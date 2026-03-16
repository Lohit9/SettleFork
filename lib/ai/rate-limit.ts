// Simple in-memory rate limiter for MVP.
// Resets on server restart. Replace with Upstash Redis post-MVP.

interface RateLimitRecord {
  count: number
  resetAt: number
}

const userCallCounts = new Map<string, RateLimitRecord>()
const MAX_CALLS_PER_HOUR = 20

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  error?: string
}

export function checkAIRateLimit(userId: string): RateLimitResult {
  const now = Date.now()
  const record = userCallCounts.get(userId)

  if (!record || now > record.resetAt) {
    userCallCounts.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 })
    return { allowed: true, remaining: MAX_CALLS_PER_HOUR - 1 }
  }

  if (record.count >= MAX_CALLS_PER_HOUR) {
    const minutesLeft = Math.ceil((record.resetAt - now) / 60_000)
    return {
      allowed: false,
      remaining: 0,
      error: `AI rate limit reached (${MAX_CALLS_PER_HOUR}/hour). Try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`,
    }
  }

  record.count++
  return { allowed: true, remaining: MAX_CALLS_PER_HOUR - record.count }
}
