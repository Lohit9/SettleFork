// @vitest-environment node
//
// Phase 1 PR 10.2 — mapping field-pair F1 scorer tests.
//
// Pure-logic scorer; no mocks, no async. Each test asserts on:
//   - `score` (the headline scalar)
//   - `details.precision`, `details.recall`
//   - `details.matched`, `details.missed`, `details.extra`
//
// Several tests additionally pin the reconstructed tuple arrays
// (matchedTuples / missedTuples / extraTuples) — proves the
// roundtrip via the `${src}::${tgt}` key encoding works.

import { describe, it, expect } from 'vitest'
import {
  scoreMappingFieldPair,
  type ProposedMapping,
  type GoldMapping,
} from '@/lib/eval/scorers/mapping'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pair(s: string, t: string, combo?: ProposedMapping['combination_type']): ProposedMapping {
  return combo
    ? { source_field_id: s, target_field_id: t, combination_type: combo }
    : { source_field_id: s, target_field_id: t }
}

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe('scoreMappingFieldPair — exact match cases', () => {
  it('all-correct: 5 identical tuples → score 1.0', () => {
    const tuples: GoldMapping[] = [
      pair('a', 'x'),
      pair('b', 'y'),
      pair('c', 'z'),
      pair('d', 'w'),
      pair('e', 'v'),
    ]
    const result = scoreMappingFieldPair(tuples, tuples)
    expect(result.score).toBe(1)
    expect(result.details.precision).toBe(1)
    expect(result.details.recall).toBe(1)
    expect(result.details.matched).toBe(5)
    expect(result.details.missed).toBe(0)
    expect(result.details.extra).toBe(0)
    expect(result.details.matchedTuples).toHaveLength(5)
    expect(result.details.missedTuples).toEqual([])
    expect(result.details.extraTuples).toEqual([])
  })

  it('all-wrong: 5 disjoint tuples → score 0.0', () => {
    const proposed: ProposedMapping[] = [
      pair('a', 'x'),
      pair('b', 'y'),
      pair('c', 'z'),
      pair('d', 'w'),
      pair('e', 'v'),
    ]
    const gold: GoldMapping[] = [
      pair('A', 'X'),
      pair('B', 'Y'),
      pair('C', 'Z'),
      pair('D', 'W'),
      pair('E', 'V'),
    ]
    const result = scoreMappingFieldPair(proposed, gold)
    expect(result.score).toBe(0)
    expect(result.details.precision).toBe(0)
    expect(result.details.recall).toBe(0)
    expect(result.details.matched).toBe(0)
    expect(result.details.missed).toBe(5)
    expect(result.details.extra).toBe(5)
  })

  it('half-correct: 4 vs 4 with 2 overlap → F1 = 0.5', () => {
    const proposed: ProposedMapping[] = [
      pair('a', 'x'),
      pair('b', 'y'),
      pair('c', 'z'),
      pair('d', 'w'),
    ]
    const gold: GoldMapping[] = [
      pair('a', 'x'), // match
      pair('b', 'y'), // match
      pair('e', 'v'), // missed
      pair('f', 'u'), // missed
    ]
    const result = scoreMappingFieldPair(proposed, gold)
    // precision = 2 / (2+2) = 0.5; recall = 2 / (2+2) = 0.5; F1 = 0.5
    expect(result.score).toBe(0.5)
    expect(result.details.precision).toBe(0.5)
    expect(result.details.recall).toBe(0.5)
    expect(result.details.matched).toBe(2)
    expect(result.details.missed).toBe(2)
    expect(result.details.extra).toBe(2)

    // Reconstruction logic: matched/missed/extra contain the right tuples.
    const sortKey = (t: { source_field_id: string; target_field_id: string }) =>
      `${t.source_field_id}::${t.target_field_id}`
    expect(result.details.matchedTuples.map(sortKey).sort()).toEqual(['a::x', 'b::y'])
    expect(result.details.missedTuples.map(sortKey).sort()).toEqual(['e::v', 'f::u'])
    expect(result.details.extraTuples.map(sortKey).sort()).toEqual(['c::z', 'd::w'])
  })
})

// ─── Boundary conditions ──────────────────────────────────────────────────────

describe('scoreMappingFieldPair — empty-input cases', () => {
  it('empty proposed, non-empty gold → score 0 (recall=0)', () => {
    const result = scoreMappingFieldPair([], [
      pair('a', 'x'),
      pair('b', 'y'),
      pair('c', 'z'),
    ])
    expect(result.score).toBe(0)
    expect(result.details.precision).toBe(0)
    expect(result.details.recall).toBe(0)
    expect(result.details.matched).toBe(0)
    expect(result.details.missed).toBe(3)
    expect(result.details.extra).toBe(0)
  })

  it('non-empty proposed, empty gold → score 0 (precision=0)', () => {
    const result = scoreMappingFieldPair(
      [pair('a', 'x'), pair('b', 'y'), pair('c', 'z')],
      [],
    )
    expect(result.score).toBe(0)
    expect(result.details.precision).toBe(0)
    expect(result.details.recall).toBe(0)
    expect(result.details.matched).toBe(0)
    expect(result.details.missed).toBe(0)
    expect(result.details.extra).toBe(3)
  })

  it('both empty → score 1.0 (documented edge-case decision)', () => {
    // Per the PR 10.2 spec §3: "nothing to map and we proposed nothing"
    // is correct behavior; the AI shouldn't be punished for an empty case.
    const result = scoreMappingFieldPair([], [])
    expect(result.score).toBe(1)
    expect(result.details.precision).toBe(1)
    expect(result.details.recall).toBe(1)
    expect(result.details.f1).toBe(1)
    expect(result.details.matched).toBe(0)
    expect(result.details.missed).toBe(0)
    expect(result.details.extra).toBe(0)
    expect(result.details.matchedTuples).toEqual([])
    expect(result.details.missedTuples).toEqual([])
    expect(result.details.extraTuples).toEqual([])
  })
})

// ─── Real-world failure modes ─────────────────────────────────────────────────

describe('scoreMappingFieldPair — many-to-one + hallucination cases', () => {
  it('many-to-one: gold has 2 contributors, AI proposes 1 → F1 ≈ 0.667', () => {
    // gold: target `x` has two source contributors `a` and `b`.
    // proposed: AI only caught the `a → x` pair.
    const gold: GoldMapping[] = [pair('a', 'x'), pair('b', 'x')]
    const proposed: ProposedMapping[] = [pair('a', 'x')]
    const result = scoreMappingFieldPair(proposed, gold)
    // precision = 1/1 = 1.0; recall = 1/2 = 0.5; F1 = 2 * 1.0 * 0.5 / 1.5 = 0.6666...
    expect(result.details.precision).toBe(1)
    expect(result.details.recall).toBe(0.5)
    expect(result.score).toBeCloseTo(2 / 3, 6)
    expect(result.details.matched).toBe(1)
    expect(result.details.missed).toBe(1)
    expect(result.details.extra).toBe(0)
  })

  it('hallucinated field: AI proposes a target that does not exist in gold → score 0', () => {
    const proposed: ProposedMapping[] = [pair('a', 'z')] // z is fictional
    const gold: GoldMapping[] = [pair('a', 'x')]
    const result = scoreMappingFieldPair(proposed, gold)
    expect(result.score).toBe(0)
    expect(result.details.precision).toBe(0)
    expect(result.details.recall).toBe(0)
    expect(result.details.matched).toBe(0)
    expect(result.details.missed).toBe(1) // (a, x) was missed
    expect(result.details.extra).toBe(1) // (a, z) was extra
  })
})

// ─── Defensive cases ──────────────────────────────────────────────────────────

describe('scoreMappingFieldPair — defensive cases', () => {
  it('duplicate proposed tuples are de-duplicated (Set semantics)', () => {
    const proposed: ProposedMapping[] = [pair('a', 'x'), pair('a', 'x')]
    const gold: GoldMapping[] = [pair('a', 'x')]
    const result = scoreMappingFieldPair(proposed, gold)
    expect(result.score).toBe(1)
    expect(result.details.matched).toBe(1)
    expect(result.details.missed).toBe(0)
    expect(result.details.extra).toBe(0)
  })

  it('combination_type is ignored — same field-pair scores as a match regardless', () => {
    // proposed says "single", gold says "concat_space" — different
    // semantics, but field-pair F1 only checks (source, target).
    // Combination-type fidelity is a separate scorer (PR 11).
    const proposed: ProposedMapping[] = [pair('a', 'x', 'single')]
    const gold: GoldMapping[] = [pair('a', 'x', 'concat_space')]
    const result = scoreMappingFieldPair(proposed, gold)
    expect(result.score).toBe(1)
    expect(result.details.matched).toBe(1)
    expect(result.details.missed).toBe(0)
    expect(result.details.extra).toBe(0)
  })

  it('extraneous fields on the input objects (confidence, reasoning) are ignored', () => {
    const proposed: ProposedMapping[] = [
      {
        source_field_id: 'a',
        target_field_id: 'x',
        confidence: 87,
        reasoning: 'AI-generated reasoning text',
        contributing_source_field_ids: ['a', 'b'],
      },
    ]
    const gold: GoldMapping[] = [pair('a', 'x')]
    const result = scoreMappingFieldPair(proposed, gold)
    expect(result.score).toBe(1)
  })
})
