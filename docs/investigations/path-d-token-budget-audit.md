# Path D Token Budget Audit

**Status:** Decision lock (Sub-PR 1 of Phase B Path D core)
**Date:** 2026-05-06
**Author:** Claude Code session
**Branch when authored:** `feat/path-d-config-and-budget-audit`
**Decision:** 48k output budget + 350-target-field monolithic threshold + sharded path deferred to Phase C
**Replaces / updates:** Phase B Path D Core Architecture Investigation (RISK #7 from [path-d-architecture-audit.md](./path-d-architecture-audit.md))

> **Why this is foundational:** Path D's promise of "single monolithic Opus 4.7 call producing comprehensive output" depends on the call physically fitting under Anthropic's `max_tokens` ceiling AND under a customer-acceptable per-click cost. This document encodes the empirical envelope and the architectural fall-back (Phase C sharding) for projects that exceed it.

---

## DIVERGENCE callouts (load-bearing — read first)

1. **Path D output budget is HIGHER than Path B's.** Path B uses `PER_BATCH_MAX_TOKENS = 32000` per per-table-mapping batch. Path D uses 48k for a single project-wide call. Both are per-callsite values — Path B's 32k is unchanged by this PR.

2. **Monolithic ⇄ sharded threshold is 350 target fields, NOT a hardcoded customer-tier proxy.** Below this, monolithic Path D runs. Above this, the call short-circuits with `ProjectTooLargeError` (no implicit shard fallback in Phase B). Phase C will add the sharded path; until then enterprise-scale projects need explicit support routing.

3. **Cost-ceiling pattern in this PR is NEW, not a mirror of multi-agent's.** The existing `PER_PAIR_MAX_COST_USD = 15.0` in [lib/ai/multi-agent-orchestrator.ts:81](../../lib/ai/multi-agent-orchestrator.ts) is module-private + hardcoded. Path D's `PER_PROJECT_MAX_COST_USD = 25.0` is **exported** (Sub-PR 4 imports it) AND **env-overridable** via `AI_MAPPING_PATH_D_MAX_COST_USD` (per-deployment tuning is a stated Phase B requirement). This establishes a new pattern; the multi-agent constants are not changed by this PR.

4. **Constants are inert until Sub-PR 4 imports them.** Sub-PR 1 only adds the audit doc + a config module + an error class. Path B production behavior is unchanged. No new tests; existing suite must hold the baseline.

---

## Opus 4.7 limits

- **Input context:** 200,000 tokens (Anthropic public spec for Claude Opus 4.x family)
- **Output `max_tokens`:** 64k+ via streaming. Codebase comment at [lib/ai/mapping-engine.ts:1583-1586](../../lib/ai/mapping-engine.ts) reads:

  > _"32k stays inside Anthropic Sonnet 4.6 / Opus 4.7 max_tokens limits (64k+)."_

  48k for Path D sits comfortably below this ceiling.

- **Pricing (approximate, Opus 4.7):** $15 / 1M input tokens, $75 / 1M output tokens. Used for cost-ceiling math below.
- **Streaming requirement:** non-streaming requests rejected by Anthropic when `max_tokens > ~10K`. Path D must use `callLLMStreaming`.

---

## Path B baseline (unchanged by this PR)

| Constant                       | Value                                            | Location                                                                                                                      |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `PER_BATCH_MAX_TOKENS`         | 32000                                            | [lib/actions/mappings.ts:241](../../lib/actions/mappings.ts), [lib/ai/mapping-engine.ts:1587](../../lib/ai/mapping-engine.ts) |
| `DEFAULT_STREAMING_MAX_TOKENS` | 32000                                            | [lib/ai/llm-client.ts:227](../../lib/ai/llm-client.ts)                                                                        |
| Per-callsite override          | Yes — via `opts.maxTokens` to `callLLMStreaming` | [lib/ai/llm-client.ts:763](../../lib/ai/llm-client.ts)                                                                        |

Path B continues to use 32k per-batch. The Path D 48k value lives only at Path D's callsite (Sub-PR 4), passed via `opts.maxTokens`.

---

## Path D token estimates

### Rootstock POC scale (163 target fields, 150 source fields)

| Component                                                   | Direction | Tokens                                                                    |
| ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| 8 doc files + business context                              | input     | ~5k                                                                       |
| 163 target field shapes (name, type, FK, etc.)              | input     | ~8k                                                                       |
| 150 source field shapes                                     | input     | ~7.5k                                                                     |
| Per-field samples (50 vals × ~100 tok × 150 fields, capped) | input     | ~30k                                                                      |
| **Input total**                                             |           | **~50k** (well under 200k context window)                                 |
| 21 mappings × ~200 tok                                      | output    | ~4.2k                                                                     |
| 163 coverage entries × ~80 tok                              | output    | ~13k                                                                      |
| 5 decisions × ~300 tok                                      | output    | ~1.5k                                                                     |
| 2 lookup tables × ~500 tok                                  | output    | ~1k                                                                       |
| ~10 DQ findings × ~150 tok                                  | output    | ~1.5k                                                                     |
| Project notes (markdown)                                    | output    | ~1k                                                                       |
| **Output total**                                            |           | **~22k** (within 32k Path B budget; comfortably within 48k Path D budget) |

**Per-click cost (POC, monolithic):** input 50k × $15/M = $0.75 + output 22k × $75/M = $1.65 → **~$2.40 / click**.

Verdict: ✅ POC fits monolithic Path D with margin.

### Mid-market threshold (~350 target fields)

| Component                                                             | Direction | Tokens                                             |
| --------------------------------------------------------------------- | --------- | -------------------------------------------------- |
| Schema + 350 target field shapes + ~300 source field shapes + samples | input     | ~80k                                               |
| Coverage entries: 350 × 80                                            | output    | ~28k                                               |
| Mappings: ~50 × 200 (sparse coverage assumption)                      | output    | ~10k                                               |
| Decisions / lookup_tables / DQ / inferred_targets / project_notes     | output    | ~7k flat                                           |
| **Output total**                                                      |           | **~45k** — fits within 48k budget with thin margin |

**Per-click cost (threshold):** input 80k × $15/M = $1.20 + output 45k × $75/M = $3.38 → **~$4.60 / click**.

Verdict: ✅ Mid-market fits at the threshold edge. Margin is intentionally thin so projects above 350 hit the `ProjectTooLargeError` rather than silently consuming the 48k → 64k headroom.

### Enterprise scale (10k tables per CLAUDE.md §1, ~100k target fields)

- Coverage entries alone: 100,000 × 80 tokens = **8M output tokens** — physically impossible in any single Anthropic call.
- Input alone (target field shapes + source samples) would exceed the 200k context window.

Verdict: ❌ Monolithic architecturally infeasible at enterprise scale. **Sharded path required (deferred to Phase C).** Until Phase C ships, projects with > 350 target fields throw `ProjectTooLargeError` with an actionable message.

---

## Decisions

### 1. `PATH_D_MAX_OUTPUT_TOKENS = 48000`

- Bumps Path B's 32k to give Path D headroom for its comprehensive output (mappings + coverage + decisions + lookup_tables + data_quality + inferred_targets + project_notes — 7 sections vs Path B's single `emit_table_mappings` tool input).
- Path B's `PER_BATCH_MAX_TOKENS = 32000` is unchanged.
- Rationale: Path D is one call vs Path B's many; per-call output ceiling matters more.
- Env override: `AI_MAPPING_PATH_D_MAX_OUTPUT_TOKENS`.

### 2. `PATH_D_MONOLITHIC_THRESHOLD = 350` (target fields)

- Maps to ~45k output (per the mid-market estimate above), fitting the 48k budget with margin.
- Conservative; can be raised post-empirical-test if Opus 4.7 produces less output than projected on first 5 production runs.
- Above threshold: throw `ProjectTooLargeError` (defined in `lib/ai/path-d-config.ts`) with a "contact support to enable enterprise mode" message — surfaced verbatim in the Sub-PR 4 server action.
- Env override: `AI_MAPPING_PATH_D_MONOLITHIC_THRESHOLD`.

### 3. `PER_PROJECT_MAX_COST_USD = 25.0`

- POC at $2.40 / click → 10× headroom.
- Mid-market threshold at $4.60 / click → 5× headroom.
- Above the ceiling: pre-call estimate fails fast (Sub-PR 4) before opening the Anthropic stream; post-call enforcement aborts the stream if rolling cost exceeds the ceiling, persisting partial state.
- Env override: `AI_MAPPING_PATH_D_MAX_COST_USD`.
- **Pattern note:** new pattern in this PR — exported + env-overridable. Distinct from the multi-agent module's hardcoded module-private constants ([multi-agent-orchestrator.ts:75-81](../../lib/ai/multi-agent-orchestrator.ts)). Multi-agent constants are not changed.

### 4. Sharded path deferred to Phase C

- Phase B serves POC + mid-market via monolithic only.
- Enterprise (> 350 target fields) waits until Phase C ships per-table-mapping sharding + cross-batch aggregator.
- This keeps Phase B's risk surface bounded; the sharded design is a meaningful architectural increment that deserves its own investigation.

---

## Open follow-ups

- **Empirical validation** — measure actual output token counts on first 5 Path D runs against the Rootstock POC. If reality consistently undershoots projections, raise `PATH_D_MONOLITHIC_THRESHOLD` (e.g., 350 → 450). If over, lower it.
- **Phase C sharding design** — separate investigation triggered when threshold becomes a customer-blocker. Likely shape: per-table-mapping batches (Path B-style) + a final aggregator call producing project-level coverage / decisions / inferred_targets / project_notes.
- **Per-deployment cost ceiling tuning** — post-pilot, set `AI_MAPPING_PATH_D_MAX_COST_USD` per environment if pricing tier matters.
- **Pricing-rate updates** — Anthropic pricing was hardcoded into the math above. If Opus 4.7 pricing changes, the cost-projection numbers in this doc need a refresh; the constant itself is durable.

---

## References

- [path-d-architecture-audit.md](./path-d-architecture-audit.md) — RISK #7 (token budget), RECOMMENDATION #11 (cost ceiling)
- Phase B Path D Core Architecture Investigation — Stop 1 findings, 2026-05-06 (in-conversation)
- [lib/ai/multi-agent-orchestrator.ts:75-81](../../lib/ai/multi-agent-orchestrator.ts) — sibling cost-ceiling pattern (module-private + hardcoded; intentionally not adopted here)
- [lib/ai/llm-client.ts:227](../../lib/ai/llm-client.ts) — `DEFAULT_STREAMING_MAX_TOKENS = 32000`
- [lib/ai/mapping-engine.ts:1583-1586](../../lib/ai/mapping-engine.ts) — Anthropic max_tokens ceiling comment
