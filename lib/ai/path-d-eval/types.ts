/**
 * Path D eval framework — type definitions.
 *
 * Sub-PR 6 ships a parallel eval framework at `lib/ai/path-d-eval/`
 * (separate from Phase 1's `lib/eval/`) because Path D's monolithic
 * streaming-call shape doesn't fit the existing per-example "short
 * call → score" model. INF-39 tracks the consolidation question for
 * post-Phase-C reconsideration.
 *
 * ── Conceptual model ───────────────────────────────────────────────────────
 *
 *   Fixture        — directory with source-schema, target-schema,
 *                    sample-data, business-context, and expected-output.
 *                    A self-contained eval scenario.
 *   Trial          — one Path D run against one fixture. ~$0.40-$0.80 each.
 *   Run            — N trials × M fixtures. Aggregates per-fixture and
 *                    overall.
 *
 * ── Eight scoring dimensions ───────────────────────────────────────────────
 *
 *   1. mapping_accuracy        F1 over (target_field_id, set(source_field_ids))
 *   2. combination_type        Per-matched-mapping accuracy on combination_type
 *   3. coverage_completeness   F1 over (target_field_id, coverage_status)
 *   4. decision_recall         Recall over expected decision_type values
 *   5. lookup_recall           Recall over expected lookup-table names
 *   6. dq_recall               Recall over expected (source_field_id, category)
 *   7. inferred_targets_recall Recall over expected inferred_target_object names
 *   8. output_completeness     Fraction of 7 sections persisted/parsed cleanly
 *
 * Weights default to:
 *   mapping_accuracy=0.25, combination_type=0.10, coverage_completeness=0.20,
 *   decision_recall=0.10, lookup_recall=0.10, dq_recall=0.10,
 *   inferred_targets_recall=0.05, output_completeness=0.10.
 *
 * Recall-only dimensions (decision_recall, lookup_recall, dq_recall,
 * inferred_targets_recall) intentionally don't penalise the AI for
 * surfacing extras — Path D's value is partly in raising judgment
 * opportunities the customer didn't think to flag. Precision-side
 * scoring would punish exactly the behaviour we want to encourage.
 *
 * Phase C will tune weights empirically.
 */

import type { PathDParsedOutput } from '@/lib/ai/path-d-parser'

// ── Fixture on-disk shapes ─────────────────────────────────────────────────

/**
 * Schema description used to drive synthetic project fixtures. Mirrors
 * the shape `buildAIContext` returns but flattened for hand-authoring.
 * Each `field.id` is a UUID the fixture commits to; the eval runner
 * uses these IDs verbatim as `target_field_id` / `source_field_id`
 * values when comparing against expected output.
 */
export interface EvalFixtureSchema {
  tables: EvalFixtureTable[]
}

export interface EvalFixtureTable {
  id: string
  name: string
  fields: EvalFixtureField[]
}

export interface EvalFixtureField {
  id: string
  name: string
  data_type: string
  is_nullable?: boolean
  is_primary_key?: boolean
  is_foreign_key?: boolean
  fk_reference?: string
  description?: string
}

/**
 * Sample-data shape used to inject realistic values into the prompt's
 * value_distribution / sample_values surface. Keys are field IDs;
 * values are arrays of `{value, count}` tuples (matching what the
 * orchestrator would otherwise pull from `field_profiles`).
 */
export interface EvalFixtureSampleData {
  [fieldId: string]: Array<{ value: string; count: number }>
}

/**
 * The expected (gold-standard) Path D output. Each section is the
 * authoritative answer for the fixture; the scorer compares the
 * orchestrator's actual output against this.
 *
 * NOT a full mirror of `PathDParsedOutput` — only the fields the
 * scorer reads. Free-text fields (`ai_reasoning`, `transformation_intent`,
 * `description`) are intentionally absent because the scorer doesn't
 * grade them.
 */
export interface ExpectedPathDOutput {
  mappings: ExpectedMapping[]
  coverage: ExpectedCoverageEntry[]
  decisions: ExpectedDecision[]
  lookup_tables: ExpectedLookupTable[]
  data_quality: ExpectedDataQualityFinding[]
  inferred_targets: ExpectedInferredTarget[]
  /**
   * Whether project_notes is expected to be present (almost always
   * `true` for Path D fixtures). The scorer doesn't grade markdown
   * content, only presence.
   */
  project_notes_expected: boolean
}

export interface ExpectedMapping {
  target_field_id: string
  source_field_ids: string[]
  combination_type: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql'
}

export interface ExpectedCoverageEntry {
  target_field_id: string
  coverage_status: 'covered' | 'partial' | 'gap' | 'optional' | 'out_of_scope'
}

export interface ExpectedDecision {
  /**
   * Short tag matching the AI's emitted `decision_type`. Match is
   * case-insensitive exact-string. Multiple expected decisions may
   * share the same type (the scorer counts the unique set).
   */
  decision_type: string
}

export interface ExpectedLookupTable {
  /** Match is case-insensitive exact-string on the AI's emitted `name`. */
  name: string
}

export interface ExpectedDataQualityFinding {
  /**
   * Either a specific source field id (per-field finding) or `null`
   * for cross-field findings. Match pairs (source_field_id, category)
   * exactly.
   */
  source_field_id: string | null
  category: string
}

export interface ExpectedInferredTarget {
  /** Case-insensitive exact-string match on `inferred_target_object`. */
  inferred_target_object: string
}

/**
 * Top-level fixture descriptor. Loaded by the runner from the fixture
 * directory's `metadata.json` (or composed from individual files —
 * runner picks the layout).
 */
export interface EvalFixture {
  /** Stable name; equals the fixture directory name. */
  name: string
  description: string
  /** Whether this fixture is opt-out — used to skip slow ones in CI. */
  skip?: boolean
  source: EvalFixtureSchema
  target: EvalFixtureSchema
  /** Per-field-id → sample values. Optional; defaults to empty object. */
  sample_data: EvalFixtureSampleData
  /** Free-form markdown describing the migration scenario. */
  business_context: string
  /** INF-41: optional pre-formatted migration intelligence block. Populated
   *  by `loadFixture` when `intelligence-context.md` is present in the
   *  fixture directory. Empty string when absent (preserves the v0
   *  intelligence-OFF baseline shape for legacy fixtures). The runner
   *  passes this through to `ctx.intelligence_context` so the resulting
   *  Path D prompt exercises the intelligence-ON path. */
  intelligence_context: string
  expected: ExpectedPathDOutput
}

// ── Score shapes ───────────────────────────────────────────────────────────

/**
 * Per-dimension score entry. `score` is bounded to [0, 1]. `details`
 * is dimension-specific breakdown for diagnostic surfacing in the
 * console + JSON reports — never load-bearing for the aggregate.
 */
export interface DimensionScore {
  score: number
  details: Record<string, unknown>
}

export type EvalDimensionKey =
  | 'mapping_accuracy'
  | 'combination_type'
  | 'coverage_completeness'
  | 'decision_recall'
  | 'lookup_recall'
  | 'dq_recall'
  | 'inferred_targets_recall'
  | 'output_completeness'

/**
 * Default weights summing to 1.00. The scorer accepts caller-provided
 * weights to support Phase C calibration experiments.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<EvalDimensionKey, number>> = {
  mapping_accuracy: 0.25,
  combination_type: 0.10,
  coverage_completeness: 0.20,
  decision_recall: 0.10,
  lookup_recall: 0.10,
  dq_recall: 0.10,
  inferred_targets_recall: 0.05,
  output_completeness: 0.10,
}

/** Mutable map for test/runner overrides. Pass to `scorePathDOutput`. */
export type EvalWeights = Record<EvalDimensionKey, number>

/**
 * Score for one trial against one fixture. The aggregate is the
 * weighted sum of `dimensions[k].score × weights[k]`.
 */
export interface EvalScore {
  /** Per-dimension scores in [0, 1]. */
  dimensions: Record<EvalDimensionKey, DimensionScore>
  /** Weighted aggregate in [0, 1]. */
  aggregate: number
  /** Effective weights used for the aggregate (after any caller override). */
  weights: EvalWeights
}

// ── Run-level shapes ───────────────────────────────────────────────────────

/**
 * Per-fixture trial result. One TrialResult per (fixture × trial)
 * combination. Aggregated into `FixtureSummary`.
 */
export interface TrialResult {
  fixtureName: string
  trialIndex: number // 0-based
  runId: string
  costUsd: number | null
  durationMs: number
  score: EvalScore
  /**
   * Set when the orchestrator threw or returned `success: false`. The
   * trial still gets a `score` (with all dimensions = 0 typically),
   * but reports surface this flag so callers know to discount the
   * trial in mean computations.
   */
  errored: boolean
  errorMessage?: string
}

/**
 * Aggregated stats across N trials of one fixture. `aggregateMean` is
 * the headline number; `min/max/stddev` capture variance for callers
 * comparing prompt versions across multiple trials.
 */
export interface FixtureSummary {
  fixtureName: string
  trials: TrialResult[]
  aggregateMean: number
  aggregateMin: number
  aggregateMax: number
  aggregateStddev: number
  /** Per-dimension mean across the trials. */
  perDimensionMean: Record<EvalDimensionKey, number>
  /** Sum of trial costs (null when any trial's cost was unknown). */
  totalCostUsd: number | null
}

/**
 * Top-level eval-run report. One per `pnpm test:integration path-d-eval-runner`
 * invocation. Persisted to JSON when `PATH_D_EVAL_JSON_OUT` is set.
 */
export interface EvalRunReport {
  /** ISO timestamp at run start. */
  startedAt: string
  trialsPerFixture: number
  /** Subset of fixtures actually run (after PATH_D_EVAL_FIXTURE filter). */
  fixtureSummaries: FixtureSummary[]
  /** Mean of fixtureSummaries' aggregateMean values. */
  overallMean: number
  /** Sum of all trial costs across all fixtures (null if any unknown). */
  totalCostUsd: number | null
  totalDurationMs: number
  weights: EvalWeights
}

// ── Type re-exports ────────────────────────────────────────────────────────

export type { PathDParsedOutput }
