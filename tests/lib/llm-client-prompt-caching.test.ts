// @vitest-environment node
//
// PR 13.1 — unit tests for `buildSystemParam` and `applyToolCache`,
// the pure helpers that thread `cache_control: { type: 'ephemeral' }`
// markers through the request shape.
//
// Pure functions, no SDK calls. The integration test at
// `tests/integration/llm-calls-prompt-caching.test.ts` exercises the
// wire path end-to-end (env-gated).

import { describe, it, expect } from 'vitest'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import { applyToolCache, buildSystemParam } from '@/lib/ai/llm-client'
import { EMIT_VALIDATION_RULE_TOOL } from '@/lib/ai/tool-schemas'

const SAMPLE_PROMPT = 'You are a helpful assistant. Respond concisely.'

// ─── buildSystemParam ────────────────────────────────────────────────────────

describe('buildSystemParam — cacheControl gate', () => {
  it('returns the prompt as a plain string when cacheControl is undefined', () => {
    const result = buildSystemParam(SAMPLE_PROMPT, undefined)
    expect(result).toBe(SAMPLE_PROMPT)
    expect(typeof result).toBe('string')
  })

  it('returns the prompt as a plain string when cacheControl is false', () => {
    const result = buildSystemParam(SAMPLE_PROMPT, false)
    expect(result).toBe(SAMPLE_PROMPT)
    expect(typeof result).toBe('string')
  })

  it('returns a TextBlockParam[] with cache_control when cacheControl is true', () => {
    const result = buildSystemParam(SAMPLE_PROMPT, true)
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result.length).toBe(1)
    const block = result[0]!
    expect(block.type).toBe('text')
    expect(block.text).toBe(SAMPLE_PROMPT)
    expect(block.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('does not mutate the input string', () => {
    // The string is immutable in JS; this is a sanity check that the
    // helper returns a fresh array rather than aliasing input.
    const input = SAMPLE_PROMPT
    const result = buildSystemParam(input, true)
    if (!Array.isArray(result)) return
    expect(result[0]!.text).toBe(input)
  })
})

// ─── applyToolCache ──────────────────────────────────────────────────────────

describe('applyToolCache — cacheControl gate', () => {
  const baseTool: Tool = EMIT_VALIDATION_RULE_TOOL

  it('returns the tool unchanged when cacheControl is undefined', () => {
    const result = applyToolCache(baseTool, undefined)
    expect(result).toBe(baseTool)
    // Reference equality: no allocation when cacheControl is unset
    // ensures byte-identical request payload pre-PR-13.1.
  })

  it('returns the tool unchanged when cacheControl is false', () => {
    const result = applyToolCache(baseTool, false)
    expect(result).toBe(baseTool)
  })

  it('returns a shallow copy with cache_control when cacheControl is true', () => {
    const result = applyToolCache(baseTool, true)
    expect(result).not.toBe(baseTool) // new object
    expect(result.name).toBe(baseTool.name)
    expect(result.description).toBe(baseTool.description)
    expect(result.input_schema).toBe(baseTool.input_schema)
    expect((result as Tool & { cache_control?: unknown }).cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('does not mutate the input tool', () => {
    applyToolCache(baseTool, true)
    expect(
      (baseTool as Tool & { cache_control?: unknown }).cache_control,
    ).toBeUndefined()
  })
})

// ─── Cross-helper consistency ────────────────────────────────────────────────

describe('cache helpers — request-shape consistency', () => {
  it('cacheControl=false: both helpers preserve input shape (byte-identical pre-13.1)', () => {
    const sys = buildSystemParam(SAMPLE_PROMPT, false)
    const tool = applyToolCache(EMIT_VALIDATION_RULE_TOOL, false)
    expect(sys).toBe(SAMPLE_PROMPT)
    expect(tool).toBe(EMIT_VALIDATION_RULE_TOOL)
  })

  it('cacheControl=true: both helpers attach cache_control markers', () => {
    const sys = buildSystemParam(SAMPLE_PROMPT, true)
    const tool = applyToolCache(EMIT_VALIDATION_RULE_TOOL, true)
    expect(Array.isArray(sys) && sys[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect((tool as Tool & { cache_control?: unknown }).cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('cacheControl=true: only cache_control differs from cacheControl=false', () => {
    // Regression smoke for the spec's "cached vs non-cached output for
    // same prompt produces identical structural output" requirement.
    // The helpers return shapes that differ ONLY in the cache_control
    // marker; everything else (text content, tool name, schema, etc.)
    // is preserved.
    const cachedSys = buildSystemParam(SAMPLE_PROMPT, true)
    const cachedTool = applyToolCache(EMIT_VALIDATION_RULE_TOOL, true)

    if (!Array.isArray(cachedSys)) throw new Error('expected array')
    expect(cachedSys[0]!.text).toBe(SAMPLE_PROMPT)

    expect(cachedTool.name).toBe(EMIT_VALIDATION_RULE_TOOL.name)
    expect(cachedTool.description).toBe(EMIT_VALIDATION_RULE_TOOL.description)
    expect(cachedTool.strict).toBe(EMIT_VALIDATION_RULE_TOOL.strict)
    // input_schema reference identity confirms no deep mutation
    expect(cachedTool.input_schema).toBe(EMIT_VALIDATION_RULE_TOOL.input_schema)
  })
})
