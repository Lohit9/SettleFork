/**
 * Path D — Monolithic Mapping Architecture Configuration
 *
 * Constants governing Path D's single-call comprehensive-output architecture
 * (mappings + coverage + decisions + lookup_tables + data_quality +
 * inferred_targets + project_notes in one Opus 4.7 streaming call).
 *
 * See `docs/investigations/path-d-token-budget-audit.md` for the empirical
 * derivation of these values + the Phase C sharding deferral rationale.
 *
 * Path D is gated by `AI_MAPPING_PATH_D_ENABLED` (Sub-PR 4). When disabled
 * (default), the production Path B pipeline runs unchanged. The constants in
 * this file are inert until Sub-PR 4 imports them.
 *
 * ── Pattern note ────────────────────────────────────────────────────────────
 * This module establishes a NEW cost-ceiling pattern for Path D — exported +
 * env-overridable — distinct from the multi-agent module's module-private
 * hardcoded constants at `lib/ai/multi-agent-orchestrator.ts:75-81`. Path D
 * needs both deviations: Sub-PR 4 must `import` these (so export is required),
 * and per-deployment cost tuning is a stated Phase B requirement (so env
 * override is required). The multi-agent constants are intentionally not
 * changed by this PR.
 */

const parseOptionalNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Maximum output tokens for the Path D monolithic call. Higher than Path B's
 * 32k to accommodate the comprehensive output (7 sections vs Path B's single
 * `emit_table_mappings` tool input). Sits comfortably below Anthropic's
 * documented 64k+ output ceiling on Opus 4.7 streaming.
 *
 * Empirically projected: ~45k tokens at the 350-field threshold (see audit
 * doc). 48k provides a thin margin to keep over-threshold projects honestly
 * routed to `ProjectTooLargeError` rather than silently consuming the 64k
 * headroom. Revisit with first 5 production runs.
 *
 * Env override: `AI_MAPPING_PATH_D_MAX_OUTPUT_TOKENS`.
 */
export const PATH_D_MAX_OUTPUT_TOKENS = parseOptionalNumberEnv(
  "AI_MAPPING_PATH_D_MAX_OUTPUT_TOKENS",
  48000,
);

/**
 * Maximum target field count for monolithic Path D. Above this, the Sub-PR 4
 * server action throws `ProjectTooLargeError` until Phase C sharding lands.
 * Conservative default based on token-budget math (350 target fields →
 * ~45k output, fits 48k budget with margin).
 *
 * Raise after empirical validation only — the threshold protects the 48k
 * output budget from overrun.
 *
 * Env override: `AI_MAPPING_PATH_D_MONOLITHIC_THRESHOLD`.
 */
export const PATH_D_MONOLITHIC_THRESHOLD = parseOptionalNumberEnv(
  "AI_MAPPING_PATH_D_MONOLITHIC_THRESHOLD",
  350,
);

/**
 * Per-project cost ceiling for a single Path D run. Pre-call gate (Sub-PR 4)
 * computes predicted cost from estimated input + output tokens; aborts before
 * opening the Anthropic stream if exceeded. Post-call enforcement during
 * streaming tracks rolling `usage.output_tokens` and aborts if cumulative
 * cost exceeds the ceiling, persisting partial state.
 *
 * Defaults to $25 (POC ~$2.40 → 10× headroom; mid-market threshold $4.60 →
 * 5× headroom). Env override: `AI_MAPPING_PATH_D_MAX_COST_USD`.
 */
export const PER_PROJECT_MAX_COST_USD = parseOptionalNumberEnv(
  "AI_MAPPING_PATH_D_MAX_COST_USD",
  25.0,
);

/**
 * Thrown by the Sub-PR 4 server action when a project's target-field count
 * exceeds `PATH_D_MONOLITHIC_THRESHOLD`. Phase C sharding will lift this
 * limit; until then the caller surfaces the error message to the UI verbatim.
 */
export class ProjectTooLargeError extends Error {
  constructor(
    public readonly targetFieldCount: number,
    public readonly threshold: number = PATH_D_MONOLITHIC_THRESHOLD,
  ) {
    super(
      `Project has ${targetFieldCount} target fields, exceeding the Path D monolithic threshold of ${threshold}. ` +
        `Sharded mapping path (Phase C) not yet available. Contact support to enable enterprise mode.`,
    );
    this.name = "ProjectTooLargeError";
  }
}
