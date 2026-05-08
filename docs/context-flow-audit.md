# Context-Flow Audit — what reaches AI agent prompts

**Audit date:** 2026-05-08
**Branch:** `chore/context-flow-audit`
**Scope:** every type of customer-uploaded content × every AI agent that consumes context.
**Status:** reference artifact. Each identified gap maps to a future ticket; this document does not prescribe fixes.

---

## 1. Executive summary

Three coverage findings of note. Two are propagation asymmetries — data exists in storage but the read path does not propagate it uniformly across consuming agents (same conceptual class as the BPR-via-RLS gap fixed in `fix/buildaicontext-field-load-rls`). The third is an architectural orphan — column and reader exist but no production write path was ever built.

**`projects.business_context` is an architectural orphan, not a propagation gap.** The column added in [migration 086](../supabase/migrations/086_project_business_context.sql) and the reader [`readBusinessContext`](../lib/ai/mapping-engine.ts#L355-L367) both exist, but no production write path was ever built. The only writer in the codebase is the eval fixture builder at [`synthetic-context-builder.ts:243`](../lib/eval/synthetic-context-builder.ts#L243); no UI surface or server action populates the column. In production the reader always returns `null`, the Path B agent-loop's prepend always short-circuits, and the "1/11 agents read it" framing is technically accurate but functionally vacuous — the consumer is dead code, not silently dropping data. Severity: LOW (architectural orphan / design debt). Fix shape is binary: build the UI write path (a deferred product item) or remove the column and reader.

**Migration intelligence reaches 6 of 11 agents.** `ProjectAIContext.intelligence_context` is populated by [`buildAIContext`](../lib/ai/context-builder.ts#L151) when the caller supplies a `userId`. Six callers interpolate it into their prompt; three fetch it but silently drop it (Path D, Validation NL), and Fix Suggestions doesn't even fetch it (passes `undefined` for `userId`). Severity: MEDIUM — a feature designed to span all agents has uneven coverage with no compile-time signal flagging the omissions.

**User decisions reach 0 of 11 agents.** `source_field_acknowledgments` is read for UI assembly only ([mapping-engine.ts:1249](../lib/ai/mapping-engine.ts#L1249)) and never enters an agent prompt. `ai_edit_history` is write-only — the codebase has insert paths at [path-d-mapping.ts:698](../lib/ai/path-d-mapping.ts#L698) and [ai-edit-history.ts:57](../lib/actions/ai-edit-history.ts#L57) but no SELECT call sites that feed prompt context. The "AI improves with user feedback" thesis is a load-bearing product positioning; the feedback loop is not yet wired into agent context. Severity: HIGH — product-weight match with the canonical product principle.

Beyond these three asymmetries, six findings surfaced that the input-type list did not anticipate. Two are promoted to §8 callouts: `tables.friendly_name` is invisible to every agent (naming-convention signal silently dropped), and the sample-data path is a static upload-time snapshot rather than a live read of `data_rows` (staleness boundary that becomes load-bearing when tool-use agents land).

---

## 2. Methodology

This audit is a static trace, file:line precise. Three dimensions:

1. **Storage verification.** Confirm each input's table/column exists in current schema. Note RLS posture where relevant.
2. **Read-path tracing.** Find every code path that reads the storage. Distinguish read-into-context-builder, read-into-action-handler, and read-into-UI-only.
3. **Prompt-arrival verification.** For each read path, identify the LLM call site that consumes it and the user-message template line that interpolates the value.

A row in the gap matrix is **✓ confirmed** only when all three dimensions check out: storage exists, read path exists, AND a specific prompt-template line interpolates the value. Anything weaker is a gap, ambiguous, or not-applicable-by-design.

**What this audit does not do:**
- Runtime verification. Flag-gated paths and conditional fetches are flagged as ambiguous when static analysis cannot determine reachability.
- Performance evaluation. Fetch redundancy, prompt-size budgets, and round-trip counts are out of scope.
- Fix proposal. Each gap is a candidate for a future ticket; this audit does not prescribe the ticket.

**Time-bound caveat.** A new agent or new context source introduced after the audit date is not reflected. The recommended re-run cadence is in §9.

**Citation durability.** Citations are valid as of commit `ea1e3ab`. Function and symbol names are the durable anchor — if a line range no longer matches, search by symbol (e.g., `buildMappingUserMessage`, `readBusinessContext`). The gap inventory's identity is the storage column / reader function pair, not the line numbers.

---

## 3. Storage map

Eight input types in the audit scope, plus migration intelligence as a bonus type (called out in the gap matrix).

**1. Source CSV row data.** Stored in `data_rows` (rows with `table_id` foreign-keying to a source-role `tables` row). Live row data is read by quality, staging, and validation paths; agent prompts consume it only via the upload-time-computed snapshot in `field_profiles.sample_values` and `field_profiles.value_distribution` — never directly. RLS: project-broad via `user_can_access_project(...)`.

**2. Target CSV row data.** Same shape as #1 but `dataset_role='target'`. Same indirection (samples come from `field_profiles`, not from a live read).

**3. Schema docs (DDL, ERD, data dictionaries).** Stored in `schema_documents` ([migration 002:73](../supabase/migrations/002_foundation.sql)). Constrained to `doc_type IN ('schema', 'business_context')` by [migration 021:7](../supabase/migrations/021_doc_types.sql). Schema docs are scoped via `dataset_id` (source or target). Extracted text in `extracted_text`.

**4. Business-context docs (uploaded files, e.g., BPR, requirements, value-mapping spreadsheets).** Same `schema_documents` table but with `doc_type='business_context'` and `project_id` set instead of `dataset_id`. The user can upload these per-project rather than per-dataset.

**5. `projects.business_context` free-text column.** Added in [migration 086](../supabase/migrations/086_project_business_context.sql) — a `TEXT` column on `projects`. Distinct from the file-based business-context docs in #4: this is the ad-hoc note field a user fills in on the project's settings page. Hard ceiling of 2000 chars enforced at read time by [`readBusinessContext`](../lib/ai/mapping-engine.ts#L347-L367).

**6. Field profiles.** Stored in `field_profiles` (one row per field). Columns: `null_percentage`, `cardinality`, `unique_percentage`, `format_issues_count`, `min_value`, `max_value`, `sample_values`, `value_distribution`. Computed at CSV ingestion and refreshed on data fix application (see §8.6 staleness boundary).

**7. Table-level metadata.**
- `tables.friendly_name` — written by [ddl-upload.ts:172](../lib/actions/ddl-upload.ts#L172). Read by [data-overview.ts](../lib/actions/data-overview.ts).
- `tables.data_modified_at` — written by [quality-fixes.ts:280](../lib/actions/quality-fixes.ts#L280) and [manual-fix.ts:458](../lib/actions/manual-fix.ts#L458). Read by [staging.ts:516-521](../lib/actions/staging.ts#L516-L521) for staleness detection. Correctly NOT in any agent prompt.

**8. User decisions.**
- `source_field_acknowledgments` — written by user actions on the Mapping page sidebar ("acknowledge this source field is intentionally unmapped"). Read by [mapping-engine.ts:1249](../lib/ai/mapping-engine.ts#L1249) for UI grid assembly only.
- `ai_edit_history` — provenance log for user edits to AI-proposed objects. Insert paths exist; no SELECT path feeds prompt context.

**Bonus type 9. Migration intelligence.** Stored in `migration_intelligence`. Cross-project user-scoped patterns harvested from completed migrations. Loaded by [`buildIntelligenceContext`](../lib/ai/context-builder.ts#L436) which gates on `userId` and `confidence >= 0.4`. Not on the original input list but spans the same coverage question as the rest.

---

## 4. Read-path catalog

This section walks each agent's context build. Eleven agents in scope. For each: entry point, context-build chain, user-message assembly site, and what's interpolated vs dropped.

### 4.1 Path D

**Entry:** [`runPathDMapping`](../lib/ai/path-d-mapping.ts) — `path-d-mapping.ts:240-251`. Server action [`generateMappings`](../lib/actions/mappings.ts) routes to it under flag-gating.

**Context build:** [path-d-mapping.ts:240-247](../lib/ai/path-d-mapping.ts#L240-L247) calls `buildAIContext(projectId, { tableIds }, userId, admin)`. The `userId` IS passed, so `intelligence_context` populates on the resulting `ProjectAIContext`.

**User-message assembly:** [`buildPathDUserMessage`](../lib/ai/path-d-system-prompt.ts#L558-L590) at `path-d-mapping.ts:251`. Composes:
- [`formatSchemaOverviewBlock(ctx)`](../lib/ai/context-builder.ts#L669) — counts, naming, FK density, doc presence flags.
- `formatPathDSchema(ctx.source_tables, 'source')` — Path-D-specific schema renderer that inlines field UUIDs.
- `formatPathDSchema(ctx.target_tables, 'target')`
- [`formatDocumentsForPrompt(ctx.documents)`](../lib/ai/context-builder.ts#L735) — schema docs + business-context docs.
- `intelligenceCtx ? '${intelligenceCtx}\n\n' : ''` — but the caller passes only `{ ctx }`, NOT `{ ctx, intelligenceCtx }`. The optional arg is never set.

**Interpolated:** schema (with samples / distributions), schema docs, business-context docs, schema-overview block.
**Fetched but dropped:** `intelligence_context` (populated on `ctx` but never threaded — see [path-d-system-prompt.ts:560-569](../lib/ai/path-d-system-prompt.ts#L560-L569)).
**Never read:** `projects.business_context` column, `source_field_acknowledgments`, `ai_edit_history`, `tables.friendly_name`.

### 4.2 Path B — bulk legacy

**Entry:** [`runMappingGeneration`](../lib/ai/mapping-engine.ts) bulk loop — `mapping-engine.ts:1542-1622`.

**Context build:** [mapping-engine.ts:1542-1557](../lib/ai/mapping-engine.ts#L1542-L1557) calls `buildAIContext` with full scope (`includeProfilingStats: true, includeValueDistributions: true, includeSampleValues: true, includeDocuments: true`). When `phase3Enabled` is true, also calls [`readBusinessContext(supabase, projectId)`](../lib/ai/mapping-engine.ts#L355) at [mapping-engine.ts:1561-1563](../lib/ai/mapping-engine.ts#L1561-L1563).

**User-message assembly:** [`buildMappingUserMessage`](../lib/ai/mapping-engine.ts) per batch at [mapping-engine.ts:1615-1621](../lib/ai/mapping-engine.ts#L1615-L1621). Threads `intelligenceCtx: aiCtx.intelligence_context ?? null`.

**Interpolated:** schema, docs, intelligence_context. Plus business_context **only** when `AI_PHASE_3_ENABLED === '1'` AND the agent-loop wrapping branch is taken (§4.3 below).
**Conditional path:** `phase3Enabled` selects the agent-loop wrapper at [mapping-engine.ts:1629](../lib/ai/mapping-engine.ts#L1629).
**Never read:** `projects.business_context` (under flag-OFF), user decisions, `tables.friendly_name`.

### 4.3 Path B — agent-loop

**Entry:** [`runSingleAgentMappingLoop`](../lib/ai/single-agent-mapping.ts). The bulk path enters this when `phase3Enabled` is true.

**Context build:** delegated. The caller (Path B bulk) supplies `baseUserMessage` (already includes schema + docs + intelligence), `schemaOverviewBlock`, and `businessContext` separately.

**User-message assembly:** [`buildAgentUserMessage`](../lib/ai/mapping-engine.ts#L375-L389). Prepends `<customer_business_context>` block when `businessContext` is non-null at [mapping-engine.ts:381-385](../lib/ai/mapping-engine.ts#L381-L385), then schema_overview, then base.

**Interpolated:** schema (via base), schema docs (via base), business-context docs (via base), intelligence (via base), `projects.business_context` (via top-level prepend), schema_overview.
**This is the only agent that consumes `projects.business_context`** — all paths flow through `buildAgentUserMessage`'s prepend. And it's still gated on `AI_PHASE_3_ENABLED`.

### 4.4 Path B — suggest single-target

**Entry:** [`suggestMappingForTarget`](../lib/ai/mapping-engine.ts) — `mapping-engine.ts:2032-2185`.

**Context build:** [mapping-engine.ts:2038-2054](../lib/ai/mapping-engine.ts#L2038-L2054) calls `buildAIContext(projectId, { ... }, userId, supabase)` with full scope. `userId` is passed.

**User-message assembly:** inline `userMsg` at [mapping-engine.ts:2168-2185](../lib/ai/mapping-engine.ts#L2168-L2185). Threads:
- target field block (composed from `context.target_tables` filtered by `target_field_id`)
- per-source-table source-fields block ([2143-2164](../lib/ai/mapping-engine.ts#L2143-L2164))
- `formatDocumentsForPrompt(context.documents)` at [2166](../lib/ai/mapping-engine.ts#L2166)
- `${context.intelligence_context ? context.intelligence_context + '\n\n' : ''}` at [2176](../lib/ai/mapping-engine.ts#L2176)

**Interpolated:** schema, docs, intelligence.
**Never read:** `projects.business_context`, user decisions, `tables.friendly_name`.

### 4.5 Path B — single-pair

**Entry:** [`runMappingGenerationForPair`](../lib/ai/mapping-engine.ts).

**Context build:** same `buildAIContext` shape as bulk.

**User-message assembly:** shares `buildMappingUserMessage` with bulk (§4.2). Same interpolation. Differences are operational (per-batch metadata, cache-control posture, error-handling shape) per [single-agent-mapping.ts:17-27](../lib/ai/single-agent-mapping.ts#L17-L27).

### 4.6 Validation NL → rule

**Entry:** [`addValidationRuleFromNL`](../lib/actions/validation-rules.ts) — `validation-rules.ts:265-501`.

**Context build:** [validation-rules.ts:340-355](../lib/actions/validation-rules.ts#L340-L355) calls `buildAIContext(projectId, { tableIds: [tableId], includeProfilingStats: false, includeValueDistributions: false, includeSampleValues: false, includeDocuments: true }, user.id, ...)`.

**Note the explicit `includeProfilingStats: false`** at [344-346](../lib/actions/validation-rules.ts#L344-L346) — profile data is intentionally suppressed in this context build. However, the prompt at [382-384](../lib/actions/validation-rules.ts#L382-L384) reads `field.field_profiles[0].sample_values` from a **separate** direct fetch at [310-314](../lib/actions/validation-rules.ts#L310-L314). Two paths to the same data, only one of them wired through `buildAIContext`. See §7.1.

**User-message assembly:** inline at [validation-rules.ts:382-384](../lib/actions/validation-rules.ts#L382-L384). Threads `field.name`, `field.data_type`, sample values, `${docBlock}`, and `User's rule: "..."`.

**Interpolated:** schema docs + business-context docs (via `formatDocumentsForPrompt(aiContext.documents)` at [352](../lib/actions/validation-rules.ts#L352)), per-field samples (via direct fetch).
**Fetched but dropped:** `intelligence_context` — `userId` is passed to `buildAIContext` so it's populated, but the prompt body never references it.
**Never read:** `projects.business_context`, user decisions, `tables.friendly_name`.

### 4.7 Transform — generate

**Entry:** [`generateTransformWithAI`](../lib/actions/transformations.ts) — `transformations.ts:1210-1341`.

**Context build:** [transformations.ts:1210-1224](../lib/actions/transformations.ts#L1210-L1224) calls `buildAIContext` with profile + distribution + samples + docs.

**User-message assembly:** inline. Interpolates `formatDocumentsForPrompt(txCtx.documents)` at [1225](../lib/actions/transformations.ts#L1225) and `${txCtx.intelligence_context ? ... : ''}` at [1329](../lib/actions/transformations.ts#L1329).

**Interpolated:** schema (per-field), docs, intelligence.
**Never read:** `projects.business_context`, user decisions, `tables.friendly_name`.

### 4.8 Transform — describe

**Entry:** [`describeFieldMapping`](../lib/actions/transformations.ts) — `transformations.ts:2760-2812`.

**Context build:** [transformations.ts:2760-2777](../lib/actions/transformations.ts#L2760-L2777) calls `buildAIContext`. `formatDocumentsForPrompt(aiCtx.documents)` at [2778](../lib/actions/transformations.ts#L2778).

**User-message assembly:** inline. `${aiCtx.intelligence_context ? aiCtx.intelligence_context + '\n\n' : ''}` at [2807](../lib/actions/transformations.ts#L2807).

**Interpolated:** schema, docs, intelligence.
**Never read:** same as §4.7.

### 4.9 AI quality detection

**Entry:** [`runAIAugmentedChecks`](../lib/actions/ai-quality-detection.ts) — `ai-quality-detection.ts:217-351`.

**Context build:** [ai-quality-detection.ts:217-232](../lib/actions/ai-quality-detection.ts#L217-L232). `buildAIContext` with full profile + distribution + samples + docs scope.

**User-message assembly:** inline. `formatDocumentsForPrompt(aiContext.documents)` at [328](../lib/actions/ai-quality-detection.ts#L328). Intelligence at [332](../lib/actions/ai-quality-detection.ts#L332): `${aiContext.intelligence_context ? '\n' + aiContext.intelligence_context + '\n' : ''}`.

**Interpolated:** schema, docs, intelligence.
**Tool-schema notable:** the agent emits `verification_sql` queries that reference `data_rows` directly ([tool-schemas.ts:864](../lib/ai/tool-schemas.ts#L864)). The agent is *told about* `data_rows` via SQL templates but does not see actual rows — only the upload-time samples in `field_profiles`.
**Never read:** `projects.business_context`, user decisions, `tables.friendly_name`.

### 4.10 Fix suggestions

**Entry:** [`generateFixSuggestions`](../lib/quality/fix-engine.ts) — `fix-engine.ts:280-498`.

**Context build:** [fix-engine.ts:309-322](../lib/quality/fix-engine.ts#L309-L322) calls `buildAIContext(projectId, scope, undefined, ...)`. **`userId` is `undefined`** — intelligence context is never even fetched.

**User-message assembly:** inline. Interpolates `fieldContext` (from `formatFieldForPrompt`), `tableName`, `fixDocBlock` at [338](../lib/quality/fix-engine.ts#L338). No reference to `intelligence_context` anywhere in the prompt body.

**Interpolated:** schema (single field), docs.
**Fetched but dropped — N/A:** intelligence is never fetched (see §7.2 for the ambiguity).
**Never read:** `projects.business_context`, user decisions, `tables.friendly_name`.

### 4.11 DDL conversion

**Entry:** [`convertDocToDDL`](../lib/ai/ddl-conversion.ts) — `ddl-conversion.ts:53-78`.

**Context build:** none. The function takes raw `documentText` and hands it to Claude as the user message.

**User-message assembly:** raw text, truncated to `MAX_INPUT_CHARS = 15_000`.

**Interpolated:** the document itself.
**Not in scope by design:** schema, docs, intelligence, business_context, samples, profiles, user decisions. This agent is intentionally narrow — it converts a single document and returns DDL. See §8.1 for why this is correctly out of the broader project context.

---

## 5. Gap inventory

The master matrix. One row per (input, agent) pair. ✓ confirmed reaches prompt · ⚠ gap · ❓ ambiguous · — N/A by design.

| # | Input | Agent | Status | Citation | Severity | Next-step pointer |
|---|---|---|---|---|---|---|
| 1 | Source row data (samples) | Path D | ✓ via `field_profiles.sample_values` | [path-d-system-prompt.ts:567](../lib/ai/path-d-system-prompt.ts#L567) | — | n/a |
| 1 | Source row data | Path B bulk | ✓ same path | [mapping-engine.ts:1567](../lib/ai/mapping-engine.ts#L1567) | — | n/a |
| 1 | Source row data | Path B agent-loop | ✓ via base | [single-agent-mapping.ts:67-72](../lib/ai/single-agent-mapping.ts#L67-L72) | — | n/a |
| 1 | Source row data | Path B suggest | ✓ | [mapping-engine.ts:2143-2164](../lib/ai/mapping-engine.ts#L2143-L2164) | — | n/a |
| 1 | Source row data | Path B single-pair | ✓ | shared with bulk | — | n/a |
| 1 | Source row data | Validation NL | — by design | profile flags off at [validation-rules.ts:344-346](../lib/actions/validation-rules.ts#L344-L346); samples via side-channel at [382-384](../lib/actions/validation-rules.ts#L382-L384) | — | n/a |
| 1 | Source row data | Tx generate | ✓ | [transformations.ts:1225](../lib/actions/transformations.ts#L1225) | — | n/a |
| 1 | Source row data | Tx describe | ✓ | [transformations.ts:2778](../lib/actions/transformations.ts#L2778) | — | n/a |
| 1 | Source row data | AI quality | ✓ | [ai-quality-detection.ts:328](../lib/actions/ai-quality-detection.ts#L328) | — | n/a |
| 1 | Source row data | Fix suggestions | ✓ | [fix-engine.ts:338](../lib/quality/fix-engine.ts#L338) | — | n/a |
| 1 | Source row data | DDL conversion | — by design | [ddl-conversion.ts:53-78](../lib/ai/ddl-conversion.ts) | — | n/a |
| 2 | Target row data | all agents | ✓ same shape as #1 | same citations | — | n/a |
| 3 | Schema docs | Path D | ✓ | [path-d-system-prompt.ts:567](../lib/ai/path-d-system-prompt.ts#L567) | — | n/a |
| 3 | Schema docs | Path B bulk | ✓ | [mapping-engine.ts:1567](../lib/ai/mapping-engine.ts#L1567) | — | n/a |
| 3 | Schema docs | Path B agent-loop | ✓ via base | [single-agent-mapping.ts](../lib/ai/single-agent-mapping.ts) | — | n/a |
| 3 | Schema docs | Path B suggest | ✓ | [mapping-engine.ts:2166](../lib/ai/mapping-engine.ts#L2166) | — | n/a |
| 3 | Schema docs | Path B single-pair | ✓ | shared with bulk | — | n/a |
| 3 | Schema docs | Validation NL | ✓ | [validation-rules.ts:352](../lib/actions/validation-rules.ts#L352) | — | n/a |
| 3 | Schema docs | Tx generate | ✓ | [transformations.ts:1225](../lib/actions/transformations.ts#L1225) | — | n/a |
| 3 | Schema docs | Tx describe | ✓ | [transformations.ts:2778](../lib/actions/transformations.ts#L2778) | — | n/a |
| 3 | Schema docs | AI quality | ✓ | [ai-quality-detection.ts:328](../lib/actions/ai-quality-detection.ts#L328) | — | n/a |
| 3 | Schema docs | Fix suggestions | ✓ | [fix-engine.ts:338](../lib/quality/fix-engine.ts#L338) | — | n/a |
| 4 | Business-context docs (uploaded files) | all 10 in-scope agents | ✓ same `formatDocumentsForPrompt` path | [context-builder.ts:735](../lib/ai/context-builder.ts#L735) | — | n/a |
| 5 | **`projects.business_context` column** | all 10 in-scope agents | **⚠ orphan** — no production write path; reader at [mapping-engine.ts:355-367](../lib/ai/mapping-engine.ts#L355-L367) always reads `null` in prod. Only writer is the eval fixture builder at [synthetic-context-builder.ts:243](../lib/eval/synthetic-context-builder.ts#L243). The "1/11 reaches it" cell pattern is technically accurate but functionally vacuous — the consumer code path is dead, not silently dropping live data. | **LOW** (architectural orphan / design debt) | Single ticket covering binary choice: (a) build the UI write path so users can populate the column (deferred product item), OR (b) remove the column + the `readBusinessContext` helper + the agent-loop prepend. The matrix-style per-agent reach analysis only becomes meaningful AFTER the write path exists; currently the per-agent rows would all read "no data to drop" and add no signal. |
| 5 | `projects.business_context` | DDL conversion | — by design | DDL conversion has no project context | — | n/a |
| 6 | Field profiles | Path D | ✓ | [context-builder.ts:251](../lib/ai/context-builder.ts#L251) → `formatPathDSchema` | — | n/a |
| 6 | Field profiles | Path B (all variants) | ✓ | same context builder path | — | n/a |
| 6 | Field profiles | Validation NL | ❓ side-channel | profile fetch is suppressed in `buildAIContext` ([344-346](../lib/actions/validation-rules.ts#L344-L346)) but available via the direct `field_profiles` join at [310-314](../lib/actions/validation-rules.ts#L310-L314) | — | See §7.1. |
| 6 | Field profiles | Tx generate | ✓ | [transformations.ts:1225](../lib/actions/transformations.ts#L1225) | — | n/a |
| 6 | Field profiles | Tx describe | ✓ | [transformations.ts:2778](../lib/actions/transformations.ts#L2778) | — | n/a |
| 6 | Field profiles | AI quality | ✓ | [ai-quality-detection.ts:328](../lib/actions/ai-quality-detection.ts#L328) | — | n/a |
| 6 | Field profiles | Fix suggestions | ✓ | [fix-engine.ts:309-322](../lib/quality/fix-engine.ts#L309-L322) | — | n/a |
| 7a | `tables.friendly_name` | all agents | ⚠ NOT READ | not in `buildAIContext` field set ([context-builder.ts:207](../lib/ai/context-builder.ts#L207) selects `id, name, dataset_id, row_count`); not read by any other agent path | MEDIUM | See §8.1. New ticket: include `friendly_name` in `formatSchemaForPrompt` to ground naming-convention detection. |
| 7b | `tables.data_modified_at` | all agents | — by design | staleness signal only; correctly absent from prompts | — | n/a |
| 8a | `source_field_acknowledgments` | all agents | **⚠ NOT READ** | only consumer is UI assembly at [mapping-engine.ts:1249](../lib/ai/mapping-engine.ts#L1249) | **HIGH** | New ticket: surface acknowledgments to mapping + transform + AI quality. The user explicitly told the AI a field is intentionally unmapped — re-running mapping should not re-propose it. |
| 8b | `ai_edit_history` | all agents | **⚠ NEVER READ** | inserts at [path-d-mapping.ts:698](../lib/ai/path-d-mapping.ts#L698), [ai-edit-history.ts:57](../lib/actions/ai-edit-history.ts#L57); zero SELECT call sites | **HIGH** | New ticket: surface human_modified / human_rejected events from prior runs to the next agent run. Feedback loop is the core product positioning; not yet wired. |
| 9 | Migration intelligence | Path D | ⚠ FETCHED BUT DROPPED | populated on `ctx.intelligence_context` via `userId` arg; never threaded into `buildPathDUserMessage` ([path-d-mapping.ts:251](../lib/ai/path-d-mapping.ts#L251)) | MEDIUM | New ticket: pass `intelligenceCtx: ctx.intelligence_context` to `buildPathDUserMessage`. The slot already exists at [path-d-system-prompt.ts:560-569](../lib/ai/path-d-system-prompt.ts#L560-L569). |
| 9 | Migration intelligence | Path B bulk | ✓ | [mapping-engine.ts:1619](../lib/ai/mapping-engine.ts#L1619) | — | n/a |
| 9 | Migration intelligence | Path B agent-loop | ✓ via base | wraps Path B bulk's base message | — | n/a |
| 9 | Migration intelligence | Path B suggest | ✓ | [mapping-engine.ts:2176](../lib/ai/mapping-engine.ts#L2176) | — | n/a |
| 9 | Migration intelligence | Path B single-pair | ✓ | shared with bulk | — | n/a |
| 9 | Migration intelligence | Validation NL | ⚠ FETCHED BUT DROPPED | `userId` passed to `buildAIContext` ([349](../lib/actions/validation-rules.ts#L349)); `aiContext.intelligence_context` never appears in prompt body | MEDIUM | New ticket: interpolate intelligence into the NL rule prompt. |
| 9 | Migration intelligence | Tx generate | ✓ | [transformations.ts:1329](../lib/actions/transformations.ts#L1329) | — | n/a |
| 9 | Migration intelligence | Tx describe | ✓ | [transformations.ts:2807](../lib/actions/transformations.ts#L2807) | — | n/a |
| 9 | Migration intelligence | AI quality | ✓ | [ai-quality-detection.ts:332](../lib/actions/ai-quality-detection.ts#L332) | — | n/a |
| 9 | Migration intelligence | Fix suggestions | ⚠ NEVER FETCHED | `userId: undefined` at [fix-engine.ts:320](../lib/quality/fix-engine.ts#L320) | MEDIUM | See §7.2 — confirm intent before classifying as gap. |
| 9 | Migration intelligence | DDL conversion | — by design | no project context | — | n/a |

---

## 6. Asymmetric coverage findings

Three load-bearing findings — two propagation asymmetries and one architectural orphan. Each gets a flow diagram. The asymmetry diagrams (§6.2, §6.3) trace storage → reader → consumed-by with arrows showing where live data is dropped or filtered en route to the prompt. The orphan diagram (§6.1) is structurally inverted: the absence-of-write sits at the top and the (always-null in production) read path runs below it.

### 6.1 `projects.business_context` is an architectural orphan (LOW)

```
projects.business_context
   ([migration 086:9])
        ▲
        │ writes
        │
   ┌────┴─────────────────────────────────────────────────────────┐
   │                                                              │
   ✗ NO production UI surface                       ✓ eval fixtures only
   ✗ NO production server action                       [synthetic-context-builder.ts:243]
   ✗ NO API endpoint                                   (writes when fixture metadata
                                                        carries businessContext)
   In production the column is always NULL.

──────────────────────────────────────────────────────────────────────────────

projects.business_context  ──reads──▶  readBusinessContext(supabase, projectId)
                                          ([mapping-engine.ts:355-367])
                                          • returns null when empty
                                          • in production: ALWAYS null
                                                  │
                                                  ▼
                                          phase3Enabled gate
                                          ([mapping-engine.ts:1561])
                                                  │
                                                  ▼
                                          buildAgentUserMessage prepend
                                          ([mapping-engine.ts:381-385])
                                                  │
                                                  ▼
                                          Path B agent-loop  ──▶  null short-circuits;
                                                                  no <customer_business_context>
                                                                  block ever rendered in prod
```

**Why this is LOW severity (architectural orphan / design debt, not a propagation gap).**

The column added in migration 086 and the reader function at [mapping-engine.ts:355-367](../lib/ai/mapping-engine.ts#L355-L367) were built for a feature whose write path was never implemented. No production code populates the column — only the eval test fixture builder at [synthetic-context-builder.ts:243](../lib/eval/synthetic-context-builder.ts#L243). In production, every call to `readBusinessContext` returns `null`, the agent-loop's prepend always short-circuits on the null guard, and the `<customer_business_context>` block never appears in any rendered prompt.

The "1 of 11 agents reads this column" framing from earlier drafts of this audit was technically accurate but functionally vacuous: the consumer code path exists, but it consumes data that is never populated. This is **dead code**, not silently dropping live customer data. Re-classifying as LOW: design debt from a deferred product feature, not an active leak.

**Fix shape is binary, not per-agent:**
- Option A — build the UI write path (the deferred product item): a settings-page text area on the project that writes to `projects.business_context`. After this exists, the per-agent matrix rows become meaningful and the question of "which agents should consume this column" becomes a separate (and at that point genuine) propagation audit.
- Option B — remove the column, the reader, the agent-loop prepend, and the eval fixture writer. Dead code retirement. No customer impact.

Until either option lands, the per-agent reach analysis is premature: there is no live data to evaluate which agent's prompt should or shouldn't include.

**This finding is structurally different from the BPR-via-RLS gap.** BPR-via-RLS was a propagation gap — data existed and was fetched, but RLS cascades silently truncated the result. This is an absence-of-write gap — there is no data, by design (the design was incomplete). Different gap class; different fix shape; different severity.

### 6.2 Migration intelligence reaches 6 of 11 agents (MEDIUM)

```
migration_intelligence (table)
        │
        ▼
buildIntelligenceContext(userId, { sourceSystemName, targetSystemName })
   ([context-builder.ts:436-551])
   • fetches user's confirmed patterns
   • formats with stars, category headers, MAX_CHARS = 8000
   • REQUIRES userId arg from caller
        │
        ▼
ProjectAIContext.intelligence_context
   ([context-builder.ts:79-80])
        │
        ├──────────────────────────────────┐
        │                                  │
        ▼                                  ▼
  caller threads it                  caller fetches but doesn't thread

  ✓ Path B bulk      [1619]          ⚠ Path D            [path-d-mapping.ts:251]
  ✓ Path B agent     (via base)         (passes only { ctx } to
  ✓ Path B suggest   [2176]               buildPathDUserMessage; the
  ✓ Tx generate      [1329]                intelligenceCtx arg slot exists
  ✓ Tx describe      [2807]                at path-d-system-prompt.ts:560)
  ✓ AI quality       [332]
                                     ⚠ Validation NL    [validation-rules.ts:357-394]
                                        (userId IS passed; aiContext.intelligence_context
                                         is populated but not interpolated)

                                     ⚠ Fix engine       [fix-engine.ts:320]
                                        (userId is undefined at the buildAIContext call,
                                         so intelligence is never even fetched —
                                         see §7.2 for ambiguity classification)
```

**Why this is MEDIUM severity.** Migration intelligence is a new feature designed to span all agents. Three agents fetch it but don't use it; one agent never even fetches it. There is no static-analysis signal that flags this — `aiContext.intelligence_context` is a string field that happens to be empty when unused, indistinguishable from "no patterns matched."

### 6.3 User decisions reach 0 of 11 agents (HIGH)

```
source_field_acknowledgments (table)
        │
        ▼
read by getMappingsForRedesignCore
   ([mapping-engine.ts:1249])
        │
        ▼
MappingsForRedesignResult (UI shape)
        │
        ▼
Mapping page React tree (UI only)
        │
        ✗ NEVER reaches any agent prompt


ai_edit_history (table)
        │
        ▼
inserted by:
   • emitPathDProvenance      [path-d-mapping.ts:698]
   • logAIEdit                [ai-edit-history.ts:57]
        │
        ▼
written rows
        │
        ✗ NEVER SELECTed for prompt context
        ✗ NEVER read by any agent
        ✗ feedback loop is not yet wired
```

**Why this is HIGH severity.** "AI proposes → deterministic validates → human approves" is the codebase's stated product principle ([CLAUDE.md §1](../CLAUDE.md)). When the human approves an acknowledgment ("this source field is intentionally unmapped, do not propose mappings for it") or rejects an AI edit ("this transform was wrong"), that decision is durable in the database — but invisible to the next agent run. A user who acknowledges 30 source fields and then re-runs Path D will get 30 fresh proposals for the same fields. The AI cannot improve from feedback because the feedback is not in the loop. Severity matches the product weight: HIGH.

---

## 7. Ambiguous cases (need runtime trace)

Three cases where static analysis cannot determine reachability or intent. Flagged for owner confirmation.

### 7.1 Validation NL — field profiles via side-channel

[validation-rules.ts:344-346](../lib/actions/validation-rules.ts#L344-L346) explicitly disables profile fetching in `buildAIContext`:

```ts
includeProfilingStats: false,
includeValueDistributions: false,
includeSampleValues: false,
```

But the prompt at [382-384](../lib/actions/validation-rules.ts#L382-L384) reads `field.field_profiles[0].sample_values`. This works because the function does a SEPARATE direct fetch with a join at [310-314](../lib/actions/validation-rules.ts#L310-L314):

```ts
.from('fields')
.select('*, tables!inner(...), field_profiles(*)')
.eq('id', fieldId)
```

So profile data DOES reach the prompt — just via a side-channel path that runs in parallel to the disabled `buildAIContext` profile flags. This is two paths to the same data, only one of them wired through the canonical context builder.

**Why ambiguous:** the call-shape works correctly today, but the dual-path arrangement is fragile. A future change that unifies on `buildAIContext` would silently drop the samples unless the flags flip back to true. This is documentation gap, not a coverage gap. Owner confirmation needed on intent (was the dual-path arrangement deliberate, or accidental?).

### 7.2 Fix engine — `userId` is `undefined`

[fix-engine.ts:320](../lib/quality/fix-engine.ts#L320) passes `undefined` as the third arg to `buildAIContext`:

```ts
const fixCtx = await buildAIContext(
  issue.project_id as string,
  { /* full scope */ },
  undefined,     // ← userId
  evalContext ? supabase : undefined,
)
```

Static analysis: `intelligence_context` is therefore never fetched (the `userId` param gates `buildIntelligenceContext` at [context-builder.ts:407-416](../lib/ai/context-builder.ts#L407-L416)). The Fix Suggestions prompt body also never references `fixCtx.intelligence_context`.

**Why ambiguous:** is this intentional (e.g., per-fix prompts deliberately exclude org-wide intelligence patterns to keep the suggestion grounded in the specific issue) or an oversight (the agent was added before intelligence existed and never updated)? The git blame at [fix-engine.ts:309-322](../lib/quality/fix-engine.ts#L309-L322) would help disambiguate but is out of scope for static analysis. Owner confirmation needed.

### 7.3 `tables.row_count` provenance

`tables.row_count` is included in `formatSchemaOverviewBlock` ([context-builder.ts:674](../lib/ai/context-builder.ts#L674)) and emitted into every Path D and Path B prompt. The provenance is unclear from static analysis: does this column reflect the latest CSV upload row count, or the staged-to-target row count? Three callers update it (CSV ingestion, staging, manual fixes), and the value the agent sees depends on which one ran last.

**Why ambiguous:** state-question, not coverage-question. If the value reflects post-staging numbers, the agent's "X rows in source table" mental model may diverge from the user's "X rows uploaded to source table" expectation. Out of audit scope but flagged here as a related concern.

---

## 8. Surprises beyond the audit scope

Six findings the input-type list did not anticipate. Two are promoted to load-bearing callouts; the other four are documentation-only.

### 8.1 DDL conversion bypasses `buildAIContext` entirely

[ddl-conversion.ts:53-78](../lib/ai/ddl-conversion.ts#L53-L78) takes `documentText` and hands it to Claude raw. No project context. No schema. No samples.

This is correct by design — DDL conversion is a pure text transform (`schema documentation → CREATE TABLE statements`), not a project-aware operation. Documenting it here so a code reader doesn't mistake the absence for a gap.

### 8.2 — CALLOUT — `tables.friendly_name` invisibility (MEDIUM)

`tables.friendly_name` is set during CSV upload via [ddl-upload.ts:172](../lib/actions/ddl-upload.ts#L172). It carries the user-friendly table label (e.g., `Customer Orders` vs raw `cust_ord`). Read only by [data-overview.ts:172,181,195](../lib/actions/data-overview.ts#L172) for UI display.

The schema-overview block in `buildAIContext` ([context-builder.ts:669-693](../lib/ai/context-builder.ts#L669-L693)) computes `naming: snake_case | camelCase | UPPER_SNAKE_CASE` from raw `field.name`. If the user's friendly names follow a different convention than the raw column names (a common pattern when DDL is auto-extracted from a legacy system), the convention hint surfaced to the AI is based on the raw names — not the names the user actually thinks in.

**Why this matters.** Naming-convention awareness is one of the cheapest ways to lift mapping accuracy: a target system with `customerEmail` mapped from a source with `cust_email` benefits from the agent knowing both conventions explicitly. The `friendly_name` data exists; it is simply not propagated to any agent.

### 8.3 `tables.data_modified_at` is correctly absent from prompts

Used by [staging.ts:516-521](../lib/actions/staging.ts#L516-L521) for staleness detection between source data and staged-to-target data. Written by [quality-fixes.ts:280](../lib/actions/quality-fixes.ts#L280) and [manual-fix.ts:458](../lib/actions/manual-fix.ts#L458). Correctly NOT in any agent prompt — staleness is a system-control signal, not customer context.

### 8.4 — CALLOUT — Sample data is a static upload-time snapshot (MEDIUM-HIGH)

`field_profiles.sample_values` and `field_profiles.value_distribution` are computed at CSV ingestion. The agent sees those snapshots in every prompt. Fix paths DO call `recomputeFieldProfile` post-fix to refresh — see [quality-fixes.ts](../lib/actions/quality-fixes.ts) `recomputeFieldProfile` integration.

**Why this matters now.** A live read of `data_rows` is never performed inside an agent prompt assembly. Agents see only the static snapshot.

**Why this matters more soon.** The codebase has data-scanning tools defined in [tool-schemas.ts](../lib/ai/tool-schemas.ts) — RPCs the agent can call to fetch live samples on demand. These were registered in the agent loop pre-May-2026, then stripped (see [single-agent-mapping.ts:40-57](../lib/ai/single-agent-mapping.ts#L40-L57)) when the agent loop became degenerate under streaming. When Path E (or whatever the next-iteration agent loop is called) re-introduces tool-use, the static-snapshot vs live-read boundary becomes a live design question: which agents get tool-use access to data_rows? Which agents continue to receive snapshots only?

This callout is forward-looking. It is not a current gap. Documenting now so the design conversation doesn't have to re-discover the boundary.

### 8.5 Path D's data-scanning tools are unwired

[single-agent-mapping.ts:40-57](../lib/ai/single-agent-mapping.ts#L40-L57) documents the May-2026 incident that stripped 3 data-scanning tool registrations from the agent loop. Path D and the streaming Path B path now run as single-shot tool-forced calls. `runAgentLoop`, the data-scanning tool handler factories, and the `schema_error` fallback are no longer reachable from this file.

Adjacent to the audit. Worth noting because the path-d-mapping.ts comment at [195-198](../lib/ai/path-d-mapping.ts#L195-L198) implies the agent runs in a loop, which is no longer accurate post-incident.

### 8.6 `schema_source` provenance is fetched but flag-gated off

[context-builder.ts:620-623](../lib/ai/context-builder.ts#L620-L623) checks `provenanceLabelsEnabled()` before emitting `manual` / `ddl_parsed` / `doc_enriched` / `cross_table_inferred` flags. The data flows through `FieldContext.schema_source` ([context-builder.ts:37](../lib/ai/context-builder.ts#L37)) but only renders when the flag is on. Default-off means agents never see whether a field came from manual user override vs DDL parse vs doc-extracted inference.

Worth flagging because `schema_source = 'manual'` is exactly the kind of "the user told us X" signal that should be high-priority feedback for the agent — but it is gated behind a feature flag rather than universally exposed.

---

## 9. Future audit cadence

The audit IS the deliverable. To stay valid, it needs maintenance.

**When to re-run:**
- A new agent is introduced (any new `callLLM` call site in `lib/`).
- The shape of `ProjectAIContext` changes (new field added or removed).
- A new context source is introduced (new column on `projects` / `tables` / `fields`, or new RPC that returns context).
- A flag that gates context flow is changed (currently: `AI_PHASE_3_ENABLED`, `provenanceLabelsEnabled()`, or new ones).
- Quarterly, regardless. Things drift.

**What automation could replace this manual audit:**
- A static-analysis pass that walks every `callLLM` call site and verifies its `userMessage` argument transitively reaches `formatDocumentsForPrompt` and `formatSchemaForPrompt`. False positives expected; works as a pre-merge guardrail rather than a fully automated audit.
- A test suite that snapshots the rendered prompt for a fixture project per agent. Agent-by-agent prompt fingerprints would catch silent-drop regressions like the Path D `intelligenceCtx` arg.
- Linting at the `buildAIContext` callsite to flag `userId: undefined` arguments — currently a silent intelligence-disabling pattern.

**What this audit cannot replace:**
- A deliberate decision on `projects.business_context` reach. Each agent's "should this column reach this prompt" answer is a product decision, not a code decision.
- A deliberate decision on user-decision feedback. The shape of the prompt addition (acknowledgments as exclusion list? as advisory context? as hard constraints?) is a product decision.

---

## 10. Appendix — agent prompt-shape reference

Terse compendium for downstream PR authors. Each entry is the minimum information needed to know which agent reads what. For the full read-path, see §4.

| Agent | Entry | Schema | Schema docs | Biz-ctx docs | `projects.business_context` | Profiles | Intelligence | User decisions |
|---|---|---|---|---|---|---|---|---|
| Path D | [path-d-mapping.ts:240](../lib/ai/path-d-mapping.ts#L240) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ⚠ dropped | ⚠ |
| Path B bulk | [mapping-engine.ts:1542](../lib/ai/mapping-engine.ts#L1542) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| Path B agent-loop | [single-agent-mapping.ts](../lib/ai/single-agent-mapping.ts) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| Path B suggest | [mapping-engine.ts:2032](../lib/ai/mapping-engine.ts#L2032) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| Path B single-pair | [mapping-engine.ts](../lib/ai/mapping-engine.ts) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| Validation NL | [validation-rules.ts:340](../lib/actions/validation-rules.ts#L340) | ❓ side | ✓ | ✓ | ⚠ orphan | ❓ side | ⚠ dropped | ⚠ |
| Tx generate | [transformations.ts:1210](../lib/actions/transformations.ts#L1210) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| Tx describe | [transformations.ts:2760](../lib/actions/transformations.ts#L2760) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| AI quality | [ai-quality-detection.ts:217](../lib/actions/ai-quality-detection.ts#L217) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ✓ | ⚠ |
| Fix suggestions | [fix-engine.ts:309](../lib/quality/fix-engine.ts#L309) | ✓ | ✓ | ✓ | ⚠ orphan | ✓ | ⚠ never fetched | ⚠ |
| DDL conversion | [ddl-conversion.ts:53](../lib/ai/ddl-conversion.ts#L53) | — | — | — | — | — | — | — |

Legend: ✓ reaches prompt · ⚠ propagation gap · ⚠ orphan = code path exists but receives no production data (see §6.1) · ❓ via side-channel · — N/A by design.

---

## Audit metadata

**Audit performed:** 2026-05-08, against branch `chore/context-flow-audit` cut from `ea1e3ab` (PR #106 — Path D eval).
**Method:** static trace, file:line citations throughout. No runtime verification; flag-gated paths flagged as ambiguous.
**Coverage:** 8 input types × 11 agents = 88 cells in the gap matrix, plus 1 bonus type (migration intelligence) = 99 cells.
**Outcomes:** 2 propagation asymmetries (user decisions HIGH, migration intelligence MEDIUM) + 1 architectural orphan (`projects.business_context` LOW — column and reader exist; no production write path). 2 promoted callouts (MEDIUM and MEDIUM-HIGH). 3 ambiguous cases for owner confirmation. 4 documentation-only surprises.
**Next-step pointers** in §5 are intended as ticket-writing seeds, not prescriptions.
