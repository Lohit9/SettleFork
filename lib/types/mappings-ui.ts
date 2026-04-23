/**
 * UI-consumed mapping shapes.
 *
 * These types were historically co-located inside `lib/actions/mappings.ts`.
 * They are extracted here so that pure modules (notably
 * `lib/compat/mapping-shim.ts` and its tests) can import them without
 * pulling in the `'use server'` action bundle.
 *
 * `lib/actions/mappings.ts` re-exports every type from this file so that
 * every existing consumer import (`import type { RichFieldMapping } from
 * '@/lib/actions/mappings'`) continues to resolve unchanged. Do not import
 * UI shapes from this file directly in client/server components — keep
 * using the `@/lib/actions/mappings` import path so that the Phase 5
 * cleanup can consolidate without touching call sites.
 */

export interface RichFieldMapping {
  id: string
  table_mapping_id: string
  source_field_id: string | null
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  similar_fields_considered: string[] | null
  type_compatibility: string | null
  /** True when this is a secondary source contributing to a target that already has a primary mapping */
  is_contributing: boolean
  created_at: string
  sourceField: {
    id: string
    name: string
    data_type: string
    inferred_type: string | null
  } | null
  targetField: {
    id: string
    name: string
    data_type: string
    inferred_type: string | null
  } | null
  sourceFieldSamples: string[]
  targetFieldSamples: string[]
  sourceFieldNullPercentage: number
  /**
   * Transformation currently defined for this mapping, or null if none.
   * Keyed on the underlying target_field_mapping so post-Phase-3 the shape
   * stays stable: the drawer Transform tab reads this field without
   * knowing about the shim/non-shim distinction.
   */
  transformation: {
    id: string
    status: 'draft' | 'tested' | 'saved' | 'applied' | 'stale'
    description: string | null
    generated_sql: string | null
  } | null
}

export interface RichTableMapping {
  id: string
  project_id: string
  source_table_id: string
  target_table_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  created_at: string
  sourceTable: {
    id: string
    name: string
    dataset: { id: string; name: string; role: string }
  } | null
  targetTable: {
    id: string
    name: string
    dataset: { id: string; name: string; role: string }
  } | null
  fieldMappings: RichFieldMapping[]
}

export interface UnmappedField {
  id: string
  name: string
  data_type: string
  table_id: string
  table: { id: string; name: string } | null
  /** Whether the underlying column is declared NULLable. Drives the
   *  "required — needs mapping" warning on unmapped target rows. */
  is_nullable?: boolean
  /** Raw DEFAULT expression from the target DDL (migration 064). When set,
   *  the target column will auto-populate on INSERT even if unmapped, so
   *  the UI shows a muted "has default" hint rather than a warning. */
  default_value?: string | null
}

export interface SimpleField {
  id: string
  name: string
  data_type: string
  is_nullable?: boolean
  /** Raw DEFAULT from DDL / information_schema (migration 064). Used by
   *  the mapping UI to distinguish "unmapped but self-populating" target
   *  fields from "unmapped and will fail on INSERT" target fields. */
  default_value?: string | null
}

export interface FieldAcknowledgmentRow {
  id: string
  project_id: string
  field_id: string
  side: string
  reason: string
  notes: string | null
  acknowledged_at: string
}

export interface MappingsResult {
  tableMappings: RichTableMapping[]
  unmappedSourceFields: UnmappedField[]
  unmappedTargetFields: UnmappedField[]
  allSourceTables: { id: string; name: string; datasetName: string }[]
  allTargetTables: { id: string; name: string; datasetName: string }[]
  /** All fields for every table in the project, keyed by table_id */
  allFieldsByTable: Record<string, SimpleField[]>
  /** Persisted acknowledgments for unmapped fields */
  acknowledgments: FieldAcknowledgmentRow[]
}
