/**
 * Resolve the originating client IP from incoming request headers.
 *
 * Server actions and route handlers don't get a `request` object, so we
 * read headers via `next/headers`. Vercel and most proxies populate
 * `x-forwarded-for` (a comma-separated list, leftmost = client). Some
 * fall back to `x-real-ip`. If neither is present, return undefined so
 * callers can decide whether to pass it onward — `verifyTurnstileToken`
 * treats undefined as "skip the optional remoteip param".
 *
 * Mirrors the inline logic that previously lived in
 * `lib/actions/auth.ts:signUpWithBotProtection` so future call sites
 * (Turnstile verify, IP rate-limit, audit logs) stay consistent.
 */

import { headers } from 'next/headers'

export async function getRequestIp(): Promise<string | undefined> {
  const h = await headers()
  const xff = h.get('x-forwarded-for')
  const fromXff = xff?.split(',')[0]?.trim()
  if (fromXff) return fromXff
  const real = h.get('x-real-ip')?.trim()
  return real || undefined
}
