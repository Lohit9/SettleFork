// @vitest-environment node
//
// PR 7 sanity check — end-to-end streaming via `callLLMStreaming` writes
// a row to `public.llm_calls` with `is_streaming = true`.
//
// Mirrors `tests/integration/llm-calls-logging.test.ts` (PR 6) but
// uses the streaming wrapper. Together the two tests prove both the
// single-shot and streaming paths log correctly end-to-end.
//
// Cost per run: ~$0.001–$0.005.
//
// Env-gated: same flags as the PR 6 sanity test.
//   RUN_LLM_CALLS_INTEGRATION=1                  required
//   ANTHROPIC_API_KEY                            required
//   NEXT_PUBLIC_SUPABASE_URL                     required
//   SUPABASE_SERVICE_ROLE_KEY                    required
//   project + user resolution: same as PR 6 test

import { describe, it, expect } from 'vitest'

import { callLLMStreaming } from '@/lib/ai/llm-client'
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

describeFn('[integration] callLLMStreaming logs a row in llm_calls', () => {
  it('writes a row with is_streaming=true, populated tokens + cost', async () => {
    const SYSTEM_PROMPT =
      'You are a JSON-only test responder. Reply with valid JSON only.'
    const USER_MESSAGE =
      'Respond with this exact JSON: {"streaming": true}. Nothing else.'

    const result = await callLLMStreaming({
      feature: 'outputs_execution_package_compartmentalized',
      systemPrompt: SYSTEM_PROMPT,
      userMessage: USER_MESSAGE,
      maxTokens: 100,
      projectId: PROJECT_ID,
      userId: USER_ID,
      promptVersion: 'llm-calls-streaming-logging-integration-v1',
      abuseUserId: USER_ID,
      metadata: { test: 'llm_calls_streaming_logging_sanity_check' },
    })

    // PR 12: no tool passed → always kind='text'.
    expect(result.kind).toBe('text')
    if (result.kind !== 'text') return
    expect(result.text).toBeTruthy()
    expect(result.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(result.inputTokens).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)
    expect(result.costUsd).not.toBeNull()
    expect(result.costUsd!).toBeGreaterThan(0)
    expect(result.anthropicRequestId).toBeTruthy()

    const row = (await waitForLogRow(result.callId)) as
      | (Record<string, unknown> & {
          is_streaming: boolean
          succeeded: boolean
          feature: string
          input_tokens: number | null
          output_tokens: number | null
          cost_usd: number | null
        })
      | null

    expect(row).toBeTruthy()
    if (!row) return

    expect(row.is_streaming).toBe(true)
    expect(row.succeeded).toBe(true)
    expect(row.feature).toBe('outputs_execution_package_compartmentalized')
    expect(row.input_tokens).toBeGreaterThan(0)
    expect(row.output_tokens).toBeGreaterThan(0)
    expect(row.cost_usd).not.toBeNull()
    expect(Number(row.cost_usd)).toBeGreaterThan(0)

    console.log(
      `[llm-calls-streaming-logging] success: callId=${result.callId} ` +
        `tokens=${result.inputTokens}+${result.outputTokens} ` +
        `cost=$${result.costUsd?.toFixed(6)}`,
    )
  }, 30_000)
})
