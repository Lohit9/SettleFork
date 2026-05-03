/**
 * Path 2 PR 2 B-2 — quality-issues structural scorer.
 *
 * Scores `runAIAugmentedChecks` raw `proposed_issues` output across
 * four axes (locked weights per Phase A §3):
 *
 *   - precision:           proposed-issues that match a gold issue       (weight 0.40)
 *   - recall:              gold-issues caught by some proposed issue     (weight 0.40)
 *   - severityCorrectness: among matched, fraction with correct severity (weight 0.10)
 *   - sqlSafetyRate:       fraction of proposals whose verification_sql
 *                          passes the same safety validator the
 *                          production action runs                        (weight 0.10)
 *
 * Total possible = 1.0. Pure: no I/O, no DB, deterministic.
 *
 * Matching: case-insensitive `field_name` equality. When `cross_field`
 * is present on EITHER side of a candidate match, both must match
 * (case-insensitive). The matching is bag-style (1:1 greedy in proposal
 * order); we accept the first proposal that matches each gold and
 * never count one proposal against two golds.
 *
 * Edge cases:
 *   - No proposals + non-empty gold → precision = 1 (vacuous, no false
 *     positives), recall = 0. severityCorrectness = 0 (no matches).
 *     sqlSafetyRate = 1 (vacuous).
 *   - Proposals + empty gold → precision = 0 (every proposal extra),
 *     recall = 1 (vacuous, nothing to catch). severityCorrectness = 0.
 *   - Both empty → all axes vacuously 1; total score 1.
 *
 * The verification-SQL safety check duplicates the production
 * `isVerificationSQLSafe` rule set (lib/actions/ai-quality-detection.ts
 * isn't importable as a sync helper because the file carries
 * `'use server'`; Next.js rejects sync exports from server-action
 * modules). The two implementations must stay aligned — when the
 * production validator changes, this one must mirror.
 */

import type { ProposedIssue } from '@/lib/actions/ai-quality-detection'

// ─── Public input/output shapes ───────────────────────────────────────────────

export type ProposedQualityIssues = ProposedIssue[]

/**
 * Gold for one quality-issues example. Hand-authored.
 *
 *   - `expected_issues`: list of issues we expect the AI to surface.
 *     Each carries the field_name + (optional) cross_field tuple used
 *     for matching, plus the expected severity.
 *   - `acceptable_extra_issues`: ceiling on extra proposals before
 *     precision starts dropping faster. The scorer doesn't currently
 *     use this field — kept on the gold shape for fixture authors and
 *     for a possible future tighter scoring rule. Documented so test
 *     readers understand the intent without surprise.
 */
export type GoldQualityIssues = {
  expected_issues: Array<{
    field_name: string
    cross_field?: string
    expected_severity: 'blocking' | 'warning'
    /** Free-form keywords for fixture-author intent; not scored. */
    description_keywords?: string[]
  }>
  acceptable_extra_issues?: number
}

const W_PRECISION = 0.4
const W_RECALL = 0.4
const W_SEVERITY = 0.1
const W_SQL_SAFETY = 0.1

export type QualityIssuesScoreDetails = {
  precision: number
  recall: number
  severityCorrectness: number
  sqlSafetyRate: number
  matched: number
  proposedCount: number
  goldCount: number
  axisScores: {
    precision: number
    recall: number
    severityCorrectness: number
    sqlSafetyRate: number
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

/**
 * Mirror of `isVerificationSQLSafe` in lib/actions/ai-quality-detection.ts.
 * Re-implemented locally because that module's `'use server'` directive
 * forbids sync helper exports. Keep the two in sync.
 */
function isVerificationSQLSafeForScoring(sql: string, tableId: string): boolean {
  if (typeof sql !== 'string' || sql.length === 0) return false
  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
  if (!normalized.startsWith('SELECT')) return false

  const lower = sql.toLowerCase()
  if (/\b(update|delete|insert|drop|alter|create|truncate|grant|revoke)\b/.test(lower)) return false
  if (/(pg_catalog|information_schema|auth\.|storage\.)/.test(lower)) return false
  if (!/data_rows/.test(lower)) return false
  if (!sql.includes(tableId)) return false
  return true
}

// ─── Public scorer ────────────────────────────────────────────────────────────

/**
 * Score one AI quality-issues output against a gold.
 *
 * @param proposed - raw `proposed_issues` from runAIAugmentedChecks
 * @param gold - hand-authored expected issues
 * @param tableId - the synthetic source table UUID; used for SQL safety check
 */
export function scoreQualityIssueDetection(
  proposed: ProposedQualityIssues,
  gold: GoldQualityIssues,
  tableId: string,
): { score: number; details: QualityIssuesScoreDetails } {
  const proposedSafe = Array.isArray(proposed) ? proposed : []
  const goldExpected = gold.expected_issues ?? []

  // 1:1 greedy matching in proposal order — once a proposal is matched
  // to a gold, neither can match another.
  const matchedProposalIdx = new Set<number>()
  const matchedGoldIdx = new Set<number>()
  let severityMatches = 0

  for (let pi = 0; pi < proposedSafe.length; pi++) {
    const p = proposedSafe[pi]!
    const pField = norm(p.field_name)
    const pCross = norm(p.cross_field)
    for (let gi = 0; gi < goldExpected.length; gi++) {
      if (matchedGoldIdx.has(gi)) continue
      const g = goldExpected[gi]!
      const gField = norm(g.field_name)
      const gCross = norm(g.cross_field)
      const fieldOk = pField === gField
      // cross_field must match if either side has it
      const crossOk = (pCross === '' && gCross === '') || pCross === gCross
      if (fieldOk && crossOk) {
        matchedProposalIdx.add(pi)
        matchedGoldIdx.add(gi)
        if (p.severity === g.expected_severity) severityMatches++
        break
      }
    }
  }

  const matched = matchedGoldIdx.size
  const proposedCount = proposedSafe.length
  const goldCount = goldExpected.length

  // precision: matched / proposedCount; vacuous 1 when no proposals
  const precision = proposedCount === 0 ? 1 : matched / proposedCount
  // recall: matched / goldCount; vacuous 1 when no gold
  const recall = goldCount === 0 ? 1 : matched / goldCount
  // severityCorrectness: severity matches / matched. When matched=0,
  // vacuously 1 only if BOTH sides are empty (nothing to score); else 0
  // (we have proposals or gold but no overlap, so severity correctness
  // is genuinely 0).
  const severityCorrectness =
    matched === 0
      ? proposedCount === 0 && goldCount === 0
        ? 1
        : 0
      : severityMatches / matched
  // sqlSafetyRate: fraction of proposals with safe verification_sql;
  // vacuous 1 when no proposals
  let safeCount = 0
  for (const p of proposedSafe) {
    if (isVerificationSQLSafeForScoring(p.verification_sql ?? '', tableId)) safeCount++
  }
  const sqlSafetyRate = proposedCount === 0 ? 1 : safeCount / proposedCount

  const axisScores = {
    precision: precision * W_PRECISION,
    recall: recall * W_RECALL,
    severityCorrectness: severityCorrectness * W_SEVERITY,
    sqlSafetyRate: sqlSafetyRate * W_SQL_SAFETY,
  }
  const score =
    axisScores.precision +
    axisScores.recall +
    axisScores.severityCorrectness +
    axisScores.sqlSafetyRate

  return {
    score,
    details: {
      precision,
      recall,
      severityCorrectness,
      sqlSafetyRate,
      matched,
      proposedCount,
      goldCount,
      axisScores,
    },
  }
}
