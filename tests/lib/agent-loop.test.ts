// @vitest-environment node
//
// PR 3.2 — unit tests for `runAgentLoop`. All scenarios use the
// `dryRun` mock-responder mode (LOCK #4) — no real Anthropic SDK
// calls, no llm_calls inserts, no env-gating.
//
// Coverage: 7 termination conditions (final, max_iterations, max_cost,
// max_wall_clock, tool_error, model_error, schema_error) + parent_call_id
// chain + dryRun bypass + multi-tool dispatch = 10 tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import {
  runAgentLoop,
  type DryRunResponder,
  type ToolHandler,
} from '@/lib/ai/agent-loop'

// ─── Test fixtures ──────────────────────────────────────────────────────────

const DATA_TOOL: Tool = {
  name: 'echo_field',
  description: 'Test data tool that echoes a field name back.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      field_name: { type: 'string', description: 'Name to echo.' },
    },
    required: ['field_name'],
  },
}

const ANSWER_TOOL: Tool = {
  name: 'emit_decision',
  description: 'Test answer tool — emitting this terminates the loop.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: { type: 'string', description: 'Final decision.' },
    },
    required: ['decision'],
  },
}

const echoHandler: ToolHandler = async (input) => ({
  result: JSON.stringify({ echoed: input.field_name }),
})

function tools(handler: ToolHandler = echoHandler) {
  return [
    { tool: DATA_TOOL, handler },
    { tool: ANSWER_TOOL }, // no handler = answer tool
  ]
}

const baseOpts = {
  feature: 'mapping_generate' as const,
  systemPrompt: 'Test system prompt.',
  userMessage: 'Test user question.',
  projectId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
}

// ─── Termination 1: final answer tool ────────────────────────────────────────

describe('runAgentLoop — final answer termination', () => {
  it('returns kind=final when the model picks the answer tool', async () => {
    const responder: DryRunResponder = async () => ({
      kind: 'toolUse',
      toolUse: { name: 'emit_decision', input: { decision: 'Approve' } },
    })
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      dryRun: { mockResponder: responder },
    })
    expect(result.kind).toBe('final')
    if (result.kind !== 'final') return
    expect(result.finalToolUse.name).toBe('emit_decision')
    expect(result.finalToolUse.input).toEqual({ decision: 'Approve' })
    expect(result.iterations).toBe(1)
    expect(result.callIds).toHaveLength(1)
  })
})

// ─── Termination 2: max_iterations ───────────────────────────────────────────

describe('runAgentLoop — max_iterations cap', () => {
  it('returns aborted{max_iterations} when the model never picks the answer tool', async () => {
    const responder: DryRunResponder = async ({ iteration }) => ({
      kind: 'toolUse',
      toolUse: { name: 'echo_field', input: { field_name: `iter${iteration}` } },
    })
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      maxIterations: 3,
      dryRun: { mockResponder: responder },
    })
    expect(result.kind).toBe('aborted')
    if (result.kind !== 'aborted') return
    expect(result.reason).toBe('max_iterations')
    expect(result.iterations).toBe(3)
  })
})

// ─── Termination 3: max_cost (soft ceiling) ─────────────────────────────────

describe('runAgentLoop — max_cost cap', () => {
  it('returns aborted{max_cost} when accumulated dryRun costs exceed the cap', async () => {
    // Each iteration "costs" $0.30; cap at $0.50 → triggers on iter 3
    // (after iter 1 = $0.30, iter 2 = $0.60 > $0.50; the check runs
    // at the START of iter 3, so iter 3 aborts before its LLM call).
    const responder: DryRunResponder = async () => ({
      kind: 'toolUse',
      toolUse: { name: 'echo_field', input: { field_name: 'x' } },
      costUsd: 0.3,
    })
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      maxIterations: 10,
      maxCostUsd: 0.5,
      dryRun: { mockResponder: responder },
    })
    expect(result.kind).toBe('aborted')
    if (result.kind !== 'aborted') return
    expect(result.reason).toBe('max_cost')
    expect(result.totalCostUsd).toBeGreaterThan(0.5)
  })
})

// ─── Termination 4: max_wall_clock ──────────────────────────────────────────

describe('runAgentLoop — max_wall_clock cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns aborted{max_wall_clock} when iterations advance the clock past the cap', async () => {
    let iter = 0
    const responder: DryRunResponder = async () => {
      iter++
      vi.advanceTimersByTime(600)
      return {
        kind: 'toolUse',
        toolUse: { name: 'echo_field', input: { field_name: `f${iter}` } },
      }
    }
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      maxIterations: 100,
      maxWallClockMs: 1500,
      dryRun: { mockResponder: responder },
    })
    expect(result.kind).toBe('aborted')
    if (result.kind !== 'aborted') return
    expect(result.reason).toBe('max_wall_clock')
  })
})

// ─── Termination 5: tool_error (consolidated: fatal + sync throw) ───────────

describe('runAgentLoop — tool_error termination', () => {
  it('aborts on both handler.fatal=true AND handler synchronous throw — distinct code paths', async () => {
    // Path 1: handler returns fatal: true (the explicit fatal branch)
    const fatalHandler: ToolHandler = async () => ({
      result: 'simulated unrecoverable error',
      fatal: true,
    })
    const responderForFatal: DryRunResponder = async () => ({
      kind: 'toolUse',
      toolUse: { name: 'echo_field', input: { field_name: 'x' } },
    })
    const fatalResult = await runAgentLoop({
      ...baseOpts,
      tools: tools(fatalHandler),
      dryRun: { mockResponder: responderForFatal },
    })
    expect(fatalResult.kind).toBe('aborted')
    if (fatalResult.kind === 'aborted') {
      expect(fatalResult.reason).toBe('tool_error')
      expect(fatalResult.message).toContain('fatal')
    }

    // Path 2: handler throws synchronously (the try/catch branch)
    const throwingHandler: ToolHandler = async () => {
      throw new Error('boom')
    }
    const throwResult = await runAgentLoop({
      ...baseOpts,
      tools: tools(throwingHandler),
      dryRun: { mockResponder: responderForFatal },
    })
    expect(throwResult.kind).toBe('aborted')
    if (throwResult.kind === 'aborted') {
      expect(throwResult.reason).toBe('tool_error')
      expect(throwResult.message).toContain('boom')
    }
  })
})

// ─── Termination 6: model_error ─────────────────────────────────────────────

describe('runAgentLoop — model_error termination', () => {
  it('returns aborted{model_error} when the responder throws', async () => {
    const throwingResponder: DryRunResponder = async () => {
      throw new Error('Anthropic 503 grammar compilation overloaded')
    }
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      dryRun: { mockResponder: throwingResponder },
    })
    expect(result.kind).toBe('aborted')
    if (result.kind !== 'aborted') return
    expect(result.reason).toBe('model_error')
    expect(result.message).toContain('grammar compilation')
  })
})

// ─── Termination 7: schema_error ────────────────────────────────────────────

describe('runAgentLoop — schema_error termination', () => {
  it('returns aborted{schema_error} when the model emits a text response (no tool picked)', async () => {
    const textResponder: DryRunResponder = async () => ({
      kind: 'text',
      text: 'I think the answer is 42.',
    })
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      dryRun: { mockResponder: textResponder },
    })
    expect(result.kind).toBe('aborted')
    if (result.kind !== 'aborted') return
    expect(result.reason).toBe('schema_error')
    expect(result.message).toContain('text response')
  })
})

// ─── parent_call_id chain (heads-to-tails per LOCK #3) ──────────────────────

describe('runAgentLoop — parent_call_id chain (LOCK #3 heads-to-tails)', () => {
  it('records one callId per iteration in order; chain links via parent_call_id semantics', async () => {
    let iter = 0
    const responder: DryRunResponder = async () => {
      iter++
      if (iter < 4) {
        return {
          kind: 'toolUse',
          toolUse: { name: 'echo_field', input: { field_name: `f${iter}` } },
        }
      }
      return {
        kind: 'toolUse',
        toolUse: { name: 'emit_decision', input: { decision: 'X' } },
      }
    }
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      dryRun: { mockResponder: responder },
    })
    expect(result.kind).toBe('final')
    if (result.kind !== 'final') return
    // Heads-to-tails: callIds[0] would have parent_call_id=null in
    // llm_calls (iteration 1); callIds[1].parent_call_id == callIds[0];
    // etc. End-to-end verified by the integration test against real
    // llm_calls rows.
    expect(result.callIds).toHaveLength(4)
    expect(new Set(result.callIds).size).toBe(4) // all unique
    for (const id of result.callIds) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
  })
})

// ─── dryRun bypass (LOCK #4) ────────────────────────────────────────────────

describe('runAgentLoop — dryRun mock responder bypass', () => {
  it('does NOT invoke any real callLLM; dryRun replaces the entire LLM round-trip', async () => {
    let calls = 0
    const responder: DryRunResponder = async () => {
      calls++
      return {
        kind: 'toolUse',
        toolUse: { name: 'emit_decision', input: { decision: 'd' } },
      }
    }
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(),
      dryRun: { mockResponder: responder },
    })
    expect(calls).toBe(1) // mockResponder fired exactly once
    expect(result.kind).toBe('final')
    expect(result.callIds).toHaveLength(1)
    // Synthetic UUID format (no real llm_calls.id was generated):
    expect(result.callIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})

// ─── Multi-tool dispatch ────────────────────────────────────────────────────

describe('runAgentLoop — multi-tool dispatch', () => {
  it('invokes the right handler per tool name; answer-tool (no handler) terminates', async () => {
    let echoCalls = 0
    const handler: ToolHandler = async (input) => {
      echoCalls++
      return { result: JSON.stringify({ echoed: input.field_name }) }
    }
    let iter = 0
    const responder: DryRunResponder = async () => {
      iter++
      if (iter === 1) {
        return {
          kind: 'toolUse',
          toolUse: { name: 'echo_field', input: { field_name: 'foo' } },
        }
      }
      return {
        kind: 'toolUse',
        toolUse: { name: 'emit_decision', input: { decision: 'final' } },
      }
    }
    const result = await runAgentLoop({
      ...baseOpts,
      tools: tools(handler),
      dryRun: { mockResponder: responder },
    })
    expect(echoCalls).toBe(1) // data handler invoked exactly on iter 1
    expect(result.kind).toBe('final')
    if (result.kind !== 'final') return
    expect(result.iterations).toBe(2)
  })
})
