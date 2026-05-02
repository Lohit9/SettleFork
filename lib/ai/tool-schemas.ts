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
 * emit. Keep descriptions specific — Anthropic's prompting guidance
 * for tool use says descriptions should be ≥3-4 sentences for any
 * non-trivial tool. The system prompts of the consuming callsites
 * remain unchanged (the H1 flag-conditional design preserves the
 * legacy text path), so the tool description is the only place where
 * tool-specific guidance lives.
 *
 * Anthropic constraint: `input_schema.type` MUST be `'object'`. Tools
 * whose underlying contract is a top-level array (migration_intelligence,
 * nl_suggest_queries) wrap the array under a stable property name
 * (`patterns`, `suggestions`) — see the per-tool comments below.
 *
 * Pricing/cost note: tool definitions count toward input tokens. All
 * schemas here are kept as compact as the contract allows; large
 * descriptive text lives in the system prompt, not in the tool. A
 * one-shot follow-up (PR 12 §9.2) measures the input-token delta from
 * adding tools to confirm the cost overhead is acceptable.
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
 *   additionalProperties: false  — used everywhere a closed shape is
 *     known (the vast majority of nested objects).
 *   additionalProperties: true   — used on two free-form objects whose
 *     shape genuinely depends on a sibling enum:
 *       rule_config in emit_validation_rule (per rule_type)
 *       pattern_config in emit_extracted_patterns (per category)
 *     Without this, strict mode would force an empty object and break
 *     the per-type contract.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages'

// ─── Shared sub-shapes (factored for reuse) ───────────────────────────────────

const FIELD_MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source_field: { type: 'string' },
    target_field: { type: 'string' },
    confidence: { type: 'number', description: 'Integer 0-100.' },
    reasoning: { type: 'string' },
    similar_fields_considered: {
      type: 'array',
      items: { type: 'string' },
    },
    type_compatibility: { type: 'string' },
    needs_transformation: { type: 'boolean' },
    mapping_type: {
      type: 'string',
      enum: ['one_to_one', 'many_to_one', 'one_to_many'],
    },
    contributing_source_fields: {
      type: 'array',
      items: { type: 'string' },
    },
    combination_hint: { type: 'string' },
    split_hint: { type: 'string' },
  },
  required: ['source_field', 'target_field', 'confidence', 'reasoning'],
} as const

const TABLE_MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source_table: { type: 'string' },
    target_table: { type: 'string' },
    confidence: { type: 'number', description: 'Integer 0-100.' },
    reasoning: { type: 'string' },
    field_mappings: { type: 'array', items: FIELD_MAPPING_SCHEMA },
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
    'Emit the structured set of source-to-target table and field mappings produced for the schemas in the prompt. Each entry pairs a source table with a target table and contains all per-field mappings between them. Use bare table and field names (no schema prefixes). Confidence is 0-100 indicating how strongly you believe the mapping holds; reasoning is a short justification a reviewer can audit. Field mappings should appear under the table mapping that owns them; one_to_many and many_to_one mappings use contributing_source_fields/combination_hint/split_hint to express the multi-source/multi-target relationship.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_mappings: { type: 'array', items: TABLE_MAPPING_SCHEMA },
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
    'Emit field-level mappings for the unmapped source and target fields supplied in the prompt. The table-mapping context is already established; only field mappings are needed here. Use bare field names (no table prefixes). Each mapping must come from the supplied source-field list and target-field list — do not invent fields. Confidence is 0-100; reasoning is a short justification.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      field_mappings: { type: 'array', items: FIELD_MAPPING_SCHEMA },
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
    'Emit a single mapping suggestion for the target field in the prompt. Pick one or more source fields that all belong to the SAME source table; cross-table sources are not allowed. Use combination_type="single" iff exactly one source field is named, otherwise "concat_space" or "concat_comma". Confidence is 0-100. Rationale is a brief explanation, ≤ 280 characters.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source_field_names: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Bare field names (no table prefix), all from the same source table.',
      },
      combination_type: {
        type: 'string',
        enum: ['single', 'concat_space', 'concat_comma'],
      },
      confidence: { type: 'number', description: 'Integer 0-100.' },
      rationale: {
        type: 'string',
        description: 'Brief explanation, ≤ 280 characters.',
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
 * `rule_config` is intentionally free-form (additionalProperties: true)
 * because its shape varies by rule_type — see the per-type templates
 * in the system prompt. The downstream `validateRuleConfig` enforces
 * the per-type contract after the call.
 */
export const EMIT_VALIDATION_RULE_TOOL: Tool = {
  name: 'emit_validation_rule',
  description:
    "Emit a structured validation rule based on the natural-language description in the prompt. rule_type is one of the canonical types listed in the system prompt (not_null, unique, min_value, max_value, min_length, max_length, regex, allowed_values, range, date_after, date_before). rule_config's shape depends on rule_type — use the templates the system prompt enumerates. severity is 'blocking' (rule failures stop the migration) or 'warning' (informational only).",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Short rule name.' },
      description: {
        type: 'string',
        description: 'What this rule checks, in plain English.',
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
        ],
      },
      rule_config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Configuration whose shape depends on rule_type; see the system prompt for the per-type templates.',
      },
      severity: { type: 'string', enum: ['blocking', 'warning'] },
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
 * `checkConstraint` is left untyped (no `type` declared) because its
 * shape is a discriminated union (in_list / regex / range / custom)
 * plus null. Strict mode tolerates this — no `type` means "any JSON".
 */
export const EMIT_PARSED_DDL_TOOL: Tool = {
  name: 'emit_parsed_ddl',
  description:
    'Emit the structured parse of all CREATE TABLE definitions found in the DDL script. Handle any SQL dialect (PostgreSQL, MySQL, Oracle, SQL Server, SAP HANA, DB2). Use the canonical type name with precision/scale where present (e.g., VARCHAR(255), DECIMAL(18,2)). For CHECK constraints, populate checkConstraint with one of the templates listed in the system prompt (in_list / regex / range / custom); set checkConstraint to null when no CHECK exists. Set fkReference to null when not a foreign key. Set defaultValue to null when no default is declared.',
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
            name: { type: 'string' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  dataType: { type: 'string' },
                  isNullable: { type: 'boolean' },
                  isPrimaryKey: { type: 'boolean' },
                  isForeignKey: { type: 'boolean' },
                  fkReference: { type: ['string', 'null'] },
                  defaultValue: { type: ['string', 'null'] },
                  checkConstraint: {
                    description:
                      "One of the CHECK templates from the system prompt, or null. Shape: { type: 'in_list' | 'regex' | 'range' | 'custom', ... }.",
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
            },
          },
          required: ['name', 'fields'],
        },
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
            field_name: { type: 'string' },
            corrections: {
              type: 'object',
              additionalProperties: false,
              properties: {
                is_nullable: { type: 'boolean' },
                is_primary_key: { type: 'boolean' },
                is_foreign_key: { type: 'boolean' },
                fk_reference: { type: ['string', 'null'] },
                inferred_type: { type: 'string' },
                data_type: { type: 'string' },
              },
            },
            reasoning: { type: 'string' },
            known_issues: { type: 'string' },
          },
          required: ['field_name', 'corrections', 'reasoning'],
        },
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
    'Emit confident matches between unmatched DDL tables and existing database tables based on field-name overlap and semantic name equivalence. Prefer precision over recall — if you are not confident about a match, omit it entirely. Each existing table id matches at most one DDL table.',
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
            ddl_table_name: { type: 'string' },
            existing_table_id: { type: 'string' },
          },
          required: ['ddl_table_name', 'existing_table_id'],
        },
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
 * `pattern_config` is free-form (additionalProperties: true) because
 * its shape varies by category (transformation_recipe vs
 * data_quality_pattern vs domain_knowledge vs source_system_hint) —
 * see the per-category templates in the system prompt.
 */
export const EMIT_EXTRACTED_PATTERNS_TOOL: Tool = {
  name: 'emit_extracted_patterns',
  description:
    'Emit generalizable migration patterns extracted from the completed project context in the prompt. Wrap your patterns array under the "patterns" property of the tool input. Patterns must be reusable across different source/target systems — do not embed project-specific names. Generate 8-15 patterns; prioritize transformation_recipe and data_quality_pattern categories. Each pattern_config follows the per-category templates in the system prompt.',
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
            },
            title: {
              type: 'string',
              description: 'Short descriptive title (≤ 60 chars).',
            },
            pattern_description: {
              type: 'string',
              description: '2-3 sentence description for prompt injection.',
            },
            pattern_config: {
              type: 'object',
              additionalProperties: true,
              description:
                'Structured metadata; per-category shape per system prompt.',
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'category',
            'title',
            'pattern_description',
            'pattern_config',
            'tags',
          ],
        },
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
    'Emit data-quality issues newly identified in the table context provided in the prompt. Skip issues already present in <existing_issues>. Each verification_sql must be a SELECT that includes a WHERE table_id filter (using the table_id supplied in the prompt). severity is "blocking" (cannot proceed without resolution) or "warning" (informational). estimated_count is a rough integer estimate of affected rows. cross_field is set when the issue spans multiple fields.',
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
            field_name: { type: 'string' },
            cross_field: { type: 'string' },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['blocking', 'warning'] },
            estimated_count: { type: 'number', description: 'Non-negative integer.' },
            verification_sql: { type: 'string' },
            reasoning: { type: 'string' },
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
      },
    },
    required: ['proposed_issues'],
  },
}

/**
 * Used by: `quality_fix_options` (lib/quality/fix-engine.ts:421).
 * Shape mirrors `ClaudeFixResponse` / `FixOption`.
 */
export const EMIT_FIX_OPTIONS_TOOL: Tool = {
  name: 'emit_fix_options',
  description:
    "Emit 2-3 fix options for the data-quality issue described in the prompt. Each option is a complete fix proposal: label, plain-English description, the exact SQL to execute (must include WHERE table_id = '<uuid>'), the tradeoff, the per-fix downstream impact, a risk_level (low/medium/high), and an estimate of rows affected. root_cause and downstream_impact at the top level explain why the issue exists and what breaks if it is left unfixed.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      root_cause: { type: 'string' },
      downstream_impact: { type: 'string' },
      fix_options: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
            sql: { type: 'string' },
            tradeoff: { type: 'string' },
            downstream_impact: { type: 'string' },
            risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
            estimated_rows_affected: { type: 'number', description: 'Non-negative integer.' },
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
    'Emit the structured content for a Migration Runbook DOCX. The system prompt enumerates exact field requirements per section. preMigrationChecklist is an array of plain-English action items. mappingSpecification, transformationRules, executionPlan, validationCriteria, and dataQualityAssessment.keyFindings are arrays sized to the project. The server fills in stats fields (totalSourceRecords, etc.) and the cover block; this tool only emits the AI-generated narrative content.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      executiveSummary: { type: 'string' },
      preMigrationChecklist: { type: 'array', items: { type: 'string' } },
      mappingSpecification: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceTable: { type: 'string' },
            targetTable: { type: 'string' },
            fieldCount: { type: 'number', description: 'Non-negative integer.' },
            keyTransformations: {
              type: 'array',
              items: { type: 'string' },
            },
            unmappedFields: { type: 'array', items: { type: 'string' } },
          },
          required: [
            'sourceTable',
            'targetTable',
            'fieldCount',
            'keyTransformations',
            'unmappedFields',
          ],
        },
      },
      transformationRules: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetField: { type: 'string' },
            sourceField: { type: 'string' },
            ruleDescription: { type: 'string' },
            valueMappingTable: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string' },
                  target: { type: 'string' },
                },
                required: ['source', 'target'],
              },
            },
          },
          required: ['targetField', 'sourceField', 'ruleDescription'],
        },
      },
      dataQualityAssessment: {
        type: 'object',
        additionalProperties: false,
        properties: {
          totalIssuesFound: { type: 'number', description: 'Non-negative integer.' },
          issuesFixed: { type: 'number', description: 'Non-negative integer.' },
          issuesAcceptedRisk: { type: 'number', description: 'Non-negative integer.' },
          issuesRemaining: { type: 'number', description: 'Non-negative integer.' },
          blockingRemaining: { type: 'number', description: 'Non-negative integer.' },
          summaryNarrative: { type: 'string' },
          keyFindings: { type: 'array', items: { type: 'string' } },
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
            stepNumber: { type: 'number', description: 'Step ordinal, starting at 1.' },
            title: { type: 'string' },
            description: { type: 'string' },
            verificationCriteria: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: [
            'stepNumber',
            'title',
            'description',
            'verificationCriteria',
          ],
        },
      },
      validationCriteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterion: { type: 'string' },
            threshold: { type: 'string' },
            passCondition: { type: 'string' },
          },
          required: ['criterion', 'threshold', 'passCondition'],
        },
      },
      rollbackProcedure: { type: 'string' },
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
    'Emit a multi-file execution package: one or more checklist, table_script, validation, promote, and rollback files. Each file has a filename, a type tag, and the SQL/markdown content. table_script files declare a load_order index and may list dependencies (filenames they must run after). The system prompt details the per-type content requirements.',
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
            filename: { type: 'string' },
            type: {
              type: 'string',
              enum: [
                'checklist',
                'table_script',
                'validation',
                'promote',
                'rollback',
              ],
            },
            content: { type: 'string' },
            table_name: { type: 'string' },
            load_order: { type: 'number', description: 'Non-negative integer.' },
            dependencies: { type: 'array', items: { type: 'string' } },
          },
          required: ['filename', 'type', 'content'],
        },
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
        items: { type: 'string' },
        description: 'Exactly 4 suggestion strings.',
      },
    },
    required: ['suggestions'],
  },
}
