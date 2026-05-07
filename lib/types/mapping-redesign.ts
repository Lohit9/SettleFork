/**
 * Row-shape types for the new mapping-redesign tables introduced in
 * migration 074.
 *
 * These mirror the DDL in `supabase/migrations/074_mapping_redesign_data_migration.sql`
 * (STEP 2). They are deliberately kept free of any business logic so they
 * can be imported from both server actions and the pure translation shim
 * in `lib/compat/mapping-shim.ts`.
 *
 * Once Phase 3 lands the new UI and the shim is deleted (spec §Cleanup
 * items), these types continue to represent the canonical row shapes —
 * UI components will consume them directly rather than the shimmed
 * RichFieldMapping shape.
 */

export type TFMCombinationType = 'single' | 'concat_space' | 'concat_comma' | 'custom_sql'

export type MappingStatus = 'needs_review' | 'approved' | 'rejected'

/**
 * One row in `public.target_field_mappings`. The primary entity in the new
 * model — one row per (project, target_field).
 *
 * Confidence semantics (spec §Confidence semantics):
 *   - mapped targets  → derived by trigger as MIN(mapping_sources.confidence)
 *   - value assignments → stored directly (trigger skips custom_sql)
 *   - acknowledged targets → NULL (trigger skips is_acknowledged rows)
 */
export interface TargetFieldMappingRow {
  id: string
  project_id: string
  target_field_id: string
  confidence: number | null
  status: MappingStatus
  ai_reasoning: string | null
  is_acknowledged: boolean
  acknowledgment_reason: string | null
  combination_type: TFMCombinationType | null
  combination_sql: string | null
  /**
   * Path D (migration 093) — free-form AI rationale describing the intent of
   * the transformation. Distinct from `ai_reasoning` which describes the
   * mapping decision itself. Path D writes this directly; Path B records
   * carry NULL here and embed combination markers inside `ai_reasoning`.
   * Read via `lib/utils/transformation-intent.ts:resolveTransformationIntent`.
   */
  transformation_intent: string | null
  /**
   * User/AI assessment of whether this target field needs a transformation.
   *
   *   NULL  = not yet assessed (no primary FM ever set a value)
   *   TRUE  = AI assessment or FK cascade flagged this target as needing
   *           a transform
   *   FALSE = user explicitly dismissed the transform requirement
   *
   * Restored in migration 075 from `field_mappings_backup_074` after the
   * legacy `field_mappings.needs_transformation` column was dropped in 074.
   * Rejected primary FMs and acknowledged TFMs are excluded from that
   * backfill — see migration 075's header for the rationale.
   */
  needs_transformation: boolean | null
  /**
   * Migration 077 — TRUE when the user has dismissed the value-assignment
   * requirement for this target field (e.g. DB default, auto-generated,
   * intentional NULL). Only meaningful for VA TFMs (`combination_type =
   * 'custom_sql'` AND zero mapping_sources). Mapped TFMs use
   * `needs_transformation = false` to dismiss transform requirements; the
   * two flags are intentionally distinct because load-SQL emission and
   * readiness scoring behave differently in each case (dismissed VAs are
   * skipped from SELECT lists; transform-dismissed mapped fields are
   * still emitted as direct passthroughs).
   */
  va_dismissed: boolean
  /**
   * Migration 077 — free-text rationale captured at dismissal time,
   * parallel to `acknowledgment_reason`. Reserved for future Phase 4
   * acknowledgment-consolidation work.
   */
  dismissal_reason: string | null
  created_at: string
  updated_at: string
}

/**
 * One row in `public.mapping_sources`. Zero-or-more children per
 * `target_field_mappings.id`.
 *
 *   - ordinal=0 is the dominant source (used for apply, join anchor)
 *   - source_field_id / source_table_id are nullable for defense-in-depth;
 *     live rows in the new model always have both set together.
 *   - `similar_fields_considered` and `join_spec` are JSONB — consumers
 *     must narrow before use.
 */
export interface MappingSourceRow {
  id: string
  target_field_mapping_id: string
  source_field_id: string | null
  source_table_id: string | null
  confidence: number | null
  ai_reasoning: string | null
  similar_fields_considered: unknown | null
  type_compatibility: string | null
  join_spec: unknown | null
  ordinal: number
  created_at: string
}

/**
 * One row in `public.source_field_acknowledgments`. Replaces the
 * `side='source'` rows of the legacy `field_acknowledgments` table.
 */
export interface SourceFieldAcknowledgmentRow {
  id: string
  project_id: string
  source_field_id: string
  reason: string
  notes: string | null
  acknowledged_by: string | null
  acknowledged_at: string
}

// ─── Transformations (migration 074 rename) ──────────────────────────────────
//
// Legacy column `transformations.field_mapping_id` was dropped in migration
// 074 (STEP 14c) and replaced by `target_field_mapping_id`, which FKs into
// `target_field_mappings(id) ON DELETE CASCADE`. This shape is what the new
// server actions read and write.
//
// Invariant (spec §Transformations, not DB-enforced):
//   COUNT(transformations) per `target_field_mapping_id` ≤ 1
//
// A target_field_mapping carries AT MOST ONE transformation. We do not add a
// DB-level UNIQUE constraint in 074 to keep the migration's scope tight; the
// invariant is instead asserted by a live-data test (see
// `tests/integration/transformations-unique-invariant.test.ts`) and by the
// upsert semantics in every write path (`.eq('target_field_mapping_id', …)`
// followed by `.maybeSingle()` / INSERT-or-UPDATE). Any future migration that
// starts writing multiple transformations per TFM MUST first lift this
// invariant explicitly, because downstream code (outputs.ts, execution-
// package.ts, lib/quality/*) unconditionally picks the single row.

export type TransformationStatus =
  | 'draft'
  | 'tested'
  | 'saved'
  | 'applied'
  | 'stale'

export interface TransformationRow {
  id: string
  target_field_mapping_id: string
  description: string | null
  generated_sql: string
  is_ai_generated: boolean
  test_results: unknown | null
  status: TransformationStatus
  created_at: string
}
