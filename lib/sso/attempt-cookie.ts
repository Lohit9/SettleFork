import { createHmac, timingSafeEqual } from 'crypto'
import type { NextResponse } from 'next/server'

/**
 * Signed short-lived cookie that plumbs the "attempted org_id" from
 * /sso/start to /api/auth/callback so the callback can do the
 * cross-tenant check (provider's org_id must match the org the user
 * attempted to authenticate into).
 *
 * Threat model:
 *   - Cookie is HttpOnly + Secure (prod) + SameSite=Lax + 5 min TTL.
 *   - HMAC-SHA256 of the orgId binds the cookie value to a server
 *     secret. A user-modified cookie cannot forge a valid signature
 *     without leaking the secret.
 *   - Cookie is consumed (set with maxAge=0) by the callback BEFORE
 *     any redirect, so a single SSO attempt cannot be replayed.
 *
 * Why a separate helper (no next/headers import here):
 *   - Keeps the verification path pure and unit-testable without
 *     standing up a Next runtime.
 *   - Read takes a plain `Request` and parses the Cookie header.
 *   - Set/delete take a `NextResponse` and use NextResponse.cookies
 *     (the only Next-specific surface — required to write Set-Cookie
 *     into the redirect response).
 */

const COOKIE_NAME = 'settle-sso-attempt-org'
const MAX_AGE_SECONDS = 300

const SECRET = process.env.SSO_ATTEMPT_COOKIE_SECRET
if (!SECRET) {
  throw new Error(
    'SSO_ATTEMPT_COOKIE_SECRET environment variable is required. ' +
      'Generate one with: openssl rand -hex 32'
  )
}
// After the guard, narrow the type for downstream use.
const SECRET_STR: string = SECRET

export type AttemptCookieReason =
  | 'missing'
  | 'malformed'
  | 'invalid_signature'

function hmacSign(orgId: string): string {
  return createHmac('sha256', SECRET_STR).update(orgId).digest('hex')
}

/**
 * Constant-time hex-string comparison. Avoids early-exit timing
 * leakage that == / === / String.localeCompare would expose.
 * Returns false on any length mismatch (including non-hex input).
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  // Hex strings are ASCII; treat as utf8 buffers of equal length.
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Naive Cookie-header parser. Returns the value of the named cookie
 * or null. We don't pull in `cookie` as a dep — the format we set is
 * simple and we control both producer and consumer.
 *
 * Handles: "name=value; other=foo", with optional whitespace.
 * Does NOT handle: multi-cookie merging, quoted values (we never
 * emit quotes), URL-encoded values (we emit pure hex.uuid only).
 */
function parseCookieHeader(
  cookieHeader: string | null,
  name: string
): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const eqIdx = part.indexOf('=')
    if (eqIdx < 0) continue
    const k = part.slice(0, eqIdx).trim()
    if (k !== name) continue
    return part.slice(eqIdx + 1).trim()
  }
  return null
}

/**
 * Set the signed attempt-org cookie on a redirect response.
 * Call this on the SAME NextResponse that the browser will follow
 * to the IdP, so the cookie is visible when the IdP redirects back
 * to /api/auth/callback.
 */
export function setAttemptOrgCookie(
  response: NextResponse,
  orgId: string
): void {
  const signature = hmacSign(orgId)
  const value = `${signature}.${orgId}`
  response.cookies.set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE_SECONDS,
    path: '/',
  })
}

/**
 * Read + verify the attempt-org cookie from the incoming request.
 * Pure: takes a Request, returns a plain object. Does NOT mutate
 * the cookie store; deletion is a separate concern (see
 * deleteAttemptOrgCookie below) so the caller can attach the
 * deletion to the actual response it's about to return.
 */
export function readAttemptOrgCookie(request: Request): {
  orgId: string | null
  reason?: AttemptCookieReason
} {
  const raw = parseCookieHeader(
    request.headers.get('cookie'),
    COOKIE_NAME
  )
  if (!raw) return { orgId: null, reason: 'missing' }

  const dotIdx = raw.indexOf('.')
  if (dotIdx <= 0 || dotIdx === raw.length - 1) {
    return { orgId: null, reason: 'malformed' }
  }

  const signature = raw.slice(0, dotIdx)
  const orgId = raw.slice(dotIdx + 1)

  // Defensive shape check on the signature half: HMAC-SHA256 hex is
  // always 64 chars. A wrong length is a malformed value, not a
  // signature mismatch — keep that distinction in the audit trail.
  if (signature.length !== 64 || !/^[0-9a-f]+$/.test(signature)) {
    return { orgId: null, reason: 'malformed' }
  }

  const expected = hmacSign(orgId)
  if (!constantTimeEqualHex(expected, signature)) {
    return { orgId: null, reason: 'invalid_signature' }
  }

  return { orgId }
}

/**
 * Set the attempt-org cookie to an empty value with maxAge=0.
 * Browsers treat this as "delete". Call on every callback exit
 * (success or failure) so a stale cookie from a previous attempt
 * never bleeds across logins.
 */
export function deleteAttemptOrgCookie(response: NextResponse): void {
  response.cookies.set({
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  })
}

/**
 * Exported for tests only. Do not use from application code.
 * @internal
 */
export const __test_only__ = {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  hmacSign,
}
