import { describe, expect, it } from 'vitest'
import { summarizeRationale } from '@/lib/utils/rationale-summary'

describe('summarizeRationale', () => {
  it('returns null for null / undefined / empty / whitespace-only input', () => {
    expect(summarizeRationale(null)).toBeNull()
    expect(summarizeRationale(undefined)).toBeNull()
    expect(summarizeRationale('')).toBeNull()
    expect(summarizeRationale('   \n  ')).toBeNull()
  })

  it('strips a leading "Field type: …" sentence and returns the rest', () => {
    const input =
      'Field type: VARCHAR(64) maps to NVARCHAR(64). NetSuite entityid is the canonical external identifier.'
    expect(summarizeRationale(input)).toBe(
      'NetSuite entityid is the canonical external identifier.',
    )
  })

  it('strips the leading "Field type: …" sentence case-insensitively', () => {
    expect(summarizeRationale('field type: int -> int. Real rationale here.')).toBe(
      'Real rationale here.',
    )
    expect(summarizeRationale('FIELD TYPE: int. Other prose.')).toBe(
      'Other prose.',
    )
  })

  it('returns null when input is only a "Field type: …" sentence', () => {
    expect(summarizeRationale('Field type: VARCHAR(64) maps to NVARCHAR(64).')).toBeNull()
  })

  it('takes the first sentence when there is no leading Field-type clause', () => {
    expect(
      summarizeRationale(
        'Customer name is the canonical CRM identity. Multiple subsystems agree on this.',
      ),
    ).toBe('Customer name is the canonical CRM identity.')
  })

  it('accepts `?` and `!` as sentence terminators', () => {
    expect(summarizeRationale('Is this the right pick? Sure looks that way.')).toBe(
      'Is this the right pick?',
    )
    expect(summarizeRationale('Confirmed! And another sentence.')).toBe(
      'Confirmed!',
    )
  })

  it('returns the full text when no terminator exists', () => {
    expect(summarizeRationale('a short rationale without a period')).toBe(
      'a short rationale without a period',
    )
  })

  it('truncates with a trailing ellipsis when the first sentence exceeds 120 chars', () => {
    const long =
      'This single sentence is being authored to be much longer than the hundred-twenty character cap that the summarizer enforces so that we can verify truncation behavior end-to-end.'
    const out = summarizeRationale(long)
    expect(out).not.toBeNull()
    if (out === null) return
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('…')).toBe(true)
    // The truncated body should not end with a stray space before the ellipsis.
    expect(out).not.toMatch(/\s…$/)
  })

  it('does not truncate a sentence at exactly the cap', () => {
    const exactly120 = 'x'.repeat(120)
    expect(summarizeRationale(exactly120)).toBe(exactly120)
  })

  it('truncates a sentence at 121 chars', () => {
    const sentence = 'x'.repeat(121)
    const out = summarizeRationale(sentence)
    expect(out).not.toBeNull()
    if (out === null) return
    expect(out.length).toBe(120)
    expect(out.endsWith('…')).toBe(true)
  })

  it('trims surrounding whitespace from the input', () => {
    expect(summarizeRationale('   Real rationale here. Plus more.   ')).toBe(
      'Real rationale here.',
    )
  })
})
