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
  /** true = staging has been run; false = passthrough (source rows, no transforms applied yet) */
  isStaged: boolean
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
// Returns ALL non-rejected table mappings regardless of staging status.
// isStaged = true  → rows come from staged_data_rows (transforms applied)
// isStaged = false → preview will use source data_rows as passthrough
// Returns an empty array only if no table mappings exist (mapping not done yet).

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

  // Count staged rows per mapping (zero for un-staged mappings)
  const { data: stagedRows } = await supabaseAdmin
    .from('staged_data_rows')
    .select('table_mapping_id')
    .in('table_mapping_id', mappingIds)

  const stagedCountByMapping = new Map<string, number>()
  for (const r of stagedRows ?? []) {
    stagedCountByMapping.set(r.table_mapping_id, (stagedCountByMapping.get(r.table_mapping_id) ?? 0) + 1)
  }

  // Table names + source row counts (for un-staged fallback display)
  const allTableIds = [
    ...new Set([...tms.map((tm) => tm.source_table_id), ...tms.map((tm) => tm.target_table_id)]),
  ]
  const { data: tableRows } = await supabaseAdmin
    .from('tables')
    .select('id, name, row_count')
    .in('id', allTableIds)
  const tableNameById = new Map((tableRows ?? []).map((t) => [t.id, t.name]))
  const tableRowCountById = new Map((tableRows ?? []).map((t) => [t.id, (t.row_count as number) ?? 0]))

  return tms.map((tm) => {
    const staged = stagedCountByMapping.get(tm.id) ?? 0
    return {
      tableMappingId: tm.id,
      sourceTableName: tableNameById.get(tm.source_table_id) ?? 'unknown',
      targetTableName: tableNameById.get(tm.target_table_id) ?? 'unknown',
      targetTableId: tm.target_table_id,
      rowCount: staged > 0 ? staged : (tableRowCountById.get(tm.source_table_id) ?? 0),
      isStaged: staged > 0,
    }
  })
}

// ── getStagedDataPreview ──────────────────────────────────────────────────────
// Returns complete target-shaped rows by merging three sources:
//   1. transformed_row_data  — fields that have been explicitly applied
//   2. source passthrough    — mapped fields not yet applied (raw source value)
//   3. null                  — target fields with no mapping
//
// stagedFields: the target field names that have been written into
//   transformed_row_data (i.e., transforms have been applied). The UI uses
//   this to visually distinguish "transformed" columns from "passthrough" ones.
//
// When no staging has been done at all, falls back to querying data_rows
// directly and maps source values into target field positions (pure passthrough).

export async function getStagedDataPreview(
  tableMappingId: string,
  page: number,
  pageSize: number
): Promise<{ rows: Record<string, unknown>[]; totalRows: number; stagedFields: string[] }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { rows: [], totalRows: 0, stagedFields: [] }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  // ── 1. Load non-rejected, non-contributing field mappings ─────────────────
  // Contributing mappings feed into a primary mapping's transform SQL —
  // they don't produce their own separate target column in the preview.
  const { data: fms } = await supabase
    .from('field_mappings')
    .select('source_field_id, target_field_id')
    .eq('table_mapping_id', tableMappingId)
    .neq('status', 'rejected')
    .or('is_contributing.is.null,is_contributing.eq.false')

  if (!fms || fms.length === 0) return { rows: [], totalRows: 0, stagedFields: [] }

  const srcIds = fms.map((fm) => fm.source_field_id)
  const tgtIds = fms.map((fm) => fm.target_field_id)

  const [{ data: srcFields }, { data: tgtFields }] = await Promise.all([
    supabase.from('fields').select('id, name').in('id', srcIds),
    supabase.from('fields').select('id, name').in('id', tgtIds),
  ])

  const srcNameById = new Map((srcFields ?? []).map((f) => [f.id, f.name]))
  const tgtNameById = new Map((tgtFields ?? []).map((f) => [f.id, f.name]))

  // targetFieldName → sourceFieldName
  const fieldMap = new Map<string, string>()
  for (const fm of fms) {
    const src = srcNameById.get(fm.source_field_id)
    const tgt = tgtNameById.get(fm.target_field_id)
    if (src && tgt) fieldMap.set(tgt, src)
  }

  // ── 2. Check whether staging has been run ─────────────────────────────────
  const { count: stagedCount } = await supabase
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .eq('table_mapping_id', tableMappingId)

  const hasStaged = (stagedCount ?? 0) > 0

  if (hasStaged) {
    // ── 3a. Staged path: merge transformed fields + source passthrough ───────
    const { data: stagedRows } = await supabase
      .from('staged_data_rows')
      .select('source_row_data, transformed_row_data')
      .eq('table_mapping_id', tableMappingId)
      .order('row_number')
      .range(from, to)

    // Determine which target fields have been applied by inspecting the first row
    const firstTransformed = ((stagedRows?.[0]?.transformed_row_data) ?? {}) as Record<string, unknown>
    const stagedFieldSet = new Set(Object.keys(firstTransformed))

    const rows = (stagedRows ?? []).map((row) => {
      const source = (row.source_row_data ?? {}) as Record<string, unknown>
      const transformed = (row.transformed_row_data ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = {}
      for (const [tgt, src] of fieldMap) {
        merged[tgt] = tgt in transformed ? transformed[tgt] : (source[src] ?? null)
      }
      return merged
    })

    return { rows, totalRows: stagedCount ?? 0, stagedFields: [...stagedFieldSet] }
  } else {
    // ── 3b. No staging yet — pure passthrough from data_rows ─────────────────
    const { data: tm } = await supabase
      .from('table_mappings')
      .select('source_table_id')
      .eq('id', tableMappingId)
      .single()

    if (!tm) return { rows: [], totalRows: 0, stagedFields: [] }

    const [{ data: sourceRows }, { count: totalCount }] = await Promise.all([
      supabase
        .from('data_rows')
        .select('row_data')
        .eq('table_id', tm.source_table_id)
        .order('row_number')
        .range(from, to),
      supabase
        .from('data_rows')
        .select('id', { count: 'exact', head: true })
        .eq('table_id', tm.source_table_id),
    ])

    const rows = (sourceRows ?? []).map((row) => {
      const source = (row.row_data ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = {}
      for (const [tgt, src] of fieldMap) {
        merged[tgt] = source[src] ?? null
      }
      return merged
    })

    // No fields have been transformed yet — stagedFields is empty
    return { rows, totalRows: totalCount ?? 0, stagedFields: [] }
  }
}
