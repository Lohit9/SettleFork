# Phase 3 Archive — Pre Path D Rebuild

**Date:** 2026-05-06
**Branch:** `chore/archive-phase-3-pre-path-d`
**Reason:** consolidate Phase 3 status before the Path D monolithic-call rebuild begins. This document captures the snapshot of what shipped, what's archived, and what carries forward.

> Authoritative reference: [`docs/investigations/path-d-architecture-audit.md`](../investigations/path-d-architecture-audit.md) (commit `9285f0f`).

---

## Phase 3 status snapshot

| Phase                       | Status                                              | Notes                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 Design                  | ✅ Shipped                                          | [`docs/investigations/pr-phase3.1-agent-design.md`](../investigations/pr-phase3.1-agent-design.md) — agent-loop primitive design                                                                                                                       |
| 3.2 Agent loop              | ✅ Shipped                                          | `lib/ai/agent-loop.ts` on main; migration 084 indexes `parent_call_id`                                                                                                                                                                                 |
| 3.3 Data-scanning tools     | ✅ Shipped + incident fix landed                    | `lib/ai/agent-tools.ts` + migration 085. Hotfix `4c5d7d5` (remove unregistered tools from prompt) lands separately.                                                                                                                                    |
| 3.4a Plumbing               | ✅ Shipped                                          | mapping-engine + `ContextScope` + `CallLLMOptions` thinking/output_config                                                                                                                                                                              |
| 3.4b Single-agent adoption  | ✅ Shipped                                          | mapping callsites dispatch to `runAgentLoop` when `AI_PHASE_3_ENABLED=1`; heritage byte-identical when OFF                                                                                                                                             |
| 3.4cd Multi-agent voting    | ✅ Shipped, **default-OFF, slated for deprecation** | `lib/ai/multi-agent-orchestrator.ts`, `multi-agent-prompts.ts`, `multi-agent-types.ts` on main behind `AI_PHASE_3_MULTI_AGENT_ENABLED=0`. Superseded by Path D's monolithic single-call. Code remains pending follow-up removal PR after Path D ships. |
| 3.4e Variance validation    | 🗄️ **Archived (orphaned)**                          | Branch `feat/pr3.4e-voting-variance-fix` (4 commits ahead, behind 21) tagged `inf-3.4e-archived-for-path-d`. Sonnet 4.6 model swap + RLS bypass + telemetry; no longer needed once 3.4cd is deprecated.                                                |
| 3.5 Transform pipeline      | 📝 Designed only                                    | [`docs/investigations/pr3.5-transform-pipeline.md`](../investigations/pr3.5-transform-pipeline.md). No implementation branch. Path D will reshape transform inputs, so 3.5 design is on hold pending Path D output schema.                             |
| 3.6 Validation row sampling | ❌ Not started                                      | No design doc, no branch. Deferred indefinitely behind Path D.                                                                                                                                                                                         |
| 3.7 SSE UX                  | 🟡 Partial — backend only                           | Commit `b3417b2` wired backend streaming via `callLLMStreaming` (server-internal, 32k token budget). Client-facing EventSource / progressive UI **not started**. Path D's 90–180s monolithic call makes client SSE a precondition for rollout.         |
| 3.8 Eval                    | 🟡 Partial — harness exists                         | `lib/eval/runner.ts`, `lib/eval/scorers/`, `tests/eval/` cover mapping + multi-agent voting. No Path D fixtures yet.                                                                                                                                   |

---

## Path C disposition

- **Branch:** `experiment/mapping-two-pass-path-c` (top commit `d33a892`, ahead 2 / behind 3 of main).
- **Action:** archived under tag **`inf-22-phase-c-archive`** at `d33a892`. Branch retained for reference; **not deleted**.
- **Migrations carried forward to Path D:**
  - `supabase/migrations/091_mapping_experiments_view.sql` — view over `llm_calls` keyed by `experiment_run_id` + `experiment_label` (cherry-pick unchanged)
  - `supabase/migrations/092_target_field_mappings_experiment_run_id.sql` — adds `experiment_run_id UUID` column + partial BTREE index + updated `dq_create_target_field_mapping` RPC signature (cherry-pick unchanged)
- **Rewritten for Path D:** two-pass orchestrator (`lib/ai/two-pass-experiment.ts`), per-pass prompts (`lib/ai/two-pass-prompts.ts`), `runSingleAgentMappingLoopTwoPass()` dispatcher in `lib/ai/single-agent-mapping.ts`. Path D is single-pass with structured output; the two-pass control logic does not transfer.
- **Reusable patterns:** `mintExperimentRunId()` UUID-per-click + metadata-tagging shape from `lib/ai/two-pass-experiment.ts` (orthogonal to pass count; lift to Path D).

---

## Multi-agent voting (3.4cd) deprecation rationale

**Current state:** shipped to main behind `AI_PHASE_3_MULTI_AGENT_ENABLED=0`. Default-OFF in production. No active consumers. Voting orchestrator (T0 Generator ×3 → T1 Specialists → T2 Critic ×3 → T3 Refinement) at `lib/ai/multi-agent-orchestrator.ts:133`.

**Why deprecate:**

- Path D's monolithic Opus 4.7 single-call architecture targets the same outcome (higher-quality mappings on hard cases) with a single call instead of a 7+ agent pipeline.
- Empirical signal that triggered Path D: standalone Claude Chat with the same input produced 21 mappings + comprehensive coverage analysis vs. the platform's 8–10. Path C/B/multi-agent all underperformed standalone-chat; Path D collapses the structural overhead.
- 3.4e variance fix (`feat/pr3.4e-voting-variance-fix`) was the gating work for multi-agent rollout. With Path D superseding the architecture, 3.4e is orphaned.
- Cost ceiling on multi-agent (`PER_PAIR_MAX_COST_USD=15.0` at `lib/ai/multi-agent-orchestrator.ts:80-83`) was already a sales-conversation friction point.

**Disposition:**

- Code remains in main behind the default-OFF flag (no production exposure).
- Follow-up removal PR after Path D ships and proves out — removes `lib/ai/multi-agent-orchestrator.ts`, `multi-agent-prompts.ts`, `multi-agent-types.ts`, the `AI_PHASE_3_MULTI_AGENT_ENABLED` dispatch at `lib/actions/mappings.ts:257`, and associated tests/eval fixtures.
- Until then: **do not enable the flag in any environment**, do not extend the multi-agent code path, do not investigate 3.4e variance further.

---

## Reusable for Path D

| Asset                         | Location                                                                         | Status                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent-loop scaffolding (3.2)  | `lib/ai/agent-loop.ts` + migration 084                                           | Reusable. Path D may run as a degenerate single-tool loop or bypass entirely; the primitive stays.                                                                               |
| Data-scanning RPCs (3.3)      | `lib/ai/agent-tools.ts` + `supabase/migrations/085_agent_data_scanning_rpcs.sql` | Reusable. Path D's "let the model investigate" pattern can call these tools directly. Land `fix/remove-unregistered-datascanning-tools` (commit `4c5d7d5`) before Path D begins. |
| `experiment_run_id` apparatus | migrations 091 + 092 (on `experiment/mapping-two-pass-path-c`)                   | Cherry-pick to Path D feature branch unchanged. Provides A/B-eval correlation across mapping runs.                                                                               |
| Eval harness (3.8)            | `lib/eval/runner.ts`, `lib/eval/scorers/`, `tests/eval/`                         | Reusable. Add Path D fixtures keyed to the standalone-Claude-Chat-21-mapping benchmark; compare Path B / Path C / Path D / multi-agent on the same canary corpus.                |
| Heritage test pattern         | `tests/integration/*-heritage.test.ts` (47 test blocks)                          | Reusable. Mirror the pattern with a new `path-d-byte-identical.test.ts` pinning prompt + persistence shape under `AI_PHASE_4_PATH_D_ENABLED=0`.                                  |

---

## What is **not** archived (active)

- **`fix/remove-unregistered-datascanning-tools`** (`4c5d7d5`, ahead 1) — separate concern; lands as its own PR. Required pre-Path D per audit RECOMMENDATION #9.
- **`feat/salesforce-connector`** — outside Phase 3 scope; not affected by this archive.

---

## Follow-up

- INF-27: Investigate PostToolUse hook reformatting repo-wide. Filed during this archive PR after 660-file drift surfaced during Claude Code Write/Edit ops. Not blocking Path D work; track separately.

---

## References

- [`docs/investigations/path-d-architecture-audit.md`](../investigations/path-d-architecture-audit.md) — full audit (sections E + F)
- [`docs/investigations/pr-phase3.1-agent-design.md`](../investigations/pr-phase3.1-agent-design.md) — 3.1 design
- [`docs/investigations/pr3.5-transform-pipeline.md`](../investigations/pr3.5-transform-pipeline.md) — 3.5 design (on hold)
- [`docs/investigations/pr3.4cd-multi-agent-mapping.md`](../investigations/pr3.4cd-multi-agent-mapping.md) — 3.4cd design
- Tags: `inf-22-phase-c-archive`, `inf-3.4e-archived-for-path-d`
