// @vitest-environment node
//
// Unit tests for `lib/rate-limit/upstash.ts` — the Upstash-backed
// sliding-window rate limiter abstraction (B-2-a-i).
//
// Both `@upstash/redis` and `@upstash/ratelimit` are mocked so these
// tests run hermetically (no network, no real Redis). The mocks let
// us assert:
//   - the abstraction's return shape mapping (success → allowed)
//   - the limiter-instance cache behavior
//   - the prefix and slidingWindow config flow through correctly
//   - identifier is passed through unchanged
//   - module load fails fast on missing env vars

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────
// Hoisted mocks for the Upstash packages.
//
// vi.hoisted is moved above any `import` of the mocked modules, so the
// mock factory is in scope before the SUT loads.
// ─────────────────────────────────────────────────────────────────────

const { mockLimitFn, RatelimitMock, RedisMock, slidingWindowMock } =
  vi.hoisted(() => {
    const mockLimitFn = vi.fn()
    const slidingWindowMock = vi.fn((tokens: number, window: string) => ({
      __kind: 'slidingWindow',
      tokens,
      window,
    }))
    // Use regular function expressions (not arrows) so the mocks are
    // constructable. `new RatelimitMock(...)` / `new RedisMock(...)` in
    // the SUT requires the underlying implementation to have a
    // [[Construct]] internal method, which arrow functions lack.
    const RatelimitMock = vi.fn(function (this: any, config: any) {
      this.__config = config
      this.limit = mockLimitFn
    })
    ;(RatelimitMock as any).slidingWindow = slidingWindowMock
    const RedisMock = vi.fn(function (this: any, opts: any) {
      this.__opts = opts
    })
    return { mockLimitFn, RatelimitMock, RedisMock, slidingWindowMock }
  })

vi.mock('@upstash/redis', () => ({
  Redis: RedisMock,
}))
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: RatelimitMock,
}))

// Set required env BEFORE the SUT loads.
vi.hoisted(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'
})

import {
  checkRateLimit,
  __test_only__,
  type RateLimitOptions,
} from '@/lib/rate-limit/upstash'

const ALLOWED = {
  success: true,
  remaining: 9,
  reset: 1234567890,
  limit: 10,
  pending: Promise.resolve(),
}
const DENIED = {
  success: false,
  remaining: 0,
  reset: 9876543210,
  limit: 10,
  pending: Promise.resolve(),
}

const BASE_OPTS: RateLimitOptions = {
  kind: 'sso-start',
  limit: 10,
  window: '60 s',
}

describe('checkRateLimit / return shape', () => {
  beforeEach(() => {
    mockLimitFn.mockReset()
    __test_only__.clearLimiterCache()
    RatelimitMock.mockClear()
    slidingWindowMock.mockClear()
  })

  it('maps success:true → allowed:true', async () => {
    mockLimitFn.mockResolvedValue(ALLOWED)
    const result = await checkRateLimit('1.2.3.4:sso-test', BASE_OPTS)
    expect(result).toEqual({
      allowed: true,
      remaining: 9,
      resetAt: 1234567890,
      limit: 10,
    })
  })

  it('maps success:false → allowed:false', async () => {
    mockLimitFn.mockResolvedValue(DENIED)
    const result = await checkRateLimit('1.2.3.4:sso-test', BASE_OPTS)
    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 9876543210,
      limit: 10,
    })
  })

  it('passes the identifier unchanged to Ratelimit.limit()', async () => {
    mockLimitFn.mockResolvedValue(ALLOWED)
    await checkRateLimit('203.0.113.7:abcdef0123456789', BASE_OPTS)
    expect(mockLimitFn).toHaveBeenCalledWith('203.0.113.7:abcdef0123456789')
  })
})

describe('checkRateLimit / limiter cache', () => {
  beforeEach(() => {
    mockLimitFn.mockReset()
    __test_only__.clearLimiterCache()
    RatelimitMock.mockClear()
    slidingWindowMock.mockClear()
    mockLimitFn.mockResolvedValue(ALLOWED)
  })

  it('reuses the same Ratelimit instance for repeated (kind, limit, window)', async () => {
    await checkRateLimit('a', BASE_OPTS)
    await checkRateLimit('b', BASE_OPTS)
    await checkRateLimit('c', BASE_OPTS)
    // Ratelimit constructor invoked once across 3 calls with same opts.
    expect(RatelimitMock).toHaveBeenCalledTimes(1)
  })

  it('constructs a separate Ratelimit per distinct kind', async () => {
    await checkRateLimit('a', { ...BASE_OPTS, kind: 'sso-start' })
    await checkRateLimit('a', { ...BASE_OPTS, kind: 'sso-check' })
    expect(RatelimitMock).toHaveBeenCalledTimes(2)
  })

  it('constructs a separate Ratelimit per distinct limit', async () => {
    await checkRateLimit('a', { ...BASE_OPTS, limit: 10 })
    await checkRateLimit('a', { ...BASE_OPTS, limit: 50 })
    expect(RatelimitMock).toHaveBeenCalledTimes(2)
  })

  it('constructs a separate Ratelimit per distinct window', async () => {
    await checkRateLimit('a', { ...BASE_OPTS, window: '60 s' })
    await checkRateLimit('a', { ...BASE_OPTS, window: '1 m' })
    expect(RatelimitMock).toHaveBeenCalledTimes(2)
  })
})

describe('checkRateLimit / Ratelimit construction config', () => {
  beforeEach(() => {
    mockLimitFn.mockReset()
    __test_only__.clearLimiterCache()
    RatelimitMock.mockClear()
    slidingWindowMock.mockClear()
    mockLimitFn.mockResolvedValue(ALLOWED)
  })

  it('uses sliding window (NOT fixed window) — prevents 59s/61s burst bypass', async () => {
    await checkRateLimit('a', BASE_OPTS)
    expect(slidingWindowMock).toHaveBeenCalledWith(10, '60 s')
    // The constructed Ratelimit's `limiter` field is the sliding-window
    // tagged object we returned from the mock.
    const config = RatelimitMock.mock.calls[0][0]
    expect(config.limiter).toMatchObject({
      __kind: 'slidingWindow',
      tokens: 10,
      window: '60 s',
    })
  })

  it('namespaces Redis keys with `settle:rl:<kind>` prefix', async () => {
    await checkRateLimit('a', { ...BASE_OPTS, kind: 'sso-start' })
    const config = RatelimitMock.mock.calls[0][0]
    expect(config.prefix).toBe('settle:rl:sso-start')
  })

  it('disables analytics (saves a Redis round-trip on every call)', async () => {
    await checkRateLimit('a', BASE_OPTS)
    const config = RatelimitMock.mock.calls[0][0]
    expect(config.analytics).toBe(false)
  })
})

describe('module load — fail-fast on missing env vars', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('throws if UPSTASH_REDIS_REST_URL is missing', async () => {
    const origUrl = process.env.UPSTASH_REDIS_REST_URL
    const origToken = process.env.UPSTASH_REDIS_REST_TOKEN
    delete process.env.UPSTASH_REDIS_REST_URL
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake'

    await expect(import('@/lib/rate-limit/upstash')).rejects.toThrow(
      /UPSTASH_REDIS_REST_URL/
    )

    if (origUrl) process.env.UPSTASH_REDIS_REST_URL = origUrl
    if (origToken) process.env.UPSTASH_REDIS_REST_TOKEN = origToken
  })

  it('throws if UPSTASH_REDIS_REST_TOKEN is missing', async () => {
    const origUrl = process.env.UPSTASH_REDIS_REST_URL
    const origToken = process.env.UPSTASH_REDIS_REST_TOKEN
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.example.com'
    delete process.env.UPSTASH_REDIS_REST_TOKEN

    await expect(import('@/lib/rate-limit/upstash')).rejects.toThrow(
      /UPSTASH_REDIS_REST_TOKEN/
    )

    if (origUrl) process.env.UPSTASH_REDIS_REST_URL = origUrl
    if (origToken) process.env.UPSTASH_REDIS_REST_TOKEN = origToken
  })

  it('imports successfully when both env vars are present', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.example.com'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'
    const mod = await import('@/lib/rate-limit/upstash')
    expect(mod.checkRateLimit).toBeTypeOf('function')
  })
})
