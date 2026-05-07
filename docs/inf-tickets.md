# INF Tickets

Internal infrastructure tickets — tracked as a single markdown file alongside the code.
Append-only. Update status in-place as work lands.

**Status legend:** OPEN · IN_PROGRESS · CLOSED · DUPLICATE

**Conventions:**

- Each ticket has a number, title, status, filed date, description, code references where applicable, acceptance criteria, and closing PR/commit if closed.
- Code comments referencing "INF-X" should match a ticket here.
- Numbers are sequential and not reused. Gaps are intentional (deferred or duplicate).

---

## INF-2 — Merge parallel `*__c` and `*_external_id` target fields

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
When uploading a target Salesforce/Rootstock CSV plus its `.docx` schema doc, the schema is captured twice: once as CSV-derived `*_external_id` import-format fields, and once as doc-enriched `*__c` Salesforce-object fields. These describe the same logical field but appear as two distinct target fields, inflating the unmapped count and confusing the AI on cross-table mapping decisions.

**Acceptance criteria:**

- Schema ingestion merges parallel fields into one target field with both representations preserved as metadata.
- Mapping page shows one row per logical target field, not two.
- Heritage byte-identical for projects without parallel fields.

**Related:** Surfaces in any Salesforce-style target ingestion (Rootstock POC, Mitratech upcoming).

---

## INF-5 — Selectively re-enable cache_control after 4-block limit unblock

**Status:** OPEN
**Filed:** 2026-04 (back-filled from code comments)
**Description:**
PR-CACHE-HOTFIX disabled `cache_control` across 8 callsites to unblock the Anthropic 4-block limit error in production. Re-enable selectively on callsites where the cost benefit (prompt caching ~62% input-token reduction on cache hits) justifies the added complexity.

**Code references:**

- `lib/parsers/ddl-parser.ts:410`
- `lib/quality/fix-engine.ts:495`
- `lib/ai/mapping-engine.ts:1661, 1683, 1729`
- `lib/actions/validation-rules.ts:411`
- `lib/actions/ai-quality-detection.ts:365`
- `lib/actions/transformations.ts:1353`
- `tests/lib/mappings-agent-gate.test.ts:49`
- `tests/lib/multi-agent-gate.test.ts:44`

**Acceptance criteria:**

- Identify which callsites stay below the 4-block limit when re-enabled.
- Re-enable cache_control on those callsites.
- Update or remove the corresponding "PR-CACHE-HOTFIX disabled" code comments.

---

## INF-7 — AI_PROVENANCE_LABELS_ENABLED flag-flip readiness checklist

**Status:** OPEN
**Filed:** 2026-04 (back-filled, post-PR-A)
**Description:**
PR-A introduced `AI_PROVENANCE_LABELS_ENABLED` (default OFF) gating the AGENT_PROVENANCE_GUIDANCE shared block emission and `schema_source` flag. Need a checklist of items to verify before flipping the flag ON in production.

**Acceptance criteria:**

- Heritage Capture C (flag ON) byte-identical to Capture A (flag OFF) — ✓ confirmed 2026-05-06 in PR #81 push prep.
- Eval data showing schema_source flag emission improves or maintains mapping accuracy.
- Production logging captures provenance label distribution for monitoring.
- Rollback plan documented in case of regression.

---

## INF-8 — RLS audit on `schema_documents` INSERT path

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
Investigate whether the `schema_documents` table INSERT path has the same RLS / silent-failure pattern that hid the `fields.description` schema drift for ~3 months. Defense-in-depth audit: any server-side INSERT that doesn't surface RLS rejection should be flagged.

**Related:** INF-10 (broader pattern).

---

## INF-9 — Mapping page UI does not auto-pick-up completed state

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
After mapping_generate completes successfully, the mapping page UI may not automatically refresh to show the new mappings. User has to navigate away and back. May actually be correct empty-state behavior rather than a bug; needs investigation.

**Acceptance criteria:**

- Reproduce on Rootstock POC project after PR #81 merges.
- Decide: bug (auto-refresh missing) or expected behavior (user-action-driven refresh).
- If bug, add subscription/poll to refresh on completion.

---

## INF-10 — Audit server-side reads for swallowed errors hiding column-mismatch / RLS / 0-row failures

**Status:** OPEN
**Filed:** 2026-05 (broadened scope per B's suggestion 2026-05-06)
**Description:**
The `fields.description` schema drift hid for ~3 months because the destructure pattern `const { data, error } = await supabase.from(...).select(...)` swallowed the SELECT error and treated zero-row response as success. Same pattern likely hides elsewhere: column mismatches, latent RLS rejections, or other 0-row-on-error failures.

**Acceptance criteria:**

- Audit all server-side reads in `lib/` for the swallowed-error destructure pattern.
- Add explicit error logging or throw-on-error wrappers where appropriate.
- Document the safe pattern in a "Supabase reads" section of `docs/methodology.md`.

**Related:** INF-8 (subset — RLS-specific).

---

## INF-11 — Heritage gap on buildAIContext fresh-project ingestion path

**Status:** CLOSED
**Filed:** 2026-05
**Closed:** 2026-05-06 by PR #80 (`fix/buildaicontext-field-load-rls`)
**Description:**
Pre-PR-#80, no heritage test exercised `buildAIContext` on a freshly-created project (all heritage paths used persisted state). The fields-empty schema drift bug went undetected because the heritage suite never ingested fresh.

**Closure:**

- New integration test `tests/integration/build-ai-context-fields-rls.test.ts` (274 LOC, env-gated) covers the fresh-project ingestion path.

---

## INF-12 — Mapping agent loop tool-usage strategy (Phase 3.5 tuning)

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
HOT-FIX 5 emptied `AGENT_TOOL_GUIDANCE` and removed data-scanning tool registrations because the AI was exhausting agent loop budget calling them unproductively. Phase 3.5 should re-evaluate tool-usage strategy before re-enabling: prompt tuning, tool design, gating logic, or budget management.

**Acceptance criteria:**

- Diagnose why pre-incident AI over-called data-scanning tools (prompt? tool descriptions? lack of budget guidance?).
- Design re-enablement plan with clear budget/iteration limits.
- Eval comparison before vs after re-enabling on hard fixtures.

**Related:** INF-21 (eval fixtures), INF-22 (Path C experiment).

---

## INF-13 — UI overflow: source table name overlaps source field column

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
On the mapping page, long source table names visually overlap the source field column. Cosmetic but distracting in screenshots and demos.

**Acceptance criteria:**

- Truncate with ellipsis OR allow column to expand OR move table name to tooltip.
- Verify on Rootstock POC project (worst-offender table names).

---

## INF-14 — AI over-eagerness on cross-table mappings

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
Observed during Rootstock POC: AI assigned 78% confidence to a Products → Item Master cross-table mapping that should have been WEAK-OVERLAP rejected. AI is too eager to propose cross-table mappings when field-name similarity is weak.

**Acceptance criteria:**

- Tighten the prompt's cross-table threshold (require stronger semantic match).
- Add a confidence ceiling for cross-table mappings without explicit FK relationship.
- Eval comparison on cross-table-heavy fixtures.

**Related:** INF-21 (need cross-table test fixtures).

---

## INF-15 — Switch mapping_generate to streaming + raise PER_BATCH_MAX_TOKENS

**Status:** CLOSED
**Filed:** 2026-05-05
**Closed:** 2026-05-06 by PR #81 (`feat/mapping-streaming-32k`) + HOT-FIX 6 (commit 2ee0eff)
**Description:**
Anthropic SDK rejects non-streaming requests estimated >10 minutes. PER_BATCH_MAX_TOKENS=32000 hits the threshold; needed streaming path. Followup HOT-FIX 6 disabled extended thinking on the agent callsite to satisfy `tool_choice='tool' ⊥ thinking` Anthropic constraint.

**Closure:**

- 3 mapping_generate callsites switched to `callLLMStreaming`.
- PER_BATCH_MAX_TOKENS raised 16000 → 32000.
- Extended thinking disabled on the forced-tool callsite.
- 9 new test pins lock the configuration in `tests/lib/mapping-streaming-incident.test.ts`.

---

## INF-17 — Support DDL/.sql upload as primary target schema input

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
Today, target schema is ingested via CSV upload (which carries placeholder template samples that can mislead the AI) plus `.docx` documentation. Cleaner architecture: support `.sql` or `.ddl` upload as the structural definition, with `.docx` and CSV samples as supplementary context. Particularly relevant for Salesforce-style targets where the import template CSV is not representative of customer data.

**Acceptance criteria:**

- DDL parser supports common dialects (PostgreSQL, MySQL, SQL Server) for target schema definition.
- Schema can be ingested without a CSV (DDL-only path).
- Migration: existing CSV-uploaded targets continue to work unchanged.

**Related:** INF-2 (parallel fields would resolve cleaner under DDL-defined schema).

---

## INF-18 — Pre-flight ingestion check for source CSV column-name quality

**Status:** OPEN
**Filed:** 2026-05 (back-filled)
**Description:**
Source CSVs sometimes arrive with garbage column names (`_1`, `_2`, `column`, etc.) — typically CSV header artifacts from Excel exports or partial-extract pipelines. AI mapping quality degrades when column names are uninformative. Add a pre-flight check that flags suspicious column names before ingestion.

**Acceptance criteria:**

- Define heuristics for "suspicious" column names (single underscore + digit, generic words, all-caps single letters, etc.).
- Surface warnings in the upload UI before commit.
- Allow user to rename columns before ingestion.

---

## INF-19 — Re-run thinking-on vs thinking-off eval on current mapping_generate prompt

**Status:** OPEN
**Filed:** 2026-05-06
**Description:**
HOT-FIX 6 disabled extended thinking on the mapping_generate agent callsite based on Feb 2026 baseline (`docs/investigations/pr3.4-mapping-agent-adoption.md:20`) which measured score parity between thinking-on and thinking-off on the available fixture (mapping/001). The current May 2026 prompt has evolved; the parity assumption needs re-validation. Critical for justifying Path B as the long-term architecture.

**Acceptance criteria:**

- Re-run the eval on the current prompt with thinking-on and thinking-off.
- Use INF-21 hard-case fixtures (not just the easy mapping/001).
- Update `docs/investigations/pr3.4-mapping-agent-adoption.md` with new measurements.
- If thinking-off underperforms on hard cases, escalate to INF-22 (Path C as production architecture).

**Related:** INF-21, INF-22, INF-23 (consolidated into this ticket).

---

## INF-20 — Run §9 probe from `pr12-tool-use-spec.md` (compositional surface tests)

**Status:** OPEN
**Filed:** 2026-05-06
**Description:**
The May 2026 incident was predicted in February by `docs/investigations/pr12-tool-use-spec.md:703`: "Tool-use + extended thinking on the streaming path is the most untested composition; the §9 probe should exercise this exact triple." The probe was never run. Build and run it now to systematically test compositional surfaces (streaming × tool_use × thinking × effort levels × cache_control × output_config).

**Acceptance criteria:**

- §9 probe script written that exercises the full Cartesian product of relevant API parameter combinations.
- Probe results documented as a compatibility matrix in `docs/anthropic-strict-mode-constraints.md`.
- CI integration so future Anthropic SDK upgrades automatically re-run the probe.

**Related:** INF-19 (eval fixtures); INF-25 (test infrastructure hygiene).

---

## INF-21 — Build hard-case eval fixtures for mapping_generate

**Status:** OPEN
**Filed:** 2026-05-06
**Description:**
Current eval baseline relies on a single fixture (mapping/001) explicitly described as "unambiguous." All measured score-parity claims (thinking-on vs off, single-pass vs multi-agent, etc.) are anchored on this easy case. Build 5–10 deliberately hard fixtures targeting: ambiguous semantics, multi-table inference, value-mapping requiring reasoning, picklist disambiguation, type-coercion edge cases.

**Acceptance criteria:**

- 5–10 new fixtures added under `tests/eval/datasets/_fixture/examples/mapping/`.
- Each fixture has manually-curated ground-truth mappings.
- Eval runner can score against them.
- Baseline measurement of current Path B accuracy on each.

**Related:** INF-19 (consumes these fixtures), INF-22 (consumes these fixtures), INF-14 (cross-table fixtures specifically).

---

## INF-22 — Implement Path C (two-pass mapping_generate) as flag-gated experiment

**Status:** CLOSED
**Filed:** 2026-05-06
**Closed:** 2026-05-06 by archive PR (`chore/archive-phase-3-pre-path-d`); branch `experiment/mapping-two-pass-path-c` tagged `inf-22-phase-c-archive` at commit `d33a892`. Superseded by Path D rebuild — see [`docs/archive/phase-3-pre-path-d.md`](archive/phase-3-pre-path-d.md). Migrations 091 + 092 carry forward to Path D unchanged.
**Description:**
HOT-FIX 6 chose Path B (forced tool + thinking disabled) over Path C (two-pass: thinking-on reasoning → thinking-off forced-tool extraction) based on shippability and existing eval evidence. Build Path C as a flag-gated experiment in dev so we can A/B test against Path B on real customer data and decide whether the additional complexity is justified by quality gains.

**Acceptance criteria:**

- New env flag `AI_MAPPING_TWO_PASS_ENABLED` (default OFF).
- Path C implementation behind the flag (~150 LOC, single new function).
- New `mapping_experiments` table or view captures both paths' outputs for comparison.
- Heritage byte-identical with flag OFF.
- A/B comparison script runs both paths on identical inputs and outputs metrics table.
- Decision documented in `docs/investigations/path-c-experiment.md`.

**Related:** INF-19 (eval methodology), INF-21 (test fixtures), INF-26 (broader Phase 3 archive).

---

## INF-23 — DUPLICATE of INF-19

**Status:** DUPLICATE
**Filed:** 2026-05-06
**Description:** Same scope as INF-19 (re-run thinking eval on current prompt). Consolidated into INF-19 to avoid divergent tracking.

---

## INF-24 — Investigation-first protocol applies to structural rewrites, not just config changes

**Status:** OPEN
**Filed:** 2026-05-06 (from B's PR #81 yellow flag)
**Description:**
PR #81 commit 1 (single-agent-mapping.ts going from `runAgentLoop` wrapper to direct `callLLMStreaming`) was a substantive structural change that landed without the same investigation discipline applied to commit 2's thinking-config change. The structural rewrite was greenlit because it "felt" mechanical (degenerate agent loop with single tool); only Heritage A+B caught it as the backstop. Future incidents touching the agent path should require investigation-first regardless of how mechanical the change feels.

**Acceptance criteria:**

- Add a methodology note to `docs/methodology.md` defining "structural rewrite" criteria that trigger investigation-first.
- Update worktree coordination protocol to reference this.
- Apply to all future agent-path changes.

**Related:** General methodology, not tied to specific code.

---

## INF-25 — `tests/eval/runner.test.ts` EVAL_ORG_ID env-pollution flake

**Status:** OPEN
**Filed:** 2026-05-06 (from B's PR #81 yellow flag)
**Description:**
`tests/eval/runner.test.ts` (the `EVAL_ORG_ID` env-var guard tests) passes in isolation but flakes under concurrent vitest workers due to env-var pollution from sibling tests. Currently surfaces as a footnote on every PR ("3396/3397, single failure is pre-existing flaky..."). Fix root cause so future PRs can claim full green.

**Acceptance criteria:**

- Identify which sibling test pollutes `EVAL_ORG_ID`.
- Either: isolate via vitest pool config (separate worker), or: add explicit cleanup in the affected sibling.
- Verify full suite passes 3397/3397 under default concurrent settings.

**Code references:**

- `tests/eval/runner.test.ts`

---

## INF-26 — Phase 3 multi-agent + voting work archived pre Path D rebuild

**Status:** CLOSED
**Filed:** 2026-05-06
**Closed:** 2026-05-06 by archive PR (`chore/archive-phase-3-pre-path-d`). Branch `feat/pr3.4e-voting-variance-fix` tagged `inf-3.4e-archived-for-path-d` at commit `64617f3`. See [`docs/archive/phase-3-pre-path-d.md`](archive/phase-3-pre-path-d.md) for the full Phase 3 status snapshot.
**Description:**
Path D's monolithic Opus 4.7 single-call architecture supersedes the multi-agent voting pipeline (Phase 3.4cd) and its variance-validation follow-up (3.4e). 3.4cd shipped to main behind `AI_PHASE_3_MULTI_AGENT_ENABLED=0` with no production exposure; 3.4e was orphaned with the variance fix never merged. The structural overhead of the 7+ agent pipeline (Generator ×3 → Specialists → Critic ×3 → Refinement) loses against a single Opus 4.7 call on the standalone-Claude-Chat 21-mapping benchmark.

**Disposition:**

- 3.4cd code remains on main behind the default-OFF flag pending a follow-up removal PR after Path D ships.
- 3.4e branch retained for reference behind tag `inf-3.4e-archived-for-path-d`; no merge planned.
- 3.5 (transform pipeline design) on hold pending Path D output schema.
- 3.6, 3.7 client SSE, 3.8 Path D fixtures — addressed during Path D rollout.

**Until follow-up removal lands:** do not enable `AI_PHASE_3_MULTI_AGENT_ENABLED` in any environment, do not extend `lib/ai/multi-agent-orchestrator.ts` / `multi-agent-prompts.ts` / `multi-agent-types.ts`, do not investigate 3.4e variance further.

**Code references:**

- `lib/ai/multi-agent-orchestrator.ts`, `multi-agent-prompts.ts`, `multi-agent-types.ts` (3.4cd, default-OFF)
- `lib/actions/mappings.ts:257` (multi-agent dispatch site)
- Tags: `inf-22-phase-c-archive`, `inf-3.4e-archived-for-path-d`

**Related:** INF-22 (Path C archive, same epoch).

---

## INF-27 — Investigate PostToolUse hook reformatting repo-wide

**Status:** OPEN
**Filed:** 2026-05-06
**Description:** PostToolUse hook in `.claude/settings.json` runs `npx prettier --write "$CLAUDE_FILE_PATH"` and `npx eslint --fix "$CLAUDE_FILE_PATH"` (single-file target by design). 660-file repo-wide drift observed during Claude Code Write/Edit ops on `chore/archive-phase-3-pre-path-d` on 2026-05-06. Either the env var is mis-expanding or another process (IDE-on-save, watchman, husky pre-commit) is firing repo-wide. Investigate as a separate concern; not blocking ongoing work.

**Acceptance criteria:** Root cause identified; hook config or offending process disabled; clean working tree confirmed across two consecutive Claude Code edits.

---

## INF-28 — A0a unregistered-data-scanning-tools fix obsolete (closed without landing)

**Status:** CLOSED
**Filed:** 2026-05-06
**Closed:** 2026-05-06 by investigation finding the fix already on main. A0a closed obsolete after investigation 2026-05-06; fix was incorporated via commit `b3417b2` (PR #81, merged 2026-05-05 as `5ae0d36`). Branch `fix/remove-unregistered-datascanning-tools` superseded; deletion follows this PR.
**Description:**
A0a was scoped (per audit RECOMMENDATION #9) to land the standalone HOT-FIX 4 commit `4c5d7d5` on `fix/remove-unregistered-datascanning-tools` to main before A2 (migration 093 / Path D structural work) begins. Investigation 2026-05-06 confirmed the fix is already on main with the same intent and more:

- `lib/ai/agent-tool-guidance.ts:51` is `export const AGENT_TOOL_GUIDANCE = ''` (HOT-FIX 4 applied)
- `tests/lib/mapping-engine-agent-system-prompt.test.ts` carries the negative-pin test for `query_field_data` / `count_distinct_patterns` / `cross_field_correlation` strings staying out of the constant body
- `tests/integration/mapping-persistence-write-path.test.ts` exists on main (378 LOC, expanded from 4c5d7d5's 286 LOC)
- HOT-FIX 5 (additional, beyond 4c5d7d5's scope) removed the 3 data-scanning tools from `runSingleAgentMappingLoop`'s tools array entirely — `grep QUERY_FIELD_DATA_TOOL lib/ai/single-agent-mapping.ts` returns zero matches

The supersession is documented in `b3417b2`'s own commit message: "This PR supersedes the pending HOT-FIX 4 PR (`fix/remove-unregistered-datascanning-tools`) — it bundles HOT-FIX 4 + HOT-FIX 5 + the streaming switch + the 32k token bump into one self-contained set of changes." Re-applying `4c5d7d5` on top would be a no-op for the prompt fix and would conflict with b3417b2's test pin updates.

**Lesson captured for INF-24 (investigation-first protocol):** the audit RECOMMENDATION #9 cited the fix's branch ref, not its content state vs current main. Branch-ref recommendations need a content-on-main check before scoping work.

**Cleanup follow-up (not blocking):** delete branch from origin after this PR merges:

```
git push origin --delete fix/remove-unregistered-datascanning-tools
```

**Related:** INF-24 (investigation-first protocol — this case reinforces the rule).

---

## INF-29 — Add canary fixtures for schema_enrichment_from_docs smoke test

**Status:** OPEN
**Filed:** 2026-05-06
**Description:** A3b smoke test for `schema_enrichment_from_docs` was deferred during the A3b PR because the canary project (HERITAGE_PROJECT_ID `6622ddf1-47bd-4e48-ac2a-5b109a25bc13`) has zero `schema_documents` rows. The function reads `schema_documents` to build its enrichment prompt and returns early without them. Building an ~80 LOC per-test fresh fixture was deferred per audit's "minimum smoke tests" framing.

**Acceptance criteria:** Either (a) provision `schema_documents` on canary (also unblocks similar future tests) or (b) build a fresh-fixture helper in the smoke test file. Convert `it.skip` to `it` and verify it passes.

**Code references:**

- `tests/integration/ai-flow-smoke.test.ts` — currently `it.skip(...)` with a docblock pointing here
- `lib/actions/schema-enrichment.ts:85` — `enrichSchemaFromDocs` entry point

**Related:** audit RECOMMENDATION #10 (smoke coverage for AI flows reshaped by Path D).

---

## INF-30 — compartmentalized_deliverables smoke test runtime exceeds budget

**Status:** OPEN
**Filed:** 2026-05-06
**Description:** A3b smoke test for `generateCompartmentalizedPackage` exceeded the 240s timeout without producing the `[generateCompartmentalizedPackage] Tool-use mode: parsed N files` log line, suggesting the streaming response or JSON recovery hung before parsing completed. 32k-token streaming output + ZIP assembly is 4–8 minutes typical, exceeding smoke-test runtime budget. Coverage gap mitigated: `migration_runbook` smoke test (passing) exercises ~90% of the same prompt-assembly pipeline; the streaming-specific code path remains uncovered.

**Acceptance criteria:** Either (a) raise the smoke timeout to 600s and accept the runtime, (b) build a streaming-isolated test that bypasses ZIP assembly, or (c) cover this code path implicitly via Phase B Path D implementation tests where fixture + timing infrastructure is already needed.

**Code references:**

- `tests/integration/ai-flow-smoke.test.ts` — currently `it.skip(...)` with a docblock pointing here
- `lib/actions/execution-package.ts:821` — `generateCompartmentalizedPackage` entry point
- `lib/actions/execution-package.ts:500` — `generateCompartmentalizedPackageInternal` (has `__skipPersistence` option that may help bypass ZIP step)

**Related:** audit RECOMMENDATION #10; INF-29 (sibling A3b deferral).

---
