# INV-1 — Input prioritization across AI agents

**Status:** Read-only investigation (no code changes, no LLM spend).
**Author:** Claude Code session, 2026-05-05.
**Branch when authored:** `feat/ai-observability-provenance` (clean `git status`; PR 3.4e branch sits separately at `feat/pr3.4e-voting-variance-fix` un-pushed).

This document maps the *current* implementation of context flow across every AI agent in the codebase, so the principal's 4-priority framework can be discussed against ground truth. It is read-only — no production code is modified, no fixtures authored, no LLM credits spent.

The principal's stated framework (when sources conflict, this is the order of authority):

| Priority | Source | Rationale |
|---|---|---|
| **P1** | User edits to Schema Overview tab | Highest — explicit user intent |
| **P2** | Schema documents (DDL, ERD, data dictionaries) | Authoritative; uploaded by user |
| **P3** | Business documents (free-text rules, value mappings) | Reference context |
| **P4** | Raw data (`data_rows` + `field_profiles`) | Lowest — AI-derived from samples |

Headline finding up front: the codebase already has a **WRITE-PATH** priority cascade ([`SCHEMA_SOURCE_PRIORITY`](../../lib/utils/schema-priority.ts#L31-L37)) that protects user edits from being overwritten by lower-authority writers. But the corresponding **PROMPT-PATH** priority is encoded in only **two places** ([`context-builder.ts:670-673`](../../lib/ai/context-builder.ts#L670-L673) and [`mapping-engine.ts:324`](../../lib/ai/mapping-engine.ts#L324)), and neither one carries the user-edit (P1) signal forward. The agents see the *current* `fields` row but have no idea whether it was user-authored or AI-inferred.

---

## §A — Inventory of context sources

### A.1 Storage map

| Source | Table.column | Populated by | Retrieved by |
|---|---|---|---|
| **Field metadata (current state)** | `fields.{name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, default_value, description, check_constraint, schema_source}` | DDL parser ([`schema-merge.ts:785`](../../lib/actions/schema-merge.ts#L785) AI parser); CSV inference ([`csv.ts:40`](../../lib/actions/csv.ts#L40)); AI enrichment ([`schema-enrichment.ts:319-321`](../../lib/actions/schema-enrichment.ts#L319-L321)); user UI edits ([`fields.ts:97-99`](../../lib/actions/fields.ts#L97-L99)) | [`buildAIContext` step 4](../../lib/ai/context-builder.ts#L168-L181) |
| **Provenance label** | `fields.schema_source` ∈ {`inferred`, `cross_table_inferred`, `doc_enriched`, `ddl_parsed`, `manual`} | Same writers as above; cascade enforced by [`canOverride()`](../../lib/utils/schema-priority.ts#L54-L62) | Carried on [`FieldContext.schema_source`](../../lib/ai/context-builder.ts#L25) but **never emitted in any prompt** (see comment at [`context-builder.ts:24-25`](../../lib/ai/context-builder.ts#L24-L25)) |
| **Field profiles** | `field_profiles.{null_percentage, cardinality, unique_percentage, format_issues_count, min_value, max_value, sample_values, value_distribution}` | CSV upload + `refreshFieldProfiling` after type changes ([`fields.ts:23-67`](../../lib/actions/fields.ts#L23-L67)) | [`buildAIContext` step 5](../../lib/ai/context-builder.ts#L184-L205) |
| **Raw rows** | `data_rows.row_data` (JSONB) | CSV upload, DB connector ([`db-connector.ts:957`](../../lib/actions/db-connector.ts#L957)) | NEVER passed to a prompt directly. Used only for `verification_sql` execution at validate time and for tools (`query_field_data`, `count_distinct_patterns`, `cross_field_correlation`) the agent loop can call to materialise samples on demand. |
| **Schema documents** | `schema_documents.extracted_text` where `doc_type='schema'` (dataset-scoped) | [`uploadSchemaDocument`](../../lib/actions/schema-documents.ts#L193-L216) — PDF/DOCX/DDL parsed via mammoth + pdf-parse | [`buildAIContext` step 6a](../../lib/ai/context-builder.ts#L213-L238) |
| **Business-context documents** | `schema_documents.extracted_text` where `doc_type='business_context'` (project-scoped, `dataset_id=NULL`) | [`uploadBusinessContextDoc`](../../lib/actions/schema-documents.ts#L391-L408) | [`buildAIContext` step 6b](../../lib/ai/context-builder.ts#L239-L255) |
| **Project free-text business context** | `projects.business_context` (TEXT, nullable) added in [migration 086](../../supabase/migrations/086_project_business_context.sql) | **No production setter** — only [`synthetic-context-builder.ts:256`](../../lib/eval/synthetic-context-builder.ts#L256) writes it for fixtures. See §A.4 surprise. | [`readBusinessContext`](../../lib/ai/mapping-engine.ts#L354-L366), surfaces only in agent-mode mapping pipelines |
| **Migration intelligence** | `migration_intelligence` (cross-project patterns) | Authored by `runMigrationIntelligenceExtraction` ([`migration-intelligence.ts:909-923`](../../lib/actions/migration-intelligence.ts#L909-L923)) at project-completion time | [`buildIntelligenceContext`](../../lib/ai/context-builder.ts#L363-L478), surfaced as `intelligence_context` string |
| **Prior mappings** | `target_field_mappings`, `mapping_sources`, `transformations` | Mapping pipeline + user approve/reject | Agent prompts: only `quality_issues` ([ai-quality-detection.ts:268-284](../../lib/actions/ai-quality-detection.ts#L268-L284)) and `migration_intelligence` ([migration-intelligence.ts:800-841](../../lib/actions/migration-intelligence.ts#L800-L841)) consume prior mappings; the other 6 agents do not |
| **Existing validation rules** | `validation_rules` | User-authored or AI-authored ([`validation-rules.ts:362-379`](../../lib/actions/validation-rules.ts#L362-L379)); also auto-created when `schema-enrichment` finds doc-vs-schema conflicts on protected fields ([`schema-enrichment.ts:441-487`](../../lib/actions/schema-enrichment.ts#L441-L487)) | Surfaced only inside `migration-intelligence` extraction; **not visible to mapping / transform / quality agents** |
| **AI edit history** | `ai_edit_history` ([migration 083](../../supabase/migrations/083_ai_edit_history.sql)) | `logAIEdit` ([`ai-edit-history.ts:55-77`](../../lib/actions/ai-edit-history.ts#L55-L77)) — `entity_type` ∈ {`target_field_mapping`, `mapping_source`, `transformation`, `validation_rule`, `quality_issue`} | **NEVER read into any prompt.** Provenance log only; consumed by future eval harness per the file header. |

### A.2 The five `schema_source` provenance labels

The cascade lives at [`lib/utils/schema-priority.ts:31-37`](../../lib/utils/schema-priority.ts#L31-L37). Lowest authority → highest:

```
inferred  →  cross_table_inferred  →  doc_enriched  →  ddl_parsed  →  manual
```

Mapped onto the principal's framework:

| `schema_source` | Principal's tier | Notes |
|---|---|---|
| `manual` | **P1** ✓ | Set when user saves an edit in Schema Overview ([`fields.ts:97-99`](../../lib/actions/fields.ts#L97-L99)). Always wins. |
| `ddl_parsed` | **P2** | Direct DDL parse (without AI interpretation). |
| `doc_enriched` | **P2 (AI-mediated)** | DDL/data-dict docs run through `enrichSchemaFromDocs` (an LLM agent — see §B). Lower than `ddl_parsed` because AI may misinterpret. |
| `cross_table_inferred` | **P4 (corroborated)** | Name match + value-overlap across sibling tables. |
| `inferred` | **P4** | CSV header + value sampling. |

The principal's **P3 (business documents)** has *no slot* in this cascade — business docs do not directly modify field rows. They land in `schema_documents` with `doc_type='business_context'` and feed prompts as a separate `<business_context>` block, OR they trigger an enrichment pass that *reads them* and may write `doc_enriched` corrections to `fields`.

### A.3 What `buildAIContext` actually returns

[`ProjectAIContext`](../../lib/ai/context-builder.ts#L61-L69) packs:

- `source_tables: TableContext[]` — fields, profiles, samples, distributions; **carries `schema_source` per field but the formatter doesn't emit it** ([`context-builder.ts:300`](../../lib/ai/context-builder.ts#L300))
- `target_tables: TableContext[]` — same shape; target-only emits `Default:` and `Description:` lines ([`context-builder.ts:546-552`](../../lib/ai/context-builder.ts#L546-L552))
- `documents: DocumentContext` — schema_documents partitioned by `doc_type` and dataset role
- `intelligence_context: string` — pre-formatted markdown block (or empty)

`projects.business_context` is **NOT** in `ProjectAIContext`. Agents that want it must call `readBusinessContext` directly (only mapping_generate + multi-agent pipeline do).

### A.4 Surprise — `projects.business_context` is dormant

Migration 086 added the column, [`readBusinessContext`](../../lib/ai/mapping-engine.ts#L354-L366) reads it, and the agent-mode mapping pipeline emits it as a `<customer_business_context>` block ([`mapping-engine.ts:380-384`](../../lib/ai/mapping-engine.ts#L380-L384)). **But there is no production server action that sets it.** The only writer is [`synthetic-context-builder.ts:241-260`](../../lib/eval/synthetic-context-builder.ts#L241-L260) for eval fixtures.

```bash
# repo-wide search for setters
$ grep -rn "business_context" lib/actions/
(no matches)
```

Implication: in production, this column is always NULL → the `<customer_business_context>` block in the mapping pipeline is always empty for real customers. Only fixture-driven tests exercise the path.

### A.5 Surprise — `fields.description` has no UI editor

[`FieldContext.description`](../../lib/ai/context-builder.ts#L29) is read into the prompt for target fields ([`context-builder.ts:548-552`](../../lib/ai/context-builder.ts#L548-L552)), but `FieldUpdates` in [`fields.ts:11-19`](../../lib/actions/fields.ts#L11-L19) does NOT include `description`. The Schema Overview UI ([`SchemaOverview.tsx:76-83`](../../app/app/projects/[projectId]/data-overview/SchemaOverview.tsx#L76-L83)) doesn't pass it. No code path sets the column today; values come only from DDL parsing if the DDL had `COMMENT ON COLUMN`.

---

## §B — Per-agent context flow audit

Eight agents in scope (per the prompt) plus three near-neighbours that the read surfaced (`enrichSchemaFromDocs`, `suggestTransformDescription`, `multi-agent` Critic / specialists). The eight in-scope agents are tabulated first; near-neighbours summarised at the end.

For each agent: entry function, system-prompt source, user-message construction, context sources passed and their order, where each source appears, whether sources are explicitly labelled, and cache-control posture.

### B.1 `mapping_generate` — the bulk mapping engine

| Aspect | Value |
|---|---|
| Entry | [`runMappingGenerationFromContext` lib/ai/mapping-engine.ts:1500](../../lib/ai/mapping-engine.ts#L1500) (BULK loop over source tables) |
| System prompt | [`MAPPING_GENERATION_SYSTEM_PROMPT` lib/ai/mapping-engine.ts:227-326](../../lib/ai/mapping-engine.ts#L227-L326) |
| Agent-mode system prompt | `MAPPING_GENERATION_AGENT_SYSTEM_PROMPT` (= base + `AGENT_TOOL_GUIDANCE`) [mapping-engine.ts:342-343](../../lib/ai/mapping-engine.ts#L342-L343) |
| User-message builder | [`buildMappingUserMessage` mapping-engine.ts:950-1003](../../lib/ai/mapping-engine.ts#L950-L1003); agent-mode wraps it via [`buildAgentUserMessage` mapping-engine.ts:374-388](../../lib/ai/mapping-engine.ts#L374-L388) |
| Cache control | `cacheControl: true` under PR 13.1 cohort flag ([`mapping-engine.ts:1652`](../../lib/ai/mapping-engine.ts#L1652)) |

**Context order in user message** (legacy / Phase-2 path, [mapping-engine.ts:1606-1612](../../lib/ai/mapping-engine.ts#L1606-L1612)):

1. `<source_schema>` — `formatSchemaForPrompt(sourceCtx, 'source')`
2. `<target_schema>` — `formatSchemaForPrompt(targetCtx, 'target')`
3. `<documentation>` — schema docs + business_context docs from `schema_documents` table (via `formatDocumentsForPrompt`)
4. `intelligence_context` (no XML wrapper, prepended as raw markdown)
5. `<other_source_tables>` — list of sibling source tables for table-mapping decisions
6. Hard-coded "CRITICAL RULES FOR THE JSON" + JSON shape

**Context order in agent / multi-agent path** (`AI_PHASE_3_ENABLED=1`, [`buildAgentUserMessage` mapping-engine.ts:374-388](../../lib/ai/mapping-engine.ts#L374-L388)):

1. `<customer_business_context>` ← `projects.business_context` column (dormant in prod; see §A.4)
2. `<schema_overview>` ← computed counts/conventions/FK density (`formatSchemaOverviewBlock`, [context-builder.ts:586-610](../../lib/ai/context-builder.ts#L586-L610))
3. The legacy `buildMappingUserMessage` body (steps 1-6 above)

**Sources are explicitly labelled** with XML tags except for `intelligence_context` (which has its own internal `## Migration Intelligence` markdown header).

### B.2 `mapping_suggestion` — single-pair Suggest action

| Aspect | Value |
|---|---|
| Entry | [`runMappingSuggestion` lib/ai/mapping-engine.ts:1924](../../lib/ai/mapping-engine.ts#L1924) (called via [`suggestMappingForTarget`](../../lib/actions/mappings-for-redesign.ts)) |
| System prompt | [`MAPPING_SUGGESTION_SYSTEM_PROMPT` mapping-engine.ts:1874-1875](../../lib/ai/mapping-engine.ts#L1874-L1875) — literally `"You are a data migration expert. Return ONLY valid JSON."` |
| User message | Constructed inline at [mapping-engine.ts:2148-2165](../../lib/ai/mapping-engine.ts#L2148-L2165) |
| Cache control | Not set (the system prompt is too short to benefit). |

**Context order**:

1. Target field name + type + tags + samples + value distribution
2. `<source_table>` blocks for ALL source tables in the project (each with fields + samples + distributions); built inline at [mapping-engine.ts:2123-2144](../../lib/ai/mapping-engine.ts#L2123-L2144)
3. `formatDocumentsForPrompt(context.documents)` — schema docs + business_context docs
4. `intelligence_context` (optional)
5. Hard-coded constraints (single source table, combination types, JSON shape)

**Notably absent**:
- `<customer_business_context>` (no `readBusinessContext` call)
- `<schema_overview>` block
- `<other_source_tables>` block
- Any priority / authority instruction in either system or user prompt

The system prompt is the most minimal in the codebase — no priority guidance whatsoever.

### B.3 `transform_generate` — SQL transformation generation

| Aspect | Value |
|---|---|
| Entry | [`generateTransform` ~lib/actions/transformations.ts:1114](../../lib/actions/transformations.ts#L1114) |
| System prompt | [`TRANSFORM_SYSTEM_PROMPT` transformations.ts:989-1084](../../lib/actions/transformations.ts#L989-L1084) — heavy SQL-pattern guidance |
| User message | Built inline at [transformations.ts:1312-1329](../../lib/actions/transformations.ts#L1312-L1329) |
| Context source | `buildAIContext` scoped to `[srcTableId, tgtTableId]` + relevant field IDs ([transformations.ts:1208-1220](../../lib/actions/transformations.ts#L1208-L1220)) |
| Cache control | `cacheControl: true` (PR 13.1 cohort) |

**Context order**:

1. `<source_field>` (formatted via `formatFieldForPrompt`) OR value-assignment marker
2. `<contributing_source_fields>` (many-to-one mappings only)
3. `<target_field>` with type / nullable / cardinality / `Allowed values` from CHECK constraint
4. `<type_compatibility>`
5. `transformDocBlock` ← `formatDocumentsForPrompt` (schema docs + business_context docs)
6. `intelligence_context`
7. `<existing_sql>` + `<iteration_instruction>` (refinement only)
8. `<description>` ← user's natural-language transform description (treated as authoritative — [system prompt §1060-1066](../../lib/actions/transformations.ts#L1060-L1066))

**Notably absent**: `<customer_business_context>`, `<schema_overview>`. Documentation IS labelled separately as `<schema_documentation>` vs `<business_context>` because `formatDocumentsForPrompt` partitions them.

### B.4 `validation_rule_from_nl` — NL-to-validation-rule

| Aspect | Value |
|---|---|
| Entry | [`addValidationRuleFromNL` lib/actions/validation-rules.ts:256](../../lib/actions/validation-rules.ts#L256) |
| System prompt | Inline string [validation-rules.ts:323-344](../../lib/actions/validation-rules.ts#L323-L344) — schema/JSON shape only, no priority guidance |
| User message | Inline at [validation-rules.ts:346-348](../../lib/actions/validation-rules.ts#L346-L348) |
| Context source | None — no `buildAIContext` call. Just direct DB reads of the single field + its profile. |
| Cache control | `cacheControl: true` |

**Context order** — exactly three lines:

1. `Field: <table>.<field> (<data_type>, inferred: <inferred_type>)`
2. `Sample values: <JSON of top-10 sample_values>`
3. `User's rule: "<NL string>"`

This is the **narrowest context of any agent in the codebase**. No documentation. No business_context. No schema_overview. No prior validation rules. No mappings. The agent has the field name, its inferred type, 10 sample values, and the user's free-text rule. Everything else is the LLM filling in from priors.

### B.5 `quality_detection_ai` — AI-augmented data quality issue detection

| Aspect | Value |
|---|---|
| Entry | [`runAIAugmentedChecks` lib/actions/ai-quality-detection.ts:172](../../lib/actions/ai-quality-detection.ts#L172) |
| System prompt | [`AI_DETECTION_SYSTEM_PROMPT` ai-quality-detection.ts:111-168](../../lib/actions/ai-quality-detection.ts#L111-L168) |
| User message | Inline at [ai-quality-detection.ts:329-342](../../lib/actions/ai-quality-detection.ts#L329-L342) |
| Context source | `buildAIContext` scoped to `[tableId]` ([ai-quality-detection.ts:216-230](../../lib/actions/ai-quality-detection.ts#L216-L230)) |
| Cache control | `cacheControl: true` (PR 13.1 cohort) |

**Context order**:

1. `formatSchemaForPrompt([tableCtx], 'source')` — single-table structured schema
2. `formatDocumentsForPrompt(aiContext.documents)` — schema docs + business_context docs (split + labelled)
3. `intelligence_context`
4. `<target_mappings>` — bespoke summary of `mapping_sources` joining target_field_mappings (line-per-source)
5. `<existing_issues>` — already-detected quality issues (de-dup signal)
6. Table ID + closing instruction

The **system prompt is uniquely explicit** about source partitioning ([ai-quality-detection.ts:111-117](../../lib/actions/ai-quality-detection.ts#L111-L117)):

> You are a data quality analyst for enterprise data migrations. You are given:
> 1. Field profiles from a source data table (types, null rates, value distributions, format issues)
> 2. Schema documentation describing the intended schema structure and known issues
> 3. Business context documents with migration rules and requirements
> 4. Existing quality issues already detected by automated rules (do NOT duplicate these)
> 5. Target field mappings and constraints (if available)

This is the **only system prompt that enumerates context sources by category**. It does not specify priority among them.

### B.6 `quality_fix_options` — fix-option generation

| Aspect | Value |
|---|---|
| Entry | [`generateFixSuggestions` lib/quality/fix-engine.ts:194](../../lib/quality/fix-engine.ts#L194) (≈) |
| System prompt | [`SYSTEM_PROMPT` fix-engine.ts:60-188](../../lib/quality/fix-engine.ts#L60-L188) — heavy SQL-safety guidance |
| User message | Inline at [fix-engine.ts:445-471](../../lib/quality/fix-engine.ts#L445-L471) |
| Context source | `buildAIContext` for the affected field/table ([fix-engine.ts:308](../../lib/quality/fix-engine.ts#L308)) |
| Cache control | `cacheControl: true` |

**Context order**:

1. `<issue>` — title, description, severity, stage, affected count, table id
2. `<field_context>` ← `formatFieldForPrompt` (full distribution + samples)
3. `<affected_rows_sample>` — actual rows surfacing the issue
4. `<target_context>` — target field constraint
5. `${fixDocBlock}` ← `formatDocumentsForPrompt` (schema docs + business_context docs)
6. `<other_issues>` — sibling quality issues for context

Notably: actual `data_rows` *samples* appear here as `<affected_rows_sample>` — the only agent that passes raw-data samples *directly* in the prompt (rather than only via field profile aggregates). This makes sense since fix SQL needs to target specific bad values.

### B.7 `migration_intelligence` (== `extracted_patterns`) — post-completion learning

| Aspect | Value |
|---|---|
| Entry | [`runMigrationIntelligenceExtraction` lib/actions/migration-intelligence.ts:~700](../../lib/actions/migration-intelligence.ts) |
| System prompt | [`EXTRACTION_SYSTEM_PROMPT` migration-intelligence.ts:88-145](../../lib/actions/migration-intelligence.ts#L88-L145) |
| User message | Built inline at [migration-intelligence.ts:879-900](../../lib/actions/migration-intelligence.ts#L879-L900) |
| Context source | Bespoke — DOES NOT call `buildAIContext`. Reads `table_mappings`, `target_field_mappings`, `mapping_sources`, `transformations`, `quality_issues`, `validation_rules`, `schema_documents` directly. |
| Cache control | Not set. |

**Context order**:

1. `## Approved Mappings` — table-by-table field mapping summary with confidence + transform info
2. `## Transformations Applied` — flat list with src → tgt + description + SQL + status
3. `## Data Quality Issues Detected`
4. `## Validation Rules Created`
5. `## Documentation Context` ← raw concatenated `extracted_text` from `schema_documents` (no doc_type partitioning)

This is the only agent that conflates `doc_type='schema'` and `doc_type='business_context'` documents into a single `<documentation>` block. The other six (that touch documents) call `formatDocumentsForPrompt` and get the partition for free.

It also does NOT see field profiles, sample values, or value distributions. By design: it's extracting patterns *from completed work*, not analysing data.

### B.8 Summary — agent ↔ source matrix

Y = present in prompt (with XML wrapper); o = bespoke / unwrapped; — = not present.

| Agent | `<source_schema>` / structured | `<target_schema>` | `<schema_documentation>` | `<business_context>` | `<customer_business_context>` (`projects.business_context`) | `schema_overview` block | `intelligence_context` | Prior mappings | Existing rules / issues | Provenance label (`schema_source`) | Raw `data_rows` samples |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mapping_generate (legacy) | Y | Y | Y | Y | — | — | o | — | — | — | — |
| mapping_generate (agent / multi-agent) | Y | Y | Y | Y | **Y** (dormant) | **Y** | o | — | — | — | — |
| mapping_suggestion | Y (all source tables, bespoke shape) | one field only | Y | Y | — | — | o | — | — | — | — |
| transform_generate | one field | one field | Y | Y | — | — | o | — | — | — | — |
| validation_rule_from_nl | **only field name + samples** | — | — | — | — | — | — | — | — | — | — |
| quality_detection_ai | Y | — | Y | Y | — | — | o | **Y (target_mappings block)** | **Y (existing_issues)** | — | — |
| quality_fix_options | one field | one field | Y | Y | — | — | — | — | **Y (other_issues)** | — | **Y (affected_rows_sample)** |
| migration_intelligence | — | — | conflated `<documentation>` | conflated `<documentation>` | — | — | — | **Y (entire mappings section)** | **Y (issues + rules sections)** | — | — |

Two agents use `data_rows` samples (`quality_fix_options`) or rely entirely on profile aggregates (`buildAIContext` for the others). No agent receives the per-field `schema_source` provenance label in any prompt.

### B.9 Near-neighbour agents (out of the principal's 8)

| Agent | Entry | Notes |
|---|---|---|
| `enrichSchemaFromDocs` | [schema-enrichment.ts:85](../../lib/actions/schema-enrichment.ts#L85) | The agent that *writes* `doc_enriched` fields. System prompt at [schema-enrichment.ts:44-81](../../lib/actions/schema-enrichment.ts#L44-L81) explicitly says **"The documentation is the source of truth for structural metadata — the data may contain quality issues that make inference unreliable."** This is the strongest single priority statement in the codebase but it ranks **doc > data**, not the principal's full 4-tier framework. |
| `multi-agent Generator / Critic / Cross-Table / Cardinality` | [multi-agent-prompts.ts](../../lib/ai/multi-agent-prompts.ts) | The Generator prompt at [multi-agent-prompts.ts:51](../../lib/ai/multi-agent-prompts.ts#L51) cues "The customer business context (when present) — this often documents value-translation rules and naming conventions the data alone doesn't reveal." Critic prompt at [multi-agent-prompts.ts:175-185](../../lib/ai/multi-agent-prompts.ts#L175-L185) instructs "USE BUSINESS_CONTEXT HEAVILY". |
| `suggestTransformDescription` | [transformations.ts:2686](../../lib/actions/transformations.ts#L2686) | NL description suggestion before `transform_generate`. Same context shape as transform_generate; system prompt is short. |
| `ddl_parsing`, `manual_fix`, `migration_runbook`, `execution_package`, `query`, `schema_merge` | various | Out of the principal's 8 but present in the codebase. None of them get reviewed for input prioritisation here. |

---

## §C — Priority handling

### C.1 Explicit priority instructions found in current prompts

Only **two** explicit "X over Y" priority statements exist across all system + user prompts in the codebase:

#### C.1.a [`context-builder.ts:670-673`](../../lib/ai/context-builder.ts#L670-L673) — inside `<schema_documentation>` block

> "IMPORTANT: If these documents describe a different data type, constraint, nullability, or relationship than the structured `<source_schema>` or `<target_schema>` sections, ALWAYS follow the structured schema. The structured schema reflects the user's latest configuration and is the source of truth for all structural definitions. Use these documents only for business rules, valid value lists, naming conventions, and domain context."

Encodes: **structured schema (== current `fields` row) > schema docs**.

#### C.1.b [`mapping-engine.ts:324`](../../lib/ai/mapping-engine.ts#L324) — `MAPPING_GENERATION_SYSTEM_PROMPT`

> "If documentation describes different data types or constraints than the structured schema, always follow the structured schema — it reflects the user's latest configuration."

Same statement, restated. Mapping_generate is the only agent whose system prompt restates the rule; the other agents inherit it implicitly via `formatDocumentsForPrompt`.

### C.1.c [`context-builder.ts:697-701`](../../lib/ai/context-builder.ts#L697-L701) — `<business_context>` block

> "These are business context documents (migration requirements, business rules, value mappings, stakeholder specifications). Use them to guide mapping logic, transformation rules, and migration behaviour — but do not let them override formal schema constraints."

Encodes: **schema constraints > business documents**. Combined with C.1.a, the implied chain is:

```
structured schema   >   schema documents   >   business documents
```

That's a 3-tier ordering ≈ principal's P1+P2 vs P2 vs P3, but with **the user-edit (P1) signal collapsed into the same bucket as DDL-parsed and AI-enriched** (because all three live in the `fields` row and the prompt has no provenance distinction).

### C.2 What the agent actually sees vs the principal's authority chain

| Principal's tier | What the LLM literally sees in prompt |
|---|---|
| **P1** User Schema Overview edits | The current `fields` row, with NO label distinguishing user-authored from AI-inferred. The `schema_source` column is read into [`FieldContext`](../../lib/ai/context-builder.ts#L25) but `formatSchemaForPrompt` never emits it. |
| **P2** Schema docs | `<schema_documentation>` block inside `<documentation>` |
| **P3** Business docs | `<business_context>` block inside `<documentation>` |
| **P4** Raw data | Field profile aggregates (samples, distributions) inside `<source_schema>` / `<target_schema>`. Raw `data_rows` only surfaces in `quality_fix_options`'s `<affected_rows_sample>`. |

**Gap on P1**: the structural edit is written *into* the same row as inferred metadata, with `schema_source='manual'` as the marker. Downstream agents see the *result* (the edited type / nullable / FK), but not the marker. They cannot tell "this is what the user said" from "this is what the inference produced."

### C.3 Are there places where a user edit signal flows to ANY agent?

**Yes, indirectly, via the `fields` row state.** The user's edit *does* reach the agent — but as anonymous content. The agent reads the same column the inference engine writes; whoever wrote last wins without label.

**No, directly.** Nothing in any prompt says "this field was user-edited" or "this field has provenance X". The only consumer of `schema_source` is `canOverride()` at write-time ([schema-priority.ts:54-62](../../lib/utils/schema-priority.ts#L54-L62)) — it gatekeeps which writers can mutate which rows. The label never reaches an LLM.

### C.4 Are user edits stored as edits (with provenance) vs in-place overwrites?

**In-place overwrites.** The `updateField` action at [`fields.ts:96-101`](../../lib/actions/fields.ts#L96-L101) issues a single `UPDATE` on the `fields` row that sets the new values + bumps `schema_source` to `'manual'`. The previous values are not retained. There is no `field_history`, `field_edits`, or similar audit table for structural changes.

`ai_edit_history` (which DOES retain before/after, [ai-edit-history.ts:55-77](../../lib/actions/ai-edit-history.ts#L55-L77)) covers `target_field_mapping`, `mapping_source`, `transformation`, `validation_rule`, `quality_issue` — **not `field`**. Schema overview edits are deliberately outside its scope per [migration 083](../../supabase/migrations/083_ai_edit_history.sql).

`activity_log` (the human-visible event log) does record schema overview edits as descriptive strings via `logActivity`, but only as one-line descriptions — no structured before/after, not consumable by an agent.

### C.5 What happens when sources conflict today

See §E for a full conflict-handling audit.

---

## §D — Gap analysis vs. principal framework

| Priority | Source | Captured? | Differentiated in prompt? | Flowing to agents? | Verdict |
|---|---|---|---|---|---|
| **P1** | User Schema Overview edits | **Stored** as `schema_source='manual'` on the `fields` row ([fields.ts:97-99](../../lib/actions/fields.ts#L97-L99)). **Protected** at write-time by `canOverride()`. | **NO.** `formatSchemaForPrompt` never emits `schema_source`. The edited values blend into the structural schema with no label. | Implicitly: agents see the post-edit field row. No agent receives the *user-edit* signal. | **PARTIAL** — captured + protected on write path, missing on prompt path. |
| **P2** | Schema docs (DDL, ERD, data dict) | **Stored** as `schema_documents.extracted_text` with `doc_type='schema'`, dataset-scoped. | **YES.** Surfaced as `<schema_documentation>` block inside `<documentation>` ([context-builder.ts:665-692](../../lib/ai/context-builder.ts#L665-L692)). | All agents that call `formatDocumentsForPrompt` (mapping_generate, mapping_suggestion, transform_generate, quality_detection_ai, quality_fix_options) | **ALIGNED** with one caveat — `validation_rule_from_nl` does not call `formatDocumentsForPrompt` so it never sees schema docs. |
| **P3** | Business docs (free-text rules, value maps) | **Stored** as `schema_documents.extracted_text` with `doc_type='business_context'`, project-scoped. Also `projects.business_context` column (dormant in prod — see §A.4). | **YES** for the doc table. Surfaced as `<business_context>` block ([context-builder.ts:694-707](../../lib/ai/context-builder.ts#L694-L707)). For `projects.business_context`, surfaced as `<customer_business_context>` only in agent-mode mapping. | Same as P2 (all `formatDocumentsForPrompt` callers) plus mapping-engine agent path. | **PARTIAL** — schema_documents path works; `projects.business_context` path has no production setter. |
| **P4** | Raw data | **Stored** in `data_rows.row_data` (JSONB) and aggregated into `field_profiles`. | **YES** for aggregates. Profiles surface as `Stats:`, `Values:`, `Samples:` lines inside `<source_schema>` / `<target_schema>` ([context-builder.ts:554-572](../../lib/ai/context-builder.ts#L554-L572)). Raw `data_rows` rows only in `quality_fix_options` `<affected_rows_sample>`. | All agents that build a context. `validation_rule_from_nl` only reads top-10 sample values, no distribution. | **ALIGNED** with one caveat — there is no agent-side instruction calling out raw data as the *lowest* authority. The implicit ordering comes from the doc-vs-schema rule (C.1.a) which leaves the data-vs-anything question silent. |

### D.1 Cross-cutting gap

There is **no priority instruction in any prompt that mentions all four tiers in order**. The strongest existing statement is `enrichSchemaFromDocs` at [schema-enrichment.ts:48](../../lib/actions/schema-enrichment.ts#L48): "The documentation is the source of truth for structural metadata — the data may contain quality issues that make inference unreliable." But that prompt is the one *writing* `doc_enriched` rows; it doesn't run during normal mapping/transform/quality flows.

---

## §E — Conflict-handling audit

### E.1 Schema doc says type X, raw data shows type Y

Two scenarios distinguished by *where* the conflict surfaces:

#### E.1.a Conflict surfaces during `enrichSchemaFromDocs` (a write-path AI agent)

[schema-enrichment.ts:255-339](../../lib/actions/schema-enrichment.ts#L255-L339) runs when a schema doc is uploaded. It compares `inferred` field rows against doc-stated metadata and proposes corrections. Resolution:

- If the existing `fields.schema_source` is `'inferred'` or `'cross_table_inferred'` → the field row is **overwritten** with `schema_source='doc_enriched'`.
- If the existing `schema_source` is `'ddl_parsed'` or `'manual'` → the correction is **routed to `validation_rules`** as a `severity='warning'` rule via [`routeConflictToValidationRule`](../../lib/actions/schema-enrichment.ts#L411-L489). The field row is not touched.

The user is told (in the rule description) to "promote via a manual edit in Schema Overview to enforce structurally" ([schema-enrichment.ts:449](../../lib/actions/schema-enrichment.ts#L449)).

#### E.1.b Conflict surfaces at runtime in a mapping / transform / quality prompt

The agent sees:
- The structured field row (whatever `schema_source` produced it — but no label visible to the agent)
- The schema doc text inside `<schema_documentation>`
- The instruction "always follow the structured schema" ([context-builder.ts:670-673](../../lib/ai/context-builder.ts#L670-L673))

The agent obeys the structured schema. The doc's *non-structural* content (value lists, business rules) is still useable per the same instruction.

### E.2 User edits Schema Overview, schema doc says something different

**At write time**: user edit lands first → `schema_source='manual'`. A subsequent doc upload that triggers `enrichSchemaFromDocs` finds `schema_source='manual'`, fails the `canOverride('manual', 'doc_enriched')` check, and routes the doc's claim to `validation_rules` as warning ([schema-enrichment.ts:268-274](../../lib/actions/schema-enrichment.ts#L268-L274)).

**At prompt time**: agents see the user's edited values. They do NOT see "this was user-authored." They DO see the doc's text inside `<schema_documentation>`, with the instruction "always follow the structured schema." Behaviour: agent ranks structured > doc, so the user edit wins — but only because of the prompt instruction, not because the agent can identify the user edit.

### E.3 Business doc says "field X represents customer category", raw data shows numeric values

The agent sees:
- Field `X` with type/inference/profile in the structured schema (e.g., `data_type=INT`, samples `[1, 2, 3, 4]`)
- The business doc text in `<business_context>`
- The instruction "do not let them override formal schema constraints" ([context-builder.ts:700-701](../../lib/ai/context-builder.ts#L700-L701))

Practically: the agent treats the field as numeric (per schema), with the business doc's "customer category" framing informing its mapping/transform decisions. For mapping_generate this often surfaces as a value-mapping `needs_transformation: true` recommendation. For transform_generate, the user's NL description is treated as authoritative ([transformations.ts:1060-1066](../../lib/actions/transformations.ts#L1060-L1066)) so the description carries the resolution.

There is no agent-side instruction telling the model "if the business doc and the data disagree about *semantics*, ask the user / surface a confidence flag" — the model handles these silently.

### E.4 Summary of conflict-handling

| Conflict | Write-path resolution | Prompt-path resolution |
|---|---|---|
| Doc says NOT NULL, schema_source=`inferred` says nullable | `enrichSchemaFromDocs` overwrites field; bumps to `doc_enriched`. | Agent sees post-overwrite row. |
| Doc says NOT NULL, schema_source=`manual` says nullable | `enrichSchemaFromDocs` routes to `validation_rules` as warning; field row untouched. | Agent sees user's nullable=true row + doc text + "follow structured schema" instruction → ranks user. |
| Business doc says X, schema says Y about a *type/constraint* | None — business docs don't modify field rows. | Agent sees both + "do not let them override formal schema constraints" → ranks schema. |
| Business doc says X, schema says Y about *semantics* | None | Agent infers; no special instruction. |

---

## §F — Schema overview edit signal trace

This is the load-bearing question for the principal's framework. Below is the full path from the user's UI click to (potentially) an agent's prompt.

### F.1 Where do schema overview edits get stored?

**In place, on the `fields` row.** Specifically, [`updateField` lib/actions/fields.ts:69-115](../../lib/actions/fields.ts#L69-L115) issues:

```ts
.update({ ...updates, schema_source: 'manual' })
.eq('id', fieldId)
```

— a single `UPDATE` that replaces the affected columns and bumps `schema_source` to `'manual'`.

Editable columns from the UI ([SchemaOverview.tsx:76-83](../../app/app/projects/[projectId]/data-overview/SchemaOverview.tsx#L76-L83)):

- `name`
- `data_type`
- `is_nullable`
- `is_primary_key`
- `is_foreign_key`
- `fk_reference`

The `inferred_type` is auto-refreshed when `data_type` changes ([fields.ts:91-93](../../lib/actions/fields.ts#L91-L93)). `description` and `default_value` are NOT editable from this UI today (see §A.5).

### F.2 Are edits retained as user-authored vs AI-inferred?

**At the column level, yes.** `schema_source='manual'` is the marker.

**At the value level, no.** The previous (AI-inferred) value is overwritten. There is no field-row history table. `ai_edit_history` does not cover `entity_type='field'`.

So you can answer "did a user touch this field?" (yes if `schema_source='manual'`) but you cannot answer "what did inference say before the user edited it?" without going back to the original CSV / DDL source.

### F.3 Do user edits propagate to ANY agent's context today?

**Yes — but only as anonymous structural data, not as a labelled signal.**

The `fields` row is read into `FieldContext` ([context-builder.ts:282-316](../../lib/ai/context-builder.ts#L282-L316)) which carries `schema_source` as a typed field. But `formatSchemaForPrompt` ([context-builder.ts:518-578](../../lib/ai/context-builder.ts#L518-L578)) never emits the label — the comment at [context-builder.ts:24-25](../../lib/ai/context-builder.ts#L24-L25) calls this out explicitly:

> "Provenance label. Not emitted in the prompt today, but carried on the context so future heuristics (confidence weighting, skip rules) can use it."

So:
- Mapping_generate sees the user-edited type / nullable / FK row.
- Transform_generate sees the user-edited type for the source / target.
- Quality_detection_ai sees the user-edited row.
- Validation_rule_from_nl sees the user-edited type (the only column it reads from `fields`).
- Fix_options sees the user-edited row.
- Migration_intelligence does not directly read field rows; it reads finalised mappings.
- Mapping_suggestion sees the user-edited row.

**None of these agents know which row was user-edited.** They cannot weight a user-authored type more heavily than an AI-inferred one — they're identical at the prompt layer.

### F.4 Where's the gap?

The gap is **at the context-builder / formatter layer**. Three concrete components are missing:

1. **`formatSchemaForPrompt` does not emit `schema_source`.** The data is on the FieldContext but the formatter drops it. Could be added as an inline tag, e.g. `[manual]` in the field flag list at [context-builder.ts:541-543](../../lib/ai/context-builder.ts#L541-L543).
2. **No system-prompt instruction telling the model what `schema_source='manual'` means.** Even if F.4.1 is fixed, no prompt tells the model "fields tagged `[manual]` are user-authoritative; trust them over schema docs."
3. **No agent-side strategy for how to weight raw data vs everything else.** The doc-vs-schema rule covers half the decision space; the data-vs-{schema, docs} half is implicit.

### F.5 The data layer is *almost* ready

The data layer captures everything the principal needs:

- `fields.schema_source` is the user-edit signal (the `'manual'` value)
- `fields.{name, data_type, ...}` carry the values
- `schema_documents` (with `doc_type` partition) carries P2 and P3 separately
- `field_profiles` + `data_rows` carry P4

So no schema migration is required to surface user-edit provenance to agents. The change is purely in the formatter + system prompts.

---

## §G — Recommendations (READ-ONLY — no implementation in this PR)

Surface-level findings first; deeper schema/data-layer questions second; open principal-review questions last.

### G.1 Context-builder changes

1. **Emit `schema_source` in `formatSchemaForPrompt`.** Add the provenance label to the field flag list — e.g. `- email (VARCHAR(255)) [PK, manual, semantic:email]` so agents can see that `manual` came from the user. This is a one-file change in [context-builder.ts:531-543](../../lib/ai/context-builder.ts#L531-L543) plus heritage byte-identical implications (the existing flag-OFF byte-identical fingerprint covers the legacy single-shot path; emitting an additional flag changes the prompt and would need a heritage rebaseline OR a feature gate). Recommend gating behind a new flag (e.g. `AI_PROVENANCE_LABELS_ENABLED=1`) so heritage stays clean until the principal opts in.

2. **Add a system-prompt clause encoding the 4-tier framework.** Write it once in a shared helper (`AGENT_PROVENANCE_GUIDANCE` ≈ to `AGENT_TOOL_GUIDANCE`) and prepend to every agent's system prompt. The clause should say, in order:
   - User edits in the structured schema (any field tagged `manual`) are the highest authority. Do not propose a mapping / transformation that contradicts them; if a doc disagrees, prefer the user.
   - Schema documents in `<schema_documentation>` are the next authority for *structural* claims (types, nullability, keys). They do not override user edits.
   - Business documents in `<business_context>` are reference context for *value-level* and *semantic* claims (value mappings, naming conventions, business rules). They do not override structural claims from either source above.
   - Raw data (samples, distributions, format issues in `Stats:` / `Values:` / `Samples:` lines) is the lowest authority. Use it to *verify* structural claims and to inform value-level decisions, but do not override higher-authority sources when they disagree.

3. **Make the doc-vs-schema language consistent across all agents that mention it.** Currently only `mapping_generate` and `formatDocumentsForPrompt` carry it; if the framework lives in a shared block, all 8 agents inherit it for free.

### G.2 System-prompt changes (per-agent)

4. **`validation_rule_from_nl` (B.4) needs documentation context.** Today it sees only the field name + samples + the user's NL rule. If the user uploaded a business doc that says "field X must match SSN format \\d{3}-\\d{2}-\\d{4}" and then types "this field must be valid", the agent has no way to know what "valid" means in this domain. Recommend wiring `formatDocumentsForPrompt` into [validation-rules.ts:346-348](../../lib/actions/validation-rules.ts#L346-L348). Cost: one `buildAIContext` call + a few hundred tokens of doc text per invocation.

5. **`mapping_suggestion` (B.2) lacks `<customer_business_context>` and `<schema_overview>`.** Today it relies on schema docs only. If the principal lights up `projects.business_context` (see §G.3), `mapping_suggestion` should consume it the same way `mapping_generate` does.

### G.3 Schema / data-layer changes

6. **Build a UI for `projects.business_context`.** Migration 086 added the column; production has no setter; the read path (`readBusinessContext` + `<customer_business_context>` block) is wired but always empty for real customers. Recommend a settings tab (or an inline editor on the project page) and a server action that upserts the column. Until this lands, the agent-mode mapping pipeline's `<customer_business_context>` block is dead weight in production.

7. **Decide whether `fields.description` should be user-editable.** Today it's written only by DDL parsers (when `COMMENT ON COLUMN` is present) and surfaces in target-side `<target_schema>` rendering. If the principal wants P1 to include free-text per-field intent, extending `FieldUpdates` + the SchemaOverview UI is straightforward.

8. **Optionally retain user-edit history.** If "user edited from VARCHAR to DECIMAL on 2026-04-15" should be visible to agents (e.g. so a model can say "the user changed this 6 days ago — strong recent signal"), a `field_history` table (or extending `ai_edit_history` to cover `entity_type='field'`) is needed. This is a larger change. Probably not load-bearing for the immediate framework alignment — `schema_source='manual'` is enough to mark "user-touched" for now.

### G.4 Open questions for principal review

| # | Question |
|---|---|
| Q1 | Are you OK with **emitting `schema_source` as an inline flag** (`[manual]`) in every field's prompt rendering? It changes the prompt surface for every agent that calls `formatSchemaForPrompt`. Heritage byte-identical fingerprints would need a rebaseline OR the change goes behind a new flag (`AI_PROVENANCE_LABELS_ENABLED`). |
| Q2 | The codebase's `SCHEMA_SOURCE_PRIORITY` cascade has 5 tiers (`inferred → cross_table_inferred → doc_enriched → ddl_parsed → manual`); your framework has 4 (P1-P4). Are you happy collapsing `ddl_parsed` and `doc_enriched` into a single P2 ("schema documents") for prompt-side reasoning, or do you want the agent to see them separately? |
| Q3 | `projects.business_context` has no production UI today — should I scope a UI for it as part of P3 alignment, or is your framework's "business documents" satisfied by `schema_documents` with `doc_type='business_context'`? If satisfied, recommend deleting the dormant column to avoid confusion. |
| Q4 | `validation_rule_from_nl` has the narrowest context of any agent (just field name + samples + NL string). Is that intentional minimalism, or a gap that should be closed by wiring `formatDocumentsForPrompt`? |
| Q5 | When schema doc and raw data disagree on a *type* (doc says DECIMAL, samples are all VARCHAR-formatted "$1,234.56"), the current agent-side rule is silent. Is your framework's P2 > P4 the answer (trust the doc) or do you want a "surface this conflict to the user" path? |
| Q6 | If user edits should be retained as history (not just `schema_source='manual'`), is the urgency high enough to ship a `field_history` table, or is "user touched this" sufficient for the agent's purposes? |
| Q7 | `migration_intelligence` is the only agent that conflates `<schema_documentation>` and `<business_context>` into a single block. Do you want it to partition them like the other agents, or is this an acceptable simplification because the agent's job is post-completion learning rather than mapping/transforming? |
| Q8 | None of the 8 agents see `validation_rules` or `ai_edit_history` in their prompts today. If the user has authored 10 validation rules saying "this field must satisfy ...", should `mapping_generate` see them? `transform_generate`? Both? Where does the boundary live? |

---

## §H — Most surprising findings (top 3)

1. **`projects.business_context` is dormant in production.** Migration 086 added the column, the read path wires it into the agent-mode mapping prompt as `<customer_business_context>`, but no UI / server action sets it. Only the eval synthetic-context-builder writes it. Agent-mode mapping ships in production with this block always empty.

2. **`validation_rule_from_nl` sees neither documentation nor business context.** Of the 8 agents, this is the only one that doesn't call `buildAIContext` at all — the prompt is field name + 10 sample values + the user's NL string. A user who has uploaded a 50-page schema doc that defines "valid" for every field gets none of it surfaced when typing "this field must be valid" in the validation tab.

3. **No agent receives the `schema_source` label in any prompt.** The data is on `FieldContext` (per [context-builder.ts:25](../../lib/ai/context-builder.ts#L25)) but `formatSchemaForPrompt` never emits it. The principal's P1 (user edits) is *protected* at write-time by `canOverride()` but *invisible* at read-time — every downstream agent sees user edits as just another field row. The strongest priority signal in the codebase (`schema_source='manual'`) does not reach a single LLM.

---

## §I — Recommended order of follow-up work

If the principal endorses the 4-tier framework as-is, the smallest viable first PR is:

| PR | Scope | LOC | Risk |
|---|---|---|---|
| **PR-A** | Add `AGENT_PROVENANCE_GUIDANCE` shared block + emit `schema_source` flag in `formatSchemaForPrompt`, gated behind `AI_PROVENANCE_LABELS_ENABLED=1`. Rebaseline heritage *under flag-ON*. Keep flag-OFF byte-identical so existing heritage tests don't break. | ~80 LOC across `context-builder.ts` + new shared block + 8 system prompts + 1 new flag in CLAUDE.md §4.5.1. | Low — gated. |
| **PR-B** | Wire `formatDocumentsForPrompt` into `addValidationRuleFromNL` (close gap B.4). | ~20 LOC. | Low. |
| **PR-C** | Build UI + server action for `projects.business_context` (close A.4 dormancy). OR delete the column if Q3 says "use schema_documents only." | ~150 LOC if shipping UI; ~30 LOC + a migration if dropping. | Medium — touches user-facing UI. |
| **PR-D** | Stretch: extend `ai_edit_history` to cover `entity_type='field'` if Q6 says "yes, retain edit history". | ~60 LOC + migration. | Medium — schema change. |

PR-A and PR-B can ship in parallel (independent surfaces). PR-C waits on the principal's Q3 decision. PR-D waits on Q6.

This investigation alone (this document) is the deliverable for INV-1 — no PR is opened from it.

---

*End of INV-1.*
