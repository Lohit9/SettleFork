/**
 * Path 2 PR 1 — mapping-suggestion structural scorer.
 *
 * Scores `runMappingSuggestion`'s per-target-field output across three
 * axes:
 *
 *   - sourceFieldsMatch:    proposed source_field_names matches gold
 *                           (set equality on the resolved set, OR matches
 *                           one of the acceptable_alternatives entries)   (weight 0.60)
 *   - combinationTypeMatch: combination_type matches gold                  (weight 0.30)
 *   - rationalePresent:     rationale is a string with length ≥ 20         (weight 0.10)
 *
 * Total possible = 1.0. Pure: no I/O, deterministic.
 *
 * Confidence is intentionally NOT scored — it's a calibration signal,
 * not a correctness signal. Picking the wrong source field with high
 * confidence is more wrong, not less, but the scorer captures that
 * via sourceFieldsMatch=0; punishing high confidence directly would
 * conflate two orthogonal axes.
 *
 * Equal-weighting choice locked at the values above per Phase A §2.5.
 * Tunable weights are a future enhancement when measurement signal
 * justifies rebalancing.
 */

// ─── Public input/output shapes ───────────────────────────────────────────────

/**
 * Mirrors the `suggestion` field returned by `runMappingSuggestion` on
 * success (lib/ai/mapping-engine.ts), translated to use field NAMES
 * (not UUIDs) so the scorer compares like-for-like with hand-authored
 * gold labels.
 */
export type ProposedMappingSuggestion = {
  source_field_names: string[]
  combination_type: 'single' | 'concat_space' | 'concat_comma'
  confidence: number
  rationale: string
}

/**
 * Hand-authored gold for mapping-suggestion examples. Names match
 * fixture.input.source_table fields verbatim (case-sensitive).
 *
 * `acceptable_alternatives` lets the gold author capture the case where
 * MULTIPLE source-field combinations are equally valid (e.g., the
 * synthetic source has both `first_name` and `fname` columns and either
 * is a correct answer). Order WITHIN an alternative matters for concat
 * combination types — see `compareSourceFieldNames` below.
 */
export type GoldMappingSuggestion = {
  expected_source_field_names: string[]
  acceptable_alternatives?: string[][]
  expected_combination_type: 'single' | 'concat_space' | 'concat_comma'
}

/** Axis-weight constants — kept here so the scorer + tests stay aligned. */
const W_SOURCE_FIELDS = 0.6
const W_COMBINATION_TYPE = 0.3
const W_RATIONALE_PRESENT = 0.1

const RATIONALE_MIN_CHARS = 20

export type MappingSuggestionScoreDetails = {
  sourceFieldsMatch: boolean
  combinationTypeMatch: boolean
  rationalePresent: boolean
  axisScores: {
    sourceFieldsMatch: number
    combinationTypeMatch: number
    rationalePresent: number
  }
  proposedSourceFieldNames: string[]
  goldExpectedSourceFieldNames: string[]
  /**
   * Which alternative (if any) the proposal matched. Useful in test
   * output when a multi-alternative gold is in play.
   *
   * `null` when the proposal didn't match any alternative.
   * `'expected'` when it matched the primary `expected_source_field_names`.
   * `'alt:<index>'` when it matched `acceptable_alternatives[index]`.
   */
  matchedAlternative: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compare two source-field-name lists for equivalence. For
 * `combination_type === 'single'` (1-element list), strict equality.
 * For concat types, the position of names matters because the AI
 * orders the contributors (e.g., first_name + last_name, NOT last_name
 * + first_name). The scorer respects that order.
 */
function compareSourceFieldNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isStructurallyValid(
  p: ProposedMappingSuggestion | null,
): p is ProposedMappingSuggestion {
  if (p === null || p === undefined) return false
  if (typeof p !== 'object') return false
  if (!Array.isArray(p.source_field_names)) return false
  if (
    p.combination_type !== 'single' &&
    p.combination_type !== 'concat_space' &&
    p.combination_type !== 'concat_comma'
  ) {
    return false
  }
  if (typeof p.confidence !== 'number') return false
  if (typeof p.rationale !== 'string') return false
  return true
}

// ─── Public scorer ────────────────────────────────────────────────────────────

/**
 * Score one AI mapping-suggestion against a gold suggestion.
 *
 * Edge cases:
 *   - Null/malformed proposed → all axes false, score 0
 *   - Proposed source list matches one of `acceptable_alternatives`
 *     instead of `expected_source_field_names` → sourceFieldsMatch=true,
 *     `matchedAlternative` set to `alt:<index>`
 *   - rationale shorter than RATIONALE_MIN_CHARS → rationalePresent=false
 */
export function scoreMappingSuggestion(
  proposed: ProposedMappingSuggestion | null,
  gold: GoldMappingSuggestion,
): { score: number; details: MappingSuggestionScoreDetails } {
  const goldExpectedSourceFieldNames = [...gold.expected_source_field_names]
  if (!isStructurallyValid(proposed)) {
    return {
      score: 0,
      details: {
        sourceFieldsMatch: false,
        combinationTypeMatch: false,
        rationalePresent: false,
        axisScores: {
          sourceFieldsMatch: 0,
          combinationTypeMatch: 0,
          rationalePresent: 0,
        },
        proposedSourceFieldNames: [],
        goldExpectedSourceFieldNames,
        matchedAlternative: null,
      },
    }
  }

  // Axis 1: sourceFieldsMatch — best-of-N against gold + alternatives.
  let matchedAlternative: string | null = null
  if (
    compareSourceFieldNames(
      proposed.source_field_names,
      gold.expected_source_field_names,
    )
  ) {
    matchedAlternative = 'expected'
  } else if (gold.acceptable_alternatives) {
    for (const [i, alt] of gold.acceptable_alternatives.entries()) {
      if (compareSourceFieldNames(proposed.source_field_names, alt)) {
        matchedAlternative = `alt:${i}`
        break
      }
    }
  }
  const sourceFieldsMatch = matchedAlternative !== null

  // Axis 2: combination_type strict equality.
  const combinationTypeMatch =
    proposed.combination_type === gold.expected_combination_type

  // Axis 3: rationale present and non-trivial.
  const rationalePresent = proposed.rationale.length >= RATIONALE_MIN_CHARS

  const axisScores = {
    sourceFieldsMatch: sourceFieldsMatch ? W_SOURCE_FIELDS : 0,
    combinationTypeMatch: combinationTypeMatch ? W_COMBINATION_TYPE : 0,
    rationalePresent: rationalePresent ? W_RATIONALE_PRESENT : 0,
  }
  const score =
    axisScores.sourceFieldsMatch +
    axisScores.combinationTypeMatch +
    axisScores.rationalePresent

  return {
    score,
    details: {
      sourceFieldsMatch,
      combinationTypeMatch,
      rationalePresent,
      axisScores,
      proposedSourceFieldNames: [...proposed.source_field_names],
      goldExpectedSourceFieldNames,
      matchedAlternative,
    },
  }
}
