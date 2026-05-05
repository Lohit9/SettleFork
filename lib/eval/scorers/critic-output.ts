/**
 * PR 3.4cd commit 4 — Critic output category scorer.
 *
 * Used by fixtures with `metadata.expected_critique_category` set
 * (e.g., `mapping/006-critic-catches-aggressive-mistake.json`). The
 * fixture constructs a mapping that should trigger a specific critique
 * category (contradiction / missed_mapping / conservative_mistake /
 * aggressive_mistake), and the scorer asserts the Critic surfaced it.
 *
 * Per Phase A §G3:
 *   - 1.0 if any critique in the aggregated set matches the expected
 *     category (high_confidence + medium_confidence + low_confidence
 *     all count — even a low-confidence flag passes)
 *   - 0.0 otherwise
 */

import type { Critique, AggregatedCritiques } from '@/lib/ai/multi-agent-types'

export type ExpectedCritiqueCategory = Critique['category']

export function scoreCriticOutput(
  expected: ExpectedCritiqueCategory,
  observed: AggregatedCritiques,
): number {
  // Flatten the 3 buckets. low_confidence is Array<Critique[]> — flatten one level.
  const all: Critique[] = [
    ...observed.high_confidence,
    ...observed.medium_confidence,
    ...observed.low_confidence.flat(),
  ]
  return all.some((c) => c.category === expected) ? 1.0 : 0.0
}
