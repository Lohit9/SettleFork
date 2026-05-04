/**
 * Tool schemas for the Phase 2 PR 12 tool-use migration.
 *
 * Each callsite that previously parsed prose JSON now (when
 * `AI_PHASE_2_ENABLED=1`) passes one of these tools to `callLLM` and
 * reads the schema-validated input back via `result.toolUse.input`.
 *
 * One tool per callsite; multi-tool flows are reserved for Phase 3+.
 *
 * The tool `description` is what the model sees when deciding what to
 * emit. PR 12.1.5 enriched these to encode decision criteria, edge
 * cases, and volume guidance — they are model-facing high-information-
 * density text, not customer-facing copy. The system prompts of the
 * consuming callsites remain unchanged (the H1 flag-conditional design
 * preserves the legacy text path).
 *
 * Anthropic constraint: `input_schema.type` MUST be `'object'`. Tools
 * whose underlying contract is a top-level array (migration_intelligence,
 * nl_suggest_queries) wrap the array under a stable property name
 * (`patterns`, `suggestions`) — see the per-tool comments below.
 *
 * Strict mode: every tool sets `strict: true`, and every `type:'object'`
 * schema declares `additionalProperties` explicitly. This is Anthropic's
 * documented requirement for strict-mode tools — without it the API
 * rejects with "For 'object' type, 'additionalProperties' must be
 * explicitly set to false". Strict mode is Settle's API-boundary
 * deterministic-validation layer (per the product principle "AI
 * proposes → Deterministic validates → Human approves"); it catches
 * missing required fields, extra fields, and type drift before any
 * downstream consumer sees the response.
 *
 *   additionalProperties: false — used UNIFORMLY across every nested
 *     object schema in this file. Path 2 PR 1 surfaced that Anthropic
 *     strict mode rejects the open-shape variant of additionalProperties
 *     (HTTP 400 on Opus 4.7 with strict tools — Anthropic\'s error
 *     message instructs setting additionalProperties to false). PR 12.1.5
 *     didn't surface this because its flag-ON smoke only exercised
 *     EMIT_TABLE_MAPPINGS_TOOL; Path 2 PR 1 was the first flag-ON
 *     exercise of EMIT_VALIDATION_RULE_TOOL.
 *
 *     Three previously free-form objects whose shape varies by sibling
 *     discriminator (`rule_config` per `rule_type`; `pattern_config`
 *     per `category`; `checkConstraint` per `type`) are now expressed
 *     as enumerated-optional-keys objects: the schema lists every
 *     possible key across all discriminator values with
 *     additionalProperties: false; the system prompt + container
 *     description + per-key descriptions are authoritative for which
 *     subset to populate per discriminator. Loses some schema-level
 *     discriminator specificity (the schema cannot reject "wrong key
 *     for this discriminator"); the downstream validator
 *     (validateRuleConfig in lib/actions/validation-rules.ts) catches
 *     that at insert time for rule_config.
 *
 *     Future probe: does Anthropic strict mode accept JSON Schema
 *     if/then/else? If yes, a follow-up PR can re-tighten rule_config
 *     and pattern_config and checkConstraint to express
 *     per-discriminator constraints properly. Probe cost ~$0.001.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { ALL_CANONICAL_PATTERNS } from './canonical-patterns'

// Build the canonical-pattern bullet list once at module load. Used by
// EMIT_EXTRACTED_PATTERNS_TOOL.pattern_config description so the AI
// sees the canonical vocabulary inline. Edits to canonical-patterns.ts
// propagate automatically.
const CANONICAL_PATTERN_BULLETS = Object.entries(ALL_CANONICAL_PATTERNS)
  .map(([name, desc]) => `• ${name} — ${desc}`)
  .join('\n')

// ─── Shared sub-shapes (factored for reuse) ───────────────────────────────────

const FIELD_MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source_field: {
      type: 'string',
      description:
        'Bare source field name (e.g., "first_name"), not "table.field". For many_to_one, this is the PRIMARY contributing source — the rest go in contributing_source_fields.',
    },
    target_field: {
      type: 'string',
      description:
        'Bare target field name. Must match a field on the target_table named in the parent table_mapping. For one_to_many, each split target gets its own entry with a different target_field.',
    },
    confidence: {
      type: 'number',
      description:
        'Integer 0-100 confidence the source-to-target field pairing is correct. 90-100 = near-certain (identical or near-identical names + compatible types + clear business alignment); 75-89 = high (similar names, compatible types, documentation-confirmed); 50-74 = moderate (partial name match OR conversion needed OR ambiguous business meaning); below 50 = low — usually omit the mapping rather than emit a low-confidence guess.',
    },
    reasoning: {
      type: 'string',
      description:
        '1-2 sentence reviewer-facing justification citing the specific signals used (name similarity, type compatibility, value-distribution alignment with documented target picklist). Avoid generic phrases like "good match" — name the evidence.',
    },
    similar_fields_considered: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional array of OTHER target field names you considered but rejected for this source (e.g., ["DisplayName", "FullName"]). Aids reviewer audit when the chosen target is not the most obvious one.',
    },
    type_compatibility: {
      type: 'string',
      description:
        'Describe the conversion or validation required: e.g., "VARCHAR → DECIMAL — strip $ and commas, parse to number"; "VARCHAR → BOOLEAN — normalize Y/N/yes/no/1/0 to TRUE/FALSE"; "VARCHAR(200) → VARCHAR(120) — truncation needed, 12 values exceed limit". When no conversion is needed, write "direct compatible — no conversion needed".',
    },
    needs_transformation: {
      type: 'boolean',
      description:
        'TRUE if ANY of: data type conversion, value translation (Won → Closed Won), format standardization, ID format change, boolean normalization, casing change, truncation, field combination/splitting, or FK reformat (cascading from a referenced PK transformation). FALSE for naming-convention-only differences (snake_case ↔ camelCase) when values pass through unchanged, or for compatible type-aliasing (TEXT ↔ VARCHAR).',
    },
    mapping_type: {
      type: 'string',
      enum: ['one_to_one', 'many_to_one', 'one_to_many'],
      description:
        'Default omitted (one-to-one). Set to "many_to_one" when multiple source fields combine into one target (first+last → full_name). Set to "one_to_many" when ONE source splits into multiple targets (full_name → first_name + last_name); each split emits a SEPARATE field_mapping entry sharing the same source_field.',
    },
    contributing_source_fields: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Required when mapping_type === "many_to_one". Array of ADDITIONAL source field names beyond source_field. Do NOT repeat the primary source_field in this list. Omit this property for one_to_one and one_to_many.',
    },
    combination_hint: {
      type: 'string',
      description:
        'Required when mapping_type === "many_to_one". Brief description of how to combine (e.g., "Concatenate with space separator", "first_name + \\" \\" + last_name").',
    },
    split_hint: {
      type: 'string',
      description:
        'Required when mapping_type === "one_to_many". Brief description of which part to extract (e.g., "Extract first name (substring before first space)", "Extract street component before comma"). Each one_to_many entry gets its own split_hint per target.',
    },
  },
  required: ['source_field', 'target_field', 'confidence', 'reasoning'],
} as const

const TABLE_MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source_table: {
      type: 'string',
      description:
        'Bare source table name (e.g., "customers"), not the qualified form ("public.customers"). Must match a source table from the prompt.',
    },
    target_table: {
      type: 'string',
      description:
        'Bare target table name (e.g., "Account"). Must match a target table from the prompt.',
    },
    confidence: {
      type: 'number',
      description:
        'Integer 0-100 confidence the source-to-target table pairing is correct. 90-100 = near-certain (identical names + same business meaning + substantial field overlap); 75-89 = high (similar names + compatible types + clear business alignment); 50-74 = moderate (partial name match OR conversion needed OR ambiguous business meaning); below 50 = low — usually omit the mapping entirely rather than emit a low-confidence guess.',
    },
    reasoning: {
      type: 'string',
      description:
        '1-2 sentence reviewer-facing justification for WHY this source maps to this target. Cite specific signals: name similarity, field-overlap count, documentation-confirmed business alignment. Avoid generic phrases like "good match" — name the evidence.',
    },
    field_mappings: {
      type: 'array',
      items: FIELD_MAPPING_SCHEMA,
      description:
        'Per-field mappings under this table pairing. May be empty when no source field is a confident match for any target field. Multi-source patterns (many_to_one) emit ONE entry per target; multi-target patterns (one_to_many) emit SEPARATE entries per target sharing the same source_field.',
    },
  },
  required: [
    'source_table',
    'target_table',
    'confidence',
    'reasoning',
    'field_mappings',
  ],
} as const

// ─── Mapping cluster (3 tools) ────────────────────────────────────────────────

/**
 * Used by: `mapping_generate` (engine primary) and
 * `mapping_generate_legacy_pair` (per-pair regenerate primary).
 *
 * Replaces `parseClaudeJSON` at lib/ai/mapping-engine.ts:820 + the
 * inline JSON parses at the two callsites. The tool input shape
 * matches the existing `ClaudeResponse` interface byte-for-byte.
 */
export const EMIT_TABLE_MAPPINGS_TOOL: Tool = {
  name: 'emit_table_mappings',
  description:
    'Emit the structured set of source-to-target table and field mappings produced for the schemas in the prompt. You process ONE source table per request — only emit a `table_mapping` when the current source is the BEST (or strong-secondary) semantic match for a given target. If `<other_source_tables>` lists a clearly-better primary match for some target, omit that target entirely from your output and let the better source claim it in its own batch.\n\nPrefer zero-mapping over low-confidence mapping. A wide source whose only field-overlap with a candidate target is `id`/`name`/`created_at` should NOT emit a `table_mapping` to that target.\n\nLookup/reference tables (narrow code+description shapes — STATUS_CODES, COUNTRY_CODES) map to AT MOST ONE target enumeration table. They MUST NOT map to entity tables (customers, accounts) — that link is established at the field level via FK, not by row-copying. Entity tables (CIF_MASTER, ACCT_MASTER) map to their corresponding entity target only when field overlap is substantial.\n\nUse bare table and field names (no schema prefixes). Multi-source patterns: a `many_to_one` mapping is ONE entry with the primary in `source_field` and the rest in `contributing_source_fields`; a `one_to_many` is SEPARATE entries per target, all sharing the same `source_field`. Direct one-to-one mappings omit `mapping_type` (or set it to `one_to_one`) and never include the multi-field hints.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_mappings: {
        type: 'array',
        items: TABLE_MAPPING_SCHEMA,
        description:
          'Array of table-level mappings emitted for the current source table. Empty array is a valid answer when no target table in the prompt is a strong semantic match for this source.',
      },
    },
    required: ['table_mappings'],
  },
}

/**
 * Used by: `mapping_suggest_legacy_bulk` (lib/actions/mappings.ts:2471).
 * Produces field-level mappings for the unmapped-fields-only flow,
 * inside an already-known table-mapping context.
 */
export const EMIT_FIELD_MAPPINGS_TOOL: Tool = {
  name: 'emit_field_mappings',
  description:
    'Emit field-level mapping suggestions for the unmapped source/target field pairs in the prompt. The table-mapping context is already established by the caller; you are filling the gaps. Each mapping must use a `source_field` from the supplied unmapped-source list and a `target_field` from the unmapped-target list — do not invent fields.\n\nSame multi-source/multi-target patterns and same confidence calibration apply as in `emit_table_mappings`: prefer zero-mapping over low-confidence mapping; emit one entry per target for many_to_one (with contributing_source_fields); emit separate entries per target for one_to_many (sharing source_field).',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      field_mappings: {
        type: 'array',
        items: FIELD_MAPPING_SCHEMA,
        description:
          'Array of field-level mappings, one per target field you can confidently fill. Empty array is acceptable when no source field on this pairing is a good match for any unmapped target.',
      },
    },
    required: ['field_mappings'],
  },
}

/**
 * Used by: `mapping_suggest` (lib/ai/mapping-engine.ts:1935). Produces
 * one suggestion for a single target field, naming source fields from
 * a single source table.
 */
export const EMIT_MAPPING_SUGGESTION_TOOL: Tool = {
  name: 'emit_mapping_suggestion',
  description:
    'Emit a single mapping suggestion for the ONE target field named in the prompt. The user is asking "what should this target field map FROM?" — pick the source field (or fields) from the SAME source table that best fills that target. Cross-table sources are not allowed in this version; if no field on the supplied source table is a good match, emit a low-confidence single-field guess rather than failing the call (the user will reject it manually).\n\nUse `combination_type = "single"` when exactly one source field maps; use `concat_space` or `concat_comma` when 2+ source fields combine into the target (e.g., first_name + last_name → full_name). Multi-source `concat_*` is the same many-to-one shape used by `emit_table_mappings` — same rules apply (don\'t repeat the primary source name; pick the most-specific combination_type for the data shape). `rationale` should be a SHORT (≤ 280 chars) reviewer-facing explanation citing the signals you used.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source_field_names: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Array of bare source field names (no "table.field" prefix), all from the SAME source table. The order matters for concat combination types — first element is the primary contributor (the conceptual "first half" for concat_space, etc.).',
      },
      combination_type: {
        type: 'string',
        enum: ['single', 'concat_space', 'concat_comma'],
        description:
          '"single" iff source_field_names has exactly one element; otherwise "concat_space" (space-delimited concatenation) or "concat_comma" (comma-delimited). Pick concat_space for human names ("first last"), concat_comma for address fragments ("street, city, state").',
      },
      confidence: {
        type: 'number',
        description:
          'Integer 0-100 confidence in this mapping. Apply the same calibration as emit_table_mappings: 90-100 near-certain, 75-89 high confidence, 50-74 moderate, <50 low — emit a low-confidence guess rather than failing the call when no good match exists, but make the rationale flag the uncertainty.',
      },
      rationale: {
        type: 'string',
        description:
          'Reviewer-facing explanation (≤ 280 chars) of the signals you used (name similarity, type compatibility, value-distribution match, documentation alignment). When confidence is below 75, explicitly note WHY you are uncertain in the rationale.',
      },
    },
    required: [
      'source_field_names',
      'combination_type',
      'confidence',
      'rationale',
    ],
  },
}

// ─── Validation cluster (1 tool) ──────────────────────────────────────────────

/**
 * Used by: `validation_rule_from_nl` (lib/actions/validation-rules.ts:341).
 * The shape mirrors the inline parser's `parsed` type exactly; the
 * downstream `validateRuleConfig` does the per-rule_type config check.
 *
 * `rule_config` is an enumerated-optional-keys object (Path 2 PR 1).
 * The schema lists every possible key across all 12 rule_types with
 * additionalProperties: false; the rule_type discriminator + the
 * container description tell the model which subset to populate.
 * The downstream `validateRuleConfig` enforces the per-type contract
 * at insert time and rejects mismatches.
 *
 * The rule_type enum carries 12 values, including `custom_sql` (added
 * in PR 12.1.5 B-3) which resolves the prior divergence with
 * `validateRuleConfig` at lib/actions/validation-rules.ts:119 — the
 * validator accepts custom_sql; the schema now matches.
 */
export const EMIT_VALIDATION_RULE_TOOL: Tool = {
  name: 'emit_validation_rule',
  description:
    "Emit a structured validation rule derived from the user's natural-language description. The rule will run against staged source data — never against production source — and its severity drives whether failures block migration approval or surface as warnings only.\n\nChoose `rule_type` to be the most specific match for the user's intent: prefer `regex` over `allowed_values` only when the value space is genuinely unbounded; prefer `range` over the separate `min_value`/`max_value` rules when both bounds apply; prefer `date_after`/`date_before` over a custom regex when the user describes a date threshold.\n\nEach `rule_type` has a fixed `rule_config` shape — see the templates in the rule_config description. The downstream `validateRuleConfig` validator will reject any rule whose config doesn't match the type's required keys (e.g., `regex` requires `pattern`; `range` requires `min` and `max` with `min ≤ max`). Severity choice is the most consequential decision: pick `blocking` only for the 5 conditions enumerated in the severity description; everything else defaults to `warning`.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        description:
          'Short rule name (≤ 60 chars), suitable for a UI list item. Phrase as a positive constraint ("Email format valid", not "Email broken"). Title Case.',
      },
      description: {
        type: 'string',
        description:
          'Plain-English description of what the rule checks (1-2 sentences). Used in the validation results UI; should make sense to a non-technical reviewer. Reference the specific value(s) or pattern when helpful (e.g., "Field must be a valid email address matching the RFC 5322 simplified pattern").',
      },
      rule_type: {
        type: 'string',
        enum: [
          'not_null',
          'unique',
          'min_value',
          'max_value',
          'min_length',
          'max_length',
          'regex',
          'allowed_values',
          'range',
          'date_after',
          'date_before',
          'custom_sql',
        ],
        description:
          'Canonical rule type. The rule_config shape MUST match the per-type template in the rule_config description. Use the most-specific type that captures the user intent — prefer "range" over separate min_value+max_value, prefer "allowed_values" over "regex" when the value set is small and known, prefer "date_after"/"date_before" over regex for date thresholds.\n\nUse `custom_sql` only when the validation logic genuinely cannot be expressed by any other rule type. Examples: cross-field referential checks, complex business rules involving multiple fields with non-trivial logic, or temporal patterns that require window functions. Do NOT use `custom_sql` as a default — prefer structured rule types when they fit. The user pays a maintainability cost for `custom_sql` rules because they bypass Settle\'s structured validation infrastructure.',
      },
      rule_config: {
        type: 'object',
        additionalProperties: false,
        description:
          'Per-type configuration object. The keys depend on rule_type:\n• not_null/unique → {} (empty)\n• min_value → { min: number }\n• max_value → { max: number }\n• min_length/max_length → { min_length / max_length: integer }\n• regex → { pattern: non-empty string, valid JS RegExp }\n• allowed_values → { values: non-empty string[] }\n• range → { min: number, max: number, min ≤ max }\n• date_after/date_before → { date: ISO date string parseable by Date.parse }\n• custom_sql → { sql: non-empty SELECT-only string, must include WHERE table_id filter }\nThe downstream validateRuleConfig will reject mismatches at insert time.',
        properties: {
          min: {
            type: 'number',
            description:
              'Numeric lower bound. Used by min_value (sole key) and range (paired with max).',
          },
          max: {
            type: 'number',
            description:
              'Numeric upper bound. Used by max_value (sole key) and range (paired with min, must satisfy min ≤ max).',
          },
          min_length: {
            type: 'number',
            description:
              'Integer lower bound on string length. Used by min_length rule_type only.',
          },
          max_length: {
            type: 'number',
            description:
              'Integer upper bound on string length. Used by max_length rule_type only.',
          },
          pattern: {
            type: 'string',
            description:
              'Non-empty JS-compatible regular expression source string. Used by regex rule_type only.',
          },
          description: {
            type: 'string',
            description:
              'Optional human-readable description of what the regex matches (e.g., "Two letters followed by 4 digits"). Used by regex rule_type only.',
          },
          values: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Non-empty array of allowed string values. Used by allowed_values rule_type only.',
          },
          date: {
            type: 'string',
            description:
              'ISO date string (e.g., "2020-01-01") parseable by Date.parse. Used by date_after and date_before rule_types only.',
          },
          sql: {
            type: 'string',
            description:
              'Non-empty SELECT-only SQL string that must include a WHERE table_id filter. Used by custom_sql rule_type only.',
          },
        },
      },
      severity: {
        type: 'string',
        enum: ['blocking', 'warning'],
        description:
          '"blocking" means the migration cannot proceed without the rule passing. Default to blocking ONLY for these 5 conditions:\n1. Target schema NOT NULL violations on required fields\n2. Target FK orphans against explicitly-required parents\n3. Target PK uniqueness violations\n4. Type-conversion failures with no transformation pattern\n5. Field-length truncation when target dialect rejects oversized values\n\nEverything else defaults to "warning". When in doubt between blocking and warning, prefer warning — the migration team retains agency over which warnings to act on.',
      },
    },
    required: ['name', 'description', 'rule_type', 'rule_config', 'severity'],
  },
}

// ─── DDL cluster (1 tool) ─────────────────────────────────────────────────────

/**
 * Used by: `ddl_parsing` (lib/parsers/ddl-parser.ts:391). The
 * AI-assisted fallback for DDL the deterministic parser couldn't
 * handle. Field shape matches `ParsedField` from ddl-parser.ts. Some
 * fields are nullable in the contract (fkReference, defaultValue,
 * checkConstraint) but always present.
 *
 * `checkConstraint` is left untyped (no `type` declared) for B-1
 * because its shape is a discriminated union. PR 12.1.5 B-2 probes
 * Anthropic strict-mode `oneOf` support and either tightens to
 * discriminated union (PASS) or applies flat-object + selection
 * guidance (FAIL).
 */
export const EMIT_PARSED_DDL_TOOL: Tool = {
  name: 'emit_parsed_ddl',
  description:
    'Emit the structured parse of all CREATE TABLE definitions found in the DDL script. Handle any SQL dialect (PostgreSQL, MySQL, Oracle, SQL Server, SAP HANA, DB2). Use the canonical type name with precision/scale where present (e.g., VARCHAR(255), DECIMAL(18,2), TIMESTAMPTZ). Preserve dialect-specific spellings when the source dialect is named in the DDL (e.g., NVARCHAR2 for Oracle); use the most-portable equivalent only when the source dialect is unstated.\n\nFor CHECK constraints, populate checkConstraint with one of the templates listed in the system prompt (in_list / regex / range / custom); set checkConstraint to null when no CHECK exists. Set fkReference to null when not a foreign key. Set defaultValue to null when no default is declared.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tables: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              description:
                'Bare table name (e.g., "ACCT_MASTER"). Preserve the casing and identifier quoting of the source DDL.',
            },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: {
                    type: 'string',
                    description:
                      'Bare field name as declared in the DDL (preserve original casing).',
                  },
                  dataType: {
                    type: 'string',
                    description:
                      'Canonical type name with precision/scale where present (e.g., VARCHAR(255), DECIMAL(18,2), TIMESTAMPTZ). Preserve dialect-specific spellings when the source dialect is named (NVARCHAR2 for Oracle, NUMBER for Oracle); use the most-portable equivalent only when the dialect is unstated.',
                  },
                  isNullable: {
                    type: 'boolean',
                    description:
                      'True when the column has no NOT NULL constraint in the DDL. Default to true when nullability is not explicitly declared, per SQL standard.',
                  },
                  isPrimaryKey: {
                    type: 'boolean',
                    description:
                      'True when this column participates in the table\'s PRIMARY KEY constraint (inline `PRIMARY KEY` or table-level `PRIMARY KEY (col, ...)`). For composite PKs, set true on every participating column.',
                  },
                  isForeignKey: {
                    type: 'boolean',
                    description:
                      'True when this column has a REFERENCES clause (inline or table-level FOREIGN KEY). When true, populate fkReference; a true value with null fkReference is a no-op downstream.',
                  },
                  fkReference: {
                    type: ['string', 'null'],
                    description:
                      'When isForeignKey is true, the canonical reference in the form "ReferencedTable.column" (e.g., "BRANCH_INFO.BRANCH_NO"). Null when not a foreign key.',
                  },
                  defaultValue: {
                    type: ['string', 'null'],
                    description:
                      'String representation of the column\'s DEFAULT clause value (e.g., "0", "CURRENT_TIMESTAMP", "\'pending\'"). Null when no DEFAULT is declared.',
                  },
                  checkConstraint: {
                    type: ['object', 'null'],
                    additionalProperties: false,
                    description:
                      'CHECK constraint as a flat object selected by the `type` discriminator, OR null when the field has no CHECK constraint. Anthropic strict mode does not support JSON Schema oneOf (verified via probe), so the variant shape is encoded in this description rather than in the schema:\n• type=\'in_list\' → populate `allowedValues: string[]`; omit pattern/min/max\n• type=\'regex\' → populate `pattern: string`; omit allowedValues/min/max\n• type=\'range\' → populate `min` and/or `max` as numbers; omit allowedValues/pattern\n• type=\'custom\' → only set `type` and `raw`; omit the other shape-specific keys\nAlways populate `raw` with the original CHECK clause text (the validator on the consumer side preserves it for audit). Set the entire checkConstraint to null when no CHECK constraint exists on this field.',
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['in_list', 'regex', 'range', 'custom'],
                        description:
                          'Discriminator selecting the constraint variant. Determines which sibling keys to populate.',
                      },
                      allowedValues: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                          'Allowed string values. Used by type=\'in_list\' only.',
                      },
                      pattern: {
                        type: 'string',
                        description:
                          'Regular-expression source string. Used by type=\'regex\' only.',
                      },
                      min: {
                        type: 'number',
                        description:
                          'Numeric lower bound (inclusive). Used by type=\'range\' only; pair with max when both bounds apply.',
                      },
                      max: {
                        type: 'number',
                        description:
                          'Numeric upper bound (inclusive). Used by type=\'range\' only; pair with min when both bounds apply.',
                      },
                      raw: {
                        type: 'string',
                        description:
                          'Verbatim CHECK clause text from the DDL (e.g., "status IN (\'A\',\'B\')"). Always populated; preserved for audit.',
                      },
                    },
                  },
                },
                required: [
                  'name',
                  'dataType',
                  'isNullable',
                  'isPrimaryKey',
                  'isForeignKey',
                ],
              },
              description:
                'Ordered list of fields as they appear in the CREATE TABLE statement. Field order matters for downstream matching, so preserve the source order.',
            },
          },
          required: ['name', 'fields'],
        },
        description:
          'Array of CREATE TABLE definitions parsed from the DDL. One entry per table; preserve declaration order.',
      },
    },
    required: ['tables'],
  },
}

// ─── Schema cluster (2 tools) ─────────────────────────────────────────────────

/**
 * Used by: `schema_enrichment` (lib/actions/schema-enrichment.ts:218).
 * Produces only fields where documentation differs from inference.
 * Shape mirrors `ClaudeSchemaResponse` / `SchemaCorrection`.
 *
 * NOTE: PR 12.1.5 B-2 may tighten `inferred_type` to enum of 14
 * semantic types per investigation §2 #2.
 */
export const EMIT_SCHEMA_CORRECTIONS_TOOL: Tool = {
  name: 'emit_schema_corrections',
  description:
    'Emit corrections that documentation reveals are needed against the inferred schema in the prompt. Only output fields where the documentation differs from inference; agreed-upon fields are skipped. corrections is a partial set per field; reasoning is a short auditable justification. known_issues is optional and captures explicit data-quality caveats from the documentation.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_name: {
              type: 'string',
              description:
                'Bare source field name being corrected. Must match a field listed in the inferred-schema portion of the prompt — do NOT correct fields that are not in the prompt.',
            },
            corrections: {
              type: 'object',
              additionalProperties: false,
              properties: {
                is_nullable: {
                  type: 'boolean',
                  description:
                    'Set to false when documentation declares the field NOT NULL but inference detected nullability (because the actual data contains nulls). Nulls in the data are data-quality defects, not schema features.',
                },
                is_primary_key: {
                  type: 'boolean',
                  description:
                    'Set to true when documentation identifies the field as PK but inference did not detect it. Composite PKs: set true on every participating column.',
                },
                is_foreign_key: {
                  type: 'boolean',
                  description:
                    'Set to true ONLY when documentation identifies an FK relationship AND the referenced parent table is also present in the inferred schema. When set to true, you MUST also populate fk_reference; a true value with a null fk_reference is a no-op downstream and is rejected. To remove a spurious FK, set false and set fk_reference to null.',
                },
                fk_reference: {
                  type: ['string', 'null'],
                  description:
                    'Canonical FK target in the form "ReferencedTableName.pk_field_name" (e.g., "BRANCH_INFO.BRANCH_NO"). Required when is_foreign_key is true. Null when removing a spurious FK or when not a foreign key.',
                },
                inferred_type: {
                  type: 'string',
                  enum: [
                    'email',
                    'phone',
                    'date',
                    'datetime',
                    'currency',
                    'boolean',
                    'percentage',
                    'url',
                    'address',
                    'zip_code',
                    'country',
                    'state',
                    'name',
                    'id',
                  ],
                  description:
                    'Semantic type, set when the documentation describes the field\'s purpose. Picks one of the 14 canonical semantic types Settle\'s downstream consumers recognize. Omit when the documentation does not describe a semantic intent (the inference\'s structural type stays).',
                },
                data_type: {
                  type: 'string',
                  description:
                    'More-precise structural type when documentation specifies one (e.g., DECIMAL(18,2) when inference said VARCHAR because of currency formatting). Use the canonical SQL type name.',
                },
              },
              description:
                'Partial set of attribute corrections for this field. Only include attributes that documentation contradicts or augments. Omit attributes where inference and documentation agree.',
            },
            reasoning: {
              type: 'string',
              description:
                '1-2 sentence reviewer-facing justification anchored in the documentation passage that drove the correction (e.g., "Data dictionary documents CIF_MASTER.BRANCH_NO as a foreign key to BRANCH_INFO.BRANCH_NO; inference missed it because column names only partially overlap").',
            },
            known_issues: {
              type: 'string',
              description:
                'Optional. Use only when the documentation explicitly calls out a known data-quality caveat for this field (e.g., "Some nulls exist from a 2018 import error that was never fully remediated"). Omit when no documented caveat exists.',
            },
          },
          required: ['field_name', 'corrections', 'reasoning'],
        },
        description:
          'Array of per-field corrections. Empty array is acceptable when documentation and inference fully agree across all fields in the table.',
      },
    },
    required: ['corrections'],
  },
}

/**
 * Used by: `schema_merge_ai_match` (lib/actions/schema-merge.ts:782).
 * The "Layer 3" matcher between DDL-declared tables and existing DB
 * tables when name-based and fingerprint matchers didn't fire.
 *
 * NOTE: existing code reads `existing_table_id` (not `existing_id`
 * which the original investigation table named); schema follows the
 * code.
 */
export const EMIT_TABLE_MATCHES_TOOL: Tool = {
  name: 'emit_table_matches',
  description:
    'Emit confident matches between unmatched DDL tables and existing database tables based on field-name overlap and semantic name equivalence. The merge layer above this tool is precision-biased — prefer no-match over wrong-match. If you are not confident about a match, omit it entirely. Each existing table id matches at most one DDL table.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ddl_table_name: {
              type: 'string',
              description:
                'Bare table name from the unmatched-DDL list (preserve casing as it appears in the prompt). Must match a name from that list; do not invent.',
            },
            existing_table_id: {
              type: 'string',
              description:
                'UUID of the existing table from the supplied unmatched-existing list. Must be a UUID present in the prompt — do not invent IDs. Each existing_table_id may appear at most once across all matches.',
            },
          },
          required: ['ddl_table_name', 'existing_table_id'],
        },
        description:
          'Array of confident DDL-to-existing-table matches. Empty array is the right answer when no DDL table has a strong field-overlap signature with any unmatched existing table.',
      },
    },
    required: ['matches'],
  },
}

// ─── Intelligence cluster (1 tool) ────────────────────────────────────────────

/**
 * Used by: `migration_intelligence`
 * (lib/actions/migration-intelligence.ts:855). The system prompt asks
 * for a top-level JSON array; Anthropic tools require objects, so the
 * array is wrapped under `patterns` here. The callsite reads
 * `result.toolUse.input.patterns` and treats it as the array.
 *
 * `pattern_config` is an enumerated-optional-keys object (Path 2 PR 1).
 * The schema lists every possible key across all 4 categories with
 * additionalProperties: false; the parent `category` enum + the
 * container description tell the model which subset to populate.
 *
 * The pattern_config description embeds the canonical pattern_type
 * vocabulary from `lib/ai/canonical-patterns.ts` — edits to that file
 * propagate here automatically at module load.
 */
export const EMIT_EXTRACTED_PATTERNS_TOOL: Tool = {
  name: 'emit_extracted_patterns',
  description:
    'Emit generalizable migration patterns extracted from the completed project\'s transformations, quality issues, and documentation. Patterns flow into the migration intelligence knowledge base where they prime FUTURE projects\' Claude prompts as reference context — they MUST be reusable across DIFFERENT source/target systems and MUST NOT embed project-specific table or field names.\n\nGenerate 8-15 patterns, weighted toward `transformation_recipe` and `data_quality_pattern` categories (those are the most actionable for future projects). Include 1-2 `domain_knowledge` entries when the project surfaces non-obvious entity-model facts; include 1 `source_system_hint` when the project reveals systematic characteristics of the source platform that will be encountered again. Skip patterns that any LLM already knows ("dates should be valid"); focus on what was genuinely LEARNED from this project\'s outcomes.\n\nEach `pattern_config` follows a per-category template. The wrapping `pattern_type` discriminator (or `domain`/`system_type` for the latter two categories) is the retrieval key — don\'t omit it. PREFER canonical pattern_type values from the list in the pattern_config description; coin new values only for genuinely novel patterns.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      patterns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: {
              type: 'string',
              enum: [
                'transformation_recipe',
                'data_quality_pattern',
                'domain_knowledge',
                'source_system_hint',
              ],
              description:
                'Pattern category, picks the per-category template that pattern_config follows. transformation_recipe = a SQL/transformation approach; data_quality_pattern = a detection+typical-rate+causes triple; domain_knowledge = an entity-model or load-order insight; source_system_hint = systematic characteristics of a source platform.',
            },
            title: {
              type: 'string',
              description:
                'Short descriptive title (≤ 60 chars). Phrase as a generalizable lesson, not a project-specific outcome — "Strip currency formatting before DECIMAL cast" beats "Migrating customers.annual_revenue to Account.AnnualRevenue".',
            },
            pattern_description: {
              type: 'string',
              description:
                '2-3 sentence description suitable for direct injection into a future Claude prompt as reference context. Write in second-person imperative when describing actions ("strip currency formatting from VARCHAR before casting to DECIMAL"); first-person passive otherwise. Do not name specific tables/fields/customers.',
            },
            pattern_config: {
              type: 'object',
              additionalProperties: false,
              description:
                'Structured metadata. Shape varies by category:\n• transformation_recipe → { pattern_type, source_indicators[], target_indicators[], approach, edge_cases[] }\n• data_quality_pattern → { pattern_type, detection_method, typical_rate_percent, common_causes[] }\n• domain_knowledge → { domain, entity_patterns[], load_order_hint }\n• source_system_hint → { system_type, common_characteristics[], typical_issues[] }\n\nThe pattern_type field (or domain/system_type for the latter two) is the retrieval key. PREFER canonical values from the list below when your pattern fits one of them; coin new values only for genuinely novel patterns that don\'t fit any canonical bucket.\n\nCanonical pattern_type values (Settle\'s v1 vocabulary):\n' +
                CANONICAL_PATTERN_BULLETS,
              properties: {
                pattern_type: {
                  type: 'string',
                  description:
                    'Snake-case canonical phrase keying retrieval. Used by transformation_recipe and data_quality_pattern. PREFER values from the canonical vocabulary listed in the parent description; coin new values only for genuinely novel patterns.',
                },
                source_indicators: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Signals that identify when this pattern applies on the source side (e.g., "VARCHAR field with $ or comma characters"). Used by transformation_recipe.',
                },
                target_indicators: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Signals that identify the target shape that triggers this pattern (e.g., "DECIMAL or NUMERIC type"). Used by transformation_recipe.',
                },
                approach: {
                  type: 'string',
                  description:
                    'High-level transformation approach in one phrase (e.g., "REGEXP_REPLACE to strip formatting, then cast"). Used by transformation_recipe.',
                },
                edge_cases: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Edge cases the pattern must handle (e.g., "parentheses for negatives", "empty string vs NULL"). Used by transformation_recipe.',
                },
                detection_method: {
                  type: 'string',
                  description:
                    'How the data-quality issue is detected (e.g., "LEFT JOIN parent WHERE parent.pk IS NULL"). Used by data_quality_pattern.',
                },
                typical_rate_percent: {
                  type: 'string',
                  description:
                    'Typical affected-row rate as a percentage range or single value (e.g., "2-5", "<1"). Used by data_quality_pattern.',
                },
                common_causes: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Upstream causes of the quality issue (e.g., "parent deletions without cascade"). Used by data_quality_pattern.',
                },
                domain: {
                  type: 'string',
                  description:
                    'Snake-case domain identifier keying retrieval (e.g., "legal_elm"). Used by domain_knowledge.',
                },
                entity_patterns: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Entity-relationship observations specific to the domain (e.g., "matters as core entity"). Used by domain_knowledge.',
                },
                load_order_hint: {
                  type: 'string',
                  description:
                    'Hint about target load order constraints (e.g., "independent entities first"). Used by domain_knowledge.',
                },
                system_type: {
                  type: 'string',
                  description:
                    'Snake-case source-system classification (e.g., "legacy_crm"). Used by source_system_hint.',
                },
                common_characteristics: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Systematic characteristics of the source platform (e.g., "VARCHAR for most fields"). Used by source_system_hint.',
                },
                typical_issues: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Recurring data quality issues to expect from this source system (e.g., "orphaned FKs from historical deletions"). Used by source_system_hint.',
                },
              },
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Array of relevant lowercase tags for retrieval (e.g., ["currency", "decimal", "varchar", "type-cast"]). Use generic vocabulary that future projects will share — not project-specific names. 3-6 tags is typical.',
            },
          },
          required: [
            'category',
            'title',
            'pattern_description',
            'pattern_config',
            'tags',
          ],
        },
        description:
          'Array of 8-15 migration patterns. Empty array is acceptable for projects with no novel patterns to share, but most completed projects yield several extractable patterns.',
      },
    },
    required: ['patterns'],
  },
}

// ─── Quality cluster (2 tools) ────────────────────────────────────────────────

/**
 * Used by: `quality_detection_ai`
 * (lib/actions/ai-quality-detection.ts:286). Shape mirrors
 * `ClaudeQualityResponse` / `ProposedIssue`.
 */
export const EMIT_QUALITY_ISSUES_TOOL: Tool = {
  name: 'emit_quality_issues',
  description:
    'Emit additional data-quality issues that the automated quality rules missed. Focus on issues that require cross-field reasoning, business-rule application, or documentation-driven knowledge that pure-statistical detection can\'t surface — automated rules already catch the obvious cases (uniformly null columns, max-length violations, regex mismatches against an explicit pattern), so don\'t duplicate them.\n\nNEVER duplicate an issue already listed in `<existing_issues>`. Only propose issues you have HIGH confidence exist based on the field profiles, sample values, and documented business rules in the prompt. Each `verification_sql` MUST be a SELECT COUNT(*) against the `data_rows` table with a `WHERE table_id = \'<the exact table_id from the prompt>\'` filter and JSONB extraction (`row_data->>\'field_name\'`); the safety validator at `isVerificationSQLSafe` rejects anything else (DML, DDL, joins to system tables, missing table_id filter). If you cannot write a safe verifiable SQL query for an issue, omit the issue entirely.\n\nCross-field issues (e.g., "amount is null when stage = Closed Won") require both `field_name` and `cross_field`. Single-field issues only set `field_name`. Estimate counts using value distributions in the prompt, or use round numbers when uncertain — `verification_sql` will produce the exact count later.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      proposed_issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_name: {
              type: 'string',
              description:
                'Bare source field name the issue primarily relates to. Must match a field listed in the table context in the prompt.',
            },
            cross_field: {
              type: 'string',
              description:
                'Optional second field name when the issue spans two fields (e.g., "amount" with cross_field "stage" for "amount null when stage closed"). Omit for single-field issues.',
            },
            description: {
              type: 'string',
              description:
                'Plain-English description of the issue (1-2 sentences). Should explain what is wrong AND why it matters, in language a migration reviewer can understand. Example: "Null amount on closed deals — records have stage IN (\\"Won\\", \\"Closed Won\\") but amount is NULL or empty".',
            },
            severity: {
              type: 'string',
              enum: ['blocking', 'warning'],
              description:
                '"blocking" means the data WILL fail to load or cause data corruption. Default to blocking ONLY for these 5 conditions:\n1. Target schema NOT NULL violations on required fields\n2. Target FK orphans against explicitly-required parents\n3. Target PK uniqueness violations\n4. Type-conversion failures with no transformation pattern\n5. Field-length truncation when target dialect rejects oversized values\n\nEverything else defaults to "warning". When in doubt between blocking and warning, prefer warning — the migration team retains agency over which warnings to act on.',
            },
            estimated_count: {
              type: 'number',
              description:
                'Rough estimate of how many rows are affected, derived from the value distributions/null rates in the prompt. Round numbers (5, 50, 500) are fine when uncertain — verification_sql produces the exact count downstream. Set to 0 only when you are confident the issue affects zero rows (in which case omit the issue entirely).',
            },
            verification_sql: {
              type: 'string',
              description:
                'A SELECT COUNT(*) query against the data_rows table that confirms the exact affected-row count. MUST include WHERE table_id = \'<the table_id from the prompt>\'. MUST use JSONB extraction (row_data->>\'field_name\'). MUST be SELECT-only (no UPDATE/DELETE/DDL/joins to system tables). Use TRIM/LOWER/regex inside the WHERE to handle the format inconsistencies you are testing for.\n\nDo NOT attempt cross-table relationship verification — those queries don\'t fit the data_rows JSONB pattern. The validator will reject joins to other tables. If a quality issue requires cross-table verification, omit it from your output and rely on the deterministic FK validation rules instead.',
            },
            reasoning: {
              type: 'string',
              description:
                '1-2 sentence justification anchored in the prompt context (cite the doc passage, the field profile statistic, or the business rule that surfaced this issue). The reviewer reads this to decide whether to act on the proposed issue.',
            },
          },
          required: [
            'field_name',
            'description',
            'severity',
            'estimated_count',
            'verification_sql',
            'reasoning',
          ],
        },
        description:
          'Array of newly-identified data-quality issues. Empty array is the correct answer when the automated rules already caught everything — DO NOT pad the response with low-confidence guesses.',
      },
    },
    required: ['proposed_issues'],
  },
}

/**
 * Used by: `quality_fix_options` (lib/quality/fix-engine.ts:421).
 * Shape mirrors `ClaudeFixResponse` / `FixOption`.
 *
 * Risk-level rubric is anchored in Settle's actual fix execution
 * mechanism (per migration 008_fix_snapshots.sql): originals are
 * preserved in fix_snapshots before fix execution, and revertFix
 * restores values bit-for-bit via SECURITY DEFINER RPCs. The "high"
 * tier explicitly flags CTE/window-function patterns that can land
 * non-revertable to bias the AI toward flat UPDATE patterns.
 */
export const EMIT_FIX_OPTIONS_TOOL: Tool = {
  name: 'emit_fix_options',
  description:
    'Emit 2-3 fix options for the data-quality issue described in the prompt. Each fix option is a complete, executable proposal — the SQL must run against `data_rows` JSONB columns with a `WHERE table_id = \'<the exact uuid from the prompt>\'` anchor.\n\nREQUIRED:\n• WHERE table_id = \'<the table_id from the prompt>\' anchor on every fix\n• Use row_data->>\'FieldName\' for JSONB extraction\n• Regex-guard any numeric cast (e.g., AND row_data->>\'Amount\' ~ \'^-?[0-9]+(\\.[0-9]+)?$\')\n• Use CASE+regex with NULL-safe outer CASE for date format fixes — never wrap a parse expression directly in to_jsonb()\n• Use a CTE for window-function logic (window functions are not allowed inside UPDATE SET)\n• Use the JSONB merge operator (row_data || \'{...}\'::jsonb) to add a missing field; use jsonb_set to update an existing field\n\nFORBIDDEN:\n• DDL keywords: DROP, ALTER, CREATE, TRUNCATE\n• References to tables other than data_rows\n• LIMIT, FETCH FIRST, FETCH NEXT, OFFSET clauses (the validator REJECTS these — fixes apply to all matching rows or to none)\n• Joins to system tables (pg_catalog, information_schema, auth.*, storage.*)\n\nProvide options spanning the risk spectrum: at least one low-risk option (e.g., flag for human review by adding a marker field) and one moderate or aggressive option (e.g., apply a default value or remove rows). The reviewer chooses based on the project\'s tolerance for data loss vs review burden.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      root_cause: {
        type: 'string',
        description:
          'Plain-English explanation (1-2 sentences) of WHY this quality issue exists in the source data. Reference the specific upstream pattern when known (e.g., "legacy import in 2018 wrote NULLs for fields the new schema requires NOT NULL").',
      },
      downstream_impact: {
        type: 'string',
        description:
          'What BREAKS in the migration if this issue is not fixed. Be specific about target tables and approximate record counts (e.g., "Account inserts will fail for 47 rows due to NOT NULL constraint on AnnualRevenue").',
      },
      fix_options: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: {
              type: 'string',
              description:
                'Short option name (≤ 50 chars), suitable for a UI button or radio label. Phrase as the action the option takes ("Filter out null records", "Default missing values to N/A").',
            },
            description: {
              type: 'string',
              description:
                'Plain-English (1-2 sentence) description of what the fix does, written for a non-SQL reviewer. Match the verb in the label ("This option deletes rows where amount is NULL...").',
            },
            sql: {
              type: 'string',
              description:
                'Exact executable SQL satisfying the REQUIRED/FORBIDDEN constraints in the tool description. MUST include WHERE table_id = \'<the table_id from the prompt>\'. MUST use row_data->>\'X\' for field access. MUST regex-guard any numeric cast. MUST NOT use LIMIT/FETCH/OFFSET (the validator rejects these — fixes apply to all matching rows or to none).',
            },
            tradeoff: {
              type: 'string',
              description:
                '1-2 sentence statement of what the option gains AND loses (e.g., "Gains: zero data loss, all rows preserved. Loses: introduces N/A placeholder values that may need a second pass").',
            },
            downstream_impact: {
              type: 'string',
              description:
                'How this specific fix affects later migration steps (e.g., "After this fix, Account inserts succeed; the 47 N/A annual_revenue values will route to a target review queue").',
            },
            risk_level: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description:
                '"low" = reversible non-destructive marker addition (e.g., flagging records via a new _review field). Originals fully preserved; revert restores exact pre-fix state.\n\n"medium" = reversible in-place value update preserving row identity (e.g., default-value fills, format normalization, value translation, casing standardization, currency cleanup). Settle\'s fix_snapshots table preserves the original row_data; revert restores values bit-for-bit. PREFER this tier when both medium and high formulations achieve the same result.\n\n"high" = row deletion OR CTE/multi-table-pattern updates. DELETE is reversible via re-INSERT but row IDs change. CTE patterns (including any fix using window functions, which require CTEs) can land in a non-revertable state if the user opts to skip snapshotting. AVOID CTE patterns when a flat UPDATE expression achieves the same logical result — for example, a "fill with prior non-null value" fix can be expressed as flat UPDATE with correlated subquery instead of CTE+window function. Always include at least one "low" option per response so the reviewer has a safe default.',
            },
            estimated_rows_affected: {
              type: 'number',
              description:
                'Rough integer estimate of rows the SQL touches, based on the issue\'s estimated_count and any narrowing in the WHERE clause. Round numbers fine when uncertain.',
            },
          },
          required: [
            'label',
            'description',
            'sql',
            'tradeoff',
            'downstream_impact',
            'risk_level',
            'estimated_rows_affected',
          ],
        },
        description:
          'Array of 2-3 complete fix proposals at varying risk levels. Each option must be independently executable — the user picks ONE to apply.',
      },
    },
    required: ['root_cause', 'downstream_impact', 'fix_options'],
  },
}

// ─── Documents cluster (2 tools) ──────────────────────────────────────────────

/**
 * Used by: `outputs_migration_runbook`
 * (lib/actions/migration-runbook.ts:541). Shape mirrors the Omit<>
 * type used at the parse site — Claude generates ~8 fields; the
 * server-side caller fills in the stats and stitched fields.
 *
 * The downstream usage at lines 583-625 has fallbacks for missing
 * fields, so we only require the most structurally critical ones.
 */
export const EMIT_MIGRATION_RUNBOOK_TOOL: Tool = {
  name: 'emit_migration_runbook',
  description:
    'Emit the structured content for a Migration Runbook DOCX. The system prompt enumerates exact field requirements per section. preMigrationChecklist is an array of plain-English action items. mappingSpecification, transformationRules, executionPlan, validationCriteria, and dataQualityAssessment.keyFindings are arrays sized to the project. The server fills in stats fields (totalSourceRecords, etc.) and the cover block; this tool only emits the AI-generated narrative content.\n\nWrite in clear, professional, action-oriented language. For checklist items, start each with a verb ("Verify all blocking quality issues are resolved", NOT "Blocking issues should be resolved"). For transformation rules, describe each in plain business language; include valueMappingTable only for CASE-WHEN style value translations; skip simple direct-copy mappings.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      executiveSummary: {
        type: 'string',
        description:
          '3-4 sentence summary of the migration scope and readiness. Cover: source/target systems, total table count, total record count, overall readiness assessment. Avoid jargon; this section is read by non-technical stakeholders.',
      },
      preMigrationChecklist: {
        type: 'array',
        items: { type: 'string' },
        description:
          '8-12 actionable checklist items. Each item starts with a verb ("Verify all blocking quality issues are resolved"; NOT "Blocking issues should be resolved"). Items should be independently checkable — no "and" combining unrelated checks.',
      },
      mappingSpecification: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceTable: {
              type: 'string',
              description: 'Bare source table name (e.g., "customers").',
            },
            targetTable: {
              type: 'string',
              description: 'Bare target table name (e.g., "Account").',
            },
            fieldCount: {
              type: 'number',
              description:
                'Total number of mapped fields between this source/target pair (count of approved field_mappings).',
            },
            keyTransformations: {
              type: 'array',
              items: { type: 'string' },
              description:
                '2-4 most significant transformations for this table pairing, in plain business language (e.g., "Concatenate first_name and last_name into FullName"). Skip trivial direct-copy mappings.',
            },
            unmappedFields: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Bare names of source fields on this table that are NOT being migrated. Empty array if every source field has a mapping.',
            },
          },
          required: [
            'sourceTable',
            'targetTable',
            'fieldCount',
            'keyTransformations',
            'unmappedFields',
          ],
        },
        description:
          'One entry per approved table mapping. Include ALL approved table mappings; do not summarize or skip.',
      },
      transformationRules: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetField: {
              type: 'string',
              description:
                'Qualified target field reference in the form "TargetTable.field_name".',
            },
            sourceField: {
              type: 'string',
              description:
                'Qualified source field reference in the form "source_table.field_name".',
            },
            ruleDescription: {
              type: 'string',
              description:
                'Plain-business-language description of the transformation (e.g., "Strip currency symbols and parse to DECIMAL(18,2); negative values represented as parenthesized strings convert to negative numbers"). Avoid SQL syntax in the description.',
            },
            valueMappingTable: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: {
                    type: 'string',
                    description: 'Source value (verbatim, including casing).',
                  },
                  target: {
                    type: 'string',
                    description: 'Target value the source maps to.',
                  },
                },
                required: ['source', 'target'],
              },
              description:
                'Optional. Include ONLY for CASE-WHEN style value translations (e.g., status codes, picklist values). Omit for type conversions, format normalizations, or computed fields.',
            },
          },
          required: ['targetField', 'sourceField', 'ruleDescription'],
        },
        description:
          'Include ALL transformations that involve value mapping, type conversion, or significant business logic. SKIP simple direct-copy mappings with no logic.',
      },
      dataQualityAssessment: {
        type: 'object',
        additionalProperties: false,
        description:
          'Per-project data-quality summary. Numeric counts are server-supplied and should be reflected verbatim; the AI generates summaryNarrative + keyFindings. The block is read by both technical operators and stakeholders, so keep narrative text accessible.',
        properties: {
          totalIssuesFound: {
            type: 'number',
            description:
              'Total quality issues detected across the project (server-supplied number; reflect verbatim).',
          },
          issuesFixed: {
            type: 'number',
            description:
              'Issues with status=fixed (server-supplied number; reflect verbatim).',
          },
          issuesAcceptedRisk: {
            type: 'number',
            description:
              'Issues marked accepted-risk (server-supplied number; reflect verbatim).',
          },
          issuesRemaining: {
            type: 'number',
            description:
              'Open issues at runbook generation time (server-supplied number).',
          },
          blockingRemaining: {
            type: 'number',
            description:
              'Open blocking-severity issues at runbook generation time (server-supplied number).',
          },
          summaryNarrative: {
            type: 'string',
            description:
              '2-3 sentence narrative of overall data quality, written for non-technical stakeholders. Reference the issue counts in context.',
          },
          keyFindings: {
            type: 'array',
            items: { type: 'string' },
            description:
              '3-6 specific findings worth highlighting (e.g., "12% of customer records have missing tax IDs that documentation requires"). Each finding should reference a concrete pattern the migration team should know about.',
          },
        },
        required: [
          'totalIssuesFound',
          'issuesFixed',
          'issuesAcceptedRisk',
          'issuesRemaining',
          'blockingRemaining',
          'summaryNarrative',
          'keyFindings',
        ],
      },
      executionPlan: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stepNumber: {
              type: 'number',
              description:
                'Step ordinal starting at 1. Steps are executed in order.',
            },
            title: {
              type: 'string',
              description:
                'Short step title (≤ 60 chars), action-oriented (e.g., "Pre-flight verification", "Load lookup tables", "Promote to target").',
            },
            description: {
              type: 'string',
              description:
                'What to do in this step. Reference the Migration Execution Package (.sql file) sections where applicable. Be specific about commands and expected outcomes.',
            },
            verificationCriteria: {
              type: 'array',
              items: { type: 'string' },
              description:
                '1-3 specific checks the operator runs before moving to the next step. Each check should be objectively verifiable (e.g., "Confirm row count in Account table equals approved mapping count of 12,453").',
            },
          },
          required: [
            'stepNumber',
            'title',
            'description',
            'verificationCriteria',
          ],
        },
        description:
          '6-8 ordered execution steps covering pre-checks, extract, transform/load per table group, post-load validation, business validation, and sign-off.',
      },
      validationCriteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterion: {
              type: 'string',
              description:
                'Short criterion name (e.g., "Record Count Reconciliation", "FK Integrity").',
            },
            threshold: {
              type: 'string',
              description:
                'Quantified threshold the criterion is measured against (e.g., "Source count (post-filter) = Target count ±0.5%").',
            },
            passCondition: {
              type: 'string',
              description:
                'Explicit pass condition (e.g., "All tables within threshold"; "Zero orphan FKs").',
            },
          },
          required: ['criterion', 'threshold', 'passCondition'],
        },
        description:
          '5-8 validation criteria covering record counts, FK integrity, picklist validation, aggregate reconciliation, null checks.',
      },
      rollbackProcedure: {
        type: 'string',
        description:
          '2-3 sentence procedure for reverting the migration. Reference the Execution Package rollback section. Be specific about what gets restored and what the operator must verify.',
      },
    },
    required: [
      'executiveSummary',
      'preMigrationChecklist',
      'mappingSpecification',
      'transformationRules',
      'dataQualityAssessment',
      'executionPlan',
      'validationCriteria',
      'rollbackProcedure',
    ],
  },
}

/**
 * Declared in 12.1, used in 12.3.
 *
 * Used by: `outputs_execution_package_compartmentalized`
 * (lib/actions/execution-package.ts:460) — the only streaming
 * callsite. Sub-commit 12.3 wires it into callLLMStreaming. The shape
 * matches the existing `ClaudeFileEntry` interface.
 */
export const EMIT_COMPARTMENTALIZED_PACKAGE_TOOL: Tool = {
  name: 'emit_compartmentalized_package',
  description:
    'Emit a multi-file execution package: one or more checklist, table_script, validation, promote, and rollback files. Each file has a filename, a type tag, and the SQL/markdown content. table_script files declare a load_order index and may list dependencies (filenames they must run after). The system prompt details the per-type content requirements.\n\nFile execution order: checklist runs first (pre-execution sanity), then table_script files in load_order respecting dependencies, then validation, then promote (post-validation hand-off), with rollback paired to promote for reversal.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filename: {
              type: 'string',
              description:
                'Filename suitable for a downloaded zip entry (e.g., "01_checklist.md", "10_load_account.sql"). Use a numeric prefix to encode execution order.',
            },
            type: {
              type: 'string',
              enum: [
                'checklist',
                'table_script',
                'validation',
                'promote',
                'rollback',
              ],
              description:
                'File type drives downstream packaging. "checklist" = pre-execution sanity checks (one file per package); "table_script" = SQL to load one target table (one per table, with load_order); "validation" = post-load checks (one file per package); "promote" = post-validation hand-off SQL; "rollback" = reversal SQL paired with promote.',
            },
            content: {
              type: 'string',
              description:
                'File content. Markdown for checklist; SQL for table_script/validation/promote/rollback. Include comments where the operator needs context.',
            },
            table_name: {
              type: 'string',
              description:
                'Required for table_script files. Bare target table name this script loads.',
            },
            load_order: {
              type: 'number',
              description:
                'Required for table_script files. Integer load order respecting FK dependencies (parent tables before children).',
            },
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Required for table_script files when this file depends on prior files completing. Array of filenames (matching the filename property of those files) that must run before this one.',
            },
          },
          required: ['filename', 'type', 'content'],
        },
        description:
          'Array of files comprising the multi-file execution package. Order matters within table_script files (load_order resolves dependencies); the runbook (checklist), validation, promote, and rollback files run in that order around the table_script load.',
      },
    },
    required: ['files'],
  },
}

// ─── Queries cluster (1 tool) ─────────────────────────────────────────────────

/**
 * Used by: `nl_suggest_queries` (lib/actions/query.ts:481). The system
 * prompt says "Return ONLY a JSON array of 4 strings"; Anthropic tools
 * require objects, so the array is wrapped under `suggestions`. The
 * callsite reads `result.toolUse.input.suggestions` and treats it as
 * the array.
 */
export const EMIT_QUERY_SUGGESTIONS_TOOL: Tool = {
  name: 'emit_query_suggestions',
  description:
    'Emit exactly 4 plain-English query suggestions for exploring the source data described in the prompt. Wrap them under the "suggestions" property of the tool input. Each suggestion is ≤ 80 characters, covers a different query pattern (filtering / aggregation / data-quality / joins), and at least one targets a data-quality concern.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'string',
          description:
            'One plain-English question (≤ 80 chars). Phrase as a question or imperative the user might ask of source data — "What\'s the average order value by month?", "Which contacts have invalid email formats?". Avoid SQL keywords; the downstream NL-to-SQL converter handles the translation.',
        },
        description:
          'Exactly 4 suggestion strings. Diversify across query patterns: at least one filtering query, one aggregation, one data-quality check, and one join or relational query.',
      },
    },
    required: ['suggestions'],
  },
}

// ─── SQL/text cluster (PR 12.2 sub-sub-commit B-1) ────────────────────────────

/**
 * Used by: `nl_to_sql` (lib/actions/query.ts:212) and the parse/run-failure
 * retry path `nl_to_sql_retry` (lib/actions/query.ts:282). Both callsites
 * pass the same tool — the retry differs by user message + parentCallId, not
 * by output schema.
 *
 * Replaces the legacy text+`extractSelectSQL` regex pipeline with a
 * schema-validated string. The fence-stripping post-processor in
 * `lib/ai/sql-extractor.ts` stays in place for the flag-OFF path; under
 * flag-ON it is bypassed because tool-use guarantees a clean string.
 *
 * The tool emits a single SELECT statement, never DML. A persistent system-
 * prompt rule already enforces SELECT-only; the schema mirrors that as a
 * description-level constraint (Anthropic strict mode does not support
 * pattern/format constraints on string types — see
 * docs/anthropic-strict-mode-constraints.md §4-5).
 */
export const EMIT_SQL_QUERY_TOOL: Tool = {
  name: 'emit_sql_query',
  description:
    "Emit ONE PostgreSQL SELECT statement answering the natural-language question in the prompt. The query runs against the schema described in the prompt's `<schema>` block — every referenced table and column MUST appear in that schema; do not invent identifiers.\n\nREQUIRED:\n• A single statement starting with SELECT (no semicolon-separated multi-statements)\n• Every column reference is qualified with its table name when more than one table is in scope\n• Casing matches the schema exactly — Postgres is case-sensitive when identifiers are double-quoted\n• Defensive numeric/date casting when the schema describes the field as VARCHAR but the question implies numeric/date semantics: NULLIF(TRIM(field), '') before ::numeric or ::date; strip currency symbols ($, ,) before numeric cast; regex-guard with ~ '^-?[0-9]+(\\.[0-9]+)?$' before any ::numeric cast\n• When the question references a likely-corrupt field (the schema's profile lists format_issues_count > 0), prefer DISTINCT or LENGTH(field) over a numeric/date comparison — surface the data quality issue rather than crash the query\n\nFORBIDDEN:\n• DDL keywords: DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE\n• DML keywords: INSERT, UPDATE, DELETE, MERGE\n• References to system schemas: pg_catalog, information_schema, auth.*, storage.*\n• Multiple statements (one SELECT per call)\n\nThe `query` property carries the executable SQL. The `explanation` property is a 1-2 sentence reviewer-facing description of what the query does and what data it returns — useful when the user later reviews the query history.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description:
          'The complete SELECT statement. No leading/trailing whitespace, no markdown fences, no comments. A single statement (one terminating semicolon optional). Must satisfy the REQUIRED/FORBIDDEN rules in the tool description.',
      },
      explanation: {
        type: 'string',
        description:
          'A 1-2 sentence reviewer-facing description of what the query does and what shape the result takes (e.g., "Returns the count of customers per state, ordered descending by count"). Plain English; no SQL syntax in the explanation.',
      },
      assumptions: {
        type: 'array',
        items: {
          type: 'string',
          description:
            'One assumption made when constructing the query (e.g., "Treated NULL annual_revenue as 0 in the SUM aggregate", "Filtered to status IN (\'active\', \'pending\') based on the question\'s intent"). Phrase as the action the query takes, not as a question.',
        },
        description:
          'Optional list of assumptions the query encodes when the question was ambiguous. Empty or omitted when the question was unambiguous and the schema fully constrained the answer.',
      },
    },
    required: ['query', 'explanation'],
  },
}

/**
 * Used by: `transform_generate` (lib/actions/transformations.ts:1331). Emits
 * a SQL transformation expression that maps a source field's value to its
 * target field. The expression is later wrapped by `wrapWithNullGuard` and
 * stored in the `transformations` table; downstream the expression composes
 * into a project-wide INSERT-from-SELECT bundle.
 *
 * Critical distinction from EMIT_SQL_QUERY_TOOL: this is an EXPRESSION (no
 * SELECT keyword), not a statement. Examples: `REGEXP_REPLACE(row_data->>'amount', '[$,]', '', 'g')::numeric`,
 * `CASE row_data->>'status' WHEN 'Won' THEN 'Closed Won' ELSE row_data->>'status' END`.
 *
 * The downstream `extractTransformSQL` post-processor stays in place for the
 * flag-OFF path; under flag-ON the input.sql is consumed directly and the
 * `wrapWithNullGuard` wrapper applies as before.
 */
export const EMIT_TRANSFORM_SQL_TOOL: Tool = {
  name: 'emit_transform_sql',
  description:
    "Emit ONE PostgreSQL expression that transforms a source field's value into the target field's representation. This is an EXPRESSION (no SELECT keyword, no FROM clause) — it will be wrapped into a project-wide INSERT...SELECT statement by the downstream pipeline.\n\nThe expression operates on JSONB-extracted values: source fields are accessed via `row_data->>'FieldName'` (text extraction). The target type drives the output: when the target is numeric, end with `::numeric` (or the specific numeric subtype); when boolean, end with `::boolean` or a CASE expression; when text, plain string-typed expression.\n\nREQUIRED:\n• A single SQL expression with no leading/trailing keywords (no SELECT, no FROM, no WHERE)\n• All source field accesses use `row_data->>'<bare field name>'` — never qualified table.field\n• Numeric casts are regex-guarded when the source field's profile shows format issues: `WHEN row_data->>'X' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (row_data->>'X')::numeric ELSE NULL END`\n• Date parsing handles mixed formats via CASE+regex when the source profile shows format_issues_count > 0\n• String truncation for VARCHAR(N) targets is explicit: `LEFT(row_data->>'X', N)` when the source max_length exceeds N\n• Boolean normalization expands the canonical Y/N/yes/no/1/0/true/false set: CASE-WHEN with case-insensitive matching\n\nFORBIDDEN:\n• DDL/DML keywords (this is an expression context — SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP all rejected at the wrapper)\n• References to tables other than the implicit source row context\n• Window functions (ROW_NUMBER, RANK, etc.) — the wrapping INSERT...SELECT does not allow window functions in this position; use a deterministic CASE/CAST instead\n• Cross-row references — each transformation operates on a single row's data\n\nThe `sql` property carries the expression. The `description` property is a one-line plain-English summary of what the transformation does, used in audit logs. The `source_columns` array names every source field referenced in the expression. The `target_column` is the bare target field name being populated. The `joins` property is reserved for future cross-table flows; today it is omitted.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sql: {
        type: 'string',
        description:
          'The complete transformation expression — a single PostgreSQL expression with no SELECT/FROM/WHERE keywords, no leading/trailing whitespace, no markdown fences, no comments. Operates on `row_data->>\'<field>\'` JSONB extracts. Casts to the target type when the source type differs. Must satisfy the REQUIRED/FORBIDDEN rules in the tool description.',
      },
      description: {
        type: 'string',
        description:
          'One-line plain-English summary (≤ 120 chars) of the transformation logic. Phrase as the action it performs ("Strip currency formatting and cast to NUMERIC", "Normalize Y/N values to canonical TRUE/FALSE booleans"). Used by audit logs and future explanation surfaces.',
      },
      source_columns: {
        type: 'array',
        items: {
          type: 'string',
          description:
            'One bare source field name (no table prefix, no row_data->> wrapping). Each name must appear in the source schema described in the prompt.',
        },
        description:
          'Array of every source field name referenced in the `sql` expression. Used to validate the expression against the schema and to populate the mapping_sources rows. Order matches the order each field is referenced in the SQL expression.',
      },
      target_column: {
        type: 'string',
        description:
          'The bare target field name being populated by this transformation. Must match the target field named in the prompt; the wrapper rejects mismatches.',
      },
      joins: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: {
              type: 'string',
              description:
                'The source-side table name driving the join (e.g., the source field\'s home table when the expression needs a sibling table for context).',
            },
            to: {
              type: 'string',
              description:
                'The target-side table name (or another source table) the join points to. Must appear in the schema.',
            },
            on: {
              type: 'string',
              description:
                'The join predicate as a SQL fragment (e.g., "src.customer_id = ref.id"). Anchored on bare table names; the wrapper handles row_data extraction.',
            },
          },
          required: ['from', 'to', 'on'],
        },
        description:
          'Optional cross-table joins required by this transformation. Today the production pipeline does not exercise joins for transformation expressions; this property is reserved for future cross-table flows and may be omitted (empty array or absent) for all current callsites.',
      },
    },
    required: ['sql', 'description', 'source_columns', 'target_column'],
  },
}

/**
 * Used by: `manual_fix` (lib/actions/manual-fix.ts:205). Emits an
 * UPDATE/DELETE statement that mutates `data_rows` JSONB to repair the
 * data-quality issue described in the user's free-form prompt.
 *
 * Distinct from EMIT_FIX_OPTIONS_TOOL (PR 12.1) which emits 2-3 fix
 * proposals at varying risk levels. EMIT_FIX_SQL_TOOL emits ONE fix that
 * the user has already described in plain English — the AI translates
 * description → SQL, not problem → options.
 *
 * The downstream `validateFixSQL` (lib/quality/fix-sql-validator.ts) safety
 * check stays in place — tool-use guarantees a parseable string, not a
 * safe one. The 5-condition risk_level rubric mirrors EMIT_FIX_OPTIONS_TOOL
 * for consistency.
 */
export const EMIT_FIX_SQL_TOOL: Tool = {
  name: 'emit_fix_sql',
  description:
    "Emit ONE PostgreSQL UPDATE or DELETE statement implementing the fix the user described in plain English. The statement runs against `data_rows` JSONB and operates on the single table named in the prompt.\n\nREQUIRED:\n• A single statement starting with UPDATE or DELETE (no SELECT, no multi-statement bundles)\n• `WHERE table_id = '<the exact uuid from the prompt>'` anchor on every statement — the wrapper validator rejects fixes that drop this filter\n• Use `row_data->>'FieldName'` for JSONB extraction; use `jsonb_set(row_data, '{FieldName}', ...)` for in-place value updates; use `row_data || '{...}'::jsonb` to add a missing field; use `DELETE FROM data_rows WHERE ...` to drop rows\n• Regex-guard any numeric cast: `WHERE ... AND row_data->>'X' ~ '^-?[0-9]+(\\.[0-9]+)?$'` before applying ::numeric in either WHERE or SET\n• Date format fixes use the CASE+regex pattern with NULL-safe outer CASE so unparseable values keep their original row_data (never wrap a parse expression in to_jsonb directly)\n• Window functions only inside CTEs (WITH ... UPDATE ...). Bare OVER() in UPDATE SET is rejected by Postgres\n\nFORBIDDEN:\n• DDL keywords: DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE\n• References to tables other than `data_rows`\n• System schemas: pg_catalog, information_schema, auth.*, storage.*\n• LIMIT, FETCH FIRST, FETCH NEXT, OFFSET on the outer statement (the validator rejects these — fixes apply to all matching rows or to none; LIMIT inside a subquery is fine)\n• Multiple statements (single statement, optional trailing semicolon)\n• SQL comments (-- or /*...*/) — potential injection vectors\n\nRisk-level taxonomy: \"low\" = reversible non-destructive marker addition (e.g., flagging records via a new _review key in row_data). Originals fully preserved; revert restores exact pre-fix state.\n\n\"medium\" = reversible in-place value update preserving row identity (e.g., default-value fills, format normalization, value translation, currency cleanup). Settle's fix_snapshots table preserves the original row_data; revert restores values bit-for-bit. PREFER this tier when both medium and high formulations achieve the same logical result.\n\n\"high\" = row deletion (DELETE) OR CTE/window-function patterns. DELETE is reversible via re-INSERT but row IDs change; CTE patterns can land non-revertable if the user opts out of snapshotting. AVOID CTE patterns when a flat UPDATE achieves the same logical result.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sql: {
        type: 'string',
        description:
          'The complete UPDATE or DELETE statement — a single statement with no leading/trailing whitespace, no markdown fences, no SQL comments. MUST include `WHERE table_id = \'<the table_id from the prompt>\'` as a safety anchor. MUST satisfy the REQUIRED/FORBIDDEN rules in the tool description; the downstream validateFixSQL validator rejects mismatches.',
      },
      description: {
        type: 'string',
        description:
          'One-line plain-English summary (≤ 200 chars) of what the fix does, written for a non-SQL reviewer. Phrase as the action the fix takes ("Replaces null `name` values with the literal string \"Anonymous\"", "Deletes rows where `email` does not match the RFC 5322 simplified pattern"). Used in audit logs and the fix-history UI.',
      },
      risk_level: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          '"low" = reversible non-destructive marker addition (e.g., flagging records via a new _review field). Originals fully preserved; revert restores exact pre-fix state.\n\n"medium" = reversible in-place value update preserving row identity (e.g., default-value fills, format normalization, value translation, casing standardization, currency cleanup). Settle\'s fix_snapshots table preserves the original row_data; revert restores values bit-for-bit. PREFER this tier when both medium and high formulations achieve the same result.\n\n"high" = row deletion (DELETE) OR CTE/multi-table-pattern updates. DELETE is reversible via re-INSERT but row IDs change. CTE patterns (including any fix using window functions, which require CTEs) can land in a non-revertable state if the user opts to skip snapshotting. AVOID CTE patterns when a flat UPDATE expression achieves the same logical result.',
      },
      downstream_impact: {
        type: 'string',
        description:
          'What BREAKS or improves in the migration if this fix is applied. Be specific about target tables and approximate record counts (e.g., "After this fix, Account inserts succeed for the 47 previously-NULL annual_revenue rows; values are filled with 0 and routed to a target review queue").',
      },
      tradeoff: {
        type: 'string',
        description:
          '1-2 sentence statement of what the fix gains AND loses (e.g., "Gains: zero data loss, all rows preserved. Loses: introduces $0 placeholder values that may need a second pass during business review"). Surface the cost of the fix so the user can compare against alternatives.',
      },
    },
    required: ['sql', 'description', 'risk_level', 'downstream_impact', 'tradeoff'],
  },
}

// ─── Phase 3 data-scanning tools (PR 3.3) ─────────────────────────────────────
//
// Three tools the agent loop registers alongside an "answer" tool to let
// the model probe project data before emitting a final decision. Each
// schema is paired with an RPC in migration 085 and a handler factory in
// `lib/ai/agent-tools.ts`. Spec: docs/investigations/pr-phase3.1-agent-design.md §B.
//
// Strict-mode posture (per docs/anthropic-strict-mode-constraints.md):
//   * additionalProperties: false on input_schema (no nested objects in
//     these schemas, but the top level is uniform)
//   * No oneOf, no min/max on numbers, no minItems/maxItems on arrays
//     (none of these schemas declare arrays in input)
//   * strict: true on each Tool

/**
 * Used by: `agent_query_field_data` RPC (migration 085 §B1). Sample N
 * row values for one field, optionally filtered by a strict-allowlist
 * single-condition where_filter.
 */
export const QUERY_FIELD_DATA_TOOL: Tool = {
  name: 'query_field_data',
  description:
    "Sample value(s) for a single field on the source table. Returns up to 50 row values; useful when the system prompt shows aggregate stats but the model needs to inspect individual values to decide on a rule, transformation, or quality check. The `where_filter` is optional; when supplied, it must be a single SQL fragment matching ONE column condition (e.g., \"row_data->>'status' IS NULL\"). Multiple conditions, joins, subqueries, and any DDL/DML are rejected.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_id: {
        type: 'string',
        description:
          'UUID of the source table to sample from. Must match a table present in the system-prompt schema block.',
      },
      field_name: {
        type: 'string',
        description:
          'Bare field name (no JSONB operators). The RPC extracts via row_data->>field_name internally.',
      },
      where_filter: {
        type: 'string',
        description:
          "Optional single-condition SQL fragment (e.g., \"row_data->>'status' IS NULL\"). Omit or pass empty string for unconditional sample. Keywords blocked: SELECT, INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE, BEGIN, COMMIT, JOIN, UNION, --, /*. Single condition only — multiple conditions joined by AND/OR are rejected.",
      },
      limit: {
        type: 'number',
        description:
          'Number of sample values to return. Server enforces ceiling of 50; values above 50 are clamped. Recommend 10-20 for general inspection, 5 for quick checks.',
      },
    },
    required: ['table_id', 'field_name'],
  },
}

/**
 * Used by: `agent_count_distinct_patterns` RPC (migration 085 §B2).
 * Returns most-frequent distinct values + frequencies for one field.
 */
export const COUNT_DISTINCT_PATTERNS_TOOL: Tool = {
  name: 'count_distinct_patterns',
  description:
    "For one field on the source table, return the most-frequent distinct values with row counts. Useful when deciding between an enum-style rule (small distinct set) and a regex/freeform rule (large distinct set). Returns up to 30 distinct values ordered by frequency desc; if the field has more than 30 distinct values, the response includes a `truncated: true` flag.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_id: {
        type: 'string',
        description:
          'UUID of the source table. Must match a table present in the system-prompt schema block.',
      },
      field_name: {
        type: 'string',
        description: 'Bare field name (no JSONB operators).',
      },
      limit: {
        type: 'number',
        description:
          'Number of distinct values to return. Server clamps to 30. Recommend 10-15 for enum candidates.',
      },
    },
    required: ['table_id', 'field_name'],
  },
}

/**
 * Used by: `agent_cross_field_correlation` RPC (migration 085 §B3).
 * Joint frequency stats for two fields on the same table + per-A
 * conditional null rates of B.
 */
export const CROSS_FIELD_CORRELATION_TOOL: Tool = {
  name: 'cross_field_correlation',
  description:
    "For a SINGLE table, return joint-frequency stats for two fields A and B: how often does each (A_value, B_value) pair appear, and what's the conditional null rate of B given each value of A. Use this when deciding cross-field rules (e.g., \"when status='Closed Won', amount must not be NULL\"). Returns up to 25 (A, B) pairs ordered by joint frequency desc, plus conditional null rates for the top 10 A values.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_id: {
        type: 'string',
        description:
          'UUID of the source table; both fields must reside on this table.',
      },
      field_a_name: {
        type: 'string',
        description: 'Bare name of the first field (the conditioning field).',
      },
      field_b_name: {
        type: 'string',
        description: 'Bare name of the second field (the conditioned field).',
      },
    },
    required: ['table_id', 'field_a_name', 'field_b_name'],
  },
}
