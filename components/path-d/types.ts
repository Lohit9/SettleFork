/**
 * Path D — UI component types.
 *
 * Schema is the contract. Every shape below traces directly to migration 093
 * (`supabase/migrations/093_path_d_foundation.sql`):
 *
 *   • 5 new tables — target_field_coverage, project_decisions,
 *     project_lookup_tables, project_data_quality_issues,
 *     project_inferred_targets
 *   • 5 enrichment columns on target_field_mappings — transformation_intent,
 *     mapping_cardinality, dedup_required, dedup_strategy,
 *     data_quality_flag_ids
 *
 * Scope: B-side scaffolding ahead of Phase B core landing real data. These
 * types feed mocked-data UI components only — no server actions wire to
 * them yet. When A's Phase B server actions need to import the same shapes,
 * promote this file to lib/types/path-d.ts.
 */

// ── Schema-derived enums (lines 58, 128, 247, 360 of migration 093) ──

export type CoverageStatus =
  | 'covered'
  | 'partial'
  | 'gap'
  | 'optional'
  | 'out_of_scope'

export type MappingCardinality =
  | '1:1'
  | 'many_to_one'
  | 'one_to_many'
  | 'many_to_many'

export type DecisionStatus = 'pending' | 'decided' | 'auto_applied'

export type DqSeverity = 'critical' | 'warning' | 'info'

// ── Structured JSONB shapes ──

// Note: B-side scaffolded shape derived from migration 093 column comment (lines 384-385).
// A's Phase B agent prompt aligns to this shape, or we reconcile in a follow-up PR
// once Phase B produces real data. Promote this file to lib/types/path-d.ts when
// server actions need to import the same shapes.
export interface DedupStrategy {
  key_fields: string[]
  conflict_resolution: 'first' | 'last' | 'merge'
  ordering?: string
}

/**
 * project_decisions.applies_to — typed per the table comment at migration 093:140.
 * Both arrays optional; either may be present without the other.
 */
export interface DecisionAppliesTo {
  tfm_ids?: string[]
  coverage_ids?: string[]
}

// ── Table row types (5 new tables) ──

/**
 * target_field_coverage — one row per (project, target_field).
 * UNIQUE (project_id, target_field_id) per migration 093:67.
 */
export interface TargetFieldCoverageRow {
  id: string
  project_id: string
  target_field_id: string
  coverage_status: CoverageStatus
  ai_reasoning: string | null
  default_value_recommendation: unknown | null
  default_value_decided: unknown | null
  default_decided_at: string | null
  default_decided_by: string | null
  created_at: string
  updated_at: string
  experiment_run_id: string | null
}

/**
 * project_decisions — structured business decisions surfaced by Path D.
 * ai_recommendation / alternatives / customer_decision are JSONB; their
 * canonical shapes are owned by Phase B's agent prompt and rendered as
 * raw JSON stubs in the scaffolding components.
 */
export interface ProjectDecisionRow {
  id: string
  project_id: string
  decision_type: string
  title: string
  description: string | null
  ai_recommendation: unknown
  alternatives: unknown[]
  customer_decision: unknown | null
  applies_to: DecisionAppliesTo | null
  status: DecisionStatus
  decided_at: string | null
  decided_by: string | null
  created_at: string
  updated_at: string
  experiment_run_id: string | null
}

/**
 * project_lookup_tables — first-class enum / code mapping tables.
 * mappings is the source→target value dictionary (e.g. {"Each":"EA"});
 * data_quality_notes is keyed by the source value for inline DQ warnings.
 */
export interface ProjectLookupTableRow {
  id: string
  project_id: string
  name: string
  description: string | null
  applies_to_fields:
    | Array<{ source_field_id: string; target_field_id: string }>
    | null
  mappings: Record<string, string>
  data_quality_notes: Record<string, string> | null
  customer_approved: boolean
  created_at: string
  updated_at: string
  experiment_run_id: string | null
}

/**
 * project_data_quality_issues — append-only AI-detected DQ findings.
 * source_field_id NULL for project-level (cross-field/cross-table) findings.
 */
export interface ProjectDataQualityIssueRow {
  id: string
  project_id: string
  source_field_id: string | null
  severity: DqSeverity
  category: string
  description: string
  example_values: unknown | null
  recommendation: string | null
  acknowledged_at: string | null
  acknowledged_by: string | null
  created_at: string
  experiment_run_id: string | null
}

/**
 * project_inferred_targets — AI-inferred target objects implied by source data.
 * No acknowledged_by per migration 093:297-299 (inference acknowledgment is
 * project-level, not user-level).
 */
export interface ProjectInferredTargetRow {
  id: string
  project_id: string
  inferred_target_object: string
  evidence_source_fields: string[] | null
  reasoning: string | null
  acknowledged_at: string | null
  created_at: string
  experiment_run_id: string | null
}

// ── target_field_mappings — Path D enrichment columns (migration 093:354-369) ──

/**
 * Pick of the 5 Path D enrichment columns added to target_field_mappings.
 * MappingDetailsPanel renders these. The base TFM shape stays in A's
 * territory (lib/types/mappings-for-redesign.ts); this interface only
 * captures the additive Path D columns.
 */
export interface TfmPathDEnrichment {
  transformation_intent: string | null
  mapping_cardinality: MappingCardinality | null
  dedup_required: boolean
  dedup_strategy: DedupStrategy | null
  data_quality_flag_ids: string[]
}
