// @vitest-environment node
//
// PR 3.2 — end-to-end smoke for `runAgentLoop` against real Anthropic.
// Registers 2 tools (1 data tool with a canned handler + 1 answer tool
// without a handler), drives the loop to completion, asserts the
// per-iteration `llm_calls` rows are linked via `parent_call_id`
// heads-to-tails (LOCK #3).
//
// Cost per run: ~$0.05 (3 iterations max × small prompts × small tool
// schemas; multi-tool registration adds tool-choice-auto overhead but
// stays well within budget).
//
// Env-gated: same flags as the existing PR 7 integration tests.
//   RUN_LLM_CALLS_INTEGRATION=1                  required
//   ANTHROPIC_API_KEY                            required
//   NEXT_PUBLIC_SUPABASE_URL                     required
//   SUPABASE_SERVICE_ROLE_KEY                    required
//   project + user resolution: same as PR 6 test

import { describe, expect, it } from 'vitest'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import { runAgentLoop, type ToolHandler } from '@/lib/ai/agent-loop'
import { supabaseAdmin } from '@/lib/supabase/admin'

const RUN = process.env.RUN_LLM_CALLS_INTEGRATION === '1'

const PROJECT_ID =
  process.env.LLM_CALLS_INTEGRATION_PROJECT_ID ??
  process.env.MAPPINGS_REDESIGN_HERITAGE_PROJECT_ID ??
  process.env.PROJECTS_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''

const USER_ID =
  process.env.LLM_CALLS_INTEGRATION_USER_ID ??
  'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'

const HAS_ENV =
  RUN &&
  Boolean(PROJECT_ID) &&
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

async function waitForLogRow(
  callId: string,
  maxWaitMs = 5000,
): Promise<unknown | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < maxWaitMs) {
    const { data } = await supabaseAdmin
      .from('llm_calls')
      .select('*')
      .eq('id', callId)
      .maybeSingle()
    if (data) return data
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const ECHO_FIELD_TOOL: Tool = {
  name: 'echo_field',
  description:
    'Echoes a single field name back to the model. Use this if you want to inspect a name before deciding on the final answer; otherwise skip directly to emit_decision.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      field_name: {
        type: 'string',
        description: 'The bare field name to echo. Any string is accepted.',
      },
    },
    required: ['field_name'],
  },
}

const EMIT_DECISION_TOOL: Tool = {
  name: 'emit_decision',
  description:
    'Emit the final decision. Calling this tool TERMINATES the loop. Use this when you have enough information; you may also call it directly without using echo_field first.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: {
        type: 'string',
        description: 'A short one-sentence decision string.',
      },
    },
    required: ['decision'],
  },
}

const echoHandler: ToolHandler = async (input) => ({
  result: JSON.stringify({ echoed: String(input.field_name ?? '') }),
})

// ─── Smoke test ──────────────────────────────────────────────────────────────

describeFn('[integration] runAgentLoop end-to-end (PR 3.2)', () => {
  it(
    'drives a 2-tool loop to a final answer; chain links via parent_call_id',
    async () => {
      const result = await runAgentLoop({
        feature: 'mapping_generate',
        systemPrompt:
          'You are testing the agent-loop primitive. Use the echo_field tool at most once if helpful, then emit_decision with a short summary. Do NOT emit text responses; always pick a tool.',
        userMessage:
          'Decide whether the field "customer_name" looks like a personal-name column or a generic-label column. Optionally echo the field name first to confirm what you saw, then emit_decision with your answer.',
        tools: [
          { tool: ECHO_FIELD_TOOL, handler: echoHandler },
          { tool: EMIT_DECISION_TOOL }, // no handler = answer tool
        ],
        projectId: PROJECT_ID,
        userId: USER_ID,
        maxIterations: 4,
        maxCostUsd: 0.2,
        llmOptions: {
          maxTokens: 512,
          promptVersion: 'agent-loop-end-to-end-v1',
          abuseUserId: USER_ID,
          metadata: { test: 'pr_3_2_agent_loop_smoke' },
        },
      })

      expect(result.kind).toBe('final')
      if (result.kind !== 'final') return
      expect(result.finalToolUse.name).toBe('emit_decision')
      expect(typeof (result.finalToolUse.input as { decision?: unknown }).decision).toBe('string')
      expect(result.iterations).toBeGreaterThanOrEqual(1)
      expect(result.iterations).toBeLessThanOrEqual(4)
      expect(result.callIds).toHaveLength(result.iterations)

      // Verify all callIds resolved to llm_calls rows.
      const rows: Array<Record<string, unknown>> = []
      for (const callId of result.callIds) {
        const row = await waitForLogRow(callId)
        expect(row).toBeTruthy()
        rows.push(row as Record<string, unknown>)
      }

      // LOCK #3: heads-to-tails parent_call_id chain.
      // Iteration 1: parent_call_id IS NULL.
      // Iteration N (N>=2): parent_call_id === callIds[N-2].
      expect(rows[0]!.parent_call_id).toBeNull()
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.parent_call_id).toBe(result.callIds[i - 1])
      }

      // Aggregate cost > 0 and recorded.
      expect(result.totalCostUsd).not.toBeNull()
      if (result.totalCostUsd !== null) {
        expect(result.totalCostUsd).toBeGreaterThan(0)
      }

      console.log(
        `[agent-loop-e2e] success: iterations=${result.iterations} ` +
          `callIds=${result.callIds.length} ` +
          `total_cost=$${result.totalCostUsd?.toFixed(6) ?? 'null'}`,
      )
    },
    60_000,
  )
})
