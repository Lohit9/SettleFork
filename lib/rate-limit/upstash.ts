import { Ratelimit, type Duration } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

/**
 * Upstash Redis-backed sliding-window rate limiter.
 *
 * Sliding window (vs. fixed window) prevents the 59s/61s burst-bypass:
 * with a 10/min fixed window an attacker can fire 10 at t=59s and 10
 * more at t=61s for an effective 20 in a 2-second span. Sliding window
 * weights the previous window's count against the current window
 * fractionally, so the effective rate stays bounded.
 *
 * Module load is fail-fast: missing env vars throw at import time, not
 * at request time. This mirrors the pattern in `lib/sso/attempt-cookie.ts`.
 *
 * Limiter instances are cached per (kind, limit, window) tuple so that
 * repeated callers in the same Node process share a single Redis-keyed
 * counter rather than allocating a fresh Ratelimit every call.
 */

if (!process.env.UPSTASH_REDIS_REST_URL) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL environment variable is required. ' +
      'Set it via your Upstash Redis dashboard. See lib/rate-limit/upstash.ts.'
  )
}
if (!process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_TOKEN environment variable is required. ' +
      'Set it via your Upstash Redis dashboard. See lib/rate-limit/upstash.ts.'
  )
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export interface RateLimitResult {
  /** True iff the request is within the limit. */
  allowed: boolean
  /** Calls remaining in the current window after this one. */
  remaining: number
  /** Epoch ms when the current window resets / oldest token expires. */
  resetAt: number
  /** The configured limit (echoed back for caller convenience). */
  limit: number
}

export interface RateLimitOptions {
  /**
   * Unique identifier for this kind of rate limit. Used as a prefix
   * for the Upstash key namespace so that two unrelated buckets cannot
   * collide. Example: 'sso-start', 'sso-check'.
   */
  kind: string

  /**
   * Maximum number of requests in the window.
   */
  limit: number

  /**
   * Window duration. Per `@upstash/ratelimit`'s exported `Duration`
   * type: `${number} ${'ms'|'s'|'m'|'h'|'d'}` (with optional space).
   * Examples: '60 s', '1 m', '500ms'.
   */
  window: Duration
}

const limiterCache = new Map<string, Ratelimit>()

function getLimiter(opts: RateLimitOptions): Ratelimit {
  const cacheKey = `${opts.kind}:${opts.limit}:${opts.window}`
  let limiter = limiterCache.get(cacheKey)
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(opts.limit, opts.window),
      prefix: `settle:rl:${opts.kind}`,
      analytics: false,
    })
    limiterCache.set(cacheKey, limiter)
  }
  return limiter
}

/**
 * Check whether a given identifier is within the rate limit.
 *
 * @param identifier - The bucket key. Caller composes from
 *   IP, org_slug, email_domain_hash, etc. The full key written to
 *   Redis is `settle:rl:<kind>:<identifier>`.
 * @param opts - Limit shape (kind, limit, window).
 * @returns RateLimitResult with allowed, remaining, resetAt, limit.
 *
 * Side effect: each call increments the bucket — there is no
 * "preview" mode. Callers must structure logic so that this is
 * called exactly once per request, before the protected work.
 */
export async function checkRateLimit(
  identifier: string,
  opts: RateLimitOptions
): Promise<RateLimitResult> {
  const limiter = getLimiter(opts)
  const result = await limiter.limit(identifier)
  return {
    allowed: result.success,
    remaining: result.remaining,
    resetAt: result.reset,
    limit: result.limit,
  }
}

export const __test_only__ = {
  /** Clear the limiter cache. ONLY for tests. */
  clearLimiterCache: () => {
    limiterCache.clear()
  },
}
