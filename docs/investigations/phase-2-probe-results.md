# Phase 2 readiness probe — measurement results

**Status:** Read-only probe. No production code modified. Anthropic API spend: **$0.00** (all four items resolved via doc fetches and the production `llm_calls` table; no probe API call needed).

**Companion document:** `~/.claude/plans/investigation-mapping-consolidation-linked-fairy.md` — the §8 items being measured here are listed in that investigation report.

---

## Item 1 — Canonical Opus 4.7 model id

**Resolved via doc fetch.** Source: <https://platform.claude.com/docs/en/docs/about-claude/models/overview> ("Latest models comparison" section).

### Verdict

The canonical Claude API ID for Claude Opus 4.7 is:

```
claude-opus-4-7
```

**No date suffix. No dated alias.** This is both the API ID and the alias — they are identical for current Claude 4 models. The user's hypothesized form `claude-opus-4-7-20251022` does not exist.

### Surprising finding — Anthropic has dropped date suffixes for current models

The investigation's §2.2 flagged the un-dated Opus key in `pricing.ts` as a "divergence" from Sonnet 4 (`claude-sonnet-4-20250514`) and Haiku 4.5 (`claude-haiku-4-5-20251001`) which carry date suffixes. **That framing was wrong.** Per the docs:

| Model | API ID | API alias | Convention |
|---|---|---|---|
| **Claude Opus 4.7** (current) | `claude-opus-4-7` | `claude-opus-4-7` | undated |
| **Claude Sonnet 4.6** (current) | `claude-sonnet-4-6` | `claude-sonnet-4-6` | undated |
| **Claude Haiku 4.5** (current) | `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | dated id, undated alias |
| Claude Sonnet 4 (DEPRECATED, retiring 2026-06-15) | `claude-sonnet-4-20250514` | `claude-sonnet-4-0` | dated |
| Claude Opus 4 (DEPRECATED, retiring 2026-06-15) | `claude-opus-4-20250514` | `claude-opus-4-0` | dated |

The codebase's current default `claude-sonnet-4-20250514` is the **deprecated** Sonnet 4, not the current Sonnet 4.6. It is scheduled for retirement on **2026-06-15** (~7 weeks from today, 2026-05-02).

### Tool use + caching support

The models overview page does not enumerate per-feature support tables (e.g., a "Tool use" column) for Opus 4.7. Two follow-ups:

- **Tool use:** standard Anthropic Messages API feature; supported on every Claude 4 model per the build-with-claude reference. No reason to expect Opus 4.7 to differ. PR 12 implementation should sanity-check via a single test call before assuming.
- **Prompt caching:** confirmed via the prompt-caching doc page (see Item 4). Opus 4.7 is explicitly listed under the prompt-caching minimum-prefix table.

### Implication for `pricing.ts`

[lib/ai/pricing.ts:40](lib/ai/pricing.ts#L40) already declares `'claude-opus-4-7'` as the key. **The string is correct.** The investigation's worry about a "missing date suffix" was unfounded — current Anthropic convention is undated for the API ID. **No change to `pricing.ts:40` is needed for PR 11.**

---

## Item 2 + Item 3 — Per-feature input-token + latency stats

**Resolved via SQL probe of production `llm_calls`.** Script: `scripts/probe-llm-calls-stats.mjs` (one-shot helper, kept in the repo for re-running).

### Query

30-day window, excluding `eval_*` features (per the daily-cost-report convention at [app/api/cron/llm-cost-report/route.ts:124-129](app/api/cron/llm-cost-report/route.ts#L124-L129)).

### Result

| Feature | Calls | Avg in | P50 in | P95 in | Max in | Avg out | Avg lat (ms) | P95 lat (ms) | Failures |
|---|---|---|---|---|---|---|---|---|---|
| `outputs_execution_package_compartmentalized` | 1 | 39 | 39 | 39 | 39 | 8 | 833 | 833 | 0 |
| `mapping_suggest` | 1 | 39 | 39 | 39 | 39 | 8 | 914 | 914 | 0 |
| `mapping_generate` | 1 | 25 | 25 | 25 | 25 | 9 | 661 | 661 | 0 |
| `mapping_generate_repair` | 1 | 34 | 34 | 34 | 34 | 9 | 923 | 923 | 0 |

### Interpretation — production volume is essentially zero

- **4 total non-eval `callLLM` invocations in 30 days.** The token counts (25-39 input, 8-9 output) are too small to be real customer work — they look like dev-environment smoke tests that weren't tagged `eval_*`.
- 21 of the 25 production features have **zero** calls in the window. No statistical baseline exists.
- This is consistent with the user's note in the investigation prompt: "Synthetic dataset authoring was deliberately deferred — gold labels emerge from real customer migrations, not from public-doc inference." The implied counterpart: real customer migrations haven't happened yet at meaningful volume.

### Implication

**The investigation's risk assessment for PR 11 (cost regression, latency regression) cannot be calibrated against production data — there isn't any.** Two paths:

1. **Sonnet 4.6 vs Opus 4.7 cost comparison must be theoretical, not empirical.** The 1.67× multiplier from `pricing.ts` (input 5/3, output 25/15) is the only concrete number; we can't claim "current Sonnet costs $X/day → Opus will cost $1.67X" because $X ≈ $0.
2. **PR 11's verification gates must be FORWARD-LOOKING.** "Run cost report 24h after `AI_PHASE_2_ENABLED=1` in dev" assumed there was a baseline to compare against. Replace with: "monitor cost-per-call after first pilot project lands, set a per-call cost ceiling based on observed Sonnet baselines" — but defer the empirical comparison to post-pilot.

This is also a **freshness signal** for the eval harness: the `_fixture` smoke (PR 10.6) is currently the only LLM-call exercise in the system. PR 10.6's full baseline becomes more important — it produces the first real per-call cost / latency measurement against the real production prompts (mapping_generate, validation_rule_from_nl), and provides the missing baseline for Phase 2 comparison.

---

## Item 4 — Anthropic prompt-caching constraints

**Resolved via doc fetch.** Source: <https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>.

### Confirmed-vs-claimed table

| # | Claim | Confirmed value | Status |
|---|---|---|---|
| 1 | Minimum prefix size: 1024 tokens (Sonnet) | **1024 tokens applies only to Sonnet 4.5 / Opus 4.1 / Opus 4.0 / Sonnet 4 / Sonnet 3.7.** Sonnet 4.6 = 2048 tokens. Opus 4.7 / 4.6 / 4.5 = **4096 tokens**. | ❌ **CHANGED — much higher for Opus 4.7** |
| 2 | Minimum changes for Opus 4.7 | YES — **4096 tokens** (4× the Sonnet 4 baseline). | confirmed change |
| 3 | Max cache_control markers per request: 4 | **4** | ✅ correct |
| 4 | TTL options: 5-min default + 1-hr extended | **5-min default (free refresh)** + **1-hour extended (2× base input price)** | ✅ correct |
| 5 | cache_control on system + user + assistant | YES — works on tools, system blocks, user/assistant text blocks, images, documents, tool_use, tool_result. | ✅ correct (broader than claimed) |
| 6 | Streaming receives cache hits like non-streaming | **Doc page does not explicitly confirm.** Implied via the `message_start` event carrying cache metrics. PR 13 should sanity-test against the streaming callsite (`outputs_execution_package_compartmentalized` at execution-package.ts:460). | ⚠️ unverified |

Direct quote from the docs (per the WebFetch result):

> "The minimum cacheable prompt length is:
> - 4096 tokens for Claude Mythos Preview, Claude Opus 4.7, Claude Opus 4.6, and Claude Opus 4.5
> - 2048 tokens for Claude Sonnet 4.6
> - 1024 tokens for Claude Sonnet 4.5, Claude Opus 4.1, Claude Opus 4, Claude Sonnet 4, and Claude Sonnet 3.7"

### Implication — half the production features fall below the Opus 4.7 caching threshold

PR 13 was conceived under the assumption that any prompt > 1024 tokens could cache. **Under Opus 4.7 the threshold is 4096 tokens — 4× higher.** Re-classifying production features by the new threshold (estimates from §4.1 of the investigation):

| Feature | Estimated system+context tokens | Caches under Opus 4.7? |
|---|---|---|
| `mapping_generate` (engine, ~18K-token system) | 18K+ | ✅ comfortably |
| `mapping_generate_legacy_pair` (same engine prompts) | 18K+ | ✅ |
| `mapping_suggest` (engine, smaller) | ~5-8K (estimate; needs measurement) | ✅ likely |
| `outputs_*` (compartmentalized, monolithic, fallback) | Per-call user message dominates; system prompt is a preamble | needs measurement |
| `transform_generate`, `transform_describe` | Single-line preamble + per-call user message | ❌ system prompt alone is below; user message varies |
| `validation_rule_from_nl` | ~1K tokens | ❌ below threshold |
| `manual_fix`, `quality_fix_options`, `quality_detection_ai` | similar single-line preambles | ❌ below threshold |
| `nl_to_sql`, `nl_suggest_queries` | per-call user message + small system | ❌ likely below |
| `ddl_parsing`, `ddl_conversion`, `schema_enrichment`, `schema_merge_ai_match`, `migration_intelligence` | unmeasured | unknown |

**PR 13 caching coverage estimate: 3-5 features out of 25, not the "most features" implied earlier.** The mapping pipeline's 18K-token system prompt is the dominant winner; everything else needs a per-feature token-count audit before deciding whether `cache_control` markers pay off.

### Tool-use + caching composability

Tools array is one of the cacheable block types per the doc:

> "Most blocks in the request can be cached. This includes:
> - Tools: Tool definitions in the `tools` array"

So PR 12's tool-schema declarations themselves can carry a `cache_control` marker once PR 13 lands, OR the marker can sit on the system prompt with the tools just outside the cache. PR 12/13 ordering decision: cache the tools array OR not? Tool schemas are stable across calls per feature (they're declared once in source), so caching them is high-value when the system prompt is also cached. Coordinate this in the PR 13 spec.

---

## Implications for PR 11 (Opus 4.7 swap) — concrete updates to the spec

| Spec area | Change |
|---|---|
| Model string | **Use `claude-opus-4-7`** verbatim. The investigation's worry about a "missing date suffix" is resolved: undated is the convention for Opus 4.7 and Sonnet 4.6. |
| `pricing.ts` change | **`pricing.ts:40` is already correct.** No `pricing.ts` change needed for PR 11. |
| `llm-client.ts:103` change | Remains a 1-line swap: `const DEFAULT_MODEL = 'claude-opus-4-7'`. |
| Deprecation context | Note in the PR 11 description that `claude-sonnet-4-20250514` is the **deprecated** Sonnet 4, retiring 2026-06-15. The swap to Opus 4.7 also moves us OFF the deprecation track. (Alternative: swap to `claude-sonnet-4-6` if Phase 2's Opus-specific gains aren't load-bearing — but the investigation prompt is explicit that Phase 2 is the Opus upgrade.) |
| Cost regression baseline | **Cannot be empirically calibrated against production data** (4 non-eval calls in 30 days, all dev smoke). Replace "compare 24h pre-flag-flip vs post-flag-flip" with "set a per-call cost ceiling based on the eval harness's PR 10.6 full baseline measurement once it ships." |
| Latency regression baseline | Same — defer to PR 10.6 baseline. |
| Tool use compatibility | The models doc didn't enumerate per-feature support; PR 11's smoke run should sanity-check (one mapping example end-to-end) before declaring Opus 4.7 production-ready. |

### Decision gate question for the architect

Sonnet 4 is deprecated. Two options for PR 11:

- **Option A (per the investigation's plan): swap to Opus 4.7.** Higher cost (1.67×), higher latency (2-3×), better quality. Forward-aligned with the Phase 2 plan.
- **Option B (an alternative not in the original plan): swap to Sonnet 4.6.** Same input/output prices as Sonnet 4 (3/15 per MTok) — **zero cost regression** — but moves off the deprecation. Sonnet 4.6 is the current "Sonnet". This is a smaller, lower-risk move.

The Phase 2 prompt commits to Opus 4.7; this is a notable trade-off worth surfacing. If the cost regression matters, a **two-step swap** (Sonnet 4 → Sonnet 4.6 first, defer Opus to a later date) is cleaner.

---

## Implications for PR 13 (prompt caching) — concrete updates to the spec

| Spec area | Change |
|---|---|
| Minimum prefix size | **4096 tokens for Opus 4.7** (not 1024). Update the spec accordingly. |
| Per-feature audit | **Mandatory before PR 13 implementation.** The investigation's "most features should cache" framing is too optimistic. Most likely cacheable: `mapping_generate`, `mapping_generate_legacy_pair`, `mapping_suggest` (estimated). Most likely NOT cacheable: `validation_rule_from_nl`, `manual_fix`, `transform_generate` system prompt (per-call user message may push some calls over 4096, but that's a per-call rather than per-feature decision). |
| Tools array caching | New consideration: the `tools` array (introduced in PR 12) can ALSO be cached. This is high-value when paired with system-prompt caching. PR 13 should structure the prompt as `tools (cached) → system (cached) → user-prefix (cached) → user-suffix (variable)`. |
| Streaming + caching | **Sanity-test required.** The doc page doesn't explicitly confirm streaming receives cache hits like non-streaming. PR 13's verification gate must include a streaming-callsite smoke (`outputs_execution_package_compartmentalized` at execution-package.ts:460). |
| Cache write/read ratio | Investigation §7 PR 13 Risk 1 framed this as "If creation/read ratio < 1:5, caching is losing money." Math check: cache creation is **2× base input** (per the doc's pricing detail re 1-hr TTL — for 5-min default the multiplier is **1.25×** per `pricing.ts:35` cacheCreation 3.75 vs input 3.0). Cache read is **0.1× base input**. Break-even ratio is `(1.25 × 1) ≤ (1.0 - 0.1) × N` → `N ≥ 1.39` reads per write. So as long as we get >1.4 reads per write, caching pays off. The "1:5 minimum" rule of thumb in the investigation was overly conservative. |

---

## Items NOT measured (deferred for a follow-up if needed)

- **Per-feature token-count audit** for the 21 production features that have 0 calls in 30 days. Two ways to get this without running real customer work: (a) hand-measure each system prompt's char count and divide by 4; (b) make a one-shot probe call per feature with a synthetic input and read `llm_calls.input_tokens` afterward. (b) is more accurate but spends ~$0.05 (25 features × $0.002). Worth doing as a PR 13 prerequisite.
- **Streaming + caching empirical confirmation.** Doc page is silent; only a one-shot `callLLMStreaming` test against the compartmentalized callsite confirms behavior. ~$0.01 spend. Worth doing as a PR 13 prerequisite.
- **Tool-use + Opus 4.7 sanity check.** Doc page doesn't enumerate per-feature support. ~$0.001 spend. Worth doing as a PR 12 prerequisite.

Total deferred-probe spend if all three are taken: ~$0.06. All would fit in the same one-shot probe budget the user authorized.

---

## Summary

| Item | Status | Key finding |
|---|---|---|
| 1. Opus 4.7 model id | ✅ resolved | `claude-opus-4-7` (undated). `pricing.ts:40` is already correct; no change needed. |
| 2. Per-feature input tokens | ✅ resolved | Production volume is ~0; risk assessment can't lean on real data. PR 10.6 baseline becomes the de facto first measurement. |
| 3. Per-feature latency | ✅ resolved | Same — no production baseline available. |
| 4. Caching constraints | ✅ resolved | **Minimum prefix is 4096 tokens for Opus 4.7, not 1024.** Most production features fall below; only mapping clearly caches. |

The biggest update to the Phase 2 plan: PR 13's expected impact is smaller than the investigation suggested. Mapping benefits clearly. Other features need per-prompt token measurement before deciding whether caching pays off. PR 11's `pricing.ts` is already correct — just the 1-line `DEFAULT_MODEL` change in `llm-client.ts:103`.

*End of Phase 2 readiness probe.*
