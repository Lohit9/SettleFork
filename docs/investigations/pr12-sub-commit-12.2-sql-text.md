# PR 12 sub-commit 12.2 — SQL/text cluster (Phase A investigation, read-only)

**Type:** Read-only investigation. The only artifact this phase produces is this document.

**Audience:** Phase B implementer + Kaan for tool-design sign-off.

**Scope:** Audit the 9 SQL/text `callLLM` callsites, design their migration to tool-use under flag-ON (mirroring PR 12.1's JSON-cluster pattern), surface latent bugs, and recommend a phasing.

**Out of scope:** Streaming cluster (PR 12.3 — `lib/actions/execution-package.ts:464` via `callLLMStreaming`). Prompt caching (PR 13).

---

## DIVERGENCE callouts

1. **No DIVERGENCE on callsite count.** Inventory found exactly **9** SQL/text callsites matching the prompt's premise.
2. **No DIVERGENCE on `_outputs-core.ts` cluster classification.** The `outputs_readiness_report` callsite ([_outputs-core.ts:762](../../lib/actions/_outputs-core.ts#L762)) is in the SQL/text cluster as the prompt asserted — confirms B's Item 2.2 unblock dependency on PR 12.2 (not PR 12.3).
3. **All 9 callsites are pre-tagged.** Each has an inline comment of the form `// PR 12: SQL/text callsite — migrated in sub-commit 12.2.` already in place from PR 12.1's planning pass. The comments include text-vs-toolUse narrowing for the discriminated union, so the wrapper-side plumbing is already done. PR 12.2 just adds `tool: EMIT_X_TOOL` plus the toolUse parsing branch.
4. **`EMIT_SQL_QUERY_TOOL` is referenced but not authored.** [query.ts:202](../../lib/actions/query.ts#L202) carries an inline note `// to pass tool: EMIT_SQL_QUERY_TOOL.` — that tool schema does NOT exist in [`lib/ai/tool-schemas.ts`](../../lib/ai/tool-schemas.ts). PR 12.2 must author it (along with one more new tool per Section 2). The 13 existing `EMIT_*_TOOL` exports cover the JSON cluster.
5. **The "consolidation" framing in the prompt is slightly imprecise.** All 24 `callLLM` invocations in the codebase already route through [`lib/ai/llm-client.ts`](../../lib/ai/llm-client.ts) (no direct Anthropic SDK bypasses). PR 12.2 is **migration to tool-use under flag-ON**, not consolidation per se. Same pattern PR 12.1 applied to the JSON cluster. This nomenclature gap doesn't change scope; the report uses "migration" below.

---

## TL;DR

| Callsite | Feature | Output type | Migration outcome | Tool needed |
|---|---|---|---|---|
| [query.ts:212](../../lib/actions/query.ts#L212) | `nl_to_sql` | SQL string | Tool-use | `EMIT_SQL_QUERY_TOOL` (new) |
| [query.ts:282](../../lib/actions/query.ts#L282) | `nl_to_sql_retry` | SQL string | Tool-use | reuse `EMIT_SQL_QUERY_TOOL` |
| [_outputs-core.ts:762](../../lib/actions/_outputs-core.ts#L762) | `outputs_readiness_report` | Markdown text | Stay-text OR thin tool | (decision needed §2.3) |
| [transformations.ts:1331](../../lib/actions/transformations.ts#L1331) | `transform_generate` | SQL expression | Tool-use | `EMIT_TRANSFORM_SQL_TOOL` (new) |
| [transformations.ts:2784](../../lib/actions/transformations.ts#L2784) | `transform_describe` | Short prose | Stay-text | n/a |
| [execution-package.ts:345](../../lib/actions/execution-package.ts#L345) | `outputs_execution_package_monolithic` | SQL bundle | Stay-text OR thin tool | (decision needed §2.6) |
| [execution-package.ts:623](../../lib/actions/execution-package.ts#L623) | `outputs_execution_package_fallback` | SQL bundle | Stay-text OR thin tool | (decision needed §2.7) |
| [manual-fix.ts:205](../../lib/actions/manual-fix.ts#L205) | `manual_fix` | UPDATE/DELETE SQL | Tool-use | `EMIT_FIX_SQL_TOOL` (new) — could reuse a generic `EMIT_SQL_QUERY_TOOL` if the schema is permissive enough |
| [ddl-conversion.ts:66](../../lib/ai/ddl-conversion.ts#L66) | `ddl_conversion` | DDL text | Stay-text | n/a (parser-verified downstream) |

**Recommendation: Option B-3 (tool-use only for the 4 SQL-emitting callsites; keep 5 text-emitting callsites text-path).** See §5.

The 4 tool-use migrations need 2-3 new tool schemas (or 1 schema reused across 4 callsites); the 5 stay-text callsites get cosmetic cleanup of their narrowing checks but no structural change. Net result: tighter SQL safety on the surfaces that emit executable SQL; no churn on prose surfaces.

---

## Section 1 — Inventory pass

### Total `callLLM` invocations: 24

All 24 route through [`lib/ai/llm-client.ts`](../../lib/ai/llm-client.ts). No direct Anthropic SDK bypasses (verified via `grep -r "anthropic.messages.\(create\|stream\)\|new Anthropic\b"` returning only `llm-client.ts` itself).

### Cluster decomposition

| Cluster | Count | PR | Status |
|---|---|---|---|
| **JSON cluster** (tool-use under flag-ON) | 13 primary + 1 retry-companion = 14 | PR 12.1 (PR #23, `9361e8a`) | Shipped |
| **SQL/text cluster** (this PR) | 9 | PR 12.2 | This investigation |
| **Streaming cluster** (`callLLMStreaming`) | 1 (`execution-package.ts:464`) | PR 12.3 | Future |

Plus 2 JSON-repair retries (`mappings.ts:262`, `mapping-engine.ts:1539`) that have NO `tool:` because their job is to re-emit clean JSON when the tool-use primary failed — those are companions to the JSON cluster, not SQL/text members.

Tool-presence audit (`feature` × `tool` per callsite):

```
JSON cluster (already on tool-use):
  query.ts:498                  nl_suggest_queries          tool=YES (EMIT_QUERY_SUGGESTIONS_TOOL)
  migration-runbook.ts:544      outputs_migration_runbook   tool=YES (EMIT_MIGRATION_RUNBOOK_TOOL)
  schema-enrichment.ts:221      schema_enrichment           tool=YES (EMIT_SCHEMA_CORRECTIONS_TOOL)
  schema-merge.ts:785           schema_merge_ai_match       tool=YES (EMIT_TABLE_MATCHES_TOOL)
  migration-intelligence.ts:909 migration_intelligence      tool=YES (EMIT_EXTRACTED_PATTERNS_TOOL)
  ai-quality-detection.ts:347   quality_detection_ai        tool=YES (EMIT_QUALITY_ISSUES_TOOL)
  validation-rules.ts:362       validation_rule_from_nl     tool=YES (EMIT_VALIDATION_RULE_TOOL)
  mappings.ts:219               mapping_generate_legacy_pair       tool=YES (EMIT_FIELD_MAPPINGS_TOOL)
  mappings.ts:2499              mapping_suggest_legacy_bulk        tool=YES
  mapping-engine.ts:1500        mapping_generate            tool=YES (EMIT_FIELD_MAPPINGS_TOOL)
  mapping-engine.ts:1975        mapping_suggest             tool=YES (EMIT_MAPPING_SUGGESTION_TOOL)
  ddl-parser.ts:394             ddl_parsing                 tool=YES (EMIT_PARSED_DDL_TOOL)
  fix-engine.ts:476             quality_fix_options         tool=YES (EMIT_FIX_OPTIONS_TOOL)

JSON-repair retries (companions; tool-use inappropriate by design):
  mappings.ts:262               mapping_generate_legacy_pair_repair  tool=NO
  mapping-engine.ts:1539        mapping_generate_repair              tool=NO

SQL/text cluster (THIS PR):
  query.ts:212                  nl_to_sql                      tool=NO
  query.ts:282                  nl_to_sql_retry                tool=NO
  _outputs-core.ts:762          outputs_readiness_report       tool=NO
  transformations.ts:1331       transform_generate             tool=NO
  transformations.ts:2784       transform_describe             tool=NO
  execution-package.ts:345      outputs_execution_package_monolithic  tool=NO
  execution-package.ts:623      outputs_execution_package_fallback    tool=NO
  manual-fix.ts:205             manual_fix                     tool=NO
  ddl-conversion.ts:66          ddl_conversion                 tool=NO
```

---

## Section 2 — Per-callsite deep audit (9 SQL/text callsites)

### 2.1 `query.ts:212` — `nl_to_sql`

- **File:line:** [`lib/actions/query.ts:212`](../../lib/actions/query.ts#L212)
- **Containing function:** `executeNLQuery(projectId, question)` — server action ('use server' file)
- **Production callers:** the NL-query feature in the Migration Center / data-overview UI; one call path
- **Output:** A SELECT SQL string. Currently text-stripped of fences via local `stripFences` + `extractSelectSQL` regex helpers (lines 201-207 + helper imported from elsewhere)
- **Existing observability:** `llm_calls` row written by wrapper. `feature='nl_to_sql'`, `promptVersion='nl-to-sql-v1'`, `metadata` empty. No `ai_edit_history` (no DB row mutated by this call — it executes SQL but doesn't persist a row tagged to the AI proposal)
- **`featureOverride` status:** Not supported. PR 11 will wire `eval_nl_to_sql` per the LLMFeature enum's reservation
- **Migration design (tool-use):**
  - New `EMIT_SQL_QUERY_TOOL` with shape `{ sql: string }` plus optional `assumptions: string[]` for documentation
  - Strict-mode default pattern: `additionalProperties: false`, no `minLength`, range constraints in description
  - Replace `extractSelectSQL` post-processing with direct `.input.sql` consumption (the schema validator at Anthropic's edge guarantees a clean string; fence-stripping is no-op under tool-use)
  - Keep `extractSelectSQL` as a flag-OFF fallback per the `result.kind === 'toolUse' ? ... : extractSelectSQL(...)` shape used in PR 12.1's other callsites
- **Latent bugs:** None obvious. The `result.kind !== 'text'` narrowing at line 222 is consistent with the wrapper's discriminated union; switching it to handle the toolUse branch is mechanical

### 2.2 `query.ts:282` — `nl_to_sql_retry`

- **File:line:** [`lib/actions/query.ts:282`](../../lib/actions/query.ts#L282)
- **Containing function:** Same `executeNLQuery`; this is a SECOND callLLM invocation when the primary's SQL fails at execution time
- **Output:** Corrected SELECT SQL string
- **Caller fan-out:** Triggered conditionally inside `executeNLQuery` when `result.error` is set and the error is not in a non-retryable list (permission denied / timeout / rate limit / cancelled)
- **Existing observability:** `llm_calls` row written. `parentCallId: primaryCallId` chains it to the primary. `feature='nl_to_sql_retry'`, `promptVersion='nl-to-sql-retry-v1'`
- **Migration design:** Reuse `EMIT_SQL_QUERY_TOOL` from §2.1
  - The inline comment at [query.ts:292-296](../../lib/actions/query.ts#L292) confirms: "this retry is DB-failure-driven (not parse-failure-driven), so it survives tool-use migration as a kept retry (not removed dead code)"
  - That distinction matters: JSON-repair retries (mappings.ts:262, mapping-engine.ts:1539) are dead code under tool-use because tool-use guarantees parseable output; this retry handles SQL that PARSED FINE but FAILED in Postgres, so it survives
- **Latent bugs:** None

### 2.3 `_outputs-core.ts:762` — `outputs_readiness_report` ⭐ B's Item 2.2 dependency

- **File:line:** [`lib/actions/_outputs-core.ts:762`](../../lib/actions/_outputs-core.ts#L762)
- **Containing function:** `generateReadinessReport(projectId, opts?)` — server action
- **Production callers:** the Outputs / Migration Center "Generate Readiness Report" button + scheduled job
- **Output:** Multi-thousand-character markdown narrative consumed by `buildReadinessDocx` (line 788) which converts to .docx via `docx` package and uploads to Storage
- **Caller fan-out:** Single UI action button + scheduled job; small fan-out
- **Existing observability:** `llm_calls` row written. `feature='outputs_readiness_report'`, `promptVersion='readiness-report-v1'`, `metadata` empty
- **Migration design:** **DECISION NEEDED.** Two options:

  - **Option A — stay-text.** Markdown narrative is a textual artifact — tool-use offers no schema-validation gain because the schema would just be `{ report: string }`. Keep the call as text and remove the narrowing-only `if (result.kind !== 'text')` guard (cosmetic cleanup).
  - **Option B — thin tool with structured sections.** Author `EMIT_READINESS_REPORT_TOOL` with `{ executive_summary: string, findings: string[], recommendations: string[], full_markdown: string }`. The DOCX builder could exploit the structured sections for better layout. Cost: schema-design effort + DOCX builder rewrite + risk of breaking the "narrative reads naturally" property.

  **Recommendation: Option A.** The downstream consumer (`buildReadinessDocx`) is set up to receive a markdown string; tool-use here would be schema-validation theater with zero correctness benefit. Stay-text + cosmetic cleanup.
- **Latent bugs:** The narrowing-check fallback `throw new Error('outputs_readiness_report: unexpected toolUse response')` at line 778 is dead code today (no `tool` is passed) and stays dead code after Option A. No bug; just dead-code worth removing.
- **B's Item 2.2 implication:** Option A keeps `_outputs-core.ts` exports stable (signatures, return shapes, errors) — Item 2.2 unblock is one cosmetic cleanup PR away

### 2.4 `transformations.ts:1331` — `transform_generate`

- **File:line:** [`lib/actions/transformations.ts:1331`](../../lib/actions/transformations.ts#L1331)
- **Containing function:** `generateTransform(ctx, description)` — server action wrapped in `guardWrites`
- **Production callers:** Transform tab "Generate" button per target field; bulk generator in batch flow
- **Output:** SQL transformation expression (e.g., `REGEXP_REPLACE(row_data->>'price', '[$,]', '', 'g')::numeric`)
- **Existing observability:** `llm_calls` row written. `feature='transform_generate'`, `promptVersion='transform-generate-v1'`, `metadata={ tfm_id, target_field_id }`. `ai_edit_history` row written downstream of this call (lines 1480+) when the transformation is upserted
- **Migration design:** **Tool-use.** New `EMIT_TRANSFORM_SQL_TOOL` with `{ sql: string }` plus optional `assumptions: string[]`. Could reuse a single `EMIT_SQL_EXPRESSION_TOOL` if §2.1 / §2.4 / §2.8 standardize on one schema, but the specifics differ:
  - `nl_to_sql` returns full SELECT statements
  - `transform_generate` returns expression-shaped SQL (no SELECT keyword) wrapped by `wrapWithNullGuard`
  - `manual_fix` returns DML (UPDATE/DELETE)

  Three different SQL types argue for three different tool schemas (or one with a discriminator), not one. Recommend per-callsite tools because the description text differs materially per type
- **Latent bugs:** None obvious. The `wrapWithNullGuard` post-processor at line 1360 needs to keep working under tool-use — it operates on the extracted SQL string, which is `result.toolUse.input.sql` instead of `result.text` post-migration

### 2.5 `transformations.ts:2784` — `transform_describe`

- **File:line:** [`lib/actions/transformations.ts:2784`](../../lib/actions/transformations.ts#L2784)
- **Containing function:** `suggestTransformDescription(ctx)` — server action; returns short prose to seed the description field a user types into
- **Production callers:** Transform tab "Suggest description" affordance per target field; small fan-out
- **Output:** Short string (typically 1-2 sentences) describing what a transformation should do
- **Existing observability:** `llm_calls` row written. `feature='transform_describe'`, `metadata={ tfm_id }`. `ai_edit_history` row written for provenance (line 2812+) tagged `entityType: 'target_field_mapping', fieldPath: 'ai_suggested_description'`
- **Special:** This is the only feature in `LOW_EFFORT_FEATURES` ([llm-client.ts:196](../../lib/ai/llm-client.ts#L196)) — under flag-ON it intentionally does NOT use `effort='high'`. That semantics carries through tool-use migration (effort is independent of tool use)
- **Migration design:** **Stay-text.** Tool-use for a 1-2-sentence prose suggestion is overkill. Cosmetic cleanup of the narrowing check
- **Latent bugs:** None

### 2.6 `execution-package.ts:345` — `outputs_execution_package_monolithic`

- **File:line:** [`lib/actions/execution-package.ts:345`](../../lib/actions/execution-package.ts#L345)
- **Containing function:** `generateExecutionPackageInternal(projectId, dialect, opts)` — server action
- **Output:** Multi-thousand-line SQL bundle (header comment + setup + per-table CREATE/INSERT + FKs + rollback). Currently consumed as a single string and split downstream by `splitMonolithicSQL`
- **Existing observability:** `llm_calls` row written. `feature='outputs_execution_package_monolithic'`, `metadata={ dialect }`
- **Migration design:** **DECISION NEEDED.** Same shape as §2.3:
  - **Option A — stay-text.** The SQL bundle is fundamentally a single text artifact; tool-use schema would be `{ sql: string }` adding no validation. Stay-text + cosmetic cleanup.
  - **Option B — thin tool with structured sections.** `EMIT_EXECUTION_PACKAGE_TOOL` with `{ checklist: string, schema_setup: string, table_scripts: Array<{ table_name: string, content: string }>, foreign_keys: string, rollback: string }`. The downstream `splitMonolithicSQL` becomes unnecessary because the AI emits already-split sections.

  **Recommendation: Option A** for PR 12.2; **Option B is a worthy follow-up** because the structured-section pattern would directly improve `splitMonolithicSQL`'s reliability (currently it relies on regex-matching `-- Table: <name>` markers). But that's a bigger surface-area change beyond PR 12.2 scope; tag as "consider for PR 14"
- **Latent bugs:** The `if (!rawSql || rawSql.trim().length < 100)` guard at line 366 is a fragile heuristic — under Option A it stays the same; under Option B it would become per-section-aware. Out of scope for PR 12.2

### 2.7 `execution-package.ts:623` — `outputs_execution_package_fallback`

- **File:line:** [`lib/actions/execution-package.ts:623`](../../lib/actions/execution-package.ts#L623)
- **Containing function:** Same `generateExecutionPackageInternal`; this is the FALLBACK path triggered when the compartmentalized path (PR 12.3 streaming, line 464) produces dialect-incorrect output
- **Caller fan-out:** Inside `generateCompartmentalizedPackage` only when `failedCount > 0` (dialect validation failure)
- **Existing observability:** `llm_calls` row with `parentCallId: primaryCallId` chained to the compartmentalized streaming primary. `feature='outputs_execution_package_fallback'`, `metadata={ dialect, dialect_validation_failed_count }`
- **Migration design:** Same as §2.6. Whatever §2.6 picks (recommended: Option A), this callsite mirrors. Both share the same prompt bundle's `fallbackSystemPrompt`/`fallbackUserMessage`/`fallbackMaxTokens`
- **Latent bugs:** None — but note that if §2.6 ever moves to Option B, §2.7 must move too (the bundle is shared)

### 2.8 `manual-fix.ts:205` — `manual_fix`

- **File:line:** [`lib/actions/manual-fix.ts:205`](../../lib/actions/manual-fix.ts#L205)
- **Containing function:** `generateManualFixSQL(projectId, tableId, fieldId, description)` — server action
- **Production callers:** Data Quality tab "Manual fix" affordance — user types a free-form fix description and the AI emits UPDATE/DELETE SQL
- **Output:** UPDATE or DELETE SQL targeting `data_rows`. Post-processed with markdown-fence stripping (line 221)
- **Existing observability:** `llm_calls` row written. `feature='manual_fix'`, `metadata={ table_id, field_id }`. No `ai_edit_history` (the SQL isn't auto-applied — the user reviews + applies via separate `applyFix` flow)
- **Migration design:** **Tool-use.** New `EMIT_FIX_SQL_TOOL` with `{ sql: string }` — could share a schema with `transform_generate`'s `EMIT_TRANSFORM_SQL_TOOL` if both use a generic SQL-string envelope, but the system prompts differ enough that two specialized tools are clearer
  - The downstream `validateFixSQL` (lib/quality/fix-sql-validator.ts) safety check stays in place — tool-use guarantees parseable JSON, not SQL safety
- **Latent bugs:** None

### 2.9 `ddl-conversion.ts:66` — `ddl_conversion`

- **File:line:** [`lib/ai/ddl-conversion.ts:66`](../../lib/ai/ddl-conversion.ts#L66)
- **Containing function:** `convertDocToDDL(projectId, userId, documentText)` — utility function called from schema-merge / data-onboarding flow
- **Output:** PostgreSQL CREATE TABLE statement(s) — multi-statement DDL text
- **Caller fan-out:** Internal — called by schema merge during onboarding when docs need DDL extraction
- **Post-processing:** Markdown fence strip + `parseDDL(cleaned).length === 0` parser-gate (drops Claude output that doesn't parse)
- **Existing observability:** `llm_calls` row written. `feature='ddl_conversion'`, `promptVersion='ddl-conversion-v1'`. No `ai_edit_history` (the resulting DDL is fed into deterministic merge pipeline; provenance is upstream)
- **Migration design:** **Stay-text.** The downstream `parseDDL` is the structural validator — and it works on text, not on a structured tool schema. Authoring a `EMIT_DDL_TOOL` would duplicate the parser's job at Anthropic's edge with looser semantics (Anthropic's strict-mode JSON Schema can't express "must be valid SQL DDL"). Stay-text + cosmetic cleanup
- **Latent bugs:** None

---

## Section 3 — Cluster commonality analysis

### What's shared across the 9

- **Wrapper integration:** All go through `callLLM`. All have `feature` + `promptVersion` set. All have `projectId` + `userId` + `abuseUserId`
- **Discriminated-union narrowing:** Each has the same `if (result.kind !== 'text') throw new Error('FEATURE: unexpected toolUse response')` pattern — pre-positioned by PR 12.1's planning pass. After PR 12.2: those that migrate to tool-use replace this with `result.kind === 'toolUse' ? input.sql : extractSQL(text)` per the standard PR 12.1 pattern. Those that stay text remove the dead-code throw
- **Error handling:** All wrap in try/catch + return `{ success: false, error: 'AI X failed. Please try again.' }`. Identical across callsites
- **No streaming:** None use `callLLMStreaming` (that's the PR 12.3 cluster, 1 callsite at execution-package.ts:464)

### What's unique per callsite

- **Output type splits 4-5:** 4 produce executable SQL (nl_to_sql primary + retry, transform_generate, manual_fix); 5 produce text artifacts (readiness report, execution package monolithic + fallback, transform_describe, ddl_conversion)
- **Post-processing varies:** SQL outputs all use a fence-strip + extractor regex (`extractSelectSQL`, `extractTransformSQL`, fence-strip). Markdown outputs pass through. DDL output uses `parseDDL` as a hard gate
- **Effort opt-out:** Only `transform_describe` and `nl_suggest_queries` are in `LOW_EFFORT_FEATURES`. Among the 9 SQL/text callsites: only `transform_describe`. Tool-use migration doesn't change effort semantics
- **Provenance writes:** `transform_generate` and `transform_describe` write `ai_edit_history` rows; the others don't (they don't mutate a tagged DB row, OR the mutation is downstream)
- **Retry chaining:** `nl_to_sql_retry` carries `parentCallId`; `outputs_execution_package_fallback` carries `parentCallId` (chained to the streaming primary at line 464)

The cluster is **structurally heterogeneous**: 4 SQL emitters can mechanically migrate to tool-use; 5 text emitters cannot meaningfully benefit. PR 12.2 needs a per-callsite design, not one uniform sweep.

---

## Section 4 — Latent bug surfacing

### B-1 — Effort policy gap on tool-use

**Severity:** Low.
**Description:** `LOW_EFFORT_FEATURES` is locked to `transform_describe` + `nl_suggest_queries`. Several PR 12.2 candidates produce documentary output (`outputs_readiness_report`, `outputs_execution_package_monolithic`, `outputs_execution_package_fallback`, `ddl_conversion`) that may also benefit from skipping `effort='high'`. None of these are currently on the list. PR 12.2 should not add them silently — but Phase B should consider whether any of them belong on the list as a separate PR follow-up.
**Scope decision:** OUT of PR 12.2. Tag as B-2 follow-up.

### B-2 — JSON-repair retries are now dead code (carry-over from PR 12.1)

**Severity:** Low.
**Description:** `mappings.ts:262` (`mapping_generate_legacy_pair_repair`) and `mapping-engine.ts:1539` (`mapping_generate_repair`) both exist to JSON-repair the output of their tool-use primaries — but tool-use guarantees parseable output, so these retries are unreachable under flag-ON. They're not in the SQL/text cluster (they're JSON-cluster companions), but they're a cousin issue that should get cleaned up sometime.
**Scope decision:** OUT of PR 12.2 (they're not SQL/text callsites). Tag as a future follow-up.

### B-3 — `EMIT_SQL_QUERY_TOOL` referenced before authored

**Severity:** Documentation-only.
**Description:** [query.ts:202](../../lib/actions/query.ts#L202) carries the inline comment `// pass tool: EMIT_SQL_QUERY_TOOL.` referring to a tool schema that does not exist yet. The comment is correct in intent — PR 12.2 authors it — but a future archaeologist could be confused if the comment landed before the tool. Recommend the PR 12.2 commit author the tool schema in the same commit as the comment-resolution.
**Scope decision:** IN PR 12.2; resolved by authoring the tool.

### B-4 — `outputs_readiness_report` narrowing check is dead code

**Severity:** Cosmetic.
**Description:** [_outputs-core.ts:777](../../lib/actions/_outputs-core.ts#L777) narrowing `if (result.kind !== 'text') throw` is dead today (no `tool` passed) and stays dead post-PR 12.2 if §2.3 picks Option A (stay-text). The throw is unreachable but harmless.
**Scope decision:** OPTIONAL in PR 12.2 — remove if cleaning up at the same time, but no functional bug.

### B-5 — `splitMonolithicSQL` reliance on regex markers

**Severity:** Pre-existing fragility.
**Description:** `lib/actions/execution-package.ts` uses `splitMonolithicSQL` to split a monolithic AI output by regex markers like `-- Table: <name>`. The AI sometimes drops or rephrases these markers. Option B in §2.6 (structured tool with named sections) would eliminate this fragility, but Option A leaves it as-is.
**Scope decision:** OUT of PR 12.2 unless §2.6 picks Option B (recommended: Option A, so it stays out).

**Latent-bug count: 5 surfaced; 1 actionable IN PR 12.2 (B-3); 4 deferred.** Lower than B-2's 3 latent bugs in 3 entry functions, consistent with PR 12.2 being a smaller migration.

---

## Section 5 — Implementation phasing

### Three options weighed

| Option | Scope | Risk | Phasing |
|---|---|---|---|
| **A — single sweep over all 9** | One commit for all 9 callsites; mirrors PR 12.1's posture | Largest blast radius; worst case 9 callsites × `result.kind` surface = 9 places to verify | Single PR |
| **B — split by output type (4 SQL + 5 text)** | 1 sub-commit migrates the 4 SQL emitters to tool-use; 1 sub-commit cosmetically cleans the 5 text emitters | Moderate; SQL migrations carry real schema risk, text cleanups are no-op | 2 sub-commits in one PR |
| **C — five sub-PRs** | Each callsite shipped independently | Smallest blast radius per change; highest coordination overhead | 5 PRs |

### Recommendation: **Option B — split by output type**

**Rationale:**
- The 4 SQL emitters share a common pattern (new tool schema + replace `extractX` regex with `.input.sql`). Bundle them so the tool-schema authoring effort amortizes across callsites
- The 5 text emitters share a different (cosmetic-only) pattern. Bundle them so the no-op nature of the change is visible at a glance — reviewer sees "5 narrowing-check edits, no behavior change"
- **B-1 (SQL): high-impact, ~250 LOC** — 3 new tool schemas (or 1 reused) in `lib/ai/tool-schemas.ts`, 4 callsite refactors with `result.kind === 'toolUse'` branches
- **B-2 (text): low-impact, ~50-80 LOC** — narrowing-check cleanups + dead-code removal across 5 callsites

**Recommended atomic shape:** Ship Option B as **one PR with two commits** (B-1: SQL → tool-use, B-2: text cleanup). This keeps `git bisect` granularity high while satisfying the "one concern per PR" handbook rule (the concern is "PR 12.2 sub-commit migration").

### Anticipated LOC delta

- New tool schemas in `lib/ai/tool-schemas.ts`: ~150-200 LOC (3 schemas at ~50-70 LOC each, mirroring existing JSON-cluster schema verbosity)
- 4 SQL callsite refactors: ~30-50 LOC each = ~120-200 LOC
- 5 text callsite cleanups: ~5-10 LOC each = ~25-50 LOC
- Test additions: 1-2 unit tests per new tool schema = ~50-100 LOC; integration tests likely byte-identical via heritage so no new tests there
- Investigation doc (this file, will be picked up by Phase B): ~ 480 LOC

**Total: ~350-550 LOC across the migration. Well under the 1,000 LOC budget B-2 used.**

---

## Section 6 — Verification gates

Standard set, mirroring PR 12.1 + Path 2 PR 1:

1. `pnpm tsc --noEmit` — clean
2. `pnpm vitest run` — passes the post-B-3 baseline (currently 3125; expect +5 to +20 from new tool-schema tests)
3. `pnpm test:integration tests/integration/mappings-for-redesign-heritage.test.ts` — flag-OFF byte-identical (heritage check) ✅ 12 pass / 1 skip
4. **6 flag-OFF eval pre-flights at $0** — `mapping`, `validation-rule`, `mapping-suggestion`, `quality-issues`, `extracted-patterns`, `fix-options` (regression check that synthetic-context teardown still works)
5. **5 flag-ON eval smokes (regression):** mapping → 1.000, validation-rule → 1.000, mapping-suggestion → 1.000, fix-options → 1.000, quality-issues → 0.700 (B-2's honest baseline)
6. **Extracted-patterns flag-ON smoke:** re-attempt now that Anthropic's grammar-compilation 503 may have recovered. If still failing, document and move on (already cataloged in [`docs/known-issues.md`](../known-issues.md))
7. **Manual feature tests:** spot-check ONE invocation per migrated callsite under flag-ON in a dev session — exercise NL→SQL, transform_generate, manual_fix, transform_describe (text), and the readiness report (text). These are not automated; they're human eyeball checks
8. **Spend cap: $0.30** (mostly the eval flag-ON smokes; PR 12.2 itself doesn't add LLM calls)

---

## Section 7 — Risk assessment

### R1 — Production behavior change under flag-OFF

**Risk:** Tool-use migration adds a flag-conditional branch. Flag-OFF must remain byte-identical to today — the heritage integration test catches this.
**Verification:** `pnpm test:integration tests/integration/mappings-for-redesign-heritage.test.ts` — 12 pass / 1 skip byte-identical to PR #23 baseline. **Same gate that PR 12.1 used.**

### R2 — Tool schemas hit Anthropic strict-mode constraints

**Risk:** New SQL-emitting tool schemas may stumble into the constraints cataloged in [`docs/anthropic-strict-mode-constraints.md`](../anthropic-strict-mode-constraints.md): `additionalProperties: false` required everywhere, no `oneOf`, no `additionalProperties: true`, no `minimum/maximum`, no `minItems/maxItems`. Description text is the only constraint mechanism.
**Verification:** Flag-ON smoke for each migrated callsite during PR 12.2 verification. Per the catalog, schema authors should expect 1-2 HTTP 400s before settling on a working shape — budget that into the implementation timeline.

### R3 — Latent bugs in 4 SQL callsites

**Risk:** Per PR 12.1's track record + Path 2 PR 1's 3-latent-bug discovery, expect 1-3 latent bugs to surface during PR 12.2 implementation. Most likely candidates: missing `evalContext.supabase` threading (already audited — none of the 9 callsites currently support eval context, so this is a Phase 3 concern, not a B-2 concern); fence-strip regex divergence between flag-OFF and flag-ON paths; `extractSelectSQL` / `extractTransformSQL` no longer needed under tool-use but retained as fallback (verify the fallback path actually works under flag-OFF with no `tool`).
**Verification:** Manual flag-ON smoke per migrated callsite (gate #7 in §6).

### R4 — Test count baseline shifts unpredictably

**Risk:** Path 2 PR 2 B-3 saw a +27 test delta from PR E.1 merging during the verification window. Similar drift could occur during PR 12.2.
**Verification:** Compute baseline AT MERGE TIME, not from this report. If baseline drifts by more than ~30 tests between PR start and PR end, flag in commit message + investigate (per Path 2 PR 1 / Path 2 PR 2 precedent).

### R5 — `_outputs-core.ts` exports change accidentally

**Risk:** B's Item 2.2 unblock requires `_outputs-core.ts` exports to remain stable through PR 12.2. The §2.3 recommendation (Option A — stay-text) makes this trivially true — no signature change. But a careless implementer might decide Option B is the "more thorough" choice and break the export shape.
**Verification:** Pin the §2.3 decision (Option A) in the Phase B implementation prompt. If §2.3 deviates to Option B, Phase B must explicitly call out that it's blocking B's Item 2.2 and require Kaan sign-off.

### R6 — `EMIT_QUERY_SUGGESTIONS_TOOL` has the SQL-string-only shape; mistakes when reusing

**Risk:** When authoring `EMIT_SQL_QUERY_TOOL`, schema authors might mistakenly look at `EMIT_QUERY_SUGGESTIONS_TOOL` (which is for nl_suggest_queries, not nl_to_sql) and copy its shape. The two tools have related names but produce different artifacts (suggestions are an array of starter questions; SQL is the executable output of one question).
**Verification:** Phase B prompt explicitly distinguishes the two; reviewer spot-checks tool-schema authorship.

### R7 — Cost reporting may not pick up new tools

**Risk:** Path 2 PR 2 B-2's verification surfaced that flag-ON smokes for `quality-issues` + `fix-options` + `mapping-suggestion` showed `$0.0000` cost (existing observability gap). PR 12.2's new flag-ON callsites may also show $0 in the cost-summing query if the underlying gap isn't resolved.
**Verification:** Spot-check `llm_calls` table directly (`SELECT feature, cost_usd FROM llm_calls WHERE feature LIKE '%manual_fix%' ORDER BY created_at DESC LIMIT 5`). If `cost_usd` is null for the new flag-ON migrations, the gap is the same one already documented; not a PR 12.2 defect.

---

## Section 8 — Surprises / divergences

### Surprises

1. **All 24 callsites already routed through the wrapper.** The "consolidation" framing in the prompt pre-supposes that some callsites bypass the wrapper, but none do. PR 12.2 is **migration to tool-use**, not consolidation. (Same observation as DIVERGENCE callout #5.)
2. **Pre-positioned in-line comments at all 9 callsites.** Each has a `// PR 12: SQL/text callsite — migrated in sub-commit 12.2.` breadcrumb left by PR 12.1's planning pass. The toolUse narrowing checks are also pre-positioned. PR 12.2 implementation is mostly mechanical given this scaffolding.
3. **5-of-9 callsites recommended for stay-text.** The "SQL/text" cluster name is misleading — only 4-of-9 produce SQL that benefits from tool-use. The other 5 are markdown / prose / DDL where tool-use is schema-validation theater.
4. **`EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` exists but is not wired.** [tool-schemas.ts:1287](../../lib/ai/tool-schemas.ts#L1287) defines `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` but the streaming callsite at `execution-package.ts:464` does NOT pass it. Either streaming + tool-use is an unsolved problem (it is, per Anthropic SDK) OR this tool was authored for the streaming PR (PR 12.3) and committed early. Out of scope for PR 12.2.
5. **Two of the 9 callsites share a prompt bundle.** `outputs_execution_package_monolithic` and `outputs_execution_package_fallback` both consume from `assembleMonolithicPrompt`'s output (with primary using `bundle.systemPrompt` and fallback using `bundle.fallbackSystemPrompt`). Whatever migration shape applies to one applies to the other.

### No DIVERGENCEs from prompt's claims

- ✅ Callsite count = 9 (matches prompt)
- ✅ `_outputs-core.ts` is in the SQL/text cluster (matches prompt; B's Item 2.2 unblocks via PR 12.2)
- ✅ Cluster is heterogeneous but mechanically migrate-able with per-callsite design
- ✅ No structural bugs that consolidation cannot resolve

---

## Out of scope

- Phase B implementation (the actual migration work — separate prompt)
- `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` wiring (PR 12.3)
- Adding new features to `LOW_EFFORT_FEATURES` (B-1 follow-up, separate PR)
- Cleaning up JSON-repair retries (B-2 follow-up, separate PR)
- `splitMonolithicSQL` regex-marker fragility (would need execution-package §2.6 Option B; defer to PR 14)
- Cost-reporting observability gap (Path 2 PR 2 B-2 surfaced this; separate PR)

## DIVERGENCE summary (consolidated)

1. Wrapper-vs-direct premise: All 24 callsites already route through the wrapper. PR 12.2 is migration to tool-use, not consolidation per se.
2. Per-callsite prep: All 9 SQL/text callsites are pre-tagged with PR 12.2 breadcrumbs and toolUse narrowing checks. Implementation is mostly mechanical from here.
3. Stay-text vs tool-use split: 4 of 9 callsites benefit from tool-use; 5 should stay text. The "SQL/text cluster" name is misleading; PR 12.2 is two distinct migrations (SQL→tool-use, text→cosmetic cleanup).
4. `EMIT_SQL_QUERY_TOOL` is referenced in [query.ts:202](../../lib/actions/query.ts#L202) inline comment but not authored. Phase B must author it.
5. `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` exists but is unwired (streaming + tool-use unsolved). Out of PR 12.2 scope.

*End of PR 12 sub-commit 12.2 — SQL/text cluster Phase A investigation.*
