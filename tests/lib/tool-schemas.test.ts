// @vitest-environment node
//
// PR 12 sub-commit 12.1 — structural invariants over every tool schema
// in `lib/ai/tool-schemas.ts`.
//
// These tests catch schema-shape mistakes at CI time without making
// any Anthropic API calls. The bar is intentionally low — the schemas
// can express any callsite-specific contract — but a few invariants
// hold for every schema we ship.
//
// PR 12.1.5 B-1 extended the invariants to enforce description quality:
// every property has a description ≥ 30 chars; every tool description
// is ≥ 200 chars (rich tier); EMIT_EXTRACTED_PATTERNS_TOOL references
// the canonical pattern vocabulary inline.

import { describe, it, expect } from 'vitest'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import * as schemas from '@/lib/ai/tool-schemas'
import { ALL_CANONICAL_PATTERNS } from '@/lib/ai/canonical-patterns'

const allTools: Tool[] = Object.values(schemas).filter(
  (s): s is Tool =>
    typeof s === 'object' &&
    s !== null &&
    'name' in s &&
    'input_schema' in s,
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface JsonSchemaNode {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  enum?: unknown[]
  required?: string[]
  additionalProperties?: boolean | JsonSchemaNode
  oneOf?: JsonSchemaNode[]
  anyOf?: JsonSchemaNode[]
}

function walkProperties(
  node: JsonSchemaNode,
  visit: (path: string, prop: JsonSchemaNode) => void,
  path = '',
): void {
  if (!node || typeof node !== 'object') return

  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      const childPath = path ? `${path}.${key}` : key
      visit(childPath, child)
      walkProperties(child, visit, childPath)
    }
  }
  if (node.items) {
    walkProperties(node.items, visit, `${path}[]`)
  }
  if (node.oneOf) {
    for (const [i, variant] of node.oneOf.entries()) {
      walkProperties(variant, visit, `${path}|oneOf[${i}]`)
    }
  }
  if (node.anyOf) {
    for (const [i, variant] of node.anyOf.entries()) {
      walkProperties(variant, visit, `${path}|anyOf[${i}]`)
    }
  }
}

// ─── Existing invariants from PR 12 sub-commit 12.1 ──────────────────────────

describe('tool-schemas — structural invariants', () => {
  it('exports the expected count of tools (PR 12.1: 13 + PR 12.2 B-1: 3 SQL emitters + PR 3.3: 3 data-scanning tools + PR 3.4cd: 4 multi-agent answer tools = 23)', () => {
    expect(allTools.length).toBe(23)
  })

  it('every tool has a snake_case name (lowercase letters + underscores)', () => {
    for (const tool of allTools) {
      expect(
        tool.name,
        `tool ${tool.name}: name must be snake_case`,
      ).toMatch(/^[a-z][a-z_]*$/)
    }
  })

  it('every tool has a description ≥ 50 characters', () => {
    for (const tool of allTools) {
      expect(
        tool.description?.length ?? 0,
        `tool ${tool.name}: description too short for the model to use confidently`,
      ).toBeGreaterThanOrEqual(50)
    }
  })

  it('every tool sets strict=true (Anthropic API-boundary deterministic validation)', () => {
    for (const tool of allTools) {
      expect(
        tool.strict,
        `tool ${tool.name}: must set strict=true`,
      ).toBe(true)
    }
  })

  it('every input_schema declares type="object" (Anthropic constraint)', () => {
    for (const tool of allTools) {
      expect(
        tool.input_schema.type,
        `tool ${tool.name}: input_schema.type must be "object" per Anthropic SDK`,
      ).toBe('object')
    }
  })

  it('every tool declares at least one required field', () => {
    for (const tool of allTools) {
      const required = tool.input_schema.required as string[] | undefined
      expect(
        Array.isArray(required),
        `tool ${tool.name}: input_schema.required must be an array`,
      ).toBe(true)
      expect(
        (required ?? []).length,
        `tool ${tool.name}: at least one required field expected`,
      ).toBeGreaterThan(0)
    }
  })

  it('every tool name is unique across the export set', () => {
    const names = allTools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('tool-schemas — top-level array wrappers (Anthropic input must be object)', () => {
  it('emit_extracted_patterns wraps the top-level array under "patterns"', () => {
    const properties = schemas.EMIT_EXTRACTED_PATTERNS_TOOL.input_schema
      .properties as Record<string, unknown> | undefined
    expect(properties).toBeDefined()
    expect(properties?.patterns).toBeDefined()
    const required = schemas.EMIT_EXTRACTED_PATTERNS_TOOL.input_schema
      .required as string[] | undefined
    expect(required).toContain('patterns')
  })

  it('emit_query_suggestions wraps the top-level array under "suggestions"', () => {
    const properties = schemas.EMIT_QUERY_SUGGESTIONS_TOOL.input_schema
      .properties as Record<string, unknown> | undefined
    expect(properties).toBeDefined()
    expect(properties?.suggestions).toBeDefined()
    const required = schemas.EMIT_QUERY_SUGGESTIONS_TOOL.input_schema
      .required as string[] | undefined
    expect(required).toContain('suggestions')
  })
})

// ─── PR 12.1.5 B-1: description quality invariants ───────────────────────────

describe('tool-schemas — description quality (PR 12.1.5 B-1)', () => {
  it('every tool description is ≥ 200 characters (rich-tier threshold)', () => {
    for (const tool of allTools) {
      expect(
        tool.description?.length ?? 0,
        `tool ${tool.name}: description below rich-tier threshold (${tool.description?.length ?? 0} chars). PR 12.1.5 enriches descriptions with decision criteria + edge cases.`,
      ).toBeGreaterThanOrEqual(200)
    }
  })

  it('every property in every tool has a description ≥ 30 characters', () => {
    const failures: string[] = []
    for (const tool of allTools) {
      walkProperties(tool.input_schema as JsonSchemaNode, (path, prop) => {
        const isSchemaNode =
          'type' in prop ||
          'items' in prop ||
          'properties' in prop ||
          'enum' in prop ||
          'oneOf' in prop ||
          'anyOf' in prop
        if (!isSchemaNode) return

        const desc = prop.description
        if (!desc || desc.length < 30) {
          failures.push(
            `${tool.name}: property "${path}" has ${desc ? `${desc.length}-char` : 'no'} description (must be ≥ 30 chars)`,
          )
        }
      })
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('EMIT_EXTRACTED_PATTERNS_TOOL.pattern_config description references the canonical pattern vocabulary', () => {
    const patternConfigDesc = (schemas.EMIT_EXTRACTED_PATTERNS_TOOL.input_schema
      .properties as Record<string, JsonSchemaNode>).patterns.items?.properties
      ?.pattern_config?.description
    expect(patternConfigDesc).toBeDefined()
    if (!patternConfigDesc) return

    expect(patternConfigDesc).toContain('currency_cleanup')
    expect(patternConfigDesc).toContain('null_violation')
    expect(patternConfigDesc).toContain('entity_relationship_model')
    expect(patternConfigDesc).toContain('legacy_format_quirk')
  })

  it('the canonical-patterns module exports the expected category counts', () => {
    expect(Object.keys(ALL_CANONICAL_PATTERNS).length).toBe(28)
  })
})

describe('tool-schemas — severity rubric (PR 12.1.5 B-1)', () => {
  it('EMIT_VALIDATION_RULE_TOOL.severity description enumerates the 5 blocking conditions', () => {
    const severityDesc = (schemas.EMIT_VALIDATION_RULE_TOOL.input_schema
      .properties as Record<string, JsonSchemaNode>).severity?.description
    expect(severityDesc).toBeDefined()
    if (!severityDesc) return
    expect(severityDesc).toContain('NOT NULL')
    expect(severityDesc).toContain('FK orphans')
    expect(severityDesc).toContain('PK uniqueness')
    expect(severityDesc).toContain('Type-conversion')
    expect(severityDesc).toContain('truncation')
  })

  it('EMIT_QUALITY_ISSUES_TOOL.severity description enumerates the same 5 blocking conditions', () => {
    const severityDesc = (
      (schemas.EMIT_QUALITY_ISSUES_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).proposed_issues.items?.properties?.severity
    )?.description
    expect(severityDesc).toBeDefined()
    if (!severityDesc) return
    expect(severityDesc).toContain('NOT NULL')
    expect(severityDesc).toContain('FK orphans')
    expect(severityDesc).toContain('PK uniqueness')
    expect(severityDesc).toContain('Type-conversion')
    expect(severityDesc).toContain('truncation')
  })
})

describe('tool-schemas — risk-level rubric (PR 12.1.5 B-1)', () => {
  it('EMIT_FIX_OPTIONS_TOOL.risk_level description encodes the 3 tiers + CTE caveat', () => {
    const riskLevelDesc = (
      (schemas.EMIT_FIX_OPTIONS_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).fix_options.items?.properties?.risk_level
    )?.description
    expect(riskLevelDesc).toBeDefined()
    if (!riskLevelDesc) return
    expect(riskLevelDesc).toContain('"low"')
    expect(riskLevelDesc).toContain('"medium"')
    expect(riskLevelDesc).toContain('"high"')
    expect(riskLevelDesc).toContain('CTE')
    expect(riskLevelDesc).toContain('non-revertable')
  })
})

describe('tool-schemas — custom_sql resolution (PR 12.1.5 B-3)', () => {
  it('EMIT_VALIDATION_RULE_TOOL.rule_type enum includes custom_sql', () => {
    const ruleTypeNode = (schemas.EMIT_VALIDATION_RULE_TOOL.input_schema
      .properties as Record<string, JsonSchemaNode>).rule_type
    const ruleTypeEnum = ruleTypeNode.enum as string[] | undefined
    expect(ruleTypeEnum).toBeDefined()
    expect(ruleTypeEnum).toContain('custom_sql')
    expect(ruleTypeEnum?.length).toBe(12)
  })

  it('EMIT_VALIDATION_RULE_TOOL.rule_type description guides custom_sql selection', () => {
    const desc = (schemas.EMIT_VALIDATION_RULE_TOOL.input_schema
      .properties as Record<string, JsonSchemaNode>).rule_type?.description
    expect(desc).toBeDefined()
    if (!desc) return
    expect(desc).toContain('custom_sql')
    expect(desc).toContain('only when')
    expect(desc).toMatch(/maintainability|bypass/i)
  })

  it('EMIT_VALIDATION_RULE_TOOL.rule_config description documents custom_sql template', () => {
    const desc = (schemas.EMIT_VALIDATION_RULE_TOOL.input_schema
      .properties as Record<string, JsonSchemaNode>).rule_config?.description
    expect(desc).toBeDefined()
    if (!desc) return
    expect(desc).toContain('custom_sql')
    expect(desc).toContain('SELECT-only')
    expect(desc).toContain('table_id')
  })
})

describe('tool-schemas — B-2 enum tightenings + checkConstraint (PR 12.1.5 B-2)', () => {
  it('EMIT_SCHEMA_CORRECTIONS_TOOL.inferred_type is enum with 14 semantic types', () => {
    const inferredTypeNode = (
      (schemas.EMIT_SCHEMA_CORRECTIONS_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).corrections.items?.properties?.corrections?.properties?.inferred_type
    )
    expect(inferredTypeNode).toBeDefined()
    if (!inferredTypeNode) return
    const enumValues = inferredTypeNode.enum as string[] | undefined
    expect(enumValues).toBeDefined()
    expect(enumValues?.length).toBe(14)
    expect(enumValues).toContain('email')
    expect(enumValues).toContain('zip_code')
    expect(enumValues).toContain('id')
  })

  it('EMIT_PARSED_DDL_TOOL.checkConstraint description encodes the 4 variants (oneOf fallback)', () => {
    const checkConstraintNode = (
      (schemas.EMIT_PARSED_DDL_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).tables.items?.properties?.fields?.items?.properties?.checkConstraint
    )
    expect(checkConstraintNode).toBeDefined()
    if (!checkConstraintNode) return
    const desc = checkConstraintNode.description
    expect(desc).toBeDefined()
    if (!desc) return
    expect(desc).toContain("'in_list'")
    expect(desc).toContain("'regex'")
    expect(desc).toContain("'range'")
    expect(desc).toContain("'custom'")
  })
})

// ─── Path 2 PR 1: additionalProperties: false uniformity ─────────────────────

describe('tool-schemas — additionalProperties uniformity (Path 2 PR 1)', () => {
  it('every nested object schema declares additionalProperties: false', () => {
    const failures: string[] = []
    for (const tool of allTools) {
      walkProperties(
        tool.input_schema as JsonSchemaNode,
        (path, prop) => {
          const isObjectNode =
            prop.type === 'object' ||
            (Array.isArray(prop.type) && prop.type.includes('object'))
          if (!isObjectNode) return
          if (prop.additionalProperties !== false) {
            failures.push(
              `${tool.name}: nested object at "${path}" must declare additionalProperties: false (got ${JSON.stringify(prop.additionalProperties)})`,
            )
          }
        },
      )
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('rule_config + pattern_config accept partial population (required is empty)', () => {
    const ruleConfig = (
      schemas.EMIT_VALIDATION_RULE_TOOL.input_schema.properties as Record<string, JsonSchemaNode>
    ).rule_config
    expect(ruleConfig.required ?? []).toEqual([])

    const patternConfig = (
      (schemas.EMIT_EXTRACTED_PATTERNS_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).patterns.items?.properties?.pattern_config
    )
    expect(patternConfig).toBeDefined()
    if (!patternConfig) return
    expect(patternConfig.required ?? []).toEqual([])
  })

  it('rule_config enumerates all 9 possible keys across 12 rule_types', () => {
    const properties = (
      (schemas.EMIT_VALIDATION_RULE_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).rule_config.properties as Record<string, JsonSchemaNode>
    )
    const expectedKeys = [
      'min',
      'max',
      'min_length',
      'max_length',
      'pattern',
      'description',
      'values',
      'date',
      'sql',
    ]
    for (const k of expectedKeys) {
      expect(properties).toHaveProperty(k)
    }
  })

  it('pattern_config enumerates the union of 4 per-category templates', () => {
    const properties = (
      (schemas.EMIT_EXTRACTED_PATTERNS_TOOL.input_schema.properties as Record<string, JsonSchemaNode>).patterns.items?.properties?.pattern_config?.properties as
        | Record<string, JsonSchemaNode>
        | undefined
    )
    expect(properties).toBeDefined()
    if (!properties) return
    expect(properties).toHaveProperty('pattern_type')
    expect(properties).toHaveProperty('approach')
    expect(properties).toHaveProperty('domain')
    expect(properties).toHaveProperty('system_type')
  })
})

// ─── PR 12.2 B-1: SQL emitter cluster (3 new tools) ──────────────────────────

describe('tool-schemas — EMIT_SQL_QUERY_TOOL (PR 12.2 B-1)', () => {
  it('exports with the expected name + strict mode', () => {
    expect(schemas.EMIT_SQL_QUERY_TOOL.name).toBe('emit_sql_query')
    expect(schemas.EMIT_SQL_QUERY_TOOL.strict).toBe(true)
  })

  it('requires query + explanation; assumptions optional', () => {
    const required = schemas.EMIT_SQL_QUERY_TOOL.input_schema.required as string[]
    expect(required).toEqual(['query', 'explanation'])
    const properties = schemas.EMIT_SQL_QUERY_TOOL.input_schema.properties as Record<
      string,
      JsonSchemaNode
    >
    expect(properties).toHaveProperty('assumptions')
    expect(required).not.toContain('assumptions')
  })

  it('description encodes SELECT-only + DDL/DML forbidden', () => {
    const desc = schemas.EMIT_SQL_QUERY_TOOL.description ?? ''
    expect(desc).toContain('SELECT')
    expect(desc).toContain('DROP')
    expect(desc).toContain('INSERT')
    expect(desc).toContain('UPDATE')
    expect(desc).toContain('DELETE')
    expect(desc).toMatch(/system schemas|pg_catalog/)
  })

  it('top-level + nested objects declare additionalProperties: false', () => {
    expect(schemas.EMIT_SQL_QUERY_TOOL.input_schema.additionalProperties).toBe(false)
  })
})

describe('tool-schemas — EMIT_TRANSFORM_SQL_TOOL (PR 12.2 B-1)', () => {
  it('exports with the expected name + strict mode', () => {
    expect(schemas.EMIT_TRANSFORM_SQL_TOOL.name).toBe('emit_transform_sql')
    expect(schemas.EMIT_TRANSFORM_SQL_TOOL.strict).toBe(true)
  })

  it('requires sql + description + source_columns + target_column; joins optional', () => {
    const required = schemas.EMIT_TRANSFORM_SQL_TOOL.input_schema.required as string[]
    expect(required).toEqual(['sql', 'description', 'source_columns', 'target_column'])
    expect(required).not.toContain('joins')
  })

  it('description encodes EXPRESSION (not statement) semantics', () => {
    const desc = schemas.EMIT_TRANSFORM_SQL_TOOL.description ?? ''
    expect(desc).toContain('EXPRESSION')
    expect(desc).toContain('row_data')
    expect(desc).toMatch(/jsonb|JSONB/i)
    expect(desc).toContain('regex')
  })

  it('joins.items is an object with from/to/on, all required', () => {
    const properties = schemas.EMIT_TRANSFORM_SQL_TOOL.input_schema.properties as Record<
      string,
      JsonSchemaNode
    >
    const joinsItems = properties.joins?.items
    expect(joinsItems).toBeDefined()
    if (!joinsItems) return
    expect(joinsItems.type).toBe('object')
    expect(joinsItems.additionalProperties).toBe(false)
    expect(joinsItems.required).toEqual(['from', 'to', 'on'])
  })
})

describe('tool-schemas — EMIT_FIX_SQL_TOOL (PR 12.2 B-1)', () => {
  it('exports with the expected name + strict mode', () => {
    expect(schemas.EMIT_FIX_SQL_TOOL.name).toBe('emit_fix_sql')
    expect(schemas.EMIT_FIX_SQL_TOOL.strict).toBe(true)
  })

  it('requires sql + description + risk_level + downstream_impact + tradeoff', () => {
    const required = schemas.EMIT_FIX_SQL_TOOL.input_schema.required as string[]
    expect(required).toEqual(['sql', 'description', 'risk_level', 'downstream_impact', 'tradeoff'])
  })

  it('risk_level is a 3-value enum (low/medium/high)', () => {
    const properties = schemas.EMIT_FIX_SQL_TOOL.input_schema.properties as Record<
      string,
      JsonSchemaNode
    >
    const riskLevel = properties.risk_level
    expect(riskLevel.type).toBe('string')
    expect(riskLevel.enum).toEqual(['low', 'medium', 'high'])
  })

  it('description encodes UPDATE/DELETE only + WHERE table_id anchor', () => {
    const desc = schemas.EMIT_FIX_SQL_TOOL.description ?? ''
    expect(desc).toContain('UPDATE')
    expect(desc).toContain('DELETE')
    expect(desc).toMatch(/table_id\s*=/)
    expect(desc).toContain('LIMIT')
    expect(desc).toContain('FORBIDDEN')
  })

  it('risk_level description encodes the 3 tiers + CTE caveat (mirrors EMIT_FIX_OPTIONS_TOOL rubric)', () => {
    const properties = schemas.EMIT_FIX_SQL_TOOL.input_schema.properties as Record<
      string,
      JsonSchemaNode
    >
    const riskDesc = properties.risk_level?.description ?? ''
    expect(riskDesc).toContain('"low"')
    expect(riskDesc).toContain('"medium"')
    expect(riskDesc).toContain('"high"')
    expect(riskDesc).toContain('CTE')
    expect(riskDesc).toContain('non-revertable')
  })
})

// ─── PR 3.3: data-scanning tool cluster (3 new schemas) ──────────────────────

describe('tool-schemas — PR 3.3 data-scanning tool cluster', () => {
  const dataScanningTools = [
    'query_field_data',
    'count_distinct_patterns',
    'cross_field_correlation',
  ]

  // (a) Tool count assertion is at the top of the file (16 → 19); this
  // describe block focuses on the new cluster's per-tool shape.

  it('(b) all 3 data-scanning tools satisfy strict-mode constraints across the catalog', () => {
    // Single sweep: additionalProperties: false, strict: true, no oneOf,
    // no minimum/maximum, no minItems/maxItems on any of the 3 schemas.
    for (const name of dataScanningTools) {
      const tool = allTools.find((t) => t.name === name)
      expect(tool, `tool ${name} not found`).toBeDefined()
      if (!tool) continue
      expect(tool.strict, `${name}: strict must be true`).toBe(true)
      expect(tool.input_schema.type).toBe('object')
      expect(
        (tool.input_schema as { additionalProperties?: unknown }).additionalProperties,
        `${name}: input_schema.additionalProperties must be false`,
      ).toBe(false)
      const json = JSON.stringify(tool.input_schema)
      expect(json, `${name}: must not contain oneOf`).not.toMatch(/"oneOf"/)
      expect(json, `${name}: must not contain minimum`).not.toMatch(/"minimum"/)
      expect(json, `${name}: must not contain maximum`).not.toMatch(/"maximum"/)
      expect(json, `${name}: must not contain minItems`).not.toMatch(/"minItems"/)
      expect(json, `${name}: must not contain maxItems`).not.toMatch(/"maxItems"/)
    }
  })

  it('(c) required-fields shape per tool: B1=[table_id,field_name], B2=[table_id,field_name], B3=[table_id,field_a_name,field_b_name]', () => {
    expect(schemas.QUERY_FIELD_DATA_TOOL.input_schema.required).toEqual([
      'table_id',
      'field_name',
    ])
    expect(schemas.COUNT_DISTINCT_PATTERNS_TOOL.input_schema.required).toEqual([
      'table_id',
      'field_name',
    ])
    expect(schemas.CROSS_FIELD_CORRELATION_TOOL.input_schema.required).toEqual([
      'table_id',
      'field_a_name',
      'field_b_name',
    ])
  })

  it('(d) canonical happy-path: each tool exports the 3 distinct names + 3 are in allTools', () => {
    const allNames = new Set(allTools.map((t) => t.name))
    for (const name of dataScanningTools) {
      expect(allNames.has(name), `${name} not in allTools`).toBe(true)
    }
    // Distinct names — no duplicates from accidental copy-paste
    expect(new Set(dataScanningTools).size).toBe(3)
  })
})
