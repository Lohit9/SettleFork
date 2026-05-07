/**
 * Experiment-run helpers for `mapping_generate` A/B comparison telemetry.
 *
 * ── What this module does ──────────────────────────────────────────────────
 * - Mints a per-click UUID (`mintExperimentRunId`) that callsites attach to
 *   every `llm_calls` row + every `target_field_mappings` row produced by a
 *   single "Generate Mappings" click. The shared ID lets downstream views
 *   group rows from the same run for cost / latency / accuracy aggregation.
 * - Builds JSONB metadata fragments (`pathBExperimentMetadata`,
 *   `pathDExperimentMetadata`) that callsites spread into the
 *   `llm_calls.metadata` JSONB column at insert time. The actual write
 *   target is `llm_calls.metadata` — the analyst-facing
 *   `mapping_experiments` VIEW (migration 091) materializes its rows
 *   FROM `llm_calls` by extracting `metadata ->> 'experiment_label'`,
 *   `metadata ->> 'experiment_run_id'`, etc. So this module's job is
 *   shaping the JSONB fragment correctly; the view does the rest.
 *
 * ── Schema source (already on main, cherry-picked via PR #85) ──────────────
 * - Migration 091 (`mapping_experiments` view): per-llm-call surface for
 *   cost / latency / token telemetry, grouped by `experiment_run_id`.
 *   Comment in 091 explicitly notes: *"`experiment_label` is text (not enum)
 *   so adding `path_d_*` for a future variant is a writer-side change with
 *   no migration."* — Path D's `'path_d'` label below requires zero
 *   schema work.
 * - Migration 092 (`target_field_mappings.experiment_run_id` UUID column +
 *   5-arg `dq_create_target_field_mapping` RPC): persists the same UUID on
 *   the resulting TFM rows so analysts can JOIN llm_calls → TFMs without
 *   a fragile timestamp-window heuristic. Sub-PR 4's Path D core passes
 *   the run ID as the 5th positional arg (`p_experiment_run_id`).
 * - Migration 092 also defines `mapping_experiment_results` view: per-TFM
 *   surface joining `experiment_label` from `llm_calls` for accuracy /
 *   confidence aggregation per run.
 *
 * ── Path neutrality (Sub-PR 3 framing) ─────────────────────────────────────
 * Originally extracted from `lib/ai/two-pass-experiment.ts` on the
 * `experiment/mapping-two-pass-path-c` branch (INF-22). That file kept
 * Path-C-specific helpers (`twoPassEnabled`, `pathCPass1Metadata`,
 * `pathCPass2Metadata`); this module hosts only the path-neutral pieces
 * plus the new Path D variant. Path B (production today) and Path D
 * (Sub-PR 4 onward) both consume from here. Path C (experiment-only) keeps
 * its specific helpers on the experiment branch.
 *
 * ── Module is inert until Sub-PR 4 imports it ──────────────────────────────
 * No production callsite uses these exports yet. Sub-PR 4 (Path D core)
 * is the first consumer; Path B's existing callsites can adopt
 * `pathBExperimentMetadata` opportunistically as a follow-up to surface
 * Path B telemetry in the same `mapping_experiments` view (currently Path B
 * runs don't carry the metadata fields and are filtered out of the view by
 * its `WHERE c.metadata ->> 'experiment_run_id' IS NOT NULL` clause).
 */

import { randomUUID } from 'node:crypto'
import {
  PATH_D_MAX_OUTPUT_TOKENS,
  PATH_D_MONOLITHIC_THRESHOLD,
  PER_PROJECT_MAX_COST_USD,
} from '@/lib/ai/path-d-config'

// ── Discriminated label union for `llm_calls.metadata.experiment_label` ────
//
// Surface contract referenced by:
//   - `mapping_experiments` view (migration 091 — text column, no DB enum)
//   - `mapping_experiment_results` view (migration 092 — read-only join)
//   - any future analyst SQL that joins llm_calls on this column
//
// Path C labels (`'path_c_pass_1'`, `'path_c_pass_2'`) live ONLY on the
// `experiment/mapping-two-pass-path-c` branch and are intentionally absent
// here — Sub-PR 3 hosts only path-neutral helpers + the new Path D variant.
//
// If a future PR re-merges Path C semantics, extend this union; the view's
// text column accepts any string with no migration.
export type ExperimentLabel = 'path_b' | 'path_d'

/**
 * Mint a fresh experiment-run UUID. Called once per "Generate Mappings"
 * click at the BULK + single-pair entry points; the same ID is then
 * propagated through every per-batch / per-pair LLM call AND through the
 * 5th positional arg of `dq_create_target_field_mapping` (migration 092)
 * so the resulting TFM rows carry the same ID.
 *
 * Output is a UUID v4 string. The DB stores it as `UUID` on TFMs (column
 * type from migration 092) and as text inside `llm_calls.metadata` JSONB
 * (cast to UUID at view query time per migration 091's `(c.metadata->>'experiment_run_id')::uuid`).
 */
export function mintExperimentRunId(): string {
  return randomUUID()
}

/**
 * Build the JSONB metadata fragment that `llm_calls` rows carry for Path B
 * runs. Callsites spread this into their existing baseMetadata object
 * alongside `agent_loop`, `source_table_id`, etc., before inserting the
 * `llm_calls` row.
 *
 * Pure function; never reads env vars. Symmetric with `pathDExperimentMetadata`
 * to keep the analyst surface uniform on the per-llm-call axis (additional
 * Path-D-specific config fields appear only on Path D rows; Path B rows
 * carry just the 2 baseline fields).
 */
export function pathBExperimentMetadata(experimentRunId: string): {
  experiment_label: ExperimentLabel
  experiment_run_id: string
} {
  return {
    experiment_label: 'path_b',
    experiment_run_id: experimentRunId,
  }
}

/**
 * Build the JSONB metadata fragment that `llm_calls` rows carry for Path D
 * runs. Carries the run ID + label PLUS a snapshot of the Path D config
 * values active at run time (token budget, monolithic threshold, cost
 * ceiling). The snapshot is critical for empirical analysis: if config
 * changes between runs (e.g., `AI_MAPPING_PATH_D_MAX_OUTPUT_TOKENS`
 * env override is bumped from 48k → 64k), an analyst comparing runs needs
 * to see what config was active when each run executed. Top-level
 * `llm_calls` columns capture model + prompt_version but NOT
 * Path D-specific config; the snapshot here closes that gap.
 *
 * Values are read from `@/lib/ai/path-d-config` exports at call time, so
 * the snapshot reflects env-overridden values rather than hardcoded
 * defaults.
 *
 * Pure function — but does read module-level constants from path-d-config,
 * which themselves resolve env vars at module-load time. Re-evaluating with
 * different env values within the same process requires `vi.resetModules()`
 * (matches the pattern used in tests for env-gated helpers elsewhere).
 */
export function pathDExperimentMetadata(experimentRunId: string): {
  experiment_label: ExperimentLabel
  experiment_run_id: string
  max_output_tokens: number
  monolithic_threshold: number
  max_cost_usd: number
} {
  return {
    experiment_label: 'path_d',
    experiment_run_id: experimentRunId,
    max_output_tokens: PATH_D_MAX_OUTPUT_TOKENS,
    monolithic_threshold: PATH_D_MONOLITHIC_THRESHOLD,
    max_cost_usd: PER_PROJECT_MAX_COST_USD,
  }
}
