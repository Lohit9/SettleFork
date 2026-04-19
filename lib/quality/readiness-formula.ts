/**
 * Migration Readiness — shared formula.
 *
 * Single source of truth for the readiness score. Pure function (no DB calls,
 * no auth) so it can be imported by both server modules and by server actions.
 *
 * Weights (sum to 100):
 *   - Mapping coverage:   20
 *   - Transform coverage: 25  (full credit when no transforms are needed)
 *   - Blocking issues:    40
 *   - Warnings:            5
 *   - Staging coverage:   10
 *
 * Thresholds:
 *   >= 80 → 'ready'
 *   >= 50 → 'at_risk'
 *   <  50 → 'not_ready'
 */

export interface ReadinessInputs {
  /** Approved mappings + acknowledged fields (matches Mapping header numerator). */
  mappingApproved: number
  /** Primary mappings + unmapped source + unmapped target + acknowledged (matches denominator). */
  mappingTotal: number
  /** In-scope field mappings whose transform is `applied`. */
  transformApplied: number
  /** In-scope field mappings that need a transform at all. 0 = project needs no transforms. */
  transformScope: number
  /** Open, in-flight, blocking quality issues. */
  openBlocking: number
  /** Open, in-flight, warning quality issues. */
  openWarnings: number
  /** Denominator used to scale blocking/warning penalties (source field count). */
  totalFields: number
  /** Target tables that have at least one row in staged_data_rows. */
  stagedTables: number
  /** Target table count (denominator for staging coverage). */
  totalTables: number
}

export interface ReadinessComponents {
  mapping: number
  transform: number
  blocking: number
  warnings: number
  staging: number
}

export interface ReadinessResult {
  score: number
  status: 'ready' | 'at_risk' | 'not_ready'
  components: ReadinessComponents
}

export function calculateReadinessScore(inputs: ReadinessInputs): ReadinessResult {
  const {
    mappingApproved,
    mappingTotal,
    transformApplied,
    transformScope,
    openBlocking,
    openWarnings,
    totalFields,
    stagedTables,
    totalTables,
  } = inputs

  // 1. Mapping Coverage (20 points)
  const safeMappingTotal = Math.max(mappingTotal, 1)
  const mappingScore = Math.min((mappingApproved / safeMappingTotal) * 20, 20)

  // 2. Transform Coverage (25 points). Full credit when nothing needs transforming.
  const transformScore =
    transformScope === 0
      ? 25
      : Math.min((transformApplied / transformScope) * 25, 25)

  // 3. Blocking Issues (40 points). Each blocking issue per source field costs score.
  const safeTotalFields = Math.max(totalFields, 1)
  const blockingRatio = Math.min(openBlocking / safeTotalFields, 1)
  const blockingScore = (1 - blockingRatio) * 40

  // 4. Warnings (5 points).
  const warningRatio = Math.min(openWarnings / safeTotalFields, 1)
  const warningScore = (1 - warningRatio) * 5

  // 5. Staging Coverage (10 points).
  const safeTotalTables = Math.max(totalTables, 1)
  const stagingScore = Math.min((stagedTables / safeTotalTables) * 10, 10)

  const rawScore =
    mappingScore + transformScore + blockingScore + warningScore + stagingScore

  const score = Math.max(0, Math.min(100, Math.round(rawScore)))

  const status: ReadinessResult['status'] =
    score >= 80 ? 'ready' : score >= 50 ? 'at_risk' : 'not_ready'

  const round1 = (n: number) => Math.round(n * 10) / 10

  return {
    score,
    status,
    components: {
      mapping: round1(mappingScore),
      transform: round1(transformScore),
      blocking: round1(blockingScore),
      warnings: round1(warningScore),
      staging: round1(stagingScore),
    },
  }
}
