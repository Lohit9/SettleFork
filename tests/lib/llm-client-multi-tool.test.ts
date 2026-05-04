// @vitest-environment node
//
// PR 3.2 — unit tests for the multi-tool dispatch helpers
// (`resolveToolsParam` + `resolveToolChoice`). Pure functions; no SDK
// calls. Six essential cases per PR 3.2 trim spec.

import { describe, expect, it } from 'vitest'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import { resolveToolChoice, resolveToolsParam } from '@/lib/ai/llm-client'
import {
  EMIT_VALIDATION_RULE_TOOL,
  EMIT_QUERY_SUGGESTIONS_TOOL,
} from '@/lib/ai/tool-schemas'

describe('multi-tool dispatch helpers', () => {
  it('(a) single-tool unchanged: forced-by-name + reference equality on the tool', () => {
    const tools = resolveToolsParam(EMIT_VALIDATION_RULE_TOOL, undefined, undefined)
    const choice = resolveToolChoice(EMIT_VALIDATION_RULE_TOOL, undefined)

    expect(tools).toHaveLength(1)
    // Reference equality: byte-identical pre-PR-3.2 behavior
    expect(tools![0]).toBe(EMIT_VALIDATION_RULE_TOOL)
    expect(choice).toEqual({
      type: 'tool',
      name: EMIT_VALIDATION_RULE_TOOL.name,
      disable_parallel_tool_use: true,
    })
  })

  it('(b) multi-tool dispatches with tool_choice auto', () => {
    const inputTools = [EMIT_VALIDATION_RULE_TOOL, EMIT_QUERY_SUGGESTIONS_TOOL]
    const tools = resolveToolsParam(undefined, inputTools, undefined)
    const choice = resolveToolChoice(undefined, inputTools)

    expect(tools).toHaveLength(2)
    expect(tools![0]).toBe(EMIT_VALIDATION_RULE_TOOL)
    expect(tools![1]).toBe(EMIT_QUERY_SUGGESTIONS_TOOL)
    expect(choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  it('(c) mutual exclusivity: both helpers throw when tool AND tools are set', () => {
    expect(() =>
      resolveToolsParam(EMIT_VALIDATION_RULE_TOOL, [EMIT_QUERY_SUGGESTIONS_TOOL], undefined),
    ).toThrow(/mutually exclusive/i)
    expect(() =>
      resolveToolChoice(EMIT_VALIDATION_RULE_TOOL, [EMIT_QUERY_SUGGESTIONS_TOOL]),
    ).toThrow(/mutually exclusive/i)
  })

  it('(d) cache_control passes through unchanged across single-tool, multi-tool, and no-cache variants', () => {
    // Single-tool no cache → reference-equal (no allocation)
    expect(resolveToolsParam(EMIT_VALIDATION_RULE_TOOL, undefined, false)![0]).toBe(
      EMIT_VALIDATION_RULE_TOOL,
    )
    // Single-tool with cache → fresh object with cache_control
    const cachedSingle = resolveToolsParam(EMIT_VALIDATION_RULE_TOOL, undefined, true)![0]
    expect(cachedSingle).not.toBe(EMIT_VALIDATION_RULE_TOOL)
    expect(
      (cachedSingle as Tool & { cache_control?: { type: 'ephemeral' } }).cache_control,
    ).toEqual({ type: 'ephemeral' })

    // Multi-tool with cache → every entry has cache_control
    const inputTools = [EMIT_VALIDATION_RULE_TOOL, EMIT_QUERY_SUGGESTIONS_TOOL]
    const cachedMulti = resolveToolsParam(undefined, inputTools, true)!
    for (const t of cachedMulti) {
      expect(
        (t as Tool & { cache_control?: { type: 'ephemeral' } }).cache_control,
      ).toEqual({ type: 'ephemeral' })
    }
    // Originals untouched
    expect(
      (EMIT_VALIDATION_RULE_TOOL as Tool & { cache_control?: unknown }).cache_control,
    ).toBeUndefined()
  })

  it('(e) disable_parallel_tool_use=true is set in BOTH single-tool and multi-tool tool_choice', () => {
    const single = resolveToolChoice(EMIT_VALIDATION_RULE_TOOL, undefined)
    const multi = resolveToolChoice(undefined, [EMIT_VALIDATION_RULE_TOOL, EMIT_QUERY_SUGGESTIONS_TOOL])

    expect(single?.disable_parallel_tool_use).toBe(true)
    expect(multi?.disable_parallel_tool_use).toBe(true)
  })

  it('(f) empty tools array is rejected (returns undefined for both helpers — no tools sent)', () => {
    expect(resolveToolsParam(undefined, [], undefined)).toBeUndefined()
    expect(resolveToolsParam(undefined, [], true)).toBeUndefined()
    expect(resolveToolChoice(undefined, [])).toBeUndefined()
    // Also: neither set
    expect(resolveToolsParam(undefined, undefined, undefined)).toBeUndefined()
    expect(resolveToolChoice(undefined, undefined)).toBeUndefined()
  })
})
