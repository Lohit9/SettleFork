/**
 * PR 3.4cd — Type definitions for the multi-agent mapping pipeline.
 *
 * These mirror the strict-mode tool schemas in tool-schemas.ts:
 *   CandidateMapping            ↔ EMIT_MAPPING_CANDIDATES_TOOL
 *   CrossTableResolution        ↔ EMIT_CROSS_TABLE_RESOLUTIONS_TOOL
 *   CardinalityResolution       ↔ EMIT_CARDINALITY_RESOLUTIONS_TOOL
 *   Critique                    ↔ EMIT_CRITIQUE_TOOL
 *
 * Plus aggregator output shapes (used by vote-aggregation helpers added
 * in commit 3) and the orchestrator's public return type.
 *
 * Spec: docs/investigations/pr3.4cd-multi-agent-mapping.md §B5 + §D1.
 */

// ─── Per-agent output shapes (1:1 with tool schemas) ────────────────────────

export interface CandidateMapping {
  /** Bare source field name (primary contributor for many_to_one). */
  source_field: string
  /** Bare target field name. */
  target_field: string
  /** Cardinality / cross-table classification. Specialists may overwrite. */
  tag: 'one_to_one' | 'many_to_one' | 'one_to_many' | 'cross_table' | 'uncertain'
  /** 0-100; agent's pre-vote estimate. Orchestrator may overwrite. */
  confidence: number
  reasoning: string
  /** Required when tag === 'many_to_one'. Other source field names. */
  contributing_source_fields?: string[]
  /** Required when tag === 'cross_table'. Names the JOIN target. */
  cross_table_source?: { source_table: string; source_field: string }
  type_compatibility: string
  needs_transformation: boolean
}

export interface CrossTableResolution {
  /** Zero-based index into the candidate list passed to the specialist. */
  candidate_index: number
  decision: 'confirm' | 'reject'
  reasoning: string
  /** Required when decision === 'confirm'. */
  join_spec?: { via_fk_field: string; join_path: string }
}

export interface CardinalityResolution {
  candidate_index: number
  final_cardinality: 'one_to_one' | 'many_to_one' | 'one_to_many'
  contributing_fields?: string[]
  split_hint?: string
  transformation_pattern: string
  reasoning: string
}

export interface Critique {
  category: 'contradiction' | 'missed_mapping' | 'conservative_mistake' | 'aggressive_mistake'
  /** Zero-based index into confirmed_mappings (for contradiction / aggressive_mistake). */
  affected_mapping_index?: number
  /** Bare target field name (for missed_mapping / conservative_mistake). */
  affected_target_field?: string
  description: string
  suggested_fix: string
  severity: 'low' | 'medium' | 'high'
}

// ─── Aggregator output shapes (commit 3 fills these in) ─────────────────────

/**
 * Result of `aggregateCandidates(votes: GeneratorOutput[3])`. The 3 voted
 * Generator outputs are merged into three buckets. `unanimous` and
 * `majority` flow to specialists; `controversial` bubbles up to Critic
 * via the `unmapped_target_fields` + special "controversial" annotation.
 */
export interface AggregatedCandidates {
  /** 3/3 agreement on (source_field, target_field, tag) — confidence 95. */
  unanimous: CandidateMapping[]
  /** 2/3 agreement — confidence 67; minority tag captured in metadata. */
  majority: Array<CandidateMapping & { minority_tag?: CandidateMapping['tag'] }>
  /** 1/1/1 disagreement — surfaced low-confidence (50) post-Critic. */
  controversial: Array<CandidateMapping[]>
  /** Summary counts for telemetry. */
  summary: MultiAgentVoteSummary
}

/**
 * Result of `aggregateCritiques(votes: CriticOutput[3])`. Critique
 * matching uses `(category, affected_mapping_index || affected_target_field)`
 * + Jaccard similarity on description tokens (≥ 0.5 threshold) per
 * Phase A §C3.
 */
export interface AggregatedCritiques {
  /** 3/3 agreement on a critique — refinement MUST address. */
  high_confidence: Critique[]
  /** 2/3 agreement — refinement SHOULD address. */
  medium_confidence: Critique[]
  /** 1/1/1 — surface low-confidence with all 3 critique payloads. */
  low_confidence: Array<Critique[]>
  summary: MultiAgentVoteSummary
}

export interface MultiAgentVoteSummary {
  /** Count of items with 3/3 agreement. */
  unanimous: number
  /** Count of items with 2/3 agreement. */
  majority: number
  /** Count of items with 1/1/1 disagreement. */
  controversial: number
}

// ─── Orchestrator return type ───────────────────────────────────────────────

/**
 * Public return type of `runMultiAgentMappingPipeline`. The orchestrator
 * runs the 4-agent pipeline for ONE (source_table, target_table) pair and
 * produces a final mapping set ready for the existing persistence path
 * (via the Refiner's EMIT_TABLE_MAPPINGS_TOOL output adapted through
 * `synthesizeToolUseResult`).
 */
export interface MultiAgentMappingResult {
  /**
   * Final confirmed mappings after Generator → specialists → Critic →
   * Refiner. Confidence scores come from vote aggregation (95 / 67 / 50).
   */
  confirmed_mappings: CandidateMapping[]
  /** Vote summary for the Generator stage (3 parallel calls). */
  generator_vote_summary: MultiAgentVoteSummary
  /** Vote summary for the Critic stage (3 parallel calls). */
  critic_vote_summary: MultiAgentVoteSummary
  /** Aggregated Critic output the Refiner consumed. */
  critiques: AggregatedCritiques
  /** Sum of all per-agent costs across the pipeline. */
  total_cost_usd: number | null
  /** Total LLM iterations across all agents (sum of agent.iterations). */
  total_iterations: number
  /** llm_calls IDs in order of invocation, for telemetry chain-walking. */
  call_ids: string[]
}

/**
 * Input shape for `runMultiAgentMappingPipeline`. Mirrors the parameters
 * the existing `runSingleAgentMappingLoop` (PR 3.4b extracted helper)
 * takes, so the two-level gate at the production callsites can dispatch
 * cleanly between them.
 */
export interface RunMultiAgentMappingPipelineInput {
  /** Set when invoked from the BULK loop; null for the single-pair callsite. */
  source_table_id: string | null
  source_table_name: string
  /** Per-batch context. The cached prefix lives here. */
  base_user_message: string
  schema_overview_block: string
  business_context: string | null
  /** Plumbed through to the existing `dq_create_target_field_mapping` RPC. */
  project_id: string
  user_id: string
  /** Optional override for the `feature` taxonomy (eval runner uses 'eval_mapping'). */
  feature_override?: string
  /** Per-batch metadata fields to thread into every llm_calls row. */
  base_metadata: Record<string, unknown>
}
