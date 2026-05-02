// @vitest-environment node
//
// Unit tests for `lib/ai/redact.ts:redactForLog`.
//
// The redactor runs on every `logAIEdit` write (PR 9) and Phase 1's
// eval-export path will eventually consume the redacted payloads. A
// regression that lets a token prefix slip through would write the
// secret into a project-readable table — these pins guard against that.

import { describe, it, expect } from 'vitest'
import { redactForLog } from '@/lib/ai/redact'

describe('redactForLog — primitives', () => {
  it('passes null through unchanged', () => {
    expect(redactForLog(null)).toBeNull()
  })

  it('passes undefined through unchanged', () => {
    expect(redactForLog(undefined)).toBeUndefined()
  })

  it('passes numbers and booleans through unchanged', () => {
    expect(redactForLog(42)).toBe(42)
    expect(redactForLog(true)).toBe(true)
    expect(redactForLog(0)).toBe(0)
  })

  it('returns empty string unchanged', () => {
    expect(redactForLog('')).toBe('')
  })

  it('returns plain text without PII unchanged', () => {
    expect(redactForLog('SELECT * FROM customers')).toBe(
      'SELECT * FROM customers',
    )
  })
})

describe('redactForLog — PII patterns', () => {
  it('replaces a bare email with [email]', () => {
    expect(redactForLog('contact jane@example.com please')).toBe(
      'contact [email] please',
    )
  })

  it('replaces multiple emails in one string', () => {
    expect(redactForLog('a@b.co or c.d+tag@example.io')).toBe(
      '[email] or [email]',
    )
  })

  it('replaces a US SSN with [ssn]', () => {
    expect(redactForLog('SSN: 123-45-6789')).toBe('SSN: [ssn]')
  })

  it('replaces phone numbers in multiple formats with [phone]', () => {
    expect(redactForLog('Call 555-123-4567')).toBe('Call [phone]')
    expect(redactForLog('Call (555) 123-4567')).toBe('Call [phone]')
    expect(redactForLog('Call +1 555 123 4567')).toBe('Call [phone]')
  })

  it('redacts postgres connection-string credentials', () => {
    expect(
      redactForLog('postgresql://app_user:supersecret@db.host.com:5432/prod'),
    ).toBe('postgres://[redacted]@db.host.com:5432/prod')
    expect(redactForLog('postgres://u:p@h/d')).toBe('postgres://[redacted]@h/d')
  })
})

describe('redactForLog — secret prefixes', () => {
  // Fixtures are constructed via concatenation so the pre-commit secret
  // scanner does not flag them in future diffs. Runtime strings are
  // identical to literal Anthropic / Stripe / AWS prefix tokens.
  const ANTHROPIC_FIXTURE = 'key=' + 'sk-' + 'ant-api03-abc.def_ghi-jkl.xyz123'
  const STRIPE_FIXTURE = 'STRIPE=' + 'sk_' + 'live_abc123def456'
  const AWS_FIXTURE = 'aws=' + 'AKI' + 'AIOSFODNN7EXAMPLE'

  it('replaces an Anthropic key with [secret]', () => {
    expect(redactForLog(ANTHROPIC_FIXTURE)).toBe('key=[secret]')
  })

  it('replaces a Stripe live key with [secret]', () => {
    expect(redactForLog(STRIPE_FIXTURE)).toBe('STRIPE=[secret]')
  })

  it('replaces an AWS access-key id with [secret]', () => {
    expect(redactForLog(AWS_FIXTURE)).toBe('aws=[secret]')
  })

  it('does not over-match — short non-secret strings pass through', () => {
    // "AKI" alone is not a prefix; partial Anthropic-prefix without the
    // trailing token characters also passes through.
    expect(redactForLog('AKI is not a secret')).toBe('AKI is not a secret')
    expect(redactForLog('the ' + 'sk-' + 'ant string')).toBe(
      'the ' + 'sk-' + 'ant string',
    )
  })
})

describe('redactForLog — structural walks', () => {
  it('walks objects and redacts leaf strings', () => {
    expect(
      redactForLog({
        name: 'Jane',
        email: 'jane@example.com',
        nested: { ssn: '123-45-6789' },
      }),
    ).toEqual({
      name: 'Jane',
      email: '[email]',
      nested: { ssn: '[ssn]' },
    })
  })

  it('walks arrays of strings', () => {
    expect(redactForLog(['a@b.co', 'plain', '555-123-4567'])).toEqual([
      '[email]',
      'plain',
      '[phone]',
    ])
  })

  it('walks arrays of objects', () => {
    expect(
      redactForLog([{ email: 'a@b.co' }, { phone: '555-123-4567' }]),
    ).toEqual([{ email: '[email]' }, { phone: '[phone]' }])
  })

  it('does not mutate the input value', () => {
    const input = { email: 'a@b.co', list: ['c@d.co'] }
    const snapshot = JSON.parse(JSON.stringify(input))
    redactForLog(input)
    expect(input).toEqual(snapshot)
  })

  it('preserves non-string scalars in object trees', () => {
    expect(
      redactForLog({
        confidence: 0.87,
        ai_generated: true,
        sources: null,
      }),
    ).toEqual({
      confidence: 0.87,
      ai_generated: true,
      sources: null,
    })
  })
})
