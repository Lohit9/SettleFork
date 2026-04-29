// @vitest-environment node
//
// Runtime tests for the Turnstile gate inside `submitPricingEstimate`
// (lib/actions/pricing-estimate.ts). Mirrors the small-mock strategy
// used by `access-request-turnstile.test.ts` and
// `migration-leads-turnstile.test.ts`: stub only the
// `supabaseAdmin.from('pricing_leads').insert(...)` chain plus
// globalThis.fetch for the notify route.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

vi.mock('@/lib/auth/turnstile', () => ({
  verifyTurnstileToken: vi.fn(),
}))

vi.mock('@/lib/utils/request-ip', () => ({
  getRequestIp: vi.fn(async () => '203.0.113.42'),
}))

const { insertSpy, fromSpy } = vi.hoisted(() => {
  const insertSpy = vi.fn(async () => ({ error: null as null | { message: string } }))
  const fromSpy = vi.fn(() => ({ insert: insertSpy }))
  return { insertSpy, fromSpy }
})
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: fromSpy },
}))

import { submitPricingEstimate } from '@/lib/actions/pricing-estimate'
import { verifyTurnstileToken } from '@/lib/auth/turnstile'

const mockedVerify = vi.mocked(verifyTurnstileToken)

const BASE_PAYLOAD = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  company: 'Acme Corp',
  role: 'VP Engineering',
  systemType: 'crm',
  sourceSystemCount: '2-3',
  tableCountRange: '50-200',
  timeline: '1-3-months',
  computedTier: 'growth',
  priceRangeShown: '$5,000 – $8,000',
}

describe('submitPricingEstimate — Turnstile gate', () => {
  let fetchMock: MockInstance<typeof fetch>
  let warnSpy: MockInstance<typeof console.warn>
  let errorSpy: MockInstance<typeof console.error>

  beforeEach(() => {
    fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    insertSpy.mockClear()
    fromSpy.mockClear()
    mockedVerify.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects with the verification error and does NOT touch Supabase when the token is missing', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: false, reason: 'missing_token' })

    const result = await submitPricingEstimate({
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

  it('rejects when the verifier returns invalid_token', async () => {
    mockedVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_token',
      errorCodes: ['invalid-input-response'],
    })

    const result = await submitPricingEstimate({
      ...BASE_PAYLOAD,
      turnstileToken: 'bad',
    })

    expect(result).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    })
    expect(insertSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects when the verifier reports a network error', async () => {
    mockedVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'network_error',
      errorCodes: ['timeout'],
    })

    const result = await submitPricingEstimate({
      ...BASE_PAYLOAD,
      turnstileToken: 'tok',
    })

    expect(result).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('inserts via supabaseAdmin and fans out to the notify route on success', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })

    const result = await submitPricingEstimate({
      ...BASE_PAYLOAD,
      turnstileToken: 'ok-token',
    })

    expect(result).toEqual({ success: true })

    expect(fromSpy).toHaveBeenCalledWith('pricing_leads')
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith({
      name: 'Jane Smith',
      email: 'jane@example.com',
      company: 'Acme Corp',
      role: 'VP Engineering',
      system_type: 'crm',
      source_system_count: '2-3',
      table_count_range: '50-200',
      timeline: '1-3-months',
      computed_tier: 'growth',
      price_range_shown: '$5,000 – $8,000',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [notifyUrl, notifyInit] = fetchMock.mock.calls[0]!
    expect(String(notifyUrl)).toContain('/api/notify-pricing-estimate')
    const forwarded = JSON.parse(String(notifyInit?.body ?? '{}'))
    // snake_case keys preserved — the route destructures these names.
    expect(forwarded).toMatchObject({
      name: 'Jane Smith',
      email: 'jane@example.com',
      company: 'Acme Corp',
      role: 'VP Engineering',
      system_type: 'crm',
      source_system_count: '2-3',
      table_count_range: '50-200',
      timeline: '1-3-months',
      computed_tier: 'growth',
      price_range_shown: '$5,000 – $8,000',
    })
    // Token must NOT leak to the notify route.
    expect(forwarded).not.toHaveProperty('turnstileToken')
  })

  it('writes role: null when role is omitted', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })

    const { role: _role, ...withoutRole } = BASE_PAYLOAD
    void _role
    const result = await submitPricingEstimate({
      ...withoutRole,
      turnstileToken: 'ok-token',
    })

    expect(result).toEqual({ success: true })
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: null }),
    )
  })

  it('returns the generic error and skips notify when the DB write fails', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })
    insertSpy.mockResolvedValueOnce({ error: { message: 'unique violation' } })

    const result = await submitPricingEstimate({
      ...BASE_PAYLOAD,
      turnstileToken: 'ok-token',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/something went wrong/i)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('rejects with a validation error before calling the verifier when the email is malformed', async () => {
    const result = await submitPricingEstimate({
      ...BASE_PAYLOAD,
      email: 'not-an-email',
      turnstileToken: 'ok-token',
    })

    expect(result.success).toBe(false)
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects with a validation error when an estimator answer is missing', async () => {
    const result = await submitPricingEstimate({
      ...BASE_PAYLOAD,
      systemType: '',
      turnstileToken: 'ok-token',
    })

    expect(result.success).toBe(false)
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
