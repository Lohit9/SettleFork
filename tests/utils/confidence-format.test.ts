import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_THRESHOLD_HIGH,
  CONFIDENCE_THRESHOLD_POSSIBLE,
  classifyConfidence,
  formatConfidenceLabel,
  formatConfidencePercent,
} from '@/lib/utils/confidence-format'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4b — confidence-format helper tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pin the lift-from-3-inline-copies behavior: same string output, same
// tolerance for 0-1 vs 0-100 inputs, same null/non-finite handling. Plus
// the new threshold classifier + label helper consumed exclusively by
// `ConfidencePill`.

describe('formatConfidencePercent — Refinement H integer rounding', () => {
  // Phase 4-polish-1 Refinement H (2026-04-26): dropped 2-decimal
  // precision in favor of integer rounding. The fractional part read
  // as numeric noise without analytical value. Pin the new format
  // verbatim across the canonical input set: null branch, integer
  // 0-100, decimal 0-100 (rounding behavior), 0-1 fraction defensive
  // branch, boundary at the >1 gate.
  it('null returns em-dash', () => {
    expect(formatConfidencePercent(null)).toBe('—')
  })

  it('integer 0-100 renders integer percent', () => {
    expect(formatConfidencePercent(85)).toBe('85%')
  })

  it('decimal 0-100 rounds to nearest integer', () => {
    expect(formatConfidencePercent(85.42)).toBe('85%')
    expect(formatConfidencePercent(85.6)).toBe('86%')
    expect(formatConfidencePercent(99.4)).toBe('99%')
    expect(formatConfidencePercent(99.5)).toBe('100%')
  })

  it('0-1 fraction multiplies ×100 then rounds (defensive drift guard)', () => {
    expect(formatConfidencePercent(0.85)).toBe('85%')
    expect(formatConfidencePercent(0.925)).toBe('93%')
  })

  it('value of exactly 1 renders as 100% (boundary at the >1 gate)', () => {
    // The implementation uses `confidence > 1` so 1 is treated as
    // a 0-1 fraction and multiplied. 1 * 100 = 100. Pin the parity.
    expect(formatConfidencePercent(1)).toBe('100%')
  })

  it('value 100 renders as 100%', () => {
    expect(formatConfidencePercent(100)).toBe('100%')
  })

  it('two-decimal precision is gone (Refinement H regression guard)', () => {
    // Pin the absence of `.NN%` suffixes — a future revert that re-
    // introduces `.toFixed(2)` would silently fail this. Test every
    // call site's typical input:
    expect(formatConfidencePercent(92.5)).not.toContain('.')
    expect(formatConfidencePercent(85)).not.toContain('.')
    expect(formatConfidencePercent(0.92)).not.toContain('.')
  })
})

describe('classifyConfidence — threshold bands', () => {
  it('exposes the threshold constants', () => {
    expect(CONFIDENCE_THRESHOLD_HIGH).toBe(70)
    expect(CONFIDENCE_THRESHOLD_POSSIBLE).toBe(40)
  })

  it('returns "high" at and above 70', () => {
    expect(classifyConfidence(70)).toBe('high')
    expect(classifyConfidence(85)).toBe('high')
    expect(classifyConfidence(100)).toBe('high')
  })

  it('returns "possible" between 40 (inclusive) and 70 (exclusive)', () => {
    expect(classifyConfidence(40)).toBe('possible')
    expect(classifyConfidence(55)).toBe('possible')
    expect(classifyConfidence(69)).toBe('possible')
  })

  it('returns "uncertain" below 40', () => {
    expect(classifyConfidence(39)).toBe('uncertain')
    expect(classifyConfidence(0)).toBe('uncertain')
  })

  it('handles 0-1 fractions consistently with the percent formatter', () => {
    // 0.85 → 85 → 'high'; 0.55 → 55 → 'possible'; 0.25 → 25 →
    // 'uncertain'. Pin the parallel with formatConfidencePercent.
    expect(classifyConfidence(0.85)).toBe('high')
    expect(classifyConfidence(0.55)).toBe('possible')
    expect(classifyConfidence(0.25)).toBe('uncertain')
  })

  it('NaN and Infinity collapse to "uncertain"', () => {
    expect(classifyConfidence(Number.NaN)).toBe('uncertain')
    expect(classifyConfidence(Number.POSITIVE_INFINITY)).toBe('uncertain')
  })
})

describe('formatConfidenceLabel — pill label + threshold band', () => {
  it('high band renders "Confident (N%)"', () => {
    expect(formatConfidenceLabel(85)).toEqual({
      label: 'Confident (85%)',
      threshold: 'high',
    })
  })

  it('possible band renders "Possible match (N%)"', () => {
    expect(formatConfidenceLabel(55)).toEqual({
      label: 'Possible match (55%)',
      threshold: 'possible',
    })
  })

  it('uncertain band renders "Low confidence (N%)"', () => {
    expect(formatConfidenceLabel(25)).toEqual({
      label: 'Low confidence (25%)',
      threshold: 'uncertain',
    })
  })

  it('rounds non-integer inputs', () => {
    // 84.6 → rounded to 85, classified as 'high'
    expect(formatConfidenceLabel(84.6)).toEqual({
      label: 'Confident (85%)',
      threshold: 'high',
    })
  })

  it('boundary values land on the higher band (>=)', () => {
    // 70 is the exact 'high' boundary, 40 is the exact 'possible'.
    expect(formatConfidenceLabel(70).threshold).toBe('high')
    expect(formatConfidenceLabel(40).threshold).toBe('possible')
  })
})
