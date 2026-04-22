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
