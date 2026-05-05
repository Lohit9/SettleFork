// @vitest-environment node
//
// PR 3.4cd commit 3 — vote aggregation algorithms.
//
// Pure-helper tests for `aggregateCandidates`, `aggregateCritiques`,
// and `jaccardSimilarity`. No mocks, no DB, no LLM calls. The
// SELECT-poll-then-UPDATE telemetry helper (`applyVoteOutcomeMetadata`)
// has integration-shape behavior (Supabase polling) and is covered by
// source-pin tests in `tests/lib/multi-agent-orchestrator.test.ts`
// (commit 4).

import { describe, it, expect } from 'vitest'

import {
  aggregateCandidates,
  aggregateCritiques,
  jaccardSimilarity,
  CONFIDENCE_UNANIMOUS,
  CONFIDENCE_MAJORITY,
  CONFIDENCE_CONTROVERSIAL,
} from '@/lib/ai/multi-agent-orchestrator'
import type {
  CandidateMapping,
  Critique,
} from '@/lib/ai/multi-agent-types'

// ─── Fixtures ───────────────────────────────────────────────────────────────

function candidate(
  source: string,
  target: string,
  tag: CandidateMapping['tag'] = 'one_to_one',
  overrides: Partial<CandidateMapping> = {},
): CandidateMapping {
  return {
    source_field: source,
    target_field: target,
    tag,
    confidence: 75,
    reasoning: 'unit-test fixture',
    type_compatibility: 'direct',
    needs_transformation: false,
    ...overrides,
  }
}

function critique(
  category: Critique['category'],
  description: string,
  overrides: Partial<Critique> = {},
): Critique {
  return {
    category,
    description,
    suggested_fix: 'fix-it',
    severity: 'medium',
    ...overrides,
  }
}

// ─── jaccardSimilarity ──────────────────────────────────────────────────────

describe('jaccardSimilarity — token-set similarity', () => {
  it('identical strings → 1.0', () => {
    expect(jaccardSimilarity('hello world foo', 'hello world foo')).toBe(1)
  })

  it('disjoint token sets → 0.0', () => {
    expect(jaccardSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0)
  })

  it('half-overlap → 0.5 within rounding (token-set semantics)', () => {
    // a: {hello, world, foo}; b: {hello, foo, bar} → ∩=2, ∪=4, J=0.5
    expect(jaccardSimilarity('hello world foo', 'hello foo bar')).toBeCloseTo(0.5, 1)
  })

  it('case-insensitive + ignores stop-words', () => {
    expect(jaccardSimilarity('THE quick fox', 'a Quick FOX')).toBeCloseTo(1, 1)
  })

  it('empty strings → 1.0 (vacuously equal); one empty → 0.0', () => {
    expect(jaccardSimilarity('', '')).toBe(1)
    expect(jaccardSimilarity('', 'something')).toBe(0)
    expect(jaccardSimilarity('something', '')).toBe(0)
  })
})

// ─── aggregateCandidates ────────────────────────────────────────────────────

describe('aggregateCandidates — Generator vote aggregation', () => {
  it('3/3 unanimous → unanimous bucket with confidence 95', () => {
    const c = candidate('id', 'id', 'one_to_one')
    const result = aggregateCandidates([[c], [c], [c]])
    expect(result.unanimous).toHaveLength(1)
    expect(result.unanimous[0]!.confidence).toBe(CONFIDENCE_UNANIMOUS)
    expect(result.majority).toHaveLength(0)
    expect(result.controversial).toHaveLength(0)
    expect(result.summary).toEqual({ unanimous: 1, majority: 0, controversial: 0 })
  })

  it('2/3 majority → majority bucket with confidence 67 + minority_tag captured', () => {
    const a = candidate('name', 'label', 'one_to_one')
    const b = candidate('name', 'label', 'one_to_one')
    // Third vote has SAME source/target but DIFFERENT tag — minority.
    const c = candidate('name', 'label', 'uncertain')
    const result = aggregateCandidates([[a], [b], [c]])
    expect(result.majority).toHaveLength(1)
    expect(result.majority[0]!.confidence).toBe(CONFIDENCE_MAJORITY)
    expect(result.majority[0]!.tag).toBe('one_to_one')
    expect(result.majority[0]!.minority_tag).toBe('uncertain')
    expect(result.unanimous).toHaveLength(0)
    expect(result.controversial).toHaveLength(0)
  })

  it('1/1/1 controversial: same field-pair, three distinct tags', () => {
    const a = candidate('email', 'Email', 'one_to_one')
    const b = candidate('email', 'Email', 'cross_table')
    const c = candidate('email', 'Email', 'uncertain')
    const result = aggregateCandidates([[a], [b], [c]])
    expect(result.unanimous).toHaveLength(0)
    expect(result.majority).toHaveLength(0)
    expect(result.controversial).toHaveLength(1)
    expect(result.controversial[0]).toHaveLength(3)
    for (const c0 of result.controversial[0]!) {
      expect(c0.confidence).toBe(CONFIDENCE_CONTROVERSIAL)
    }
  })

  it('mixed outcomes across multiple candidates partition correctly', () => {
    // pair P1 (id→id, one_to_one): unanimous
    const p1a = candidate('id', 'id')
    // pair P2 (name→label, one_to_one): 2/3 majority + 1 dissenter (one_to_many)
    const p2a = candidate('name', 'label', 'one_to_one')
    const p2b = candidate('name', 'label', 'one_to_many')
    // pair P3 (status→Status): 1/1/1 across three tags
    const p3a = candidate('status', 'Status', 'one_to_one')
    const p3b = candidate('status', 'Status', 'cross_table')
    const p3c = candidate('status', 'Status', 'uncertain')
    const result = aggregateCandidates([
      [p1a, p2a, p3a],
      [p1a, p2a, p3b],
      [p1a, p2b, p3c],
    ])
    expect(result.summary.unanimous).toBe(1) // p1
    expect(result.summary.majority).toBe(1) // p2
    expect(result.summary.controversial).toBe(1) // p3
  })

  it('partial overlap — only some voters propose a candidate (not 1/1/1)', () => {
    // pair X: 2 voters propose, 1 omits entirely. NOT 1/1/1 (it's 2/2, but
    // since totalVotes=3 the third vote's absence means agreement is 2/3.
    const x = candidate('only_in_two', 'TARGET_X')
    const result = aggregateCandidates([[x], [x], []])
    expect(result.summary.majority).toBe(1)
    expect(result.summary.unanimous).toBe(0)
    expect(result.summary.controversial).toBe(0)
  })

  it('within-vote duplicate joint keys deduped (defensive — agent should not emit duplicates)', () => {
    const c = candidate('id', 'id')
    const result = aggregateCandidates([[c, c], [c], [c]])
    expect(result.unanimous).toHaveLength(1) // not 2
  })

  it('empty inputs → empty output', () => {
    const result = aggregateCandidates([[], [], []])
    expect(result.unanimous).toHaveLength(0)
    expect(result.majority).toHaveLength(0)
    expect(result.controversial).toHaveLength(0)
  })
})

// ─── aggregateCritiques ─────────────────────────────────────────────────────

describe('aggregateCritiques — Critic vote aggregation with Jaccard matching', () => {
  it('3/3 agreement on a critique → high_confidence', () => {
    const c1 = critique('aggressive_mistake', 'CHECK constraint violation on Status field', { affected_mapping_index: 0 })
    const c2 = critique('aggressive_mistake', 'CHECK constraint violation on Status', { affected_mapping_index: 0 })
    const c3 = critique('aggressive_mistake', 'CHECK violation: Status constraint', { affected_mapping_index: 0 })
    const result = aggregateCritiques([[c1], [c2], [c3]])
    expect(result.high_confidence).toHaveLength(1)
    expect(result.medium_confidence).toHaveLength(0)
    expect(result.low_confidence).toHaveLength(0)
    expect(result.summary).toEqual({ unanimous: 1, majority: 0, controversial: 0 })
  })

  it('2/3 agreement → medium_confidence (Phase A §C3)', () => {
    // Both c1 and c2 share substantial tokens to clear Jaccard ≥ 0.5.
    const c1 = critique('missed_mapping', 'target field has no source proposed but customer table contains matching column', { affected_target_field: 'RegionName' })
    const c2 = critique('missed_mapping', 'target field has no source proposed but customer table contains direct match column', { affected_target_field: 'RegionName' })
    // c3 votes for a totally different critique
    const c3 = critique('contradiction', 'Two mappings conflict on customer_id', { affected_mapping_index: 5 })
    const result = aggregateCritiques([[c1], [c2], [c3]])
    expect(result.medium_confidence).toHaveLength(1)
    expect(result.high_confidence).toHaveLength(0)
    // The c3 singleton goes to low_confidence
    expect(result.low_confidence).toHaveLength(1)
    expect(result.summary).toEqual({ unanimous: 0, majority: 1, controversial: 1 })
  })

  it('1/1/1 distinct critiques → all surface as low_confidence singletons', () => {
    const c1 = critique('contradiction', 'A versus B', { affected_mapping_index: 0 })
    const c2 = critique('missed_mapping', 'foo unmapped', { affected_target_field: 'foo' })
    const c3 = critique('aggressive_mistake', 'bar overflow', { affected_mapping_index: 3 })
    const result = aggregateCritiques([[c1], [c2], [c3]])
    expect(result.high_confidence).toHaveLength(0)
    expect(result.medium_confidence).toHaveLength(0)
    expect(result.low_confidence).toHaveLength(3)
  })

  it('Jaccard < 0.5 on same coarse key → critiques NOT merged', () => {
    // Same category + same affected_mapping_index but utterly unrelated descriptions.
    const c1 = critique('aggressive_mistake', 'alpha beta gamma delta epsilon foo', { affected_mapping_index: 0 })
    const c2 = critique('aggressive_mistake', 'kappa lambda mu nu xi omicron pi', { affected_mapping_index: 0 })
    const c3 = critique('aggressive_mistake', 'rho sigma tau upsilon phi chi psi', { affected_mapping_index: 0 })
    const result = aggregateCritiques([[c1], [c2], [c3]])
    // Each critique is its own singleton — no merge.
    expect(result.low_confidence).toHaveLength(3)
    expect(result.high_confidence).toHaveLength(0)
  })

  it('different coarse keys (different affected fields) → never merged even with similar descriptions', () => {
    const c1 = critique('missed_mapping', 'field has no source proposed', { affected_target_field: 'AAA' })
    const c2 = critique('missed_mapping', 'field has no source proposed', { affected_target_field: 'BBB' })
    const c3 = critique('missed_mapping', 'field has no source proposed', { affected_target_field: 'CCC' })
    const result = aggregateCritiques([[c1], [c2], [c3]])
    // Even though descriptions are 100% Jaccard similar, the affected_target_field
    // differs — they're 3 separate concerns, all low-confidence singletons.
    expect(result.low_confidence).toHaveLength(3)
  })

  it('empty input → empty output, all summary counts 0', () => {
    const result = aggregateCritiques([[], [], []])
    expect(result.high_confidence).toHaveLength(0)
    expect(result.medium_confidence).toHaveLength(0)
    expect(result.low_confidence).toHaveLength(0)
    expect(result.summary).toEqual({ unanimous: 0, majority: 0, controversial: 0 })
  })

  it('within-vote duplicate critiques on the same coarse key are deduped (first wins)', () => {
    // Three critiques with substantial token overlap (Jaccard ≥ 0.5).
    const c1 = critique('aggressive_mistake', 'CHECK constraint violation source values exceed allowed picklist on Status field', { affected_mapping_index: 0 })
    const c1dup = critique('aggressive_mistake', 'unrelated duplicate', { affected_mapping_index: 0 })
    const c2 = critique('aggressive_mistake', 'CHECK constraint violation source values exceed allowed list on Status field', { affected_mapping_index: 0 })
    const c3 = critique('aggressive_mistake', 'CHECK constraint violation source values exceed allowed picklist on Status', { affected_mapping_index: 0 })
    const result = aggregateCritiques([[c1, c1dup], [c2], [c3]])
    // c1dup is deduped within vote 1 (same coarse key); c1 + c2 + c3 with high
    // Jaccard similarity → 3/3 high_confidence.
    expect(result.high_confidence).toHaveLength(1)
  })
})
