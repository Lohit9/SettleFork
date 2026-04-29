// @vitest-environment node
//
// Unit tests for the Cloudflare Turnstile server verifier
// (lib/auth/turnstile.ts).
//
// We mock global.fetch and stub NODE_ENV / TURNSTILE_SECRET_KEY for each
// case via vi.stubEnv so the verifier's branches can be exercised without
// touching the real network or relying on a process-wide env. The
// verifier reads env on every call, so the stubs apply immediately
// without needing a re-import.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import { verifyTurnstileToken } from '@/lib/auth/turnstile'

// Sentinel secret used in tests. Intentionally avoids any prefix scanned
// by the husky pre-commit hook.
const TEST_SECRET = 'turnstile-test-secret-1234'

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('verifyTurnstileToken', () => {
  let fetchMock: MockInstance<typeof fetch>
  let consoleErrorSpy: MockInstance<typeof console.error>
  let consoleWarnSpy: MockInstance<typeof console.warn>

  beforeEach(() => {
    fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ success: true }))
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns missing_token when no token is provided (secret set)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    const result = await verifyTurnstileToken(undefined)

    expect(result).toEqual({ ok: false, reason: 'missing_token' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats empty string as missing_token (secret set)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    const result = await verifyTurnstileToken('')

    expect(result).toEqual({ ok: false, reason: 'missing_token' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bypasses verification in development when secret is unset', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TURNSTILE_SECRET_KEY', '')

    const result = await verifyTurnstileToken('any-token')

    expect(result).toEqual({ ok: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalled()
  })

  it('reports misconfigured in production when secret is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', '')

    const result = await verifyTurnstileToken('any-token')

    expect(result).toEqual({ ok: false, reason: 'misconfigured' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('reports network_error with timeout code when fetch aborts', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    const abortErr = new DOMException('aborted', 'AbortError')
    fetchMock.mockRejectedValueOnce(abortErr)

    const result = await verifyTurnstileToken('tok')

    expect(result).toEqual({
      ok: false,
      reason: 'network_error',
      errorCodes: ['timeout'],
    })
  })

  it('reports network_error with fetch_failed on generic fetch rejection', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    fetchMock.mockRejectedValueOnce(new Error('connect ECONNRESET'))

    const result = await verifyTurnstileToken('tok')

    expect(result).toEqual({
      ok: false,
      reason: 'network_error',
      errorCodes: ['fetch_failed'],
    })
  })

  it('reports network_error with http_<status> on non-2xx response', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 503 }))

    const result = await verifyTurnstileToken('tok')

    expect(result).toEqual({
      ok: false,
      reason: 'network_error',
      errorCodes: ['http_503'],
    })
  })

  it('reports invalid_token when siteverify returns success: false', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        'error-codes': ['invalid-input-response'],
      }),
    )

    const result = await verifyTurnstileToken('tok')

    expect(result).toEqual({
      ok: false,
      reason: 'invalid_token',
      errorCodes: ['invalid-input-response'],
    })
  })

  it('returns ok on a successful verification and posts secret + response', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('TURNSTILE_SECRET_KEY', TEST_SECRET)

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }))

    const result = await verifyTurnstileToken('happy-token', '203.0.113.42')

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    )
    expect(init?.method).toBe('POST')
    expect(
      (init?.headers as Record<string, string> | undefined)?.[
        'Content-Type'
      ],
    ).toBe('application/x-www-form-urlencoded')

    const body = String(init?.body ?? '')
    const params = new URLSearchParams(body)
    expect(params.get('secret')).toBe(TEST_SECRET)
    expect(params.get('response')).toBe('happy-token')
    expect(params.get('remoteip')).toBe('203.0.113.42')
  })
})
