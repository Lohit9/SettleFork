import { headers } from 'next/headers'
import { createHash } from 'crypto'

/**
 * Extract the client IP from request headers.
 *
 * Returns null on miss — DO NOT fall back to a sentinel string.
 * Callers are expected to fail-closed when IP is null (reject the
 * request rather than colliding all anonymous IPs into one bucket).
 *
 * Header priority (Vercel-canonical first):
 *   1. x-forwarded-for (first comma-segment, trimmed)
 *   2. x-real-ip
 *   3. cf-connecting-ip
 *
 * Returns null if all three headers are absent, empty, or whitespace.
 *
 * Notes on spoofability: x-forwarded-for is trivially spoofable by
 * direct callers, but on Vercel the platform rewrites it to the true
 * client IP at the edge. On localhost or behind a proxy that does not
 * normalize this header, an attacker can set any value — but the
 * worst-case impact is that a single attacker can target a different
 * (ip, target) bucket per request, which still costs them 10 RPS per
 * spoofed IP and is not a meaningful enumeration speedup.
 */
export async function getClientIp(): Promise<string | null> {
  const h = await headers()

  const xff = h.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }

  const realIp = h.get('x-real-ip')?.trim()
  if (realIp) return realIp

  const cfIp = h.get('cf-connecting-ip')?.trim()
  if (cfIp) return cfIp

  return null
}

/**
 * Hash an IP for safe inclusion in audit metadata.
 *
 * Returns the first 16 hex chars of SHA-256(ip). The truncation is
 * intentional: 64 bits of collision-resistance is sufficient for
 * audit-correlation purposes while preventing trivial reverse-lookup
 * of the source IP from log exports. Same shape as
 * `lib/sso/email-hash.ts:hashEmail` for consistency.
 */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16)
}
