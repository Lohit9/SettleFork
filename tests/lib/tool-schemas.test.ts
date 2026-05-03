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

/**
 * Walks every property in a JSON Schema node, invoking visit(path, prop)
 * for each leaf-level property and each composite property's container.
 * Path is built from the property names traversed.
 */
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
  it('exports the expected count of tools (PR 12 §6: 13 distinct schemas)', () => {
    expect(allTools.length).toBe(13)
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
    // Strict mode is Settle's API-boundary deterministic-validation
    // layer per the product principle "AI proposes → Deterministic
    // validates → Human approves". It catches missing required fields,
    // extra fields, and type drift before any downstream consumer
    // sees the response. Strict mode requires `additionalProperties`
    // on every nested object — the per-schema additions are documented
    // in lib/ai/tool-schemas.ts.
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
        // Skip pure container nodes (e.g., a `properties` object that's
        // really a string lookup of named child schemas) — only report
        // on nodes whose siblings include type/items/properties (i.e.,
        // actual schema nodes the model reads).
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

    // Spot-check one canonical pattern_type from each of the 4 categories
    expect(patternConfigDesc).toContain('currency_cleanup') // transformation_recipe
    expect(patternConfigDesc).toContain('null_violation') // data_quality_pattern
    expect(patternConfigDesc).toContain('entity_relationship_model') // domain_knowledge
    expect(patternConfigDesc).toContain('legacy_format_quirk') // source_system_hint
  })

  it('the canonical-patterns module exports the expected category counts', () => {
    // 12 transformation_recipe + 8 data_quality + 4 domain_knowledge + 4 source_system_hint = 28
    expect(Object.keys(ALL_CANONICAL_PATTERNS).length).toBe(28)
  })
})

// ─── PR 12.1.5 B-1: severity rubric anchored in 5 blocking conditions ────────

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
      (schemas.EMIT_QUALITY_ISSUES_TOOL.input_schema.properties as Record<
        string,
        JsonSchemaNode
      >).proposed_issues.items?.properties?.severity
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
      (schemas.EMIT_FIX_OPTIONS_TOOL.input_schema.properties as Record<
        string,
        JsonSchemaNode
      >).fix_options.items?.properties?.risk_level
    )?.description
    expect(riskLevelDesc).toBeDefined()
    if (!riskLevelDesc) return
    expect(riskLevelDesc).toContain('"low"')
    expect(riskLevelDesc).toContain('"medium"')
    expect(riskLevelDesc).toContain('"high"')
    // CTE caveat — the load-bearing risk-level decision
    expect(riskLevelDesc).toContain('CTE')
    expect(riskLevelDesc).toContain('non-revertable')
  })
})

// ─── PR 12.1.5 B-3: custom_sql in rule_type enum ─────────────────────────────

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
    // The selection-criteria text — biases the AI toward structured types
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

// ─── PR 12.1.5 B-2: enum tightenings + checkConstraint flat-object ───────────

describe('tool-schemas — B-2 enum tightenings + checkConstraint (PR 12.1.5 B-2)', () => {
  it('EMIT_SCHEMA_CORRECTIONS_TOOL.inferred_type is enum with 14 semantic types', () => {
    const inferredTypeNode = (
      (schemas.EMIT_SCHEMA_CORRECTIONS_TOOL.input_schema.properties as Record<
        string,
        JsonSchemaNode
      >).corrections.items?.properties?.corrections?.properties?.inferred_type
    )
    expect(inferredTypeNode).toBeDefined()
    if (!inferredTypeNode) return
    const enumValues = inferredTypeNode.enum as string[] | undefined
    expect(enumValues).toBeDefined()
    expect(enumValues?.length).toBe(14)
    // Spot-check a few canonical semantic types
    expect(enumValues).toContain('email')
    expect(enumValues).toContain('zip_code')
    expect(enumValues).toContain('id')
  })

  it('EMIT_PARSED_DDL_TOOL.checkConstraint description encodes the 4 variants (oneOf fallback)', () => {
    const checkConstraintNode = (
      (schemas.EMIT_PARSED_DDL_TOOL.input_schema.properties as Record<
        string,
        JsonSchemaNode
      >).tables.items?.properties?.fields?.items?.properties?.checkConstraint
    )
    expect(checkConstraintNode).toBeDefined()
    if (!checkConstraintNode) return
    // Anthropic strict mode rejected oneOf (verified via probe);
    // variant guidance lives in the description instead.
    const desc = checkConstraintNode.description
    expect(desc).toBeDefined()
    if (!desc) return
    expect(desc).toContain("'in_list'")
    expect(desc).toContain("'regex'")
    expect(desc).toContain("'range'")
    expect(desc).toContain("'custom'")
  })
})
