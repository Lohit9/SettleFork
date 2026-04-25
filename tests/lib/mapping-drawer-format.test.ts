import { describe, expect, it } from 'vitest'
import {
  SAMPLE_VALUES_DEFAULT_MAX,
  formatSampleValues,
} from '@/lib/utils/mapping-drawer-format'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 8b — formatSampleValues unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure-function coverage. No React, no fixtures beyond plain string arrays.
// The ~8 cases below exercise: null/empty short-circuit, identity render
// at and below the threshold, truncation tail, overflow arithmetic, and
// the "values with internal commas survive verbatim" invariant.

describe('formatSampleValues', () => {
  it('returns empty string when samples is null', () => {
    expect(formatSampleValues(null)).toBe('')
  })

  it('returns empty string when samples is an empty array', () => {
    expect(formatSampleValues([])).toBe('')
  })

  it('returns the single value as-is when length === 1', () => {
    expect(formatSampleValues(['v1'])).toBe('v1')
  })

  it('joins 5 values with ", " separator (no truncation)', () => {
    expect(formatSampleValues(['v1', 'v2', 'v3', 'v4', 'v5'])).toBe(
      'v1, v2, v3, v4, v5',
    )
  })

  it('joins all 8 values when length === default max (no overflow tail)', () => {
    const eight = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']
    const out = formatSampleValues(eight)
    expect(out).toBe('v1, v2, v3, v4, v5, v6, v7, v8')
    expect(out).not.toContain('more')
  })

  it('truncates 9 values to first 8 + "... (+1 more)"', () => {
    const nine = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']
    expect(formatSampleValues(nine)).toBe(
      'v1, v2, v3, v4, v5, v6, v7, v8, ... (+1 more)',
    )
  })

  it('truncates 15 values to first 8 + "... (+7 more)"', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `v${i + 1}`)
    expect(formatSampleValues(fifteen)).toBe(
      'v1, v2, v3, v4, v5, v6, v7, v8, ... (+7 more)',
    )
  })

  it('preserves values that contain internal commas without quoting or escaping', () => {
    const withCommas = ['Smith, John', 'Doe, Jane', 'plain']
    expect(formatSampleValues(withCommas)).toBe(
      'Smith, John, Doe, Jane, plain',
    )
  })

  it('honors a custom max parameter (smaller than default)', () => {
    expect(formatSampleValues(['v1', 'v2', 'v3', 'v4'], 2)).toBe(
      'v1, v2, ... (+2 more)',
    )
  })

  it('exports SAMPLE_VALUES_DEFAULT_MAX = 8', () => {
    expect(SAMPLE_VALUES_DEFAULT_MAX).toBe(8)
  })
})
