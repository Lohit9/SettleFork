// @vitest-environment node
//
// PR 12 sub-commit 12.1 — discriminated-union shape unit tests.
//
// Pure type-level tests + runtime construction tests for the new
// `CallLLMResult` discriminated union. No Anthropic SDK calls, no
// Supabase. The integration test at
// `tests/integration/llm-calls-logging.test.ts` exercises the wire
// path end-to-end (env-gated).

import { describe, it, expect } from 'vitest'

import type { CallLLMResult } from '@/lib/ai/llm-client'

describe('CallLLMResult — discriminated union shape', () => {
  it('text variant carries kind="text" and a text field', () => {
    const result: CallLLMResult = {
      kind: 'text',
      text: 'hello',
      callId: '00000000-0000-0000-0000-000000000000',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      anthropicRequestId: 'req_test',
    }
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      // The narrowing here mirrors the production callsites — the
      // discriminator gates access to `.text`.
      expect(result.text).toBe('hello')
      // @ts-expect-error — `toolUse` is absent on the text variant.
      expect(result.toolUse).toBeUndefined()
    }
  })

  it('toolUse variant carries kind="toolUse" and a toolUse object', () => {
    const result: CallLLMResult = {
      kind: 'toolUse',
      toolUse: {
        name: 'emit_x',
        input: { foo: 'bar' },
      },
      callId: '11111111-1111-1111-1111-111111111111',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
      anthropicRequestId: 'req_test',
    }
    expect(result.kind).toBe('toolUse')
    if (result.kind === 'toolUse') {
      expect(result.toolUse.name).toBe('emit_x')
      expect(result.toolUse.input).toEqual({ foo: 'bar' })
      // @ts-expect-error — `text` is absent on the toolUse variant.
      expect(result.text).toBeUndefined()
    }
  })

  it('common fields (token counts, callId, cost) are present on both variants', () => {
    const text: CallLLMResult = {
      kind: 'text',
      text: '',
      callId: 'a',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.5,
      anthropicRequestId: 'req_a',
    }
    const tool: CallLLMResult = {
      kind: 'toolUse',
      toolUse: { name: 'n', input: {} },
      callId: 'b',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.5,
      anthropicRequestId: 'req_b',
    }
    for (const r of [text, tool]) {
      expect(r.callId).toBeTruthy()
      expect(r.inputTokens).toBe(1)
      expect(r.outputTokens).toBe(2)
      expect(r.cacheReadTokens).toBe(3)
      expect(r.cacheCreationTokens).toBe(4)
      expect(r.costUsd).toBe(0.5)
      expect(r.anthropicRequestId).toMatch(/^req_/)
    }
  })
})
