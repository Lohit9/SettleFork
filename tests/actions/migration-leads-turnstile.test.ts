// @vitest-environment node
//
// Runtime tests for the Turnstile gate inside `submitMigrationLead`
// (lib/actions/migration-leads.ts). Mirrors the strategy used by
// `tests/actions/access-request-turnstile.test.ts`: small mock surface
// (verifier + IP helper + supabaseAdmin.from().insert() + globalThis
// fetch) instead of pulling in the full Supabase fluent builder.
//
// Cases covered: missing token, invalid token, network error from the
// verifier, happy path. Validation-failure paths are exercised by
// passing through inputs that fail the regex / required-field checks.

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

import { submitMigrationLead } from '@/lib/actions/migration-leads'
import { verifyTurnstileToken } from '@/lib/auth/turnstile'

const mockedVerify = vi.mocked(verifyTurnstileToken)

const BASE_PAYLOAD = {
  email: 'jane@example.com',
  company: 'Acme Corp',
  slug: 'salesforce-to-hubspot',
  sourceSystem: 'Salesforce',
  targetSystem: 'HubSpot',
}

describe('submitMigrationLead — Turnstile gate', () => {
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

    const result = await submitMigrationLead({
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

  it('rejects with the verification error when the verifier returns invalid_token', async () => {
    mockedVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_token',
      errorCodes: ['invalid-input-response'],
    })

    const result = await submitMigrationLead({
      ...BASE_PAYLOAD,
      turnstileToken: 'bad-token',
    })

    expect(result).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    })
    expect(insertSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects with the verification error when the verifier reports a network error', async () => {
    mockedVerify.mockResolvedValueOnce({
      ok: false,
      reason: 'network_error',
      errorCodes: ['timeout'],
    })

    const result = await submitMigrationLead({
      ...BASE_PAYLOAD,
      turnstileToken: 'tok',
    })

    expect(result).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('inserts via supabaseAdmin and fans out to the notify route on a successful gate', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })

    const result = await submitMigrationLead({
      ...BASE_PAYLOAD,
      timeline: 'This quarter',
      volume: '1M – 10M rows',
      notes: '  cross-region migration  ',
      turnstileToken: 'ok-token',
    })

    expect(result).toEqual({ success: true })

    expect(fromSpy).toHaveBeenCalledWith('migration_leads')
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith({
      company_name: 'Acme Corp',
      email: 'jane@example.com',
      source_system: 'Salesforce',
      target_system: 'HubSpot',
      timeline: 'This quarter',
      volume: '1M – 10M rows',
      notes: 'cross-region migration',
      page_slug: 'salesforce-to-hubspot',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [notifyUrl, notifyInit] = fetchMock.mock.calls[0]!
    expect(String(notifyUrl)).toContain('/api/notify-access-request')
    const forwarded = JSON.parse(String(notifyInit?.body ?? '{}'))
    expect(forwarded).toMatchObject({
      email: 'jane@example.com',
      company: 'Acme Corp',
      ref: 'assessment',
      systems_involved: 'Salesforce → HubSpot',
    })
    // Token must NOT be forwarded — it's verifier input only.
    expect(forwarded).not.toHaveProperty('turnstileToken')
    expect(forwarded.additional_notes).toContain('Timeline: This quarter')
    expect(forwarded.additional_notes).toContain('Data volume: 1M – 10M rows')
    expect(forwarded.additional_notes).toContain('cross-region migration')
  })

  it('returns the generic insert error and skips notify when the DB write fails', async () => {
    mockedVerify.mockResolvedValueOnce({ ok: true })
    insertSpy.mockResolvedValueOnce({ error: { message: 'unique violation' } })

    const result = await submitMigrationLead({
      ...BASE_PAYLOAD,
      turnstileToken: 'ok-token',
    })

    expect(result).toEqual({ success: false, error: 'Something went wrong. Please try again.' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('rejects with a validation error before calling the verifier when the email is malformed', async () => {
    const result = await submitMigrationLead({
      ...BASE_PAYLOAD,
      email: 'not-an-email',
      turnstileToken: 'ok-token',
    })

    expect(result.success).toBe(false)
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects with a validation error when the slug or system fields are missing', async () => {
    const result = await submitMigrationLead({
      ...BASE_PAYLOAD,
      slug: '',
      turnstileToken: 'ok-token',
    })

    expect(result.success).toBe(false)
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
