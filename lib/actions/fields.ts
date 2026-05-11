'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { logActivity } from '@/lib/actions/activity-log'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { Field } from '@/lib/types/database'
import { countFormatIssues } from '@/lib/utils/profiling'
import { inferBasicType } from '@/lib/utils/infer-basic-type'
import {
  createFieldInputSchema,
  PREVIEW_STAGED_ROW_CAP,
  type CreateFieldInput,
  type DeleteFieldImpact,
  type FieldActionResult,
  type AppliedCascade,
} from '@/lib/validation/fields'

const MAINTENANCE_GUARD_MESSAGE =
  'Mapping writes are temporarily disabled for scheduled maintenance'

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

  // FR-3 retroactive emitter: close the existing logging gap. Activity log is
  // fire-and-forget; failure here never blocks the action.
  await logActivity(
    projectId,
    'field_updated',
    `Field updated: ${updated.name}`,
    'data',
    {
      field_id: fieldId,
      table_id: updated.table_id,
      changed_keys: Object.keys(updates),
    }
  )

  revalidatePath(`/app/projects/${projectId}/data-overview`)

  return { success: true, data: updated as Field }
}

// ===========================================================================
// FR-3 — Schema Overview field actions
// ===========================================================================
//
// createField, previewFieldDeletion, deleteField. See notes/fr-3-investigation.md
// for the full design memo. Three actions, three contracts, one shared
// FieldActionResult discriminated union.
//
// Permission matrix (per investigation §8):
//
//   Action                  | role     | maintenance gate
//   ────────────────────────┼──────────┼──────────────────
//   createField             | editor   | —
//   previewFieldDeletion    | viewer   | —
//   deleteField             | editor   | ✓
//
// `updateField` (legacy) is editor / no maintenance gate; we deliberately
// extend the gate to deleteField only (cascade impact crosses mapping-write
// boundary). createField cannot affect existing mappings.

/**
 * Create a new schema field on a table. Manual user creation only;
 * schema_source is forced to `'manual'` (mirrors `updateField`).
 *
 * Validation:
 *   - Zod parses the input shape (lib/validation/fields.ts) — first issue's
 *     message bubbles up as the error string.
 *   - Case-sensitive (table_id, name) collision check. Postgres TEXT and the
 *     existing DDL parser are both case-sensitive; we do not lowercase.
 *
 * Side effects:
 *   - Computes ordinal_position = MAX(existing) + 1 server-side.
 *   - Emits a single 'field_created' activity_log entry.
 *   - Does NOT create a placeholder field_profiles row — every read path
 *     LEFT-joins, so absence is safe (verified in investigation §5).
 */
export async function createField(
  input: CreateFieldInput
): Promise<FieldActionResult<Field>> {
  // 1. Auth
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, errorCode: 'not_authenticated', error: 'Not authenticated' }
  }

  // 2. Validate input
  const parsed = createFieldInputSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const message = firstIssue?.message ?? 'Invalid input'
    // Map known first-issue paths to specific error codes; everything else
    // collapses to invalid_data_type (broad fallback for malformed shape).
    const path = firstIssue?.path?.[0]
    const errorCode =
      path === 'name'
        ? ('name_required' as const)
        : path === 'dataType'
          ? ('invalid_data_type' as const)
          : ('invalid_data_type' as const)
    return { success: false, errorCode, error: message }
  }
  const v = parsed.data

  // 3. Resolve project_id via the parent table
  const { data: tableLookup } = await supabaseAdmin
    .from('tables')
    .select('id, dataset_id, datasets!inner(project_id)')
    .eq('id', v.tableId)
    .single()
  if (!tableLookup) {
    return { success: false, errorCode: 'table_not_found', error: 'Parent table not found' }
  }
  const projectId = (tableLookup as unknown as { datasets: { project_id: string } }).datasets
    .project_id

  // 4. Permission
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      errorCode: 'forbidden',
      error: perm.error ?? 'Insufficient permissions',
    }
  }

  // 5. Case-sensitive name collision check (no UNIQUE constraint exists today —
  // see investigation §5; partial unique index is filed as INF-67 follow-up).
  const { data: collision } = await supabaseAdmin
    .from('fields')
    .select('id')
    .eq('table_id', v.tableId)
    .eq('name', v.name)
    .limit(1)
    .maybeSingle()
  if (collision) {
    return {
      success: false,
      errorCode: 'name_collision',
      error: `A field named "${v.name}" already exists on this table`,
    }
  }

  // 6. Compute ordinal_position = MAX + 1 (existing convention; investigation §5)
  const { data: maxRow } = await supabaseAdmin
    .from('fields')
    .select('ordinal_position')
    .eq('table_id', v.tableId)
    .order('ordinal_position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextOrdinal = (maxRow?.ordinal_position ?? 0) + 1

  // 7. Insert
  const inferredType =
    v.inferredType !== undefined ? v.inferredType : (inferBasicType(v.dataType) ?? null)

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('fields')
    .insert({
      table_id: v.tableId,
      name: v.name,
      data_type: v.dataType,
      inferred_type: inferredType,
      is_nullable: v.isNullable ?? true,
      is_primary_key: v.isPrimaryKey ?? false,
      is_foreign_key: v.isForeignKey ?? false,
      fk_reference: v.fkReference ?? null,
      description: v.description ?? null,
      ordinal_position: nextOrdinal,
      schema_source: 'manual',
    })
    .select()
    .single()

  if (insertError || !inserted) {
    return {
      success: false,
      errorCode: 'db_error',
      error: insertError?.message ?? 'Failed to create field',
    }
  }

  // 8. Activity log (fire-and-forget)
  await logActivity(
    projectId,
    'field_created',
    `Field created: ${v.name}`,
    'data',
    {
      field_id: inserted.id,
      table_id: v.tableId,
      data_type: v.dataType,
      ordinal_position: nextOrdinal,
    }
  )

  revalidatePath(`/app/projects/${projectId}/data-overview`)

  return { success: true, data: inserted as Field }
}

/**
 * Compute the cascade impact summary for deleting a field, without mutating
 * anything. Drives the typed-confirmation gate in the UI.
 *
 * Permission: viewer-or-higher (read-only preview).
 * Strategy: 1 sequential context fetch (field + parent table_mappings) then
 * 7 parallel COUNT queries via Promise.all. Staged-row count is capped at
 * PREVIEW_STAGED_ROW_CAP (101) — mirrors previewEditInvalidation.
 */
export async function previewFieldDeletion(
  fieldId: string
): Promise<FieldActionResult<DeleteFieldImpact>> {
  // 1. Auth
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, errorCode: 'not_authenticated', error: 'Not authenticated' }
  }

  // 2. Resolve field + parent table + project
  const { data: ctx } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', fieldId)
    .single()
  if (!ctx) {
    return { success: false, errorCode: 'field_not_found', error: 'Field not found' }
  }
  const fieldName = ctx.name as string
  const tableId = ctx.table_id as string
  const projectId = (ctx as unknown as { tables: { datasets: { project_id: string } } }).tables
    .datasets.project_id

  // 3. Permission (viewer minimum — read-only preview)
  const perm = await requireProjectPermission(projectId, 'viewer')
  if (!perm.allowed) {
    return {
      success: false,
      errorCode: 'forbidden',
      error: perm.error ?? 'Insufficient permissions',
    }
  }

  // 4. Sequential prerequisite — TFM ids targeting this field, plus
  // table_mapping ids whose target table matches. We need both:
  //  - tfmIds for the transformations + authored-SQL detection
  //  - tmIds  for the staged_data_rows JSONB key match
  const [tfmIdsRes, tmIdsRes] = await Promise.all([
    supabaseAdmin.from('target_field_mappings').select('id').eq('target_field_id', fieldId),
    supabaseAdmin.from('table_mappings').select('id').eq('target_table_id', tableId),
  ])
  const tfmIds = (tfmIdsRes.data ?? []).map((r) => r.id as string)
  const tmIds = (tmIdsRes.data ?? []).map((r) => r.id as string)

  // 5. Fan out counts in parallel.
  //
  // Legacy `field_acknowledgments` is intentionally NOT queried here — the
  // codebase guard at tests/lib/no-legacy-table-refs.test.ts forbids product
  // code from issuing `.from('field_acknowledgments')` (migration 074
  // retired the table and migration 098 collapsed its semantics into
  // target_field_coverage). The deleteField RPC still counts it as part of
  // its DB-side audit (since the FK CASCADE still fires for any residual
  // rows pre-098 backfill), so the preview's `acknowledgments` count may
  // under-report by the legacy residue — practically zero for any project
  // migrated through 098.
  const stagedJsonbProbe = JSON.stringify({ [fieldName]: null })
  const [
    msRes,
    txnRes,
    txnAuthoredRes,
    stagedRes,
    ackNewRes,
    coverageRes,
    vrRes,
  ] = await Promise.all([
    supabaseAdmin
      .from('mapping_sources')
      .select('id', { count: 'exact', head: true })
      .eq('source_field_id', fieldId),
    tfmIds.length === 0
      ? Promise.resolve({ count: 0 })
      : supabaseAdmin
          .from('transformations')
          .select('id', { count: 'exact', head: true })
          .in('target_field_mapping_id', tfmIds),
    tfmIds.length === 0
      ? Promise.resolve({ data: [] as { id: string }[] })
      : supabaseAdmin
          .from('transformations')
          .select('id')
          .in('target_field_mapping_id', tfmIds)
          .eq('is_ai_generated', false)
          .limit(1),
    tmIds.length === 0
      ? Promise.resolve({ count: 0 })
      : supabaseAdmin
          .from('staged_data_rows')
          .select('id', { count: 'exact', head: true })
          .in('table_mapping_id', tmIds)
          .filter('transformed_row_data', 'cs', stagedJsonbProbe)
          .limit(PREVIEW_STAGED_ROW_CAP),
    supabaseAdmin
      .from('source_field_acknowledgments')
      .select('id', { count: 'exact', head: true })
      .eq('source_field_id', fieldId),
    supabaseAdmin
      .from('target_field_coverage')
      .select('id', { count: 'exact', head: true })
      .eq('target_field_id', fieldId),
    // validation_rules: field-scoped rules where field_id = $1. Nullable FK
    // (rules can be table- or project-scoped, with field_id NULL) — the
    // .eq() correctly excludes those; only field-scoped rules cascade when
    // the field is deleted. Surfaced in the preview so the UI's honest-
    // cascade-disclosure isn't lying about zero impact when the FK CASCADE
    // is about to silently remove rows.
    supabaseAdmin
      .from('validation_rules')
      .select('id', { count: 'exact', head: true })
      .eq('field_id', fieldId),
  ])

  const stagedCountRaw = (stagedRes as { count: number | null }).count ?? 0
  const stagedRows = Math.min(stagedCountRaw, PREVIEW_STAGED_ROW_CAP)
  const stagedRowsCapped = stagedCountRaw >= PREVIEW_STAGED_ROW_CAP

  const impact: DeleteFieldImpact = {
    fieldId,
    fieldName,
    tableId,
    counts: {
      tfms: tfmIds.length,
      mappingSources: (msRes as { count: number | null }).count ?? 0,
      transformations: (txnRes as { count: number | null }).count ?? 0,
      stagedRows,
      acknowledgments: (ackNewRes as { count: number | null }).count ?? 0,
      coverageRows: (coverageRes as { count: number | null }).count ?? 0,
      validationRules: (vrRes as { count: number | null }).count ?? 0,
    },
    stagedRowsCapped,
    hasAuthoredTransformSQL:
      ((txnAuthoredRes as { data: { id: string }[] | null }).data?.length ?? 0) > 0,
    // v1 policy: typed confirmation required when staged rows would be
    // scrubbed. Server-derived so policy can evolve without UI changes.
    requiresTypedConfirmation: stagedRows > 0,
  }

  return { success: true, data: impact }
}

/**
 * Hard-delete a schema field. Atomic via `delete_field_with_cleanup` RPC
 * (migration 099) which:
 *   - re-asserts auth + editor role
 *   - scrubs staged_data_rows.transformed_row_data JSONB keys
 *   - DELETEs the field; FK CASCADEs handle dependent rows
 *   - returns the cascade-count summary
 *
 * Permission: editor + maintenance-mode gate (cascade impact crosses the
 * mapping-write boundary, even though updateField doesn't gate; see
 * investigation §8).
 */
export async function deleteField(
  fieldId: string
): Promise<FieldActionResult<{ appliedCascade: AppliedCascade }>> {
  // 1. Auth
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, errorCode: 'not_authenticated', error: 'Not authenticated' }
  }

  // 2. Resolve project_id (so we can run the maintenance gate + permission
  // check before the RPC; the RPC re-asserts auth + role independently as a
  // defense-in-depth measure, but giving the user a structured permission
  // error from the action is friendlier than a raw Postgres exception).
  const { data: fieldLookup } = await supabaseAdmin
    .from('fields')
    .select('id, name, tables!inner(datasets!inner(project_id))')
    .eq('id', fieldId)
    .single()
  if (!fieldLookup) {
    return { success: false, errorCode: 'field_not_found', error: 'Field not found' }
  }
  const projectId = (fieldLookup as unknown as { tables: { datasets: { project_id: string } } })
    .tables.datasets.project_id
  const fieldName = (fieldLookup as { name: string }).name

  // 3. Permission
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      errorCode: 'forbidden',
      error: perm.error ?? 'Insufficient permissions',
    }
  }

  // 4. Maintenance gate (deliberate divergence from updateField — see §8)
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === MAINTENANCE_GUARD_MESSAGE) {
      return { success: false, errorCode: 'maintenance_mode', error: message }
    }
    return { success: false, errorCode: 'db_error', error: message }
  }

  // 5. Atomic RPC: scrub + delete + return cascade summary.
  // INF-80: invoke via the cookie-forwarding `supabase` client (NOT
  // supabaseAdmin) so the user's JWT propagates into the RPC. The RPC
  // calls auth.uid() and re-asserts the editor role — both require the
  // user's session, which the service-role key does not carry. Pattern
  // matches mappings.ts:1522 / mappings.ts:2010 / field-acknowledgments.ts:142.
  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'delete_field_with_cleanup',
    { p_field_id: fieldId }
  )
  if (rpcError || !rpcResult) {
    return {
      success: false,
      errorCode: 'db_error',
      error: rpcError?.message ?? 'Failed to delete field',
    }
  }

  // 6. Unpack the JSONB summary
  const summary = rpcResult as {
    project_id: string
    table_id: string
    table_name: string
    field_name: string
    cascade_counts: {
      target_field_mappings: number
      mapping_sources: number
      transformations: number
      staged_rows_scrubbed: number
      acknowledgments: number
      coverage_rows: number
      validation_rules: number
    }
    had_authored_transform_sql: boolean
  }

  const appliedCascade: AppliedCascade = {
    targetFieldMappings: summary.cascade_counts.target_field_mappings,
    mappingSources: summary.cascade_counts.mapping_sources,
    transformations: summary.cascade_counts.transformations,
    stagedRowsScrubbed: summary.cascade_counts.staged_rows_scrubbed,
    acknowledgments: summary.cascade_counts.acknowledgments,
    coverageRows: summary.cascade_counts.coverage_rows,
    validationRules: summary.cascade_counts.validation_rules,
    hadAuthoredTransformSql: summary.had_authored_transform_sql,
  }

  // 7. Activity log — single parent entry with cascade counts in metadata.
  // Mirrors the resetFieldTransform precedent (one entry per atomic action).
  await logActivity(
    projectId,
    'field_deleted',
    `Field deleted: ${summary.table_name}.${fieldName}`,
    'data',
    {
      field_id: fieldId,
      field_name: fieldName,
      table_id: summary.table_id,
      table_name: summary.table_name,
      cascade_counts: summary.cascade_counts,
      had_authored_transform_sql: summary.had_authored_transform_sql,
    }
  )

  revalidatePath(`/app/projects/${projectId}/data-overview`)

  return { success: true, data: { appliedCascade } }
}
