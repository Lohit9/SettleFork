/**
 * Path 2 PR 2 B-2 — fix-options structural scorer.
 *
 * Scores `generateFixSuggestions` raw `rawFixOptions` output across
 * five axes (locked weights per Phase A §3):
 *
 *   - sqlValidityRate:     fraction of options whose SQL passes the
 *                          production validateFixSQL safety check    (weight 0.40)
 *   - optionCountInRange:  proposed.length is within
 *                          [min_option_count, max_option_count]      (weight 0.20)
 *   - hasLowRiskOption:    when gold requires it, ≥1 option has
 *                          risk_level === 'low'                      (weight 0.20)
 *   - riskLevelDiversity:  unique risk_level values >= 2             (weight 0.10)
 *   - descriptionNonEmpty: fraction of options with description
 *                          length >= 20                              (weight 0.10)
 *
 * Total possible = 1.0. Pure: no I/O (validateFixSQL is sync), deterministic.
 *
 * Edge cases:
 *   - Empty proposals: optionCountInRange = 0 (unless gold accepts 0),
 *     hasLowRiskOption = 0, riskLevelDiversity = 0, descriptionNonEmpty = 0,
 *     sqlValidityRate vacuously 1 (no SQL to fail). Total ≈ 0.40.
 *   - When gold.requires_low_risk_option = false, hasLowRiskOption is
 *     vacuously 1 (axis converts to "no constraint, no penalty").
 */

import { validateFixSQL } from '@/lib/quality/fix-sql-validator'
import type { FixOption } from '@/lib/types/database'

// ─── Public input/output shapes ───────────────────────────────────────────────

export type ProposedFixOptions = FixOption[]

export type GoldFixOptions = {
  min_option_count: number
  max_option_count: number
  requires_low_risk_option: boolean
}

const W_SQL_VALIDITY = 0.4
const W_COUNT_IN_RANGE = 0.2
const W_HAS_LOW_RISK = 0.2
const W_DIVERSITY = 0.1
const W_DESCRIPTION = 0.1

const DESCRIPTION_MIN_CHARS = 20

export type FixOptionsScoreDetails = {
  sqlValidityRate: number
  optionCountInRange: boolean
  hasLowRiskOption: boolean
  riskLevelDiversity: boolean
  descriptionNonEmpty: number
  proposedCount: number
  uniqueRiskLevelCount: number
  sqlValidCount: number
  axisScores: {
    sqlValidityRate: number
    optionCountInRange: number
    hasLowRiskOption: number
    riskLevelDiversity: number
    descriptionNonEmpty: number
  }
}

// ─── Public scorer ────────────────────────────────────────────────────────────

export function scoreFixOptions(
  proposed: ProposedFixOptions,
  gold: GoldFixOptions,
  tableId: string,
): { score: number; details: FixOptionsScoreDetails } {
  const proposedSafe = Array.isArray(proposed) ? proposed : []
  const proposedCount = proposedSafe.length

  // Axis 1: sqlValidityRate — vacuous 1 when no proposals
  let sqlValidCount = 0
  for (const opt of proposedSafe) {
    const sql = typeof opt?.sql === 'string' ? opt.sql : ''
    const result = validateFixSQL(sql, tableId)
    if (result.safe) sqlValidCount++
  }
  const sqlValidityRate = proposedCount === 0 ? 1 : sqlValidCount / proposedCount

  // Axis 2: optionCountInRange
  const optionCountInRange =
    proposedCount >= gold.min_option_count && proposedCount <= gold.max_option_count

  // Axis 3: hasLowRiskOption — vacuous 1 if gold doesn't require it
  let hasLowRiskOption = false
  if (gold.requires_low_risk_option) {
    hasLowRiskOption = proposedSafe.some((opt) => opt?.risk_level === 'low')
  } else {
    hasLowRiskOption = true
  }

  // Axis 4: riskLevelDiversity — at least 2 unique risk_level values
  const riskLevels = new Set<string>()
  for (const opt of proposedSafe) {
    if (typeof opt?.risk_level === 'string') riskLevels.add(opt.risk_level)
  }
  const riskLevelDiversity = riskLevels.size >= 2

  // Axis 5: descriptionNonEmpty — fraction with description length >= 20
  let descriptionOkCount = 0
  for (const opt of proposedSafe) {
    if (typeof opt?.description === 'string' && opt.description.length >= DESCRIPTION_MIN_CHARS) {
      descriptionOkCount++
    }
  }
  const descriptionNonEmpty = proposedCount === 0 ? 0 : descriptionOkCount / proposedCount

  const axisScores = {
    sqlValidityRate: sqlValidityRate * W_SQL_VALIDITY,
    optionCountInRange: optionCountInRange ? W_COUNT_IN_RANGE : 0,
    hasLowRiskOption: hasLowRiskOption ? W_HAS_LOW_RISK : 0,
    riskLevelDiversity: riskLevelDiversity ? W_DIVERSITY : 0,
    descriptionNonEmpty: descriptionNonEmpty * W_DESCRIPTION,
  }
  const score =
    axisScores.sqlValidityRate +
    axisScores.optionCountInRange +
    axisScores.hasLowRiskOption +
    axisScores.riskLevelDiversity +
    axisScores.descriptionNonEmpty

  return {
    score,
    details: {
      sqlValidityRate,
      optionCountInRange,
      hasLowRiskOption,
      riskLevelDiversity,
      descriptionNonEmpty,
      proposedCount,
      uniqueRiskLevelCount: riskLevels.size,
      sqlValidCount,
      axisScores,
    },
  }
}
