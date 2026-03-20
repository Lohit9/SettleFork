// In-memory rate limiter for signup attempts.
// Resets on server restart — mirrors the pattern in lib/ai/rate-limit.ts.

interface RateLimitEntry {
  count: number
  resetAt: number
}

const ipAttempts = new Map<string, RateLimitEntry>()

const MAX_ATTEMPTS = 3
const WINDOW_MS = 60 * 60 * 1000 // 1 hour

export function checkSignupRateLimit(ip: string): { allowed: boolean; error?: string } {
  const now = Date.now()
  const entry = ipAttempts.get(ip)

  if (!entry || now > entry.resetAt) {
    ipAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true }
  }

  if (entry.count >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      error: 'Too many signup attempts. Please try again later.',
    }
  }

  entry.count++
  return { allowed: true }
}
