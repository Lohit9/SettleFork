'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

// ── ActionType discriminated union ──────────────────────────────────────────
//
// The underlying `activity_log.action_type` column is `TEXT NOT NULL` with no
// CHECK constraint or enum (see `supabase/migrations/031_activity_log.sql:13`),
// so widening this union is a pure TS change — no DB migration required.
//
// **Naming convention** (do not break — observed in 19/22 existing values):
// `subject_pastTenseVerb`, with the subject as a singular noun.
//   ✓ `mapping_approved`     (singular subject + past-tense verb)
//   ✓ `acknowledgment_removed`
//   ✗ `mapping_approve`      (verb tense wrong)
//   ✗ `mappings_approved`    (subject pluralized)
// Exceptions retained for back-compat: `scan_run`, `stage_all`, `rule_added`,
// `rule_deleted`. Don't add new exceptions.
//
// **No exhaustive switches** consume this union anywhere in the codebase —
// it's only used as the `actionType` parameter to `logActivity`. Adding a new
// value cannot break existing code paths; tests only assert specific event
// names emit (additive verification, never exhaustive).
//
// Phase 4 mutation-completeness widening (2026-04-25, see
// `docs/features/phase-4-plan.md` §2.2):
//   - `mapping_created`               — W1 manual creation, W6 AI-suggested persist
//   - `mapping_sources_changed`       — W2 add/remove a source on an existing TFM
//   - `mapping_combination_changed`   — W3 combination_type change on a mapped TFM
//   - `acknowledgment_removed`        — W4 un-acknowledge target field
//   - `mapping_bulk_approved`         — W5 approveAll / approveHighConfidence
//   - `mapping_bulk_rejected`         — W5 rejectAll
//   - `transformation_reset`          — emitted by `editMappingSources`
//                                       (4b-1) when a source change forces
//                                       the field's transform to be deleted
//                                       and its staged data reverted.
//                                       Metadata: { reason: 'mapping_edited',
//                                       target_field_mapping_id, target_field,
//                                       rows_reverted }.
export type ActionType =
  | 'fix_applied'
  | 'fix_reverted'
  | 'custom_fix_applied'
  | 'risk_accepted'
  | 'risk_reverted'
  | 'transform_generated'
  | 'transform_tested'
  | 'transform_applied'
  | 'mapping_approved'
  | 'mapping_rejected'
  | 'mapping_generated'
  // Phase 4 — mutation completeness (added 2026-04-25, no emitters yet;
  // wrappers in `lib/actions/mappings-for-redesign.ts` will emit these as
  // 4a/4b/4c land).
  | 'mapping_created'
  | 'mapping_sources_changed'
  | 'mapping_combination_changed'
  | 'acknowledgment_removed'
  | 'mapping_bulk_approved'
  | 'mapping_bulk_rejected'
  | 'transformation_reset'
  | 'rule_added'
  | 'rule_deleted'
  | 'scan_run'
  | 'stage_all'
  | 'source_uploaded'
  | 'target_uploaded'
  | 'doc_uploaded'
  | 'project_archived'

export type ActionCategory = 'fix' | 'mapping' | 'transform' | 'validation' | 'data' | 'system'

/**
 * Append one activity entry to the log. Always fire-and-forget — wrapped in
 * try/catch so a logging failure never blocks the parent server action.
 */
export async function logActivity(
  projectId: string,
  actionType: ActionType,
  description: string,
  category: ActionCategory,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    await supabaseAdmin.from('activity_log').insert({
      project_id: projectId,
      user_id: user.id,
      action_type: actionType,
      description,
      category,
      metadata: metadata ?? {},
    })
  } catch (err) {
    // Non-critical — never fail the parent action because of logging
    console.warn('[activity-log] Failed to log activity:', err)
  }
}
