/**
 * PR 3.4cd commit 4 — Multi-agent vote outcome scorer.
 *
 * Used by fixtures with `metadata.expected_vote` set. The fixture
 * deliberately constructs an ambiguity (e.g., two equally-defensible
 * source candidates for a target field) and asserts that the Generator's
 * 3-vote aggregation produces the expected outcome.
 *
 * Per Phase A §G3 — pure scoring, three discrete return values:
 *   - 1.0 exact match (expected vote outcome === observed dominant outcome)
 *   - 0.5 partial-shape match (expected controversial → got majority — still
 *     captured uncertainty, just with the wrong magnitude)
 *   - 0.0 complete mismatch (expected controversial → got unanimous; the
 *     pipeline missed the ambiguity entirely)
 *
 * "Observed" comes from `MultiAgentVoteSummary` returned by the
 * orchestrator's telemetry payload. The runner picks the dominant
 * outcome (most-confident bucket with non-zero count, ties broken
 * unanimous > majority > controversial).
 */

import type { MultiAgentVoteSummary } from '@/lib/ai/multi-agent-types'

export type ExpectedVote = 'unanimous' | 'majority' | 'controversial'

export function pickDominantVoteOutcome(
  summary: MultiAgentVoteSummary,
): ExpectedVote {
  // Tie-break: most-confident wins. unanimous > majority > controversial.
  if (summary.unanimous >= summary.majority && summary.unanimous >= summary.controversial) {
    return 'unanimous'
  }
  if (summary.majority >= summary.controversial) {
    return 'majority'
  }
  return 'controversial'
}

/**
 * Score a multi-agent vote outcome against the fixture's expected
 * classification. Pure function.
 */
export function scoreMultiAgentVote(
  expected: ExpectedVote,
  observed: MultiAgentVoteSummary,
): number {
  const dominant = pickDominantVoteOutcome(observed)
  if (dominant === expected) return 1.0

  // Partial credit: any disagreement-shape match counts as 0.5.
  // Specifically: if expected was 'controversial' but observed was
  // 'majority' (or vice versa), the pipeline captured uncertainty —
  // just with the wrong magnitude. Better than total mismatch.
  const isUncertaintyShape = (v: ExpectedVote) =>
    v === 'majority' || v === 'controversial'
  if (isUncertaintyShape(expected) && isUncertaintyShape(dominant)) return 0.5

  // unanimous expected but got controversial OR vice versa = full mismatch.
  return 0.0
}
