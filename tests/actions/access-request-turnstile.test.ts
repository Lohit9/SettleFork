// @vitest-environment node
//
// Runtime tests for the Turnstile gate inside `submitAccessRequest`
// (lib/actions/invites.ts). The convention across `tests/actions/` is
// source-level invariant testing via readFileSync + regex (see
// `projects.test.ts` for the rationale: avoids mocking the full
// Supabase fluent builder). For this file we deviate slightly because
// the user requested behavior assertions on the gate itself
// — missing token, invalid token, ok path. To keep the mock surface
// small we only stub the supabase admin chain that this single action
// touches: `supabaseAdmin.from('access_requests').insert(...)`. The
// downstream notify route is stubbed by replacing globalThis.fetch.
//
// Gap (documented per the prompt): the post-gate insert payload is
// asserted only via `insertSpy.toHaveBeenCalledWith(...)` here. The
// pre-existing notify-route + Resend wiring is covered by code review +
// production smoke; this file does not pin those.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────
// Turnstile verifier: we control the gate result per-test.
vi.mock('@/lib/auth/turnstile', () => ({
  verifyTurnstileToken: vi.fn(),
}))

// next/headers can't run outside a Next request scope. Stub the IP
// helper so the action doesn't try to read real request headers.
vi.mock('@/lib/utils/request-ip', () => ({
  getRequestIp: vi.fn(async () => '203.0.113.42'),
}))

// Minimal supabaseAdmin fluent stub. The action only touches:
//   supabaseAdmin.from('access_requests').insert({...})
// and reads .error from the resolved value. Other functions in
// invites.ts use additional methods, but those code paths aren't
// invoked by submitAccessRequest. `vi.hoisted` is required because
// the factory is hoisted above this file's `const` initializers.
const { insertSpy, fromSpy } = vi.hoisted(() => {
  const insertSpy = vi.fn(async () => ({ error: null as null | { message: string } }))
  const fromSpy = vi.fn(() => ({ insert: insertSpy }))
  return { insertSpy, fromSpy }
})
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: fromSpy },
}))

import { submitAccessRequest } from '@/lib/actions/invites'
import { verifyTurnstileToken } from '@/lib/auth/turnstile'

const mockedVerify = vi.mocked(verifyTurnstileToken)

const BASE_PAYLOAD = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  company: 'Acme Corp',
  role_type: 'Platform access request',
  additional_notes: undefined,
}

describe('submitAccessRequest — Turnstile gate', () => {
  let fetchMock: MockInstance<typeof fetch>
  let warnSpy: MockInstance<typeof console.warn>

  beforeEach(() => {
    fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    insertSpy.mockClear()
    fromSpy.mockClear()
    mockedVerify.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the verification error and does NOT touch Supabase when the token is missing', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: false, reason: 'missing_token' })

    const result = await submitAccessRequest({
      ...BASE_PAYLOAD,
      turnstileToken: '',
    })

    expect(result).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    })
    expect(mockedVerify).toHaveBeenCalledWith('', '203.0.113.42')
    expect(fromSpy).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns the verification error when verifier rejects the token', async () => {
    mockedVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_token',
      errorCodes: ['invalid-input-response'],
    })

    const result = await submitAccessRequest({
      ...BASE_PAYLOAD,
      turnstileToken: 'bad-token',
    })

    expect(result).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    })
    expect(fromSpy).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('flows through to Supabase insert + notify fetch when verification succeeds', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })

    const result = await submitAccessRequest({
      ...BASE_PAYLOAD,
      turnstileToken: 'ok-token',
    })

    expect(result).toEqual({ success: true })
    expect(fromSpy).toHaveBeenCalledWith('access_requests')
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Jane Smith',
        email: 'jane@example.com',
        company: 'Acme Corp',
        role_type: 'Platform access request',
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [notifyUrl, notifyInit] = fetchMock.mock.calls[0]!
    expect(String(notifyUrl)).toContain('/api/notify-access-request')
    const forwardedBody = JSON.parse(String(notifyInit?.body ?? '{}'))
    // Token must NOT be forwarded to the notify route — verifier output
    // is the only consumer.
    expect(forwardedBody).not.toHaveProperty('turnstileToken')
    expect(forwardedBody).toMatchObject({ name: 'Jane Smith', email: 'jane@example.com' })
  })

  it('returns the generic error if Supabase insert fails after a successful gate', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })
    insertSpy.mockResolvedValueOnce({ error: { message: 'unique violation' } })

    const result = await submitAccessRequest({
      ...BASE_PAYLOAD,
      turnstileToken: 'ok-token',
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/something went wrong/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
