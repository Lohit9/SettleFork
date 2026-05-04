// @vitest-environment node
//
// PR 13.1 — end-to-end smoke for Anthropic prompt caching.
//
// First call writes the cache (cache_creation_input_tokens > 0);
// second identical call within Anthropic's 5-minute ephemeral TTL
// reads the cache (cache_read_input_tokens > 0). Both numbers are
// persisted to llm_calls.cache_creation_tokens / cache_read_tokens
// (already wired pre-PR-13.1).
//
// Cost per run: ~$0.05 (one cache write + one cache read on a small
// system prompt + the smallest tool in the catalog).
//
// Env-gated: same flags as the PR 7 sanity test.
//   RUN_LLM_CALLS_INTEGRATION=1                  required
//   ANTHROPIC_API_KEY                            required
//   NEXT_PUBLIC_SUPABASE_URL                     required
//   SUPABASE_SERVICE_ROLE_KEY                    required
//   project + user resolution: same as PR 6 test

import { describe, it, expect } from 'vitest'

import { callLLM } from '@/lib/ai/llm-client'
import { EMIT_VALIDATION_RULE_TOOL } from '@/lib/ai/tool-schemas'
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

// A system prompt long enough to clear Anthropic's 1024-token cache
// floor. Sonnet/Opus reject the cache_control marker silently below
// that threshold; this prompt repeats a stable instruction block to
// exceed the floor without becoming nonsensical to the model.
const CACHEABLE_SYSTEM_PROMPT = Array.from({ length: 30 })
  .map(
    (_, i) =>
      `[Section ${i + 1}] You are a data validation expert specializing in enterprise migration. Given a field's metadata and a natural language description of a validation rule, generate a structured validation rule. Be precise about rule_type, rule_config shape, and severity. Choose blocking severity only for the 5 conditions enumerated in the prompt: target NOT NULL violations, target FK orphans, target PK uniqueness violations, type-conversion failures with no transformation pattern, and field-length truncation when target dialect rejects oversized values.`,
  )
  .join('\n\n')

describeFn('[integration] prompt caching writes + reads cache tokens', () => {
  it('first call writes the cache; second identical call reads it', async () => {
    const userMessage =
      'Field: customers.email (text). Rule: "must be a valid email address". Generate a structured validation rule.'

    // ── First call: should populate cache_creation_input_tokens ─────────────
    const firstResult = await callLLM({
      feature: 'validation_rule_from_nl',
      systemPrompt: CACHEABLE_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 512,
      projectId: PROJECT_ID,
      userId: USER_ID,
      promptVersion: 'llm-calls-prompt-caching-integration-v1',
      abuseUserId: USER_ID,
      metadata: { test: 'pr13_prompt_caching_smoke', call: 'first' },
      tool: EMIT_VALIDATION_RULE_TOOL,
      cacheControl: true,
    })

    expect(firstResult.kind).toBe('toolUse')
    expect(firstResult.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // Cache write happened — Anthropic returns the count of tokens it
    // just wrote to the cache. >0 means the marker was honored and the
    // prefix exceeded the 1024-token floor.
    expect(firstResult.cacheCreationTokens).toBeGreaterThan(0)

    const firstRow = (await waitForLogRow(firstResult.callId)) as
      | (Record<string, unknown> & {
          cache_creation_tokens: number | null
          cache_read_tokens: number | null
        })
      | null
    expect(firstRow).toBeTruthy()
    if (!firstRow) return
    expect(Number(firstRow.cache_creation_tokens)).toBeGreaterThan(0)

    console.log(
      `[prompt-caching] first call: callId=${firstResult.callId} ` +
        `cache_writes=${firstResult.cacheCreationTokens} ` +
        `cache_reads=${firstResult.cacheReadTokens} ` +
        `cost=$${firstResult.costUsd?.toFixed(6)}`,
    )

    // ── Second call: identical prefix; should hit the cache ─────────────────
    const secondResult = await callLLM({
      feature: 'validation_rule_from_nl',
      systemPrompt: CACHEABLE_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 512,
      projectId: PROJECT_ID,
      userId: USER_ID,
      promptVersion: 'llm-calls-prompt-caching-integration-v1',
      abuseUserId: USER_ID,
      metadata: { test: 'pr13_prompt_caching_smoke', call: 'second' },
      tool: EMIT_VALIDATION_RULE_TOOL,
      cacheControl: true,
    })

    expect(secondResult.kind).toBe('toolUse')
    // Cache read happened — Anthropic returns the count of tokens it
    // served from the cache. >0 confirms the marker landed within the
    // 5-min TTL and the prefix matched.
    expect(secondResult.cacheReadTokens).toBeGreaterThan(0)

    const secondRow = (await waitForLogRow(secondResult.callId)) as
      | (Record<string, unknown> & { cache_read_tokens: number | null })
      | null
    expect(secondRow).toBeTruthy()
    if (!secondRow) return
    expect(Number(secondRow.cache_read_tokens)).toBeGreaterThan(0)

    console.log(
      `[prompt-caching] second call: callId=${secondResult.callId} ` +
        `cache_writes=${secondResult.cacheCreationTokens} ` +
        `cache_reads=${secondResult.cacheReadTokens} ` +
        `cost=$${secondResult.costUsd?.toFixed(6)}`,
    )

    // Sanity: the second call should be cheaper than the first
    // (cache reads at 0.10× input cost vs full input price on the first
    // call's non-cache portion). We don't assert exact ratio because
    // output tokens vary between calls.
    if (
      secondResult.costUsd !== null &&
      firstResult.costUsd !== null &&
      // Filter out the case where both calls had identical small output
      // tokens — the tiny output-cost component would dominate.
      firstResult.cacheCreationTokens > 100
    ) {
      // Cache read should reduce per-call cost meaningfully when the
      // cached prefix is non-trivial.
      console.log(
        `[prompt-caching] cost delta: first=$${firstResult.costUsd} ` +
          `second=$${secondResult.costUsd} ` +
          `(read benefit kicks in)`,
      )
    }
  }, 60_000)
})
