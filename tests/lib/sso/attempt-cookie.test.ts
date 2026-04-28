// @vitest-environment node
//
// Unit tests for `lib/sso/attempt-cookie.ts` — the signed cookie that
// plumbs attempted_org_id from /sso/start to /api/auth/callback.
//
// The module throws at load if SSO_ATTEMPT_COOKIE_SECRET is unset.
// We set a deterministic test secret via vi.hoisted (which runs
// before any import statement is evaluated) so this test runs in
// isolation regardless of whether .env.local is present.

import { describe, it, expect, vi } from 'vitest'

// Hoisted: ensure the secret is set before the module under test
// loads. vi.hoisted is moved above all `import` statements by the
// vitest transformer, so this assignment wins the race against the
// `import` below.
vi.hoisted(() => {
  if (!process.env.SSO_ATTEMPT_COOKIE_SECRET) {
    // 64 hex chars — same shape as `openssl rand -hex 32` output.
    process.env.SSO_ATTEMPT_COOKIE_SECRET =
      'a'.repeat(32) + 'b'.repeat(32)
  }
})

import {
  setAttemptOrgCookie,
  readAttemptOrgCookie,
  deleteAttemptOrgCookie,
  __test_only__,
} from '@/lib/sso/attempt-cookie'

const VALID_ORG_ID = '6363a3af-5829-4e94-b9f7-20aefa4900ad'
const OTHER_ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// ─────────────────────────────────────────────────────────────────────
// Minimal NextResponse stand-in. The real NextResponse exposes a
// `cookies` object with a `set(opts)` method that records to internal
// state. We only need to capture what would be written, so a tiny
// shim suffices and avoids spinning up a Next runtime.
// ─────────────────────────────────────────────────────────────────────

interface CookieRecord {
  name: string
  value: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  maxAge?: number
  path?: string
}

function makeFakeResponse() {
  const writes: CookieRecord[] = []
  const fake = {
    cookies: {
      set(opts: CookieRecord) {
        writes.push(opts)
      },
    },
  }
  return { fake: fake as any, writes }
}

function makeFakeRequest(cookieHeader: string | null): Request {
  // The real implementation only calls .headers.get('cookie'), so
  // a Headers-with-Map shim is enough.
  const headers = new Map<string, string>()
  if (cookieHeader !== null) headers.set('cookie', cookieHeader)
  return {
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
  } as unknown as Request
}

// ─────────────────────────────────────────────────────────────────────

describe('attempt-cookie / sign+verify roundtrip', () => {
  it('setAttemptOrgCookie writes a HttpOnly, SameSite=Lax, 5-min cookie', () => {
    const { fake, writes } = makeFakeResponse()
    setAttemptOrgCookie(fake, VALID_ORG_ID)

    expect(writes).toHaveLength(1)
    const w = writes[0]
    expect(w.name).toBe(__test_only__.COOKIE_NAME)
    expect(w.httpOnly).toBe(true)
    expect(w.sameSite).toBe('lax')
    expect(w.maxAge).toBe(__test_only__.MAX_AGE_SECONDS)
    expect(w.maxAge).toBe(300)
    expect(w.path).toBe('/')
  })

  it('cookie value is `${signature}.${orgId}` where signature is HMAC-SHA256 hex (64 chars)', () => {
    const { fake, writes } = makeFakeResponse()
    setAttemptOrgCookie(fake, VALID_ORG_ID)
    const value = writes[0].value
    // Split on the FIRST dot only — the orgId (a UUID) is on the
    // right-hand side and contains no dots itself.
    const dotIdx = value.indexOf('.')
    expect(dotIdx).toBeGreaterThan(0)
    const sig = value.slice(0, dotIdx)
    const org = value.slice(dotIdx + 1)
    // Signature half: 64 hex chars.
    expect(sig).toHaveLength(64)
    expect(sig).toMatch(/^[0-9a-f]+$/)
    // Org half: the orgId we passed in, verbatim.
    expect(org).toBe(VALID_ORG_ID)
    // Recompute the expected full value to pin the format end-to-end.
    const expectedSig = __test_only__.hmacSign(VALID_ORG_ID)
    expect(value).toBe(`${expectedSig}.${VALID_ORG_ID}`)
  })

  it('readAttemptOrgCookie returns the orgId for a valid signed cookie', () => {
    const { fake, writes } = makeFakeResponse()
    setAttemptOrgCookie(fake, VALID_ORG_ID)
    const cookieHeader = `${__test_only__.COOKIE_NAME}=${writes[0].value}`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: VALID_ORG_ID })
  })
})

describe('attempt-cookie / negative paths', () => {
  it('returns reason="missing" when no Cookie header is present', () => {
    const result = readAttemptOrgCookie(makeFakeRequest(null))
    expect(result).toEqual({ orgId: null, reason: 'missing' })
  })

  it('returns reason="missing" when Cookie header is present but our cookie is not in it', () => {
    const result = readAttemptOrgCookie(
      makeFakeRequest('some-other-cookie=foo; another=bar')
    )
    expect(result).toEqual({ orgId: null, reason: 'missing' })
  })

  it('returns reason="malformed" when value lacks the dot delimiter', () => {
    const cookieHeader = `${__test_only__.COOKIE_NAME}=just-a-flat-string`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: null, reason: 'malformed' })
  })

  it('returns reason="malformed" when signature half is non-hex', () => {
    const cookieHeader = `${__test_only__.COOKIE_NAME}=zz${'z'.repeat(62)}.${VALID_ORG_ID}`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: null, reason: 'malformed' })
  })

  it('returns reason="malformed" when signature half is the wrong length', () => {
    // 32 hex chars instead of 64.
    const cookieHeader = `${__test_only__.COOKIE_NAME}=${'a'.repeat(32)}.${VALID_ORG_ID}`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: null, reason: 'malformed' })
  })

  it('returns reason="invalid_signature" when signature does not verify', () => {
    // Take a valid signature and flip one byte in the middle.
    const sig = __test_only__.hmacSign(VALID_ORG_ID)
    const tampered = sig.slice(0, 30) + (sig[30] === '0' ? '1' : '0') + sig.slice(31)
    const cookieHeader = `${__test_only__.COOKIE_NAME}=${tampered}.${VALID_ORG_ID}`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: null, reason: 'invalid_signature' })
  })

  it('returns reason="invalid_signature" when orgId is swapped (signature was for a different orgId)', () => {
    // Sign org A, present org B with org A's signature.
    const sigA = __test_only__.hmacSign(VALID_ORG_ID)
    const cookieHeader = `${__test_only__.COOKIE_NAME}=${sigA}.${OTHER_ORG_ID}`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: null, reason: 'invalid_signature' })
  })

  it('rejects an empty orgId half (treated as malformed because no chars after dot)', () => {
    const sig = __test_only__.hmacSign('')
    const cookieHeader = `${__test_only__.COOKIE_NAME}=${sig}.`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result.orgId).toBeNull()
    expect(result.reason).toBe('malformed')
  })
})

describe('attempt-cookie / cross-orgId isolation', () => {
  it('signature for org A does NOT verify for org B', () => {
    // Independent verification that the signing function is keyed by
    // orgId (not just by secret). If a regression made the signature
    // independent of orgId, the cross-tenant check would silently
    // pass for any cookie whose signature was once valid.
    const sigA = __test_only__.hmacSign(VALID_ORG_ID)
    const sigB = __test_only__.hmacSign(OTHER_ORG_ID)
    expect(sigA).not.toBe(sigB)
  })
})

describe('attempt-cookie / deleteAttemptOrgCookie', () => {
  it('writes the cookie with maxAge=0 and an empty value', () => {
    const { fake, writes } = makeFakeResponse()
    deleteAttemptOrgCookie(fake)
    expect(writes).toHaveLength(1)
    const w = writes[0]
    expect(w.name).toBe(__test_only__.COOKIE_NAME)
    expect(w.value).toBe('')
    expect(w.maxAge).toBe(0)
    expect(w.path).toBe('/')
    // HttpOnly + SameSite are preserved on delete so the browser's
    // attribute-match rule for cookie deletion can fire.
    expect(w.httpOnly).toBe(true)
    expect(w.sameSite).toBe('lax')
  })
})

describe('attempt-cookie / cookie header parsing edge cases', () => {
  it('parses our cookie when surrounded by other cookies and whitespace', () => {
    const { fake, writes } = makeFakeResponse()
    setAttemptOrgCookie(fake, VALID_ORG_ID)
    const ours = `${__test_only__.COOKIE_NAME}=${writes[0].value}`
    const cookieHeader = `sb-foo-auth-token=abc;   ${ours}  ; tracking=xyz`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: VALID_ORG_ID })
  })

  it('does not match cookies whose name is a prefix or suffix of ours', () => {
    const { fake, writes } = makeFakeResponse()
    setAttemptOrgCookie(fake, VALID_ORG_ID)
    const value = writes[0].value
    // Adversarial: a cookie literally named "settle-sso-attempt-org-x"
    // must NOT match. The parser uses an exact-name compare so a
    // prefix collision can't smuggle an unsigned value past us.
    const cookieHeader = `${__test_only__.COOKIE_NAME}-x=${value}; pre-${__test_only__.COOKIE_NAME}=${value}`
    const result = readAttemptOrgCookie(makeFakeRequest(cookieHeader))
    expect(result).toEqual({ orgId: null, reason: 'missing' })
  })
})
