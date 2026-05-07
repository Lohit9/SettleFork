'use server'

import { createClient } from '@/lib/supabase/server'
import { DBTable } from '@/lib/types/database'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { logActivity } from '@/lib/actions/activity-log'

export async function getDatasetTables(datasetId: string): Promise<DBTable[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('dataset_id', datasetId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (data || []) as DBTable[]
}

/**
 * Removes a data table from the project, cascading to fields, data_rows,
 * mapping_sources, target_field_mappings (via fields), transformations
 * (via TFMs), validation_rules, quality_issues, field_profiles, and
 * staged_data_rows. Then runs a project-scoped cleanup pass that deletes
 * any non-VA, non-acknowledged TFMs left with zero mapping_sources after
 * the cascade (catches orphaned mapped TFMs whose source was just deleted).
 *
 * Auth: 'editor' role required (mirrors deleteSchemaDocument). Caller
 * receives a discriminated result; FK CASCADEs run inside the same
 * statement, so partial failure on the parent delete returns an error
 * message that the UI surfaces inline in the confirmation modal.
 *
 * Activity log: emits 'table_removed' (category 'data') with metadata
 * { table_id, dataset_id, table_name, row_count }. Cascade-driven
 * deletes do NOT emit per-row activity_log entries — that gap is
 * documented in INF-32 as a known v1 limitation.
 *
 * Known v1 limitations (INF-32):
 *   - JSONB references in project_decisions / project_lookup_tables /
 *     project_inferred_targets (migration 093) are not cleaned up.
 *     Those are AI-generated review surfaces and become stale once
 *     fields disappear; re-running the AI is the recovery path.
 *   - ingestion_jobs.table_id is SET NULL on cascade (per migration
 *     087); an in-flight ingestion job would lose its table reference
 *     mid-run. INF-33 tracks this race condition.
 */
export async function removeTable(
  tableId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Resolve project_id + capture metadata for the activity log + cleanup scope.
  const { data: row } = await supabaseAdmin
    .from('tables')
    .select('id, dataset_id, name, row_count, datasets!inner(project_id)')
    .eq('id', tableId)
    .single<{
      id: string
      dataset_id: string
      name: string
      row_count: number | null
      datasets: { project_id: string }
    }>()
  if (!row) return { success: false, error: 'Table not found' }
  const projectId = row.datasets.project_id

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error ?? 'Insufficient permissions' }

  // Delete the table — FK CASCADEs handle the rest.
  const { error: delErr } = await supabaseAdmin.from('tables').delete().eq('id', tableId)
  if (delErr) return { success: false, error: delErr.message }

  // Post-cascade orphan-TFM cleanup (project-scoped, idempotent).
  // After source-field cascade, mapped TFMs may have zero remaining
  // mapping_sources but still carry combination_type='single'/'concat_*'.
  // Two-step: load candidates, then delete by ID. Excludes 'custom_sql'
  // (value assignments — VAs legitimately have zero sources) and
  // is_acknowledged=TRUE (target acks — also legitimately have zero).
  try {
    const { data: candidates } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, mapping_sources(id)')
      .eq('project_id', projectId)
      .in('combination_type', ['single', 'concat_space', 'concat_comma'])
      .eq('is_acknowledged', false)
    const orphanIds: string[] = (candidates ?? [])
      .filter((c) => !c.mapping_sources || c.mapping_sources.length === 0)
      .map((c) => c.id)
    if (orphanIds.length > 0) {
      await supabaseAdmin.from('target_field_mappings').delete().in('id', orphanIds)
    }
  } catch (err) {
    // Cleanup failure is non-blocking — the primary delete succeeded and
    // FK cascades are already complete. Log and continue. Inconsistent
    // TFMs surface as broken-mapping warnings in the UI's existing
    // readiness-score path (pre-existing latent state, see Stop 1 §8).
    console.error('[removeTable] orphan TFM cleanup failed:', err)
  }

  // Activity log — fire-and-forget per logActivity convention.
  await logActivity(
    projectId,
    'table_removed',
    `Table "${row.name}" removed (${(row.row_count ?? 0).toLocaleString()} rows)`,
    'data',
    {
      table_id: tableId,
      dataset_id: row.dataset_id,
      table_name: row.name,
      row_count: row.row_count ?? 0,
    },
  )

  return { success: true }
}
