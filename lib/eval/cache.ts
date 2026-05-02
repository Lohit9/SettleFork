/**
 * Phase 1 PR 10.1 — read-only response cache backed by `public.llm_calls`.
 *
 * Before issuing a real `callLLM`, the eval runner queries `llm_calls`
 * for a row with the same `(model, system_prompt_hash, user_message_hash)`
 * tuple from the last N days. On hit, the runner replays the cached
 * `response_text` without an API call. This makes re-running evals
 * cheap when prompts haven't changed (e.g. during scorer development).
 *
 * Why this works:
 *
 *   `lib/ai/llm-client.ts` writes `system_prompt_hash` and
 *   `user_message_hash` (16-char SHA-256 prefixes) on every call (PR 6
 *   migration `082_llm_calls.sql`). The eval runner can reproduce
 *   these hashes for any prompt it's about to send and look up prior
 *   runs of the exact same prompt against the exact same model.
 *
 * Cache invalidation:
 *
 *   - prompt_version bump → caller passes a different prompt → hash
 *     differs → cache miss (natural)
 *   - new model → different `model` field → cache miss
 *   - default 7-day window — picks up any "rerun the eval after a
 *     prompt edit" pattern; configurable via `maxAgeDays`
 *
 * This module is read-only against `llm_calls`. No writes. The
 * production `callLLM` already writes when a real call is made.
 */

import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase/admin'

/** Mirrors `lib/ai/llm-client.ts:shortHash` — keep in sync. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

export interface CacheLookupInput {
  model: string
  systemPrompt: string
  userMessage: string
  /** Defaults to 7. Set to 0 to disable the cache for one lookup. */
  maxAgeDays?: number
}

export interface CacheHit {
  hit: true
  responseText: string
  llmCallId: string
  cachedAt: string
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
}

export interface CacheMiss {
  hit: false
}

export type CacheLookupResult = CacheHit | CacheMiss

/**
 * Look up a prior `llm_calls` row matching the prompt + model. Returns
 * the most recent successful row within `maxAgeDays`.
 *
 * Defensive against the migration-not-applied case: if the table query
 * fails because `llm_calls` doesn't exist, returns a miss and logs a
 * warning. The eval runner falls back to a real API call.
 */
export async function checkCache(
  input: CacheLookupInput,
): Promise<CacheLookupResult> {
  const maxAgeDays = input.maxAgeDays ?? 7

  if (maxAgeDays <= 0) {
    return { hit: false }
  }

  const sysHash = shortHash(input.systemPrompt)
  const userHash = shortHash(input.userMessage)
  const since = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('llm_calls')
    .select('id, response_text, created_at, input_tokens, output_tokens, cost_usd')
    .eq('model', input.model)
    .eq('system_prompt_hash', sysHash)
    .eq('user_message_hash', userHash)
    .eq('succeeded', true)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string
      response_text: string | null
      created_at: string
      input_tokens: number | null
      output_tokens: number | null
      cost_usd: number | null
    }>()

  if (error) {
    // Migration-not-applied: fall back to a miss without surfacing as fatal.
    if (
      error.message.includes('relation') ||
      error.message.includes('does not exist') ||
      error.message.includes('schema cache')
    ) {
      console.warn(
        '[eval/cache] llm_calls table not present — treating as miss:',
        error.message,
      )
      return { hit: false }
    }
    throw new Error(`[eval/cache] Lookup failed: ${error.message}`)
  }

  if (!data || data.response_text == null) {
    return { hit: false }
  }

  return {
    hit: true,
    responseText: data.response_text,
    llmCallId: data.id,
    cachedAt: data.created_at,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    costUsd: data.cost_usd,
  }
}
