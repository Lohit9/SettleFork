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

describe('formatConfidencePercent — parity with pre-lift inline copies', () => {
  // These five inputs are the locked refactor parity set per §11-OQ-1.
  // They span: integer 0-100 (the canonical storage convention),
  // sub-integer 0-100, the 0-1 fraction defensive branch, the null
  // branch, and a boundary value (100 → "100.00%").
  it('null returns em-dash', () => {
    expect(formatConfidencePercent(null)).toBe('—')
  })

  it('integer 0-100 renders 2-decimal percent', () => {
    expect(formatConfidencePercent(85)).toBe('85.00%')
  })

  it('decimal 0-100 preserves precision', () => {
    expect(formatConfidencePercent(85.42)).toBe('85.42%')
  })

  it('0-1 fraction multiplies ×100 (defensive drift guard)', () => {
    expect(formatConfidencePercent(0.85)).toBe('85.00%')
  })

  it('value of exactly 1 stays as 1.00% (boundary at the >1 gate)', () => {
    // The inline copies all use `confidence > 1` so 1 is treated as
    // a 0-1 fraction and multiplied. 1 * 100 = 100. Pin the parity.
    expect(formatConfidencePercent(1)).toBe('100.00%')
  })

  it('value 100 stays as 100.00%', () => {
    expect(formatConfidencePercent(100)).toBe('100.00%')
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
