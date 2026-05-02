/**
 * Per-model Anthropic pricing in USD per million tokens.
 *
 * Source of truth for cost computation in `lib/ai/llm-client.ts`.
 * Update in step with Anthropic's pricing page; treat each price
 * change as a reviewable PR.
 *
 * Formula (applied at log time):
 *   cost_usd =
 *     (input_tokens          * input
 *   +  output_tokens         * output
 *   +  cache_read_tokens     * cacheRead
 *   +  cache_creation_tokens * cacheCreation) / 1_000_000
 */

export interface ModelPricing {
  /** USD per million input tokens (base, no cache) */
  input: number
  /** USD per million output tokens */
  output: number
  /** USD per million tokens read from prompt cache (typically 10% of input) */
  cacheRead: number
  /** USD per million tokens written to prompt cache (typically 1.25x input for 5-min TTL) */
  cacheCreation: number
  /** USD per million input tokens via batch API (50% off; not yet used in this codebase) */
  batchInput?: number
}

export const PRICING: Record<string, ModelPricing> = {
  // Deprecated as of 2025-Q4; retires 2026-06-15. Kept here so historical
  // llm_calls rows pre-PR-11 still resolve a price. New calls use
  // 'claude-sonnet-4-6' (current Sonnet) or 'claude-opus-4-7' (Phase 2).
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    batchInput: 1.5,
  },

  // Current Sonnet — replaces the deprecated 'claude-sonnet-4-20250514'
  // as the default when AI_PHASE_2_ENABLED is OFF (PR 11). Identical
  // pricing to Sonnet 4. Off the deprecation track.
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    batchInput: 1.5,
  },

  // Phase 2 model upgrade (PR 11) — used when AI_PHASE_2_ENABLED=1.
  // Higher quality, higher cost (1.67x base; up to 2.25x effective due
  // to Opus 4.7's new tokenizer producing more tokens per input).
  'claude-opus-4-7': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheCreation: 6.25,
    batchInput: 1.25,
  },

  // Reserved for Tier 4 utility calls if a feature ever uses Haiku
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheCreation: 1.25,
  },
} as const

export function computeCostUsd(
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  },
): number | null {
  const p = PRICING[model]
  if (!p) {
    console.warn(
      `[pricing] Unknown model "${model}" — cost_usd will be NULL. Add to lib/ai/pricing.ts.`,
    )
    return null
  }
  return (
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    usage.cache_read_tokens * p.cacheRead +
    usage.cache_creation_tokens * p.cacheCreation
  ) / 1_000_000
}
