'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { Field } from '@/lib/types/database'
import { countFormatIssues } from '@/lib/utils/profiling'
import { inferBasicType } from '@/lib/utils/infer-basic-type'

type FieldUpdates = {
  name?: string
  data_type?: string
  inferred_type?: string | null
  is_nullable?: boolean
  is_primary_key?: boolean
  is_foreign_key?: boolean
  fk_reference?: string | null
}

// Re-computes format_issues_count for a single field after its type changes.
// Fire-and-forget — called without awaiting so the UI response isn't blocked.
async function refreshFieldProfiling(
  fieldId: string,
  newDataType: string,
  newInferredType: string | null
): Promise<void> {
  const { data: field } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('id', fieldId)
    .single()

  if (!field) return

  // Fetch up to 10,000 rows — enough for a representative format-issue count
  const { data: rows } = await supabaseAdmin
    .from('data_rows')
    .select('row_data')
    .eq('table_id', field.table_id)
    .limit(10000)

  if (!rows || rows.length === 0) {
    // DDL-only upload — no data to profile
    return
  }

  const nonNullValues = rows
    .map((r) => (r.row_data as Record<string, unknown>)?.[field.name])
    .filter((v): v is string => v !== null && v !== undefined && String(v).trim() !== '')
    .map(String)

  const formatIssuesCount = countFormatIssues(
    nonNullValues,
    newDataType,
    newInferredType,
    field.name
  )

  // Only format_issues_count is type-dependent; all other profiling columns
  // (null_percentage, cardinality, sample_values, value_distribution) are
  // computed from raw values and don't change when the type label changes.
  await supabaseAdmin
    .from('field_profiles')
    .update({ format_issues_count: formatIssuesCount })
    .eq('field_id', fieldId)
}

export async function updateField(
  fieldId: string,
  updates: FieldUpdates
): Promise<{ success: boolean; data?: Field; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: fieldLookup } = await supabaseAdmin
    .from('fields')
    .select('id, tables!inner(datasets!inner(project_id))')
    .eq('id', fieldId)
    .single()
  if (!fieldLookup) return { success: false, error: 'Field not found' }
  const projectId = (fieldLookup as any).tables.datasets.project_id
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Auto-refresh inferred_type when data_type changes and caller didn't supply one.
  // This keeps the semantic type in sync (e.g. VARCHAR → DATE updates inferred_type to 'date').
  if (updates.data_type && updates.inferred_type === undefined) {
    updates.inferred_type = inferBasicType(updates.data_type) ?? null
  }

  // Mark as manually edited — manual takes precedence over doc_enriched or inferred
  const { data: updated, error } = await supabase
    .from('fields')
    .update({ ...updates, schema_source: 'manual' })
    .eq('id', fieldId)
    .select()
    .single()

  if (error || !updated) return { success: false, error: error?.message || 'Failed to update field' }

  // Re-compute format_issues_count when type metadata changes.
  // Fire-and-forget: profiling is non-blocking; the save response returns immediately.
  if (updates.data_type || updates.inferred_type !== undefined) {
    refreshFieldProfiling(fieldId, updated.data_type, updated.inferred_type ?? null)
      .catch((err) => console.error('[updateField] Profiling refresh failed:', err))
  }

  return { success: true, data: updated as Field }
}
