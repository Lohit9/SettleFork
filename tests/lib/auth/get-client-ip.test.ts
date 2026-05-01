// @vitest-environment node
//
// Unit tests for `lib/auth/get-client-ip.ts` — the canonical
// header-based client-IP extractor used by the SSO rate limiters
// (B-2-a-i). Tests assert header-priority order, whitespace handling,
// fail-soft (null) on miss, and the audit-safe hashIp helper.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// next/headers is mocked because in node test environment it does
// not have a request scope to read from; we control the headers map
// directly to exercise each branch.
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}))

import { headers } from 'next/headers'
import { getClientIp, hashIp } from '@/lib/auth/get-client-ip'

function makeHeaders(map: Record<string, string | undefined>) {
  // Minimal Headers-like shim: only .get() is used by the helper.
  return {
    get(name: string): string | null {
      return map[name.toLowerCase()] ?? null
    },
  }
}

describe('getClientIp / x-forwarded-for', () => {
  beforeEach(() => {
    vi.mocked(headers).mockReset()
  })

  it('returns the trimmed value when xff has a single IP', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({ 'x-forwarded-for': '203.0.113.7' }) as any
    )
    expect(await getClientIp()).toBe('203.0.113.7')
  })

  it('returns the FIRST comma-segment, trimmed, when xff is a chain', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({
        'x-forwarded-for': '203.0.113.7, 10.0.0.1, 172.16.0.5',
      }) as any
    )
    expect(await getClientIp()).toBe('203.0.113.7')
  })

  it('strips whitespace around the first segment', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({ 'x-forwarded-for': '   203.0.113.7   , 10.0.0.1' }) as any
    )
    expect(await getClientIp()).toBe('203.0.113.7')
  })

  it('falls through to x-real-ip when xff is empty string', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({
        'x-forwarded-for': '',
        'x-real-ip': '198.51.100.42',
      }) as any
    )
    expect(await getClientIp()).toBe('198.51.100.42')
  })

  it('falls through to x-real-ip when xff first segment is whitespace-only', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({
        'x-forwarded-for': '   , 10.0.0.1',
        'x-real-ip': '198.51.100.42',
      }) as any
    )
    expect(await getClientIp()).toBe('198.51.100.42')
  })
})

describe('getClientIp / x-real-ip fallback', () => {
  beforeEach(() => {
    vi.mocked(headers).mockReset()
  })

  it('returns x-real-ip when xff is absent', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({ 'x-real-ip': '198.51.100.42' }) as any
    )
    expect(await getClientIp()).toBe('198.51.100.42')
  })

  it('trims whitespace on x-real-ip', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({ 'x-real-ip': '  198.51.100.42  ' }) as any
    )
    expect(await getClientIp()).toBe('198.51.100.42')
  })

  it('falls through to cf-connecting-ip when x-real-ip is whitespace only', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({
        'x-real-ip': '   ',
        'cf-connecting-ip': '192.0.2.99',
      }) as any
    )
    expect(await getClientIp()).toBe('192.0.2.99')
  })
})

describe('getClientIp / cf-connecting-ip fallback', () => {
  beforeEach(() => {
    vi.mocked(headers).mockReset()
  })

  it('returns cf-connecting-ip when both xff and x-real-ip are absent', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({ 'cf-connecting-ip': '192.0.2.99' }) as any
    )
    expect(await getClientIp()).toBe('192.0.2.99')
  })
})

describe('getClientIp / fail-closed null on miss', () => {
  beforeEach(() => {
    vi.mocked(headers).mockReset()
  })

  it('returns null when none of the three headers are present', async () => {
    vi.mocked(headers).mockResolvedValue(makeHeaders({}) as any)
    expect(await getClientIp()).toBeNull()
  })

  it('returns null when all three headers are empty strings', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({
        'x-forwarded-for': '',
        'x-real-ip': '',
        'cf-connecting-ip': '',
      }) as any
    )
    expect(await getClientIp()).toBeNull()
  })

  it('returns null when all three headers are whitespace-only', async () => {
    vi.mocked(headers).mockResolvedValue(
      makeHeaders({
        'x-forwarded-for': '   ',
        'x-real-ip': '\t\t',
        'cf-connecting-ip': ' ',
      }) as any
    )
    expect(await getClientIp()).toBeNull()
  })

  it('does not fall back to "127.0.0.1" or any other sentinel string', async () => {
    // Regression guard: lib/actions/auth.ts:62-65 falls back to
    // '127.0.0.1' for the in-memory signup limiter. The new helper
    // MUST NOT replicate that pattern — null lets the caller make
    // the fail-closed decision explicitly.
    vi.mocked(headers).mockResolvedValue(makeHeaders({}) as any)
    const result = await getClientIp()
    expect(result).not.toBe('127.0.0.1')
    expect(result).not.toBe('0.0.0.0')
    expect(result).not.toBe('unknown')
    expect(result).toBeNull()
  })
})

describe('hashIp', () => {
  it('returns a 16-character lowercase hex string', async () => {
    const h = hashIp('1.2.3.4')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(h.length).toBe(16)
  })

  it('is deterministic — same input produces same hash', async () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4'))
  })

  it('returns different hashes for different IPs', async () => {
    expect(hashIp('1.2.3.4')).not.toBe(hashIp('1.2.3.5'))
    expect(hashIp('203.0.113.7')).not.toBe(hashIp('198.51.100.42'))
  })

  it('does not echo the raw IP anywhere in the output', async () => {
    // Defensive: hash must not be a transformation that reveals the
    // input (e.g. base64). 16 hex chars of SHA-256 is too short to
    // contain "203.0.113.7" as a substring, but assert anyway.
    const h = hashIp('203.0.113.7')
    expect(h).not.toContain('203')
    expect(h).not.toContain('113')
  })
})
