'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { flagStagedRowIssues } from '@/lib/actions/staged-row-flags'
import { logActivity } from '@/lib/actions/activity-log'

// ── Public types ──────────────────────────────────────────────────────────────

export interface StagedTableResult {
  tableMappingId: string
  sourceTableName: string
  targetTableName: string
  rowCount: number
  flaggedRows: number
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

export interface RowIssue {
  field: string
  issue: 'null_primary_key' | 'null_required_field'
  description: string
}

export interface BlockingIssue {
  id: string
  title: string
  description: string
  affected_records: number
  table_id: string | null
  table_name: string | null
  table_total_rows: number
  field_id: string | null
}

// ── getBlockingSourceIssues ───────────────────────────────────────────────────
// Returns open blocking quality issues on source data for a project.
// Optionally filtered to specific source table IDs.
// When fieldId is supplied the results are narrowed to:
//   - issues for that specific field  (field_id = fieldId)
//   - table-level issues with no field (field_id IS NULL) for the same table
// Used to show a warning popup before staging when bad source data exists.

export async function getBlockingSourceIssues(
  projectId: string,
  tableIds?: string[],
  fieldId?: string
): Promise<BlockingIssue[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase as any)
    .from('quality_issues')
    .select('id, title, description, affected_records, table_id, field_id, tables(name, row_count)')
    .eq('project_id', projectId)
    .eq('stage', 'source')
    .eq('severity', 'blocking')
    .eq('status', 'open')

  if (tableIds && tableIds.length > 0) {
    query = query.in('table_id', tableIds)
  }

  // Narrow to the specific field's issues (plus table-level issues with no field assignment)
  if (fieldId) {
    query = query.or(`field_id.eq.${fieldId},field_id.is.null`)
  }

  const { data } = await query

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((issue: any) => ({
    id: issue.id,
    title: issue.title,
    description: issue.description,
    affected_records: issue.affected_records ?? 0,
    table_id: issue.table_id,
    table_name: issue.tables?.name ?? null,
    table_total_rows: issue.tables?.row_count ?? 0,
    field_id: issue.field_id,
  }))
}

// ── getSourceIssuesForField ───────────────────────────────────────────────────
// Returns all open source quality issues for a specific source field_id.
// Used by the Transform tab Data Preview to show issue count in the header
// and detect which sample rows are problematic.

export interface FieldSourceIssue {
  id: string
  title: string
  description: string
  affected_records: number
  issue_kind: string | null
}

export async function getSourceIssuesForField(
  projectId: string,
  fieldId: string
): Promise<FieldSourceIssue[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from('quality_issues')
    .select('id, title, description, affected_records, issue_kind')
    .eq('project_id', projectId)
    .eq('stage', 'source')
    .eq('field_id', fieldId)
    .eq('status', 'open')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((i: any) => ({
    id: i.id,
    title: i.title,
    description: i.description,
    affected_records: i.affected_records ?? 0,
    issue_kind: i.issue_kind ?? null,
  }))
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
//   - Populates row_issues for rows with null values in non-nullable/PK fields.
//
// Graceful handling: each field's transform expression is wrapped in a NULL
// guard so that a null source value produces a null target value instead of
// crashing. The entire jsonb_build_object is also wrapped in COALESCE so a
// row with all-null fields still inserts as '{}' rather than violating the
// NOT NULL constraint.
//
// Steps per table_mapping:
//   1. Get approved field_mappings
//   2. Fetch source/target field names and saved/tested/applied transforms
//   3. Build jsonb_build_object SELECT (per-field NULL guard + transform or direct access)
//   4. Call generate_staged_data_for_mapping RPC (DELETE + INSERT in one round-trip)
//   5. Populate row_issues via populate_row_issues_for_mapping RPC
//   6. Mark transforms as 'applied'

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
        .select('id, source_field_id, target_field_id, is_contributing')
        .eq('table_mapping_id', tm.id)
        .neq('status', 'rejected')

      if (!fms || fms.length === 0) continue

      const srcFieldIds = fms.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)
      const tgtFieldIds = fms.map((fm) => fm.target_field_id)
      const fmIds = fms.map((fm) => fm.id)

      const [
        { data: srcFields },
        { data: tgtFields },
        { data: allSrcFields },
        { data: transforms },
      ] = await Promise.all([
        srcFieldIds.length > 0
          ? supabaseAdmin.from('fields').select('id, name').in('id', srcFieldIds)
          : Promise.resolve({ data: [], error: null }),
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

      // Build jsonb_build_object pairs with per-field NULL guard.
      // If the source value is NULL or empty → produce NULL for that field instead
      // of letting an erroring transform expression crash the entire row.
      const jsonbPairs: string[] = []

      for (const fm of fms) {
        if (fm.is_contributing) continue
        const isValueAssignment = fm.source_field_id === null
        const srcField = fm.source_field_id ? srcById.get(fm.source_field_id) : null
        const tgtField = tgtById.get(fm.target_field_id)
        if (!isValueAssignment && !srcField) continue
        if (!tgtField) continue

        const keyLiteral = `'${tgtField.name.replace(/'/g, "''")}'`
        const transformSql = transformByFMId.get(fm.id)
        const escapedSrc = srcField ? srcField.name.replace(/'/g, "''") : ''

        let valueExpr: string
        if (isValueAssignment) {
          if (transformSql) {
            const wrappedTransform = wrapFieldRefsInJsonb(
              transformSql.replace(/;+$/, '').trim(),
              allSrcFieldNames
            )
            valueExpr = `(${wrappedTransform})`
          } else {
            valueExpr = `NULL`
          }
        } else if (transformSql) {
          const wrappedTransform = wrapFieldRefsInJsonb(
            transformSql.replace(/;+$/, '').trim(),
            allSrcFieldNames
          )
          valueExpr = `CASE WHEN (row_data->>'${escapedSrc}') IS NULL OR TRIM(COALESCE(row_data->>'${escapedSrc}', '')) = '' THEN NULL ELSE (${wrappedTransform}) END`
        } else {
          valueExpr = `row_data->>'${escapedSrc}'`
        }

        jsonbPairs.push(`${keyLiteral}, (${valueExpr})`)
      }

      if (jsonbPairs.length === 0) continue

      // Wrap in COALESCE so a row with all-null fields inserts as '{}' rather
      // than violating the NOT NULL constraint on transformed_row_data.
      const selectSql =
        `SELECT ` +
        `row_number AS rn, ` +
        `row_data AS src, ` +
        `COALESCE(jsonb_build_object(${jsonbPairs.join(', ')}), '{}'::jsonb) AS tgt ` +
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

      // Cross-reference staged rows against open quality issues and populate row_issues
      const { flaggedRows = 0 } = await flagStagedRowIssues(projectId, tm.id)

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
        flaggedRows,
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

  const totalRows = results.reduce((sum, r) => sum + (r.rowCount ?? 0), 0)
  await logActivity(
    projectId,
    'stage_all',
    `Staged all data — ${totalRows} row${totalRows !== 1 ? 's' : ''} across ${results.length} table${results.length !== 1 ? 's' : ''}`,
    'system',
    { total_rows: totalRows, table_count: results.length }
  )

  return { success: true, tables: results }
}

// ── checkStagingFreshness ─────────────────────────────────────────────────────
// Compares the source table's data_modified_at against the latest staged_at for
// the given table mapping. Returns isStale = true when source data was modified
// after the last staging run.

export async function checkStagingFreshness(tableMappingId: string): Promise<{
  isStale: boolean
  sourceModifiedAt: string | null
  stagedAt: string | null
}> {
  const none = { isStale: false, sourceModifiedAt: null, stagedAt: null }

  // Latest staged row for this mapping
  const { data: latestStaged } = await supabaseAdmin
    .from('staged_data_rows')
    .select('staged_at')
    .eq('table_mapping_id', tableMappingId)
    .order('staged_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestStaged) return none

  // Source table modification time via the mapping join
  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('source_table:tables!table_mappings_source_table_id_fkey(data_modified_at)')
    .eq('id', tableMappingId)
    .maybeSingle()

  const sourceTable = tm?.source_table as unknown as { data_modified_at: string | null } | null
  const sourceModifiedAt = sourceTable?.data_modified_at ?? null
  const stagedAt = latestStaged.staged_at as string | null

  const isStale =
    !!sourceModifiedAt &&
    !!stagedAt &&
    new Date(sourceModifiedAt) > new Date(stagedAt)

  return { isStale, sourceModifiedAt, stagedAt }
}

// ── checkProjectStaleness ─────────────────────────────────────────────────────
// Checks whether any staged table mapping in a project has data that was staged
// before the corresponding source table was last modified.
// Returns the list of stale table_mapping IDs and whether any staging exists.

export async function checkProjectStaleness(projectId: string): Promise<{
  staleTableMappingIds: string[]
  hasAnyStaging: boolean
}> {
  // Get all non-rejected table mappings with source table modification time
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table:tables!table_mappings_source_table_id_fkey(data_modified_at)')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) return { staleTableMappingIds: [], hasAnyStaging: false }

  const mappingIds = tms.map((tm) => tm.id)

  // Latest staged_at per mapping — fetch all in one go, ordered desc so first seen = latest
  const { data: stagedRows } = await supabaseAdmin
    .from('staged_data_rows')
    .select('table_mapping_id, staged_at')
    .in('table_mapping_id', mappingIds)
    .order('staged_at', { ascending: false })

  if (!stagedRows || stagedRows.length === 0) {
    return { staleTableMappingIds: [], hasAnyStaging: false }
  }

  // Build map: table_mapping_id → latest staged_at
  const latestStagedAt = new Map<string, string>()
  for (const row of stagedRows) {
    if (!latestStagedAt.has(row.table_mapping_id)) {
      latestStagedAt.set(row.table_mapping_id, row.staged_at as string)
    }
  }

  const staleTableMappingIds: string[] = []
  for (const tm of tms) {
    const srcTable = tm.source_table as unknown as { data_modified_at: string | null } | null
    const modifiedAt = srcTable?.data_modified_at
    const stagedAt = latestStagedAt.get(tm.id)
    if (modifiedAt && stagedAt && new Date(modifiedAt) > new Date(stagedAt)) {
      staleTableMappingIds.push(tm.id)
    }
  }

  return { staleTableMappingIds, hasAnyStaging: latestStagedAt.size > 0 }
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
// stagedFields: target field names that have an 'applied' transformation in the
//   transformations table. stageAllData writes ALL mapped fields (transformed +
//   passthrough-copied) into transformed_row_data, so we cannot use
//   Object.keys(transformed_row_data) to distinguish them — we must check the
//   transformations table instead.
//
// flaggedFields: total issue count per target field across ALL staged rows (not
//   just the current page). Used to show correct column-header badge counts.
//
// totalFlaggedRows: number of staged rows that have at least one entry in
//   row_issues across the entire mapping (not just the current page).
//
// rowIssues: parallel to the current-page rows — per-row issue arrays used for
//   per-cell flagging in the UI.
//
// When no staging has been done at all, falls back to data_rows (pure passthrough).

export async function getStagedDataPreview(
  tableMappingId: string,
  page: number,
  pageSize: number
): Promise<{
  rows: Record<string, unknown>[]
  totalRows: number
  stagedFields: string[]
  rowIssues: RowIssue[][]
  flaggedFields: Record<string, number>
  totalFlaggedRows: number
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { rows: [], totalRows: 0, stagedFields: [], rowIssues: [], flaggedFields: {}, totalFlaggedRows: 0 }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  // ── 1. Load non-rejected, non-contributing field mappings ─────────────────
  // Contributing mappings feed into a primary mapping's transform SQL —
  // they don't produce their own separate target column in the preview.
  const { data: fms } = await supabase
    .from('field_mappings')
    .select('id, source_field_id, target_field_id')
    .eq('table_mapping_id', tableMappingId)
    .neq('status', 'rejected')
    .or('is_contributing.is.null,is_contributing.eq.false')

  if (!fms || fms.length === 0) return { rows: [], totalRows: 0, stagedFields: [], rowIssues: [], flaggedFields: {}, totalFlaggedRows: 0 }

  const srcIds = fms.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)
  const tgtIds = fms.map((fm) => fm.target_field_id)
  const fmIds = fms.map((fm) => fm.id)

  const [{ data: srcFields }, { data: tgtFields }] = await Promise.all([
    srcIds.length > 0
      ? supabase.from('fields').select('id, name').in('id', srcIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    supabase.from('fields').select('id, name').in('id', tgtIds),
  ])

  const srcNameById = new Map((srcFields ?? []).map((f) => [f.id, f.name]))
  const tgtNameById = new Map((tgtFields ?? []).map((f) => [f.id, f.name]))

  // targetFieldName → sourceFieldName (for passthrough lookup)
  const fieldMap = new Map<string, string>()
  // target field names for value assignments (source_field_id is null)
  const valueAssignmentTargetNames = new Set<string>()
  // fieldMappingId → targetFieldName (for stagedFields computation)
  const tgtNameByFMId = new Map<string, string>()
  for (const fm of fms) {
    const tgt = tgtNameById.get(fm.target_field_id)
    if (!tgt) continue
    if (fm.source_field_id) {
      const src = srcNameById.get(fm.source_field_id)
      if (src) fieldMap.set(tgt, src)
    } else {
      valueAssignmentTargetNames.add(tgt)
    }
    tgtNameByFMId.set(fm.id, tgt)
  }

  // ── 2. Check whether staging has been run ─────────────────────────────────
  const { count: stagedCount } = await supabase
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .eq('table_mapping_id', tableMappingId)

  const hasStaged = (stagedCount ?? 0) > 0

  if (hasStaged) {
    // ── 3a. Staged path: merge transformed fields + source passthrough ───────

    // Determine stagedFields from applied transformations rather than inspecting
    // transformed_row_data keys. stageAllData writes both transformed AND plain
    // passthrough-copied values into transformed_row_data, so both have keys —
    // only the transformations table can tell us which fields were actually
    // transformed by a SQL expression.
    const { data: appliedTransforms } = await supabaseAdmin
      .from('transformations')
      .select('field_mapping_id')
      .in('field_mapping_id', fmIds)
      .eq('status', 'applied')

    const stagedFields = (appliedTransforms ?? [])
      .map((t) => tgtNameByFMId.get(t.field_mapping_id))
      .filter((name): name is string => !!name)

    // Aggregate flaggedFields and totalFlaggedRows from ALL rows (not just the
    // current page) so column header badges reflect the true totals.
    const { data: allIssueRows } = await supabase
      .from('staged_data_rows')
      .select('row_issues')
      .eq('table_mapping_id', tableMappingId)

    const flaggedFields: Record<string, number> = {}
    let totalFlaggedRows = 0
    for (const row of allIssueRows ?? []) {
      const issues = (row.row_issues as RowIssue[] | null) ?? []
      if (issues.length > 0) totalFlaggedRows++
      for (const issue of issues) {
        if (issue?.field) {
          flaggedFields[issue.field] = (flaggedFields[issue.field] ?? 0) + 1
        }
      }
    }

    // Fetch the current page of staged rows
    const { data: stagedRows } = await supabase
      .from('staged_data_rows')
      .select('source_row_data, transformed_row_data, row_issues')
      .eq('table_mapping_id', tableMappingId)
      .order('row_number')
      .range(from, to)

    const rows = (stagedRows ?? []).map((row) => {
      const source = (row.source_row_data ?? {}) as Record<string, unknown>
      const transformed = (row.transformed_row_data ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = {}
      // Regular mapped fields: prefer transformed value, fall back to source passthrough
      for (const [tgt, src] of fieldMap) {
        merged[tgt] = tgt in transformed ? transformed[tgt] : (source[src] ?? null)
      }
      // Value assignments (no source field): read from transformed_row_data only
      for (const tgtName of valueAssignmentTargetNames) {
        merged[tgtName] = tgtName in transformed ? transformed[tgtName] : null
      }
      return merged
    })

    const rowIssues = (stagedRows ?? []).map(
      (row) => (row.row_issues as RowIssue[]) ?? []
    )

    return { rows, totalRows: stagedCount ?? 0, stagedFields, rowIssues, flaggedFields, totalFlaggedRows }
  } else {
    // ── 3b. No staging yet — pure passthrough from data_rows ─────────────────
    const { data: tm } = await supabase
      .from('table_mappings')
      .select('source_table_id')
      .eq('id', tableMappingId)
      .single()

    if (!tm) return { rows: [], totalRows: 0, stagedFields: [], rowIssues: [], flaggedFields: {}, totalFlaggedRows: 0 }

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
      // Value assignments have no source — show null in passthrough mode
      for (const tgtName of valueAssignmentTargetNames) {
        merged[tgtName] = null
      }
      return merged
    })

    // No staging has run — no transforms applied, no issues flagged
    return { rows, totalRows: totalCount ?? 0, stagedFields: [], rowIssues: [], flaggedFields: {}, totalFlaggedRows: 0 }
  }
}
