# PR 12 Investigation — Tool Use for Structured Output

**Type:** Read-only investigation report. No code changes proposed below as patches. No edits performed against `lib/`, `app/`, `supabase/`, or `tests/`. The only file written is this investigation document.

**Audience:** AI architect drafting the PR 12 implementation prompt(s).

**Scope:** Map every Anthropic API callsite by output shape (JSON-via-tool, SQL/text-via-tool, streaming-via-tool), spec the redesigned `callLLM` API, identify the exact line scope of retry-callsite removal, and surface the top risks per sub-commit.

**Out of scope:** Implementation. Anthropic API probes (one-shot probes flagged in §9 as pre-merge gates). PR 13 caching design (separate sub-PR).

---

## TL;DR

| Concern | Answer |
|---|---|
| Total callsites | **25** (matches PR #14 + Phase 2 readiness investigation) |
| **JSON cluster (Decision A2 sub-commit 12.1)** | **16 callsites**, NOT 22 as the original investigation said |
| **SQL/text cluster (sub-commit 12.2)** | **8 callsites**, NOT 5 as the original investigation said |
| **Streaming cluster (sub-commit 12.3)** | **1 callsite** (matches investigation) |
| Distinct tool schemas needed | **15** (JSON: 13 distinct + SQL/text: 2 generic `emit_sql` / `emit_text` + Streaming: 1 — JSON tool reused by streaming) |
| Retry callsites that become dead | **2** — `mapping_generate_repair`, `mapping_generate_legacy_pair_repair` |
| Retry callsites that survive UNCHANGED | **1** — `nl_to_sql_retry` (DB-failure retry, not parse-failure). DIVERGENCE from the original investigation, which said this needed narrowing — actually no narrowing needed |
| SDK Tool type location | [`@anthropic-ai/sdk/resources/messages/messages.d.ts`](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts) line 987 |
| `tool_choice` location | top-level field on `MessageCreateParams`; **NOT** nested in `output_config` (unlike `effort`) |
| Streaming protocol | [`callLLMStreaming`](lib/ai/llm-client.ts#L402) waits for `stream.finalMessage()` — **NOT** consuming tokens incrementally. Tool-use streaming is mechanically simple as a result |
| Items requiring code execution | **2** (one-shot tool-use streaming probe, token-count delta measurement) |

---

## Major divergences from the prior Phase 2 investigation

The Phase 2 readiness investigation (`docs/investigations/phase-2-probe-results.md` and the readiness report it accompanied) classified each callsite by output shape based on a quick grep. Reading each callsite end-to-end in this investigation surfaces **6 misclassifications**:

| Callsite | Investigation said | Actual output | Evidence |
|---|---|---|---|
| `outputs_execution_package_monolithic` | JSON | **SQL text** | `result.text` appended to header at [execution-package.ts:356-390](lib/actions/execution-package.ts#L356) — no JSON parse |
| `outputs_execution_package_fallback` | JSON | **SQL text** | `result.text` passed to `splitMonolithicSQL` at [execution-package.ts:627-635](lib/actions/execution-package.ts#L627) — no JSON parse |
| `manual_fix` | JSON | **SQL text** | `result.text` stripped of fences and used as SQL at [manual-fix.ts:215-219](lib/actions/manual-fix.ts#L215) — no JSON parse |
| `ddl_conversion` | JSON | **SQL text** (DDL) | `result.text` stripped + handed to `parseDDL` at [ddl-conversion.ts:84-105](lib/ai/ddl-conversion.ts#L84) — no JSON parse |
| `outputs_readiness_report` | JSON | **Markdown prose** | `result.text` passed straight to `buildReadinessDocx` at [_outputs-core.ts:760-770](lib/actions/_outputs-core.ts#L760) — no JSON parse |
| `nl_suggest_queries` | SQL/text | **JSON array** (`string[]` at top level) | `JSON.parse(cleaned)` then `Array.isArray` check at [query.ts:493-497](lib/actions/query.ts#L493) |

**Net reclassification:** 5 callsites moved from JSON → SQL/text; 1 moved from SQL/text → JSON.

**Final cluster sizes for PR 12:**
- JSON cluster: 16 (was 22)
- SQL/text cluster: 8 (was 5) — wait, let me recount: 9 if we count transform_describe (which is prose, not SQL). It's a text output via `emit_text` tool either way.

Actually counting the SQL/text cluster precisely:
- `transform_generate` (SQL)
- `transform_describe` (prose)
- `nl_to_sql` (SQL)
- `nl_to_sql_retry` (SQL — survives unchanged)
- `manual_fix` (SQL)
- `ddl_conversion` (SQL/DDL)
- `outputs_execution_package_monolithic` (SQL)
- `outputs_execution_package_fallback` (SQL)
- `outputs_readiness_report` (markdown prose)

**= 9 SQL/text callsites total.** 16 JSON + 9 SQL/text = 25 ✓.

The TL;DR table above is now updated to reflect 9 (not 8). Original investigation said 5; reality is 9.

---

## Section 1 — JSON cluster: per-callsite schemas (16 callsites)

### 1.1 Shared schema family — `parseClaudeJSON` (4 callsites)

The `parseClaudeJSON` helper at [mapping-engine.ts:820](lib/ai/mapping-engine.ts#L820) parses `ClaudeResponse`:

```ts
// lib/ai/mapping-engine.ts:173-197
export interface ClaudeFieldMapping {
  source_field: string
  target_field: string
  confidence: number                    // 0-100
  reasoning: string
  similar_fields_considered?: string[]
  type_compatibility?: string
  needs_transformation?: boolean
  mapping_type?: 'one_to_one' | 'many_to_one' | 'one_to_many'
  contributing_source_fields?: string[]
  combination_hint?: string
  split_hint?: string
}

export interface ClaudeTableMapping {
  source_table: string
  target_table: string
  confidence: number                    // 0-100
  reasoning: string
  field_mappings: ClaudeFieldMapping[]
}

export interface ClaudeResponse {
  table_mappings: ClaudeTableMapping[]  // top-level array under .table_mappings
}
```

**Consuming callsites (4):**
- [mapping-engine.ts:1492](lib/ai/mapping-engine.ts#L1492) — `mapping_generate` (engine primary)
- [mapping-engine.ts:1520](lib/ai/mapping-engine.ts#L1520) — `mapping_generate_repair` (DEAD under tool use, see §4)
- [mappings.ts:212](lib/actions/mappings.ts#L212) — `mapping_generate_legacy_pair`
- [mappings.ts:243](lib/actions/mappings.ts#L243) — `mapping_generate_legacy_pair_repair` (DEAD under tool use, see §4)

**Tool schema:** **1 schema** (`emit_table_mappings`) shared by all 4 callsites. After dead-code removal in §4, only 2 remain: the engine primary and the legacy per-pair primary.

### 1.2 Per-callsite inline-`JSON.parse` schemas (12 callsites)

| # | Feature | File:line | Top-level shape | Required fields | Optional fields | Schema source |
|---|---|---|---|---|---|---|
| 1 | `mapping_suggest` | [mapping-engine.ts:1935](lib/ai/mapping-engine.ts#L1935) | object | `source_field_names: string[]`, `combination_type: 'single' \| 'concat_space' \| 'concat_comma'`, `confidence: number`, `rationale: string` (≤ 280 chars) | none | `ClaudeSuggestionResponse` interface at engine.ts:1663-1668 (loose typing — fields all `unknown`); strict shape documented in the system prompt at line 1929 (`Respond with ONLY valid JSON in this exact shape: {"source_field_names": [...], ...}`) |
| 2 | `mapping_suggest_legacy_bulk` | [mappings.ts:2471](lib/actions/mappings.ts#L2471) | object | `field_mappings: ClaudeFieldMapping[]` | none | Inline at parse site; reuses `ClaudeFieldMapping` type from mapping-engine.ts |
| 3 | `validation_rule_from_nl` | [validation-rules.ts:341](lib/actions/validation-rules.ts#L341) | object | `name: string`, `description: string`, `rule_type: string` (enum of 11 values), `rule_config: Record<string, unknown>`, `severity: 'blocking' \| 'warning'` | none | Inline `let parsed: { name; description; rule_type; rule_config; severity }`; per-rule_type `rule_config` schemas listed in system prompt (e.g. `regex` → `{ pattern, description }`) |
| 4 | `ddl_parsing` | [ddl-parser.ts:391](lib/parsers/ddl-parser.ts#L391) | object | `tables: ParsedTable[]` | none | `ParsedTable` type defined elsewhere; each table has `name`, `fields[]` with per-field `data_type`, `is_nullable`, `is_primary_key`, `check_constraint?: { type, allowedValues?, pattern?, min?, max?, raw }`, `references?` |
| 5 | `schema_enrichment` | [schema-enrichment.ts:218](lib/actions/schema-enrichment.ts#L218) | object | `corrections: Array<{ field_name, ... }>` | many | `ClaudeSchemaResponse` typed locally; per-correction shape includes `field_name`, optional `data_type`, `is_nullable`, `description`, etc. |
| 6 | `schema_merge_ai_match` | [schema-merge.ts:782](lib/actions/schema-merge.ts#L782) | object | `matches: Array<{ ddl_table_name: string; existing_id: string }>` | none | Inline; defensive `if (!Array.isArray(maybeMatches)) return []` |
| 7 | `migration_intelligence` | [migration-intelligence.ts:855](lib/actions/migration-intelligence.ts#L855) | **array** at top level | `ExtractedPattern[]` (each: `pattern_type`, `description`, `rule`, `confidence`, `tags?`, `source_excerpt?`) | none on each element | Inline `extractedPatterns = JSON.parse(cleaned)` then `if (!Array.isArray) throw` |
| 8 | `quality_detection_ai` | [ai-quality-detection.ts:286](lib/actions/ai-quality-detection.ts#L286) | object | `proposed_issues: Array<{ field_name, severity: 'blocking' \| 'warning', description, verification_sql, ... }>` | many | `ClaudeQualityResponse` typed locally; uses regex `match(/\{[\s\S]*\}/)` to extract from prose-wrapped output |
| 9 | `quality_fix_options` | [fix-engine.ts:421](lib/quality/fix-engine.ts#L421) | object | `fix_options: Array<{ description: string; sql: string; ... }>` | `downstream_impact?: string`, others | `ClaudeFixResponse` typed locally; downstream consumes `fix_options[0].sql` and `fix_options[0].description` |
| 10 | `outputs_migration_runbook` | [migration-runbook.ts:541](lib/actions/migration-runbook.ts#L541) | object | `executiveSummary: string`, `preMigrationChecklist: string[]`, `mappingSpecification: any[]`, `transformationRules: any[]`, `dataQualityAssessment: { totalIssuesFound, issuesFixed, issuesAcceptedRisk, issuesRemaining, blockingRemaining, summaryNarrative, keyFindings: string[] }`, `executionPlan: any[]`, `validationCriteria: any[]`, `rollbackProcedure: string` | all (each has a fallback at usage site) | Locally-typed `Omit<RunbookData, ...generated-at-runtime fields>`; ~10 top-level fields, deeply nested |
| 11 | `outputs_execution_package_compartmentalized` | [execution-package.ts:460](lib/actions/execution-package.ts#L460) | object | `files: ClaudeFileEntry[]` (each: `filename: string`, `type: 'checklist' \| 'table_script' \| 'validation' \| 'promote' \| 'rollback'`, `content: string`, `table_name?`, `load_order?`, `dependencies?: string[]`) | per-element optional fields | Inline `ClaudeFileEntry` interface at line 480-487; **uses `callLLMStreaming`**; has heavy recovery logic (brace counting, truncation recovery, `sanitizeClaudeJson`) |
| 12 | `nl_suggest_queries` | [query.ts:481](lib/actions/query.ts#L481) | **string[]** at top level | array of 4 strings | none | Inline `JSON.parse(cleaned)` then `Array.isArray && length >= 1` check; falls back to hardcoded suggestions on any failure |

### 1.3 Distinct tool schemas needed for the JSON cluster

| Tool name | Used by | Shape |
|---|---|---|
| `emit_table_mappings` | mapping_generate, mapping_generate_legacy_pair | `{ table_mappings: ClaudeTableMapping[] }` |
| `emit_field_mappings` | mapping_suggest_legacy_bulk | `{ field_mappings: ClaudeFieldMapping[] }` |
| `emit_mapping_suggestion` | mapping_suggest | `{ source_field_names, combination_type, confidence, rationale }` |
| `emit_validation_rule` | validation_rule_from_nl | `{ name, description, rule_type, rule_config, severity }` |
| `emit_parsed_ddl` | ddl_parsing | `{ tables: ParsedTable[] }` |
| `emit_schema_corrections` | schema_enrichment | `{ corrections: SchemaCorrection[] }` |
| `emit_table_matches` | schema_merge_ai_match | `{ matches: Array<{ ddl_table_name, existing_id }> }` |
| `emit_extracted_patterns` | migration_intelligence | `{ patterns: ExtractedPattern[] }` (wrap the top-level array under a `patterns` key — Anthropic tool input must be an object) |
| `emit_quality_issues` | quality_detection_ai | `{ proposed_issues: ProposedIssue[] }` |
| `emit_fix_options` | quality_fix_options | `{ fix_options, downstream_impact? }` |
| `emit_migration_runbook` | outputs_migration_runbook | the 10-field RunbookData omit-set |
| `emit_compartmentalized_package` | outputs_execution_package_compartmentalized | `{ files: ClaudeFileEntry[] }` |
| `emit_query_suggestions` | nl_suggest_queries | `{ suggestions: string[] }` (wrap the top-level array; same reason as `emit_extracted_patterns`) |

**= 13 distinct tool schemas for the JSON cluster.** Two of the schemas wrap a top-level array under a property because Anthropic's tool `input_schema.type` must be `'object'` ([SDK line 1044-1049](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L1044)).

---

## Section 2 — SQL/text cluster: per-callsite specifics (9 callsites)

| # | Feature | File:line | Output shape | Current parser | Tool schema |
|---|---|---|---|---|---|
| 1 | `transform_generate` | [transformations.ts:1331](lib/actions/transformations.ts#L1331) | SQL string | `extractTransformSQL(rawSql)` from `lib/ai/sql-extractor.ts` | `emit_sql_transform` with `{ sql: string }` |
| 2 | `transform_describe` | [transformations.ts:2780](lib/actions/transformations.ts#L2780) | prose (≤ 256 tokens) | `result.text.trim()` — no parser | `emit_description` with `{ description: string }` |
| 3 | `nl_to_sql` | [query.ts:211](lib/actions/query.ts#L211) | SQL SELECT string | `extractSelectSQL(rawResponse)` | `emit_sql_query` with `{ sql: string }` |
| 4 | `nl_to_sql_retry` | [query.ts:277](lib/actions/query.ts#L277) | SQL SELECT string | same — `extractSelectSQL(rawRetry)` | reuses `emit_sql_query` |
| 5 | `manual_fix` | [manual-fix.ts:205](lib/actions/manual-fix.ts#L205) | SQL UPDATE/DELETE string | inline fence-strip | `emit_sql_fix` with `{ sql: string }` |
| 6 | `ddl_conversion` | [ddl-conversion.ts:66](lib/ai/ddl-conversion.ts#L66) | DDL (CREATE TABLE statements) | inline fence-strip; downstream `parseDDL` | `emit_ddl` with `{ ddl: string }` |
| 7 | `outputs_execution_package_monolithic` | [execution-package.ts:345](lib/actions/execution-package.ts#L345) | SQL multi-statement | none — `result.text` consumed directly | `emit_sql_package` with `{ sql: string }` |
| 8 | `outputs_execution_package_fallback` | [execution-package.ts:615](lib/actions/execution-package.ts#L615) | SQL multi-statement | none — `result.text` consumed directly | reuses `emit_sql_package` |
| 9 | `outputs_readiness_report` | [_outputs-core.ts:762](lib/actions/_outputs-core.ts#L762) | markdown prose | `result.text` → `buildReadinessDocx(reportText, ...)` | `emit_markdown_report` with `{ content: string }` |

### 2.1 Distinct tool schemas needed for the SQL/text cluster

Eight of the 9 callsites collapse to 5 distinct schemas (`emit_sql_transform`, `emit_sql_query`, `emit_sql_fix`, `emit_ddl`, `emit_sql_package`) plus 2 prose-shaped (`emit_description`, `emit_markdown_report`). The 5 SQL ones could be **collapsed further** to a single generic `emit_sql` with `{ sql: string; dialect?: 'postgresql' | 'tsql' | 'mysql' }` if the architect prefers DRY; per-feature schemas give better tool-name semantics ("the model understands what kind of SQL to produce") at the cost of repetition.

**Recommendation: 5 distinct SQL schemas + 2 prose schemas = 7 distinct tool schemas for the SQL/text cluster.** Per-feature naming pays off: the model sees `emit_sql_fix` and knows it's an UPDATE/DELETE; sees `emit_sql_query` and knows it's a SELECT.

### 2.2 The `nl_suggest_queries` reclassification

`nl_suggest_queries` was originally classified as SQL/text but is actually JSON (a `string[]` array). It belongs in the JSON cluster (already counted there in §1.2 row 12). Its tool schema (`emit_query_suggestions`) wraps the top-level array under `suggestions` to satisfy Anthropic's "input must be object" constraint.

### 2.3 Total distinct tool schemas

13 (JSON cluster) + 7 (SQL/text cluster) = **20 distinct tool schemas.** Rough scale of `lib/ai/tool-schemas.ts`: 20 schemas × ~25-35 lines each = **~500-700 lines**, smaller than the original investigation's "~1000 lines" estimate because (a) several schemas share `ClaudeFieldMapping`/`ClaudeTableMapping` sub-shapes via JSON Schema `$ref`, and (b) the SQL/text schemas are 5-10 lines each (just `{ sql: string }` etc.).

---

## Section 3 — Streaming protocol (1 callsite)

### 3.1 Current `callLLMStreaming` shape

[lib/ai/llm-client.ts:402-468](lib/ai/llm-client.ts#L402):

```ts
export async function callLLMStreaming(opts: CallLLMOptions): Promise<CallLLMResult> {
  // ... build request with stream: true
  const stream = await anthropic.messages.stream(request)
  const message = await stream.finalMessage()  // ← waits for complete response

  const textBlock = message.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }
  // ... return result.text
}
```

**KEY OBSERVATION: `callLLMStreaming` DOES NOT consume tokens incrementally.** It calls `stream.finalMessage()` which blocks until the entire response is assembled, then returns the complete text. From a behavioral standpoint it's almost identical to `callLLM`, just routed through the streaming endpoint (which presumably has different rate limits, latency characteristics, or token-window allocation per Anthropic's internal routing).

**Implication for PR 12:** tool-use streaming is mechanically simple. Instead of `message.content.find((b) => b.type === 'text')` we change to `message.content.find((b) => b.type === 'tool_use')` and read `block.input` instead of `block.text`. No incremental-delta consumption to redesign.

### 3.2 The streaming callsite

[execution-package.ts:460](lib/actions/execution-package.ts#L460) — `outputs_execution_package_compartmentalized`. Already detailed in §1.2 row 11. Output shape: `{ files: ClaudeFileEntry[] }`.

The streaming call site does heavy parsing-recovery work (brace counting, truncation recovery, `sanitizeClaudeJson`) at lines 491-525. **All of this disappears under tool use** — the tool input arrives validated against the schema or not at all.

### 3.3 SDK 0.78.0 tool-use streaming support

Confirmed via SDK type definitions:
- [`StopReason`](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L847) includes `'tool_use'` — the streaming endpoint will signal completion the same way the non-streaming endpoint does
- [`ContentBlock`](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L435) union includes `ToolUseBlock` — `message.content` will contain a tool-use block when the model selects a tool, regardless of streaming mode
- `stream.finalMessage()` returns the same shape as the non-streaming `messages.create` response, so the existing pattern transfers cleanly

**One-shot probe still recommended (see §9):** the SDK types support this end-to-end, but no production code in this repo has exercised "streaming + tool_use" together. A $0.001 probe call before merging sub-commit 12.3 confirms the runtime behavior.

### 3.4 Streaming + Opus 4.7 + effort='high' composability

Phase 2 PR 11 ships `output_config.effort = 'high'` to streaming requests too. Tool-use + extended thinking on the streaming path is the most untested composition; the §9 probe should exercise this exact triple.

---

## Section 4 — Retry callsite removal: exact line scope

### 4a. `mapping_generate_repair` (mapping-engine.ts)

**File:** [lib/ai/mapping-engine.ts](lib/ai/mapping-engine.ts)
**Parent function:** `runMappingGeneration` (around line 1384)

**Lines that disappear under tool use:** 1515-1538 (24 lines).

```ts
// Current shape (lines 1515-1538):
try {
  const batchParsed = parseClaudeJSON(batchRaw)         // ← line 1516
  allTableMappings.push(...(batchParsed.table_mappings ?? []))
} catch {
  try {
    const retryResult = await callLLM({                  // ← lines 1520-1531: REMOVED
      feature: 'mapping_generate_repair',
      systemPrompt: 'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
      userMessage: `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${batchRaw}`,
      maxTokens: PER_BATCH_MAX_TOKENS,
      projectId,
      userId,
      promptVersion: 'mapping-repair-v1',
      parentCallId: primaryCallId,
      abuseUserId: userId,
    })
    const retryParsed = parseClaudeJSON(retryResult.text)
    allTableMappings.push(...(retryParsed.table_mappings ?? []))
  } catch (retryErr) {                                   // ← terminal log; replaced
    console.error(`[Mapping] Failed to parse mappings for source table ${sourceCtx.table_name} after retry:`, retryErr)
  }
}
```

**Tool-use shape (replacement, ~5 lines):**

```ts
// After tool use migration:
if (batchResult.kind === 'toolUse' && batchResult.toolUse.name === 'emit_table_mappings') {
  const input = batchResult.toolUse.input as { table_mappings: ClaudeTableMapping[] }
  allTableMappings.push(...(input.table_mappings ?? []))
}
```

**LOC delta: -24, +5 = net -19 lines.**

### 4b. `mapping_generate_legacy_pair_repair` (mappings.ts)

**File:** [lib/actions/mappings.ts](lib/actions/mappings.ts)
**Parent function:** `runMappingGenerationForPair` (line 121, exported in PR 10.4)

**Lines that disappear under tool use:** 239-267 (29 lines).

```ts
// Current shape (lines 239-267):
let parsedResponse: ClaudeResponse
try {
  parsedResponse = parseClaudeJSON(raw)                  // ← line 240
} catch {
  try {
    const retryResult = await callLLM({                  // ← lines 244-260: REMOVED
      // Per the PR 10.4 decision: when the override is set, the
      // JSON-repair retry rolls up under the SAME eval feature
      // (eval_mapping) — eval treats primary+repair as one logical
      // call. Production callers continue to log under the
      // canonical _repair feature taxonomy.
      feature: featureOverride ?? 'mapping_generate_legacy_pair_repair',
      systemPrompt: 'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
      userMessage: `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${raw}`,
      maxTokens: PER_BATCH_MAX_TOKENS,
      projectId,
      userId,
      promptVersion: 'mapping-repair-v1',
      parentCallId: primaryCallId,
      abuseUserId: userId,
    })
    parsedResponse = parseClaudeJSON(retryResult.text)
  } catch (retryErr) {                                   // ← lines 261-264: REMOVED
    console.error(`[Mapping] Failed to parse response for pair after retry:`, retryErr)
    return { inserted: 0, error: 'AI returned invalid response. Please try again.' }
  }
}
```

**Tool-use shape (replacement, ~7 lines):**

```ts
// After tool use migration:
if (primaryResult.kind !== 'toolUse' || primaryResult.toolUse.name !== 'emit_table_mappings') {
  return { inserted: 0, error: 'AI did not produce a structured mapping response.' }
}
const parsedResponse = primaryResult.toolUse.input as { table_mappings: ClaudeTableMapping[] }
```

**LOC delta: -29, +7 = net -22 lines.**

### 4c. `nl_to_sql_retry` (query.ts) — ⚠️ DIVERGENCE: SURVIVES UNCHANGED

**The original investigation §3.3 claimed `nl_to_sql_retry` retries on BOTH parse failure AND DB execution failure, and that PR 12 should narrow it to DB-only.** Reading the actual code at [query.ts:235-285](lib/actions/query.ts#L235) reveals:

```ts
// Line 232:
if (result.error) {  // ← `result` is the SQL EXECUTION result, NOT the parse result
  // ... exclusions for permission-denied, timeout, rate-limit, cancelled
  if (!nonRetryable) {
    // ... build retryUserMessage with the failed SQL + DB error
    const retryResult = await callLLM({
      feature: 'nl_to_sql_retry',
      // ...
    })
  }
}
```

**The retry triggers SOLELY on `result.error` — the SQL execution result's error.** There is no `parseFailed` branch. The primary call's output handling at lines 211-227 uses `extractSelectSQL(rawResponse)` which is a regex extractor, not a JSON parser. If extraction returns empty, the empty SQL gets passed to `executeQuery`, which returns its own error.

**Conclusion: `nl_to_sql_retry` is purely a DB-failure retry. Tool use does NOT eliminate it. NO narrowing required in PR 12.** The investigation's "narrow to DB-only" guidance is unnecessary because the path is already DB-only.

**Implication for PR 12 spec:** sub-commit 12.2 leaves `nl_to_sql_retry` UNCHANGED beyond migrating its tool schema (it gets `emit_sql_query` like its primary). The retry condition stays `if (result.error && !nonRetryable)`. Zero deletion at this site.

### 4d. Total dead-code removal LOC

`mapping_generate_repair`: -24 / +5 = **-19** lines.
`mapping_generate_legacy_pair_repair`: -29 / +7 = **-22** lines.
`nl_to_sql_retry`: ±0 lines (no narrowing needed).

**Total: ~41 LOC removed across 2 callsites.**

---

## Section 5 — `callLLM` API redesign

### 5.1 SDK Tool type (verified)

[`@anthropic-ai/sdk/resources/messages/messages.d.ts:987-1036`](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L987):

```ts
export interface Tool {
  input_schema: Tool.InputSchema   // JSON Schema (type: 'object', properties, required, ...)
  name: string                     // canonical tool name
  description?: string             // Anthropic recommends VERY detailed descriptions
  cache_control?: CacheControlEphemeral | null   // ← PR 13 hook
  strict?: boolean                 // schema-strict validation; recommended `true` for our case
  type?: 'custom' | null
  // ... defer_loading, eager_input_streaming, input_examples (all unused by our callsites)
}

export declare namespace Tool {
  interface InputSchema {
    type: 'object'                 // ← MUST be 'object'; arrays must be wrapped
    properties?: unknown | null
    required?: Array<string> | null
    [k: string]: unknown
  }
}
```

### 5.2 SDK ToolChoice types (verified)

[`messages.d.ts:1081-1129`](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L1081):

```ts
export type ToolChoice = ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | ToolChoiceNone

// For Settle's use case (one tool per callsite, force the model to use it):
export interface ToolChoiceTool {
  name: string                          // ← the tool to force
  type: 'tool'                          // ← discriminator
  disable_parallel_tool_use?: boolean   // recommend `true` (we want exactly one tool use)
}
```

`tool_choice` lives at the **top level** of the request (alongside `tools`, `model`, `max_tokens`, etc.). **NOT nested in `output_config` like `effort`** — the Phase 2 surprise that bit PR 11 doesn't recur here.

### 5.3 SDK ToolUseBlock (response side, verified)

[`messages.d.ts:1322-1330`](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L1322):

```ts
export interface ToolUseBlock {
  id: string                            // tool-use call id (Anthropic-internal)
  input: { [k: string]: unknown }       // ← validated against the tool's input_schema
  name: string                          // tool name as declared
  type: 'tool_use'                      // discriminator
}
```

`message.content` is `ContentBlock[]` ([line 435](node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L435)) where each block is one of `TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ...`. **Important:** the response can contain **multiple blocks** — typically a `ThinkingBlock` (when extended thinking is on, like Phase 2's `effort='high'`) **plus** a `ToolUseBlock`. Our existing `find((b) => b.type === 'text')` pattern needs to become `find((b) => b.type === 'tool_use')`. The thinking block can be ignored or logged separately for future eval debugging.

**Question: can a tool-use response also include a text block?** Per Anthropic's docs, when the model decides to use a tool, the response's `stop_reason` becomes `'tool_use'` and the model generally does NOT also produce text. But it's not strictly impossible. Our migration should:
- Find the `tool_use` block first; that's the canonical output
- If no tool_use block but there's a text block, treat it as an error (the model didn't call the forced tool)

### 5.4 Proposed `CallLLMOptions` extension

```ts
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

export interface CallLLMOptions {
  feature: LLMFeature
  systemPrompt: string
  userMessage: string
  projectId: string
  userId: string
  model?: string
  maxTokens?: number
  promptVersion?: string
  parentCallId?: string
  abuseUserId?: string
  metadata?: Record<string, unknown>

  // ── PR 12 additions ─────────────────────────────────────────────────
  /**
   * When provided, the request includes this as the only available tool
   * and tool_choice forces the model to call it. The response will be a
   * `{ kind: 'toolUse', toolUse: { name, input } }` shape.
   *
   * When omitted, the request is text-only (current behavior). The
   * response will be `{ kind: 'text', text }`.
   *
   * Settle's convention: every PR 12 callsite passes EXACTLY ONE tool.
   * Multi-tool flows are reserved for Phase 3+ agentic features.
   */
  tool?: Tool
}
```

**Note:** singular `tool` (not `tools[]`), reflecting Settle's "one tool per callsite" convention. The internal request to Anthropic builds `tools: [opts.tool]` and `tool_choice: { type: 'tool', name: opts.tool.name, disable_parallel_tool_use: true }`.

### 5.5 Proposed `CallLLMResult` discriminated union

```ts
interface CallLLMResultCommon {
  callId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
  anthropicRequestId: string | null
}

export type CallLLMResult =
  | (CallLLMResultCommon & { kind: 'text'; text: string })
  | (CallLLMResultCommon & {
      kind: 'toolUse'
      toolUse: { name: string; input: Record<string, unknown> }
    })
```

**Backwards compatibility:** every existing callsite reads `result.text` directly. A discriminated-union switch breaks 25 callsites at compile time — that's the intended forcing function for PR 12. The compiler walks each callsite to a tool-use shape; sub-commits 12.1/12.2/12.3 split the work across sub-commits without leaving a half-migrated state.

**Alternative considered: keep `text` always present, add `toolUse?` optionally.** Rejected because it lets callsites silently consume the wrong shape; the discriminant forces explicit handling.

### 5.6 Cost accounting under tool use

Verified by reading [llm-client.ts:266-272](lib/ai/llm-client.ts#L266) — `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens` all come from `response.usage` which is the same object regardless of whether the response contains text or tool_use blocks. Anthropic counts tool-use output tokens (the JSON serialization the model emits internally) toward the same `output_tokens` field.

**Conclusion: pricing.ts:73-78 cost math works unchanged for tool use. No PR 12 changes needed in pricing.**

---

## Section 6 — Tool schema centralization (Decision C2)

### 6.1 File shape

`lib/ai/tool-schemas.ts` (new in sub-commit 12.1):

```ts
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

// ─── Sub-shape definitions (referenced via JSON Schema $ref) ──────────────
//
// Defined once and reused across the JSON cluster's tool schemas where
// the same object appears (e.g. ClaudeFieldMapping inside both
// emit_table_mappings and emit_field_mappings).

const FIELD_MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    source_field: { type: 'string' },
    target_field: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
    similar_fields_considered: { type: 'array', items: { type: 'string' } },
    type_compatibility: { type: 'string' },
    needs_transformation: { type: 'boolean' },
    mapping_type: { type: 'string', enum: ['one_to_one', 'many_to_one', 'one_to_many'] },
    contributing_source_fields: { type: 'array', items: { type: 'string' } },
    combination_hint: { type: 'string' },
    split_hint: { type: 'string' },
  },
  required: ['source_field', 'target_field', 'confidence', 'reasoning'],
} as const

// ─── 13 JSON-cluster tools ────────────────────────────────────────────────

export const EMIT_TABLE_MAPPINGS_TOOL: Tool = {
  name: 'emit_table_mappings',
  description: 'Emit the structured set of source-to-target mappings for the given schemas. Each entry pairs a source table with a target table and contains the per-field mappings between them.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      table_mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source_table: { type: 'string' },
            target_table: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 100 },
            reasoning: { type: 'string' },
            field_mappings: { type: 'array', items: FIELD_MAPPING_SCHEMA },
          },
          required: ['source_table', 'target_table', 'confidence', 'reasoning', 'field_mappings'],
        },
      },
    },
    required: ['table_mappings'],
  },
}

// ... 12 more JSON tools ...

// ─── 7 SQL/text-cluster tools ─────────────────────────────────────────────

export const EMIT_SQL_TRANSFORM_TOOL: Tool = {
  name: 'emit_sql_transform',
  description: 'Emit the SQL expression that transforms the source field value into the target field value...',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A single SQL expression suitable for a SELECT clause.' },
    },
    required: ['sql'],
  },
}

// ... 6 more SQL/text tools ...
```

### 6.2 Estimated file size

20 distinct schemas × (~25-35 LOC per schema, accounting for shared sub-schemas) = **~500-700 LOC**, plus ~20-30 LOC of shared sub-schema definitions = **~550-750 LOC total.**

Smaller than the original investigation's "~1000 lines" because:
- 4 callsites share `emit_table_mappings` (saves 3 schemas)
- 2 callsites share `emit_sql_query` (saves 1)
- 2 callsites share `emit_sql_package` (saves 1)
- `ClaudeFieldMapping` and similar sub-shapes are factored as constants

### 6.3 Per-feature mapping

Settle's "one tool per callsite" convention means the eval runner / callsite caller passes the right tool. A small lookup helper centralizes this:

```ts
// lib/ai/tool-schemas.ts
const FEATURE_TO_TOOL: Record<LLMFeature, Tool | null> = {
  mapping_generate: EMIT_TABLE_MAPPINGS_TOOL,
  mapping_generate_repair: null,        // dead under tool use; remove from union or keep null
  mapping_generate_legacy_pair: EMIT_TABLE_MAPPINGS_TOOL,
  mapping_generate_legacy_pair_repair: null,
  mapping_suggest: EMIT_MAPPING_SUGGESTION_TOOL,
  mapping_suggest_legacy_bulk: EMIT_FIELD_MAPPINGS_TOOL,
  transform_generate: EMIT_SQL_TRANSFORM_TOOL,
  transform_describe: EMIT_DESCRIPTION_TOOL,
  // ... (24 more)
  eval_mapping: EMIT_TABLE_MAPPINGS_TOOL,        // eval inherits production tool
  eval_validation_rule: EMIT_VALIDATION_RULE_TOOL,
  eval_transform: EMIT_SQL_TRANSFORM_TOOL,
  eval_nl_to_sql: EMIT_SQL_QUERY_TOOL,
}

export function getToolForFeature(feature: LLMFeature): Tool | null {
  return FEATURE_TO_TOOL[feature] ?? null
}
```

This lets callsites stay terse: instead of `tool: EMIT_X_TOOL`, callers pass `tool: getToolForFeature(opts.feature)` if the architect prefers feature-driven dispatch. **Recommendation: do NOT add this lookup helper in PR 12.** Per-callsite explicit `tool:` declarations are clearer for code review and don't require a central dispatch table to stay in sync. The lookup is gravy that PR 13's caching (which needs to find the tool per call) might reuse.

---

## Section 7 — Phasing within PR 12 (Decision A2 — three sub-commits)

### 7.1 Sub-commit 12.1 — JSON cluster (16 callsites)

**Touches:**
- `lib/ai/tool-schemas.ts` (NEW) — 13 JSON tool schemas (~400-500 LOC)
- `lib/ai/llm-client.ts` — add `tool?: Tool` param + discriminated `CallLLMResult` (~80-100 LOC)
- 12 callsite files — migrate inline `JSON.parse` to tool-use consumption
- 2 callsites in `mapping-engine.ts` + `mappings.ts` — REMOVE the parse-failure repair retries (-41 LOC)
- Tests pinning model strings or response shapes — update where the discriminated-union compiler shows compile errors

**Estimated total LOC delta:** +500-650 / -150-200 = **net +350-500 LOC.**

**Verification gates before moving to 12.2:**
1. `pnpm tsc --noEmit` — clean. The discriminated-union `CallLLMResult` will fail to compile every callsite that reads `result.text` without checking `result.kind`. This is THE forcing function — every JSON callsite is forced to handle the new shape before tsc passes.
2. `pnpm vitest run` — 2956 baseline + ~20-30 new tool-schema tests.
3. `pnpm test:integration tests/integration/mappings-for-redesign-heritage.test.ts` — heritage test will SHIFT because the AI is now using a tool. Expect new fingerprints; verify the integration test still asserts on the structural shape (mapping count, field-pair existence) rather than byte-fingerprints.
4. **Smoke gate:** `AI_PHASE_2_ENABLED=1 pnpm eval mapping --dataset _fixture --smoke` — must score 1.0 with the new tool path. ~$0.03 spend.

If smoke fails on 12.1, STOP — do not proceed to 12.2 until JSON cluster is provably correct.

### 7.2 Sub-commit 12.2 — SQL/text cluster (9 callsites)

**Touches:**
- `lib/ai/tool-schemas.ts` — append 7 SQL/text tool schemas (~100 LOC)
- 8 callsite files — migrate response handling from `result.text` + extractor to `result.toolUse.input.sql/ddl/description/content`
- `nl_to_sql_retry` — UNCHANGED migration; it continues to retry on DB failure, just emits via `emit_sql_query` tool now
- The 2 SQL extractors `lib/ai/sql-extractor.ts` (`extractTransformSQL`, `extractSelectSQL`) — likely deletable since tool use eliminates the prose-extraction step. Confirm zero remaining callers, then delete

**Estimated total LOC delta:** +150-200 / -100-150 = **net +50-100 LOC.**

**Verification gates before moving to 12.3:**
1. `pnpm tsc --noEmit` — clean.
2. `pnpm vitest run` — full suite.
3. **Per-callsite one-shot smoke:** for each of the 8 SQL/text callsites, exercise the path against a real production project in dev and verify the produced SQL/text is sensible. ~$0.10 spend across 8 features.
4. `tests/integration/llm-calls-logging.test.ts` (env-gated) — verify `feature` and `model` are still logged correctly when tool use is active.

### 7.3 Sub-commit 12.3 — Streaming cluster (1 callsite)

**Touches:**
- `lib/ai/llm-client.ts` (`callLLMStreaming`) — add tool-use response handling parallel to `callLLM`'s (~30-50 LOC)
- `lib/actions/execution-package.ts:460` — migrate `outputs_execution_package_compartmentalized` callsite, REMOVE the heavy recovery logic at lines 491-525 (-35 LOC)

**Estimated total LOC delta:** +30-50 / -35 = **net +0-15 LOC.**

**Verification gates:**
1. `pnpm tsc --noEmit` — clean.
2. `pnpm vitest run` — full suite.
3. **Pre-merge §9 probe:** one-shot real API call exercising `outputs_execution_package_compartmentalized` against a dev project. Confirms streaming + tool_use + Opus 4.7 + effort='high' all compose. ~$0.05 spend.
4. Manual verification: dialect-detection-failure path triggers `outputs_execution_package_fallback` (which is non-streaming and was already migrated in 12.2).

### 7.4 Total PR 12 estimated LOC delta

12.1 (+350-500) + 12.2 (+50-100) + 12.3 (+0-15) = **net +400-615 LOC across PR 12.**

Lower than the original investigation's "~750-1350 LOC" estimate because:
- The misclassifications moved 5 features from JSON (which need full tool schemas + parse changes) to SQL/text (which need lightweight `{ sql: string }` schemas + simpler migration)
- Shared schema reuse (4 mapping callsites → 1 tool, 2 SQL package callsites → 1 tool, 2 nl-to-sql callsites → 1 tool) reduces schema count
- Repair-retry removal subtracts 41 LOC (originally framed as additive)

---

## Section 8 — Risk assessment

### 8.1 Sub-commit 12.1 (JSON cluster) — biggest sub-commit

**Risk 1: Tool schema mismatch with downstream parsing.** A schema like `emit_validation_rule` says `rule_type: enum(11 values)`, but the downstream code at `validation-rules.ts:351-374` may expect more values, or treat unknown values silently.
**Verification:** per-callsite unit test that parses a known-good tool input through the production code path. The eval harness fixture (PR 10.6) exercises one callsite end-to-end; sub-commit 12.1 should add per-feature smoke tests for the other 11 JSON callsites.

**Risk 2: Discriminated-union compile errors hide a callsite.** If a callsite isn't fully migrated (e.g., still reads `result.text` without a `kind` check), the compiler catches it. But if a callsite is migrated WRONG (e.g., reads `result.toolUse.input.field_mappings` when the tool emits `table_mappings`), the compiler accepts it because both fields are typed as `Record<string, unknown>`.
**Verification:** runtime unit tests assert on the field NAMES being read out of `toolUse.input`. The compile-time guarantee only covers the `kind` discriminant, not the content shape.

**Risk 3: A callsite's parsed JSON has a shape the tool schema can't express.** Anthropic's `input_schema.type` MUST be `'object'`. The two array-at-top-level callsites (`migration_intelligence` returning `ExtractedPattern[]`, `nl_suggest_queries` returning `string[]`) need wrapping under a property name.
**Verification:** schema-design review surface — wrap arrays under a stable property like `patterns` / `suggestions` BEFORE writing the migration code, not as a late-stage fix.

**Risk 4 (bonus): Heritage integration test fingerprint shift.** Tool use changes the prompt structure (system prompt + tool declaration) and the response shape. Even if the mapping output is structurally identical, byte-fingerprints will shift.
**Verification:** the heritage test pre-PR-12 asserted byte-identical fingerprints (12 pass / 1 skipped). PR 12 should switch the heritage test's fingerprint assertions to STRUCTURAL assertions (correct mapping count, correct field-pair existence). Document this as a deliberate baseline reset.

### 8.2 Sub-commit 12.2 (SQL/text cluster)

**Risk 1: Tool schema for SQL output overconstrains and the model can't produce valid SQL.** A schema like `{ sql: string }` is unconstrained, but a description that says "must be a single SELECT statement" might cause the model to decline edge cases (multi-statement DDL, comments, etc.).
**Verification:** the `description` field on each tool schema should be permissive ("the SQL transformation expression" — not "a single SELECT"). Test against the eval harness fixture for `transform_generate`; manual smoke for the others.

**Risk 2: `nl_to_sql_retry` accidentally narrowed.** The retry path is DB-failure-driven; if a sub-commit-12.2 author misreads the spec and adds a `kind === 'toolUse'` check that excludes the DB-failure case, the retry breaks silently.
**Verification:** integration test that simulates a DB failure on the primary call and asserts the retry fires. Build this BEFORE migrating the callsite.

**Risk 3: SQL extractor deletion (`extractTransformSQL`, `extractSelectSQL`) leaves an orphan import.**
**Verification:** `grep -rn 'extractTransformSQL\|extractSelectSQL' lib/ app/ tests/` after migration. Zero matches → safe to delete.

### 8.3 Sub-commit 12.3 (Streaming cluster)

**Risk 1: Tool-use streaming protocol differs from what we assume.** The SDK types support it, but no production code in this repo has exercised it. Specifically: does `stream.finalMessage()` return a fully-assembled tool_use block, or do we need to handle deltas via `stream.on('contentBlockDelta', ...)`?
**Verification:** the §9 probe (one-shot real API call). Pre-merge gate.

**Risk 2: Streaming + tool_use + Opus 4.7 + effort='high' compositional issues.** Four-way combination. `effort='high'` produces extended thinking blocks. Tool use produces tool_use blocks. Streaming routes through the streaming endpoint. None of these have been combined in production yet.
**Verification:** §9 probe explicitly exercises this combination, not just two-of-four.

**Risk 3: Heavy recovery logic at execution-package.ts:491-525 removed too aggressively.** The current code handles truncation recovery with brace counting. Tool use SHOULD make this unnecessary, but if Anthropic's tool-use validation rejects on truncation, the user sees a hard error instead of a recovered output.
**Verification:** test on a deliberately-too-large project where the response approaches `max_tokens`. Confirm the failure mode is "tool use returns nothing" rather than "tool use returns malformed input".

---

## Section 9 — Items requiring code execution

This investigation is read-only. The following 2 items need a probe before PR 12 implementation begins:

### 9.1 One-shot tool-use streaming probe

**Question:** does `callLLMStreaming` + `tool_use` + Opus 4.7 + `effort='high'` work end-to-end?

**Probe:** one-shot Anthropic API call from a Node REPL using the SDK 0.78.0:

```ts
const stream = await anthropic.messages.stream({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  output_config: { effort: 'high' },
  system: 'You are a SQL expert.',
  messages: [{ role: 'user', content: 'Write a SELECT to count rows in users.' }],
  tools: [{
    name: 'emit_sql',
    description: 'Emit the SQL query.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    strict: true,
  }],
  tool_choice: { type: 'tool', name: 'emit_sql', disable_parallel_tool_use: true },
})
const message = await stream.finalMessage()
console.log(message.content)
```

Expected: `message.content` contains a `ToolUseBlock` with `name: 'emit_sql'` and `input: { sql: 'SELECT COUNT(*) FROM users' }` (or similar valid SQL).

**Cost:** ~$0.001. **Pre-merge gate for sub-commit 12.3.**

### 9.2 Token-count delta when prompts include tool definitions

**Question:** how many tokens does adding a tool declaration add to a request?

**Probe:** measure `input_tokens` for a known callsite (e.g. mapping_generate) before and after adding the tool declaration. Use the existing `llm_calls.input_tokens` instrumentation; no new code needed.

**Why it matters:** PR 13 prompt caching has a 4096-token minimum prefix on Opus 4.7. If the tool declaration is ~200 tokens, it slots above the system prompt and consumes part of the cache prefix. Mapping's 18K-token system prompt comfortably accommodates this; smaller-system-prompt features (validation_rule_from_nl ~1K tokens) may have their tools push them over the threshold OR the schema-bloat may not be worth caching for those features.

**Cost:** $0 (just a SQL query against `llm_calls` after the first PR 12 callsite is migrated and exercised once). Can be deferred until sub-commit 12.1 lands.

---

## What's NOT in this investigation (out of scope)

- PR 12 implementation prompts — the architect drafts those from this report
- Runtime behavior of tool-use streaming (flagged in §9.1 for one-shot probe)
- Token-count delta from tool declarations (flagged in §9.2)
- PR 13 caching design (separate sub-PR)
- Phase 3 (specialized agents, multi-tool flows, self-consistency)
- Decision on whether to delete `lib/ai/sql-extractor.ts` after 12.2 (depends on whether anything else in the codebase references it; flag as a small follow-up question)
- Decision on the heritage integration test's structural-vs-byte-fingerprint posture (raised in §8.1 Risk 4; needs explicit architect call)

---

## Appendix — One-line summary for the architect

**PR 12 is smaller than the original investigation suggested** (~400-615 net LOC vs. ~750-1350). The 6 callsite reclassifications shrink the JSON cluster by 5 (16 not 22) and grow the SQL/text cluster by 4 (9 not 5). `nl_to_sql_retry` survives unchanged — it's already DB-failure-only. The discriminated-union `CallLLMResult` is the load-bearing forcing function: tsc fails until every callsite is migrated. Sub-commit 12.1 (JSON cluster + repair-retry removal) is the biggest piece; 12.2 and 12.3 are smaller and lower-risk.

*End of PR 12 readiness investigation.*
