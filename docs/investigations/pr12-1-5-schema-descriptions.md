# PR 12.1.5 — Schema Description Audit (Phase A Investigation)

**Type:** Read-only investigation. No code changes proposed below as patches. The only file written is this document.

**Audience:** Kaan (founder review for domain accuracy) + the AI architect drafting Phase B.

**Scope:** Audit description quality across the 13 JSON tool schemas in `lib/ai/tool-schemas.ts`; propose enriched descriptions for the 5 high-stakes tools; identify domain-expertise gaps requiring founder input.

**Out of scope:** Implementation. The H1 flag-conditional design is preserved — no system-prompt changes in callsite files.

---

## TL;DR

| Metric | Value |
|---|---|
| Tools audited | 13 |
| Tools rated **rich** | 0 |
| Tools rated **adequate** | 13 |
| Tools rated **thin** | 0 |
| Total properties across all tools (top-level + nested) | ~110 |
| Properties WITH a `description` field | ~16 |
| Properties WITHOUT a `description` field | ~94 |
| Enum-tightening candidates surfaced | 4 (one is a structural divergence) |
| `[NEEDS KAAN INPUT]` flags surfaced | 11 (consolidated by topic in §6) |
| Estimated Phase B scope | ~+200-300 LOC in tool-schemas.ts; ~$0.05 verification spend |

**Key finding:** every tool has a passable tool-level description today. None is "rich" by the audit's bar (3-5 sentences with usage guidance, decision criteria, edge cases). And ~85% of properties carry NO description at all — the model is generating inputs against type + name + the upstream system prompt only, with no schema-attached guidance. This is the largest output-quality lever PR 12.1 left on the table.

**One structural divergence found:** `EMIT_VALIDATION_RULE_TOOL.rule_type` enum lists 11 values but `validateRuleConfig` in `lib/actions/validation-rules.ts:119` accepts a 12th value, `custom_sql`. Either the enum is missing a value or `custom_sql` is dead code. Flagged in §2 + §6.

---

## Section 1 — Per-tool description audit

Sorted thin → adequate → rich. (No tools fell into the **thin** or **rich** tiers; all 13 are **adequate**.) Tier rubric:

- **rich** — 3-5 sentences naming the output AND giving usage guidance (when to call, decision criteria, edge cases). Property descriptions on >80% of fields.
- **adequate** — 1-2 sentences naming the output, with sparse property descriptions.
- **thin** — <1 sentence or missing tool-level description; no property descriptions.

| # | Tool | Tool-level desc length (chars) | Quality | Top-level props | Total nested props (incl. shared shapes) | Props WITH desc | Props WITHOUT desc |
|---|---|---|---|---|---|---|---|
| 1 | `emit_table_mappings` | 638 | adequate | 1 | ~16 (via `TABLE_MAPPING_SCHEMA` + `FIELD_MAPPING_SCHEMA`) | 0 | ~16 |
| 2 | `emit_field_mappings` | 348 | adequate | 1 | ~11 (via `FIELD_MAPPING_SCHEMA`) | 0 | ~11 |
| 3 | `emit_mapping_suggestion` | 314 | adequate | 4 | 4 | 2 | 2 |
| 4 | `emit_validation_rule` | 510 | adequate | 5 | 5 | 4 | 1 |
| 5 | `emit_parsed_ddl` | 542 | adequate | 1 | ~10 | 1 | ~9 |
| 6 | `emit_schema_corrections` | 366 | adequate | 1 | ~10 | 0 | ~10 |
| 7 | `emit_table_matches` | 263 | adequate | 1 | 3 | 0 | 3 |
| 8 | `emit_extracted_patterns` | 458 | adequate | 1 | 6 | 3 | 3 |
| 9 | `emit_quality_issues` | 484 | adequate | 1 | 8 | 0 | 8 |
| 10 | `emit_fix_options` | 528 | adequate | 3 | 10 | 0 | 10 |
| 11 | `emit_migration_runbook` | 481 | adequate | 8 | ~25 | 0 | ~25 |
| 12 | `emit_compartmentalized_package` | 332 | adequate | 1 | 7 | 0 | 7 |
| 13 | `emit_query_suggestions` | 326 | adequate | 1 | 2 | 1 | 1 |

**Pattern observed:** every tool-level description names the output and gives 1-2 lines of when-to-call context, but none commits to decision criteria ("emit confidence 90+ ONLY when…"), edge cases ("never emit a lookup → entity table mapping"), or output volume guidance ("8-15 patterns; 2-3 fix options"). Most of that guidance lives in the system prompts of the consuming callsites — Phase B's job is to migrate the callsite-specific guidance into the tool descriptions where the model sees it during structured generation.

---

## Section 2 — Enum tightening candidates

Properties currently typed as `{ type: 'string' }` whose accepted value sets are documented elsewhere (in code, in system prompts, or in TS interfaces).

| # | Tool | Property path | Current type | Proposed enum values | Source-of-truth |
|---|---|---|---|---|---|
| 1 | `emit_validation_rule` | `input_schema.properties.rule_type` | `enum` of **11** values | Add `custom_sql` (12 total) | `lib/actions/validation-rules.ts:119-123` — `validateRuleConfig` accepts `custom_sql` and validates `config.sql` is a non-empty string. The current schema enum will reject this rule_type at the API boundary, producing a no-op for any user who tries to NL-author a custom_sql rule. **DIVERGENCE** — flagged in §6. |
| 2 | `emit_schema_corrections` | `input_schema.properties.corrections.items.properties.corrections.properties.inferred_type` | `{ type: 'string' }` | `enum: ['email', 'phone', 'date', 'datetime', 'currency', 'boolean', 'percentage', 'url', 'address', 'zip_code', 'country', 'state', 'name', 'id']` | `lib/actions/schema-enrichment.ts:55` — system prompt explicitly enumerates valid semantic types in the same order. Without the enum, the model can emit any string (e.g., `"name_first"`) which downstream consumers may not recognize. |
| 3 | `emit_parsed_ddl` | `input_schema.properties.tables.items.properties.fields.items.properties.checkConstraint` | untyped (no `type` declared) | Tighten to `oneOf` discriminated union with `type: enum(['in_list', 'regex', 'range', 'custom'])` | `lib/parsers/ddl-parser.ts:13-17` — `CheckConstraint` is a TS discriminated union with exactly these 4 variants. Per-variant property shapes (`allowedValues`, `pattern`, `min`/`max`, `raw`) are also documented in `DDL_PARSE_SYSTEM` at line 380-385. **CAVEAT:** Anthropic's strict-mode `oneOf` support is uncertain — needs a one-shot probe before Phase B commits. If `oneOf` doesn't compose with strict, alternative is to add a per-variant property and require `type` as a discriminator string enum, accepting some looseness. |
| 4 | `emit_extracted_patterns` | `input_schema.properties.patterns.items.properties.pattern_config` | `{ type: 'object', additionalProperties: true }` (free-form) | **Keep free-form** — confirmed intentional per the existing header comment | `lib/actions/migration-intelligence.ts:67-100` — pattern_config's shape varies by `category` enum (4 distinct templates per category). Tightening to a `oneOf` per-category is a Phase 3 refinement; for now the free-form is the right design. NO CHANGE proposed. |

**Already-enum properties confirmed (no action):** `mapping_type`, `combination_type`, `severity` (in 2 tools), `category`, `risk_level`, file `type` in compartmentalized package, `rule_type` (modulo divergence #1).

---

## Section 3 — High-stakes tools (final list)

The prompt nominated 5 tools. Confirming or revising based on three criteria:

1. **Eval-harness coverage** — only `eval_mapping` is wired (`lib/eval/runner.ts:404`). `eval_validation_rule`, `eval_transform`, `eval_nl_to_sql` are reserved enum values but not yet wired. So **`emit_table_mappings`** is the only tool currently covered by the eval harness; description quality affects the eval fixture score directly.

2. **Volume × correctness blast radius** — `emit_table_mappings` is shared by 4 callsites (`mapping_generate`, `mapping_generate_legacy_pair`, plus their two `_repair` retries which become unreachable when the flag is on). Every other tool is used by exactly 1 callsite.

3. **Output-quality elasticity to descriptions** — synthesis tools (mapping, validation, quality detection, intelligence) move more on description quality than glue/document tools (runbook, package, suggestions).

**Confirmed list of 5 high-stakes tools (matches the prompt's nomination):**

1. `emit_table_mappings` — 4-callsite volume + only eval-covered tool. **Highest stakes.**
2. `emit_validation_rule` — synthesis with downstream blocking/warning consequences for migration approval.
3. `emit_quality_issues` — synthesis with verification_sql that runs against customer data; quality threshold decisions.
4. `emit_extracted_patterns` — synthesis feeding the migration intelligence knowledge base; bad patterns pollute future projects.
5. `emit_mapping_suggestion` — per-target suggestion synthesis; affects mapping UX one field at a time.

**Possible swap candidate:** `emit_fix_options` could displace `emit_mapping_suggestion` from the top-5 — fix options run SQL against customer data (higher correctness blast radius than a single per-target suggestion) and the system prompt already encodes ~150 lines of SQL-pattern + cast-safety + window-function guidance that hasn't migrated to the schema. **Recommendation: include `emit_fix_options` in §4 too.** Six high-stakes tools, not five. Below treats it as #6 with abbreviated draft. (Phase B can prioritize 5+1 vs strict 5 based on review.)

---

## Section 4 — Proposed enriched descriptions (high-stakes tools)

Convention: each subsection shows current vs proposed for tool-level + every property. `[NEEDS KAAN INPUT]` flags marked inline. All proposed text is paste-ready for `lib/ai/tool-schemas.ts`.

### 4.1 `emit_table_mappings` — used by `mapping_generate` + `mapping_generate_legacy_pair`

**Tool-level description (current):** *"Emit the structured set of source-to-target table and field mappings produced for the schemas in the prompt. Each entry pairs a source table with a target table and contains all per-field mappings between them. Use bare table and field names (no schema prefixes). Confidence is 0-100 indicating how strongly you believe the mapping holds; reasoning is a short justification a reviewer can audit. Field mappings should appear under the table mapping that owns them; one_to_many and many_to_one mappings use contributing_source_fields/combination_hint/split_hint to express the multi-source/multi-target relationship."*

**Tool-level description (proposed):**

> Emit the structured set of source-to-target table and field mappings produced for the schemas in the prompt. You process ONE source table per request — only emit a `table_mapping` when the current source is the BEST (or strong-secondary) semantic match for a given target. If `<other_source_tables>` lists a clearly-better primary match for some target, omit that target entirely from your output and let the better source claim it in its own batch. Prefer zero-mapping over low-confidence mapping: a wide source whose only field-overlap with a candidate target is `id`/`name`/`created_at` should NOT emit a `table_mapping` to that target.
>
> Lookup/reference tables (narrow code+description shapes — STATUS_CODES, COUNTRY_CODES) map to AT MOST ONE target enumeration table; they MUST NOT map to entity tables (customers, accounts) — that link is established at the field level via FK, not by row-copying. Entity tables (CIF_MASTER, ACCT_MASTER) map to their corresponding entity target only when field overlap is substantial.
>
> Use bare table and field names (no schema prefixes). Multi-source patterns: a `many_to_one` mapping is ONE entry with the primary in `source_field` and the rest in `contributing_source_fields`; a `one_to_many` is SEPARATE entries per target, all sharing the same `source_field`. Direct one-to-one mappings omit `mapping_type` (or set it to `one_to_one`) and never include the multi-field hints.

**Property-level descriptions (proposed):**

The following live on `TABLE_MAPPING_SCHEMA` and `FIELD_MAPPING_SCHEMA` (shared sub-shapes), which in turn back this tool, `EMIT_FIELD_MAPPINGS_TOOL`, and any future per-pair tool.

| Property path | Current | Proposed |
|---|---|---|
| `table_mappings` (top-level) | (none) | `'Array of table-level mappings emitted for the current source table. Empty array is a valid answer when no target table in the prompt is a strong semantic match for this source.'` |
| `TABLE_MAPPING_SCHEMA.source_table` | (none) | `'Bare source table name (e.g., "customers"), not the qualified form ("public.customers"). Must match a source table from the prompt.'` |
| `TABLE_MAPPING_SCHEMA.target_table` | (none) | `'Bare target table name (e.g., "Account"). Must match a target table from the prompt.'` |
| `TABLE_MAPPING_SCHEMA.confidence` | `'Integer 0-100.'` | `'Integer 0-100 representing your confidence the source-to-target table pairing is correct. Use 90-100 for near-certain matches (identical names, same business meaning, substantial field overlap); 75-89 for high-confidence matches (similar names, compatible types, clear business alignment); 50-74 for moderate confidence (partial name match, conversion needed, or ambiguous business meaning); below 50 for low confidence (weak signals, multiple possible targets — usually means you should omit the mapping entirely).'` `[NEEDS KAAN INPUT — confidence calibration]` |
| `TABLE_MAPPING_SCHEMA.reasoning` | (none) | `'Short reviewer-facing justification (1-2 sentences) for WHY this source maps to this target. Cite specific signals: name similarity, field-overlap count, documentation-confirmed business alignment. Avoid generic phrases like "good match" — name the evidence.'` |
| `TABLE_MAPPING_SCHEMA.field_mappings` | (none) | `'Per-field mappings under this table pairing. May be empty when no source field is a confident match for any target field. Multi-source patterns (many_to_one) emit ONE entry per target; multi-target patterns (one_to_many) emit SEPARATE entries per target sharing the same source_field.'` |
| `FIELD_MAPPING_SCHEMA.source_field` | (none) | `'Bare source field name (e.g., "first_name"), not "table.field". For many_to_one, this is the PRIMARY contributing source — the rest go in contributing_source_fields.'` |
| `FIELD_MAPPING_SCHEMA.target_field` | (none) | `'Bare target field name. Must match a field on the target_table named in the parent table_mapping. For one_to_many, each split target gets its own entry with a different target_field.'` |
| `FIELD_MAPPING_SCHEMA.confidence` | `'Integer 0-100.'` | `'Integer 0-100 confidence the source-to-target field pairing is correct. Apply the same calibration tiers as the table-level confidence (90-100 near-certain; 75-89 high; 50-74 moderate; <50 low — usually omit).'` `[NEEDS KAAN INPUT — same calibration question as the table-level]` |
| `FIELD_MAPPING_SCHEMA.reasoning` | (none) | `'1-2 sentence justification: name similarity (e.g., "first_name → FirstName, identical semantics"), type compatibility, value-distribution alignment with documented target picklist, etc.'` |
| `FIELD_MAPPING_SCHEMA.similar_fields_considered` | (none) | `'Optional array of OTHER target field names you considered but rejected for this source (e.g., ["DisplayName", "FullName"]). Aids reviewer audit when the chosen target is not the most obvious one.'` |
| `FIELD_MAPPING_SCHEMA.type_compatibility` | (none) | `'Describe the conversion or validation required (e.g., "VARCHAR → DECIMAL — strip $ and commas, parse to number"; "VARCHAR → BOOLEAN — normalize Y/N/yes/no/1/0 to TRUE/FALSE"; "VARCHAR(200) → VARCHAR(120) — truncation needed, 12 values exceed limit"). When no conversion is needed, write "direct compatible — no conversion needed".'` |
| `FIELD_MAPPING_SCHEMA.needs_transformation` | (none) | `'TRUE if ANY of: data type conversion, value translation (Won → Closed Won), format standardization, ID format change, boolean normalization, casing change, truncation, field combination/splitting, or FK reformat (cascading from a referenced PK transformation). FALSE for naming-convention-only differences (snake_case ↔ camelCase) when values pass through unchanged, or for compatible type-aliasing (TEXT ↔ VARCHAR).'` |
| `FIELD_MAPPING_SCHEMA.mapping_type` | (none) | `'Default omitted (one-to-one). Set to "many_to_one" when multiple source fields combine into one target (first+last → full_name). Set to "one_to_many" when ONE source splits into multiple targets (full_name → first_name + last_name); each split emits a SEPARATE field_mapping entry sharing the same source_field.'` |
| `FIELD_MAPPING_SCHEMA.contributing_source_fields` | (none) | `'Required when mapping_type === "many_to_one". Array of ADDITIONAL source field names beyond source_field. Do NOT repeat the primary source_field in this list. Omit this property for one_to_one and one_to_many.'` |
| `FIELD_MAPPING_SCHEMA.combination_hint` | (none) | `'Required when mapping_type === "many_to_one". Brief description of how to combine (e.g., "Concatenate with space separator", "first_name + " " + last_name").'` |
| `FIELD_MAPPING_SCHEMA.split_hint` | (none) | `'Required when mapping_type === "one_to_many". Brief description of which part to extract (e.g., "Extract first name (substring before first space)", "Extract street component before comma"). Each one_to_many entry gets its own split_hint per target.'` |

### 4.2 `emit_validation_rule` — used by `validation_rule_from_nl`

**Tool-level description (current):** *"Emit a structured validation rule based on the natural-language description in the prompt. rule_type is one of the canonical types listed in the system prompt (not_null, unique, min_value, max_value, min_length, max_length, regex, allowed_values, range, date_after, date_before). rule_config's shape depends on rule_type — use the templates the system prompt enumerates. severity is 'blocking' (rule failures stop the migration) or 'warning' (informational only)."*

**Tool-level description (proposed):**

> Emit a structured validation rule derived from the user's natural-language description. The rule will run against staged source data — never against production source — and its severity drives whether failures block migration approval or surface as warnings only. Choose `rule_type` to be the most specific match for the user's intent: prefer `regex` over `allowed_values` only when the value space is genuinely unbounded; prefer `range` over the separate `min_value`/`max_value` rules when both bounds apply; prefer `date_after`/`date_before` over a custom regex when the user describes a date threshold.
>
> Each `rule_type` has a fixed `rule_config` shape — see the templates in the system prompt. The downstream `validateRuleConfig` validator will reject any rule whose config doesn't match the type's required keys (e.g., `regex` requires `pattern`; `range` requires `min` and `max` with `min ≤ max`). Severity choice is the most consequential decision: pick `blocking` only when the rule's failure represents data that cannot be loaded into the target without corruption or system error; pick `warning` for everything else, including business-rule violations the migration team may choose to accept on a case-by-case basis.

**Property-level descriptions (proposed):**

| Property | Current | Proposed |
|---|---|---|
| `name` | `'Short rule name.'` | `'Short rule name (≤ 60 chars), suitable for a UI list item. Phrase as a positive constraint ("Email format valid", not "Email broken"). Title Case.'` |
| `description` | `'What this rule checks, in plain English.'` | `'Plain-English description of what the rule checks (1-2 sentences). Used in the validation results UI; should make sense to a non-technical reviewer. Reference the specific value(s) or pattern when helpful (e.g., "Field must be a valid email address matching the RFC 5322 simplified pattern").'` |
| `rule_type` | (none — enum-only) | `'Canonical rule type. The rule_config shape MUST match the per-type template in the system prompt. Use the most-specific type that captures the user intent — prefer "range" over separate min_value+max_value, prefer "allowed_values" over "regex" when the value set is small and known, prefer "date_after"/"date_before" over regex for date thresholds.'` `[NEEDS KAAN INPUT — see DIVERGENCE in §2 #1: should custom_sql be added to this enum?]` |
| `rule_config` | `'Configuration whose shape depends on rule_type; see the system prompt for the per-type templates.'` | `'Per-type configuration object. The keys depend on rule_type: not_null/unique → {} (empty); min_value → { min: number }; max_value → { max: number }; min_length/max_length → { min_length / max_length: integer }; regex → { pattern: non-empty string, valid JS RegExp }; allowed_values → { values: non-empty string[] }; range → { min: number, max: number, min ≤ max }; date_after/date_before → { date: ISO date string parseable by Date.parse }. The downstream validateRuleConfig will reject mismatches at insert time.'` |
| `severity` | (none — enum-only) | `'"blocking" means the migration cannot proceed without the rule passing — failures will corrupt target data or violate target schema constraints. "warning" means the rule failure is informational and the migration team may accept it. When in doubt, prefer "warning"; reserve "blocking" for hard-stop conditions like missing required PKs, FK orphans against an explicitly-required parent, or NOT NULL violations on target-required fields.'` `[NEEDS KAAN INPUT — severity calibration: which user inputs should auto-resolve to blocking vs warning? Should the model lean conservative (default to warning) or lean strict (default to blocking)?]` |

### 4.3 `emit_quality_issues` — used by `quality_detection_ai`

**Tool-level description (current):** *"Emit data-quality issues newly identified in the table context provided in the prompt. Skip issues already present in `<existing_issues>`. Each verification_sql must be a SELECT that includes a WHERE table_id filter (using the table_id supplied in the prompt). severity is 'blocking' (cannot proceed without resolution) or 'warning' (informational). estimated_count is a rough integer estimate of affected rows. cross_field is set when the issue spans multiple fields."*

**Tool-level description (proposed):**

> Emit additional data-quality issues that the automated quality rules missed. Focus on issues that require cross-field reasoning, business-rule application, or documentation-driven knowledge that pure-statistical detection can't surface — automated rules already catch the obvious cases (uniformly null columns, max-length violations, regex mismatches against an explicit pattern), so don't duplicate them.
>
> NEVER duplicate an issue already listed in `<existing_issues>`. Only propose issues you have HIGH confidence exist based on the field profiles, sample values, and documented business rules in the prompt. Each `verification_sql` MUST be a SELECT COUNT(*) against the `data_rows` table with a `WHERE table_id = '<the exact table_id from the prompt>'` filter and JSONB extraction (`row_data->>'field_name'`); the safety validator at `isVerificationSQLSafe` rejects anything else (DML, DDL, joins to system tables, missing table_id filter). If you cannot write a safe verifiable SQL query for an issue, omit the issue entirely.
>
> Cross-field issues (e.g., "amount is null when stage = Closed Won") require both `field_name` and `cross_field`. Single-field issues only set `field_name`. Estimate counts using value distributions in the prompt, or use round numbers when uncertain — `verification_sql` will produce the exact count later.

**Property-level descriptions (proposed):**

| Property | Current | Proposed |
|---|---|---|
| `proposed_issues` | (none) | `'Array of newly-identified data-quality issues. Empty array is the correct answer when the automated rules already caught everything — DO NOT pad the response with low-confidence guesses.'` |
| `field_name` | (none) | `'Bare source field name the issue primarily relates to. Must match a field listed in the table context in the prompt.'` |
| `cross_field` | (none) | `'Optional second field name when the issue spans two fields (e.g., "amount" with cross_field "stage" for "amount null when stage closed"). Omit for single-field issues.'` |
| `description` | (none) | `'Plain-English description of the issue (1-2 sentences). Should explain what is wrong AND why it matters, in language a migration reviewer can understand. Example: "Null amount on closed deals — records have stage IN (\\"Won\\", \\"Closed Won\\") but amount is NULL or empty".'` |
| `severity` | (none — enum-only) | `'"blocking" if the data WILL fail to load or cause data corruption (e.g., NOT NULL violation on a required target field, FK orphan against a hard-required parent). "warning" if the issue needs human review but doesn\'t hard-stop the migration (e.g., suspicious value distribution, possible business-rule violation, format inconsistency that target tolerates). When in doubt, prefer "warning".'` `[NEEDS KAAN INPUT — severity rubric: should an issue be "blocking" if business documentation says it must be fixed but target schema technically tolerates it? E.g., docs say "Tax ID required for all customers" but target column is nullable.]` |
| `estimated_count` | `'Non-negative integer.'` | `'Rough estimate of how many rows are affected, derived from the value distributions/null rates in the prompt. Round numbers (5, 50, 500) are fine when uncertain — verification_sql produces the exact count downstream. Set to 0 only when you are confident the issue affects zero rows (in which case omit the issue entirely).'` |
| `verification_sql` | (none) | `'A SELECT COUNT(*) query against the data_rows table that confirms the exact affected-row count. MUST include WHERE table_id = \\'<the table_id from the prompt>\\'. MUST use JSONB extraction (row_data->>\\'field_name\\'). MUST be SELECT-only (no UPDATE/DELETE/DDL/joins to system tables). Use TRIM/LOWER/regex inside the WHERE to handle the format inconsistencies you are testing for.'` |
| `reasoning` | (none) | `'1-2 sentence justification anchored in the prompt context (cite the doc passage, the field profile statistic, or the business rule that surfaced this issue). The reviewer reads this to decide whether to act on the proposed issue.'` |

### 4.4 `emit_extracted_patterns` — used by `migration_intelligence`

**Tool-level description (current):** *"Emit generalizable migration patterns extracted from the completed project context in the prompt. Wrap your patterns array under the \"patterns\" property of the tool input. Patterns must be reusable across different source/target systems — do not embed project-specific names. Generate 8-15 patterns; prioritize transformation_recipe and data_quality_pattern categories. Each pattern_config follows the per-category templates in the system prompt."*

**Tool-level description (proposed):**

> Emit generalizable migration patterns extracted from the completed project's transformations, quality issues, and documentation. Patterns flow into the migration intelligence knowledge base where they prime FUTURE projects' Claude prompts as reference context — they MUST be reusable across DIFFERENT source/target systems and MUST NOT embed project-specific table or field names.
>
> Generate 8-15 patterns, weighted toward `transformation_recipe` and `data_quality_pattern` categories (those are the most actionable for future projects). Include 1-2 `domain_knowledge` entries when the project surfaces non-obvious entity-model facts (e.g., "legal ELM systems link timekeepers to organizations through matters"); include 1 `source_system_hint` when the project reveals systematic characteristics of the source platform that will be encountered again (e.g., "legacy CRM stores all currency as VARCHAR with format inconsistencies"). Skip patterns that any LLM already knows ("dates should be valid"); focus on what was genuinely LEARNED from this project's outcomes.
>
> Each `pattern_config` follows a per-category template (see system prompt) — `transformation_recipe` carries `pattern_type` + `source_indicators` + `target_indicators` + `approach` + `edge_cases`; `data_quality_pattern` carries `pattern_type` + `detection_method` + `typical_rate_percent` + `common_causes`; etc. The wrapping `pattern_type` discriminator is what enables future projects to retrieve relevant patterns — don't omit it.

**Property-level descriptions (proposed):**

| Property | Current | Proposed |
|---|---|---|
| `patterns` | (none) | `'Array of 8-15 migration patterns. Empty array is acceptable for projects with no novel patterns to share, but most completed projects yield several extractable patterns.'` |
| `category` | (none — enum-only) | `'Pattern category, picks the per-category template that pattern_config follows. transformation_recipe = a SQL/transformation approach; data_quality_pattern = a detection+typical-rate+causes triple; domain_knowledge = an entity-model or load-order insight; source_system_hint = systematic characteristics of a source platform.'` |
| `title` | `'Short descriptive title (≤ 60 chars).'` | `'Short descriptive title (≤ 60 chars). Phrase as a generalizable lesson, not a project-specific outcome — "Strip currency formatting before DECIMAL cast" beats "Migrating customers.annual_revenue to Account.AnnualRevenue".'` |
| `pattern_description` | `'2-3 sentence description for prompt injection.'` | `'2-3 sentence description suitable for direct injection into a future Claude prompt as reference context. Write in second-person imperative when describing actions ("strip currency formatting from VARCHAR before casting to DECIMAL"); first-person passive otherwise. Do not name specific tables/fields/customers.'` |
| `pattern_config` | `'Structured metadata; per-category shape per system prompt.'` | `'Structured metadata. Shape varies by category: transformation_recipe → { pattern_type, source_indicators[], target_indicators[], approach, edge_cases[] }; data_quality_pattern → { pattern_type, detection_method, typical_rate_percent, common_causes[] }; domain_knowledge → { domain, entity_patterns[], load_order_hint }; source_system_hint → { system_type, common_characteristics[], typical_issues[] }. The pattern_type field (or domain/system_type for the latter two) is the retrieval key — use a snake_case canonical phrase (e.g., currency_cleanup, orphaned_foreign_keys).'` `[NEEDS KAAN INPUT — pattern_type vocabulary: should there be a curated list of canonical pattern_type strings the model picks from, to keep retrieval consistent across projects? Or is per-project freeform OK?]` |
| `tags` | (none) | `'Array of relevant lowercase tags for retrieval (e.g., ["currency", "decimal", "varchar", "type-cast"]). Use generic vocabulary that future projects will share — not project-specific names. 3-6 tags is typical.'` |

### 4.5 `emit_mapping_suggestion` — used by `mapping_suggest`

**Tool-level description (current):** *"Emit a single mapping suggestion for the target field in the prompt. Pick one or more source fields that all belong to the SAME source table; cross-table sources are not allowed. Use combination_type=\"single\" iff exactly one source field is named, otherwise \"concat_space\" or \"concat_comma\". Confidence is 0-100. Rationale is a brief explanation, ≤ 280 characters."*

**Tool-level description (proposed):**

> Emit a single mapping suggestion for the ONE target field named in the prompt. The user is asking "what should this target field map FROM?" — pick the source field (or fields) from the SAME source table that best fills that target. Cross-table sources are not allowed in this version; if no field on the supplied source table is a good match, emit a low-confidence single-field guess rather than failing the call (the user will reject it manually).
>
> Use `combination_type = "single"` when exactly one source field maps; use `concat_space` or `concat_comma` when 2+ source fields combine into the target (e.g., first_name + last_name → full_name). Multi-source `concat_*` is the same many-to-one shape used by `emit_table_mappings` — same rules apply (don't repeat the primary source name; pick the most-specific combination_type for the data shape). `rationale` should be a SHORT (≤ 280 chars) reviewer-facing explanation citing the signals you used.

**Property-level descriptions (proposed):**

| Property | Current | Proposed |
|---|---|---|
| `source_field_names` | `'Bare field names (no table prefix), all from the same source table.'` | `'Array of bare source field names (no "table.field" prefix), all from the SAME source table. The order matters for concat combination types — first element is the primary contributor (the conceptual "first half" for concat_space, etc.).'` |
| `combination_type` | (none — enum-only) | `'"single" iff source_field_names has exactly one element; otherwise "concat_space" (space-delimited concatenation) or "concat_comma" (comma-delimited). Pick concat_space for human names ("first last"), concat_comma for address fragments ("street, city, state").'` |
| `confidence` | `'Integer 0-100.'` | `'Integer 0-100 confidence in this mapping. Apply the same calibration as emit_table_mappings: 90-100 near-certain, 75-89 high confidence, 50-74 moderate, <50 low — emit a low-confidence guess rather than failing the call when no good match exists, but make the rationale flag the uncertainty.'` `[NEEDS KAAN INPUT — same calibration question as emit_table_mappings]` |
| `rationale` | `'Brief explanation, ≤ 280 characters.'` | `'Reviewer-facing explanation (≤ 280 chars) of the signals you used (name similarity, type compatibility, value-distribution match, documentation alignment). When confidence is below 75, explicitly note WHY you are uncertain in the rationale.'` |

### 4.6 `emit_fix_options` — used by `quality_fix_options` *(see §3 swap rationale)*

**Tool-level description (current):** *"Emit 2-3 fix options for the data-quality issue described in the prompt. Each option is a complete fix proposal: label, plain-English description, the exact SQL to execute (must include WHERE table_id = '<uuid>'), the tradeoff, the per-fix downstream impact, a risk_level (low/medium/high), and an estimate of rows affected. root_cause and downstream_impact at the top level explain why the issue exists and what breaks if it is left unfixed."*

**Tool-level description (proposed):**

> Emit 2-3 fix options for the data-quality issue described in the prompt. Each fix option is a complete, executable proposal — the SQL must run against `data_rows` JSONB columns with a `WHERE table_id = '<the exact uuid from the prompt>'` anchor; the validator REJECTS any SQL with DDL keywords (DROP/ALTER/CREATE/TRUNCATE), references to tables other than `data_rows`, or `LIMIT`/`FETCH FIRST`/`OFFSET` clauses. ALWAYS use the JSONB extraction operator `row_data->>'FieldName'`; for missing fields, use `row_data || '{...}'::jsonb`.
>
> Numeric casts MUST be regex-guarded — a bare `(row_data->>'X')::numeric` crashes the entire UPDATE if any non-numeric row exists. Date-format fixes MUST use the CASE+regex pattern with NULL-safe outer CASE (see system prompt) — never wrap a parse expression directly in `to_jsonb()`. Window functions are not allowed in `UPDATE SET` — use a CTE.
>
> Provide options spanning the risk spectrum: at least one low-risk option (e.g., flag for human review by adding a marker field) and one moderate or aggressive option (e.g., apply a default value or remove rows). The reviewer chooses based on the project's tolerance for data loss vs review burden.

**Property-level descriptions (proposed):**

| Property | Current | Proposed |
|---|---|---|
| `root_cause` | (none) | `'Plain-English explanation (1-2 sentences) of WHY this quality issue exists in the source data. Reference the specific upstream pattern when known (e.g., "legacy import in 2018 wrote NULLs for fields the new schema requires NOT NULL").'` |
| `downstream_impact` | (none) | `'What BREAKS in the migration if this issue is not fixed. Be specific about target tables and approximate record counts (e.g., "Account inserts will fail for 47 rows due to NOT NULL constraint on AnnualRevenue").'` |
| `fix_options` | (none) | `'Array of 2-3 complete fix proposals at varying risk levels. Each option must be independently executable — the user picks ONE to apply.'` |
| `fix_options.items.label` | (none) | `'Short option name (≤ 50 chars), suitable for a UI button or radio label. Phrase as the action the option takes ("Filter out null records", "Default missing values to N/A").'` |
| `fix_options.items.description` | (none) | `'Plain-English (1-2 sentence) description of what the fix does, written for a non-SQL reviewer. Match the verb in the label ("This option deletes rows where amount is NULL...").'` |
| `fix_options.items.sql` | (none) | `'Exact executable SQL. MUST include WHERE table_id = \\'<the table_id from the prompt>\\'. MUST use row_data->>\\'X\\' for field access. MUST regex-guard any numeric cast. MUST NOT use LIMIT/FETCH/OFFSET (the validator rejects these — fixes apply to all matching rows or to none).'` |
| `fix_options.items.tradeoff` | (none) | `'1-2 sentence statement of what the option gains AND loses (e.g., "Gains: zero data loss, all rows preserved. Loses: introduces N/A placeholder values that may need a second pass.").'` |
| `fix_options.items.downstream_impact` | (none) | `'How this specific fix affects later migration steps (e.g., "After this fix, Account inserts succeed; the 47 N/A annual_revenue values will route to a target review queue").'` |
| `fix_options.items.risk_level` | (none — enum-only) | `'"low" = reversible flag/marker change with no data loss; "medium" = data update preserving row identity (default values, format normalization); "high" = row deletion or destructive overwrite. Always include at least one "low" option per response so the reviewer has a safe default.'` `[NEEDS KAAN INPUT — risk-level rubric: where exactly is the line between "medium" and "high"? E.g., does in-place value normalization that loses original data count as medium or high?]` |
| `fix_options.items.estimated_rows_affected` | `'Non-negative integer.'` | `'Rough integer estimate of rows the SQL touches, based on the issue\'s estimated_count and any narrowing in the WHERE clause. Round numbers fine when uncertain.'` |

---

## Section 5 — Pattern recommendations (8 medium/lower-stakes tools)

For each: brief gap audit + 1-2 example enriched descriptions to set the pattern. Phase B applies the pattern to draft full text.

### 5.1 `emit_field_mappings` — `mapping_suggest_legacy_bulk`

**Audit:** `field_mappings` (top-level) has no description. Reuses `FIELD_MAPPING_SCHEMA`, so all of §4.1's field-level proposals apply transitively.

**Pattern:** the only addition needed is a tool-level + top-level array description that names the bulk-suggest context.

**Examples:**
- Tool-level (proposed): *"Emit field-level mapping suggestions for the unmapped source/target field pairs in the prompt. The table-mapping context is already established by the caller; you are filling the gaps. Each mapping must use a `source_field` from the supplied unmapped-source list and a `target_field` from the unmapped-target list — do not invent fields. Same multi-source/multi-target patterns and same confidence calibration apply as in `emit_table_mappings`."*
- `field_mappings` property (proposed): *"Array of field-level mappings, one per target field you can confidently fill. Empty array is acceptable when no source field on this pairing is a good match for any unmapped target."*

### 5.2 `emit_parsed_ddl` — `ddl_parsing`

**Audit:** Tool-level description is reasonable but doesn't reference dialect-handling guidance from `DDL_PARSE_SYSTEM`. Fields lack descriptions entirely.

**Pattern:** mirror the system prompt's per-field guidance into property descriptions. Tighten `checkConstraint` to a `oneOf` discriminated union (per §2 #3, with the caveat about strict-mode `oneOf` support).

**Examples:**
- `dataType` property (proposed): *"Canonical type name with precision/scale where present (e.g., VARCHAR(255), DECIMAL(18,2), TIMESTAMPTZ). Preserve dialect-specific spellings when the source dialect is named in the DDL (e.g., NVARCHAR2 for Oracle); use the most-portable equivalent only when the source dialect is unstated."*
- `checkConstraint` property (proposed): *"One of four discriminated shapes: { type: 'in_list', allowedValues: string[], raw: string } | { type: 'regex', pattern: string, raw: string } | { type: 'range', min?: number, max?: number, raw: string } | { type: 'custom', raw: string }. Use 'custom' for any constraint you cannot decompose into the structured forms. Set to null when no CHECK constraint exists."* `[NEEDS KAAN INPUT — see §2 #3 regarding strict-mode oneOf]`

### 5.3 `emit_schema_corrections` — `schema_enrichment`

**Audit:** Tool-level desc is reasonable. Fields lack descriptions; `inferred_type` should be tightened to an enum (per §2 #2). The `corrections.corrections` nested-property naming is awkward — Phase B may consider renaming, but that's a structural change beyond this audit.

**Pattern:** add property descriptions that mirror the system prompt's per-field-attribute guidance.

**Examples:**
- `field_name` property (proposed): *"Bare source field name being corrected. Must match a field listed in the inferred-schema portion of the prompt — do NOT correct fields that aren't in the prompt."*
- `corrections.is_foreign_key` property (proposed): *"Set to true ONLY when the documentation identifies an FK relationship AND the referenced parent table is also present in the inferred schema. When set to true, you MUST also populate fk_reference (e.g., \"BRANCH_INFO.BRANCH_NO\"); a true value with a null fk_reference is a no-op downstream and is rejected."*

### 5.4 `emit_table_matches` — `schema_merge_ai_match`

**Audit:** Tool-level desc names the precision-over-recall posture, which is good. Property descriptions are missing on the 3 fields.

**Pattern:** reinforce the precision-bias in the property descriptions.

**Examples:**
- `matches` property (proposed): *"Array of confident DDL-to-existing-table matches. Empty array is the right answer when no DDL table has a strong field-overlap signature with any unmatched existing table — the merge layer above this tool is precision-biased and prefers no match over a wrong match."*
- `existing_table_id` property (proposed): *"UUID of the existing table from the supplied unmatched-existing list. Must be a UUID present in the prompt — do not invent IDs. Each existing_table_id may appear at most once across all matches."*

### 5.5 `emit_migration_runbook` — `outputs_migration_runbook`

**Audit:** This is the largest schema (~25 nested properties). Tool-level desc is adequate but doesn't propagate the volume-guidance from the system prompt (e.g., "8-12 checklist items", "ALL table mappings", "5-8 validation criteria"). Field descriptions are entirely absent.

**Pattern:** mirror the per-section volume + style guidance from `RUNBOOK_SYSTEM_PROMPT` and the user-message JSON template into the tool-schema property descriptions. Especially valuable to encode "skip simple direct-copy mappings" and "Title Case for action verbs in checklist items".

**Examples:**
- `executiveSummary` property (proposed): *"3-4 sentence summary of the migration scope and readiness. Audience is a Fortune-500 implementation team. Cover: source/target systems, total table count, total record count, overall readiness assessment. Avoid jargon; this section is read by non-technical stakeholders."*
- `preMigrationChecklist` property (proposed): *"8-12 actionable checklist items. Each item starts with a verb (\"Verify all blocking quality issues are resolved\"; NOT \"Blocking issues should be resolved\"). Items should be independently checkable — no \"and\" combining unrelated checks."*

### 5.6 `emit_compartmentalized_package` — `outputs_execution_package_compartmentalized` *(streaming, used in 12.3)*

**Audit:** Property descriptions absent. The streaming context doesn't change description authoring — same patterns apply.

**Pattern:** name each file `type` enum value's purpose explicitly, since the type drives downstream packaging.

**Examples:**
- `files` property (proposed): *"Array of files comprising the multi-file execution package. Order matters within table_script files (load_order resolves dependencies); the runbook (checklist), validation, promote, and rollback files run in that order around the table_script load."*
- `type` property (proposed): *"File type drives downstream packaging. \"checklist\" = pre-execution sanity checks (one file per package); \"table_script\" = SQL to load one target table (one per table, with load_order); \"validation\" = post-load checks (one file per package); \"promote\" = post-validation hand-off SQL; \"rollback\" = reversal SQL paired with promote."*

### 5.7 `emit_query_suggestions` — `nl_suggest_queries`

**Audit:** Tool-level description encodes the volume + diversity guidance (4 suggestions, different patterns, ≤ 80 chars, at least one data-quality query). Top-level `suggestions` carries a description; the inner `items: { type: 'string' }` does not.

**Pattern:** lowest-stakes tool; minimal additions. Add an `items` description naming the per-suggestion constraints.

**Example:**
- `items` property on `suggestions` (proposed): *"One plain-English question (≤ 80 chars). Phrase as a question or imperative the user might ask of source data — \"What's the average order value by month?\", \"Which contacts have invalid email formats?\". Avoid SQL keywords; the downstream NL-to-SQL converter handles the translation."*

### 5.8 `emit_validation_rule` — already covered in §4.2

### *(8 tools accounted for: 5.1-5.7 + the §4 high-stakes set covers everything except `emit_validation_rule` which is in §4.2 and is therefore not duplicated here.)*

---

## Section 6 — Domain-expertise gaps requiring founder input

Consolidated `[NEEDS KAAN INPUT]` flags from §4 + §5, grouped by topic.

### 6.1 Confidence calibration (most cross-cutting)

Affects: `emit_table_mappings.TABLE_MAPPING_SCHEMA.confidence`, `FIELD_MAPPING_SCHEMA.confidence`, `emit_mapping_suggestion.confidence`.

The current MAPPING_GENERATION_SYSTEM_PROMPT documents tiers (90-100 / 75-89 / 50-74 / <50). I've propagated those into the proposed property descriptions as the default. **Open question for Kaan:**

> Does the 4-tier calibration match how Settle's customer base actually uses confidence in the mapping review UI? Specifically:
> - Should 90-100 require BOTH name + type match, or is name match alone sufficient?
> - At what confidence threshold does the UI auto-approve vs require manual review? (If there's an auto-approval threshold downstream, the schema description should align the AI's "near-certain" tier with that threshold.)
> - Below 50 — should the AI emit anyway with a flag, or is "omit entirely" the correct posture? Currently mixed (table-level says "omit", suggestion says "emit with low-confidence flag").

### 6.2 Severity rubric (validation rules + quality issues)

Affects: `emit_validation_rule.severity`, `emit_quality_issues.severity`.

The proposed text leans conservative ("when in doubt prefer warning"). **Open question for Kaan:**

> What's the right default posture for severity when the user's natural-language description is ambiguous?
>
> Specific edge cases:
> - Business documentation says a field is "required" but the target schema column is technically nullable — is that **blocking** (business rule violated) or **warning** (target tolerates)?
> - User says "phone number must be valid" — does an invalid format auto-resolve to **blocking** or **warning**?
> - Cross-field consistency rules ("close_date must be after created_date") — is the severity domain-specific (some customers care, others don't) or should it default to **warning** so the migration team can decide per-issue?

### 6.3 Risk-level boundaries (fix options)

Affects: `emit_fix_options.fix_options.items.risk_level`.

The proposed text uses: low = flag/marker change, medium = in-place update preserving rows, high = deletion. **Open question for Kaan:**

> Where's the boundary between **medium** and **high** in Settle's posture?
>
> - In-place numeric normalization (negative revenue → absolute value) — loses original sign. Medium or high?
> - Casing normalization (john → John for proper-name fields) — loses original casing. Medium or high?
> - Default-value fill for missing required fields — substitutes data that wasn't there. Medium or high?
>
> If there's an existing internal customer-facing rubric, the schema description should mirror it verbatim.

### 6.4 Pattern vocabulary (migration intelligence)

Affects: `emit_extracted_patterns.pattern_config`.

**Open question for Kaan:**

> Should there be a curated, growing list of canonical `pattern_type` strings (e.g., a constants file `lib/ai/canonical-patterns.ts`) that the model picks from, to keep retrieval consistent across projects? Or is per-project freeform (current state) the right design?
>
> The tradeoff: curated list improves retrieval precision (future projects find prior patterns reliably) but requires maintenance + editorial judgment about what counts as a canonical pattern. Freeform avoids the maintenance overhead but risks pattern fragmentation (one project says `currency_cleanup`, another says `currency_strip_format`, retrieval misses the link).

### 6.5 Validation rule type completeness (DIVERGENCE)

Affects: `emit_validation_rule.rule_type` enum.

**Discrepancy:** the schema enumerates 11 rule_types. `validateRuleConfig` in `lib/actions/validation-rules.ts:119-123` accepts a 12th value, `custom_sql`, with config `{ sql: string }` (must be a non-empty SELECT-only statement). Either:

- The schema is missing `custom_sql` — Phase B should add it AND describe the per-type config as `{ sql: non-empty SELECT-only string }`.
- Or `custom_sql` is dead code in `validateRuleConfig` and should be removed.

**Open question for Kaan:** is `custom_sql` a supported user-facing rule type? If yes, fix the schema; if no, remove from the validator.

### 6.6 Cross-cutting: does the Phase B description language need to match Settle's customer-facing voice?

Schema descriptions are not user-facing — the model reads them. But several proposed descriptions reuse customer-facing UI language ("Fortune 500 implementation team", "non-technical reviewer"). **Open question for Kaan:**

> Should the schema descriptions stay model-facing (terse, technical, decision-criteria-focused) or pull in some Settle voice (e.g., "Fortune 500 enterprise migrations")?
>
> My recommendation is **model-facing**: descriptions are one of the largest input-token costs in the request and should be high-information-density. Customer voice belongs in system prompts and UI copy. But this is a style call worth confirming.

---

## Section 7 — Phase B implementation scope

### 7.1 Files modified

- `lib/ai/tool-schemas.ts` — add tool-level + per-property `description` strings; tighten 2-3 enums per §2; possibly add `custom_sql` to `rule_type` per §6.5.
- `tests/lib/tool-schemas.test.ts` — extend the existing structural-invariant tests to also assert that every property has a description (or explicitly justify the exception). Add an enum-presence test for the tightened fields.

No callsite files modified — H1 design is preserved; system prompts in callsites stay unchanged. Description enrichment is a tool-schema-only change.

### 7.2 Estimated LOC delta

| Change | LOC |
|---|---|
| 5 high-stakes tools, full property descriptions | ~+150 |
| 6+ medium-stakes tools, pattern-driven property descriptions | ~+80-120 |
| Enum tightening (3 candidates) | ~+15 |
| Test additions | ~+30 |
| **Total** | **~+275-315** |

Net additive — no deletions. Descriptions count toward input tokens; PR 12 §9.2 probe (deferred from PR 12.1) should be re-run AFTER Phase B to confirm token-count overhead is acceptable. Naive estimate: ~150-300 extra tokens per request that uses one of these tools, which on Opus 4.7 is ~$0.0007-0.0015 per call.

### 7.3 Verification gates

1. `pnpm tsc --noEmit` — clean (descriptions are strings, can't introduce type errors)
2. `pnpm vitest run` — full suite passes; new test invariants for description presence + enum tightening pass; baseline 2969 + ~3-5 new = ~2972-2974 tests.
3. `AI_PHASE_2_ENABLED=1 pnpm eval mapping --dataset _fixture --smoke` — must still score 1.000. Cost expected to rise modestly from $0.0377 → ~$0.04 due to extra description tokens; flag if 2× off.
4. **Optional pre-commit Anthropic API smoke** for the schema-shape changes (tightened enums + `custom_sql` + `oneOf` if used for `checkConstraint`). The strict-mode `oneOf` support question (§2 #3) is the load-bearing uncertainty — a single $0.001 probe call answers it before Phase B commits.
5. Heritage flag-OFF integration test — runs unchanged. Description changes only affect flag-ON path; legacy text path is preserved by H1.

### 7.4 Sequencing recommendation

**Phase B-1** (cheap, mechanical): apply all property descriptions for the 6 §4 tools + the 7 §5 tools using the agreed text. Single commit. ~+250 LOC. Verification: tsc, vitest, eval flag-ON smoke (~$0.04).

**Phase B-2** (needs probe): apply the enum tightenings — `inferred_type` enum, possible `checkConstraint` oneOf. Run the strict-mode oneOf probe first; commit once the API accepts the schema shape. ~+25 LOC.

**Phase B-3** (resolves DIVERGENCE): based on Kaan's answer to §6.5, either add `custom_sql` to the rule_type enum and document the `rule_config.sql` shape, or remove the dead branch from `validateRuleConfig`. ~+5-10 LOC either way.

Land all three in the same PR (it's still a small, focused PR), but stage the commits so the probe-dependent change is isolated.

---

## What's NOT in this investigation (out of scope)

- Editing `lib/ai/tool-schemas.ts` (Phase B work)
- Editing callsite files (none required for description enrichment)
- Editing system prompts in callsites (separate concern; H1 design preserves them — but future PR could migrate guidance from prompts into schemas to reduce duplication, freeing prompt tokens for caching)
- LLM calls (this audit is read-only; spend cap is $0)
- Committing this investigation doc (Phase B PR will pick it up alongside the code edits)

## DIVERGENCE callout

Surfaced one structural divergence between the schemas and the consuming code: `emit_validation_rule.rule_type` enum has 11 values; `validateRuleConfig` accepts 12. Documented in §2 #1 and §6.5. Phase B resolves once Kaan picks a direction.

*End of Phase A audit.*
