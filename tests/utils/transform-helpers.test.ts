import { describe, it, expect } from 'vitest'
import { fieldNeedsTransform } from '@/lib/utils/transform-helpers'

/**
 * Unit coverage for the `fieldNeedsTransform` heuristic.
 *
 * Pins the evaluation order mandated by migration 075:
 *   1. `needsTransformation === false` → return false (user dismissal wins).
 *   2. `hasTransformation` → return true.
 *   3. `needsTransformation === true` → return true.
 *   4. NULL + type-family fallback.
 *
 * The headline regression (regression-1 below) is the transform-toggle
 * persistence bug: before this fix, the defensive regex on `type_compatibility`
 * re-flagged user-dismissed fields whenever the AI's compatibility note
 * contained any of a long list of common words ("needs", "convert", "format",
 * etc.), silently reverting the toggle on page refresh.
 */

const BASE = {
  sourceDataType: 'DECIMAL(15,2)',
  targetDataType: 'DECIMAL(15,2)',
  sourceFieldName: 'ORIG_AMT',
  targetFieldName: 'original_amount',
  confidence: 95,
} as const

describe('fieldNeedsTransform — user dismissal semantics (migration 075)', () => {
  it('regression-1: dismissed field with AI compat text containing "needs conversion" stays dismissed', () => {
    // Pre-fix: the defensive regex matched "needs" / "conversion" in the
    // compatibility note and returned true, silently re-flagging the field
    // on every page load. Post-fix: explicit dismissal is authoritative.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL(15,2) → DECIMAL(15,2) — needs conversion to target precision',
        hasTransformation: false,
        needsTransformation: false,
      }),
    ).toBe(false)
  })

  it('regression-2: dismissal wins over a stale hasTransformation row', () => {
    // Ordering invariant: the dismissal check fires before the
    // hasTransformation short-circuit. Protects readiness-score and outputs
    // from counting dismissed fields whose transformation row was never
    // cleared.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL → DECIMAL — direct compatible',
        hasTransformation: true,
        needsTransformation: false,
      }),
    ).toBe(false)
  })

  it('reinstated field (needsTransformation === true) is flagged', () => {
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL → DECIMAL — direct compatible',
        hasTransformation: false,
        needsTransformation: true,
      }),
    ).toBe(true)
  })

  it('unassessed NULL + high-confidence same-type direct-compatible → skip', () => {
    // Preserves the existing passthrough carve-out for newly minted TFMs
    // that have never been assessed and trivially pass through.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL(15,2) → DECIMAL(15,2) — direct compatible',
        confidence: 95,
        hasTransformation: false,
        needsTransformation: null,
      }),
    ).toBe(false)
  })

  it('unassessed NULL default → flag it (safe default)', () => {
    // When the AI didn't assess and the passthrough carve-out doesn't apply,
    // the helper must default to "needs transform" so the field surfaces
    // for review. The user can still dismiss via the toggle.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'VARCHAR(40) → DECIMAL(15,2)',
        sourceDataType: 'VARCHAR(40)',
        targetDataType: 'DECIMAL(15,2)',
        confidence: 80,
        hasTransformation: false,
        needsTransformation: null,
      }),
    ).toBe(true)
  })
})
