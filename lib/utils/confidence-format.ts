// ─────────────────────────────────────────────────────────────────────────────
// Confidence formatting + classification — Phase 4a-4b lift.
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth for confidence display in the redesign UI. Lifts
// the inline `formatConfidence` helpers that previously lived as 3 byte-
// near-identical copies in `FieldMappingRow.tsx`, `MappingDrawer.tsx`,
// and `ExpandedSourceList.tsx`, and adds the threshold classifier +
// label helper consumed exclusively by the new `ConfidencePill` for
// AI Suggest pre-fills.
//
// Tolerance contract: every formatter accepts BOTH the 0-100 integer
// storage convention (canonical) AND a 0-1 fraction (defensive — DB
// decimals can drift, and the AI Suggest wrapper rounds to integer
// 0-100 server-side but a future refactor could lift that). Values
// >1 are assumed already 0-100. This mirrors the inline tolerance in
// the three pre-lift call sites.
//
// Rendering parity: the existing call sites (FieldMappingRow's
// `ConfidenceCell`, MappingDrawer's `RowConfidenceSection`, and
// `ExpandedSourceList`'s `SourceBullet`) MUST render identically
// before and after the lift. `formatConfidencePercent` is byte-
// equivalent to the inline implementations modulo the null branch.
// `tests/utils/confidence-format.test.ts` pins parity at boundary
// inputs.
//
// Color thresholds: the band cutoffs (≥70 high, 40-69 possible,
// <40 uncertain) are NEW to 4a-4b. They are consumed only by
// `ConfidencePill` in `CreateMappingForm.tsx`. The 3 existing
// confidence display cells stay muted slate (no color band) — the
// founder explicitly chose to gate colored bands behind AI
// provenance only.
//
// Out-of-scope: outputs/CSV/SQL export confidence formatting in
// `lib/actions/_outputs-translators.ts` and
// `tests/outputs/confidence-formatting.test.ts` is a separate
// concern (export precision matters more) and is intentionally NOT
// touched by this lift.

/**
 * Lower bound (inclusive) for the "high confidence" band — green dot,
 * "Confident" label, no caveats. Tuned to match the founder's intuition
 * of "I can defer to the AI here" — empirically, suggestions ≥70%
 * round-trip to user approval without manual edits in Heritage smoke
 * tests.
 */
export const CONFIDENCE_THRESHOLD_HIGH = 70

/**
 * Lower bound (inclusive) for the "possible match" band — amber dot,
 * "Possible match" label, user should sanity-check before approving.
 * Below this cutoff the suggestion is "uncertain" and gets a red dot.
 */
export const CONFIDENCE_THRESHOLD_POSSIBLE = 40

/**
 * Three-way classification of a confidence value, used by ConfidencePill
 * to drive color band + dot color + label prefix. The bounds are
 * inclusive on the low end:
 *
 *   • confidence >= 70             → 'high'
 *   • 40 <= confidence < 70        → 'possible'
 *   • confidence < 40              → 'uncertain'
 *
 * Values out of [0, 100] (e.g. NaN, negative, 200) collapse to
 * 'uncertain' as the safe default — the only consumer is a
 * presentation pill, no business logic depends on the band.
 */
export type ConfidenceThreshold = 'high' | 'possible' | 'uncertain'

export function classifyConfidence(confidence: number): ConfidenceThreshold {
  if (!Number.isFinite(confidence)) return 'uncertain'
  // Match the percent formatter's tolerance: 0-1 fractions collapse to
  // 0-100 before threshold checks. A 0.85 input classifies as 'high'
  // (consistent with formatConfidencePercent rendering "85.00%").
  const normalized = confidence > 1 ? confidence : confidence * 100
  if (normalized >= CONFIDENCE_THRESHOLD_HIGH) return 'high'
  if (normalized >= CONFIDENCE_THRESHOLD_POSSIBLE) return 'possible'
  return 'uncertain'
}

/**
 * 2-decimal percent string, suitable for muted-slate confidence cells
 * that show the raw numeric value. Mirrors the pre-lift inline behavior:
 *
 *   • null              → '—'              (em-dash; rendered when a
 *                                            mapped source has no
 *                                            confidence on record)
 *   • 0-1 fraction       → multiply ×100, fixed(2) + '%'
 *   • 0-100 integer/float → fixed(2) + '%'
 *
 * Used by FieldMappingRow's `ConfidenceCell`, MappingDrawer's
 * `RowConfidenceSection`, and `ExpandedSourceList`'s `SourceBullet`.
 */
export function formatConfidencePercent(confidence: number | null): string {
  if (confidence === null) return '—'
  const normalized = confidence > 1 ? confidence : confidence * 100
  return `${normalized.toFixed(2)}%`
}

/**
 * Threshold-band-prefixed integer label, used exclusively by
 * `ConfidencePill` for AI Suggest pre-fill UI. Examples:
 *
 *   • formatConfidenceLabel(85)   → { label: 'Confident (85%)', threshold: 'high' }
 *   • formatConfidenceLabel(0.85) → { label: 'Confident (85%)', threshold: 'high' }
 *   • formatConfidenceLabel(55)   → { label: 'Possible match (55%)', threshold: 'possible' }
 *   • formatConfidenceLabel(25)   → { label: 'Low confidence (25%)', threshold: 'uncertain' }
 *
 * The integer is `Math.round`ed (the AI Suggest wrapper already rounds
 * server-side; this is defense-in-depth for any future float input).
 */
export function formatConfidenceLabel(confidence: number): {
  label: string
  threshold: ConfidenceThreshold
} {
  const threshold = classifyConfidence(confidence)
  // Mirror the percent formatter's normalization — the label always
  // shows the 0-100 form regardless of whether the input was 0-1.
  const normalized = confidence > 1 ? confidence : confidence * 100
  const rounded = Number.isFinite(normalized) ? Math.round(normalized) : 0
  const prefix =
    threshold === 'high'
      ? 'Confident'
      : threshold === 'possible'
        ? 'Possible match'
        : 'Low confidence'
  return { label: `${prefix} (${rounded}%)`, threshold }
}
