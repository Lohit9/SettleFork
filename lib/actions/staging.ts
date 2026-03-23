'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'

// ── Public types ──────────────────────────────────────────────────────────────

export interface StagedTableResult {
  tableMappingId: string
  sourceTableName: string
  targetTableName: string
  rowCount: number
}

export interface StagedMappingOption {
  tableMappingId: string
  sourceTableName: string
  targetTableName: string
  targetTableId: string
  rowCount: number
}

// ── stageAllData ──────────────────────────────────────────────────────────────
//
// Canonical staging function — used by every caller:
//   • "Stage All Data" button on the Transform page
//   • "Continue to Validation" button on the Transform page
//   • "Regenerate Staged Data" button on the Validate page
//   • runFullScan in quality-fixes.ts
//
// Stages ALL non-rejected table_mappings (approved + needs_review).
// Gold Standard generation in outputs.ts is the only place that filters
// to approved-only — that's where explicit sign-off matters.
//
// After successful staging for each table:
//   - Marks all 'saved'/'tested' transforms in that table as 'applied'.
//
// Steps per table_mapping:
//   1. Get approved field_mappings
//   2. Fetch source/target field names and saved/tested/applied transforms
//   3. Build jsonb_build_object SELECT (apply transform or direct access)
//   4. Call generate_staged_data_for_mapping RPC (DELETE + INSERT in one round-trip)
//   5. Mark transforms as 'applied'

export async function stageAllData(projectId: string): Promise<{
  success: boolean
  tables: StagedTableResult[]
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, tables: [], error: 'Not authenticated' }

  // Verify project ownership via RLS
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { success: false, tables: [], error: 'Access denied' }

  // Get ALL non-rejected table mappings
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) {
    return { success: false, tables: [], error: 'No table mappings found.' }
  }

  // Resolve table names in one query
  const allTableIds = [
    ...new Set([
      ...tms.map((tm) => tm.source_table_id),
      ...tms.map((tm) => tm.target_table_id),
    ]),
  ]
  const { data: tableRows } = await supabaseAdmin
    .from('tables')
    .select('id, name')
    .in('id', allTableIds)
  const tableNameById = new Map((tableRows ?? []).map((t) => [t.id, t.name]))

  const results: StagedTableResult[] = []
  const errors: string[] = []

  for (const tm of tms) {
    const sourceTableName = tableNameById.get(tm.source_table_id) ?? 'unknown'
    const targetTableName = tableNameById.get(tm.target_table_id) ?? 'unknown'

    try {
      // Get non-rejected field mappings for this table mapping
      const { data: fms } = await supabaseAdmin
        .from('field_mappings')
        .select('id, source_field_id, target_field_id')
        .eq('table_mapping_id', tm.id)
        .neq('status', 'rejected')

      if (!fms || fms.length === 0) continue

      const srcFieldIds = fms.map((fm) => fm.source_field_id)
      const tgtFieldIds = fms.map((fm) => fm.target_field_id)
      const fmIds = fms.map((fm) => fm.id)

      const [
        { data: srcFields },
        { data: tgtFields },
        { data: allSrcFields },
        { data: transforms },
      ] = await Promise.all([
        supabaseAdmin.from('fields').select('id, name').in('id', srcFieldIds),
        supabaseAdmin.from('fields').select('id, name').in('id', tgtFieldIds),
        supabaseAdmin.from('fields').select('name').eq('table_id', tm.source_table_id),
        supabaseAdmin
          .from('transformations')
          .select('id, field_mapping_id, generated_sql, status')
          .in('field_mapping_id', fmIds)
          .in('status', ['saved', 'tested', 'applied']),
      ])

      const srcById = new Map((srcFields ?? []).map((f) => [f.id, f]))
      const tgtById = new Map((tgtFields ?? []).map((f) => [f.id, f]))
      const allSrcFieldNames = (allSrcFields ?? []).map((f) => f.name)
      const transformByFMId = new Map(
        (transforms ?? []).map((t) => [t.field_mapping_id, t.generated_sql as string])
      )
      const transformIdByFMId = new Map(
        (transforms ?? []).map((t) => [t.field_mapping_id, t.id as string])
      )

      // Build jsonb_build_object pairs
      const jsonbPairs: string[] = []

      for (const fm of fms) {
        const srcField = srcById.get(fm.source_field_id)
        const tgtField = tgtById.get(fm.target_field_id)
        if (!srcField || !tgtField) continue

        const keyLiteral = `'${tgtField.name.replace(/'/g, "''")}'`
        const transformSql = transformByFMId.get(fm.id)

        let valueExpr: string
        if (transformSql) {
          valueExpr = wrapFieldRefsInJsonb(transformSql.replace(/;+$/, '').trim(), allSrcFieldNames)
        } else {
          const escapedSrc = srcField.name.replace(/'/g, "''")
          valueExpr = `row_data->>'${escapedSrc}'`
        }

        jsonbPairs.push(`${keyLiteral}, (${valueExpr})`)
      }

      if (jsonbPairs.length === 0) continue

      const selectSql =
        `SELECT ` +
        `row_number AS rn, ` +
        `row_data AS src, ` +
        `jsonb_build_object(${jsonbPairs.join(', ')}) AS tgt ` +
        `FROM data_rows ` +
        `WHERE table_id = '${tm.source_table_id}' ` +
        `ORDER BY row_number`

      const { data: rowCount, error: rpcErr } = await supabaseAdmin.rpc(
        'generate_staged_data_for_mapping',
        {
          p_table_mapping_id: tm.id,
          p_source_table_id: tm.source_table_id,
          p_target_table_id: tm.target_table_id,
          p_select_sql: selectSql,
        }
      )

      if (rpcErr) {
        errors.push(`${targetTableName}: ${rpcErr.message}`)
        continue
      }

      // Mark all saved/tested transforms for this table as 'applied'
      const transformIdsToMark = [...transformIdByFMId.values()]
      if (transformIdsToMark.length > 0) {
        await supabaseAdmin
          .from('transformations')
          .update({ status: 'applied' })
          .in('id', transformIdsToMark)
          .in('status', ['saved', 'tested'])
      }

      results.push({
        tableMappingId: tm.id,
        sourceTableName,
        targetTableName,
        rowCount: Number(rowCount ?? 0),
      })
    } catch (err) {
      errors.push(
        `${targetTableName}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  if (results.length === 0 && errors.length > 0) {
    return { success: false, tables: [], error: errors.join('; ') }
  }

  return { success: true, tables: results }
}

// ── hasStagedData ─────────────────────────────────────────────────────────────

export async function hasStagedData(projectId: string): Promise<boolean> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false

  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) return false

  const mappingIds = tms.map((tm) => tm.id)

  const { count } = await supabaseAdmin
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .in('table_mapping_id', mappingIds)
    .limit(1)

  return (count ?? 0) > 0
}

// ── getStagedMappings ─────────────────────────────────────────────────────────

export async function getStagedMappings(projectId: string): Promise<StagedMappingOption[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return []

  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) return []

  const mappingIds = tms.map((tm) => tm.id)

  const { data: stagedRows } = await supabaseAdmin
    .from('staged_data_rows')
    .select('table_mapping_id')
    .in('table_mapping_id', mappingIds)

  if (!stagedRows || stagedRows.length === 0) return []

  const countByMapping = new Map<string, number>()
  for (const r of stagedRows) {
    countByMapping.set(r.table_mapping_id, (countByMapping.get(r.table_mapping_id) ?? 0) + 1)
  }

  const allTableIds = [
    ...new Set([...tms.map((tm) => tm.source_table_id), ...tms.map((tm) => tm.target_table_id)]),
  ]
  const { data: tableNameRows } = await supabaseAdmin
    .from('tables')
    .select('id, name')
    .in('id', allTableIds)
  const tableNameById = new Map((tableNameRows ?? []).map((t) => [t.id, t.name]))

  return tms
    .filter((tm) => countByMapping.has(tm.id))
    .map((tm) => ({
      tableMappingId: tm.id,
      sourceTableName: tableNameById.get(tm.source_table_id) ?? 'unknown',
      targetTableName: tableNameById.get(tm.target_table_id) ?? 'unknown',
      targetTableId: tm.target_table_id,
      rowCount: countByMapping.get(tm.id) ?? 0,
    }))
}

// ── getStagedDataPreview ──────────────────────────────────────────────────────

export async function getStagedDataPreview(
  tableMappingId: string,
  page: number,
  pageSize: number
): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { rows: [], totalRows: 0 }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const [{ data: rowData }, { count }] = await Promise.all([
    supabase
      .from('staged_data_rows')
      .select('transformed_row_data')
      .eq('table_mapping_id', tableMappingId)
      .order('row_number')
      .range(from, to),
    supabase
      .from('staged_data_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_mapping_id', tableMappingId),
  ])

  const rows = (rowData ?? []).map(
    (r) => r.transformed_row_data as Record<string, unknown>
  )

  return { rows, totalRows: count ?? 0 }
}
