// @vitest-environment node
//
// PR 6 sanity check — end-to-end logging via `callLLM` writes a row
// to `public.llm_calls` with the expected shape.
//
// This test is intentionally narrow: it calls `callLLM` directly
// (NOT through the engine), makes a small real Anthropic API call,
// then queries the log table. The goal is to prove the wrapper's
// fire-and-forget logging works end-to-end with real Anthropic
// usage data + a real Supabase write.
//
// Cost per run: ~$0.001–$0.005 (single small completion).
//
// Env-gated:
//   RUN_LLM_CALLS_INTEGRATION=1                  required
//   ANTHROPIC_API_KEY                            required
//   NEXT_PUBLIC_SUPABASE_URL                     required
//   SUPABASE_SERVICE_ROLE_KEY                    required
//   LLM_CALLS_INTEGRATION_PROJECT_ID  OR
//     MAPPINGS_REDESIGN_HERITAGE_PROJECT_ID  OR
//     PROJECTS_HERITAGE_PROJECT_ID  OR
//     HERITAGE_PROJECT_ID                        required
//   LLM_CALLS_INTEGRATION_USER_ID                optional, defaults
//                                                to a Heritage owner
//
// Migration prerequisite: `supabase/migrations/082_llm_calls.sql`
// must have been applied. If not, this test fails with a "relation
// public.llm_calls does not exist" error.

import { describe, it, expect, beforeAll } from 'vitest'

import { callLLM } from '@/lib/ai/llm-client'
import { supabaseAdmin } from '@/lib/supabase/admin'

const RUN = process.env.RUN_LLM_CALLS_INTEGRATION === '1'

const PROJECT_ID =
  process.env.LLM_CALLS_INTEGRATION_PROJECT_ID ??
  process.env.MAPPINGS_REDESIGN_HERITAGE_PROJECT_ID ??
  process.env.PROJECTS_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''

// Default user matches the Heritage owner used by the redesign
// integration tests. Override with `LLM_CALLS_INTEGRATION_USER_ID` if
// you want to log against a different user.
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

// Tiny helper to wait for the fire-and-forget log write to commit.
// 2 seconds is generous for a single INSERT to local Supabase or
// production Supabase. The wrapper kicks off the write via `void`
// without awaiting; we sleep then poll once.
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

describeFn('[integration] callLLM logs a row in llm_calls', () => {
  beforeAll(() => {
    expect(PROJECT_ID).toBeTruthy()
  })

  it('writes a row with succeeded=true, populated tokens + cost, and matching system prompt', async () => {
    const SYSTEM_PROMPT =
      'You are a JSON-only test responder. Reply with valid JSON only.'
    const USER_MESSAGE =
      'Respond with this exact JSON: {"ok": true}. Nothing else.'

    const result = await callLLM({
      feature: 'mapping_suggest', // any LLMFeature works for this test
      systemPrompt: SYSTEM_PROMPT,
      userMessage: USER_MESSAGE,
      maxTokens: 100,
      projectId: PROJECT_ID,
      userId: USER_ID,
      promptVersion: 'llm-calls-logging-integration-v1',
      abuseUserId: USER_ID,
      metadata: { test: 'llm_calls_logging_sanity_check' },
    })

    // PR 12: this test calls callLLM without a `tool`, so the result
    // is always { kind: 'text' }; assert + narrow before reading .text.
    expect(result.kind).toBe('text')
    if (result.kind !== 'text') return
    // Wrapper return shape — basic sanity
    expect(result.text).toBeTruthy()
    expect(result.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(result.inputTokens).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)
    expect(result.costUsd).not.toBeNull()
    expect(result.costUsd!).toBeGreaterThan(0)
    expect(result.anthropicRequestId).toBeTruthy()

    // Wait for the async log write
    const row = (await waitForLogRow(result.callId)) as
      | (Record<string, unknown> & {
          succeeded: boolean
          feature: string
          system_prompt: string
          user_message: string
          input_tokens: number | null
          output_tokens: number | null
          cost_usd: number | null
          anthropic_request_id: string | null
          parent_call_id: string | null
          metadata: Record<string, unknown>
          model: string
          is_streaming: boolean
        })
      | null

    expect(row).toBeTruthy()
    if (!row) return

    // Outcome + identity fields
    expect(row.succeeded).toBe(true)
    expect(row.feature).toBe('mapping_suggest')
    // Phase 2 PR 11: default model now resolves dynamically via
    // `resolveDefaultModel()` — `claude-sonnet-4-6` when
    // AI_PHASE_2_ENABLED is unset (default), `claude-opus-4-7` when
    // the flag is on. Assert against whichever default applies for
    // the current env so this integration test stays robust across
    // both states.
    const expectedModel =
      process.env.AI_PHASE_2_ENABLED === '1'
        ? 'claude-opus-4-7'
        : 'claude-sonnet-4-6'
    expect(row.model).toBe(expectedModel)
    expect(row.is_streaming).toBe(false)
    expect(row.parent_call_id).toBeNull() // primary call, no parent

    // Prompt content stored verbatim
    expect(row.system_prompt).toBe(SYSTEM_PROMPT)
    expect(row.user_message).toBe(USER_MESSAGE)

    // Tokens + cost computed
    expect(row.input_tokens).toBeGreaterThan(0)
    expect(row.output_tokens).toBeGreaterThan(0)
    expect(row.cost_usd).not.toBeNull()
    expect(Number(row.cost_usd)).toBeGreaterThan(0)

    // Anthropic request id captured
    expect(row.anthropic_request_id).toBeTruthy()
    expect(row.anthropic_request_id).toBe(result.anthropicRequestId)

    // Metadata round-trips
    expect(row.metadata).toMatchObject({
      test: 'llm_calls_logging_sanity_check',
    })

    console.log(
      `[llm-calls-logging] success: callId=${result.callId} ` +
        `tokens=${result.inputTokens}+${result.outputTokens} ` +
        `cost=$${result.costUsd?.toFixed(6)}`,
    )
  }, 30_000)

  it('writes a child row with parent_call_id for a chained retry', async () => {
    const SYSTEM_PROMPT_A = 'You are a JSON-only test responder.'
    const USER_MESSAGE_A = 'Reply with {"a": 1}.'

    // Primary call
    const primary = await callLLM({
      feature: 'mapping_generate',
      systemPrompt: SYSTEM_PROMPT_A,
      userMessage: USER_MESSAGE_A,
      maxTokens: 100,
      projectId: PROJECT_ID,
      userId: USER_ID,
      promptVersion: 'llm-calls-logging-integration-v1',
      abuseUserId: USER_ID,
      metadata: { test: 'parent_chain_primary' },
    })
    // PR 12: no tool passed → always kind='text'.
    expect(primary.kind).toBe('text')
    if (primary.kind !== 'text') return
    expect(primary.text).toBeTruthy()

    // Child call — synthesizes a "repair" retry by passing parentCallId
    const SYSTEM_PROMPT_B = 'You are a JSON repair tool.'
    const USER_MESSAGE_B = `Fix this if needed: ${primary.text}. Reply with {"b": 2}.`
    const child = await callLLM({
      feature: 'mapping_generate_repair',
      systemPrompt: SYSTEM_PROMPT_B,
      userMessage: USER_MESSAGE_B,
      maxTokens: 100,
      projectId: PROJECT_ID,
      userId: USER_ID,
      promptVersion: 'llm-calls-logging-integration-v1',
      parentCallId: primary.callId,
      abuseUserId: USER_ID,
      metadata: { test: 'parent_chain_child' },
    })
    // PR 12: no tool passed → always kind='text'.
    expect(child.kind).toBe('text')
    if (child.kind !== 'text') return
    expect(child.text).toBeTruthy()

    const childRow = (await waitForLogRow(child.callId)) as
      | { parent_call_id: string | null; feature: string }
      | null
    expect(childRow).toBeTruthy()
    if (!childRow) return
    expect(childRow.feature).toBe('mapping_generate_repair')
    expect(childRow.parent_call_id).toBe(primary.callId)

    console.log(
      `[llm-calls-logging] retry chain: parent=${primary.callId} child=${child.callId}`,
    )
  }, 30_000)
})
