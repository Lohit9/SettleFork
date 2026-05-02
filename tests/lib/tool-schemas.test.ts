// @vitest-environment node
//
// PR 12 sub-commit 12.1 — structural invariants over every tool schema
// in `lib/ai/tool-schemas.ts`.
//
// These tests catch schema-shape mistakes at CI time without making
// any Anthropic API calls. The bar is intentionally low — the schemas
// can express any callsite-specific contract — but a few invariants
// hold for every schema we ship.

import { describe, it, expect } from 'vitest'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import * as schemas from '@/lib/ai/tool-schemas'

const allTools: Tool[] = Object.values(schemas).filter(
  (s): s is Tool =>
    typeof s === 'object' &&
    s !== null &&
    'name' in s &&
    'input_schema' in s,
)

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
