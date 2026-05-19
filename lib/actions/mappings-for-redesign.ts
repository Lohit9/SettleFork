'use server'


/**
 * Server actions for the Phase 3 redesigned Mapping page.
 *
 * Read path (`getMappingsForRedesign`): thin auth wrapper over the
 * pure assembler in `_mappings-for-redesign-core.ts`.
 *
 * Write path — Gap 9 (Phase 3 mutations):
 *   - `approveFieldMapping(rowId)` — flip TFM.status to 'approved'.
 *     Thin wrapper over the legacy `updateFieldMappingStatus` so the
 *     redesign UI never has to import a mixed-concern action surface.
 *     Per the founder amendment (2026-04-21), approve is non-destructive
 *     and reversible.
 *   - `rejectFieldMapping(rowId)` — DELETE the TFM (founder amendment:
 *     reject == delete). The target field thereafter renders as Rule 6
 *     (unmapped). Wrapper queries TFM identity BEFORE delegating to
 *     `deleteFieldMapping` so it can emit a `mapping_rejected` activity-
 *     log entry with the legacy-format payload (the legacy `delete`
 *     action does not log on its own).
 *
 * Write path — Phase 4a-1 (manual creation + per-target AI Suggest):
 *   - `createFieldMapping(input)` — atomic creation of a target_field_
 *     mapping plus its mapping_sources children via the
 *     `dq_create_target_field_mapping` RPC. Same-table only in 4a-1;
 *     cross-table support extends in 4a-3 with FK-inference precheck.
 *     Status 'needs_review' on creation (per founder decision 2 —
 *     redesign Approve is the explicit acceptance gate). Emits
 *     `mapping_created` activity-log entry. Calls
 *     `recomputeTableMappingStatus` explicitly (closes the legacy
 *     `addManualFieldMapping` gap that never recomputed coverage).
 *   - `suggestMappingForTarget(input)` — per-target AI Suggest. Net-new
 *     server action (does NOT wrap legacy `suggestRemainingMappings`
 *     which is per-TM-bulk + same-table + 1:1; see Phase 4a investigation
 *     §1.4 for divergence rationale). Returns an ephemeral suggestion
 *     for the form to pre-fill — no DB writes, no activity-log entry.
 *     Confirmation flows through `createFieldMapping` with
 *     `aiSuggested: true` for metadata bookkeeping.
 *
 * Coexistence (design §8.2): these actions live ALONGSIDE the legacy
 * `updateFieldMappingStatus` / `deleteFieldMapping` /
 * `addManualFieldMapping` / `suggestRemainingMappings` write paths
 * during Phase 3+4. The legacy MappingContent.tsx UI keeps calling the
 * legacy actions directly; only the redesign drawer + form reach the
 * wrappers below. Phase 5 cleanup retires the legacy UI; the wrappers
 * stay (they are the canonical redesign-side write surface).
 *
 * RACE-CONDITION HANDLING (Gap 9 alignment §5):
 *   If `rejectFieldMapping` finds the TFM has already been deleted by
 *   another caller between auth and our delete attempt, the wrapper
 *   returns `{ success: true, alreadyDeleted: true }` so the UI surfaces
 *   the same success state rather than a surprising NOT_FOUND. A thin
 *   activity-log entry with placeholder names is emitted to preserve
 *   the audit trail.
 *
 * IMPORT-GRAPH INVARIANT
 *   Files under `app/app/projects/[projectId]/mapping/redesign/**` MUST
 *   NOT import from `@/lib/actions/mappings` directly — the redesign
 *   surface goes through the wrappers in this file. Enforced by
 *   `tests/lib/no-shim-in-redesign-path.test.ts`.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  getMappingsForRedesignCore,
} from '@/lib/ai/mapping-engine'
import {
  deleteFieldMapping,
  generateMappings as legacyGenerateMappings,
  recomputeTableMappingStatus,
  updateFieldMappingStatus,
  type MappingWriteErrorCode,
} from '@/lib/actions/mappings'
import { logActivity } from '@/lib/actions/activity-log'
import { logAIEdit } from '@/lib/actions/ai-edit-history'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { removeAcknowledgment } from '@/lib/actions/field-acknowledgments'
import { resetFieldTransform } from '@/lib/actions/transformations'
import { runMappingSuggestion } from '@/lib/ai/mapping-engine'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { decodeShimmedRowId } from '@/lib/compat/mapping-shim'
import {
  inferFkCandidates,
  parseToFkFieldFromReference,
  type FkInferenceField,
  type FkInferenceTable,
} from '@/lib/utils/fk-inference'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

/**
 * Combination types user can select via the redesign-side W1 form.
 * Subset of the DB CHECK constraint enum (migration 074:156-157):
 *   ('single' | 'concat_space' | 'concat_comma' | 'custom_sql')
 *
 * `custom_sql` is BLOCKED from drawer-side authoring per founder
 * decision (Phase 4 plan §10) — transitions to custom_sql happen on
 * the Transform tab, not in the W1 form. The wrapper accepts only
 * the three values below; an incoming 'custom_sql' returns
 * `VALIDATION` with copy directing the user to Transform.
 */
export type CreateFieldMappingCombinationType =
  | 'single'
  | 'concat_space'
  | 'concat_comma'

// ─── Read path ────────────────────────────────────────────────────────────────

export async function getMappingsForRedesign(
  projectId: string,
): Promise<MappingsForRedesignResult | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  return getMappingsForRedesignCore(supabase, projectId)
}

// ─── Write path — Gap 9 ───────────────────────────────────────────────────────

export interface MappingActionResult {
  success: boolean
  error?: string
  errorCode?: MappingWriteErrorCode
}

export interface RejectMappingResult extends MappingActionResult {
  /**
   * True when the TFM was already gone by the time we tried to delete
   * it (concurrent caller deleted between our identity query and the
   * delete attempt). The UI treats this as a successful reject — the
   * end-state is identical (target field is unmapped).
   */
  alreadyDeleted?: boolean
  /**
   * Bubbled up from `deleteFieldMapping` so the UI can surface
   * "Resetting transformation" feedback if needed.
   */
  transformReset?: boolean
  stagedRowsReverted?: number
}

// ─── PR α₀ — no-source row approve/reject helpers ────────────────────────────
//
// PR α₀ extends the inline approve/reject affordances to no-source rows
// (kind: 'unmapped' synthesized by the read translator with a synthetic
// `unmapped::<targetFieldId>` id). The persistence target is
// `target_field_coverage.status` (migration 095) — independent of the
// TFM lifecycle. The two helpers below carry the shared writes.

const UNMAPPED_ID_PREFIX = 'unmapped::'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface FieldOwnership {
  projectId: string
  fieldName: string | null
}

/**
 * Resolve a target field's project_id + name via the schema ownership
 * chain (fields → tables → datasets). Used by the no-source approve/reject
 * paths, which receive a synthetic `unmapped::<targetFieldId>` id and have
 * no TFM to look up project context from.
 *
 * Returns null when the field doesn't exist (caller surfaces NOT_FOUND).
 */
async function resolveFieldOwnership(
  targetFieldId: string,
): Promise<FieldOwnership | null> {
  const { data, error } = await supabaseAdmin
    .from('fields')
    .select('id, name, tables!inner(datasets!inner(project_id))')
    .eq('id', targetFieldId)
    .single<{
      id: string
      name: string | null
      tables: { datasets: { project_id: string } }
    }>()
  if (error || !data) return null
  return {
    projectId: data.tables.datasets.project_id,
    fieldName: data.name ?? null,
  }
}

/**
 * UPSERT semantics for `target_field_coverage.status` driven by the user
 * (drawer/inline approve/reject). Preserves any existing
 * `coverage_status` verdict authored by Path D — a user-driven approval
 * decision is orthogonal to the AI's coverage analysis.
 *
 * Flow:
 *   1. UPDATE the existing row (if present) — sets status, status_set_by,
 *      updated_at. coverage_status untouched.
 *   2. If no row matched, INSERT a synthesized row with
 *      coverage_status='gap' (the user is explicitly deciding the row's
 *      fate; the AI never produced a verdict — 'gap' is the most
 *      semantically faithful default and is consistent with the PR γ
 *      backfill mapping `gap → needs_review`).
 *
 * Two round-trips in the create-new case, one round-trip in the common
 * update case. Avoids `.upsert()` because Supabase's upsert does a full
 * row replace on conflict, which would clobber Path D's coverage_status.
 */
async function setCoverageStatus(
  projectId: string,
  targetFieldId: string,
  status: 'needs_review' | 'approved' | 'rejected',
): Promise<{ success: boolean; error?: string }> {
  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('target_field_coverage')
    .update({ status, status_set_by: 'user', updated_at: now })
    .eq('project_id', projectId)
    .eq('target_field_id', targetFieldId)
    .select('id')
  if (updErr) return { success: false, error: updErr.message }
  if (updated && updated.length > 0) return { success: true }

  // No existing row — INSERT one. coverage_status defaults to 'gap'
  // (see helper JSDoc).
  const { error: insErr } = await supabaseAdmin
    .from('target_field_coverage')
    .insert({
      project_id: projectId,
      target_field_id: targetFieldId,
      coverage_status: 'gap',
      status,
      status_set_by: 'user',
    })
  if (insErr) return { success: false, error: insErr.message }
  return { success: true }
}

/**
 * Shared auth + permission gate for the no-source approve/reject paths.
 * Mirrors the inline check used by `createFieldMapping` (auth → role →
 * maintenance-mode) so the surface stays uniform across redesign-side
 * write actions.
 */
async function gateNoSourceWrite(
  projectId: string,
): Promise<{ ok: true } | { ok: false; result: MappingActionResult }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      ok: false,
      result: {
        success: false,
        error: 'Not authenticated',
        errorCode: 'PERMISSION_DENIED',
      },
    }
  }
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      ok: false,
      result: {
        success: false,
        error: perm.error ?? 'Insufficient permissions',
        errorCode: 'PERMISSION_DENIED',
      },
    }
  }
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        ok: false,
        result: {
          success: false,
          error: message,
          errorCode: 'MAINTENANCE_MODE',
        },
      }
    }
    return {
      ok: false,
      result: {
        success: false,
        error: message,
        errorCode: 'INTERNAL',
      },
    }
  }
  return { ok: true }
}

/**
 * Approve a TFM (mapped or value-assignment). Thin wrapper over
 * `updateFieldMappingStatus(rowId, 'approved')`.
 *
 * Pre-flight defenses (belt-and-suspenders alongside the UI's disabled-
 * state matrix):
 *   - Reject the `unmapped::<id>` sentinel (no TFM to approve).
 *   - Reject acknowledged TFMs (`is_acknowledged=true`). Acknowledged
 *     rows decode as `tfm-primary` in the redesign (their id is the
 *     bare TFM UUID — see `_mappings-for-redesign-core.ts` line 486),
 *     so the legacy action's `target-ack` short-circuit does NOT fire.
 *     Without this defense, an acknowledged row's TFM.status would be
 *     UPDATEd, which is a no-op on the audit trail but still represents
 *     incorrect intent.
 *
 * The legacy action handles auth, permission, guardWrites, the actual
 * UPDATE, table-mapping coverage recompute, and `mapping_approved`
 * activity logging.
 */
/**
 * Phase 4 empty-state — thin pass-through wrapper around the legacy
 * `generateMappings` action so the redesigned `GenerateMappingsPanel`
 * (a client component under `mapping/redesign/components/`) can call
 * AI-driven initial mapping generation without breaking the redesign
 * UI's grep invariant.
 *
 * Why a wrapper instead of a re-export? Next.js's SWC compiler rejects
 * `export … from '…'` re-exports in `'use server'` files — only direct
 * async function exports are allowed. The wrapper satisfies the
 * compiler while still routing through the legacy implementation,
 * which already handles auth, `requireProjectPermission('editor')`,
 * `guardWrites`, Claude orchestration, and persisting `table_mappings`
 * + `target_field_mappings` via `dq_create_target_field_mapping`.
 *
 * The redesign UI imports this symbol from
 * `@/lib/actions/mappings-for-redesign`. The grep invariant
 * (`tests/lib/no-shim-in-redesign-path.test.ts`) is satisfied because
 * the redesign tree never references `@/lib/actions/mappings` —
 * imports terminate at this file.
 *
 * When Phase 5 retires the legacy `MappingContent.tsx`, fold the
 * underlying implementation in here and drop the wrapper.
 */
export async function generateMappings(
  projectId: string,
  sourceTableIds: string[],
  targetTableIds: string[],
) {
  return legacyGenerateMappings(projectId, sourceTableIds, targetTableIds)
}

export async function approveFieldMapping(
  rowId: string,
): Promise<MappingActionResult> {
  // PR α₀ — no-source approve writes target_field_coverage.status='approved'
  // independent of any TFM. The synthetic id format is `unmapped::<uuid>`
  // (see `_mappings-for-redesign-core.ts`'s buildUnmappedRow).
  if (rowId.startsWith(UNMAPPED_ID_PREFIX)) {
    const targetFieldId = rowId.slice(UNMAPPED_ID_PREFIX.length)
    if (!UUID_REGEX.test(targetFieldId)) {
      return {
        success: false,
        error: 'Invalid row id',
        errorCode: 'VALIDATION',
      }
    }
    const ownership = await resolveFieldOwnership(targetFieldId)
    if (!ownership) {
      return {
        success: false,
        error: 'Target field not found',
        errorCode: 'NOT_FOUND',
      }
    }
    const gate = await gateNoSourceWrite(ownership.projectId)
    if (!gate.ok) return gate.result

    const writeResult = await setCoverageStatus(
      ownership.projectId,
      targetFieldId,
      'approved',
    )
    if (!writeResult.success) {
      return {
        success: false,
        error: writeResult.error ?? 'Failed to update coverage status',
        errorCode: 'INTERNAL',
      }
    }

    await logActivity(
      ownership.projectId,
      'mapping_approved',
      `Mapping approved: [no source] → ${ownership.fieldName ?? '?'}`,
      'mapping',
      {
        target_field_id: targetFieldId,
        target_field: ownership.fieldName,
        source_field: null,
        no_source: true,
      },
    )
    revalidatePath(`/app/projects/${ownership.projectId}/mapping`)
    return { success: true }
  }

  const decoded = decodeShimmedRowId(rowId)
  if (decoded.kind === 'tfm-primary' || decoded.kind === 'tfm-contributor') {
    const { data: tfm } = await supabaseAdmin
      .from('target_field_mappings')
      .select('is_acknowledged')
      .eq('id', decoded.tfmId)
      .single()
    if (tfm?.is_acknowledged) {
      return {
        success: false,
        error: 'Acknowledged rows do not support approve',
        errorCode: 'VALIDATION',
      }
    }
  }

  return updateFieldMappingStatus(rowId, 'approved')
}

/**
 * Reject a TFM under founder-amended semantics: the row is DELETEd
 * outright and the target field thereafter renders as Rule 6 (unmapped).
 *
 * Flow:
 *   1. Reject `unmapped::` sentinel (no TFM to delete).
 *   2. Decode to confirm we have a tfm-primary id.
 *   3. Query the TFM for project_id, target field name, primary source
 *      name, and `is_acknowledged` BEFORE attempting the delete. We
 *      need the names to populate the `mapping_rejected` activity log
 *      payload — `deleteFieldMapping` would have already removed them
 *      by the time we tried to look them up post-delete.
 *   4. If the TFM is acknowledged, refuse with VALIDATION (defensive
 *      alongside the UI's disabled-state matrix; see decision 7).
 *   5. If the TFM is missing (race condition: another caller deleted
 *      between us reading and us writing), log a thin
 *      `mapping_rejected` event with placeholder names and return
 *      `{ success: true, alreadyDeleted: true }`.
 *   6. Otherwise delegate to the legacy `deleteFieldMapping` (which
 *      handles permission, guardWrites, transform reset, FK-cascade,
 *      and TM coverage recompute) and emit `mapping_rejected` with
 *      the legacy-format payload `Mapping rejected: <src> → <tgt>`.
 *
 * The legacy `deleteFieldMapping` does NOT itself emit an activity
 * log entry, so the wrapper carries that responsibility. Reusing the
 * existing `mapping_rejected` event type (per founder decision 6 in
 * the Gap 9 alignment) avoids enum churn and keeps the user-facing
 * verb ("reject") canonical regardless of the internal delete
 * mechanism.
 */
export async function rejectFieldMapping(
  rowId: string,
): Promise<RejectMappingResult> {
  // PR α₀ — no-source reject writes target_field_coverage.status='rejected'
  // independent of any TFM. Mirrors the approve branch in
  // `approveFieldMapping`; the synthetic id format is `unmapped::<uuid>`.
  if (rowId.startsWith(UNMAPPED_ID_PREFIX)) {
    const targetFieldId = rowId.slice(UNMAPPED_ID_PREFIX.length)
    if (!UUID_REGEX.test(targetFieldId)) {
      return {
        success: false,
        error: 'Invalid row id',
        errorCode: 'VALIDATION',
      }
    }
    const ownership = await resolveFieldOwnership(targetFieldId)
    if (!ownership) {
      return {
        success: false,
        error: 'Target field not found',
        errorCode: 'NOT_FOUND',
      }
    }
    const gate = await gateNoSourceWrite(ownership.projectId)
    if (!gate.ok) {
      return {
        ...gate.result,
      }
    }

    const writeResult = await setCoverageStatus(
      ownership.projectId,
      targetFieldId,
      'rejected',
    )
    if (!writeResult.success) {
      return {
        success: false,
        error: writeResult.error ?? 'Failed to update coverage status',
        errorCode: 'INTERNAL',
      }
    }

    await logActivity(
      ownership.projectId,
      'mapping_rejected',
      `Mapping rejected: [no source] → ${ownership.fieldName ?? '?'}`,
      'mapping',
      {
        target_field_id: targetFieldId,
        target_field: ownership.fieldName,
        source_field: null,
        no_source: true,
      },
    )
    revalidatePath(`/app/projects/${ownership.projectId}/mapping`)
    return { success: true }
  }

  const decoded = decodeShimmedRowId(rowId)
  if (decoded.kind !== 'tfm-primary' && decoded.kind !== 'tfm-contributor') {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Identity snapshot BEFORE delete — names are needed for the activity
  // log payload and `is_acknowledged` is the defensive guard.
  const { data: tfmLookup } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      `id, project_id, target_field_id, is_acknowledged, confidence, ai_reasoning, transformation_intent, needs_transformation,
       fields:target_field_id(name)`,
    )
    .eq('id', decoded.tfmId)
    .single<{
      id: string
      project_id: string
      target_field_id: string
      is_acknowledged: boolean
      confidence: number | null
      ai_reasoning: string | null
      transformation_intent: string | null
      needs_transformation: boolean | null
      fields: { name: string } | null
    }>()

  if (!tfmLookup) {
    // Race condition path: TFM is already gone. Treat as success +
    // log a thin event so the audit trail still reflects the user's
    // explicit reject click. Project id is unrecoverable here, so we
    // skip the activity-log call (logActivity requires a project id);
    // the delete itself was performed by whoever raced us — they own
    // the audit-trail entry.
    return { success: true, alreadyDeleted: true }
  }

  if (tfmLookup.is_acknowledged) {
    return {
      success: false,
      error: 'Acknowledged rows do not support reject',
      errorCode: 'VALIDATION',
    }
  }

  // Resolve primary source name for the log payload. Best-effort:
  // missing primary or query failure → '[value]' fallback (matches
  // legacy `updateFieldMappingStatus` reject branch at
  // `lib/actions/mappings.ts:1373-1375`).
  const { data: primarySource } = await supabaseAdmin
    .from('mapping_sources')
    .select('source_field_id, fields:source_field_id(name)')
    .eq('target_field_mapping_id', tfmLookup.id)
    .order('ordinal', { ascending: true })
    .limit(1)
  const srcName =
    primarySource && primarySource.length > 0
      ? ((primarySource[0] as unknown as { fields?: { name?: string } | null })
          .fields?.name ?? null)
      : null
  const tgtName = tfmLookup.fields?.name ?? null

  const deleteResult = await deleteFieldMapping(rowId)
  if (!deleteResult.success) {
    return {
      success: false,
      error: deleteResult.error,
      errorCode: deleteResult.errorCode,
    }
  }

  // PR \u03b1\u2080 \u2014 write target_field_coverage.status='rejected' so the row
  // surfaces as rejected (not synthesized 'needs_review') on next read.
  // The translator's resolution priority post-PR-\u03b3: no TFM \u2192
  // coverage.status. Without this write, the row would default back to
  // 'needs_review' the moment the deleteFieldMapping cascade clears the
  // TFM, and the user's reject click would not stick.
  //
  // Best-effort: a failure here does NOT roll back the TFM delete (which
  // already committed) \u2014 the user gets a "Mapping rejected" success but
  // the row may transiently render 'needs_review' until the next user
  // action lands a coverage row. The activity log below will still
  // reflect the rejection intent; the user can re-click reject if the
  // visual state lags.
  const coverageWrite = await setCoverageStatus(
    tfmLookup.project_id,
    tfmLookup.target_field_id,
    'rejected',
  )
  if (!coverageWrite.success) {
    console.warn(
      '[rejectFieldMapping] coverage status write failed (TFM delete already committed):',
      coverageWrite.error,
    )
  }

  // Preserve row-level metadata on the resulting no-source row. Reject
  // deletes the mapped TFM, but the drawer still needs confidence,
  // explanation, and transformation guidance after refresh.
  const { error: preserveMetadataError } = await supabaseAdmin
    .from('target_field_mappings')
    .upsert(
      {
        project_id: tfmLookup.project_id,
        target_field_id: tfmLookup.target_field_id,
        is_acknowledged: true,
        acknowledgment_reason: 'Rejected by user',
        status: 'rejected',
        combination_type: null,
        combination_sql: null,
        confidence: tfmLookup.confidence,
        ai_reasoning: tfmLookup.ai_reasoning,
        transformation_intent: tfmLookup.transformation_intent,
        needs_transformation: tfmLookup.needs_transformation,
      },
      { onConflict: 'project_id,target_field_id' },
    )
  if (preserveMetadataError) {
    console.warn(
      '[rejectFieldMapping] rejected-row metadata preservation failed:',
      preserveMetadataError.message,
    )
  }

  // Log AFTER successful delete so a failed delete doesn't leave a
  // dangling rejection event. Format matches legacy reject branch
  // verbatim (`lib/actions/mappings.ts:1379`).
  await logActivity(
    tfmLookup.project_id,
    'mapping_rejected',
    `Mapping rejected: ${srcName ?? '[value]'} \u2192 ${tgtName ?? '?'}`,
    'mapping',
    {
      target_field_mapping_id: tfmLookup.id,
      target_field: tgtName,
      source_field: srcName,
    },
  )

  return {
    success: true,
    transformReset: deleteResult.transformReset,
    stagedRowsReverted: deleteResult.stagedRowsReverted,
  }
}

// ─── Write path — Phase 4a-1 ──────────────────────────────────────────────────
//
// `createFieldMapping` and `suggestMappingForTarget` form the server-side
// surface for W1 (manual mapping creation from Rule 6 unmapped target rows)
// and W6 (per-row AI Suggest as a sub-affordance of the W1 form).
//
// Cross-table sources are supported (Phase 4a-3) and the FK-precheck
// disambiguation surface was removed in Cycle 1 — multi-candidate FK
// resolution now happens at Transform-tab apply time
// (`CROSS_TABLE_FK_INFERENCE_FAILED`) when the read-path inference cannot
// resolve a unique FK. `mapping_sources.join_spec` is always null on the
// write path; the read path re-derives via-FK annotations through
// `inferFkCandidates`.
//
// Audit-log emitter: this file emits `mapping_created` (and Phase 4 plan
// §2.2 catalogues the other 5 emitters that will land in 4b/4c). The legacy
// `addManualFieldMapping` does NOT emit an activity-log entry today, so the
// wrapper is the FIRST creation path that lands on the audit trail —
// matching the redesign UI being the canonical create-mapping surface.

export type CreateFieldMappingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'
  /**
   * 4a-1 same-table-only emitter. Phase 4a-3 lifts the same-table guard
   * and never emits this code; the union member is retained on the type
   * so older clients that branch on it continue to compile.
   */
  | 'CROSS_TABLE_NOT_YET_SUPPORTED'

export type CreateFieldMappingResult =
  | {
      success: true
      tfmId: string
      tableMappingId: string
    }
  | {
      success: false
      error: string
      errorCode: CreateFieldMappingErrorCode
    }

/**
 * Create a target_field_mapping with one or more sources in a single
 * atomic RPC call.
 *
 * Same-table and cross-table sources both supported as of Phase 4a-3.
 * Cycle 1 removed the cross-table FK precheck and the form-side
 * disambiguation surface. The anchor source table is the first source's
 * table (selection order); `mapping_sources.join_spec` is always null
 * on the write path. The read path re-derives via-FK annotations per
 * render through `inferFkCandidates`. Multi-candidate ambiguity surfaces
 * at Transform-tab apply time as `CROSS_TABLE_FK_INFERENCE_FAILED` if
 * the read-path inference cannot resolve a unique FK.
 *
 * Apply RPC: Phase 4a-6 wired the cross-table branch of
 * `dq_apply_field_transform_joined` (migration 076).
 * `lib/actions/transformations.ts:applyTransform` derives the
 * `p_join_spec` JSONB at apply time via `buildJoinSpec` — per-source
 * dedupe to per-table joins, FK re-derivation when stored
 * `join_spec` is null (always, post-Cycle 1).
 *
 * SEQUENCE (per Phase 4a-3 investigation §2):
 *   1. Auth + permission (`requireProjectPermission(..., 'editor')`).
 *   2. Validate inputs: 1+ sources, no duplicates, combinationType not
 *      'custom_sql', single↔concat sanity.
 *   3. Identity reads: source fields with their table_id+name, target
 *      field with its table_id+name.
 *   4. Defensive guards: all field IDs belong to this project; no
 *      duplicate sourceFieldIds.
 *   5. Maintenance-mode guard (`assertMappingWritesEnabled`).
 *   5b. Anchor-source identification (first source's table_id).
 *   6. Existing-TFM collision check.
 *   7. Find-or-create table_mappings row for (anchorTable, targetTable);
 *      Cycle 1 fans out to every distinct source table so each lands a
 *      TM row (Block 4 rollup auto-management).
 *   8. RPC call `dq_create_target_field_mapping` — `join_spec` is null
 *      for every source.
 *   9. `recomputeTableMappingStatus` per source-table TM (fan-out).
 *  10. revalidatePath for /mapping AND /transform.
 *  11. Emit `mapping_created` activity log entry.
 */
export async function createFieldMapping(input: {
  projectId: string
  targetFieldId: string
  sourceFieldIds: string[]
  combinationType: CreateFieldMappingCombinationType | 'custom_sql'
  /** Set true when the form was pre-filled by `suggestMappingForTarget`. */
  aiSuggested?: boolean
  /** Per-source confidence (uniform). Defaults to 100 for manual paths. */
  confidence?: number
  /** Optional AI rationale to persist on TFM.ai_reasoning (decision 4). */
  aiReasoning?: string | null
  /**
   * @deprecated Cycle 1 architectural rebuild — Mapping no longer persists join_spec.
   * Read path re-derives via inferFkCandidates. Parameter retained for client back-compat;
   * value is ignored. May be re-instated in Cycle 2 under the new owning-TM rule.
   */
  joinAnnotations?: Record<string, string>
}): Promise<CreateFieldMappingResult> {
  // ── Step 1: validation (cheap, before any I/O) ────────────────────────────
  const {
    projectId,
    targetFieldId,
    sourceFieldIds,
    combinationType,
    aiSuggested = false,
    confidence,
    aiReasoning = null,
    joinAnnotations = {},
  } = input

  if (!projectId || !targetFieldId) {
    return {
      success: false,
      error: 'projectId and targetFieldId are required',
      errorCode: 'VALIDATION',
    }
  }

  if (!Array.isArray(sourceFieldIds) || sourceFieldIds.length === 0) {
    return {
      success: false,
      error: 'At least one source field is required',
      errorCode: 'VALIDATION',
    }
  }

  if (combinationType === 'custom_sql') {
    return {
      success: false,
      error:
        'Custom SQL combinations are authored on the Transform tab, not here',
      errorCode: 'VALIDATION',
    }
  }

  if (combinationType === 'single' && sourceFieldIds.length !== 1) {
    return {
      success: false,
      error: "combination_type 'single' requires exactly one source field",
      errorCode: 'VALIDATION',
    }
  }

  if (combinationType !== 'single' && sourceFieldIds.length < 2) {
    return {
      success: false,
      error: `combination_type '${combinationType}' requires at least two source fields`,
      errorCode: 'VALIDATION',
    }
  }

  // Duplicate sources are a UI bug (the picker should dedupe). Reject
  // here as a defense-in-depth — the DB has no UNIQUE constraint on
  // (target_field_mapping_id, source_field_id) so duplicates would
  // silently double-count in concat_* combinations.
  if (new Set(sourceFieldIds).size !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'Duplicate source fields are not allowed',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: maintenance-mode guard ───────────────────────────────────────
  // Inline rather than wrapping the whole body in a guardWrites helper —
  // the legacy `guardWrites` is module-private to lib/actions/mappings.ts
  // and the wrapper here is the only redesign-side caller, so a colocated
  // guard keeps the contract surface flat.
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Step 4: identity reads ───────────────────────────────────────────────
  // Single round-trip per entity. Use admin client for the cross-table
  // read so RLS narrowing on `fields` doesn't silently drop a source the
  // user lacks SELECT on — the wrapper's project-membership check above
  // is the authoritative gate.
  // Project ownership chain: fields.table_id → tables.dataset_id →
  // datasets.project_id. The `tables` table has NO `project_id` column
  // of its own — joining `tables(project_id)` would return a PostgREST
  // 42703 ("column tables_1.project_id does not exist"). Match the
  // legacy pattern at `lib/actions/fields.ts:81` which walks both hops
  // through `!inner` to keep the join restrictive.
  const { data: targetField, error: tfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', targetFieldId)
    .single<{
      id: string
      name: string
      table_id: string
      tables:
        | { datasets: { project_id: string } | { project_id: string }[] | null }
        | {
            datasets: { project_id: string } | { project_id: string }[] | null
          }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Defensive: target field belongs to this project. PostgREST returns
  // a one-to-one join either as a single object or a singleton array
  // depending on relationship-cardinality inference; tolerate both.
  const targetTables = Array.isArray(targetField.tables)
    ? targetField.tables[0]
    : targetField.tables
  const targetDatasets = Array.isArray(targetTables?.datasets)
    ? targetTables?.datasets[0]
    : targetTables?.datasets
  const targetProjectId = targetDatasets?.project_id
  if (targetProjectId !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'VALIDATION',
    }
  }

  // Same join-chain caveat as the target-field read above: walk through
  // datasets to reach project_id. `tables` has no project_id column.
  const { data: sourceFields, error: sfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .in('id', sourceFieldIds)
    .returns<
      Array<{
        id: string
        name: string
        table_id: string
        tables:
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }[]
          | null
      }>
    >()
  if (sfErr || !sourceFields) {
    return {
      success: false,
      error: 'Failed to read source fields',
      errorCode: 'INTERNAL',
    }
  }

  if (sourceFields.length !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'One or more source fields not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Defensive: every source field belongs to this project.
  for (const sf of sourceFields) {
    const sfTables = Array.isArray(sf.tables) ? sf.tables[0] : sf.tables
    const sfDatasets = Array.isArray(sfTables?.datasets)
      ? sfTables?.datasets[0]
      : sfTables?.datasets
    const sfProject = sfDatasets?.project_id
    if (sfProject !== projectId) {
      return {
        success: false,
        error: 'One or more source fields do not belong to this project',
        errorCode: 'VALIDATION',
      }
    }
  }

  // Re-order `sourceFields` to match the input `sourceFieldIds` order
  // (Postgres `.in()` returns rows in DB order, not input order). This
  // matters for `ordinal` assignment below — first input id = ordinal 0
  // = dominant source.
  const sourceFieldsById = new Map(sourceFields.map((f) => [f.id, f]))
  const orderedSources = sourceFieldIds.map((id) => sourceFieldsById.get(id)!)

  // ── Step 5b: anchor-source identification ────────────────────────────────
  // Anchor source table = first source's table_id (selection order). The
  // form picker preserves user selection order, so the anchor is the
  // table the user picked first. Cross-table sources are written without
  // a persisted `join_spec`; the read path re-derives via-FK annotations
  // through `inferFkCandidates`. Cycle 1 removed the form-side FK
  // disambiguation prompt and the server-side precheck — multi-candidate
  // ambiguity will surface at Transform-tab apply time as
  // `CROSS_TABLE_FK_INFERENCE_FAILED` if the read-path inference cannot
  // resolve a unique FK.
  //
  // Block 4 — TM rollup fan-out: every distinct source-table-id in
  // `orderedSources` lands a `table_mappings` row + recompute (so the
  // counter pills + table-level status reflect the new TFM under every
  // contributing source table, not just the anchor). The anchor remains
  // first-source-wins under the hood (Cycle 1) — Cycle 2 will rewrite
  // owning-TM semantics and migrate the apply RPC.
  const anchorTableId = orderedSources[0].table_id
  const sourceTableId = anchorTableId
  const uniqueSourceTableIds = new Set(orderedSources.map((s) => s.table_id))

  // ── Step 6: existing-TFM collision check ─────────────────────────────────
  const { data: existingTfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, status, is_acknowledged, combination_type')
    .eq('project_id', projectId)
    .eq('target_field_id', targetFieldId)
    .maybeSingle()

  if (existingTfm) {
    // Bare-acknowledgment exception: an `is_acknowledged=true` TFM with
    // `combination_type=null` has no mapping_sources or transformations,
    // so we can delete it cleanly to make room for the new mapping. This
    // mirrors legacy `addManualFieldMapping:1714-1719` and is the implicit
    // "create a mapping = un-ack the field" path.
    if (
      existingTfm.is_acknowledged === true &&
      existingTfm.combination_type === null
    ) {
      const { error: bareAckDelErr } = await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .eq('id', existingTfm.id)
      if (bareAckDelErr) {
        return {
          success: false,
          error: bareAckDelErr.message,
          errorCode: 'INTERNAL',
        }
      }
    } else if (existingTfm.status !== 'rejected') {
      // Any other live TFM (mapped, VA, full acknowledgment) blocks
      // creation. Per founder decision 3, surface the "refresh" copy
      // — we don't auto-convert to contributor (that decision belongs
      // on the form's UX, not silent server behavior).
      return {
        success: false,
        error:
          'This target field was mapped while you were editing. Refresh to see the current state.',
        errorCode: 'VALIDATION',
      }
    }
    // status === 'rejected' is impossible post-Gap-9 (reject = delete)
    // but if a legacy rejected row survives in production (Demo #2
    // SimpleLegal has 1), fall through and create alongside it. The
    // RPC's INSERT will fail on the (project_id, target_field_id)
    // unique constraint if so — surface as INTERNAL.
  }

  // ── Step 7: find-or-create table mapping(s) ──────────────────────────────
  // Block 4 — fan out across every distinct source-table id in the new
  // sources. The anchor TM (first source's table → target table) is
  // returned to the caller as `tableMappingId` for backward-compat with
  // existing call sites that expect a single id. Non-anchor TMs are
  // created best-effort; a failure on any one short-circuits with
  // INTERNAL, matching the single-TM path's failure mode.
  let tableMappingId: string | null = null
  for (const sourceTableIdInLoop of uniqueSourceTableIds) {
    const tmLoopResult = await findOrCreateTableMapping(
      projectId,
      sourceTableIdInLoop,
      targetField.table_id,
    )
    if (!tmLoopResult.success) {
      return {
        success: false,
        error: tmLoopResult.error,
        errorCode: 'INTERNAL',
      }
    }
    if (sourceTableIdInLoop === sourceTableId) {
      tableMappingId = tmLoopResult.id
    }
  }
  if (tableMappingId === null) {
    // Defensive — `uniqueSourceTableIds` includes `sourceTableId` by
    // construction (it's `orderedSources[0].table_id`), but TS can't
    // prove that statically. If this fires, it indicates schema drift
    // or a bad source field.
    return {
      success: false,
      error: 'Failed to resolve anchor table_mapping id',
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 8: RPC call ─────────────────────────────────────────────────────
  // Per-source confidence: AI path passes uniform `confidence`; manual
  // path defaults to 100. The Transform-tab apply rules don't currently
  // gate on per-source confidence so this is metadata-only today.
  const perSourceConfidence = typeof confidence === 'number' ? confidence : 100
  const tfmAiReasoning = aiReasoning
    ? aiReasoning
    : aiSuggested
      ? 'AI-suggested via per-row Suggest'
      : 'Mapping created via redesign UI'
  const perSourceReasoning = aiSuggested
    ? `AI-suggested: ${(aiReasoning ?? '').slice(0, 280)}`.trim()
    : 'Manually selected by user'

  const rpcSources = orderedSources.map((sf, idx) => {
    // Cycle 1 — `join_spec` is always null on the write path. The read
    // path re-derives the via-FK annotation per render through
    // `inferFkCandidates`, so persistence is redundant.
    return {
      source_field_id: sf.id,
      source_table_id: sf.table_id,
      confidence: perSourceConfidence,
      ai_reasoning: perSourceReasoning,
      type_compatibility: null as string | null,
      similar_fields_considered: [] as string[],
      join_spec: null as unknown,
      ordinal: idx,
    }
  })

  const { data: rpcTfmId, error: rpcErr } = await supabase.rpc(
    'dq_create_target_field_mapping',
    {
      p_project_id: projectId,
      p_target_field_id: targetFieldId,
      p_sources: rpcSources,
      p_combination: {
        type: combinationType,
        ai_reasoning: tfmAiReasoning,
      },
    },
  )

  if (rpcErr || !rpcTfmId) {
    return {
      success: false,
      error: rpcErr?.message ?? 'RPC failed',
      errorCode: 'INTERNAL',
    }
  }
  const newTfmId = rpcTfmId as string

  // ── Step 9: coverage recompute ───────────────────────────────────────────
  // Closes the legacy gap: addManualFieldMapping never called recompute,
  // leaving table_mappings.status stale until the next read-path action
  // happened to trigger it. The redesign-side wrapper owns this
  // explicitly so coverage-driven UI (counter pills, table-level status)
  // updates immediately.
  //
  // Block 4 — fan out the recompute across every distinct source table
  // so each TM's counter rollup picks up the new TFM. Anchor + non-
  // anchor TMs are recomputed identically.
  for (const sourceTableIdInLoop of uniqueSourceTableIds) {
    const tmIdForRecompute =
      sourceTableIdInLoop === sourceTableId
        ? tableMappingId
        : (
            await supabaseAdmin
              .from('table_mappings')
              .select('id')
              .eq('project_id', projectId)
              .eq('source_table_id', sourceTableIdInLoop)
              .eq('target_table_id', targetField.table_id)
              .maybeSingle()
          ).data?.id
    if (typeof tmIdForRecompute === 'string') {
      await recomputeTableMappingStatus(supabase, tmIdForRecompute)
    }
  }

  // ── Step 10: revalidate ──────────────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath(`/app/projects/${projectId}/transform`)
  // PR-4: dashboard tile aggregates target_field_mappings; refresh it too.
  revalidatePath('/app/projects')

  // ── Step 11: activity log ────────────────────────────────────────────────
  // Format: `Mapping created: <src1>, <src2>, +N more → <tgt>` for
  // verbosity parity with `mapping_rejected` payload from Gap 9.
  // For >3 sources, truncate the inline list to keep the activity feed
  // scannable.
  const srcNames = orderedSources.map((s) => s.name)
  const inlineSrcList =
    srcNames.length <= 3
      ? srcNames.join(', ')
      : `${srcNames.slice(0, 2).join(', ')}, +${srcNames.length - 2} more`
  const description = `${aiSuggested ? 'AI-suggested mapping' : 'Mapping'} created: ${inlineSrcList} \u2192 ${targetField.name}`

  await logActivity(projectId, 'mapping_created', description, 'mapping', {
    target_field_mapping_id: newTfmId,
    target_field: targetField.name,
    target_field_id: targetFieldId,
    source_fields: srcNames,
    source_field_ids: sourceFieldIds,
    combination_type: combinationType,
    ai_suggested: aiSuggested,
    cross_table: uniqueSourceTableIds.size > 1,
  })

  return {
    success: true,
    tfmId: newTfmId,
    tableMappingId,
  }
}

// ─── Helper: find-or-create table_mappings ────────────────────────────────────
//
// Lifted from legacy `mapUnmappedField:2110-2134` so the redesign
// wrapper does not have to import a legacy entry-point that bundles
// auth + addManualFieldMapping + revalidate (we want JUST the
// find-or-create logic). Stays internal to this module.
//
// Uses the admin client because the wrapper has already verified
// project membership; an RLS-narrowed read could miss an existing TM
// row that the user lacks SELECT on, leading to a doomed INSERT.

async function findOrCreateTableMapping(
  projectId: string,
  sourceTableId: string,
  targetTableId: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .eq('source_table_id', sourceTableId)
    .eq('target_table_id', targetTableId)
    .maybeSingle()

  if (lookupErr) {
    return { success: false, error: lookupErr.message }
  }
  if (existing) {
    return { success: true, id: existing.id }
  }

  const { data: created, error: createErr } = await supabaseAdmin
    .from('table_mappings')
    .insert({
      project_id: projectId,
      source_table_id: sourceTableId,
      target_table_id: targetTableId,
      confidence: null,
      status: 'needs_review',
    })
    .select('id')
    .single()

  if (createErr || !created) {
    return {
      success: false,
      error: createErr?.message ?? 'Failed to create table mapping',
    }
  }
  return { success: true, id: created.id }
}

// ─── Per-target AI Suggest — Phase 4a-1 ───────────────────────────────────────
//
// `suggestMappingForTarget` is the W6 server-side surface: given a single
// target field, ask the LLM for ONE proposed mapping (1+ source fields +
// combination strategy + confidence + rationale). The wrapper returns an
// ephemeral suggestion for the form to pre-fill — NO DB writes happen
// here. Confirmation flows through `createFieldMapping` with
// `aiSuggested: true`.
//
// Distinct from legacy `suggestRemainingMappings` (per-TM bulk, same-
// table, 1:1 output schema, persists immediately). Net-new prompt body;
// reuses `buildAIContext` + `callClaude` + `checkAIRateLimit` plumbing.
//
// Same-table only in 4a-1 — the prompt instructs the LLM to choose
// sources from the target field's project's source schema BUT to keep
// all sources in a single source table. Cross-table extension in 4a-3.
//
// AUDIT LOG: this wrapper does NOT emit an activity_log entry on
// invocation. Suggestions are ephemeral; only `mapping_created` (with
// `ai_suggested: true` metadata) records the user's eventual commit.
// The rate limiter (in-memory; not durable) tracks invocation volume.

export type SuggestMappingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'AI_INVALID_RESPONSE'
  | 'INTERNAL'

export type SuggestMappingForTargetResult =
  | {
      success: true
      suggestion: {
        sourceFieldIds: string[]
        combinationType: CreateFieldMappingCombinationType
        confidence: number
        rationale: string
      }
    }
  | {
      success: false
      error: string
      errorCode: SuggestMappingErrorCode
    }

// `ClaudeSuggestionResponse` interface and `RATIONALE_MAX_CHARS` constant
// moved to `lib/ai/mapping-engine.ts` alongside `runMappingSuggestion`
// in PR 5. The wrapper below delegates all AI work; nothing in this
// file references those symbols anymore.

export async function suggestMappingForTarget(input: {
  projectId: string
  targetFieldId: string
}): Promise<SuggestMappingForTargetResult> {
  const { projectId, targetFieldId } = input

  if (!projectId || !targetFieldId) {
    return {
      success: false,
      error: 'projectId and targetFieldId are required',
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  // Shared 100-calls/hour budget with `suggestRemainingMappings` and other
  // AI features (lib/ai/rate-limit.ts). Per-target Suggest is meant to be
  // selective — pilot users hitting the cap is signal to revisit, not a
  // wrapper concern.
  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) {
    return {
      success: false,
      error: rateLimit.error ?? 'AI rate limit exceeded',
      errorCode: 'RATE_LIMITED',
    }
  }

  // ── Delegate to engine ───────────────────────────────────────────────────
  // Engine returns a narrower error union ('NOT_FOUND' |
  // 'AI_INVALID_RESPONSE' | 'INTERNAL') — every member is a subset of
  // SuggestMappingErrorCode, so direct pass-through is type-safe. We
  // pass `supabaseAdmin` because the legacy bypassed RLS for the
  // target-field + source-field reads after the explicit
  // `requireProjectPermission` gate above.
  return runMappingSuggestion(supabaseAdmin, user.id, projectId, targetFieldId)
}

// ─── Write path — Phase 4b-1 (edit existing mappings) ────────────────────────
//
// `editMappingSources`, `updateMappingCombination`, and `previewEditInvalidation`
// form the W2 (sources) + W3 (combination) edit surfaces for an EXISTING TFM
// reachable from the redesign drawer. New behavior contract (per founder
// decisions §1-§10 in the Phase 4b investigation):
//
//   • Status revert  — any source/combination change flips the TFM back to
//                      `needs_review` regardless of prior state. The user
//                      must explicitly Approve again.
//   • Provenance laundering — when a source change strips every original
//                      AI-suggested source, the TFM-level `ai_reasoning`
//                      and per-source AI markers are wiped to manual
//                      provenance. Retaining ≥1 original AI source
//                      preserves the AI markers on retained rows; new
//                      rows always carry manual markers.
//   • Transform reset — source edits call `resetFieldTransform`, which
//                      deletes the transformations row AND reverts staged
//                      data (strips the target field key). Combination-only
//                      edits do NOT reset the transform (§1.3) — the
//                      transform SQL is still valid, only the combination
//                      semantics changed.
//   • Anchor table swap unrestricted (Cycle 1) — the founder lifted the
//                      4b-1 dominant-swap guard. Inline edits can change
//                      the first source's table; the wrapper re-anchors
//                      the table-mapping on the next save (Block 4 fan-
//                      out hits every distinct source table). Multi-
//                      candidate FK ambiguity surfaces at Transform-tab
//                      apply time as `CROSS_TABLE_FK_INFERENCE_FAILED`.
//   • Bare-acknowledged TFMs (`is_acknowledged=true`, no sources) cannot
//                      be edited via this path — the un-acknowledge flow
//                      ships as W4 in 4b-2 (founder decision §3.4 +
//                      §9.1). Returns `TFM_ACKNOWLEDGED`.
//   • Defensive `TFM_REJECTED` — post Gap-9 reject == delete, so a
//                      rejected TFM should be unreachable; if a legacy
//                      rejected row survives, refuse to mutate it.
//
// `previewEditInvalidation` is a read-only pre-save query the drawer
// invokes BEFORE calling `editMappingSources` so it can show the
// EditInvalidationDialog warning when (a) a transform exists for this
// field AND (b) staged_data_rows reference the target field key. The
// drawer-side dialog routes through `editMappingSources` regardless on
// confirm — the preview only drives copy.

export type EditMappingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'
  /**
   * Defensive — post-Gap-9 a rejected TFM should be unreachable
   * (reject == delete). If a legacy `status='rejected'` row survives,
   * refuse to mutate it; the user must reject (delete) and re-create.
   */
  | 'TFM_REJECTED'
  /**
   * Bare-acknowledged TFM (`is_acknowledged=true`, no sources). Edit
   * doesn't apply; the user must un-acknowledge first (W4 in 4b-2).
   */
  | 'TFM_ACKNOWLEDGED'

export type EditMappingResult =
  | {
      success: true
      tfmId: string
      /**
       * True when `resetFieldTransform` actually deleted a transform row.
       * The drawer surfaces a "Re-author transform" deep-link in the
       * post-save toast when this is true.
       */
      transformReset: boolean
      /** Number of staged_data_rows whose target field key was reverted. */
      stagedRowsReverted: number
      /**
       * True when the source set changed (set diff vs. existing). Combination-
       * only or no-op edits report `false`. Drives whether the drawer's
       * post-save toast mentions invalidation at all.
       */
      sourcesChanged: boolean
    }
  | {
      success: false
      error: string
      errorCode: EditMappingErrorCode
    }

export type UpdateCombinationErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'
  | 'TFM_REJECTED'
  | 'TFM_ACKNOWLEDGED'

export type UpdateCombinationResult =
  | { success: true; tfmId: string }
  | {
      success: false
      error: string
      errorCode: UpdateCombinationErrorCode
    }

export type PreviewEditInvalidationResult =
  | {
      success: true
      hasTransform: boolean
      /**
       * Count of staged_data_rows whose `transformed_row_data` JSONB
       * carries the target field name as a key. Capped at
       * PREVIEW_INVALIDATION_COUNT_CAP (101) so the dialog can render
       * "100+ staged rows" without paging through millions of rows.
       */
      stagedRowCount: number
      /** True when stagedRowCount hit the cap (i.e. real count is ≥ cap). */
      capped: boolean
    }
  | {
      success: false
      error: string
      errorCode: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'INTERNAL'
    }

/**
 * Founder decision §2.1 — show exact count when ≤100, qualitative copy
 * ("100+ staged rows") otherwise. The preview query caps at
 * `PREVIEW_INVALIDATION_COUNT_CAP` so a project with millions of staged
 * rows doesn't punish the dialog with a full count.
 */
// Note: `'use server'` files can only export async functions, so this
// is a module-internal const. The number is also documented in
// `docs/features/mapping-redesign.md` and referenced by name in
// `EditInvalidationDialog.tsx`'s JSDoc.
const PREVIEW_INVALIDATION_COUNT_CAP = 101

/**
 * Edit the source set of an existing TFM. See file header for the full
 * 4b-1 contract. This is the W2 server-side surface.
 *
 * SEQUENCE:
 *   1.  Cheap input validation (1+ sources, no dups, custom_sql blocked,
 *       single↔concat sanity).
 *   2.  Auth (Supabase user).
 *   3.  Identity reads: TFM (with project_id, target_field_id, status,
 *       is_acknowledged, ai_reasoning, combination_type) + existing
 *       mapping_sources (with source_field_id + ai_reasoning).
 *   4.  Project permission gate (`requireProjectPermission(..., 'editor')`).
 *   5.  Defensive state guards: TFM_REJECTED (post-Gap-9 unreachable),
 *       TFM_ACKNOWLEDGED (bare-ack TFM has no sources to edit).
 *   6.  Maintenance-mode guard.
 *   7.  Source field identity reads (project ownership) + reorder to
 *       input order (anchor = ordinal 0).
 *   8.  Anchor-source identification (Cycle 1: dominant-swap guard and
 *       cross-table FK precheck were both removed; inline edits across
 *       tables are unrestricted).
 *  10.  Provenance laundering: read existing AI-suggested source ids,
 *       compute retained set, derive new TFM-level ai_reasoning and
 *       per-source ai_reasoning markers.
 *  11.  Compute set-diff to drive `sourcesChanged` flag (drives
 *       transform reset + activity log + post-save toast).
 *  12.  RPC `dq_replace_mapping_sources` — atomic DELETE+INSERT. Fires
 *       only when something actually changed (no-op edits skip).
 *  13.  UPDATE target_field_mappings SET status='needs_review',
 *       combination_type=<new>, ai_reasoning=<new>, updated_at=now().
 *  14.  If sourcesChanged: `resetFieldTransform` to clean up transform
 *       row + revert staged data.
 *  15.  Coverage recompute on the (existing) table_mappings row.
 *  16.  revalidatePath /mapping AND /transform.
 *  17.  Activity log: `mapping_sources_changed` always (even no-op so
 *       the audit trail captures the user's explicit edit click).
 *       Plus `transformation_reset` when applicable.
 *  18.  Return result with transformReset + stagedRowsReverted +
 *       sourcesChanged so the drawer can drive its post-save toast.
 */
export async function editMappingSources(input: {
  tfmId: string
  sourceFieldIds: string[]
  combinationType: CreateFieldMappingCombinationType | 'custom_sql'
  /**
   * @deprecated Cycle 1 architectural rebuild — Mapping no longer persists join_spec.
   * Read path re-derives via inferFkCandidates. Parameter retained for client back-compat;
   * value is ignored. May be re-instated in Cycle 2 under the new owning-TM rule.
   */
  joinAnnotations?: Record<string, string>
}): Promise<EditMappingResult> {
  const {
    tfmId,
    sourceFieldIds,
    combinationType,
    joinAnnotations = {},
  } = input

  // ── Step 1: validation ───────────────────────────────────────────────────
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!Array.isArray(sourceFieldIds) || sourceFieldIds.length === 0) {
    return {
      success: false,
      error: 'At least one source field is required',
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType === 'custom_sql') {
    return {
      success: false,
      error:
        'Custom SQL combinations are authored on the Transform tab, not here',
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType === 'single' && sourceFieldIds.length !== 1) {
    return {
      success: false,
      error: "combination_type 'single' requires exactly one source field",
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType !== 'single' && sourceFieldIds.length < 2) {
    return {
      success: false,
      error: `combination_type '${combinationType}' requires at least two source fields`,
      errorCode: 'VALIDATION',
    }
  }
  if (new Set(sourceFieldIds).size !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'Duplicate source fields are not allowed',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: identity read — TFM + existing sources ───────────────────────
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      'id, project_id, target_field_id, status, is_acknowledged, ai_reasoning, combination_type',
    )
    .eq('id', tfmId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      ai_reasoning: string | null
      combination_type: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }
  const projectId = tfm.project_id

  // ── Step 4: permission ───────────────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 5: defensive state guards ──────────────────────────────────────
  if (tfm.status === 'rejected') {
    return {
      success: false,
      error:
        "This mapping has been rejected. Reject and re-create instead of editing.",
      errorCode: 'TFM_REJECTED',
    }
  }
  if (tfm.is_acknowledged) {
    return {
      success: false,
      error:
        "This field is acknowledged. Un-acknowledge it first to map it.",
      errorCode: 'TFM_ACKNOWLEDGED',
    }
  }

  // ── Step 6: maintenance gate ─────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Step 7: identity reads — target field + source fields ───────────────
  const { data: targetField, error: tfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', tfm.target_field_id)
    .single<{
      id: string
      name: string
      table_id: string
      tables:
        | { datasets: { project_id: string } | { project_id: string }[] | null }
        | {
            datasets: { project_id: string } | { project_id: string }[] | null
          }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const { data: sourceFields, error: sfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .in('id', sourceFieldIds)
    .returns<
      Array<{
        id: string
        name: string
        table_id: string
        tables:
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }[]
          | null
      }>
    >()
  if (sfErr || !sourceFields) {
    return {
      success: false,
      error: 'Failed to read source fields',
      errorCode: 'INTERNAL',
    }
  }
  if (sourceFields.length !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'One or more source fields not found',
      errorCode: 'NOT_FOUND',
    }
  }
  for (const sf of sourceFields) {
    const sfTables = Array.isArray(sf.tables) ? sf.tables[0] : sf.tables
    const sfDatasets = Array.isArray(sfTables?.datasets)
      ? sfTables?.datasets[0]
      : sfTables?.datasets
    const sfProject = sfDatasets?.project_id
    if (sfProject !== projectId) {
      return {
        success: false,
        error: 'One or more source fields do not belong to this project',
        errorCode: 'VALIDATION',
      }
    }
  }
  const sourceFieldsById = new Map(sourceFields.map((f) => [f.id, f]))
  const orderedSources = sourceFieldIds.map((id) => sourceFieldsById.get(id)!)

  // ── Step 7b: identity read — existing mapping_sources ───────────────────
  // Captures both the original dominant table (for swap detection) and
  // the AI-suggested source ids (for provenance laundering).
  const { data: existingSources, error: esErr } = await supabaseAdmin
    .from('mapping_sources')
    .select('source_field_id, source_table_id, ai_reasoning, ordinal')
    .eq('target_field_mapping_id', tfm.id)
    .order('ordinal', { ascending: true })
    .returns<
      Array<{
        source_field_id: string | null
        source_table_id: string | null
        ai_reasoning: string | null
        ordinal: number | null
      }>
    >()
  if (esErr || !existingSources) {
    return {
      success: false,
      error: 'Failed to read existing mapping sources',
      errorCode: 'INTERNAL',
    }
  }
  // AI-suggested rows are tagged with `ai_reasoning` starting with
  // 'AI-suggested:' (per createFieldMapping's perSourceReasoning). Manual
  // rows carry 'Manually selected by user'. Provenance is tracked at the
  // source row level so a single TFM can mix retained-AI + new-manual
  // rows after an edit.
  const originalAiSuggestedSourceIds = new Set<string>(
    existingSources
      .filter(
        (s) =>
          s.source_field_id !== null &&
          typeof s.ai_reasoning === 'string' &&
          s.ai_reasoning.startsWith('AI-suggested:'),
      )
      .map((s) => s.source_field_id as string),
  )
  const existingSourceFieldIds = new Set<string>(
    existingSources
      .filter((s) => s.source_field_id !== null)
      .map((s) => s.source_field_id as string),
  )

  // ── Step 8: anchor-source identification ────────────────────────────────
  // Cycle 1 — the dominant-source-changed guard and the cross-table FK
  // precheck were both removed. Inline edits across tables are now
  // unrestricted: the user can swap the anchor source freely, and the
  // wrapper will re-derive the table_mapping anchor on the next save
  // (Block 4 fan-out). Multi-candidate FK ambiguity surfaces at
  // Transform-tab apply time as `CROSS_TABLE_FK_INFERENCE_FAILED`.
  const anchorTableId = orderedSources[0].table_id
  const sourceTableId = anchorTableId

  // ── Step 10: provenance laundering (§1f, 4a-4b parity) ──────────────────
  // RULE: any source row whose source_field_id is in
  // `originalAiSuggestedSourceIds` AND survives the edit retains its
  // 'AI-suggested:…' marker; everything else (new sources + originally-
  // manual sources) gets the manual marker. The TFM-level `ai_reasoning`
  // collapses to manual when ZERO original AI sources survive — even if
  // the edit happened to keep some manual sources.
  const newSourceIdsSet = new Set(sourceFieldIds)
  const retainedAiSourceIds = new Set(
    [...originalAiSuggestedSourceIds].filter((id) => newSourceIdsSet.has(id)),
  )
  const stillHasOriginalAi = retainedAiSourceIds.size > 0
  const newTfmAiReasoning = stillHasOriginalAi
    ? tfm.ai_reasoning ?? 'AI-suggested via per-row Suggest'
    : 'Mapping edited via redesign UI'

  // ── Step 11: source set-diff (drives transform reset + log copy) ─────────
  let sourcesChanged = false
  if (newSourceIdsSet.size !== existingSourceFieldIds.size) {
    sourcesChanged = true
  } else {
    for (const id of newSourceIdsSet) {
      if (!existingSourceFieldIds.has(id)) {
        sourcesChanged = true
        break
      }
    }
  }
  // Ordinal change (re-ordering sources without adding/removing) ALSO counts
  // as a source change because the dominant source defines the join anchor.
  if (!sourcesChanged && existingSources.length === sourceFieldIds.length) {
    for (let i = 0; i < sourceFieldIds.length; i++) {
      if (existingSources[i].source_field_id !== sourceFieldIds[i]) {
        sourcesChanged = true
        break
      }
    }
  }

  // ── Step 12: replace mapping sources via RPC ────────────────────────────
  const rpcSources = orderedSources.map((sf, idx) => {
    const isRetainedAi = retainedAiSourceIds.has(sf.id)
    return {
      source_field_id: sf.id,
      source_table_id: sf.table_id,
      // Edit-time we don't have a fresh confidence signal — preserve the
      // existing per-source confidence by reusing 100 for new manual rows
      // and re-using the stored value when the source is retained. The
      // RPC's INSERT writes whatever we send; we don't pass through prior
      // per-source confidence today (would require a per-id lookup) — a
      // future polish, low priority because confidence isn't gating any
      // behavior.
      confidence: 100,
      ai_reasoning: isRetainedAi
        ? existingSources.find((s) => s.source_field_id === sf.id)
            ?.ai_reasoning ?? 'AI-suggested: (preserved across edit)'
        : 'Manually selected by user',
      type_compatibility: null as string | null,
      similar_fields_considered: [] as string[],
      // Cycle 1 — `join_spec` is always null on the write path. The read
      // path re-derives the via-FK annotation per render.
      join_spec: null as unknown,
      ordinal: idx,
    }
  })

  const { error: rpcErr } = await supabase.rpc('dq_replace_mapping_sources', {
    p_tfm_id: tfm.id,
    p_sources: rpcSources,
  })
  if (rpcErr) {
    return {
      success: false,
      error: rpcErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 13: TFM-level UPDATE (status revert + combination + AI) ────────
  const { error: tfmUpdErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      status: 'needs_review',
      combination_type: combinationType,
      ai_reasoning: newTfmAiReasoning,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfm.id)
  if (tfmUpdErr) {
    return {
      success: false,
      error: tfmUpdErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 14: transform reset (only when sources changed) ─────────────────
  let transformReset = false
  let stagedRowsReverted = 0
  if (sourcesChanged) {
    const { resetFieldTransform } = await import('@/lib/actions/transformations')
    const reset = await resetFieldTransform(tfm.id)
    if (reset.success) {
      transformReset = reset.hadTransform
      stagedRowsReverted = reset.rowsReverted
    } else {
      // Soft-fail: surface as INTERNAL but the source replacement already
      // committed; the user gets a "transform may be stale" follow-up. We
      // do NOT roll back the source change because the transform reset is
      // best-effort cleanup and a stale transform will just be `applied=false`
      // until the user re-authors.
      console.warn(
        '[editMappingSources] resetFieldTransform failed:',
        reset.error,
      )
    }
  }

  // ── Step 15: coverage recompute (Block 4 fan-out) ────────────────────────
  // Cycle 1 — fan out across every source table touched by the edit:
  //   • New source-table set → find-or-create + recompute (so a new
  //     anchor or new contributor table lands a TM row immediately and
  //     its counter rollup picks up the edited TFM).
  //   • Previous source-table set minus the new set → recompute only
  //     (the TM may now be incomplete because this TFM left its
  //     contributor list; we never delete a TM here, even when its
  //     coverage drops to zero — TM lifecycle deletion is out of scope
  //     for Cycle 1).
  const newSourceTableIds = new Set(orderedSources.map((s) => s.table_id))
  const previousSourceTableIds = new Set(
    existingSources
      .map((s) => s.source_table_id)
      .filter((id): id is string => typeof id === 'string'),
  )
  for (const sourceTableIdInLoop of newSourceTableIds) {
    const tmLoopResult = await findOrCreateTableMapping(
      projectId,
      sourceTableIdInLoop,
      targetField.table_id,
    )
    if (tmLoopResult.success) {
      await recomputeTableMappingStatus(supabase, tmLoopResult.id)
    } else {
      console.warn(
        '[editMappingSources] findOrCreateTableMapping failed for',
        { sourceTableId: sourceTableIdInLoop, error: tmLoopResult.error },
      )
    }
  }
  for (const sourceTableIdInLoop of previousSourceTableIds) {
    if (newSourceTableIds.has(sourceTableIdInLoop)) continue
    const { data: existingTm } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .eq('source_table_id', sourceTableIdInLoop)
      .eq('target_table_id', targetField.table_id)
      .maybeSingle()
    if (existingTm?.id) {
      await recomputeTableMappingStatus(supabase, existingTm.id as string)
    }
  }

  // ── Step 16: revalidate ──────────────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath(`/app/projects/${projectId}/transform`)
  // PR-4: dashboard tile aggregates target_field_mappings; refresh it too.
  revalidatePath('/app/projects')

  // ── Step 17: activity logs ───────────────────────────────────────────────
  const srcNames = orderedSources.map((s) => s.name)
  const inlineSrcList =
    srcNames.length <= 3
      ? srcNames.join(', ')
      : `${srcNames.slice(0, 2).join(', ')}, +${srcNames.length - 2} more`
  const editDescription = `Mapping edited: ${inlineSrcList} \u2192 ${targetField.name}`

  const isCrossTable = new Set(orderedSources.map((s) => s.table_id)).size > 1
  await logActivity(projectId, 'mapping_sources_changed', editDescription, 'mapping', {
    target_field_mapping_id: tfm.id,
    target_field: targetField.name,
    target_field_id: tfm.target_field_id,
    source_fields: srcNames,
    source_field_ids: sourceFieldIds,
    combination_type: combinationType,
    sources_changed: sourcesChanged,
    cross_table: isCrossTable,
    transform_reset: transformReset,
  })

  if (transformReset) {
    await logActivity(
      projectId,
      'transformation_reset',
      `Transformation reset on edit: ${targetField.name}`,
      'transform',
      {
        reason: 'mapping_edited',
        target_field_mapping_id: tfm.id,
        target_field: targetField.name,
        rows_reverted: stagedRowsReverted,
      },
    )
  }

  return {
    success: true,
    tfmId: tfm.id,
    transformReset,
    stagedRowsReverted,
    sourcesChanged,
  }
}

/**
 * Update only the combination_type on an existing TFM. Cheaper than
 * `editMappingSources` because:
 *   • Sources are unchanged → no `dq_replace_mapping_sources` call.
 *   • Transform is NOT reset (per founder decision §1.3) — the SQL is
 *     still valid, only the combination semantics changed.
 *   • Provenance laundering does NOT apply (no source touched).
 *
 * Status reverts to `needs_review` so the user re-approves explicitly.
 */
export async function updateMappingCombination(
  tfmId: string,
  combinationType: CreateFieldMappingCombinationType | 'custom_sql',
): Promise<UpdateCombinationResult> {
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType === 'custom_sql') {
    return {
      success: false,
      error:
        'Custom SQL combinations are authored on the Transform tab, not here',
      errorCode: 'VALIDATION',
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      'id, project_id, target_field_id, status, is_acknowledged, combination_type',
    )
    .eq('id', tfmId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      combination_type: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  if (tfm.status === 'rejected') {
    return {
      success: false,
      error:
        "This mapping has been rejected. Reject and re-create instead of editing.",
      errorCode: 'TFM_REJECTED',
    }
  }
  if (tfm.is_acknowledged) {
    return {
      success: false,
      error:
        "This field is acknowledged. Un-acknowledge it first to map it.",
      errorCode: 'TFM_ACKNOWLEDGED',
    }
  }

  try {
    await assertMappingWritesEnabled(tfm.project_id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    }
  }

  // Single↔concat sanity vs. existing source count.
  const { count: existingSourceCount } = await supabaseAdmin
    .from('mapping_sources')
    .select('id', { count: 'exact', head: true })
    .eq('target_field_mapping_id', tfm.id)
  const sourceCount = existingSourceCount ?? 0
  if (combinationType === 'single' && sourceCount !== 1) {
    return {
      success: false,
      error:
        "combination_type 'single' requires exactly one source field on the mapping",
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType !== 'single' && sourceCount < 2) {
    return {
      success: false,
      error: `combination_type '${combinationType}' requires at least two source fields on the mapping`,
      errorCode: 'VALIDATION',
    }
  }

  // No-op short-circuit: if the new value matches the existing one, still
  // bump status to needs_review (the user's intent was an edit) but skip
  // the activity log and revalidate to avoid log spam.
  if (tfm.combination_type === combinationType && tfm.status === 'needs_review') {
    return { success: true, tfmId: tfm.id }
  }

  const { error: updErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      status: 'needs_review',
      combination_type: combinationType,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfm.id)
  if (updErr) {
    return {
      success: false,
      error: updErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // Read target field name for the activity-log payload.
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('name')
    .eq('id', tfm.target_field_id)
    .single<{ name: string }>()

  revalidatePath(`/app/projects/${tfm.project_id}/mapping`)
  revalidatePath(`/app/projects/${tfm.project_id}/transform`)
  // PR-4: dashboard tile aggregates target_field_mappings; refresh it too.
  revalidatePath('/app/projects')

  await logActivity(
    tfm.project_id,
    'mapping_combination_changed',
    `Combination changed: ${targetField?.name ?? '?'} \u2192 ${combinationType}`,
    'mapping',
    {
      target_field_mapping_id: tfm.id,
      target_field: targetField?.name ?? null,
      target_field_id: tfm.target_field_id,
      previous_combination_type: tfm.combination_type,
      combination_type: combinationType,
    },
  )

  return { success: true, tfmId: tfm.id }
}

/**
 * Read-only pre-save query for the EditInvalidationDialog. Returns
 * (a) whether a transform exists for this TFM, and (b) the count of
 * staged_data_rows whose `transformed_row_data` JSONB carries the target
 * field name as a key. Capped at PREVIEW_INVALIDATION_COUNT_CAP so a
 * project with millions of staged rows doesn't punish the dialog with
 * an unbounded count.
 *
 * The drawer uses this to decide whether to show the warn dialog
 * BEFORE invoking `editMappingSources`. The dialog gates on
 * `hasTransform === true && stagedRowCount > 0`. On confirm the drawer
 * calls `editMappingSources` regardless — the preview only drives copy.
 */
export async function previewEditInvalidation(
  tfmId: string,
): Promise<PreviewEditInvalidationResult> {
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'NOT_FOUND',
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, project_id, target_field_id')
    .eq('id', tfmId)
    .maybeSingle<{ id: string; project_id: string; target_field_id: string }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // Transform existence check.
  const { data: txn } = await supabaseAdmin
    .from('transformations')
    .select('id, status')
    .eq('target_field_mapping_id', tfm.id)
    .maybeSingle<{ id: string; status: string }>()
  const hasTransform = txn !== null

  // Read the target field name + table id for the staged-row scan.
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('id', tfm.target_field_id)
    .single<{ id: string; name: string; table_id: string }>()
  if (!targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Find every TM for (project, target_table) so we can scope the count
  // to staged rows that belong to this field. Multi-source-table projects
  // can have several TMs whose target_table is this field's parent.
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', tfm.project_id)
    .eq('target_table_id', targetField.table_id)
    .neq('status', 'rejected')
  const tmIds: string[] = (tms ?? []).map((t) => t.id as string)
  if (tmIds.length === 0) {
    return { success: true, hasTransform, stagedRowCount: 0, capped: false }
  }

  // Count staged_data_rows whose transformed_row_data JSONB contains the
  // target field name as a key. PostgREST translates `?` (jsonb key
  // existence) via the `cs` (contains) helper; we use raw filter syntax
  // to express it.
  // Cap at PREVIEW_INVALIDATION_COUNT_CAP so a project with millions of
  // staged rows doesn't run a full count.
  const { count, error: countErr } = await supabaseAdmin
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .in('table_mapping_id', tmIds)
    .filter('transformed_row_data', 'cs', JSON.stringify({ [targetField.name]: null }))
    .limit(PREVIEW_INVALIDATION_COUNT_CAP)
  if (countErr) {
    // Soft-fail: count is best-effort signal for the dialog. If the
    // jsonb-contains filter fails (some PostgREST versions are picky),
    // surface qualitative copy via `capped: true` so the dialog still
    // renders the "staged data will be invalidated" warning without a
    // bogus number.
    return {
      success: true,
      hasTransform,
      stagedRowCount: 0,
      capped: hasTransform,
    }
  }
  const stagedRowCount = count ?? 0
  const capped = stagedRowCount >= PREVIEW_INVALIDATION_COUNT_CAP
  return {
    success: true,
    hasTransform,
    stagedRowCount,
    capped,
  }
}

// ─── Write path — Phase 4b-2 (un-acknowledge field) ─────────────────────────
//
// `unacknowledgeField` is the W4 server-side surface — the mirror image of
// `acknowledgeField`. It deletes the bare-acknowledged TFM row (no sources,
// `is_acknowledged=true`) and lets the field return to Rule 6 (unmapped) so
// the user can map it through the W1 form.
//
// Founder decisions §3.j + §3.k (Phase 4b investigation):
//   • UI affordance: footer Un-acknowledge button on `target_acknowledged`
//     rows (NOT inline — matches the verb-action affordance pattern of
//     Approve / Reject / Edit).
//   • Status semantics: delete the TFM row, no new status enum value. The
//     field re-renders as Rule 6 unmapped on the next read. Activity log
//     captures the un-ack via the existing `acknowledgment_removed` action
//     type (no new action type needed; widened in 4a-* per
//     `lib/actions/activity-log.ts:31`).
//
// The wrapper delegates the actual delete to
// `removeAcknowledgment(projectId, fieldId)` from
// `lib/actions/field-acknowledgments.ts` which already does the
// editor-permission check, maintenance gate, and recompute of affected
// table_mapping statuses. We layer wrapper-level guards on top so we can
// distinguish PERMISSION_DENIED / MAINTENANCE_MODE / NOT_FOUND / VALIDATION
// at the discriminated-union level without throw/catch in the drawer.
//
// IMPORTANT — `removeAcknowledgment` performs the same auth + maintenance
// checks internally and throws on failure. We pre-validate so the typical
// happy path returns a clean discriminated-union without exception flow,
// AND so a NOT_FOUND case (stale drawer click after another user
// un-acknowledged) surfaces deterministically. Any unexpected throw from
// `removeAcknowledgment` is caught and translated to INTERNAL.

export type UnacknowledgeFieldErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'

export type UnacknowledgeFieldResult =
  | { success: true; tfmId: string }
  | {
      success: false
      error: string
      errorCode: UnacknowledgeFieldErrorCode
    }

/**
 * Un-acknowledge a target field. Deletes the bare-ack TFM and returns the
 * field to Rule 6 (unmapped). See file header for the full 4b-2 contract.
 *
 * SEQUENCE:
 *   1.  Cheap input validation (projectId + targetFieldId required).
 *   2.  Auth (Supabase user) → PERMISSION_DENIED.
 *   3.  Project-permission gate (`requireProjectPermission(..., 'editor')`)
 *       → PERMISSION_DENIED.
 *   4.  Maintenance-mode gate → MAINTENANCE_MODE.
 *   5.  Identity read — find the TFM via `(project_id, target_field_id)`
 *       (uniqueness constraint guarantees ≤1 row). NOT_FOUND when absent.
 *   6.  State guard — refuse to mutate a non-acknowledged TFM (the user
 *       should reach `editMappingSources` for those). Returns VALIDATION
 *       with copy directing the caller to the right surface.
 *   7.  Delegate to `removeAcknowledgment(projectId, targetFieldId)` which
 *       (a) deletes the row, (b) recomputes affected table_mappings.
 *   8.  Activity log: `acknowledgment_removed` with metadata
 *       { tfm_id, target_field_id, target_field, previous_acknowledgment_reason }.
 *   9.  Revalidate /mapping path.
 */
export async function unacknowledgeField(input: {
  projectId: string
  targetFieldId: string
}): Promise<UnacknowledgeFieldResult> {
  const { projectId, targetFieldId } = input

  // ── Step 1: validation ───────────────────────────────────────────────────
  if (!projectId) {
    return {
      success: false,
      error: 'projectId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!targetFieldId) {
    return {
      success: false,
      error: 'targetFieldId is required',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: permission ───────────────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: maintenance gate ─────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 5: identity read — find TFM by (project_id, target_field_id) ───
  // We do NOT filter by is_acknowledged here so we can distinguish
  // NOT_FOUND (no TFM at all — likely a stale drawer click) from
  // VALIDATION (TFM exists but is_acknowledged=false — wrong surface).
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, is_acknowledged, acknowledgment_reason')
    .eq('project_id', projectId)
    .eq('target_field_id', targetFieldId)
    .maybeSingle<{
      id: string
      is_acknowledged: boolean
      acknowledgment_reason: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Acknowledgment not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Step 6: state guard ──────────────────────────────────────────────────
  if (!tfm.is_acknowledged) {
    return {
      success: false,
      error:
        "This field has a mapping, not an acknowledgment. Use Edit or Reject from the drawer to change it.",
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 7: delegate to removeAcknowledgment ─────────────────────────────
  try {
    await removeAcknowledgment(projectId, targetFieldId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 8: activity log ─────────────────────────────────────────────────
  // Best-effort target-field name lookup for the description; the row is
  // already deleted but the field itself is still present.
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('name')
    .eq('id', targetFieldId)
    .maybeSingle<{ name: string }>()

  // ── Step 9: revalidate /mapping ──────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  // PR-4: dashboard tile target.approved drops on ack removal.
  revalidatePath('/app/projects')

  await logActivity(
    projectId,
    'acknowledgment_removed',
    `Acknowledgment removed: ${targetField?.name ?? '?'}`,
    'mapping',
    {
      tfm_id: tfm.id,
      target_field_id: targetFieldId,
      target_field: targetField?.name ?? null,
      previous_acknowledgment_reason: tfm.acknowledgment_reason,
    },
  )

  return { success: true, tfmId: tfm.id }
}

// ─── Write path — INF-57 (reset row status to needs_review) ─────────────────
//
// `resetMappingStatus` is the drawer's "Reset to needs_review" affordance.
// Available on any row that carries a user-set status (the inline approve/
// reject path's symmetrical undo). Three surface dispatch by row id format:
//
//   1. `unmapped::<targetFieldId>` (canonical no-source row) — coverage row
//      either exists with status_set_by='user' or is absent. Branch:
//      UPDATE coverage SET status='needs_review', status_set_by='ai_auto'
//      if a row exists; else NO-OP (target_only orphan already renders as
//      needs_review+system_default).
//
//   2. Raw TFM UUID, lookup is_acknowledged=false (mapped or VA) — UPDATE
//      target_field_mappings SET status='needs_review'. Per INF-53 lock
//      semantics (path-d-persistence.ts:fetchTfmUserLocks), needs_review
//      is NOT in the user-lock set so the next Path D run will refresh AI
//      metadata cleanly.
//
//   3. Raw TFM UUID, lookup is_acknowledged=true (legacy bare-ack) —
//      DOUBLE WRITE: (a) DELETE the bare-ack TFM (kills legacy path), (b)
//      UPDATE coverage SET status='needs_review', status_set_by='ai_auto'
//      (kills canonical path post-098 backfill). Without (b), the row
//      stays approved via dual-recognition.
//
// Single activity_log entry per call: 'mapping_status_reset' with
// metadata.previous_status + metadata.previous_set_by + metadata.surface.

export type ResetMappingStatusErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'

export type ResetMappingStatusResult =
  | {
      success: true
      surface: 'coverage_only' | 'tfm_mapped_or_va' | 'legacy_bare_ack'
    }
  | {
      success: false
      error: string
      errorCode: ResetMappingStatusErrorCode
    }

export async function resetMappingStatus(input: {
  rowId: string
}): Promise<ResetMappingStatusResult> {
  const { rowId } = input
  if (!rowId) {
    return {
      success: false,
      error: 'rowId is required',
      errorCode: 'VALIDATION',
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Branch 1: canonical no-source row (synthetic id) ───────────────────────
  if (rowId.startsWith(UNMAPPED_ID_PREFIX)) {
    const targetFieldId = rowId.slice(UNMAPPED_ID_PREFIX.length)
    if (!UUID_REGEX.test(targetFieldId)) {
      return {
        success: false,
        error: 'Invalid row id',
        errorCode: 'VALIDATION',
      }
    }
    const ownership = await resolveFieldOwnership(targetFieldId)
    if (!ownership) {
      return {
        success: false,
        error: 'Target field not found',
        errorCode: 'NOT_FOUND',
      }
    }
    const gate = await gateNoSourceWrite(ownership.projectId)
    if (!gate.ok) {
      // gateNoSourceWrite returns MappingActionResult; widen errorCode to
      // ResetMappingStatusErrorCode (the two unions overlap on every value
      // gateNoSourceWrite can produce: PERMISSION_DENIED, MAINTENANCE_MODE,
      // INTERNAL).
      return {
        success: false,
        error: gate.result.error ?? 'Failed to authorize reset',
        errorCode: (gate.result.errorCode ?? 'INTERNAL') as ResetMappingStatusErrorCode,
      }
    }

    // Read the existing coverage row's status + provenance for activity-log
    // metadata. A missing row means the orphan target-only case — the row
    // already renders needs_review+system_default, so reset is a no-op
    // (return success without writing anything).
    const { data: existing } = await supabaseAdmin
      .from('target_field_coverage')
      .select('status, status_set_by')
      .eq('project_id', ownership.projectId)
      .eq('target_field_id', targetFieldId)
      .maybeSingle<{
        status: 'needs_review' | 'approved' | 'rejected'
        status_set_by: 'ai_auto' | 'user' | 'system_default'
      }>()

    if (existing) {
      const { error: updErr } = await supabaseAdmin
        .from('target_field_coverage')
        .update({
          status: 'needs_review',
          status_set_by: 'ai_auto',
          updated_at: new Date().toISOString(),
        })
        .eq('project_id', ownership.projectId)
        .eq('target_field_id', targetFieldId)
      if (updErr) {
        return {
          success: false,
          error: updErr.message,
          errorCode: 'INTERNAL',
        }
      }
    }

    await logActivity(
      ownership.projectId,
      'mapping_status_reset',
      `Status reset to needs_review: ${ownership.fieldName ?? '?'}`,
      'mapping',
      {
        target_field_id: targetFieldId,
        target_field: ownership.fieldName,
        surface: 'coverage_only',
        previous_status: existing?.status ?? null,
        previous_set_by: existing?.status_set_by ?? null,
      },
    )
    revalidatePath(`/app/projects/${ownership.projectId}/mapping`)
    return { success: true, surface: 'coverage_only' }
  }

  // ── Branches 2 + 3: TFM-backed row ─────────────────────────────────────────
  if (!UUID_REGEX.test(rowId)) {
    return {
      success: false,
      error: 'Invalid row id',
      errorCode: 'VALIDATION',
    }
  }
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, project_id, target_field_id, status, is_acknowledged')
    .eq('id', rowId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }
  try {
    await assertMappingWritesEnabled(tfm.project_id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('name')
    .eq('id', tfm.target_field_id)
    .maybeSingle<{ name: string }>()

  if (tfm.is_acknowledged) {
    // ── Branch 3: legacy bare-ack — DOUBLE WRITE ────────────────────────────
    // Read coverage state before delete so the activity log captures the
    // pre-reset surface state.
    const { data: coverage } = await supabaseAdmin
      .from('target_field_coverage')
      .select('status, status_set_by')
      .eq('project_id', tfm.project_id)
      .eq('target_field_id', tfm.target_field_id)
      .maybeSingle<{
        status: 'needs_review' | 'approved' | 'rejected'
        status_set_by: 'ai_auto' | 'user' | 'system_default'
      }>()

    const { error: delErr } = await supabaseAdmin
      .from('target_field_mappings')
      .delete()
      .eq('id', tfm.id)
    if (delErr) {
      return {
        success: false,
        error: delErr.message,
        errorCode: 'INTERNAL',
      }
    }

    if (coverage) {
      const { error: covErr } = await supabaseAdmin
        .from('target_field_coverage')
        .update({
          status: 'needs_review',
          status_set_by: 'ai_auto',
          updated_at: new Date().toISOString(),
        })
        .eq('project_id', tfm.project_id)
        .eq('target_field_id', tfm.target_field_id)
      if (covErr) {
        return {
          success: false,
          error: covErr.message,
          errorCode: 'INTERNAL',
        }
      }
    }

    await logActivity(
      tfm.project_id,
      'mapping_status_reset',
      `Status reset to needs_review: ${targetField?.name ?? '?'}`,
      'mapping',
      {
        target_field_id: tfm.target_field_id,
        target_field: targetField?.name ?? null,
        surface: 'legacy_bare_ack',
        deleted_tfm_id: tfm.id,
        previous_status: coverage?.status ?? 'approved',
        previous_set_by: coverage?.status_set_by ?? 'user',
      },
    )
    revalidatePath(`/app/projects/${tfm.project_id}/mapping`)
    return { success: true, surface: 'legacy_bare_ack' }
  }

  // ── Branch 2: mapped or VA TFM ─────────────────────────────────────────────
  const previousStatus = tfm.status
  const { error: updErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({ status: 'needs_review' })
    .eq('id', tfm.id)
  if (updErr) {
    return {
      success: false,
      error: updErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // Phase 0c provenance — status flip on a TFM is an AI-vs-human edit.
  // editKind='human_modified' (parallels updateFieldMappingStatus's mapping
  // for status='needs_review' in lib/actions/mappings.ts:1056-1061).
  void logAIEdit({
    projectId: tfm.project_id,
    actorId: user.id,
    entityType: 'target_field_mapping',
    entityId: tfm.id,
    fieldPath: 'status',
    oldValue: previousStatus,
    newValue: 'needs_review',
    editKind: 'human_modified',
  })

  await logActivity(
    tfm.project_id,
    'mapping_status_reset',
    `Status reset to needs_review: ${targetField?.name ?? '?'}`,
    'mapping',
    {
      target_field_id: tfm.target_field_id,
      target_field: targetField?.name ?? null,
      surface: 'tfm_mapped_or_va',
      tfm_id: tfm.id,
      previous_status: tfm.status,
      previous_set_by: 'user',
    },
  )
  revalidatePath(`/app/projects/${tfm.project_id}/mapping`)
  return { success: true, surface: 'tfm_mapped_or_va' }
}

// ─── Write path — Phase 4c-1 (bulk approve + high-confidence) ───────────────
//
// Two bulk approve wrappers + one read-only preview helper. Locked decisions
// (founder, 2026-04-26):
//
//   §1   IN-scope for 4c-1: per-target-table approve, project-wide
//        approve-high-confidence. (Per-target-table reject ships in 4c-2.)
//   §2.1 Do NOT reuse legacy `rejectAllFieldMappings` (status='rejected'
//        contract clash with redesign's reject=DELETE). Approve side is
//        also a fresh wrapper, NOT a per-row loop, NOT a wrap of legacy
//        `approveAllFieldMappings` (which auto-acks unmapped fields).
//   §2.2 Strict scope on approve — NO auto-acknowledge side-effect.
//   §4.1 Approach C — TS orchestration + single bulk SQL UPDATE. No new
//        RPC migration. Heritage scale: <500ms; Mitratech-class
//        (~1000 TFMs): ~1-2s on a single .update().in() call.
//   §4.2 Scope by target_table_id (not table_mapping_id like legacy).
//        Redesign UI groups by target table; TM is the source×target
//        pairing concept the redesign deliberately abstracts away.
//   §4.3 Server-side preview helper (`previewBulkApprove`) — eliminates
//        the TOCTOU class where the live UI filter state diverges from
//        the canonical scope at write time.
//   §6   Hard-coded scope: `status='needs_review' AND is_acknowledged=false`.
//        Bulk wrappers IGNORE the user's live filter state.
//   §7.1 Single bulk activity-log entry per click (NOT N per-row entries).
//        Uses pre-staged `mapping_bulk_approved` ActionType.
//   §7.2 Metadata includes the full `tfm_ids` array for granular audit
//        without log spam.
//   §9.1 Single bulk UPDATE. No background-task / progress-bar
//        complication for v1.
//
// Activity log shape (from §7 + closure-doc §5.2):
//   action_type: 'mapping_bulk_approved'
//   description: 'Bulk approve: 7 mappings on customers'      (per-table)
//                'Bulk approve: 27 high-confidence mappings (≥85%)'
//                                                             (project-wide)
//   metadata: {
//     scope: 'target_table_needs_review' | 'project_high_confidence',
//     count: number,
//     tfm_ids: string[],
//     fields_affected: string[],         (target-field names, for human read)
//     target_table_id?: string,          (per-table only)
//     target_table_name?: string,        (per-table only)
//     threshold?: number,                (high-confidence only, default 85)
//   }
//
// CONCURRENCY / IDEMPOTENCY (§2.3): the wrapper is idempotent under re-run.
// The hard-coded scope filter is `status='needs_review'`, so a re-fired
// click after a partial commit simply skips the already-approved rows. No
// transaction wrapping for v1.
//
// TM RECOMPUTE (§4.1): one pass at the end of the bulk write per affected
// target table. The legacy `approveHighConfidenceMappings` and
// `approveAllFieldMappings` use the same shape — we mirror it here.

export type BulkApproveErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'

export type BulkApproveResult =
  | {
      success: true
      /** Number of TFMs flipped from `needs_review` → `approved`. */
      rowsAffected: number
      /** Bulk-approved TFM uuids (matches `tfm_ids` in the activity log). */
      tfmIds: string[]
    }
  | {
      success: false
      error: string
      errorCode: BulkApproveErrorCode
    }

/**
 * Read-only preview of what `bulkApproveFieldMappingsForTargetTable` WOULD
 * approve at this moment. Used by `BulkConfirmDialog` to populate the
 * count + first-five-rows preview list. Callers should treat the result
 * as authoritative at dialog-open time; any divergence between this
 * snapshot and the eventual write is handled by the wrapper's idempotent
 * scope filter (§2.3).
 *
 * Returns `null` count + empty preview when the user lacks read
 * permission, so the dialog can render a graceful empty state.
 *
 * Scope (§6.1, §6.3 — hard-coded, NOT user-filter-state aware):
 *   - status === 'needs_review'
 *   - is_acknowledged === false
 *   - target_field's table === input.targetTableId
 *
 * Preview list cap: 5 rows (§3.2). Full count is always returned exactly.
 */
export async function previewBulkApprove(input: {
  projectId: string
  targetTableId: string
}): Promise<{
  count: number
  preview: Array<{
    tfmId: string
    targetField: string
    primarySource: string | null
  }>
}> {
  const { projectId, targetTableId } = input
  if (!projectId || !targetTableId) {
    return { count: 0, preview: [] }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { count: 0, preview: [] }
  }

  // Read-only perm: viewer is sufficient for preview. The actual write
  // wrapper enforces editor.
  const perm = await requireProjectPermission(projectId, 'viewer')
  if (!perm.allowed) {
    return { count: 0, preview: [] }
  }

  // Resolve target field ids in this table once.
  const { data: targetFieldsRows } = await supabaseAdmin
    .from('fields')
    .select('id, name')
    .eq('table_id', targetTableId)
  const targetFields = (targetFieldsRows ?? []) as Array<{
    id: string
    name: string
  }>
  if (targetFields.length === 0) {
    return { count: 0, preview: [] }
  }
  const targetFieldIds = targetFields.map((f) => f.id)
  const fieldNameById = new Map(targetFields.map((f) => [f.id, f.name] as const))

  // In-scope TFMs (status='needs_review' AND is_acknowledged=false).
  const { data: tfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, target_field_id')
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .eq('is_acknowledged', false)
    .in('target_field_id', targetFieldIds)
  const tfmRows = (tfms ?? []) as Array<{ id: string; target_field_id: string }>
  const count = tfmRows.length
  if (count === 0) {
    return { count: 0, preview: [] }
  }

  // Preview the first 5 (server order: PostgREST default, stable enough
  // for "and N more" UX). For each, look up the primary mapping_source
  // (ordinal=0) so the dialog can render "last_name ← LAST_NAME". Single
  // batched query keeps the N+1 lookup at one round-trip.
  const previewTfmIds = tfmRows.slice(0, 5).map((t) => t.id)
  const { data: primarySources } = await supabaseAdmin
    .from('mapping_sources')
    .select('target_field_mapping_id, ordinal, fields:source_field_id(name)')
    .in('target_field_mapping_id', previewTfmIds)
    .eq('ordinal', 0)
  const primaryByTfmId = new Map<string, string>()
  for (const ms of (primarySources ?? []) as unknown as Array<{
    target_field_mapping_id: string
    ordinal: number
    fields: { name: string } | { name: string }[] | null
  }>) {
    // Supabase typegen surfaces the FK relation as either a single object
    // or a one-element array depending on the join kind. Normalise here.
    const f = Array.isArray(ms.fields) ? ms.fields[0] : ms.fields
    if (f?.name) {
      primaryByTfmId.set(ms.target_field_mapping_id, f.name)
    }
  }

  const preview = previewTfmIds.map((tfmId) => {
    const tfm = tfmRows.find((t) => t.id === tfmId)
    return {
      tfmId,
      targetField: tfm ? (fieldNameById.get(tfm.target_field_id) ?? '?') : '?',
      primarySource: primaryByTfmId.get(tfmId) ?? null,
    }
  })

  return { count, preview }
}

/**
 * Bulk-approve every needs-review TFM whose target field belongs to the
 * given target table. See file header for the full 4c-1 contract.
 *
 * SEQUENCE:
 *   1.  Cheap input validation (projectId + targetTableId required).
 *   2.  Auth (Supabase user) → PERMISSION_DENIED.
 *   3.  Project-permission gate (`requireProjectPermission(..., 'editor')`)
 *       → PERMISSION_DENIED.
 *   4.  Maintenance-mode gate → MAINTENANCE_MODE.
 *   5.  Resolve target field universe (table → field ids).
 *   6.  Identity read — find every in-scope TFM (needs_review +
 *       not-acknowledged + target_field in this table). Empty set
 *       returns success with `rowsAffected: 0` (NOT a VALIDATION error;
 *       idempotent re-run path).
 *   7.  Bulk SQL UPDATE — single `.update().in(tfmIds)` call, atomic
 *       at the SQL statement level. Sets `status='approved'`.
 *   8.  TM recompute pass — every TM whose target_table_id matches
 *       this table gets a coverage refresh. Looped on the assumption
 *       that one target table belongs to a small number of TMs (<5
 *       on Heritage; <20 worst case at Mitratech scale).
 *   9.  Activity log: single `mapping_bulk_approved` entry with full
 *       metadata (scope='target_table_needs_review', count, tfm_ids,
 *       fields_affected, target_table_id, target_table_name).
 *   10. Revalidate /mapping path.
 */
export async function bulkApproveFieldMappingsForTargetTable(input: {
  projectId: string
  targetTableId: string
}): Promise<BulkApproveResult> {
  const { projectId, targetTableId } = input

  // ── Step 1: validation ───────────────────────────────────────────────────
  if (!projectId) {
    return {
      success: false,
      error: 'projectId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!targetTableId) {
    return {
      success: false,
      error: 'targetTableId is required',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: permission ───────────────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: maintenance gate ─────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 5: resolve target field universe ────────────────────────────────
  // We also need to verify the table itself belongs to the project — a
  // wrong projectId/targetTableId pairing should NOT silently approve
  // rows from a different project.
  const { data: targetTable } = await supabaseAdmin
    .from('tables')
    .select('id, name, dataset_id, datasets:dataset_id(project_id)')
    .eq('id', targetTableId)
    .maybeSingle<{
      id: string
      name: string
      dataset_id: string
      datasets: { project_id: string } | null
    }>()
  if (!targetTable || targetTable.datasets?.project_id !== projectId) {
    return {
      success: false,
      error: 'Target table not found in this project',
      errorCode: 'NOT_FOUND',
    }
  }

  const { data: targetFieldsRows } = await supabaseAdmin
    .from('fields')
    .select('id, name')
    .eq('table_id', targetTableId)
  const targetFields = (targetFieldsRows ?? []) as Array<{
    id: string
    name: string
  }>
  if (targetFields.length === 0) {
    // Empty target table — nothing to approve, but not an error per §2.3
    // idempotent semantics. The UI should also disable the kebab item
    // when count=0 (Block C), so this branch is mostly defense-in-depth.
    return { success: true, rowsAffected: 0, tfmIds: [] }
  }
  const targetFieldIds = targetFields.map((f) => f.id)
  const fieldNameById = new Map(targetFields.map((f) => [f.id, f.name] as const))

  // ── Step 6: identity read — in-scope TFMs ────────────────────────────────
  const { data: tfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, target_field_id')
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .eq('is_acknowledged', false)
    .in('target_field_id', targetFieldIds)
  const tfmRows = (tfms ?? []) as Array<{ id: string; target_field_id: string }>
  if (tfmRows.length === 0) {
    return { success: true, rowsAffected: 0, tfmIds: [] }
  }
  const tfmIds = tfmRows.map((t) => t.id)
  const fieldsAffected = tfmRows.map(
    (t) => fieldNameById.get(t.target_field_id) ?? '?',
  )

  // ── Step 7: bulk SQL UPDATE ──────────────────────────────────────────────
  const { error: updateError } = await supabaseAdmin
    .from('target_field_mappings')
    .update({ status: 'approved' })
    .in('id', tfmIds)
  if (updateError) {
    return {
      success: false,
      error: updateError.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 8: TM recompute pass ────────────────────────────────────────────
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .eq('target_table_id', targetTableId)
  for (const tm of (tms ?? []) as Array<{ id: string }>) {
    await recomputeTableMappingStatus(supabase, tm.id)
  }

  // ── Step 9: activity log ─────────────────────────────────────────────────
  await logActivity(
    projectId,
    'mapping_bulk_approved',
    `Bulk approve: ${tfmRows.length} mapping${
      tfmRows.length === 1 ? '' : 's'
    } on ${targetTable.name}`,
    'mapping',
    {
      scope: 'target_table_needs_review',
      count: tfmRows.length,
      tfm_ids: tfmIds,
      fields_affected: fieldsAffected,
      target_table_id: targetTableId,
      target_table_name: targetTable.name,
    },
  )

  // ── Step 10: revalidate /mapping ─────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  // PR-4: bulk-approve shifts target.approved on the dashboard tile.
  revalidatePath('/app/projects')

  return {
    success: true,
    rowsAffected: tfmRows.length,
    tfmIds,
  }
}

/**
 * Project-wide approve for every needs-review TFM whose confidence
 * meets the threshold. Redesign-shape wrapper around the same SQL
 * idiom as legacy `approveHighConfidenceMappings`, but with:
 *
 *   - Discriminated-union result (BulkApproveResult, NOT
 *     `{ success, count, error }` legacy shape).
 *   - Single bulk activity-log entry tagged
 *     `scope='project_high_confidence'`.
 *   - Threshold default 85 (matches legacy default per §6).
 *
 * Scope (§6.1):
 *   - status === 'needs_review'
 *   - is_acknowledged === false
 *   - confidence >= threshold
 */
export async function approveHighConfidenceMappings(input: {
  projectId: string
  threshold?: number
}): Promise<BulkApproveResult> {
  const { projectId } = input
  const threshold = input.threshold ?? 85

  // ── Step 1: validation ───────────────────────────────────────────────────
  if (!projectId) {
    return {
      success: false,
      error: 'projectId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return {
      success: false,
      error: 'threshold must be a number in [0, 100]',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: permission ───────────────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: maintenance gate ─────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 5: bulk UPDATE with WHERE filters + RETURNING ───────────────────
  // Returning the affected ids + target_field_ids in one shot so we can
  // compute the activity-log payload and the TM recompute set without a
  // second round-trip.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('target_field_mappings')
    .update({ status: 'approved' })
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .eq('is_acknowledged', false)
    .gte('confidence', threshold)
    .select('id, target_field_id')
  if (updateError) {
    return {
      success: false,
      error: updateError.message,
      errorCode: 'INTERNAL',
    }
  }
  const updatedRows = (updated ?? []) as Array<{
    id: string
    target_field_id: string
  }>
  const tfmIds = updatedRows.map((r) => r.id)
  if (tfmIds.length === 0) {
    return { success: true, rowsAffected: 0, tfmIds: [] }
  }

  // ── Step 6: TM recompute pass ────────────────────────────────────────────
  // Affected target tables = the parent tables of the target_field_ids.
  // De-dupe via Set to bound TM lookups.
  const targetFieldIds = [
    ...new Set(updatedRows.map((r) => r.target_field_id)),
  ]
  const { data: tgtFields } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .in('id', targetFieldIds)
  const tgtFieldRows = (tgtFields ?? []) as Array<{
    id: string
    name: string
    table_id: string
  }>
  const targetTableIds = [...new Set(tgtFieldRows.map((f) => f.table_id))]
  const fieldNameById = new Map(tgtFieldRows.map((f) => [f.id, f.name] as const))
  const fieldsAffected = updatedRows.map(
    (r) => fieldNameById.get(r.target_field_id) ?? '?',
  )

  if (targetTableIds.length > 0) {
    const { data: tms } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .in('target_table_id', targetTableIds)
    for (const tm of (tms ?? []) as Array<{ id: string }>) {
      await recomputeTableMappingStatus(supabase, tm.id)
    }
  }

  // ── Step 7: activity log ─────────────────────────────────────────────────
  await logActivity(
    projectId,
    'mapping_bulk_approved',
    `Bulk approve: ${updatedRows.length} high-confidence mapping${
      updatedRows.length === 1 ? '' : 's'
    } (\u2265${threshold}%)`,
    'mapping',
    {
      scope: 'project_high_confidence',
      count: updatedRows.length,
      tfm_ids: tfmIds,
      fields_affected: fieldsAffected,
      threshold,
    },
  )

  // ── Step 8: revalidate /mapping ──────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  // PR-4: bulk mutation shifts dashboard tile target/source axes.
  revalidatePath('/app/projects')

  return {
    success: true,
    rowsAffected: updatedRows.length,
    tfmIds,
  }
}

// ─── Phase 4c-2 — bulk reject (W5 reject) ────────────────────────────────────
//
// Reject contract in the redesign UI: per-row reject DELETEs the TFM (founder
// amendment 2026-04-21; the legacy `status='rejected'` flag is NOT used by
// the new model). Bulk reject mirrors that contract — DELETE every needs-
// review TFM in the target table; the target field thereafter renders as
// Rule 6 unmapped. This is why we do NOT reuse the legacy
// `rejectAllFieldMappings` (Phase 4c investigation §2.1): the legacy action
// flips `status` to a value that the redesign read path no longer
// distinguishes from approved (`status` is informational; deletion is the
// only state the UI surfaces).
//
// PARTIAL-SUCCESS MODEL (§5.3 forward-progress, §3.4 toast + log surface):
//   The wrapper performs a per-TFM `resetFieldTransform` loop BEFORE the
//   bulk DELETE so any staged data is reverted with the right TFM context
//   in scope. Reset failures do NOT abort the wrapper — failed TFM ids are
//   collected into `failedTfmIds` and excluded from the rejectable set. The
//   bulk DELETE proceeds with the survivors, the activity log records both
//   sets, and the UI surfaces the partial count in the success toast. This
//   is a deliberate departure from the all-or-nothing approve path: reject
//   is destructive, so forward progress on the rows that CAN be deleted is
//   preferable to retrying the whole batch on the next click.
//
// SCOPE (§6.1, §6.3 — same hard-coded scope as approve):
//   - status === 'needs_review'
//   - is_acknowledged === false
//   - target_field's table === input.targetTableId
//
//   Acknowledged TFMs are bare-acks ("intentionally unmapped") and have no
//   reject semantics — the redesign exposes "Un-acknowledge" instead (Phase
//   4b-2). Approved TFMs are out of scope per §1.1; the user reaches them
//   via per-row reject if they want to delete a previously-approved row.
//
// ACTIVITY LOG (§7):
//   Single `mapping_bulk_rejected` entry per click with full metadata
//   (scope, count, tfm_ids, failed_tfm_ids?, fields_affected,
//   target_table_id, target_table_name, transforms_reset). Same shape as
//   `mapping_bulk_approved` plus the partial-success surface.

export type BulkRejectErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'

export type BulkRejectResult =
  | {
      success: true
      /** Number of TFMs DELETEd (rejectable set after transform-reset filter). */
      rowsAffected: number
      /** Count of TFMs whose transformation row was reset before deletion. */
      transformsReset: number
      /** Sum of staged_data_rows reverted across the per-TFM reset loop. */
      stagedRowsReverted: number
      /** Bulk-rejected TFM uuids (matches `tfm_ids` in the activity log). */
      tfmIds: string[]
      /**
       * TFM uuids whose `resetFieldTransform` step failed; these were
       * EXCLUDED from the bulk DELETE so they remain in `needs_review`
       * for a follow-up retry. Undefined / omitted on full success;
       * present and non-empty on partial success.
       */
      failedTfmIds?: string[]
    }
  | {
      success: false
      error: string
      errorCode: BulkRejectErrorCode
    }

/**
 * Read-only preview of what `bulkRejectFieldMappingsForTargetTable` WOULD
 * delete at this moment. Mirrors `previewBulkApprove` plus a `hasTransform`
 * flag per row so the dialog can render a transform-reset indicator.
 *
 * Permission gate: viewer-level (the actual write enforces editor).
 *
 * Scope is hard-coded — same as the write wrapper (§6.1, §6.3).
 *
 * Preview list cap: 5 rows (§3.2). Full count is always returned exactly.
 */
export async function previewBulkReject(input: {
  projectId: string
  targetTableId: string
}): Promise<{
  count: number
  preview: Array<{
    tfmId: string
    targetField: string
    primarySource: string | null
    hasTransform: boolean
  }>
}> {
  const { projectId, targetTableId } = input
  if (!projectId || !targetTableId) {
    return { count: 0, preview: [] }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { count: 0, preview: [] }
  }

  const perm = await requireProjectPermission(projectId, 'viewer')
  if (!perm.allowed) {
    return { count: 0, preview: [] }
  }

  const { data: targetFieldsRows } = await supabaseAdmin
    .from('fields')
    .select('id, name')
    .eq('table_id', targetTableId)
  const targetFields = (targetFieldsRows ?? []) as Array<{
    id: string
    name: string
  }>
  if (targetFields.length === 0) {
    return { count: 0, preview: [] }
  }
  const targetFieldIds = targetFields.map((f) => f.id)
  const fieldNameById = new Map(targetFields.map((f) => [f.id, f.name] as const))

  const { data: tfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, target_field_id')
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .eq('is_acknowledged', false)
    .in('target_field_id', targetFieldIds)
  const tfmRows = (tfms ?? []) as Array<{ id: string; target_field_id: string }>
  const count = tfmRows.length
  if (count === 0) {
    return { count: 0, preview: [] }
  }

  const previewTfmIds = tfmRows.slice(0, 5).map((t) => t.id)

  // Primary source lookup — single batched query (same shape as
  // previewBulkApprove).
  const { data: primarySources } = await supabaseAdmin
    .from('mapping_sources')
    .select('target_field_mapping_id, ordinal, fields:source_field_id(name)')
    .in('target_field_mapping_id', previewTfmIds)
    .eq('ordinal', 0)
  const primaryByTfmId = new Map<string, string>()
  for (const ms of (primarySources ?? []) as unknown as Array<{
    target_field_mapping_id: string
    ordinal: number
    fields: { name: string } | { name: string }[] | null
  }>) {
    const f = Array.isArray(ms.fields) ? ms.fields[0] : ms.fields
    if (f?.name) {
      primaryByTfmId.set(ms.target_field_mapping_id, f.name)
    }
  }

  // hasTransform indicator: which preview TFMs own a transformations row?
  // Single batched query (one round-trip for all 5). Caller renders a
  // small badge so users understand transform-reset will run for those
  // rows. We do NOT inspect transformation status (applied vs. draft)
  // here — that's a Transform-tab concern; the bulk wrapper resets either
  // way per `resetFieldTransform`'s contract.
  const { data: transforms } = await supabaseAdmin
    .from('transformations')
    .select('target_field_mapping_id')
    .in('target_field_mapping_id', previewTfmIds)
  const hasTransformByTfmId = new Set<string>()
  for (const t of (transforms ?? []) as Array<{
    target_field_mapping_id: string
  }>) {
    hasTransformByTfmId.add(t.target_field_mapping_id)
  }

  const preview = previewTfmIds.map((tfmId) => {
    const tfm = tfmRows.find((t) => t.id === tfmId)
    return {
      tfmId,
      targetField: tfm ? (fieldNameById.get(tfm.target_field_id) ?? '?') : '?',
      primarySource: primaryByTfmId.get(tfmId) ?? null,
      hasTransform: hasTransformByTfmId.has(tfmId),
    }
  })

  return { count, preview }
}

/**
 * Bulk-reject every needs-review TFM whose target field belongs to the
 * given target table. See file header for the full 4c-2 contract.
 *
 * SEQUENCE:
 *   1.  Cheap input validation (projectId + targetTableId required).
 *   2.  Auth (Supabase user) → PERMISSION_DENIED.
 *   3.  Project-permission gate (`requireProjectPermission(..., 'editor')`)
 *       → PERMISSION_DENIED.
 *   4.  Maintenance-mode gate → MAINTENANCE_MODE.
 *   5.  Resolve target field universe + ownership check (target table
 *       belongs to project) → NOT_FOUND on mismatch.
 *   6.  Identity read — find every in-scope TFM (needs_review + not-
 *       acknowledged + target_field in this table). Empty set returns
 *       VALIDATION ("nothing to reject"); the kebab item should be
 *       disabled in this case (defense-in-depth).
 *   7.  Per-TFM transform reset loop. Failures populate `failedTfmIds`
 *       and the failing TFM is EXCLUDED from the rejectable set —
 *       forward-progress (§5.3).
 *   8.  Single bulk DELETE on the rejectable set. CASCADE removes
 *       `mapping_sources` and `transformations` rows automatically
 *       (FK ON DELETE CASCADE). Empty rejectable set returns VALIDATION
 *       to surface the failure clearly to the UI.
 *   9.  TM recompute pass — same shape as approve.
 *   10. Activity log: single `mapping_bulk_rejected` entry with
 *       metadata { scope, count, tfm_ids, failed_tfm_ids?,
 *       fields_affected, target_table_id, target_table_name,
 *       transforms_reset }.
 *   11. Revalidate /mapping path.
 */
export async function bulkRejectFieldMappingsForTargetTable(input: {
  projectId: string
  targetTableId: string
}): Promise<BulkRejectResult> {
  const { projectId, targetTableId } = input

  // ── Step 1: validation ───────────────────────────────────────────────────
  if (!projectId) {
    return {
      success: false,
      error: 'projectId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!targetTableId) {
    return {
      success: false,
      error: 'targetTableId is required',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: permission ───────────────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: maintenance gate ─────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 5: resolve target field universe + ownership check ──────────────
  const { data: targetTable } = await supabaseAdmin
    .from('tables')
    .select('id, name, dataset_id, datasets:dataset_id(project_id)')
    .eq('id', targetTableId)
    .maybeSingle<{
      id: string
      name: string
      dataset_id: string
      datasets: { project_id: string } | null
    }>()
  if (!targetTable || targetTable.datasets?.project_id !== projectId) {
    return {
      success: false,
      error: 'Target table not found in this project',
      errorCode: 'NOT_FOUND',
    }
  }

  const { data: targetFieldsRows } = await supabaseAdmin
    .from('fields')
    .select('id, name')
    .eq('table_id', targetTableId)
  const targetFields = (targetFieldsRows ?? []) as Array<{
    id: string
    name: string
  }>
  if (targetFields.length === 0) {
    return {
      success: false,
      error: 'No needs-review mappings to reject on this table',
      errorCode: 'VALIDATION',
    }
  }
  const targetFieldIds = targetFields.map((f) => f.id)
  const fieldNameById = new Map(targetFields.map((f) => [f.id, f.name] as const))

  // ── Step 6: identity read — in-scope TFMs ────────────────────────────────
  const { data: tfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, target_field_id')
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .eq('is_acknowledged', false)
    .in('target_field_id', targetFieldIds)
  const tfmRows = (tfms ?? []) as Array<{ id: string; target_field_id: string }>
  if (tfmRows.length === 0) {
    return {
      success: false,
      error: 'No needs-review mappings to reject on this table',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 7: per-TFM transform reset loop ─────────────────────────────────
  // resetFieldTransform is no-op-safe when the TFM has no transformation
  // row (returns success with hadTransform=false). We still want to count
  // hadTransform / rowsReverted for the activity log + toast. Failures
  // are forward-progress: collect into failedTfmIds and exclude from
  // the rejectable set.
  const failedTfmIds: string[] = []
  const rejectable: Array<{ id: string; target_field_id: string }> = []
  let transformsReset = 0
  let stagedRowsReverted = 0
  for (const tfm of tfmRows) {
    const r = await resetFieldTransform(tfm.id)
    if (!r.success) {
      failedTfmIds.push(tfm.id)
      continue
    }
    if (r.hadTransform) transformsReset += 1
    stagedRowsReverted += r.rowsReverted
    rejectable.push(tfm)
  }
  if (rejectable.length === 0) {
    return {
      success: false,
      error: 'Transform reset failed for every in-scope mapping',
      errorCode: 'INTERNAL',
    }
  }
  const rejectableIds = rejectable.map((t) => t.id)
  const fieldsAffected = rejectable.map(
    (t) => fieldNameById.get(t.target_field_id) ?? '?',
  )

  // ── Step 8: bulk SQL DELETE ──────────────────────────────────────────────
  // CASCADE removes mapping_sources (FK ON DELETE CASCADE on
  // mapping_sources.target_field_mapping_id). Transformations are also
  // removed by the per-TFM reset loop above; any residual rows would
  // also CASCADE here.
  const { error: deleteError } = await supabaseAdmin
    .from('target_field_mappings')
    .delete()
    .in('id', rejectableIds)
  if (deleteError) {
    return {
      success: false,
      error: deleteError.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 9: TM recompute pass ────────────────────────────────────────────
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .eq('target_table_id', targetTableId)
  for (const tm of (tms ?? []) as Array<{ id: string }>) {
    await recomputeTableMappingStatus(supabase, tm.id)
  }

  // ── Step 10: activity log ────────────────────────────────────────────────
  await logActivity(
    projectId,
    'mapping_bulk_rejected',
    `Bulk reject: ${rejectable.length} mapping${
      rejectable.length === 1 ? '' : 's'
    } on ${targetTable.name}`,
    'mapping',
    {
      scope: 'target_table_needs_review',
      count: rejectable.length,
      tfm_ids: rejectableIds,
      ...(failedTfmIds.length > 0 ? { failed_tfm_ids: failedTfmIds } : {}),
      fields_affected: fieldsAffected,
      target_table_id: targetTableId,
      target_table_name: targetTable.name,
      transforms_reset: transformsReset,
    },
  )

  // ── Step 11: revalidate /mapping ─────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  // PR-4: bulk-reject shifts target.approved on the dashboard tile.
  revalidatePath('/app/projects')

  return {
    success: true,
    rowsAffected: rejectable.length,
    transformsReset,
    stagedRowsReverted,
    tfmIds: rejectableIds,
    ...(failedTfmIds.length > 0 ? { failedTfmIds } : {}),
  }
}

// ─── Flat (spreadsheet) view server actions ──────────────────────────────────
//
// The 4 actions below back the flat / spreadsheet Mapping view. Each
// flat-view row represents a single source→target attribution (a
// mapping_source paired with its parent TFM), or an unmapped row
// (target with no TFM, or source with no consumer). Inline cell edits
// drive these wrappers; the auto-approve cascade is intentional —
// editing a value in the spreadsheet is the user's affirmative
// statement "this attribution is correct".
//
// Founder decisions (2026-05-11, see
// notes/spreadsheet-view-server-investigation.md):
//
//   Q1  Confidence: set ONLY the edited source's confidence to 100; let
//       the MIN trigger keep TFM.confidence as the aggregate. We do NOT
//       force TFM.confidence to 100.
//   Q2  Status revert on contributor rejection: KEEP current behavior
//       (existing rejectFieldMapping/deleteFieldMapping path). Rejecting
//       a contributor does NOT revert the TFM to needs_review.
//   Q3  createMappingFromUnmapped + existing ack: DELETE the
//       source_field_acknowledgments row, proceed with create.
//   Q4  Activity log: mostly reuse existing action_types. Single new
//       action_type `source_field_rejected` for the flat-view source-side
//       reject. Other inline edits emit existing types
//       (mapping_sources_changed, mapping_approved, mapping_rejected)
//       with metadata.surface='flat_view' to disambiguate from drawer/
//       legacy emitters.
//   Q5  VA at new target during updateMappingTargetField: REFUSE with
//       TARGET_CONFLICT. The user must explicitly reject the existing VA
//       first.
//   Q6  B's UI investigation lives in worktree B; UI splits multi-source
//       TFMs into one row per source attribution and uses the
//       <tfmId>::<msId> shim id format.

const FLAT_VIEW_USER_CONFIDENCE = 100

// ─── 5.1 updateMappingSourceField ────────────────────────────────────────────

export type UpdateSourceFieldErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'DUPLICATE_SOURCE'
  | 'INTERNAL'

export type UpdateMappingSourceFieldResult =
  | {
      success: true
      tfmId: string
      mappingSourceId: string
      /** True when `resetFieldTransform` removed a transformation row. */
      transformReset: boolean
      stagedRowsReverted: number
    }
  | {
      success: false
      error: string
      errorCode: UpdateSourceFieldErrorCode
    }

/**
 * Update the source field on a single flat-view row. Triggered when the
 * user edits the Source Field cell.
 *
 * Behaviour:
 *   • Decodes `rowId` (`<tfmId>` for the primary attribution, or
 *     `<tfmId>::<mappingSourceId>` for a contributor attribution).
 *   • Validates the new source field exists in this project and isn't a
 *     duplicate of an existing source on the TFM.
 *   • Resets the field transformation (source change invalidates SQL).
 *   • UPDATEs the resolved `mapping_sources` row's source_field_id /
 *     source_table_id / confidence; the MIN-aggregate trigger then
 *     refreshes TFM.confidence.
 *   • Flips TFM.status → 'approved' (inline edit is an affirmative
 *     statement of correctness). Other attributions on the same TFM
 *     ride the TFM-wide status as before.
 *   • Fans out `recomputeTableMappingStatus` across every distinct
 *     source-table id in the post-edit source set (parallels
 *     `editMappingSources`).
 *   • Emits `mapping_sources_changed` + `mapping_approved` activity-log
 *     entries with `surface: 'flat_view'` metadata.
 */
export async function updateMappingSourceField(input: {
  rowId: string
  newSourceFieldId: string
  newConfidence?: number
}): Promise<UpdateMappingSourceFieldResult> {
  const { rowId, newSourceFieldId } = input
  const newConfidence =
    typeof input.newConfidence === 'number'
      ? input.newConfidence
      : FLAT_VIEW_USER_CONFIDENCE

  // ── Step 1: input validation ────────────────────────────────────────────
  if (!rowId) {
    return {
      success: false,
      error: 'rowId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!newSourceFieldId) {
    return {
      success: false,
      error: 'newSourceFieldId is required',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: decode shim id ──────────────────────────────────────────────
  const decoded = decodeShimmedRowId(rowId)
  if (decoded.kind !== 'tfm-primary' && decoded.kind !== 'tfm-contributor') {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Step 3: auth ────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: TFM identity read ───────────────────────────────────────────
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      'id, project_id, target_field_id, status, is_acknowledged, combination_type',
    )
    .eq('id', decoded.tfmId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      combination_type: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }
  const projectId = tfm.project_id

  // ── Step 5: project permission ──────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 6: defensive state guards ──────────────────────────────────────
  if (tfm.is_acknowledged) {
    return {
      success: false,
      error:
        'This field is acknowledged. Un-acknowledge it first to edit the source.',
      errorCode: 'VALIDATION',
    }
  }
  if (tfm.status === 'rejected') {
    return {
      success: false,
      error:
        'This mapping has been rejected. Reject and re-create instead of editing.',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 7: maintenance gate ────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 8: new source field identity + project ownership ──────────────
  const { data: newSource, error: nsErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', newSourceFieldId)
    .single<{
      id: string
      name: string
      table_id: string
      tables:
        | { datasets: { project_id: string } | { project_id: string }[] | null }
        | {
            datasets: { project_id: string } | { project_id: string }[] | null
          }[]
        | null
    }>()
  if (nsErr || !newSource) {
    return {
      success: false,
      error: 'Source field not found',
      errorCode: 'NOT_FOUND',
    }
  }
  const nsTables = Array.isArray(newSource.tables)
    ? newSource.tables[0]
    : newSource.tables
  const nsDatasets = Array.isArray(nsTables?.datasets)
    ? nsTables?.datasets[0]
    : nsTables?.datasets
  if (nsDatasets?.project_id !== projectId) {
    return {
      success: false,
      error: 'Source field does not belong to this project',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 9: resolve the mapping_source row to edit ──────────────────────
  let mappingSourceId: string
  let currentSourceFieldId: string | null = null
  if (decoded.kind === 'tfm-primary') {
    const { data: primary } = await supabaseAdmin
      .from('mapping_sources')
      .select('id, source_field_id')
      .eq('target_field_mapping_id', tfm.id)
      .eq('ordinal', 0)
      .maybeSingle<{ id: string; source_field_id: string | null }>()
    if (!primary) {
      return {
        success: false,
        error: 'Primary source row not found for this mapping',
        errorCode: 'NOT_FOUND',
      }
    }
    mappingSourceId = primary.id
    currentSourceFieldId = primary.source_field_id
  } else {
    const { data: contrib } = await supabaseAdmin
      .from('mapping_sources')
      .select('id, source_field_id')
      .eq('id', decoded.mappingSourceId)
      .eq('target_field_mapping_id', tfm.id)
      .maybeSingle<{ id: string; source_field_id: string | null }>()
    if (!contrib) {
      return {
        success: false,
        error: 'Source attribution not found on this mapping',
        errorCode: 'NOT_FOUND',
      }
    }
    mappingSourceId = contrib.id
    currentSourceFieldId = contrib.source_field_id
  }

  // No-op short circuit: source unchanged. Still flip status to approved
  // (the user's click is an affirmation) but skip writes that would
  // pointlessly fire the recompute trigger and transform reset.
  if (currentSourceFieldId === newSourceFieldId) {
    const { error: noopErr } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', tfm.id)
    if (noopErr) {
      return {
        success: false,
        error: noopErr.message,
        errorCode: 'INTERNAL',
      }
    }
    revalidatePath(`/app/projects/${projectId}/mapping`)
    revalidatePath('/app/projects')
    return {
      success: true,
      tfmId: tfm.id,
      mappingSourceId,
      transformReset: false,
      stagedRowsReverted: 0,
    }
  }

  // ── Step 10: duplicate check (defence in depth before UNIQUE fires) ────
  const { data: dup } = await supabaseAdmin
    .from('mapping_sources')
    .select('id')
    .eq('target_field_mapping_id', tfm.id)
    .eq('source_field_id', newSourceFieldId)
    .maybeSingle<{ id: string }>()
  if (dup && dup.id !== mappingSourceId) {
    return {
      success: false,
      error:
        'This source field is already on the mapping. Pick a different field.',
      errorCode: 'DUPLICATE_SOURCE',
    }
  }

  // ── Step 11: existing source-table set (for fan-out recompute) ─────────
  const { data: existingSources } = await supabaseAdmin
    .from('mapping_sources')
    .select('source_table_id')
    .eq('target_field_mapping_id', tfm.id)
    .returns<Array<{ source_table_id: string | null }>>()
  const previousSourceTableIds = new Set(
    (existingSources ?? [])
      .map((s) => s.source_table_id)
      .filter((id): id is string => typeof id === 'string'),
  )

  // ── Step 12: reset transform (source change invalidates SQL) ───────────
  const reset = await resetFieldTransform(tfm.id)
  const transformReset = reset.success ? reset.hadTransform : false
  const stagedRowsReverted = reset.success ? reset.rowsReverted : 0

  // ── Step 13: UPDATE the mapping_source row ─────────────────────────────
  const { error: msUpdErr } = await supabaseAdmin
    .from('mapping_sources')
    .update({
      source_field_id: newSourceFieldId,
      source_table_id: newSource.table_id,
      confidence: newConfidence,
      ai_reasoning: 'Manually selected by user (flat view)',
    })
    .eq('id', mappingSourceId)
  if (msUpdErr) {
    return {
      success: false,
      error: msUpdErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 14: flip TFM status to approved ───────────────────────────────
  const { error: tfmUpdErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfm.id)
  if (tfmUpdErr) {
    return {
      success: false,
      error: tfmUpdErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 15: target field table_id for TM recompute ────────────────────
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('id', tfm.target_field_id)
    .single<{ id: string; name: string; table_id: string }>()

  // ── Step 16: TM recompute fan-out across every distinct source table ───
  if (targetField) {
    const newSourceTableIds = new Set<string>([newSource.table_id])
    const { data: remainingSources } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_table_id')
      .eq('target_field_mapping_id', tfm.id)
      .returns<Array<{ source_table_id: string | null }>>()
    for (const ms of remainingSources ?? []) {
      if (ms.source_table_id) newSourceTableIds.add(ms.source_table_id)
    }

    for (const sourceTableIdInLoop of newSourceTableIds) {
      const tmLoop = await findOrCreateTableMapping(
        projectId,
        sourceTableIdInLoop,
        targetField.table_id,
      )
      if (tmLoop.success) {
        await recomputeTableMappingStatus(supabase, tmLoop.id)
      }
    }
    for (const sourceTableIdInLoop of previousSourceTableIds) {
      if (newSourceTableIds.has(sourceTableIdInLoop)) continue
      const { data: existingTm } = await supabaseAdmin
        .from('table_mappings')
        .select('id')
        .eq('project_id', projectId)
        .eq('source_table_id', sourceTableIdInLoop)
        .eq('target_table_id', targetField.table_id)
        .maybeSingle<{ id: string }>()
      if (existingTm?.id) {
        await recomputeTableMappingStatus(supabase, existingTm.id)
      }
    }
  }

  // ── Step 17: revalidate ────────────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath(`/app/projects/${projectId}/transform`)
  revalidatePath('/app/projects')

  // ── Step 18: activity logs ─────────────────────────────────────────────
  const tgtName = targetField?.name ?? null
  await logActivity(
    projectId,
    'mapping_sources_changed',
    `Mapping source edited: ${newSource.name} → ${tgtName ?? '?'}`,
    'mapping',
    {
      surface: 'flat_view',
      target_field_mapping_id: tfm.id,
      mapping_source_id: mappingSourceId,
      target_field: tgtName,
      target_field_id: tfm.target_field_id,
      new_source_field: newSource.name,
      new_source_field_id: newSourceFieldId,
      previous_source_field_id: currentSourceFieldId,
      transform_reset: transformReset,
    },
  )
  await logActivity(
    projectId,
    'mapping_approved',
    `Mapping approved: ${newSource.name} → ${tgtName ?? '?'}`,
    'mapping',
    {
      surface: 'flat_view',
      target_field_mapping_id: tfm.id,
      target_field: tgtName,
      source_field: newSource.name,
    },
  )

  if (transformReset) {
    await logActivity(
      projectId,
      'transformation_reset',
      `Transformation reset on edit: ${tgtName ?? '?'}`,
      'transform',
      {
        surface: 'flat_view',
        reason: 'flat_view_source_changed',
        target_field_mapping_id: tfm.id,
        target_field: tgtName,
        rows_reverted: stagedRowsReverted,
      },
    )
  }

  return {
    success: true,
    tfmId: tfm.id,
    mappingSourceId,
    transformReset,
    stagedRowsReverted,
  }
}

// ─── 5.2 updateMappingTargetField ────────────────────────────────────────────

export type UpdateTargetFieldErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'TARGET_CONFLICT'
  | 'INTERNAL'

export type UpdateMappingTargetFieldResult =
  | {
      success: true
      tfmId: string
      transformReset: boolean
      stagedRowsReverted: number
    }
  | {
      success: false
      error: string
      errorCode: UpdateTargetFieldErrorCode
    }

/**
 * Update the target field on a TFM. Triggered when the user edits the
 * Target Field cell on a flat-view row. This is a TFM-level operation —
 * the input is the bare TFM uuid, not a shim id.
 *
 * Per founder decision Q5 (2026-05-11): a VA at the new target is NOT
 * auto-deleted (legacy `editFieldMapping` behaviour). Returns
 * TARGET_CONFLICT; the user must explicitly reject the existing VA
 * first. Keeps flat-view semantics simple and avoids implicit data
 * loss.
 *
 * Per founder decision Q1: confidence is NOT touched here. The
 * underlying mapping_sources keep their AI-authored per-source
 * confidence and the MIN trigger preserves TFM.confidence.
 */
export async function updateMappingTargetField(input: {
  tfmId: string
  newTargetFieldId: string
}): Promise<UpdateMappingTargetFieldResult> {
  const { tfmId, newTargetFieldId } = input

  // ── Step 1: input validation ────────────────────────────────────────────
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!UUID_REGEX.test(tfmId)) {
    return {
      success: false,
      error: 'tfmId must be a valid uuid',
      errorCode: 'VALIDATION',
    }
  }
  if (!newTargetFieldId) {
    return {
      success: false,
      error: 'newTargetFieldId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!UUID_REGEX.test(newTargetFieldId)) {
    return {
      success: false,
      error: 'newTargetFieldId must be a valid uuid',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: TFM identity read ───────────────────────────────────────────
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      'id, project_id, target_field_id, status, is_acknowledged, combination_type',
    )
    .eq('id', tfmId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      combination_type: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }
  const projectId = tfm.project_id

  // ── Step 4: project permission ──────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 5: defensive state guards ──────────────────────────────────────
  if (tfm.is_acknowledged) {
    return {
      success: false,
      error:
        'This field is acknowledged. Un-acknowledge it first to edit the target.',
      errorCode: 'VALIDATION',
    }
  }
  if (tfm.status === 'rejected') {
    return {
      success: false,
      error:
        'This mapping has been rejected. Reject and re-create instead of editing.',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 6: maintenance gate ────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 7: identity read on the previous target field ─────────────────
  const { data: prevTarget } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('id', tfm.target_field_id)
    .maybeSingle<{ id: string; name: string; table_id: string }>()

  // ── Step 8: new target field identity + project ownership ──────────────
  const { data: newTarget, error: ntErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', newTargetFieldId)
    .single<{
      id: string
      name: string
      table_id: string
      tables:
        | { datasets: { project_id: string } | { project_id: string }[] | null }
        | {
            datasets: { project_id: string } | { project_id: string }[] | null
          }[]
        | null
    }>()
  if (ntErr || !newTarget) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }
  const ntTables = Array.isArray(newTarget.tables)
    ? newTarget.tables[0]
    : newTarget.tables
  const ntDatasets = Array.isArray(ntTables?.datasets)
    ? ntTables?.datasets[0]
    : ntTables?.datasets
  if (ntDatasets?.project_id !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'VALIDATION',
    }
  }

  // No-op short circuit: target unchanged. Flip status to approved and
  // exit (the user's click is an affirmation).
  if (tfm.target_field_id === newTargetFieldId) {
    const { error: noopErr } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', tfm.id)
    if (noopErr) {
      return {
        success: false,
        error: noopErr.message,
        errorCode: 'INTERNAL',
      }
    }
    revalidatePath(`/app/projects/${projectId}/mapping`)
    revalidatePath('/app/projects')
    return {
      success: true,
      tfmId: tfm.id,
      transformReset: false,
      stagedRowsReverted: 0,
    }
  }

  // ── Step 9: TARGET_CONFLICT check ──────────────────────────────────────
  // Mirrors editFieldMapping's logic. UNIQUE (project_id, target_field_id)
  // would surface as INTERNAL otherwise; pre-check returns a clean code.
  // Q5: refuse for ANY live TFM at the new target (mapped, VA, or bare-
  // ack). User must explicitly reject the existing row first.
  const { data: existing } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, status, is_acknowledged, combination_type')
    .eq('project_id', projectId)
    .eq('target_field_id', newTargetFieldId)
    .maybeSingle<{
      id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      combination_type: string | null
    }>()
  if (existing && existing.id !== tfm.id && existing.status !== 'rejected') {
    return {
      success: false,
      error:
        'Target field already has a mapping. Reject the existing mapping first.',
      errorCode: 'TARGET_CONFLICT',
    }
  }

  // ── Step 10: reset transform (target change invalidates SQL) ───────────
  const reset = await resetFieldTransform(tfm.id)
  const transformReset = reset.success ? reset.hadTransform : false
  const stagedRowsReverted = reset.success ? reset.rowsReverted : 0

  // ── Step 11: UPDATE the TFM (target_field_id + status='approved') ──────
  const { error: tfmUpdErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      target_field_id: newTargetFieldId,
      status: 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfm.id)
  if (tfmUpdErr) {
    return {
      success: false,
      error: tfmUpdErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 12: clear stale coverage status on the new target ─────────────
  // If the new target had a coverage row with status='rejected' or
  // status_set_by='user', a subsequent read would resurface it as
  // rejected (the read translator's resolution priority falls back to
  // coverage when no TFM... but the TFM now exists, so this is mostly
  // defence in depth). Reset to needs_review + ai_auto so the row
  // surfaces under TFM control.
  const coverageReset = await setCoverageStatus(
    projectId,
    newTargetFieldId,
    'needs_review',
  )
  if (!coverageReset.success) {
    console.warn(
      '[updateMappingTargetField] coverage reset on new target failed (TFM update committed):',
      coverageReset.error,
    )
  }

  // ── Step 13: TM recompute fan-out ──────────────────────────────────────
  // Recompute every TM whose target_table_id matches EITHER the old
  // target's table OR the new target's table — the target table may
  // have crossed table boundaries.
  const targetTablesAffected = new Set<string>()
  targetTablesAffected.add(newTarget.table_id)
  if (prevTarget?.table_id) targetTablesAffected.add(prevTarget.table_id)

  for (const ttId of targetTablesAffected) {
    const { data: tms } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .eq('target_table_id', ttId)
    for (const tm of (tms ?? []) as Array<{ id: string }>) {
      await recomputeTableMappingStatus(supabase, tm.id)
    }
  }

  // ── Step 14: revalidate ────────────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath(`/app/projects/${projectId}/transform`)
  revalidatePath('/app/projects')

  // ── Step 15: activity logs ─────────────────────────────────────────────
  // Reuses mapping_sources_changed (broad "mapping mutated" semantic)
  // with metadata.kind='target_changed' to disambiguate from the
  // sources-edit emitter. Plus mapping_approved for the cascade.
  await logActivity(
    projectId,
    'mapping_sources_changed',
    `Mapping target edited: ${prevTarget?.name ?? '?'} → ${newTarget.name}`,
    'mapping',
    {
      surface: 'flat_view',
      kind: 'target_changed',
      target_field_mapping_id: tfm.id,
      previous_target_field: prevTarget?.name ?? null,
      previous_target_field_id: tfm.target_field_id,
      new_target_field: newTarget.name,
      new_target_field_id: newTargetFieldId,
      transform_reset: transformReset,
    },
  )
  await logActivity(
    projectId,
    'mapping_approved',
    `Mapping approved: → ${newTarget.name}`,
    'mapping',
    {
      surface: 'flat_view',
      target_field_mapping_id: tfm.id,
      target_field: newTarget.name,
    },
  )

  if (transformReset) {
    await logActivity(
      projectId,
      'transformation_reset',
      `Transformation reset on edit: ${newTarget.name}`,
      'transform',
      {
        surface: 'flat_view',
        reason: 'flat_view_target_changed',
        target_field_mapping_id: tfm.id,
        target_field: newTarget.name,
        rows_reverted: stagedRowsReverted,
      },
    )
  }

  return {
    success: true,
    tfmId: tfm.id,
    transformReset,
    stagedRowsReverted,
  }
}

// ─── 5.3 createMappingFromUnmapped ───────────────────────────────────────────

export type CreateFromUnmappedErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'TARGET_CONFLICT'
  | 'INTERNAL'

export type CreateMappingFromUnmappedResult =
  | {
      success: true
      tfmId: string
      tableMappingId: string
      resolvedCase: 'unmapped_target' | 'unmapped_source' | 'both' | 'neither'
    }
  | {
      success: false
      error: string
      errorCode: CreateFromUnmappedErrorCode
    }

/**
 * Create a mapping between a source field and a target field when one
 * of them is currently in an unmapped state. Detects the case
 * automatically:
 *
 *   • Unmapped target  — target has no live TFM (may have a coverage
 *     row carrying status='rejected' or status_set_by='user'). The
 *     wrapper clears that coverage state and creates the mapping.
 *   • Unmapped source  — source has a row in source_field_acknowledgments
 *     (decision='acknowledged' or 'rejected'). The wrapper DELETEs the
 *     ack row (Q3) and creates the mapping.
 *
 * Both cases can coexist for a single create — the wrapper reports
 * `resolvedCase` so the UI can tailor the post-create toast.
 *
 * The actual TFM creation delegates to `createFieldMapping`
 * (single-source, combination='single', confidence=100). The wrapper
 * then flips the TFM to status='approved' (manual creation is an
 * affirmative decision per founder Q4 + flat-view semantics).
 */
export async function createMappingFromUnmapped(input: {
  projectId: string
  sourceFieldId: string
  targetFieldId: string
}): Promise<CreateMappingFromUnmappedResult> {
  const { projectId, sourceFieldId, targetFieldId } = input

  // ── Step 1: input validation ────────────────────────────────────────────
  if (!projectId || !sourceFieldId || !targetFieldId) {
    return {
      success: false,
      error: 'projectId, sourceFieldId, and targetFieldId are required',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: project permission ──────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: case detection ──────────────────────────────────────────────
  const [existingTfmRes, existingAckRes] = await Promise.all([
    supabaseAdmin
      .from('target_field_mappings')
      .select('id, status, is_acknowledged, combination_type')
      .eq('project_id', projectId)
      .eq('target_field_id', targetFieldId)
      .maybeSingle<{
        id: string
        status: 'needs_review' | 'approved' | 'rejected'
        is_acknowledged: boolean
        combination_type: string | null
      }>(),
    supabaseAdmin
      .from('source_field_acknowledgments')
      .select('id, decision')
      .eq('project_id', projectId)
      .eq('source_field_id', sourceFieldId)
      .maybeSingle<{ id: string; decision: string }>(),
  ])

  const existingTfm = existingTfmRes.data
  const existingAck = existingAckRes.data

  const targetIsUnmapped =
    !existingTfm ||
    (existingTfm.is_acknowledged && existingTfm.combination_type === null)
  const sourceIsUnmapped = existingAck !== null

  // If a live (non-bare-ack) TFM exists at the target, refuse — the
  // user reached the flat-view "create" affordance for what should be
  // a target with NO live mapping. Defer to the drawer/edit surface.
  if (
    existingTfm &&
    !(existingTfm.is_acknowledged && existingTfm.combination_type === null) &&
    existingTfm.status !== 'rejected'
  ) {
    return {
      success: false,
      error:
        'This target field is already mapped. Edit the existing mapping instead.',
      errorCode: 'TARGET_CONFLICT',
    }
  }

  let resolvedCase: 'unmapped_target' | 'unmapped_source' | 'both' | 'neither'
  if (targetIsUnmapped && sourceIsUnmapped) resolvedCase = 'both'
  else if (targetIsUnmapped) resolvedCase = 'unmapped_target'
  else if (sourceIsUnmapped) resolvedCase = 'unmapped_source'
  else resolvedCase = 'neither'

  // ── Step 5: delegate to createFieldMapping ─────────────────────────────
  // createFieldMapping handles auth (re-checked), permission (re-checked),
  // maintenance, identity reads, the bare-ack delete, TM find-or-create,
  // RPC, coverage recompute, revalidate, and the mapping_created activity-
  // log entry. We skip duplicating any of that.
  const createResult = await createFieldMapping({
    projectId,
    targetFieldId,
    sourceFieldIds: [sourceFieldId],
    combinationType: 'single',
    aiSuggested: false,
    confidence: FLAT_VIEW_USER_CONFIDENCE,
    aiReasoning: 'Mapping created via flat (spreadsheet) view',
  })
  if (!createResult.success) {
    return {
      success: false,
      error: createResult.error,
      // CROSS_TABLE_NOT_YET_SUPPORTED collapses into VALIDATION for the
      // narrower union here; the flat-view UI surfaces "couldn't map
      // across tables" copy if needed.
      errorCode:
        createResult.errorCode === 'CROSS_TABLE_NOT_YET_SUPPORTED'
          ? 'VALIDATION'
          : createResult.errorCode,
    }
  }

  // ── Step 6: flip TFM status to approved (flat-view affirmation) ────────
  const { error: statusErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('id', createResult.tfmId)
  if (statusErr) {
    return {
      success: false,
      error: statusErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 7: clear unmapped-target coverage state (Q3 + §5.3 step 7) ────
  // If the target had a coverage row carrying status='rejected' or
  // status_set_by='user', a subsequent read translator resolution would
  // surface it as rejected. Reset to needs_review + ai_auto so TFM-
  // driven status wins on the next render.
  if (targetIsUnmapped) {
    const coverageReset = await setCoverageStatus(
      projectId,
      targetFieldId,
      'needs_review',
    )
    if (!coverageReset.success) {
      console.warn(
        '[createMappingFromUnmapped] coverage reset failed (TFM created):',
        coverageReset.error,
      )
    }
  }

  // ── Step 8: clear source acknowledgment (Q3) ───────────────────────────
  // Per Q3 resolution: delete the acknowledgment row when present,
  // regardless of decision. The new mapping is the affirmative decision
  // for the source.
  if (sourceIsUnmapped && existingAck) {
    const { error: ackDelErr } = await supabaseAdmin
      .from('source_field_acknowledgments')
      .delete()
      .eq('id', existingAck.id)
    if (ackDelErr) {
      console.warn(
        '[createMappingFromUnmapped] source ack delete failed (TFM created):',
        ackDelErr.message,
      )
    }
  }

  // createFieldMapping already revalidates and logs `mapping_created`.
  // The status flip emits no additional log to keep audit-trail noise
  // tight (Q4 — reuse existing types).

  return {
    success: true,
    tfmId: createResult.tfmId,
    tableMappingId: createResult.tableMappingId,
    resolvedCase,
  }
}

// ─── 5.4 setUnmappedRowRejected ──────────────────────────────────────────────

export type SetUnmappedRowRejectedErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'

export type SetUnmappedRowRejectedResult =
  | {
      success: true
      side: 'target' | 'source'
    }
  | {
      success: false
      error: string
      errorCode: SetUnmappedRowRejectedErrorCode
    }

/**
 * Reject an unmapped flat-view row. Exactly one of `targetFieldId` /
 * `sourceFieldId` must be supplied:
 *
 *   • Target branch — writes `target_field_coverage.status='rejected'`
 *     via `setCoverageStatus`. Refuses if a live TFM already covers
 *     the target (the user reached the wrong affordance).
 *   • Source branch — UPSERTs into `source_field_acknowledgments` with
 *     `decision='rejected'` and `reason=''`. Recomputes affected TMs.
 *
 * Activity-log emitters:
 *   • Target — `mapping_rejected` with `no_source: true` (parity with
 *     the existing rejectFieldMapping unmapped-target branch).
 *   • Source — `source_field_rejected` (new action_type added in this
 *     PR; Q4 resolution).
 */
export async function setUnmappedRowRejected(input: {
  projectId: string
  targetFieldId?: string
  sourceFieldId?: string
}): Promise<SetUnmappedRowRejectedResult> {
  const { projectId, targetFieldId, sourceFieldId } = input

  // ── Step 1: input validation (XOR) ──────────────────────────────────────
  if (!projectId) {
    return {
      success: false,
      error: 'projectId is required',
      errorCode: 'VALIDATION',
    }
  }
  if ((targetFieldId && sourceFieldId) || (!targetFieldId && !sourceFieldId)) {
    return {
      success: false,
      error: 'Exactly one of targetFieldId or sourceFieldId must be supplied',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: project permission ──────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 4: maintenance gate ────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
    }
  }

  if (targetFieldId) {
    // ── Target branch ──────────────────────────────────────────────────────
    if (!UUID_REGEX.test(targetFieldId)) {
      return {
        success: false,
        error: 'targetFieldId must be a valid uuid',
        errorCode: 'VALIDATION',
      }
    }
    const ownership = await resolveFieldOwnership(targetFieldId)
    if (!ownership || ownership.projectId !== projectId) {
      return {
        success: false,
        error: 'Target field not found in this project',
        errorCode: 'NOT_FOUND',
      }
    }

    // Refuse if a live TFM exists for the target — the user must reach
    // the per-row reject path (rejectFieldMapping), not the flat-view
    // unmapped reject.
    const { data: liveTfm } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, status')
      .eq('project_id', projectId)
      .eq('target_field_id', targetFieldId)
      .maybeSingle<{ id: string; status: string }>()
    if (liveTfm && liveTfm.status !== 'rejected') {
      return {
        success: false,
        error:
          'This target has a mapping. Use Reject on the mapped row instead.',
        errorCode: 'VALIDATION',
      }
    }

    const writeResult = await setCoverageStatus(
      projectId,
      targetFieldId,
      'rejected',
    )
    if (!writeResult.success) {
      return {
        success: false,
        error: writeResult.error ?? 'Failed to update coverage status',
        errorCode: 'INTERNAL',
      }
    }

    await logActivity(
      projectId,
      'mapping_rejected',
      `Mapping rejected: [no source] → ${ownership.fieldName ?? '?'}`,
      'mapping',
      {
        surface: 'flat_view',
        target_field_id: targetFieldId,
        target_field: ownership.fieldName,
        source_field: null,
        no_source: true,
      },
    )
    revalidatePath(`/app/projects/${projectId}/mapping`)
    revalidatePath('/app/projects')

    return { success: true, side: 'target' }
  }

  // ── Source branch ──────────────────────────────────────────────────────
  if (!sourceFieldId) {
    // unreachable per XOR check, but the type narrows for the compiler.
    return {
      success: false,
      error: 'sourceFieldId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!UUID_REGEX.test(sourceFieldId)) {
    return {
      success: false,
      error: 'sourceFieldId must be a valid uuid',
      errorCode: 'VALIDATION',
    }
  }

  const ownership = await resolveFieldOwnership(sourceFieldId)
  if (!ownership || ownership.projectId !== projectId) {
    return {
      success: false,
      error: 'Source field not found in this project',
      errorCode: 'NOT_FOUND',
    }
  }

  // UPSERT — flip any existing acknowledgment (decision='acknowledged')
  // to decision='rejected'. The UNIQUE (project_id, source_field_id)
  // constraint guarantees one row per source field.
  const { error: upsertErr } = await supabaseAdmin
    .from('source_field_acknowledgments')
    .upsert(
      {
        project_id: projectId,
        source_field_id: sourceFieldId,
        decision: 'rejected',
        reason: '',
        acknowledged_by: user.id,
        acknowledged_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,source_field_id' },
    )
  if (upsertErr) {
    return {
      success: false,
      error: upsertErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // Recompute TMs whose source_table_id matches this source field's
  // parent table. The recompute treats any source_field_acknowledgments
  // row as "source decided", so flipping acknowledged → rejected is a
  // no-op for TM status but the recompute is harmless and keeps the
  // dashboard pill snappy if the user flipped from un-acked.
  const { data: sourceField } = await supabaseAdmin
    .from('fields')
    .select('table_id')
    .eq('id', sourceFieldId)
    .maybeSingle<{ table_id: string }>()
  if (sourceField) {
    const { data: tms } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .eq('source_table_id', sourceField.table_id)
    for (const tm of (tms ?? []) as Array<{ id: string }>) {
      await recomputeTableMappingStatus(supabase, tm.id)
    }
  }

  await logActivity(
    projectId,
    'source_field_rejected',
    `Source field rejected: ${ownership.fieldName ?? '?'}`,
    'mapping',
    {
      surface: 'flat_view',
      source_field_id: sourceFieldId,
      source_field: ownership.fieldName,
    },
  )
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath('/app/projects')

  return { success: true, side: 'source' }
}
