# PR 13 — Anthropic prompt caching (Phase A investigation, read-only)

**Type:** Read-only investigation. The only artifact this phase produces is this document.

**Audience:** Phase B implementer + Kaan for sign-off.

**Scope:** Audit the SDK + wrapper + 26 consolidated callsites for prompt-caching readiness. Recommend a placement strategy and implementation phasing.

**Out of scope:** Phase B implementation; cache-effectiveness dashboard work; batch API (separate Anthropic feature).

---

## DIVERGENCE callouts (load-bearing — read first)

1. **Observability is already 100% wired end-to-end.** Migration 082 declares `cache_read_tokens` and `cache_creation_tokens` columns ([082_llm_calls.sql:42-43](../../supabase/migrations/082_llm_calls.sql#L42-L43)). The wrapper at [lib/ai/llm-client.ts:398-399](../../lib/ai/llm-client.ts#L398-L399) (callLLM) and [llm-client.ts:572-573](../../lib/ai/llm-client.ts#L572-L573) (callLLMStreaming) ALREADY extract `cache_creation_input_tokens` + `cache_read_input_tokens` from SDK responses and persist them. **PR 13 does not need any observability work** — the moment caching is enabled at the request layer, the existing log rows will surface hit/miss counts.

2. **Pricing model is locked in [lib/ai/pricing.ts](../../lib/ai/pricing.ts).** Per-model `cacheRead` and `cacheCreation` rates are configured for both Sonnet 4.6 and Opus 4.7. `computeCostUsd` already factors them into `cost_usd`. Caching cost reflects automatically in the daily cost report.

3. **SDK 0.78.0 supports `cache_control: { type: 'ephemeral' }` natively** on the stable (non-beta) message API. The marker is accepted on every relevant content-block type — TextBlockParam, Tool, ToolResultBlockParam, etc. No SDK upgrade required.

4. **PR 13's actual scope is narrower than the prompt suggests.** Phase A's prompt asked about API state, observability, cost model — all three are SOLVED. The remaining work is: **(a) thread `cache_control` markers through the wrapper, (b) flip the marker on for high-cache-fit features, (c) measure hit rates over 1-2 weeks via the existing `llm_calls` columns.** That's it.

---

## TL;DR

| Question | Answer |
|---|---|
| SDK supports prompt caching for sonnet-4-6 / opus-4-7? | ✅ Yes — `cache_control: { type: 'ephemeral' }` on stable API |
| Observability columns exist in `llm_calls`? | ✅ Yes — migration 082 added `cache_read_tokens` + `cache_creation_tokens` |
| Wrapper already extracts cache usage from SDK responses? | ✅ Yes — both `callLLM` and `callLLMStreaming` |
| Pricing model accounts for cache reads/writes? | ✅ Yes — `cacheRead` (10% of input) + `cacheCreation` (1.25x input) per model |
| System prompts are static across invocations? | ✅ Yes — declared as module-level constants at most callsites |
| Tools are static? | ✅ Yes — constants in [tool-schemas.ts](../../lib/ai/tool-schemas.ts) (1571 LOC) |
| Wrapper change required? | YES — `system: string` → `system: [{ type: 'text', text, cache_control }]`, and `tools[].cache_control` plumbing |
| Recommended strategy? | **Strategy C — phased rollout**: enable cache_control on 4-6 highest-volume High-fit features; measure 2 weeks; expand based on actual hit rates |

**Recommendation: Strategy C, Phased rollout.** Initial PR enables `cache_control` on the wrapper + flips it on for 4-6 high-volume High-fit features. Gather 2 weeks of measurement via the existing `llm_calls.cache_read_tokens / cache_creation_tokens` columns. Expand to remaining High-fit features in PR 13.2 once net cost reduction is empirically proven on the initial cohort.

---

## Section 1 — Anthropic prompt caching state

### Cache marker placement (SDK 0.78.0, stable API)

`cache_control: { type: 'ephemeral' }` is accepted on:
- **TextBlockParam** ([messages.ts:259](../../node_modules/@anthropic-ai/sdk/src/resources/messages/messages.ts)) — for system prompts when expressed as content-block array, and for user-message content blocks
- **Tool** (Anthropic API definitions) — caches the tool definition itself (description + input_schema)
- **ToolResultBlockParam** — caches tool-call output (not relevant to Settle's single-shot pattern)
- **ImageBlockParam / DocumentBlockParam** — for cached image/document inputs (not relevant to Settle)

Settle's relevant breakpoints reduce to **system + tool** (2 of the available 4).

### Minimum cacheable size

Per Anthropic's prompt-caching documentation: **1024 tokens minimum per cached prefix** for Sonnet/Opus models. Below threshold, the marker is silently ignored (no error, just no caching). Settle's per-feature audit (§3) shows most system+tool combinations exceed this floor easily; the few that don't are flagged.

### Maximum cache breakpoints per request

**4 breakpoints maximum** per request. Settle's typical use is 1-2 (system + tool). Headroom exists for Phase 2+ if user-message-prefix caching becomes desirable.

### TTL

**5 minutes default**, refreshed on each cache hit. A 1-hour TTL exists in beta (`ephemeral_1h_input_tokens` per [messages.ts:388](../../node_modules/@anthropic-ai/sdk/src/resources/beta/messages/messages.ts#L388)) but Settle should default to 5min — it matches typical user-session locality (a user generating mappings, then transformations, then validations within minutes of each other).

### Cost model (verified from [lib/ai/pricing.ts](../../lib/ai/pricing.ts))

| Model | Input ($/Mt) | Output ($/Mt) | Cache Read ($/Mt) | Cache Write ($/Mt) | Read multiplier | Write premium |
|---|---|---|---|---|---|---|
| `claude-sonnet-4-6` | 3.00 | 15.00 | 0.30 | 3.75 | **0.10×** | **1.25×** |
| `claude-opus-4-7` | 5.00 | 25.00 | 0.50 | 6.25 | **0.10×** | **1.25×** |

**Break-even calculation:** when caching is enabled and the prefix is N tokens:
- 1st invocation: writes N at 1.25× = 1.25N cost units
- Each subsequent hit: reads N at 0.10× = 0.10N cost units
- After 1 write + K reads: cost = 1.25N + 0.10NK = N(1.25 + 0.10K)
- Without caching: cost = N(K+1) = N + NK
- Net savings when N(K+1) > N(1.25 + 0.10K) → K + 1 > 1.25 + 0.10K → 0.90K > 0.25 → **K > 0.28**, i.e., the cache must be hit at least once per write to break even
- **Practical break-even hit rate: 25%.** With Anthropic's 5-min TTL, this is achievable for any feature invoked more than ~once per 5min in user sessions.

### Tool-use compatibility

Confirmed via SDK types: `Tool` interface accepts `cache_control: CacheControlEphemeral | null`. Tool caching is fully supported.

### Streaming compatibility

Cache control is REQUEST-side, not response-side. Streaming + caching is supported identically to non-streaming. The `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` fields are populated on the final message regardless of streaming mode.

---

## Section 2 — Wrapper audit

### Current request shape (callLLM at [llm-client.ts:362-388](../../lib/ai/llm-client.ts#L362-L388))

```typescript
const request: Anthropic.MessageCreateParamsNonStreaming = {
  model,
  max_tokens: maxTokens,
  system: opts.systemPrompt,                       // STRING (no cache_control possible)
  messages: [{ role: 'user', content: opts.userMessage }],
  ...(effort && { output_config: { effort } }),
  ...(opts.tool && {
    tools: [opts.tool],                            // Tool object (passed as-is — no cache_control set)
    tool_choice: { type: 'tool', name: opts.tool.name, disable_parallel_tool_use: true },
  }),
}
```

### Required wrapper changes for cache_control

**System prompt (string → content-block array):**

```typescript
// Current:
system: opts.systemPrompt,

// Cache-enabled (when opts.cacheControl is set):
system: [
  {
    type: 'text',
    text: opts.systemPrompt,
    ...(opts.cacheControl && { cache_control: { type: 'ephemeral' } }),
  },
],
```

The SDK accepts BOTH string AND content-block array forms for `system` — the change is non-breaking on the API side but is a wrapper-shape change observable to anything that reads requests (none in Settle's codebase).

**Tool definition (cache_control field on Tool itself):**

```typescript
// Current:
tools: [opts.tool],

// Cache-enabled:
tools: [
  {
    ...opts.tool,
    ...(opts.cacheControl && { cache_control: { type: 'ephemeral' } }),
  },
],
```

The `Tool` interface in [tool-schemas.ts](../../lib/ai/tool-schemas.ts) (`type Tool = { name, description, strict, input_schema }`) does not currently include `cache_control`, but the SDK accepts it as an optional field — direct spread + conditional addition works without modifying the per-tool definitions.

### `CallLLMOptions` extension

Add an opt-in flag — preserves byte-identical flag-OFF behavior for any caller that doesn't set it:

```typescript
export interface CallLLMOptions {
  // ... existing fields ...
  /**
   * PR 13: opt into Anthropic prompt caching. When true, sets
   * cache_control: { type: 'ephemeral' } on the system prompt and
   * (when present) on the tool definition. Cache reads/writes are
   * recorded automatically via the existing
   * cache_read_tokens / cache_creation_tokens columns.
   *
   * Defaults to false. Enable per-callsite based on cache-fit audit
   * (docs/investigations/pr13-prompt-caching.md §3).
   */
  cacheControl?: boolean
}
```

**Net wrapper LOC:** ~30-40 (system shape change in both callLLM + callLLMStreaming, tool spread, optional field addition, JSDoc).

### Wrapper changes are byte-identical when `cacheControl` is unset

Since the new flag defaults to false and the system/tool spread is conditional, callers that don't opt in see ZERO behavior change. Heritage flag-OFF byte-identical preserved.

---

## Section 3 — Per-feature cache-fit audit

### Methodology

For each of 26 callsites, classify by:
- **System prompt size** — `small <500 tokens`, `medium 500-2000`, `large >2000`. Estimated from line counts of `*_SYSTEM_PROMPT` constants (rough: ~4 chars/token).
- **System prompt stability** — `static` (module-level constant, never changes per call) vs `dynamic` (built from per-project context).
- **Tool size** — when present; large tool descriptions in [tool-schemas.ts](../../lib/ai/tool-schemas.ts) (1571 LOC total across 16 tools) typically exceed the 1024-token cache floor.
- **Invocation pattern** — frequency + locality (within 5-min TTL window?).

### 16 JSON cluster (PR 12.1)

| Feature | System size | System stable? | Tool size | Locality | Cache fit |
|---|---|---|---|---|---|
| `mapping_generate` | medium | static | large (EMIT_TABLE_MAPPINGS_TOOL ~2.5K tk) | High (per-table batch) | **High** |
| `mapping_generate_repair` | medium | static | none (text retry) | Low (only on parse fail) | **Low** |
| `mapping_generate_legacy_pair` | medium | static | large (EMIT_FIELD_MAPPINGS_TOOL ~2K tk) | Medium (per-pair regen) | **High** |
| `mapping_generate_legacy_pair_repair` | medium | static | none | Low | **Low** |
| `mapping_suggest` | medium | static | medium (EMIT_MAPPING_SUGGESTION_TOOL ~1.2K tk) | Medium (per-target field) | **High** |
| `mapping_suggest_legacy_bulk` | medium | static | medium (EMIT_FIELD_MAPPINGS_TOOL) | Medium | **High** |
| `nl_suggest_queries` | small | static | small (EMIT_QUERY_SUGGESTIONS_TOOL ~700 tk) | Low (per-session, ~1×) | **Medium** (system+tool together likely under 1024 tk floor) |
| `migration_intelligence` | large (EXTRACTION_SYSTEM_PROMPT + canonical bullets) | static | large (EMIT_EXTRACTED_PATTERNS_TOOL ~3.5K tk) | Low (~1× per project completion) | **Medium** (high content size, low locality) |
| `quality_detection_ai` | large (AI_DETECTION_SYSTEM_PROMPT) | static | large (EMIT_QUALITY_ISSUES_TOOL ~2.5K tk) | High (per-table scan, batched) | **High** |
| `validation_rule_from_nl` | small-medium | static | medium (EMIT_VALIDATION_RULE_TOOL ~2.5K tk) | Medium (per-rule auth) | **High** |
| `ddl_parsing` | medium (DDL_PARSE_SYSTEM) | static | large (EMIT_PARSED_DDL_TOOL ~3.5K tk) | High (per-DDL doc, batched at onboarding) | **High** |
| `quality_fix_options` | large (SQL safety rules) | static | large (EMIT_FIX_OPTIONS_TOOL ~4K tk with 5-condition rubric) | Medium (per-issue) | **High** |
| `schema_enrichment` | medium (ENRICHMENT_SYSTEM_PROMPT) | static | medium (EMIT_SCHEMA_CORRECTIONS_TOOL ~2K tk) | High (per-table during onboarding) | **High** |
| `schema_merge_ai_match` | small-medium | static | medium (EMIT_TABLE_MATCHES_TOOL ~1.2K tk) | High (per-merge batch) | **High** |
| `outputs_migration_runbook` | medium (RUNBOOK_SYSTEM_PROMPT) | static | large (EMIT_MIGRATION_RUNBOOK_TOOL ~3.5K tk) | Low (~1× per package generation) | **Medium** |
| `ddl_conversion` | medium (DDL_CONVERT_SYSTEM) | static | none (stay-text per PR 12.2 B-2) | Medium (per-doc) | **Medium** (system-only ~600 tk; under 1024 floor) |

### 4 SQL emitter (PR 12.2 B-1)

| Feature | System size | System stable? | Tool size | Locality | Cache fit |
|---|---|---|---|---|---|
| `nl_to_sql` | large (schema + per-question dynamic context) | **dynamic** (schema injected per call) | medium (EMIT_SQL_QUERY_TOOL ~1.7K tk) | High (per query, fast iteration) | **Low** (system varies per project schema; tool alone is ~1.7K tk so tool-only caching is viable) |
| `nl_to_sql_retry` | same as primary | dynamic | medium (same tool) | Low (only on retry) | **Low** |
| `transform_generate` | huge (TRANSFORM_SYSTEM_PROMPT ~5K tk) | static | medium (EMIT_TRANSFORM_SQL_TOOL ~2K tk) | High (per-field, batched) | **High** |
| `manual_fix` | large (DML safety rules) | static | medium (EMIT_FIX_SQL_TOOL ~2K tk) | Medium (per-fix request) | **High** |

### 5 stay-text (PR 12.2 B-2)

| Feature | System size | System stable? | Tool size | Locality | Cache fit |
|---|---|---|---|---|---|
| `outputs_readiness_report` | medium (per-bundle systemPrompt) | dynamic (bundle-built) | none | Low | **No value** |
| `outputs_execution_package_monolithic` | medium (per-bundle) | dynamic | none | Low | **No value** |
| `outputs_execution_package_fallback` | medium (per-bundle) | dynamic | none | Low | **No value** |
| `transform_describe` | small (SUGGEST_SYSTEM_PROMPT) | static | none | Medium (per-field) | **No value** (system is small <500 tk; below floor) |
| `ddl_conversion` (counted above as JSON cluster) | — | — | — | — | (already classified) |

### 1 streaming (PR 12.3)

| Feature | System size | System stable? | Tool size | Locality | Cache fit |
|---|---|---|---|---|---|
| `outputs_execution_package_compartmentalized` | medium (per-bundle) | dynamic | medium (EMIT_COMPARTMENTALIZED_PACKAGE_TOOL ~2K tk) | Low (~1× per package) | **Medium** (tool-only caching viable; system varies) |

### Verdict summary

- **High cache fit (10 features):** `mapping_generate`, `mapping_generate_legacy_pair`, `mapping_suggest`, `mapping_suggest_legacy_bulk`, `quality_detection_ai`, `validation_rule_from_nl`, `ddl_parsing`, `quality_fix_options`, `schema_enrichment`, `schema_merge_ai_match`, `transform_generate`, `manual_fix` — actually **12 features**
- **Medium cache fit (5 features):** `nl_suggest_queries`, `migration_intelligence`, `outputs_migration_runbook`, `ddl_conversion`, `outputs_execution_package_compartmentalized`
- **Low cache fit (3 features):** `mapping_generate_repair`, `mapping_generate_legacy_pair_repair`, `nl_to_sql`/`nl_to_sql_retry` (dynamic system prompts) — **4 if both NL→SQL counted**
- **No value (3 features):** `outputs_readiness_report`, `outputs_execution_package_monolithic`, `outputs_execution_package_fallback`, `transform_describe` — **4 features**

12 of 26 features are clear High-fit candidates with static system prompts + cacheable tool schemas exceeding the 1024-token floor. Most have invocation locality within the 5-minute TTL window (per-table/per-field batching during onboarding flows).

---

## Section 4 — Cache placement strategy

### Strategy A — Aggressive (mark all 26 callsites)

**Pros:** maximize potential savings; one-time wrapper change applies everywhere.
**Cons:**
- 4 features (readiness/monolithic/fallback/transform_describe) provide zero cache value — wasted complexity
- 4 features have dynamic system prompts (NL→SQL, stay-text bundles) — cache writes incur 1.25× cost without read potential
- Net: $0.25 of write-only cost per Low-fit invocation, no offsetting reads

**LOC:** ~30 wrapper + N callsite flag-flips (~26 callsites × 1 line each = ~26 LOC)
**Verification spend:** ~$0.50 (smoke each feature flag-ON)
**Risk:** Net negative on Low-fit features

### Strategy B — Selective (10-12 High-fit only)

**Pros:** confident net savings; predictable per-feature behavior.
**Cons:** leaves Medium-fit savings on the table; coordinated rollout.

**LOC:** ~30 wrapper + 12 callsite flag-flips = ~42 LOC
**Verification spend:** ~$0.30 (focused smokes)
**Risk:** Lower than A; misses Medium-fit upside

### Strategy C — Phased (3-5 highest-volume High-fit, then expand)

**Pros:**
- Real-data measurement informs Strategy B/A decision empirically
- Existing `llm_calls.cache_read_tokens / cache_creation_tokens` columns make measurement free
- Low blast radius
- Can ship with confidence

**Cons:** two PRs (PR 13.1 initial cohort + PR 13.2 expansion)

**Initial cohort (recommended for PR 13.1):**
1. `mapping_generate` — highest-volume (engine primary), large system + large tool, batched per-table
2. `quality_detection_ai` — per-table scan, large tool, locality within onboarding session
3. `transform_generate` — per-field batched, huge system prompt (~5K tk), highest single-call savings
4. `validation_rule_from_nl` — medium volume, small-but-nontrivial cache; tests the small-prefix path
5. (optional) `ddl_parsing` — onboarding burst pattern; tests the high-locality batch case

**LOC for PR 13.1:** ~30 wrapper + 4-5 callsite flag-flips = ~35 LOC
**Verification spend:** ~$0.10-0.15
**Measurement window:** 2 weeks of production data; aggregate cache hit rates per feature via `SELECT feature, SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(input_tokens) FROM llm_calls GROUP BY feature`

**PR 13.2 expansion criteria:** any feature in PR 13.1 cohort showing hit rate >25% (break-even) → roll out the remaining ~7 High-fit features. Hit rate <25% → revisit before expanding.

**Risk:** Lowest of the three. Empirically grounded.

### Recommendation: **Strategy C — Phased rollout**

Justified by:
1. Caching cost model is asymmetric (write penalty 1.25× vs read benefit 10×) — wrong choices have measurable downside
2. Settle's invocation patterns aren't yet representative at scale (small customer count); priors should be validated empirically
3. Existing observability makes phased measurement free
4. Lower blast radius if anything regresses

---

## Section 5 — Observability integration

**Status: ZERO new work required.**

### What's already in place

- `llm_calls.cache_read_tokens` (INT, nullable) — populated from `usage.cache_read_input_tokens ?? 0` per [llm-client.ts:398](../../lib/ai/llm-client.ts#L398)
- `llm_calls.cache_creation_tokens` (INT, nullable) — populated from `usage.cache_creation_input_tokens ?? 0` per [llm-client.ts:399](../../lib/ai/llm-client.ts#L399)
- Same population for streaming at [llm-client.ts:572-573](../../lib/ai/llm-client.ts#L572-L573)
- `cost_usd` already weights cache reads at 0.10× and writes at 1.25× via [computeCostUsd](../../lib/ai/pricing.ts#L72)

### Recommended ops query (no implementation work; just SQL for ops dashboard)

```sql
-- Per-feature cache effectiveness, last 14 days
SELECT
  feature,
  COUNT(*)                                AS invocations,
  SUM(input_tokens)                       AS total_input_tokens,
  SUM(cache_creation_tokens)              AS cache_writes,
  SUM(cache_read_tokens)                  AS cache_reads,
  CASE WHEN SUM(cache_creation_tokens) > 0
       THEN ROUND(SUM(cache_read_tokens)::numeric / SUM(cache_creation_tokens), 2)
       ELSE NULL END                      AS read_to_write_ratio,
  ROUND(SUM(cost_usd)::numeric, 4)        AS total_cost_usd
FROM llm_calls
WHERE created_at > NOW() - INTERVAL '14 days'
GROUP BY feature
ORDER BY total_cost_usd DESC;
```

**Break-even rule of thumb:** `read_to_write_ratio` > 0.28 means caching is net positive for that feature. Below that, caching is a net cost.

No cron job exists today — adding one is out of scope for PR 13.1 (the ad-hoc query above suffices for measurement).

---

## Section 6 — Cost projection

### Assumptions (must be validated by PR 13.1's 2-week measurement window)

- Settle currently has limited production traffic; absolute volumes unknown. Estimates below use synthetic per-project rates.
- A typical migration project triggers:
  - ~10-20 `mapping_generate` calls (batched per source table)
  - ~5-10 `quality_detection_ai` calls (per source table scan)
  - ~30-100 `transform_generate` calls (per target field with mapping)
  - ~5-15 `validation_rule_from_nl` calls (per user-authored rule)
  - ~1-3 `ddl_parsing` calls (onboarding bursts)

### Per-feature savings model (Sonnet 4.6 baseline)

For a 3000-token static prefix (system + tool combined):
- **No cache:** 3000 × 3.00 = $0.009 per call
- **Cache write (1st call):** 3000 × 3.75 = $0.01125 per call (+25%)
- **Cache read (subsequent):** 3000 × 0.30 = $0.0009 per call (-90%)

For a typical 10-call batch with 1 write + 9 reads:
- Without caching: 10 × $0.009 = $0.09
- With caching: $0.01125 + 9 × $0.0009 = $0.01935
- **Savings: $0.07065 (~78% reduction on cached prefix)**

For Opus 4.7 (1.67× base): savings scale proportionally.

### Conservative monthly projection (10 active projects/month)

Per project, summing cached savings across the 5-feature cohort: **~$0.75 saved per project** (Sonnet baseline). At 10 projects/month: **~$7.50/month savings**. At 100 projects/month (Series B trajectory): **~$75/month**.

**Implication:** monetary impact is small at current scale; the value of PR 13 is establishing the infrastructure + measurement loop, not immediate cost reduction. Net savings scale linearly with adoption.

### Break-even hit rate

Per Section 1 calculation: **>25% read/write ratio** is net positive. With 5-min TTL and Settle's per-table batching patterns, this floor is achievable for most High-fit features.

---

## Section 7 — Implementation phasing

### Recommended: 2 PRs

**PR 13.1 — Wrapper + initial cohort (this investigation's output):**
- Wrapper: add `cacheControl?: boolean` to `CallLLMOptions`; thread `cache_control` markers in both `callLLM` and `callLLMStreaming`
- Flip on for 4-5 highest-volume High-fit features (cohort listed in §4)
- 1-2 unit tests (verify wrapper sets cache_control when flag is true; absent when false)
- 1 integration test (verify cache_read_tokens/cache_creation_tokens populate after a real call)
- Heritage flag-OFF byte-identical (callsites that don't opt-in are unchanged)
- Estimated LOC: ~80-120 (wrapper + 5 callsite flips + tests + JSDoc)
- Estimated spend: ~$0.10-0.15

**PR 13.2 — Expansion (future, gated on PR 13.1 measurement):**
- After 2 weeks of `llm_calls` data: query the read-to-write ratio per cohort feature
- Confirm net positive; expand to remaining 7-8 High-fit features
- Optionally: add Medium-fit features (`migration_intelligence`, `outputs_migration_runbook`) if their sparse-locality math works out
- Estimated LOC: ~30-50 (mostly callsite flips)
- Estimated spend: ~$0.10

**Total phasing:** 2 PRs, ~150-170 LOC combined, ~$0.25 cumulative spend.

### NOT recommended: single PR all-26

Per Strategy A analysis (§4): wastes work on 4 No-value features and risks net cost on 4 Low-fit features. The phased approach is strictly better at minimal coordination cost.

---

## Section 8 — Risk assessment

### R1 — Cache writes cost more than reads; net negative if hit rate too low

Phase A's break-even is 25% read-to-write ratio. Below that, caching costs more than it saves.

**Verification:** PR 13.1's 2-week measurement window. The query in §5 surfaces hit rates per feature. Any feature below 25% gets removed from the cohort in PR 13.2.

### R2 — Cache invalidation on prompt changes

Editing `*_SYSTEM_PROMPT` constants invalidates all cached prefixes for that feature. Anthropic's cache key is content-hash-based — a single character change forces a re-write.

**Verification:** Phase B documents this explicitly in the wrapper JSDoc + a comment at the top of each cached `*_SYSTEM_PROMPT` constant: *"Editing this string invalidates the prompt cache. Expect a 1-day cost spike after deploys that touch this prompt."*

**Status:** Inherent to caching; managed via discipline + observability.

### R3 — Tool schema versioning

When tool schemas change in [tool-schemas.ts](../../lib/ai/tool-schemas.ts), all caches for that tool invalidate. Settle ships tool changes regularly (PR 12.1.5, PR 12.2 B-1) so this is non-trivial.

**Verification:** Each tool-schema-touching PR will see a temporary cost spike for affected features. Document this in the schema-change PR template; expect 1-day cache rewarming on deploy.

**Mitigation:** Combine schema changes when possible; avoid drip-feeding small edits.

### R4 — Streaming + caching corner cases

Less-tested combination than non-streaming. The 1 streaming callsite (`outputs_execution_package_compartmentalized`) is in the **Medium-fit** category — not in the PR 13.1 initial cohort. Caching is deferred for streaming until the non-streaming cohort proves out.

**Verification:** N/A in PR 13.1. PR 13.2 includes a dedicated streaming smoke if streaming features are added to the cohort.

### R5 — Production behavior under flag-OFF

Caching must be additive. Callers that don't opt in (the 21 features outside the cohort, plus all flag-OFF paths) must see byte-identical behavior.

**Verification:** Heritage flag-OFF integration test (existing gate). The wrapper's `cacheControl ?? false` default ensures unset callers see no behavior change.

### R6 — Test coverage without burning real spend

Cache hit verification requires real Anthropic calls (the SDK doesn't simulate cache hits in test mode).

**Verification:** Two-tier approach:
- **Unit tests (free):** verify the wrapper sets `cache_control: { type: 'ephemeral' }` on the request object when `cacheControl: true`. Use mocked Anthropic client; assert request shape only.
- **Integration test (~$0.05):** real Anthropic call with cache_control on; verify `usage.cache_creation_input_tokens > 0` (write) on first call; second identical call within 5min asserts `usage.cache_read_input_tokens > 0` (hit). Env-gated like existing `llm-calls-streaming-logging.test.ts`.

### R7 — Tool-use schema cache marker placement

Where exactly to put `cache_control`? The SDK accepts it on both `Tool` (caches the entire tool definition) AND on `TextBlockParam` content blocks within the system. For Settle, the recommendation is:
- **System prompt:** marker at the END of the system content-block array (caches everything before)
- **Tool:** marker on the Tool object directly (caches tool definition + description)

Both can be marked simultaneously; Anthropic uses the LATER marker for the cache breakpoint, with all content before it cached as a single prefix.

**Verification:** PR 13.1's wrapper unit tests assert the exact request shape. Anthropic's strict-mode validator rejects misplaced markers with a clear error.

### R8 — Anthropic pricing model shift

Pricing in [lib/ai/pricing.ts](../../lib/ai/pricing.ts) is a snapshot. If Anthropic changes the cache cost ratios, break-even shifts.

**Verification:** Pricing changes are reviewed PRs (per the file's docstring). Each change should re-validate the break-even threshold and flag affected features.

### R9 — Below-floor system prompts marked but ignored

Anthropic silently ignores `cache_control` on prefixes below ~1024 tokens. The wrapper marks the prompt regardless; if the prompt is too short, it's a no-op (no cost, no benefit).

**Verification:** Per-feature audit (§3) flagged 2-3 features near or below the floor (`nl_suggest_queries`, `transform_describe`, `ddl_conversion` system-only). These are excluded from PR 13.1; if added in PR 13.2, expect zero cache_creation_tokens in their measurement.

---

## Section 9 — Surprises / divergences

### Surprises

1. **The infrastructure is ENTIRELY in place.** Phase A's prompt assumed there'd be SDK research, observability gaps, pricing exploration. None of those needed work — migration 082, the wrapper's cache-token extraction, and pricing.ts's per-model rates ALL pre-date PR 13. Whoever wrote 082 + the pricing constants set this up to be flipped on later.

2. **Cache token extraction is already wired in BOTH callLLM and callLLMStreaming.** Both wrappers extract `cache_creation_input_tokens` and `cache_read_input_tokens` from `usage` and persist to `llm_calls`. Untouched by PR 12 cluster; was wired earlier.

3. **Pricing model is correct.** Sonnet 4.6 + Opus 4.7 both have `cacheRead = 10% of input` and `cacheCreation = 1.25× input` — matching Anthropic's published cache pricing model exactly. No drift.

4. **System prompts are mostly module-level constants.** All 16 JSON-cluster features and 3 of 4 SQL-emitter features use static `*_SYSTEM_PROMPT` constants. Only 4 features (NL→SQL primary+retry, 3 stay-text bundle-built) have dynamic prompts that defeat caching.

5. **Tools are static across the codebase.** All 16 `EMIT_*_TOOL` definitions in [tool-schemas.ts](../../lib/ai/tool-schemas.ts) are declared as constants. Tool caching is high-value because each tool definition is 700-4500 tokens.

### No DIVERGENCEs from spec stop conditions

- ✅ SDK supports prompt caching for Sonnet 4.6 and Opus 4.7 (stable API, not beta-gated)
- ✅ `cache_read_tokens` + `cache_creation_tokens` columns exist in migration 082
- ✅ Most callsites have static system prompts (only 4 of 26 are dynamic — manageable, not "meaningful number")
- ✅ Anthropic pricing model is current (read multiplier 0.10×; write premium 1.25×)

---

## Out of scope

- PR 13.1 implementation (Phase B work — separate prompt)
- PR 13.2 expansion (gated on PR 13.1's 2-week measurement window)
- Cache-effectiveness dashboard cron job (ad-hoc query in §5 suffices for now)
- Anthropic batch API enablement (separate Phase 2+ feature)
- 1-hour ephemeral TTL (`ephemeral_1h_input_tokens` is beta; defer)
- User-message-prefix caching (none of Settle's user messages have stable prefixes today)

## DIVERGENCE summary (consolidated)

1. **Observability + pricing are 100% prepared.** PR 13.1 is purely a wrapper + flag-flip exercise; no DB or cost-model work.
2. **SDK 0.78.0 supports cache_control on stable API for Sonnet/Opus.** Cache placement on system + tool both verified via SDK types.
3. **22 of 26 features are cache-eligible** (12 High-fit + 5 Medium-fit + 5 Low/No depending on prompt dynamism).
4. **Strategy C (phased) is recommended** to ground real cost decisions in 2 weeks of production measurement.
5. **PR 13.1 scope: ~80-120 LOC, ~$0.10-0.15 spend, 4-5 callsite flag-flips + wrapper extension.**

*End of PR 13 — Anthropic prompt caching Phase A investigation.*
