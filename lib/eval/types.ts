/**
 * Phase 1 PR 10 — eval harness type definitions.
 *
 * Shared types for the eval CLI scaffolding (loader / cache / runner /
 * scorers / reporters). Kept dependency-light so non-Node consumers
 * (e.g. CI report rendering) can import shapes without pulling the
 * runtime in.
 *
 * See `tests/eval/datasets/_fixture/` for the on-disk dataset shape.
 */

// ─── Public task vocabulary ───────────────────────────────────────────────────

/**
 * Locked enum mirroring the four Tier 1 tasks from the Phase 1
 * investigation §1. PR 10 ships scorers for `mapping` and
 * `validation-rule` only; the other two are reserved for PR 11.
 */
export type EvalTask = 'mapping' | 'transform' | 'nl-to-sql' | 'validation-rule'

/** Datasets are referenced by directory name under `tests/eval/datasets/`. */
export type DatasetName = string

/**
 * Globally unique example identifier. Convention:
 *   `<datasetName>/<task>/<filename without extension>`
 * e.g. `netsuite-rootstock/mapping/001-customer-pair`
 */
export type EvalExampleId = string

// ─── On-disk shapes (matched by `lib/eval/loader.ts`) ─────────────────────────

/** Top-level metadata file: `<dataset>/metadata.json`. */
export interface DatasetMetadata {
  /** Stable name; should equal the directory name. */
  name: string
  /** Human-readable description for reports. */
  description: string
  /** Free-form version tag — bump when gold labels are revised. */
  version: string
  /** Author handle for traceability. */
  author: string
  /** When the dataset was created or last revised. */
  updatedAt: string
}

/**
 * Lightweight schema description used to drive synthetic-context
 * insertion (PR 10.4) and to render dataset summaries. Mirrors the
 * shape the production `dq_create_target_field_mapping` RPC expects
 * but flattened for human authoring.
 */
export interface SchemaShape {
  tables: SchemaTable[]
}

export interface SchemaTable {
  name: string
  fields: SchemaField[]
}

export interface SchemaField {
  name: string
  data_type: string
  is_nullable: boolean
  is_primary_key?: boolean
  is_foreign_key?: boolean
  description?: string
}

/** Top-level schema file: `<dataset>/schema.json`. */
export interface DatasetSchema {
  source: SchemaShape
  target: SchemaShape
}

/**
 * One example file: `<dataset>/examples/<task>/<id>.json`.
 *
 * `input` and `gold` shapes are task-specific; the loader does not
 * validate their internal shape. Per-task scorers (PR 10.2 / PR 10.3)
 * own their own schema validation.
 */
export interface EvalExample {
  id: EvalExampleId
  task: EvalTask
  input: Record<string, unknown>
  gold: Record<string, unknown>
  metadata: ExampleMetadata
}

export interface ExampleMetadata {
  author: string
  reviewedBy?: string
  difficulty: 'easy' | 'medium' | 'hard'
  /**
   * Free-form notes about the gold label — alternative interpretations
   * considered, doc references, etc. Required when difficulty is
   * 'hard' to keep reviewers oriented.
   */
  notes?: string
}

/** Loader return shape — bundles schema + examples + metadata. */
export interface LoadedDataset {
  name: DatasetName
  metadata: DatasetMetadata
  schema: DatasetSchema
  /** Examples grouped by task. Empty arrays for tasks with no examples. */
  examples: Record<EvalTask, EvalExample[]>
}

// ─── Scoring shapes ───────────────────────────────────────────────────────────

/**
 * Per-example score from a single scorer. Multiple scorers may run on
 * one example (e.g. mapping has fieldPair, combinationType, and
 * many-to-one collapse scorers per the investigation §3.1).
 */
export interface ScoreResult {
  exampleId: EvalExampleId
  scorerName: string
  /** Bounded to [0, 1]. Per-scorer interpretation of partial credit. */
  score: number
  /** Scorer-specific breakdown (matched/missed/extra counts, axis flags, etc.). */
  details: Record<string, unknown>
  /** True if the AI output couldn't be parsed or the scorer threw. */
  errored: boolean
  errorMessage?: string
}

/** Aggregated stats for one (task, scorer) tuple across a dataset. */
export interface ScoreSummary {
  mean: number
  count: number
  min: number
  max: number
  errorCount: number
}

/** Aggregated metrics for one (dataset, task) pair. */
export interface DatasetMetrics {
  dataset: DatasetName
  task: EvalTask
  examples: number
  /** Map of scorer name → summary. */
  scorers: Record<string, ScoreSummary>
  costUsd: number
  durationMs: number
  /** How many examples hit the llm_calls cache and skipped a real API call. */
  cachedCount: number
}

/** Full output of a `pnpm eval` invocation. Persisted to the baseline JSON. */
export interface EvalRunOutput {
  /** ISO timestamp at run start. */
  runId: string
  branch: string
  commitSha: string
  model: string
  smoke: boolean
  datasets: DatasetMetrics[]
  totalCostUsd: number
  totalDurationMs: number
  totalCachedCount: number
}
