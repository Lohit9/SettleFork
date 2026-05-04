# PR 3.4 — `mapping_generate` first agent-loop adopter (Phase A investigation)

**Status:** Read-only Phase A. No code mutated. No commits.
**Branch:** `feat/pr3.4-mapping-agent-adoption` (post-PR 3.3, migration 086 free).
**Reference:** [`docs/investigations/pr-phase3.1-agent-design.md`](./pr-phase3.1-agent-design.md) §C1 (adoption sketch), §E3 (PR slicing).

---

## TL;DR

PR 3.4 wires the `runAgentLoop` primitive (PR 3.2) and the 3 data-scanning tools (PR 3.3) into the existing `mapping_generate` flow under `AI_PHASE_3_ENABLED=1`. The 12 locked decisions are mostly directly implementable, but **eight on-disk realities** require Phase B accommodation — most consequentially:

- `CallLLMOptions` does NOT today expose `thinking` or `output_config.effort` overrides. LOCK #3 requires both. They must be added as optional fields before any agent call can be made (D-1, D-2).
- There are **two distinct production callsites** under the `mapping_generate*` feature umbrella: a bulk per-source-table loop in `lib/ai/mapping-engine.ts` and a single-pair regenerate in `lib/actions/mappings.ts`. The eval runner exercises only the latter. Phase 3.8 lift measurement therefore requires wiring **both** callsites — the recommendation is to do exactly that (D-3, §F2).
- Sample-data shape is per-FIELD (an array of values per field), not per-TABLE row tuples. LOCK #5/#6 ("50 per source table" / "30 per target table") are most-naturally interpreted as per-field value-count bumps; the row-tuple alternative would require a significantly larger structural change (D-4, §C4).
- Heritage byte-identical (LOCK #11) is enforced by a SHA-256 fingerprint test that pins the post-persistence read state. The flag-OFF branch must be **literally unchanged** for the gate to pass — this is the strongest stability test in this PR (D-8, R8).

**Recommended PR slicing:** split into 3.4a (plumbing — CallLLMOptions extension, migration 086, prompt-format additions; ~+200 LOC, $0 spend) and 3.4b (callsite wiring + eval fixture; ~+300 LOC, ~$0.30-0.50 spend). Total ~+500 LOC, well inside the prompt's "+800 to +1200" ceiling.

**Eval-fixture baseline today:** `mapping/001-fixture` scores 1.000 at ~$0.045/run under `AI_PHASE_2_ENABLED=1` single-shot. Under `AI_PHASE_3_ENABLED=1` with Opus 4.7 + adaptive thinking + max effort, expect 1.000 score, ~$0.50-2.00 cost — score parity (the fixture is unambiguous) with a 10-40× cost increase.

---

## DIVERGENCE callouts (load-bearing — read first)

Eight on-disk realities contradict, complicate, or extend the 12 locked decisions. Phase B must address each.

1. **D-1 — `CallLLMOptions` exposes neither `thinking` nor `output_config.effort` overrides.** LOCK #3 specifies `thinking: { type: "adaptive" }` plus `output_config: { effort: "max" }`. The wrapper today auto-resolves `effort` to `'high' | undefined` from `AI_PHASE_2_ENABLED + LOW_EFFORT_FEATURES` ([`llm-client.ts:218-257`](../../lib/ai/llm-client.ts#L218-L257)) and does not accept a `thinking` field at all. Phase B must extend `CallLLMOptions` (and the wrapper request body) before any agent-loop call can carry adaptive thinking + max effort.

2. **D-2 — `RunAgentLoopOptions.llmOptions` is a `Pick`'d subset that excludes any future thinking/effort fields.** [`agent-loop.ts:83-86`](../../lib/ai/agent-loop.ts#L83-L86) currently picks only `'model' | 'maxTokens' | 'promptVersion' | 'abuseUserId' | 'cacheControl' | 'metadata'`. Even after extending `CallLLMOptions` (per D-1), the Pick must be widened to include the new fields, otherwise PR 3.4 cannot pass them through to `callLLM`.

3. **D-3 — Two distinct production callsites both feature-tagged `mapping_generate*`.** The design doc's "first adopter at [`mapping-engine.ts:1500`](../../lib/ai/mapping-engine.ts#L1500)" is the BULK loop in `runMappingGeneration`. The eval runner ([`lib/eval/runner.ts:506`](../../lib/eval/runner.ts#L506)) instead exercises `runMappingGenerationForPair` ([`lib/actions/mappings.ts:139`](../../lib/actions/mappings.ts#L139)) — a separate single-pair function with its own `callLLM` invocation at [`mappings.ts:219`](../../lib/actions/mappings.ts#L219). If PR 3.4 wires the agent loop only into `runMappingGeneration`, the eval runner will continue to exercise the single-shot single-pair path and Phase 3.8 lift measurement will not actually measure agent-loop output. Decision required before Phase B (see §F2).

4. **D-4 — Sample data is field-level, not row-level.** `buildAIContext` returns per-field `sample_values: string[]` ([`context-builder.ts:284-287`](../../lib/ai/context-builder.ts#L284-L287)). `runMappingGeneration` currently passes `maxSampleValues: 5` ([`mapping-engine.ts:1442`](../../lib/ai/mapping-engine.ts#L1442)) — five values per field, NOT five rows. LOCK #5 ("50 per source table") and LOCK #6 ("30 per target table") read most naturally as TUPLE-style row samples. Phase B must disambiguate: bump per-field cap from 5 → 50/30 (mechanical, matches existing schema rendering), OR add a row-tuple sample alongside (structural, requires new query against `data_rows` and a new `formatSchemaForPrompt` block). Recommended interpretation in §C4.

5. **D-5 — Source / target sample asymmetry not expressible with a single `buildAIContext` call.** Today both source and target tables share the same `maxSampleValues` because `tableIds` is a single union list. LOCK #5 (50) ≠ LOCK #6 (30). Phase B must either (a) make two calls — one per role — and merge, or (b) extend `ContextScope` with `maxSourceSampleValues` / `maxTargetSampleValues`. Option (b) is the smaller change.

6. **D-6 — Target metadata enrichment partially present.** LOCK #7 demands FK / NOT NULL / CHECK / defaults / descriptions / synonyms in the target schema section. The `fields` SELECT in `runMappingGeneration` ([`mapping-engine.ts:1421`](../../lib/ai/mapping-engine.ts#L1421)) already pulls `is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint`. NOT pulled today: `default_value`, `description`, and synonyms (no `synonyms` column exists on `fields` — see §C5). Per-field rendering surface in `formatSchemaForPrompt` does not currently print FK reference, default, or description either. The enrichment scope is not "verify it's surfaced" — it's "wire it through".

7. **D-7 — `projects.description` already exists** ([`002_foundation.sql:14`](../../supabase/migrations/002_foundation.sql#L14)). LOCK #8 says "new field on projects table via migration 086". Confirmed: `business_context` is a SEPARATE column from `description` (description = project name/blurb; business_context = customer-provided migration context to feed AI). Migration 086 adds `business_context TEXT` — see §D.

8. **D-8 — Heritage gate is a READ-path test.** [`mappings-for-redesign-heritage.test.ts`](../../tests/integration/mappings-for-redesign-heritage.test.ts) fingerprints the post-persistence READ via `getMappingsForRedesignCore` (rowCount, rowCountByKind, counts, rowsFingerprint). It does NOT capture LLM output directly. "Heritage byte-identical when AI_PHASE_3_ENABLED=0" therefore means: under flag-OFF, the persisted rows after running through PR 3.4-modified `runMappingGeneration` produce the same post-read fingerprint as PR #23 baseline. The branch where `phase3Enabled` is false must remain literally unchanged at the AST level — this is the strongest test of locked decision #11.

---

## Section A — Current `mapping_generate` flow inventory

### A1. Entry function signatures

| Entry | File | Lines | Caller | Feature tag |
|---|---|---|---|---|
| `runMappingGeneration` (BULK loop, multi source-table) | `lib/ai/mapping-engine.ts` | 1391-1672 | `generateMappings` server action ([`mappings.ts:415`](../../lib/actions/mappings.ts#L415)) | `mapping_generate` (id 1) + `mapping_generate_repair` (id 2) |
| `runMappingGenerationForPair` (SINGLE pair) | `lib/actions/mappings.ts` | 139-372 | `regenerateFieldMappings` server action ([`mappings.ts:2005`](../../lib/actions/mappings.ts#L2005)) AND eval runner ([`runner.ts:506`](../../lib/eval/runner.ts#L506)) | `mapping_generate_legacy_pair` (id 3) + `mapping_generate_legacy_pair_repair` (id 4) — eval overrides to `eval_mapping` |

Both share: `MAPPING_GENERATION_SYSTEM_PROMPT`, `buildMappingUserMessage`, `EMIT_TABLE_MAPPINGS_TOOL`, the JSON-repair retry shape, the `dq_create_target_field_mapping` RPC for persistence.

### A2. Prompt construction (current)

System prompt: `MAPPING_GENERATION_SYSTEM_PROMPT` ([`mapping-engine.ts:219-318`](../../lib/ai/mapping-engine.ts#L219-L318)), ~100 LOC of static prose. Sections: confidence rubric, transformation rules, multi-field patterns (many_to_one / one_to_many), TABLE-LEVEL MATCHING with primary-match / lookup / entity / weak-overlap rules, "Respond with ONLY valid JSON" closer.

User message: `buildMappingUserMessage` ([`mapping-engine.ts:853-906`](../../lib/ai/mapping-engine.ts#L853-L906)) concatenates:
- `sourceSection` — `formatSchemaForPrompt([sourceCtx], 'source')`
- `targetSection` — `formatSchemaForPrompt(aiCtx.target_tables, 'target')`
- `docBlock` — `formatDocumentsForPrompt(aiCtx.documents)` (schema docs + business-context docs from storage)
- `intelligenceCtx` — `aiCtx.intelligence_context` (migration intelligence text, optional)
- `otherSourcesBlock` — wrapped `<other_source_tables>` block listing source tables NOT in the current batch (BULK loop only; the single-pair function omits it)

Sample-row count: `maxSampleValues: 5` ([`mapping-engine.ts:1442`](../../lib/ai/mapping-engine.ts#L1442) and [`mappings.ts:185`](../../lib/actions/mappings.ts#L185)). Per-field, not per-table tuples.

### A3. `callLLM` invocation today

Both callsites set: `feature` (varies), `systemPrompt`, `userMessage`, `maxTokens: 16000`, `projectId`, `userId`, `promptVersion: 'mapping-v1'`, `abuseUserId: userId`, structured `metadata`. Conditional on `AI_PHASE_2_ENABLED=1`: `tool: EMIT_TABLE_MAPPINGS_TOOL` (forces tool-use). The bulk callsite additionally sets `cacheControl: true` (PR 13.1 cohort); the single-pair callsite does NOT — that's the existing PR 13.1 audit decision, preserved here.

NOT plumbed today: `thinking`, `output_config.effort` (resolved automatically by wrapper), `tools` (multi-tool array), `parentCallId` outside the repair retry.

### A4. Persistence

For the BULK path: each `table_mapping` row is inserted into `table_mappings` (line 1612), then `persistClaudeFieldMappingsForTM` ([`mapping-engine.ts:1244-1364`](../../lib/ai/mapping-engine.ts#L1244-L1364)) groups field mappings by target field, collapses many-to-one entries, and calls the `dq_create_target_field_mapping` RPC once per target field (line 1344). For the single-pair path: same `dq_create_target_field_mapping` RPC, called from a similar collapsed loop in `runMappingGenerationForPair`.

### A5. Error handling

- Per-batch `callLLM` failure → `console.error` + `continue` to next batch (BULK); → return `{inserted:0, error}` (single-pair).
- JSON parse failure on the legacy text path → `mapping_generate_repair` retry with `parentCallId` chain. Reachable only when `AI_PHASE_2_ENABLED=0`.
- Zero stored AND zero skipped after the loop → `success: false, errorCode: 'INTERNAL'`.
- Caught uncaught exceptions → same `INTERNAL` shape.

### A6. Heritage fingerprint

[`mappings-for-redesign-heritage.test.ts:101-117`](../../tests/integration/mappings-for-redesign-heritage.test.ts#L101-L117) computes a SHA-256 of normalized rows: `{id, kind, status, targetField.id, sourceIds, hasTransformation}` per row in the contract-guaranteed server order. Plus a separate sourceFields fingerprint over `{id, sourceTable.id, mappingStatus, isAcknowledged, sampleValueCount}`. The test is opt-in via `RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1` and pins against PR #23 baseline.

The test runs in two modes: CAPTURE always prints the JSON snapshot (re-baselineable), PINNED asserts an exact equality against `SNAPSHOT_2026_04_23`. PR 3.4 must keep PINNED green under flag-OFF — agent-loop landing must not require a re-capture. The fingerprint deliberately excludes things that change naturally over time (timestamps, AI-text reasoning) and pins everything that affects user-visible behavior (row count, kind discrimination, source/target wiring, status). The test does NOT exercise the AI write path directly: it reads what's already persisted on the heritage project. Heritage byte-identical for PR 3.4 means: nothing in the flag-OFF branch (the `else` arm of the `if (phase3Enabled)` gate) changes the rows that get inserted, in any way that would propagate to the read fingerprint.

### A7. Cache-control posture today

[`mapping-engine.ts:1524`](../../lib/ai/mapping-engine.ts#L1524) sets `cacheControl: true` on the BULK callsite (PR 13.1 cohort decision). The single-pair callsite at [`mappings.ts:219-238`](../../lib/actions/mappings.ts#L219-L238) does NOT set `cacheControl` — preserved here as the existing PR 13.1 audit decision (single-pair regenerate has poor cache locality vs. the bulk per-table loop). Phase B preserves this asymmetry by default; flipping the single-pair path to `cacheControl: true` is a separate decision since it changes cost-and-latency posture.

### A8. parent_call_id state today

`runMappingGeneration` only populates `parentCallId` on the JSON-repair retry ([`mapping-engine.ts:1556`](../../lib/ai/mapping-engine.ts#L1556)). All other calls within the same batch loop are independent — no chain. PR 3.4's agent loop will produce per-iteration heads-to-tails chains via `runAgentLoop` (LOCK #3 from design §A4). Agent calls and repair-retry calls thus share the same `parent_call_id` column in `llm_calls` (introduced in 082, indexed in 084) but write distinct chain types — `metadata.agent_loop: true` distinguishes them downstream.

---

## Section B — Phase 3 adoption surface

### B1. Where the `AI_PHASE_3_ENABLED` gate lives

Single `if (phase3Enabled)` branch around the `callLLM(...)` invocation. For the BULK callsite that's the call at [`mapping-engine.ts:1503-1525`](../../lib/ai/mapping-engine.ts#L1503-L1525). For the single-pair callsite (if also wired — see D-3 / §F2) that's [`mappings.ts:219-238`](../../lib/actions/mappings.ts#L219-L238). The flag-OFF branch must be byte-identical to today (heritage gate per D-8).

### B2. `runAgentLoop` invocation shape

Per LOCK #1, #2, #4 and the §C1 sketch:

```
runAgentLoop({
  feature: featureOverride ?? 'mapping_generate',
  systemPrompt: enrichedSystemPrompt,        // §C
  userMessage: enrichedUserMessage,           // §C
  tools: [
    { tool: QUERY_FIELD_DATA_TOOL,        handler: makeQueryFieldDataHandler({ supabase, projectId, userId }) },
    { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase, projectId, userId }) },
    { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase, projectId, userId }) },
    { tool: EMIT_TABLE_MAPPINGS_TOOL },        // no handler = answer tool
  ],
  projectId,
  userId,
  maxIterations: 8,                            // wrapper default; could lower
  maxCostUsd: 1.0,                             // wrapper default; LOCK #1 spend allows this
  llmOptions: {
    model: 'claude-opus-4-7',                  // LOCK #1
    maxTokens: 16000,
    promptVersion: 'mapping-v2-agent',
    cacheControl: true,                        // LOCK #10 (inherited from PR 13.1 cohort)
    abuseUserId: userId,
    metadata: { source_table_id, batch_index, agent_loop: true },
    // LOCK #3: requires CallLLMOptions extension + Pick widening (D-1, D-2)
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
  },
})
```

The supabase client passed to `make*Handler` MUST carry the user JWT (NOT service-role) — the data-scanning RPCs are SECURITY INVOKER and gate via `user_has_project_role(p_project_id, 'viewer')` ([`agent-tools.ts:46-55`](../../lib/ai/agent-tools.ts#L46-L55)).

### B3. Mapping back from `AgentLoopResult`

`runAgentLoop` returns `{ kind: 'final', finalToolUse, ... } | { kind: 'aborted', reason, ... }`. The final answer tool by construction is `EMIT_TABLE_MAPPINGS_TOOL`, so `result.finalToolUse.input` has shape `{ table_mappings: ClaudeTableMapping[] }` — directly substitutable for the existing `primaryResult.toolUse.input` cast at [`mapping-engine.ts:1536`](../../lib/ai/mapping-engine.ts#L1536). The downstream persistence loop is unchanged.

Aborted-loop fallback (per §A5 patterns):
- `reason === 'schema_error'` (model emitted text instead of an answer tool): single-shot retry against `callLLM` with `EMIT_TABLE_MAPPINGS_TOOL` forced. Mirrors today's repair-retry but for a different failure mode.
- `reason === 'tool_error'` (RLS denied / unrecoverable handler exception): hard fail this batch, `console.error`, continue to next batch (BULK) or return error (single-pair).
- `reason === 'max_iterations' | 'max_cost' | 'max_wall_clock' | 'model_error'`: log and hard-fail this batch. Recovery options can be added later if telemetry shows real frequency.

### B4. Telemetry

Per-iteration `llm_calls` rows already written by `runAgentLoop` via the `callLLM` wrapper, parent-chained heads-to-tails (LOCK #3 from design). PR 3.4 must thread `metadata: { agent_loop: true }` through `llmOptions.metadata` so dashboards can filter agent rows from single-shot rows. Suggest also: `metadata.agent_iteration_max: maxIterations` for cost-budget audits, plus `metadata.source_table_id` (already present in single-shot today) so per-table agent latency can be split out from aggregates.

### B5. Cache-warmth across iterations

LOCK #10 inherits `cacheControl: true` for the bulk callsite. The agent loop iteration shape interacts with Anthropic's 5-min ephemeral TTL favorably: each iteration's request reuses the system-prompt + tools prefix, the cache hit refreshes the TTL, the conversation accumulates as appended `<prior_tool_calls>` text in `userMessage` ([`agent-loop.ts:365-379`](../../lib/ai/agent-loop.ts#L365-L379)). The cached prefix stays warm as long as iterations land within ~5 min of each other. Hard caps (`maxWallClockMs: 120_000`, `maxIterations: 8`) keep us comfortably under TTL. Verification gate per design §D1: `cache_read_input_tokens > 0` on iteration N for N > 1.

### B6. Aborted-loop fallback policy

For PR 3.4 keep the fallback policy minimal — only `schema_error` triggers single-shot retry (mirrors today's repair-retry shape). Other abort reasons hard-fail the batch and proceed to the next source table (BULK) or return `{inserted: 0, error}` (single-pair). This is conservative: we'd rather log an aborted batch and let the user retry than burn budget on speculative recovery. Phase 3.5+ may introduce richer recovery (e.g., halve `maxSampleValues` and retry on `max_cost`) but that's a measurement-driven decision after the eval cohort runs.

### B7. Sketch of the gated branch

Pseudo-code at the gate (BULK callsite). The `else` branch is verbatim today's code; the `if` branch is new. Identical pattern at the single-pair callsite, minus `<other_source_tables>` handling.

```
const phase3Enabled = process.env.AI_PHASE_3_ENABLED === '1'
let primaryResult: Awaited<ReturnType<typeof callLLM>>

if (phase3Enabled) {
  const agentResult = await runAgentLoop({
    feature: featureOverride ?? 'mapping_generate',
    systemPrompt: MAPPING_GENERATION_AGENT_SYSTEM_PROMPT,    // §C1
    userMessage: buildMappingUserMessage({ ...preludesFromC2C3, sourceSection, targetSection, docBlock, intelligenceCtx, otherSourcesBlock }),
    tools: [
      { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase, projectId, userId }) },
      { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase, projectId, userId }) },
      { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase, projectId, userId }) },
      { tool: EMIT_TABLE_MAPPINGS_TOOL },
    ],
    projectId,
    userId,
    llmOptions: {
      model: 'claude-opus-4-7',
      maxTokens: PER_BATCH_MAX_TOKENS,
      promptVersion: 'mapping-v2-agent',
      cacheControl: true,
      abuseUserId: userId,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
      metadata: { source_table_id, batch_index, agent_loop: true },
    },
  })

  if (agentResult.kind === 'final') {
    primaryResult = synthesizeToolUseResult(agentResult)   // tiny adapter to match CallLLMResult shape
  } else if (agentResult.kind === 'aborted' && agentResult.reason === 'schema_error') {
    primaryResult = await callLLM({ /* single-shot retry with EMIT_TABLE_MAPPINGS_TOOL forced */ })
  } else {
    console.error('[Mapping] Agent loop aborted', agentResult)
    continue   // BULK; or `return { inserted: 0, error: ... }` (single-pair)
  }
} else {
  // FLAG-OFF: byte-identical to today. Do not reformat. Do not refactor.
  primaryResult = await callLLM({ /* the existing block, unchanged */ })
}
```

`synthesizeToolUseResult` is a small adapter (~10 LOC) that constructs a `CallLLMResult` of `kind: 'toolUse'` from the agent's final tool-use block. Required because the downstream code at [`mapping-engine.ts:1531-1571`](../../lib/ai/mapping-engine.ts#L1531-L1571) is typed against `CallLLMResult`, not `AgentLoopResult`. The adapter populates `callId` from `agentResult.callIds[agentResult.callIds.length - 1]` (the head of the chain) and zeroes the token counters (the per-iteration counters live in `llm_calls`, not on the synthesized result).

---

## Section C — Prompt enrichment design

LOCK #9 budgets ~150-200 LOC of additions across three new sections. Recommend the following.

### C1. Tool-use guidance (~50-70 LOC, system-prompt suffix)

New section appended to `MAPPING_GENERATION_SYSTEM_PROMPT` only when `AI_PHASE_3_ENABLED=1` (otherwise heritage byte-identical breaks). Recommend gating via a constant `MAPPING_GENERATION_AGENT_SYSTEM_PROMPT = MAPPING_GENERATION_SYSTEM_PROMPT + AGENT_TOOL_GUIDANCE` exported alongside the original. The flag-conditional branch picks the right one at the call site; the original constant stays untouched for heritage.

Required content per design §B + §C1:
- WHEN to call `query_field_data`: when aggregate stats show drift (high cardinality with format hints) OR when documentation describes target picklist values that need cross-checking against actual source values.
- WHEN to call `count_distinct_patterns`: deciding enum-vs-freeform target field, validating expected boolean encoding (Y/N vs 0/1 vs true/false), checking if a source field is functionally a foreign key (low cardinality + repeated values).
- WHEN to call `cross_field_correlation`: deciding whether two source fields should combine into one target (many_to_one), validating conditional-required rules (e.g., `amount` required when `status='Closed Won'`).
- One concrete worked example per tool. Examples should mirror real-world ambiguity (e.g., "source `customer_status` has 14 distinct values, target `Account.Status` is a 6-value picklist per documentation — call `count_distinct_patterns` to see which 6 source values dominate before deciding the value-translation rule").
- Hard limits: prefer to answer after ≤3 tool calls; escalate-and-explain in `reasoning` when scanning is inconclusive.
- WHAT NOT to do: do NOT call `query_field_data` to "look at all the data" — the static prompt already contains 50 sample values per source field. Tools are for targeted checks, not bulk inspection.

The "what not to do" guard matters because the cost model only works if the model averages 2-3 tool calls per loop. Without explicit guidance the model can over-call (costing 8 iterations × $0.10 = $0.80 per call) and burn the loop's max_cost cap unproductively.

### C2. Schema-level overview (~30-50 LOC, user-message prelude)

Computed server-side, prepended to the user message. Recommend including:
- Source table count + field count + total profiled rows.
- Target table count + field count.
- Naming-convention summary (e.g., "source uses snake_case, target uses UPPER_SNAKE_CASE") computed via a simple regex over field names.
- FK density (`count(fields where is_foreign_key=true) / count(fields)`) per role.
- Document-context presence flags ("schema docs: 2; business-context docs: 1; intelligence summary: present").

This block sets the model's mental frame before it sees per-field detail. Cheap to compute, high signal for the model deciding whether to spend tool-use budget.

### C3. Business-context section (~20-30 LOC, user-message prelude)

When `projects.business_context` is non-empty:
```
<customer_business_context>
{business_context, max ~2000 chars verbatim}
</customer_business_context>
```

When empty: omit the section entirely (do not emit empty tags). Keeping the block conditional avoids false-positive cache invalidation for projects without context. The 2000-char ceiling protects against accidental dump of full-document text.

### C4. Sample-row count: 5 → 50/30 (per D-4 disambiguation)

**Recommended interpretation:** LOCK #5/#6 are per-FIELD value counts. Bumping `maxSampleValues` from 5 → 50 (source) / 30 (target) preserves the existing rendering surface (`Samples: "v1", "v2", ...` line in `formatSchemaForPrompt`) and matches how the data-scanning tools augment runtime queries (the model can always call `query_field_data` for more samples, so the static prompt only needs to give it a representative sample to decide IF a tool call is worth it).

Tuple-style row samples (interpretation B) would require:
- New SQL query against `data_rows` joined to `tables`/`fields` for the first N rows per table.
- New `formatSchemaForPrompt` rendering branch for `Sample rows: \n  | f1 | f2 | f3 |\n  | ...`.
- Token-budget pressure (50 rows × 30 fields × 10 chars ≈ 15K chars per source table; with 10 source tables that's 150K chars — pushes into 200K-token territory and forces aggressive cache reliance).

**If the principal does want tuple samples**, scope it as a follow-up sub-PR (3.4a structural / 3.4b agent-adoption) — significantly larger surface than the current Phase B estimate.

### C5. Target metadata enrichment (per D-6)

Per-field LOC estimate to surface FK / NOT NULL / CHECK / defaults / descriptions / synonyms in the target schema rendering:

| Field metadata | Current SELECT | Currently rendered? | LOC to add |
|---|---|---|---|
| `is_nullable` (NOT NULL signal) | yes | yes (via "nullable: true/false") | 0 |
| `is_foreign_key` + `fk_reference` | yes | NO — pulled but not printed | ~5 in `formatSchemaForPrompt` |
| `check_constraint` | yes | NO — pulled but not printed | ~5 |
| `default_value` | NO — not in current SELECT | NO | +1 column in SELECT, +5 render |
| `description` | NO — column is `description` on fields table | NO | +1 SELECT, +5 render |
| `synonyms` | **column does NOT exist on `fields`** | n/a | scope into a separate migration if required, OR drop from LOCK #7 |

Recommend dropping "synonyms" from PR 3.4 unless the principal confirms the source. The rest is mechanical: extend the `fields` SELECT, extend `formatSchemaForPrompt`'s target-role branch (~25 LOC total).

---

## Section D — Migration 086 design

### D1. DDL

```sql
-- 086_project_business_context.sql
ALTER TABLE public.projects
  ADD COLUMN business_context TEXT;

COMMENT ON COLUMN public.projects.business_context IS
  'Customer-supplied free-text context surfaced to the AI mapping engine. Distinct from `description` (project name blurb).';
```

NULL default. Empty string and NULL both treated as "absent" by the prompt builder (§C3).

### D2. RLS implications

`projects` already has RLS policies established in 002 / 050 / 079 (org_id + project_members gate). `business_context` is just another column on the existing row — no new policy needed. Read access: anyone who can read the project row. Write access: anyone who can update the project row (today: project owner or org admin via the existing UPDATE policies).

If write access to `business_context` should be narrower (e.g., only project owners), that's a follow-up sub-PR with a new column-level policy. Recommend NOT adding this in 086 unless explicitly required — keeps the migration minimal and matches today's all-or-nothing column policy posture.

### D3. Data backfill

Not required. NULL is the absent state and the prompt builder handles it.

### D4. Application-side surface

A `lib/actions/projects.ts` setter to update `business_context` is OUT of scope for PR 3.4 — that's product UI work. Phase B can ship the column + the AI-side read; the UI to populate it can land later. (If the principal wants a stub setter in PR 3.4 for testing, the LOC delta is ~30 with a Zod-validated server action.)

### D5. Read-side helper

The mapping callsites need to read `business_context` from the project row before building the prompt. Recommend a tiny helper inside `runMappingGeneration` / `runMappingGenerationForPair` that does a single `supabase.from('projects').select('business_context').eq('id', projectId).maybeSingle()` and treats both `null` and empty string as "absent". DO NOT thread it through `buildAIContext` — that's an unrelated concern (`buildAIContext` already handles documents-from-storage; project-row metadata is separate). Inline read keeps the change scope tight.

### D6. RPC-layer alternative — rejected

Considered: a new `get_project_business_context(p_project_id UUID)` RPC. Rejected because the existing `projects` table has perfectly adequate RLS already (project_members + org gate), and adding an RPC just to read one column is over-engineering. The inline read in §D5 is sufficient.

---

## Section E — Eval coverage

### E1. Existing fixture

[`tests/eval/datasets/_fixture/examples/mapping/001-fixture.json`](../../tests/eval/datasets/_fixture/examples/mapping/001-fixture.json) — 19 LOC. Two gold mappings: `id → id`, `name → label`, both `single`. Trivial fixture. Current AI_PHASE_2_ENABLED=1 baseline: score 1.000, ~$0.0454-$0.0461 per run (reported in Path 2 PR 1 / PR 12.1.5 telemetry).

### E2. New fixture proposal

`_fixture/examples/mapping/002-with-business-context.json`. Same `task: 'mapping'`, same `_fixture` schema (no schema migration needed). Adds `metadata.business_context: "..."` so the loader can populate `projects.business_context` during synthetic-project setup. Gold-label content: a mapping that's only DISCOVERABLE via the business_context (e.g., a target field `customer_tier` where the rationale "we use platinum/gold/silver tiers" only appears in business_context, not in field names or sample values).

The existing `synthetic-context-builder.ts` populates the project row during setup; extending to populate `business_context` is mechanical (one line). If the loader currently doesn't read a `metadata.business_context` field, that's a small loader change in Phase B.

### E3. Re-baseline plan

Run AI_PHASE_3_ENABLED=1 against `001-fixture` first. Expected:
- Score: unchanged (1.000 — the fixture is unambiguous, agent loop has no evidence to discover).
- Cost: ~$0.50-2.00 per run (Opus 4.7 + adaptive thinking + max effort + 4-iteration loop with caching). Confirms the LOCK #1 cost expectation.
- Telemetry: 4-row chain in `llm_calls` per fixture (one per iteration), `metadata.agent_loop: true` on each.

Then run against `002-with-business-context`. Expected:
- Score: ≥ AI_PHASE_2_ENABLED=1 baseline on the same fixture (or document the gap).
- Cost: similar to 001 under flag-ON.

### E4. Methodology callout (per Path 2 PR 1 lessons)

These fixtures are smoke tests, NOT benchmarks. Score 1.000 on a 2-mapping fixture is a non-regression signal, not evidence of agent-loop quality lift. Phase 3.8 lift measurement requires a real eval cohort (≥30 examples with adversarial cases). Path 2 fixtures stay in-repo as smoke; the cohort lives in a separate dataset directory and is exercised manually.

The fixture is also vulnerable to the "synthetic gold-labels trap" called out in PR 18 retrospective: if the fixture's gold mapping was authored by the same model under test, score 1.000 means "model agrees with model" — not "model agrees with ground truth". For `001-fixture` this is acceptable because the gold is trivial (`id → id`, `name → label`). For `002-with-business-context`, recommend authoring the gold mapping by hand (or with a different model family) to break the loop. Document this in the fixture's `metadata.author` field.

### E5. Cost-attribution sanity check

The eval runner reads cost via `sumLlmCallsCost({ projectId, sinceMs })` ([`runner.ts:516-519`](../../lib/eval/runner.ts#L516-L519)) — sums all `llm_calls.cost_usd` rows for the synthetic project since just before the fixture started. Agent-loop adoption produces 4-8 `llm_calls` rows per fixture (one per iteration + any tool-loop chain). The `sumLlmCallsCost` query naturally includes all of them — no instrumentation change needed. Verification: run `001-fixture` flag-ON, then `SELECT COUNT(*) FROM llm_calls WHERE project_id = '<synth>' AND feature = 'eval_mapping'` — count should equal the agent's `iterations` field.

### E6. Per-iteration cache-hit telemetry

Per design §D1 the verification gate is `cache_read_input_tokens > 0` on iteration N for N > 1. The `llm_calls` schema already has the `cache_read_tokens` column (PR 13.1). After running the eval fixture, query: `SELECT id, cache_read_tokens FROM llm_calls WHERE project_id = '<synth>' AND parent_call_id IS NOT NULL ORDER BY created_at` — every non-head row should show non-zero `cache_read_tokens`. If the head row's prefix didn't make it into the cache (e.g., prompt-version drift, schema-rewrite mid-loop), this query catches it.

---

## Section F — Risks and divergences

### F1. Risk catalog

| ID | Risk | Verification gate |
|---|---|---|
| R1 | Heritage byte-identical regression. Editing the flag-OFF branch (even a refactor) breaks the SHA-256 fingerprint. | `RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1 pnpm test:integration tests/integration/mappings-for-redesign-heritage.test.ts` — must produce zero diff against PR #23 baseline. Run before AND after Phase B edits. |
| R2 | Agent loop infinite-iteration / cost runaway under buggy tool handler. | Hard caps: `maxIterations: 8`, `maxCostUsd: 1.0`, `maxWallClockMs: 120_000` (`agent-loop.ts:122-124`). Phase B unit test exercises each cap via `dryRun` mock (LOCK #4). |
| R3 | Anthropic strict-mode 503 on 4-tool registration (per design §D2). | Phase B integration smoke registers all 4 tools; if 503 recurs, document per known-issues protocol and lower max-tools-per-call (drop one of the data tools — CROSS_FIELD_CORRELATION is the most expensive schema). |
| R4 | Token-budget overflow. Bumping samples 5→50 + business_context + tool-use guidance + schema overview could approach 200K tokens on large schemas. | Phase B captures `input_tokens` from the first iteration's `llm_calls` row on `001-fixture` and `002-with-business-context`; flag if > 150K. With per-field 50 source / 30 target as recommended, real-world projects (10 source × 30 fields × 50 values × 12 chars ≈ 180K chars in samples alone) ARE at risk. Mitigation: tighten `maxSampleValues` cap or fall back to row-tuple sampling per §C4. |
| R5 | Eval lift measurement does not actually exercise agent loop (D-3). | Per §F2, decide BEFORE Phase B whether to wire the agent loop at the single-pair callsite (eval reaches it), the bulk callsite (eval doesn't), or both. |
| R6 | `CallLLMOptions` extension for thinking/effort breaks every existing callsite under tsc if the new fields are required (D-1). | Add as OPTIONAL fields. Compile-only change for non-adopters. Audit `lib/ai/llm-client.ts` `MessageCreateParamsNonStreaming`/`Streaming` to confirm `thinking` is a valid SDK field (Anthropic SDK 0.78+ exposes it; verify in Phase B). |
| R7 | `AI_PHASE_3_ENABLED=1` cost spike on flag flip. Single-shot $0.045 → agent $0.50-2.00 = 10-40× per call. | Phase B documents the spike in CLAUDE.md §4.5.1 (alongside the existing `AI_PHASE_2_ENABLED` description). Operational guidance: keep flag OFF in production until cohort eval validates lift. |
| R8 | Heritage flag-OFF AST change. Even a no-op formatting change to the flag-OFF branch fails the heritage gate. | Phase B's diff must show the flag-OFF branch is literally unchanged; the new agent path goes inside an `if (phase3Enabled) { ... } else { /* original code, untouched */ }` wrapper. Reviewer checks `git diff` against the original block. |

### F1a. Risk-by-risk verification recipe

- **R1 heritage gate.** Run the heritage test pre-edit (capture baseline JSON), apply Phase B edits, re-run. CAPTURE-mode JSON on both runs must be byte-identical when `AI_PHASE_3_ENABLED` is unset. Diff displayed inline by the test on mismatch — every divergent field is named.
- **R2 cost runaway.** Unit test in `tests/lib/agent-loop.test.ts` already exercises max_cost via `dryRun.mockResponder` with synthetic `costUsd`. PR 3.4 adds an integration smoke that registers a real handler returning oversized result text and asserts `kind: 'aborted', reason: 'max_cost'` within budget.
- **R3 503s.** Phase B integration smoke (env-gated, $0.10 budget) registers all 4 tools; if 503 recurs, the smoke fails loud. No retry-with-backoff in PR 3.4 — known-issues protocol applies (PR 12.2 B-2 cataloged the trigger conditions).
- **R4 token budget.** Capture `input_tokens` from the first iteration's `llm_calls` row on `001-fixture` and `002-with-business-context`. Hard fail (manual review) if > 150K. Budget headroom: 200K total, 150K threshold gives ~50K buffer for the conversation accumulation across iterations.
- **R5 eval lift signal.** Per §F2, both callsites are wired. Phase 3.8 lift comparison across `mapping/001-fixture` (flag-OFF cost) vs (flag-ON cost) must show: (a) score ≥ 1.000 (no regression), (b) cost increase within the 10-40× expected band — anything outside that range is a measurement / wiring bug, not real lift.
- **R6 SDK validation.** Before merging PR 3.4a, manually verify the Anthropic SDK version (`@anthropic-ai/sdk` package.json pin) accepts both `thinking` and `output_config.effort: 'max'` — the `'max'` value is documented for Claude 4.x but not all SDK versions expose it. If SDK is too old, scope the bump into 3.4a.
- **R7 cost spike documentation.** Update `CLAUDE.md` §4.5.1 in PR 3.4b: extend the `AI_PHASE_3_ENABLED` description to note "10-40× per-call cost increase on adopted callsites; default OFF in production until cohort eval validates lift".
- **R8 AST stability.** Final review step before merging PR 3.4b: paste the original `mapping_generate` block (the `try { primaryResult = await callLLM(...) } catch { ... }` at [`mapping-engine.ts:1502-1529`](../../lib/ai/mapping-engine.ts#L1502-L1529)) into the post-edit file's `else` branch and `git diff`. Zero diff is the gate.

### F2. The two-callsite question (D-3) — recommendation

**Recommend wiring the agent loop into BOTH `runMappingGeneration` AND `runMappingGenerationForPair`.** Rationale:
1. The eval runner exercises the single-pair function. Without wiring it, Phase 3.8 lift measurement is impossible.
2. The two functions duplicate the same core pattern (build context → callLLM with EMIT_TABLE_MAPPINGS_TOOL → persist). Wiring both is symmetrical.
3. LOC delta of wiring both vs. one is small (~+50 LOC additional vs. ~+150 single).
4. Heritage gate fingerprints the read path; both write paths feed it; risk of drift is identical for both.

The alternative (wire only the bulk path, change the eval to call the bulk function) would force a structural change to the eval runner (`runMappingGenerationForPair` → `runMappingGeneration`, then read back the inserted single-pair mappings from a multi-pair output). That's a larger, more invasive change than wiring both production callsites.

---

## Section G — Implementation order and PR slicing

### G1. Recommended PR shape: 3.4a + 3.4b split

**PR 3.4a (plumbing, ~+200 / -10 LOC):**
- Migration 086 (business_context column + comment).
- `CallLLMOptions` extension: add `thinking?: { type: 'adaptive' | 'enabled' | 'disabled' }` and `output_config?: { effort?: 'high' | 'max' }` as optional fields. Wrapper request body honors them.
- `RunAgentLoopOptions.llmOptions` Pick widened to include the new fields.
- `ContextScope` extension: add `maxSourceSampleValues` / `maxTargetSampleValues` (D-5).
- `formatSchemaForPrompt` extension: render FK reference + check_constraint + default_value + description on target side (§C5, drop synonyms).
- `MAPPING_GENERATION_AGENT_SYSTEM_PROMPT` exported alongside the original.
- Verification: tsc + heritage gate + flag-OFF eval pre-flights ($0). NO production behavior change.
- Spend: $0.

**PR 3.4b (callsite wiring, ~+250 / -0 LOC):**
- Wire `runAgentLoop` into BOTH `runMappingGeneration` and `runMappingGenerationForPair`, gated on `AI_PHASE_3_ENABLED=1`.
- Schema-overview prelude + business-context prelude in user-message builder.
- New eval fixture `mapping/002-with-business-context.json`.
- Loader extension to populate `projects.business_context` during synthetic-project setup.
- Verification: tsc + heritage + flag-OFF byte-identical + flag-ON regression on 001-fixture + flag-ON eval on 002.
- Spend: ~$0.30-0.50 (re-baseline + new fixture × Opus max-effort).

**Why split:** PR 3.4a is mostly mechanical and risk-free (CallLLMOptions widening, schema column, prompt-format additions). It can land + be heritage-gated independently. PR 3.4b is the load-bearing change (gate + agent-loop integration); it carries the eval lift signal and the AST-stability proof. Splitting lets the principal review the plumbing once and the wiring once, instead of reading +450 LOC in one diff.

**Single-PR alternative (~+450 LOC):** acceptable if the principal prefers fewer review rounds. The split is a recommendation, not a requirement.

### G2. Total LOC delta (sum of 3.4a + 3.4b)

| File / change | LOC |
|---|---|
| `supabase/migrations/086_project_business_context.sql` | +6 |
| `lib/ai/llm-client.ts` (CallLLMOptions extension + request-body plumbing) | +30 |
| `lib/ai/agent-loop.ts` (Pick widening) | +2 |
| `lib/ai/context-builder.ts` (ContextScope + per-role samples + new SELECT cols) | +30 |
| `lib/ai/context-builder.ts` (formatSchemaForPrompt enrichment) | +25 |
| `lib/ai/mapping-engine.ts` (MAPPING_GENERATION_AGENT_SYSTEM_PROMPT + tool-use guidance) | +80 |
| `lib/ai/mapping-engine.ts` (`runMappingGeneration` agent gate) | +60 |
| `lib/actions/mappings.ts` (`runMappingGenerationForPair` agent gate) | +60 |
| `lib/ai/mapping-engine.ts` / `lib/actions/mappings.ts` (schema-overview + business-context preludes) | +50 |
| Eval fixture `mapping/002-with-business-context.json` | +25 |
| Eval loader extension for `business_context` propagation | +15 |
| `tests/lib/llm-client.test.ts` (thinking/effort plumbing tests) | +30 |
| `tests/lib/mapping-engine.test.ts` (system-prompt + agent-gate unit tests) | +40 |
| `tests/integration/mapping-agent-end-to-end.test.ts` (env-gated smoke) | +60 |
| **Total** | **~+513** |

Slightly over the prompt's "+800 to +1200 net" estimate ceiling — actually under. The lock-conformant design is more compact than originally feared, mostly because §C5 drops "synonyms" and §C4 picks per-field values over tuple rows (otherwise +200 LOC for the row-sampling subsystem).

### G2a. Per-file change ledger (cross-reference for the principal)

The full set of files touched, in dependency order:

1. **`supabase/migrations/086_project_business_context.sql`** — NEW, +6 LOC. Self-contained `ALTER TABLE` + `COMMENT ON COLUMN`.
2. **`lib/ai/llm-client.ts`** — modify `CallLLMOptions` interface (~+15 LOC, optional fields), modify request-body builders in both `callLLM` and `callLLMStreaming` (~+15 LOC each branch, total +30 LOC including streaming). Streaming variant is required even though no streaming callsite uses agent loop today — the type surface must be uniform or the wrapper diverges across modes.
3. **`lib/ai/agent-loop.ts`** — extend the `Pick` at [`agent-loop.ts:83`](../../lib/ai/agent-loop.ts#L83) to include `'thinking' | 'output_config'`. ~+2 LOC. Pure type widening — runtime behavior unchanged because `runAgentLoop` already spreads `opts.llmOptions` into the `callLLM` call.
4. **`lib/ai/context-builder.ts`** — extend `ContextScope` interface, default values, and the field-profile loop. ~+30 LOC. New SELECT columns (`default_value`, `description`) require the per-field rendering branch in `formatSchemaForPrompt` to be widened too.
5. **`lib/ai/context-builder.ts`** — `formatSchemaForPrompt` enrichment for target fields (FK reference, check constraint, default, description). ~+25 LOC. The source-side rendering stays unchanged; this is target-only.
6. **`lib/ai/mapping-engine.ts`** — add `MAPPING_GENERATION_AGENT_SYSTEM_PROMPT` constant (+80 LOC of guidance text appended to the existing `MAPPING_GENERATION_SYSTEM_PROMPT`).
7. **`lib/ai/mapping-engine.ts`** — wrap [`mapping-engine.ts:1503-1525`](../../lib/ai/mapping-engine.ts#L1503-L1525) `callLLM` invocation in the `if (phase3Enabled) { runAgentLoop(...) } else { callLLM(...) }` gate. The `else` branch is byte-unchanged. ~+60 LOC.
8. **`lib/actions/mappings.ts`** — same gate around [`mappings.ts:219-238`](../../lib/actions/mappings.ts#L219-L238). ~+60 LOC. Single-pair version doesn't have the `<other_source_tables>` block, so the agent path's user-message has one less section but is otherwise identical to the bulk version.
9. **`lib/ai/mapping-engine.ts` + `lib/actions/mappings.ts`** — schema-overview prelude (computed in a small helper, called from both callsites) + business-context prelude (read from the project row, conditional). ~+50 LOC total split across the two files.
10. **`tests/eval/datasets/_fixture/examples/mapping/002-with-business-context.json`** — NEW, ~+25 LOC. Fixture body + `metadata.business_context`.
11. **`lib/eval/synthetic-context-builder.ts`** — propagate `metadata.business_context` from fixture into the synthetic project row during setup. ~+15 LOC.
12. **`tests/lib/llm-client.test.ts`** — assertion that `thinking` and `output_config.effort` reach the SDK request body. ~+30 LOC of source-level invariants.
13. **`tests/lib/mapping-engine.test.ts`** — assertion that the agent-mode system prompt contains the tool-use guidance section + assertion that the flag-OFF branch is unchanged. ~+40 LOC.
14. **`tests/integration/mapping-agent-end-to-end.test.ts`** — env-gated smoke ($0.10 budget, runs 4-tool registration + asserts cache_read on iter 2+). ~+60 LOC.

Files NOT touched (load-bearing locked surface, reaffirmed):
- `lib/ai/agent-tools.ts` — PR 3.3 surface, frozen.
- `lib/ai/tool-schemas.ts` — no new tools (LOCK §SCOPE constraint).
- `supabase/migrations/085_agent_data_scanning_rpcs.sql` — PR 3.3 surface, frozen.
- All non-mapping callsites — they continue to use `callLLM` single-shot. Phase 3 adoption beyond `mapping_generate` is PR 3.5+ scope.

### G3. Verification gate per PR (consolidated)

Both 3.4a and 3.4b must pass:
1. `pnpm tsc --noEmit` clean.
2. `pnpm vitest run` — full suite passing (baseline + new tests). PR #23 test count delta tracked.
3. `RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1 pnpm test:integration tests/integration/mappings-for-redesign-heritage.test.ts` byte-identical to PR #23 baseline.
4. Flag-OFF eval pre-flights at $0 (the 6-eval pre-flight suite from PR 3.2 / PR 3.3).
5. Flag-ON regression on `mapping/001-fixture` (3.4b only) — score must remain 1.000.
6. Flag-ON eval on `mapping/002-with-business-context` (3.4b only) — score baseline captured for future regressions.
7. `git diff` review confirms the flag-OFF branch in both `runMappingGeneration` and `runMappingGenerationForPair` is byte-unchanged (stronger gate than the read-path heritage test alone).

---

---

## Out of scope (per LOCK § SCOPE)

- Adding new tools beyond the locked 4 (3 data + 1 answer).
- Changes to `agent-loop.ts` runtime behavior (PR 3.2 surface).
- Changes to `agent-tools.ts` factories or migration 085 RPCs (PR 3.3 surface).
- Self-consistency voting (Option A decision in design §D5).
- Streaming variant of the agent loop (design §C2 defers to PR 13.2+).
- Phase 3 adoption beyond `mapping_generate` (PR 3.5+ scope: `quality_detection_ai`, `validation_rule_from_nl`, `quality_fix_options`, `transform_generate`).
- Target-side data-scanning RPCs (PR 3.4.5 if eval shows need).
- Cohort eval against ≥30 examples (Phase 3.8 work).
- UI-side surface to populate `projects.business_context` (product follow-up).

## Open questions for the principal

1. **Tuple-row sample interpretation (D-4).** Confirm: are LOCK #5 ("50 per source table") and LOCK #6 ("30 per target table") per-FIELD value counts (recommended, mechanical bump) or per-TABLE row tuples (structural change, +200 LOC)?
2. **Single vs. split PR (G1).** Confirm preference: 3.4a + 3.4b split (recommended for review clarity) vs. single PR (faster, less review overhead).
3. **Synonyms field (D-6).** No `synonyms` column exists on `fields`. Drop from LOCK #7 or scope a separate migration to add it?
4. **`business_context` write-side surface (D4).** Should PR 3.4 include a stub setter for testing the prompt path, or strictly read-only consumption?
5. **Cost-spike communication.** Should `AI_PHASE_3_ENABLED=1` ship with a hard runtime cost cap (per-project / per-day) on top of the agent loop's per-call `maxCostUsd`, or rely on operational discipline (flag stays OFF in production)?

---

*End of PR 3.4 Phase A investigation.*
