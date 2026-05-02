# Phase 2 Investigation — Opus 4.7 + Tool Use + Prompt Caching

**Type:** Read-only investigation report. No code changes proposed below as patches. No edits performed against `lib/`, `app/`, `components/`, or `supabase/migrations/`. The only file modified is this plan document.

**Audience:** AI architect deciding the Phase 2 implementation PRs (PR 11 Opus swap, PR 12 tool-use structured output, PR 13 prompt caching).

**Scope:** Map every Anthropic API callsite, verify pricing/model config, examine current prose-JSON parsing patterns, assess prompt caching readiness, identify feature-flag patterns, confirm eval harness compatibility, and surface the top risks per sub-PR.

**Out of scope:** Implementation. Token-count measurements (instrumentation flagged in §8). Phase 3 (specialized agents, self-consistency, eval-driven prompt iteration).

---

## TL;DR

| Concern | Answer |
|---|---|
| Total `callLLM` / `callLLMStreaming` callsites | **25** (24 `callLLM` + 1 `callLLMStreaming`). Matches PR #14. |
| Production code paths bypassing `lib/ai/llm-client.ts` | **0**. CI invariant `tests/lib/no-direct-callclaude.test.ts` is intact (5786 bytes, allow-list = 1 entry: `lib/ai/llm-client.ts`). |
| Model selection | **Global, single line.** `lib/ai/llm-client.ts:103` `const DEFAULT_MODEL = 'claude-sonnet-4-20250514'`; consumed at L243 + L335 via `opts.model ?? DEFAULT_MODEL`. PR 11 is a 1-line swap. |
| Opus 4.7 already in pricing | ✅ at `lib/ai/pricing.ts:40-46` as `'claude-opus-4-7'` — **but that string lacks a date suffix** that Sonnet (`-20250514`) and Haiku (`-20251001`) carry. Possible drift; verify against Anthropic's published model string before PR 11. |
| `llm_calls` cache columns | ✅ `cache_read_tokens INT` and `cache_creation_tokens INT` at `082_llm_calls.sql:44-45`. **No migration needed for PR 13.** |
| Anthropic API response cache fields | ✅ already destructured at `llm-client.ts:269-270` (`cache_read_input_tokens`, `cache_creation_input_tokens`). |
| JSON parsing pattern | **Decentralized.** Shared `parseClaudeJSON` (mapping-engine.ts:820) used by 2 mapping callsites only; rest do inline `JSON.parse` with their own markdown-fence stripping. PR 12 must visit each of ~22 JSON callsites. |
| SQL-output callsites (not JSON) | 1 (`transform_generate` uses `extractTransformSQL` from `lib/ai/sql-extractor`) — different helper, also decentralized. |
| Retry-on-parse-failure callsites that become dead under tool use | **3**: `mapping_generate_repair` (mapping-engine.ts:1520), `mapping_generate_legacy_pair_repair` (mappings.ts:243), `nl_to_sql_retry` (query.ts:277). |
| Centralized feature-flag module | **None.** Inline `process.env.X` pattern at `lib/ai/redact.ts:22` is the closest precedent. |
| Eval harness Phase 2 propagation | Automatic — `featureOverride` at `lib/eval/runner.ts:394` only swaps the `feature` tag; the model + parsing + caching live below the override boundary. |
| Things requiring code execution to determine | 4 items, all flagged in §8 |

---

## Section 1 — Callsite inventory

### 1.1 The 25 callsites

Verified via `grep -rn "await callLLM\|await callLLMStreaming" lib/ app/` (excluding tests). Listed in file/line order with feature tag:

| # | File:line | Feature | Notes |
|---|---|---|---|
| 1 | [lib/parsers/ddl-parser.ts:391](lib/parsers/ddl-parser.ts#L391) | `ddl_parsing` | |
| 2 | [lib/quality/fix-engine.ts:421](lib/quality/fix-engine.ts#L421) | `quality_fix_options` | |
| 3 | [lib/ai/ddl-conversion.ts:66](lib/ai/ddl-conversion.ts#L66) | `ddl_conversion` | |
| 4 | [lib/ai/mapping-engine.ts:1492](lib/ai/mapping-engine.ts#L1492) | `mapping_generate` | engine primary |
| 5 | [lib/ai/mapping-engine.ts:1520](lib/ai/mapping-engine.ts#L1520) | `mapping_generate_repair` | JSON-repair retry; chains `parentCallId` |
| 6 | [lib/ai/mapping-engine.ts:1935](lib/ai/mapping-engine.ts#L1935) | `mapping_suggest` | |
| 7 | [lib/actions/mappings.ts:212](lib/actions/mappings.ts#L212) | `featureOverride ?? 'mapping_generate_legacy_pair'` | per-pair regenerate |
| 8 | [lib/actions/mappings.ts:243](lib/actions/mappings.ts#L243) | `featureOverride ?? 'mapping_generate_legacy_pair_repair'` | JSON-repair retry; chains `parentCallId` |
| 9 | [lib/actions/mappings.ts:2471](lib/actions/mappings.ts#L2471) | `mapping_suggest_legacy_bulk` | |
| 10 | [lib/actions/manual-fix.ts:205](lib/actions/manual-fix.ts#L205) | `manual_fix` | |
| 11 | [lib/actions/migration-runbook.ts:541](lib/actions/migration-runbook.ts#L541) | `outputs_migration_runbook` | |
| 12 | [lib/actions/ai-quality-detection.ts:286](lib/actions/ai-quality-detection.ts#L286) | `quality_detection_ai` | |
| 13 | [lib/actions/_outputs-core.ts:762](lib/actions/_outputs-core.ts#L762) | `outputs_readiness_report` | |
| 14 | [lib/actions/transformations.ts:1331](lib/actions/transformations.ts#L1331) | `transform_generate` | output is SQL, not JSON |
| 15 | [lib/actions/transformations.ts:2780](lib/actions/transformations.ts#L2780) | `transform_describe` | output is prose, not JSON |
| 16 | [lib/actions/query.ts:211](lib/actions/query.ts#L211) | `nl_to_sql` | output is SQL |
| 17 | [lib/actions/query.ts:277](lib/actions/query.ts#L277) | `nl_to_sql_retry` | parse-failure retry; chains `parentCallId` |
| 18 | [lib/actions/query.ts:481](lib/actions/query.ts#L481) | `nl_suggest_queries` | |
| 19 | [lib/actions/schema-enrichment.ts:218](lib/actions/schema-enrichment.ts#L218) | `schema_enrichment` | |
| 20 | [lib/actions/migration-intelligence.ts:855](lib/actions/migration-intelligence.ts#L855) | `migration_intelligence` | |
| 21 | [lib/actions/schema-merge.ts:782](lib/actions/schema-merge.ts#L782) | `schema_merge_ai_match` | |
| 22 | [lib/actions/execution-package.ts:345](lib/actions/execution-package.ts#L345) | `outputs_execution_package_monolithic` | |
| 23 | [lib/actions/execution-package.ts:460](lib/actions/execution-package.ts#L460) | `outputs_execution_package_compartmentalized` | **`callLLMStreaming`** |
| 24 | [lib/actions/execution-package.ts:615](lib/actions/execution-package.ts#L615) | `outputs_execution_package_fallback` | dialect-failure fallback (NOT parse failure) |
| 25 | [lib/actions/validation-rules.ts:341](lib/actions/validation-rules.ts#L341) | `validation_rule_from_nl` | |

**Count = 25.** Matches PR #14's number. No new callsites added since.

### 1.2 CI invariant

`tests/lib/no-direct-callclaude.test.ts` exists (5786 bytes, mtime 2026-05-01). Its allow-list (`ALLOWED_FILES_FOR_SDK_IMPORT`) contains exactly one entry:

```ts
const ALLOWED_FILES_FOR_SDK_IMPORT = new Set([
  // The single legitimate consumer of the Anthropic SDK
  'lib/ai/llm-client.ts',
])
```

The test guards three patterns: imports of `@/lib/ai/claude` (deleted in PR 7), direct `anthropic.messages.create/.stream(...)` calls, and `Anthropic` SDK imports outside `llm-client.ts`. **Intact** — single source of truth invariant holds.

### 1.3 Notes for Phase 2

- **All 25 callsites flow through `callLLM` / `callLLMStreaming`.** Sub-PRs 11/12/13 can edit `llm-client.ts` (and the relevant downstream parsers for PR 12) without per-callsite plumbing for the model swap or caching plumbing.
- **The streaming variant at #23 needs equivalent treatment in PR 12 + PR 13** — the streaming Anthropic API supports tool use and caching, but the wire protocol differs from the non-streaming path.

---

## Section 2 — Current model and pricing config

### 2.1 `lib/ai/pricing.ts` (full contents, verified)

```ts
export const PRICING: Record<string, ModelPricing> = {
  // Currently in use everywhere (lib/ai/claude.ts:16, :40)
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    batchInput: 1.5,
  },

  // Reserved for Phase 2 model upgrade
  'claude-opus-4-7': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheCreation: 6.25,
    batchInput: 1.25,
  },

  // Reserved for Tier 4 utility calls if a feature ever uses Haiku
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheCreation: 1.25,
  },
}
```

Per-token pricing summary (USD per 1M tokens):

| Model | Input | Output | Cache read | Cache creation |
|---|---|---|---|---|
| Sonnet 4 (`claude-sonnet-4-20250514`) — current | 3.00 | 15.00 | 0.30 | 3.75 |
| Opus 4.7 (`claude-opus-4-7`) — reserved | 5.00 | 25.00 | 0.50 | 6.25 |
| Haiku 4.5 (`claude-haiku-4-5-20251001`) — reserved | 1.00 | 5.00 | 0.10 | 1.25 |

Per-call cost ratio Opus / Sonnet: input **1.67×**, output **1.67×**, cache read **1.67×**, cache creation **1.67×**. All four are uniform 1.67×.

### 2.2 ⚠️ DIVERGENCE — Opus model-string format

The Opus 4.7 entry is keyed on `'claude-opus-4-7'` — **no date suffix**. Sonnet uses `'claude-sonnet-4-20250514'` and Haiku uses `'claude-haiku-4-5-20251001'`, both **with** date suffixes. This is inconsistent.

The investigation prompt says: "swap `claude-sonnet-4-20250514` → `claude-opus-4-7-20251022` (or whatever the latest Opus 4.7 model string is — verify)". That `claude-opus-4-7-20251022` form is not what `pricing.ts` declares.

**Action for PR 11 implementation prompt:** before swapping, verify the canonical Anthropic-published model string for Opus 4.7. The actual API requires the precise model id; using `claude-opus-4-7` may resolve to a default version or fail outright. Two paths:

1. **Confirm Anthropic's docs** for the exact dated model id (e.g., `claude-opus-4-7-20251022`) and update `pricing.ts:40` to use the dated form.
2. **Or** confirm Anthropic supports the un-dated alias `claude-opus-4-7` as a "latest within minor" pointer (some SDKs accept this). If yes, document the choice; otherwise fail.

This is a cheap probe: a single read against Anthropic's [model overview](https://docs.anthropic.com/en/docs/about-claude/models) confirms the ID. **Flag in §8 as needing one-shot verification.**

### 2.3 Model selection logic

[lib/ai/llm-client.ts:103](lib/ai/llm-client.ts#L103) declares the default:

```ts
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
```

Consumed at exactly two sites:
- [llm-client.ts:243](lib/ai/llm-client.ts#L243) inside `callLLM`: `const model = opts.model ?? DEFAULT_MODEL`
- [llm-client.ts:335](lib/ai/llm-client.ts#L335) inside `callLLMStreaming`: same shape

**Decision answer: model selection is GLOBAL.** No callsite passes `opts.model`; all defer to `DEFAULT_MODEL`. PR 11 is **a 1-line change** at line 103.

### 2.4 `CallLLMOptions` includes a `model` parameter that no callsite uses

```ts
// llm-client.ts:60-78 (CallLLMOptions interface)
export interface CallLLMOptions {
  feature: LLMFeature
  systemPrompt: string
  userMessage: string
  projectId: string
  userId: string
  /** Defaults to `claude-sonnet-4-20250514` (matches `lib/ai/claude.ts`). */
  model?: string
  ...
}
```

No callsite passes `model`. The optional plumbing exists for per-call overrides (e.g., a future feature that wants Haiku for cheap utility work). Phase 2 can either (a) keep this plumbing and have the model swap apply globally via `DEFAULT_MODEL`, or (b) leverage it for a feature-flagged per-call override. (a) is simpler.

---

## Section 3 — Current structured-output (prose-JSON) parsing

### 3.1 Three representative callsites

#### 3.1.1 `mapping_generate` (engine primary) — JSON output via `parseClaudeJSON` shared helper

**Prompt assembly:** [mapping-engine.ts:212](lib/ai/mapping-engine.ts#L212) declares `MAPPING_GENERATION_SYSTEM_PROMPT` as a 73,483-char template literal (≈18,000 tokens). Per-call user message at [mapping-engine.ts:1481](lib/ai/mapping-engine.ts#L1481-L1487) is assembled via `buildMappingUserMessage({ sourceSection, targetSection, docBlock, intelligenceCtx, otherSourcesBlock })`. The user message size varies wildly with project — typically 1k-5k tokens but can exceed 10k for documentation-heavy projects.

**Response parsing:** [mapping-engine.ts:820-843](lib/ai/mapping-engine.ts#L820-L843):

```ts
export function parseClaudeJSON(raw: string): ClaudeResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed.table_mappings || !Array.isArray(parsed.table_mappings)) {
      throw new Error('Invalid response: missing table_mappings array')
    }
    return parsed as ClaudeResponse
  } catch (err) {
    const trimmed = cleaned.trimEnd()
    const isLikelyTruncation =
      cleaned.length > 500 && !trimmed.endsWith('}') && !trimmed.endsWith(']')
    if (isLikelyTruncation) {
      console.error(`[Mapping] Response appears truncated...`)
    }
    throw err
  }
}
```

**Schema:** `ClaudeResponse` defined as `{ table_mappings: ClaudeTableMapping[] }` where each `ClaudeTableMapping` has nested `field_mappings: ClaudeFieldMapping[]`. Callers downstream of `parseClaudeJSON`: 2 sites — [mapping-engine.ts:1516, 1531](lib/ai/mapping-engine.ts#L1516) (engine primary + repair retry) and 2 more in [mappings.ts:240, 259](lib/actions/mappings.ts#L240) (legacy per-pair primary + repair).

#### 3.1.2 `validation_rule_from_nl` — JSON output via INLINE parsing

**Prompt assembly:** [validation-rules.ts:282-322](lib/actions/validation-rules.ts#L282) — 41-line system prompt enumerating rule_type values + per-type rule_config schemas; user message `userMessage = '`Field: ... Sample values: ... User's rule: "..."'`'.

**Response parsing:** [validation-rules.ts:340-360](lib/actions/validation-rules.ts#L340):

```ts
let parsed: { name: string; description: string; rule_type: string; rule_config: Record<string, unknown>; severity: 'blocking' | 'warning' }
try {
  const result = await callLLM({...})
  llmCallId = result.callId
  const cleaned = result.text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  parsed = JSON.parse(cleaned)
} catch {
  return { success: false, error: 'AI returned an unexpected response. Please try again.' }
}
```

**Schema:** flat object with 5 fields. Markdown fence stripping is **inline** — same regex as `parseClaudeJSON`'s but locally duplicated. No `parseClaudeJSON` reuse here.

#### 3.1.3 `transform_generate` — SQL output via `extractTransformSQL`

**Prompt assembly:** [transformations.ts:985](lib/actions/transformations.ts#L985) declares `TRANSFORM_SYSTEM_PROMPT`; user message assembled at [transformations.ts:1305-1325](lib/actions/transformations.ts#L1305) with source field + target field + sample data context.

**Response handling:** [transformations.ts:1331-1351](lib/actions/transformations.ts#L1331):

```ts
const result = await callLLM({ feature: 'transform_generate', ... })
rawSql = result.text
llmCallId = result.callId
// ...
let sql = extractTransformSQL(rawSql)
```

`extractTransformSQL` lives in `lib/ai/sql-extractor.ts` (separate helper, dedicated to SQL-from-prose extraction — strips fences, picks the SQL out of mixed-content responses). **Distinct from `parseClaudeJSON`** because the output is SQL text, not a JSON object.

### 3.2 Decision answer — parsing is DECENTRALIZED

Cross-tabulating where each callsite parses:

| # callsites | Parsing path |
|---|---|
| 4 | `parseClaudeJSON` (mapping_generate, mapping_generate_repair, mapping_generate_legacy_pair, mapping_generate_legacy_pair_repair) — shared helper, JSON output |
| ~18 | Inline `JSON.parse` with local markdown-fence stripping (validation_rule_from_nl, manual_fix, ddl_conversion, ddl_parsing, schema_enrichment, schema_merge_ai_match, mapping_suggest, mapping_suggest_legacy_bulk, migration_intelligence, quality_detection_ai, quality_fix_options, outputs_readiness_report, outputs_migration_runbook, outputs_execution_package_monolithic, outputs_execution_package_compartmentalized [streaming], outputs_execution_package_fallback, nl_suggest_queries) |
| 2 | `extractTransformSQL` (transform_generate, transform_describe — both produce text/SQL not JSON) |
| 1 | `extractSelectSQL` (nl_to_sql + nl_to_sql_retry — SQL output) |

**PR 12 implication:** tool use replaces both the prose-JSON parsing AND the SQL-from-prose extraction patterns with structured tool arguments. The 18 inline-`JSON.parse` callsites and the 4 `parseClaudeJSON` callsites can both migrate to tool use; the SQL-output callsites (`transform_generate`, `transform_describe`, `nl_to_sql`, `nl_to_sql_retry`, `nl_suggest_queries` — 5 sites) are **a different shape** because their output isn't structured JSON. Tool use can still wrap them — the tool schema becomes `{ "name": "emit_sql", "input_schema": { "type": "object", "properties": { "sql": {"type":"string"} } } }` — but the diff is per-callsite.

**Concrete PR 12 scope estimate:**
- Cluster A (JSON output, 22 callsites): each gets a tool schema declaration + invocation update. Per-site: ~30-50 LOC. Total: **~600-1100 LOC**.
- Cluster B (SQL/text output, 5 callsites): wrap in an `emit_sql` or `emit_text` tool. Per-site: ~20-30 LOC. Total: **~100-150 LOC**.
- Plus: changes to `callLLM` itself to support a `tools?: Tool[]` parameter and return either `text` or `toolUse.input` — **~50-100 LOC** in `llm-client.ts`.

**Total PR 12 implementation: ~750-1350 LOC.** Larger than originally implied. Worth surfacing in the PR 12 spec.

### 3.3 Retry-on-parse-failure callsites that become dead under tool use

3 of the 25 callsites are structurally-justified by current parse failures:

| Feature | File:line | Why it exists |
|---|---|---|
| `mapping_generate_repair` | [mapping-engine.ts:1520](lib/ai/mapping-engine.ts#L1520) | Re-asks Claude to fix malformed JSON when `parseClaudeJSON` throws |
| `mapping_generate_legacy_pair_repair` | [mappings.ts:243](lib/actions/mappings.ts#L243) | Same shape, legacy code path |
| `nl_to_sql_retry` | [query.ts:277](lib/actions/query.ts#L277) | Re-asks Claude to fix the SQL when extraction or DB-execution fails |

Tool use eliminates the parse-failure mode structurally — Anthropic validates the tool input schema before returning, so malformed JSON cannot reach the caller. Under PR 12:

- `mapping_generate_repair` and `mapping_generate_legacy_pair_repair` become **dead code**. Should be removed in PR 12 OR kept as defensive no-ops with a comment.
- `nl_to_sql_retry` is more nuanced — it retries on **both** parse failure AND DB execution failure (the latter is "AI proposed SQL that the database rejected at runtime"). Tool use only fixes the parse path; the DB-error path still needs a retry. So `nl_to_sql_retry` should be **kept and narrowed**: trigger only on DB execution failure, not on parse failure.

**Decision needed in PR 12 spec:** remove the two mapping-repair callsites, keep + narrow `nl_to_sql_retry`. Or keep all three as defensive no-ops — adds latency cost (one extra Anthropic call per failure) but reduces blast radius if tool use itself misbehaves.

`outputs_execution_package_fallback` (#24) is **not** a parse-failure retry — it's a "the compartmentalized package failed dialect detection so generate a monolithic alternative" pattern. Survives PR 12 unchanged.

---

## Section 4 — Prompt caching readiness

### 4.1 Largest prompt by token count

`MAPPING_GENERATION_SYSTEM_PROMPT` at [mapping-engine.ts:212](lib/ai/mapping-engine.ts#L212): **73,483 chars ≈ 18,370 tokens** (rule of thumb 4 chars/token).

Other large prompts (estimates by file inspection):
- `TRANSFORM_SYSTEM_PROMPT` ([transformations.ts:985](lib/actions/transformations.ts#L985)) — single-line preamble; the bulk of the prompt is in the user message which is per-call variable.
- Validation rule system prompt ([validation-rules.ts:282](lib/actions/validation-rules.ts#L282)) — ~41 lines, ~3-5K chars (~1K tokens).
- Quality fix-engine prompt ([fix-engine.ts:421](lib/quality/fix-engine.ts#L421) area) — not measured, similar order.

**The mapping prompt is 5-20× the size of the others** and dominates the caching value calculation. Most other features have system prompts well under the 1024-token caching minimum prefix size.

### 4.2 Prompt structure analysis (caching friendliness)

Inspecting the mapping flow:
1. **System prompt** (constant across all calls): `MAPPING_GENERATION_SYSTEM_PROMPT` — 18K tokens, never changes. **High cache value.**
2. **User message components** (per-call):
   - `sourceSection` — formatted source schema; **constant within a project session, varies across projects**. Medium cache value (5-min TTL captures intra-session repeats).
   - `targetSection` — same shape, constant within project.
   - `docBlock` — extracted document text; constant within project.
   - `intelligenceCtx` — pattern memory; nearly constant within project.
   - `otherSourcesBlock` — varies per source-table being processed; **per-call**.

**Decision answer: the system prompt + project-level schema context can be structured as a stable cache prefix.** The `otherSourcesBlock` is the variable suffix.

But: today the user message is assembled as a single concatenated string via `buildMappingUserMessage({...})`. To leverage caching effectively, PR 13 needs to either:

- **Restructure the user message** as multiple message parts where the cache marker sits between the constant prefix and the variable suffix. The Anthropic Messages API allows `content` to be an array of blocks, each independently cacheable. Or:
- **Move project-level context to the system prompt** so the `cache_control` marker on the system block captures both the prompt template AND the schema/docs content. (Not all features have project-level context that fits the system slot — flag for case-by-case decision.)

Approach (1) is cleaner; requires updating `callLLM` to accept an array-of-blocks userMessage shape.

### 4.3 ⚠️ `llm-client.ts` already destructures cache fields from the response

[llm-client.ts:269-270](lib/ai/llm-client.ts#L269):

```ts
cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
cache_creation_tokens: response.usage.cache_creation_input_tokens ?? 0,
```

**These fields are already being captured** from every Anthropic response and written to `llm_calls`. They're nullable in the DB and currently always 0 because no `cache_control` markers are in any prompt. The instrumentation for measuring cache hit-rate and cost savings is **already in place** — PR 13 just needs to start emitting the markers.

Pricing math for cache savings is also already wired ([pricing.ts:73-78](lib/ai/pricing.ts#L73)):

```ts
return (
  usage.input_tokens * p.input +
  usage.output_tokens * p.output +
  usage.cache_read_tokens * p.cacheRead +
  usage.cache_creation_tokens * p.cacheCreation
) / 1_000_000
```

### 4.4 `llm_calls` migration check

[supabase/migrations/082_llm_calls.sql:42-46](supabase/migrations/082_llm_calls.sql#L42):

```sql
  -- Tokens (nullable: NULL on errors before completion)
  input_tokens                  INT,
  output_tokens                 INT,
  cache_read_tokens             INT,
  cache_creation_tokens         INT,
```

**No migration needed for PR 13.** The columns exist and have been collecting zeros since PR #14 shipped.

### 4.5 Anthropic prompt-caching constraints — needs verification

Per the user's note, last-known facts about Anthropic prompt caching:
- Minimum prefix size: 1024 tokens (Sonnet); may differ for Opus 4.7
- Maximum `cache_control` markers per request: 4
- Cache TTL: 5-min default, 1-hr extended

**These are user-supplied values; investigation is read-only and cannot ping Anthropic's docs.** PR 13's implementation prompt should re-verify against current Anthropic documentation at implementation time — limits have changed before.

The mapping system prompt at 18K tokens vastly exceeds 1024-token minimum, so the prefix-size constraint is not a blocker for the mapping feature. For the smaller features (~1K-token system prompts), caching may not pay off — flag for per-feature decision.

---

## Section 5 — Feature-flag plumbing

### 5.1 Existing patterns

A targeted `grep -rE 'process\.env\.(AI_|MODEL_|FEATURE_|FLAG_)'` across `lib/` and `app/` found **one** existing AI-flag site:

- [lib/ai/redact.ts:22](lib/ai/redact.ts#L22): `const REDACTION_ENABLED = process.env.AI_EDIT_HISTORY_REDACT !== '0'`

A broader sweep for any `process.env.X` outside the well-known infrastructure variables (Supabase, Anthropic, Resend, etc.) found **3 total** non-infra flag-style env vars in production code:
- `SSO_ADMIN_METADATA_UPLOAD_ORGS` ([lib/sso/admin-metadata-upload-allowlist.ts:43](lib/sso/admin-metadata-upload-allowlist.ts#L43))
- `SSO_ATTEMPT_COOKIE_SECRET` ([lib/sso/attempt-cookie.ts:30](lib/sso/attempt-cookie.ts#L30))
- `AI_EDIT_HISTORY_REDACT` (above)

**No centralized feature-flag module** — `lib/features.ts`, `lib/flags.ts`, `lib/config.ts` do not exist.

### 5.2 Read-once vs per-request

The redact flag is read at **module-load time** (top-level `const`). Same for the SSO cookie secret. There's no reactive flag module that re-reads env on each request.

**For Phase 2's gradual rollout**, the user's stated requirement is "per-request lets us flip the flag without redeploying." This means:
- Module-load reads (current pattern) require a redeploy to flip.
- Per-request reads cost a `process.env` lookup per call — negligible.

The new `AI_PHASE_2_ENABLED` flag should be **read per-request** (inside the function body, not at module-load), to support flag flipping without redeploy. If we want to be defensive about latency overhead, cache the result for a short TTL.

### 5.3 Sketch of where the flag check goes

The cleanest insertion point is inside `callLLM` itself ([llm-client.ts:241-244](lib/ai/llm-client.ts#L241)):

```ts
export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResult> {
  const callId = randomUUID()
  const phase2On = process.env.AI_PHASE_2_ENABLED === '1'
  const model =
    opts.model ?? (phase2On ? 'claude-opus-4-7' : DEFAULT_MODEL)
  // PR 12 extension: also gate the tools[] parameter on phase2On
  // PR 13 extension: also gate cache_control markers on phase2On
  // ...
}
```

This places all three Phase 2 behavioral changes behind a single flag at a single point. Rolling back any sub-PR is "set `AI_PHASE_2_ENABLED=0` in prod env" — no code revert required.

**Decision needed in PR 11 spec:** introduce `lib/features.ts` for centralized flag handling, OR add the inline `process.env.AI_PHASE_2_ENABLED` check directly inside `callLLM`. The codebase has no precedent for the centralized module — adding it is a fresh decision worth making explicit.

### 5.4 Composability with existing flags

No existing AI-behavior flags compose with Phase 2. `AI_EDIT_HISTORY_REDACT` is orthogonal (controls redaction in the eval/audit path, not the LLM call path).

---

## Section 6 — Eval harness compatibility

### 6.1 `featureOverride` propagation

[lib/eval/runner.ts:394](lib/eval/runner.ts#L394): the eval runner passes `featureOverride: 'eval_mapping'` to `runMappingGenerationForPair`. That override flows down to `callLLM`'s `feature` field. Crucially:

- **Model selection** lives downstream in `callLLM` itself ([llm-client.ts:243](lib/ai/llm-client.ts#L243)). The override doesn't perturb model selection. PR 11's swap reaches eval calls unchanged.
- **Tool use** (PR 12) lives in `callLLM`'s request shape. PR 12's tools-array reaches eval calls unchanged.
- **Caching** (PR 13) lives in `callLLM`'s message-block construction. PR 13's `cache_control` markers reach eval calls unchanged.

The only differentiator at the eval-call level is the `feature` tag in `llm_calls` — `eval_mapping` vs `mapping_generate`. Phase 2 propagation is fully automatic; no special-casing needed in the eval path.

### 6.2 Predicted score impact on `_fixture` smoke

| Sub-PR | Predicted fixture score | Risk if it diverges |
|---|---|---|
| PR 11 (Opus 4.7) | 1.000 (fixture is unambiguous) | Score < 1.0 → Opus interpreting prompts differently than Sonnet for trivial cases. Investigate the proposed mapping output. |
| PR 12 (tool use) | 1.000 | Score < 1.0 → tool schema mismatch with downstream parser. Investigate the parsed tool input shape. |
| PR 13 (caching) | **must be exactly 1.000** | Any drift from 1.0 → caching changed the prompt structure in a way that affected output. Cache should be a pure cost optimization. |

Additionally, `cost_usd` and `latency_ms` should drop measurably under PR 13 on the second smoke run within 5 minutes (cache TTL). **First** smoke run after PR 13 ships won't see cache hits; this is a 2-call test (run twice within 5 min) not a 1-call test.

### 6.3 Eval-call cost separation

[app/api/cron/llm-cost-report/route.ts:124-129](app/api/cron/llm-cost-report/route.ts#L124) filters out `eval_*` features from the daily cost report. Phase 2's eval calls inherit the same `eval_*` tag, so production cost reports stay clean automatically.

---

## Section 7 — Risk assessment

### PR 11 — Opus 4.7

**Risk 1: Cost regression.** Opus is 1.67× per-token across the board. Worst case: a feature whose monthly volume scales with enterprise pilot size (mapping_generate, ~18K-token prompts) sees a 1.67× cost increase. For a small pilot (<$20/day Sonnet) this is <$35/day Opus — acceptable. For larger pilot expansion, this should be measured before flag-flip in prod.
**Verification:** the daily cost report at `app/api/cron/llm-cost-report/route.ts` already aggregates by feature. Run the cost report 24h after `AI_PHASE_2_ENABLED=1` in dev; compare to the 24h pre-flag-flip baseline. Decision criterion before prod flip: avg cost-per-call increase ≤2× baseline (allows for some variance).

**Risk 2: Latency regression.** Opus is typically 2-3× slower than Sonnet for the same prompt+output sizes. Mapping generation (currently 5-15s) could become 15-45s. UI implications: streaming UI for `outputs_execution_package_compartmentalized` (#23) hides latency, but blocking UI flows (e.g., `validation_rule_from_nl` from a modal) become noticeably worse.
**Verification:** `llm_calls.latency_ms` is already captured. Query 24h post-flag-flip in dev for p50/p95 latency by feature. Decision criterion: no feature p95 > 30s.

**Risk 3: Behavior drift on existing prompts.** Opus 4.7 may interpret prompts differently than Sonnet 4 — particularly the long mapping prompt with extensive examples. Output format may shift (more markdown, different JSON structure under prose). The eval harness `_fixture` is too small to surface this; real customer data may.
**Verification:** A) Heritage replay regression — run the eval harness against the Heritage fingerprint capture (12/13 byte-identical baseline). Fingerprints WILL shift (expected); the QUESTION is whether the structural shape is still parseable. B) Manual smoke against 2-3 real pilot projects in dev before prod flip.

**Risk 4 (bonus): Model-string drift.** §2.2 flagged that `pricing.ts` declares `'claude-opus-4-7'` without a date suffix. If Anthropic's API requires the dated form (`claude-opus-4-7-20251022`), the swap fails at every call.
**Verification:** A one-shot call against the Anthropic API in dev with the chosen model string before merging PR 11. If `pricing.ts`'s string doesn't work, fix the string first.

### PR 12 — Tool use for structured output

**Risk 1: Scope creep.** §3.2 estimated ~750-1350 LOC across 25 callsites. Per-callsite changes are mechanically similar but each requires a tool schema declaration — a small new bug surface per site.
**Verification:** Per-callsite unit test that the tool schema parses and the production code consumes the tool's `input` field correctly. The eval harness fixture currently exercises 1 callsite (`mapping_generate`); add per-feature smoke tests in PR 12 (one per distinct tool schema, ~10-12 tests).

**Risk 2: Tool use compatibility with Opus 4.7.** Tool use is part of the standard Anthropic Messages API — Opus 4.7 supports it the same way Sonnet does (per Anthropic docs at the time of writing). But the model's adherence to the schema may differ. Opus may include extra fields, omit optional ones, etc.
**Verification:** Schema-strict validation in PR 12 — fail-loud on any deviation rather than silently dropping fields. The eval harness's `validation_rule_structural` scorer (PR 10.3) is exactly this pattern; adopt it across PR 12.

**Risk 3: Streaming + tool use composition.** Callsite #23 (`outputs_execution_package_compartmentalized`) uses `callLLMStreaming`. The streaming protocol for tool use returns deltas (`tool_use_input_delta`) that must be assembled before the tool input is parseable. PR 12 needs to handle this in `callLLMStreaming` separately from the non-streaming path.
**Verification:** Manual smoke of the compartmentalized package generation against a small project in dev.

**Risk 4 (bonus): Dead-code removal of repair callsites.** §3.3 noted 3 repair callsites become dead under tool use. Removing them touches `mapping_generate_repair`, `mapping_generate_legacy_pair_repair`, plus the `nl_to_sql_retry` narrowing.
**Verification:** Test that each removed callsite's parent code path still completes cleanly (the AI succeeds on first attempt). The eval harness only exercises the happy path; the repair retries are exercised by malformed-JSON synthetic tests in `tests/lib/no-direct-callclaude.test.ts` and elsewhere — verify those remain coverage-positive.

### PR 13 — Prompt caching

**Risk 1: Cache invalidation on prompt evolution.** Any change to the system prompt or schema-context block busts the cache and triggers a write (1.25× input cost) instead of a read (0.10× input cost). High-frequency prompt iteration (e.g., during prompt-engineering work) makes caching net-negative.
**Verification:** `llm_calls.cache_creation_tokens` vs `cache_read_tokens` in the daily cost report. If creation/read ratio < 1:5 (i.e., we create cache more than we read it), caching is losing money.

**Risk 2: Sub-1024-token system prompts won't cache.** Any feature whose system prompt is below the cache minimum prefix size cannot use `cache_control` on the system slot — the marker has to attach to a longer block in the user message, which may not be stable.
**Verification:** A pre-implementation token-count audit of every system prompt. Flag features whose system + project context combined is below the threshold; skip caching for those. Most likely candidates to skip: `validation_rule_from_nl`, `manual_fix`, `nl_suggest_queries`. Mapping/transform/runbook should cache.

**Risk 3: Behavior shift from message-block restructuring.** §4.2 noted that effective caching requires restructuring the user message into multiple blocks. Anthropic treats array-of-blocks input the same as concatenated string input semantically, but in practice models can be sensitive to formatting differences (extra whitespace, block boundaries). The fixture score = 1.0 contract is a strong invariant here.
**Verification:** Run the eval fixture twice, compare scores byte-identically. If they differ, the message-block restructuring is changing behavior — investigate before merging.

**Risk 4 (bonus): TTL eviction during a single migration session.** A pilot user might have a 30-min mapping session with 5-min TTL cache. The first call after each 5-min idle period writes a new cache entry. Cost savings calculation should account for typical session length and idle gap.
**Verification:** Anthropic offers extended 1-hr TTL for higher cost. For Phase 2, default 5-min TTL is reasonable; revisit after measurement.

---

## Section 8 — Items requiring code execution to determine

Investigation is read-only. The following four items need a one-shot measurement before the PR 11 implementation prompt is finalized:

1. **Verify the canonical Opus 4.7 model id.** Either (a) check Anthropic's [models documentation](https://docs.anthropic.com/en/docs/about-claude/models) or (b) make a single API call with `claude-opus-4-7` and one with `claude-opus-4-7-20251022` (or whatever the dated form is) and confirm which Anthropic accepts. ~$0.001 spend.

2. **Measure typical input-token counts per feature.** The largest prompt was estimated at 18K tokens by char division; actual Anthropic-counted tokens differ. The instrumentation already exists (`llm_calls.input_tokens`); a 24h dev-environment query against `llm_calls` grouped by feature would give precise numbers. **No spend** — just a SQL query.

3. **Measure typical p95 latency per feature.** Same approach — `llm_calls.latency_ms` aggregated by feature. **No spend.**

4. **Verify Anthropic's current prompt-caching constraints** (1024-token minimum prefix, 4 markers max, TTL options). The user-supplied facts are last-known; Anthropic has changed limits before. A doc fetch covers this; **no spend**.

These four are pre-implementation gates for PR 11 + PR 13. PR 12 doesn't depend on any of them.

---

## What's NOT in this investigation (out of scope)

- PR 11/12/13 implementation prompts — the architect drafts those from this report
- Token-count measurements (flagged in §8 for one-shot follow-up)
- Anthropic API-side verification of model ids and caching constraints (flagged in §8)
- Phase 3 (specialized agents, self-consistency, prompt iteration loop)
- Refactoring decisions like "introduce `lib/features.ts`" — surfaced in §5.3 but not decided
- Per-feature decision on "which features benefit from caching enough to justify markers" — PR 13's spec should iterate on this case-by-case

---

## Appendix — One-line summary for the architect

**Phase 2 is mostly mechanical at the call level.** PR 11 is a 1-line model swap (caveat: verify the Opus 4.7 model id) plus `pricing.ts` already has the entry. PR 13 needs no migration — `082_llm_calls.sql` already has cache columns, and `llm-client.ts` already destructures the response cache fields. **PR 12 is the largest sub-PR** (~750-1350 LOC across 25 callsites) because parsing is decentralized; that's the one to plan carefully and split into clusters.

*End of Phase 2 readiness investigation.*
