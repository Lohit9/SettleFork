'use server'

/**
 * Phase 0c provenance helper.
 *
 * `logAIEdit` writes one row to `public.ai_edit_history` per AI-touched
 * value change. Sibling to `logActivity` (lib/actions/activity-log.ts):
 * `logActivity` captures human-visible events as a description string;
 * `logAIEdit` captures the structured before/after used by the future
 * eval harness and the migration_intelligence calibration loop.
 *
 * Always fire-and-forget — wrapped in try/catch so a logging failure
 * never blocks the parent server action. Mirrors `logActivity`'s
 * contract.
 *
 * Schema: `supabase/migrations/083_ai_edit_history.sql`. Adding a new
 * `AIEntityType` value requires both updating the CHECK constraint on
 * `entity_type` (new migration) AND extending the union below.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { redactForLog } from '@/lib/ai/redact'

export type AIEditKind =
  | 'ai_proposed'
  | 'ai_replaced'
  | 'human_accepted'
  | 'human_modified'
  | 'human_rejected'
  | 'human_authored'

export type AIEntityType =
  | 'target_field_mapping'
  | 'mapping_source'
  | 'transformation'
  | 'validation_rule'
  | 'quality_issue'

export interface LogAIEditInput {
  projectId: string
  actorId: string
  entityType: AIEntityType
  entityId: string
  fieldPath: string
  /** Pre-redaction; helper applies redactForLog before insert. */
  oldValue: unknown
  /** Pre-redaction; helper applies redactForLog before insert. */
  newValue: unknown
  editKind: AIEditKind
  /** FK to llm_calls(id). NULL for human-only edits. */
  llmCallId?: string | null
  metadata?: Record<string, unknown>
}

export async function logAIEdit(input: LogAIEditInput): Promise<void> {
  try {
    await supabaseAdmin.from('ai_edit_history').insert({
      project_id: input.projectId,
      actor_id: input.actorId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      field_path: input.fieldPath,
      old_value: redactForLog(input.oldValue) ?? null,
      new_value: redactForLog(input.newValue) ?? null,
      edit_kind: input.editKind,
      llm_call_id: input.llmCallId ?? null,
      // metadata is NOT NULL DEFAULT '{}'::jsonb in the schema; pass `{}` not null.
      metadata: input.metadata ?? {},
    })
  } catch (err) {
    // Non-critical — never fail the parent action because of provenance logging.
    console.warn(
      `[ai-edit-history] Failed to log edit (entity_type=${input.entityType} entity_id=${input.entityId}):`,
      err,
    )
  }
}
