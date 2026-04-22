'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { recomputeTableMappingStatus } from './mappings'

/**
 * Field-acknowledgment server actions, rewritten against the new
 * mapping-redesign data model (migration 074).
 *
 * ─── Storage split ───────────────────────────────────────────────────────────
 * In the legacy model, both source-side and target-side acknowledgments lived
 * in a single `field_acknowledgments` table keyed by `(project_id, field_id)`.
 * The new model splits them:
 *
 *   - target-side → `target_field_mappings` row with `is_acknowledged=true`
 *                   (unique on `(project_id, target_field_id)`). Written via
 *                   the `dq_acknowledge_target` RPC which defends the
 *                   project-role check + clears any existing mapping_sources.
 *   - source-side → `source_field_acknowledgments` (new table, unique on
 *                   `(project_id, source_field_id)`). Written directly.
 *
 * ─── Back-compat API ─────────────────────────────────────────────────────────
 * The three exports preserve their throw-on-error semantics so that the
 * existing try/catch structure in `MappingContent.tsx` (lines 3205-3236)
 * keeps behaving identically. Guard failures surface as thrown Errors with
 * the guard's user-readable message. Errors from RPCs/writes also throw.
 *
 * `notes` is accepted for both sides but is only persisted for the source
 * side — the new model's target acknowledgment carries no `notes` column
 * (migration 074 STEP 9 folded pre-existing notes into `acknowledgment_reason`
 * with an em-dash separator). Existing call sites never pass notes, so this
 * is not a regression. If `notes` is ever supplied for a target ack it is
 * appended to the reason with " — ".
 */

export interface FieldAcknowledgment {
  id: string
  project_id: string
  field_id: string
  side: 'source' | 'target'
  reason: string
  notes: string | null
  acknowledged_by: string | null
  acknowledged_at: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Acknowledgment changes can shift a TM between `approved` and `needs_review`
 * because TM status requires every target AND source field to be either
 * mapped or acknowledged. Recompute every TM whose target OR source table
 * contains the field so the badge in the UI stays in sync without a full
 * refetch.
 */
async function recomputeAffectedTableMappings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
  fieldId: string,
): Promise<void> {
  const { data: field } = await supabase
    .from('fields')
    .select('table_id')
    .eq('id', fieldId)
    .single()

  if (!field) return

  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .or(`target_table_id.eq.${field.table_id},source_table_id.eq.${field.table_id}`)

  for (const tm of tms ?? []) {
    await recomputeTableMappingStatus(supabase, tm.id)
  }
}

/**
 * Resolve which side of the mapping this field lives on. Used by the
 * side-agnostic `removeAcknowledgment` API. Returns 'target' for fields
 * in a target-role dataset, 'source' otherwise. Throws when the field or
 * its dataset can't be resolved (defensive: a caller passing a field
 * outside this project is already a bug).
 */
async function resolveFieldSide(
  supabase: Awaited<ReturnType<typeof createClient>>,
  fieldId: string,
): Promise<'source' | 'target'> {
  const { data, error } = await supabase
    .from('fields')
    .select('tables:table_id(datasets:dataset_id(role))')
    .eq('id', fieldId)
    .single()

  if (error || !data) {
    throw new Error(`[field-acknowledgments] Field ${fieldId} not found`)
  }

  const role = (data as unknown as {
    tables?: { datasets?: { role?: string } | null } | null
  }).tables?.datasets?.role
  if (role !== 'source' && role !== 'target') {
    throw new Error(
      `[field-acknowledgments] Field ${fieldId} has unexpected dataset role: ${String(role)}`,
    )
  }
  return role
}

// ─── acknowledgeField ─────────────────────────────────────────────────────────

export async function acknowledgeField(
  projectId: string,
  fieldId: string,
  side: 'source' | 'target',
  reason: string,
  notes?: string,
): Promise<FieldAcknowledgment> {
  const supabase = await createClient()

  const permission = await requireProjectPermission(projectId, 'editor')
  if (!permission.allowed) {
    throw new Error(permission.error ?? 'Insufficient permissions')
  }

  await assertMappingWritesEnabled(projectId)

  const { data: { user } } = await supabase.auth.getUser()

  if (side === 'target') {
    // Fold notes into reason for storage parity with the old model. The
    // shim surfaces target-side acks with notes=null per its contract,
    // so round-tripping is symmetric for new writes (no notes).
    const reasonForStorage = notes ? `${reason} — ${notes}` : reason

    const { data, error } = await supabase.rpc('dq_acknowledge_target', {
      p_project_id: projectId,
      p_target_field_id: fieldId,
      p_reason: reasonForStorage,
    })
    if (error) {
      throw new Error(`[field-acknowledgments] dq_acknowledge_target failed: ${error.message}`)
    }
    const tfmId = typeof data === 'string' ? data : String(data)

    await recomputeAffectedTableMappings(supabase, projectId, fieldId)

    return {
      id: `ack::target::${tfmId}`,
      project_id: projectId,
      field_id: fieldId,
      side: 'target',
      reason,
      notes: notes ?? null,
      acknowledged_by: user?.id ?? null,
      acknowledged_at: new Date().toISOString(),
    }
  }

  // side === 'source'
  const { data, error } = await supabase
    .from('source_field_acknowledgments')
    .upsert(
      {
        project_id: projectId,
        source_field_id: fieldId,
        reason,
        notes: notes ?? null,
        acknowledged_by: user?.id ?? null,
        acknowledged_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,source_field_id' },
    )
    .select('id, acknowledged_at')
    .single()

  if (error || !data) {
    throw new Error(
      `[field-acknowledgments] source_field_acknowledgments upsert failed: ${error?.message ?? 'no row returned'}`,
    )
  }

  await recomputeAffectedTableMappings(supabase, projectId, fieldId)

  return {
    id: `ack::source::${data.id}`,
    project_id: projectId,
    field_id: fieldId,
    side: 'source',
    reason,
    notes: notes ?? null,
    acknowledged_by: user?.id ?? null,
    acknowledged_at: data.acknowledged_at,
  }
}

// ─── removeAcknowledgment ─────────────────────────────────────────────────────

export async function removeAcknowledgment(
  projectId: string,
  fieldId: string,
): Promise<void> {
  const supabase = await createClient()

  const permission = await requireProjectPermission(projectId, 'editor')
  if (!permission.allowed) {
    throw new Error(permission.error ?? 'Insufficient permissions')
  }

  await assertMappingWritesEnabled(projectId)

  const side = await resolveFieldSide(supabase, fieldId)

  if (side === 'target') {
    // Target-side ack lives as an `is_acknowledged=true` TFM row with no
    // sources. Clearing the flag (and deleting the row outright) un-acks.
    // We delete the row because without is_acknowledged or sources the
    // migration 074 check constraint (ckc_tfm_shape) would reject it.
    const { error } = await supabaseAdmin
      .from('target_field_mappings')
      .delete()
      .eq('project_id', projectId)
      .eq('target_field_id', fieldId)
      .eq('is_acknowledged', true)
    if (error) {
      throw new Error(
        `[field-acknowledgments] Failed to remove target ack: ${error.message}`,
      )
    }
  } else {
    const { error } = await supabase
      .from('source_field_acknowledgments')
      .delete()
      .eq('project_id', projectId)
      .eq('source_field_id', fieldId)
    if (error) {
      throw new Error(
        `[field-acknowledgments] Failed to remove source ack: ${error.message}`,
      )
    }
  }

  await recomputeAffectedTableMappings(supabase, projectId, fieldId)
}

// ─── getAcknowledgmentsForProject (new helper; used by integration tests) ────

/**
 * Fetch both target-side and source-side acknowledgments for a project,
 * collapsed into the legacy `FieldAcknowledgment[]` shape. Not currently
 * consumed by server pages (they go through the shim via `getMappings`),
 * but exported so tests and future tooling have a direct projection.
 */
export async function getAcknowledgmentsForProject(
  projectId: string,
): Promise<FieldAcknowledgment[]> {
  const supabase = await createClient()

  const [targetRes, sourceRes] = await Promise.all([
    supabase
      .from('target_field_mappings')
      .select('id, target_field_id, acknowledgment_reason, updated_at')
      .eq('project_id', projectId)
      .eq('is_acknowledged', true),
    supabase
      .from('source_field_acknowledgments')
      .select('id, source_field_id, reason, notes, acknowledged_by, acknowledged_at')
      .eq('project_id', projectId),
  ])

  if (targetRes.error) {
    throw new Error(
      `[field-acknowledgments] target fetch failed: ${targetRes.error.message}`,
    )
  }
  if (sourceRes.error) {
    throw new Error(
      `[field-acknowledgments] source fetch failed: ${sourceRes.error.message}`,
    )
  }

  const result: FieldAcknowledgment[] = []
  for (const t of targetRes.data ?? []) {
    result.push({
      id: `ack::target::${t.id}`,
      project_id: projectId,
      field_id: t.target_field_id,
      side: 'target',
      reason: t.acknowledgment_reason ?? 'acknowledged',
      notes: null,
      acknowledged_by: null,
      acknowledged_at: t.updated_at,
    })
  }
  for (const s of sourceRes.data ?? []) {
    result.push({
      id: `ack::source::${s.id}`,
      project_id: projectId,
      field_id: s.source_field_id,
      side: 'source',
      reason: s.reason,
      notes: s.notes,
      acknowledged_by: s.acknowledged_by,
      acknowledged_at: s.acknowledged_at,
    })
  }
  return result
}
