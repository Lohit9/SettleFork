// @vitest-environment node
//
// PR 3.4cd commit 4 — orchestrator + scorer source-pin tests.
//
// The orchestrator's runtime behavior involves real LLM calls + Supabase
// telemetry, which is impractical to fully mock. These tests pin the
// STRUCTURAL invariants (function signatures, scorer return shapes,
// telemetry helper backoff schedule) that future refactors must preserve.
// Vote-aggregation runtime is tested in `multi-agent-vote-aggregator.test.ts`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import {
  scoreMultiAgentVote,
  pickDominantVoteOutcome,
} from '@/lib/eval/scorers/multi-agent-vote'
import { scoreCriticOutput } from '@/lib/eval/scorers/critic-output'
import type {
  AggregatedCritiques,
  Critique,
  MultiAgentVoteSummary,
} from '@/lib/ai/multi-agent-types'

const ORCHESTRATOR_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/multi-agent-orchestrator.ts'),
  'utf8',
)

// ─── scoreMultiAgentVote ────────────────────────────────────────────────────

describe('scoreMultiAgentVote — vote-outcome classification', () => {
  it('expected unanimous + observed unanimous → 1.0', () => {
    const observed: MultiAgentVoteSummary = { unanimous: 5, majority: 0, controversial: 0 }
    expect(scoreMultiAgentVote('unanimous', observed)).toBe(1.0)
  })

  it('expected controversial + observed controversial → 1.0', () => {
    const observed: MultiAgentVoteSummary = { unanimous: 0, majority: 0, controversial: 1 }
    expect(scoreMultiAgentVote('controversial', observed)).toBe(1.0)
  })

  it('expected controversial + observed majority → 0.5 (uncertainty-shape match)', () => {
    const observed: MultiAgentVoteSummary = { unanimous: 0, majority: 1, controversial: 0 }
    expect(scoreMultiAgentVote('controversial', observed)).toBe(0.5)
  })

  it('expected controversial + observed unanimous → 0.0 (full mismatch — pipeline missed ambiguity)', () => {
    const observed: MultiAgentVoteSummary = { unanimous: 5, majority: 0, controversial: 0 }
    expect(scoreMultiAgentVote('controversial', observed)).toBe(0.0)
  })

  it('expected unanimous + observed controversial → 0.0', () => {
    const observed: MultiAgentVoteSummary = { unanimous: 0, majority: 0, controversial: 3 }
    expect(scoreMultiAgentVote('unanimous', observed)).toBe(0.0)
  })

  it('pickDominantVoteOutcome: ties broken unanimous > majority > controversial', () => {
    expect(pickDominantVoteOutcome({ unanimous: 1, majority: 1, controversial: 1 })).toBe('unanimous')
    expect(pickDominantVoteOutcome({ unanimous: 0, majority: 1, controversial: 1 })).toBe('majority')
    expect(pickDominantVoteOutcome({ unanimous: 0, majority: 0, controversial: 1 })).toBe('controversial')
  })
})

// ─── scoreCriticOutput ──────────────────────────────────────────────────────

describe('scoreCriticOutput — expected critique category surfaces', () => {
  function makeCritique(category: Critique['category'], description = 'test'): Critique {
    return {
      category,
      description,
      suggested_fix: 'fix',
      severity: 'medium',
    }
  }

  function makeAggregated(buckets: {
    high?: Critique[]
    medium?: Critique[]
    low?: Critique[][]
  }): AggregatedCritiques {
    const high_confidence = buckets.high ?? []
    const medium_confidence = buckets.medium ?? []
    const low_confidence = buckets.low ?? []
    return {
      high_confidence,
      medium_confidence,
      low_confidence,
      summary: {
        unanimous: high_confidence.length,
        majority: medium_confidence.length,
        controversial: low_confidence.length,
      },
    }
  }

  it('returns 1.0 when expected category surfaces in high_confidence', () => {
    const observed = makeAggregated({ high: [makeCritique('aggressive_mistake')] })
    expect(scoreCriticOutput('aggressive_mistake', observed)).toBe(1.0)
  })

  it('returns 1.0 when expected category surfaces in medium_confidence', () => {
    const observed = makeAggregated({ medium: [makeCritique('missed_mapping')] })
    expect(scoreCriticOutput('missed_mapping', observed)).toBe(1.0)
  })

  it('returns 1.0 when expected category surfaces in low_confidence (singleton 1/1/1)', () => {
    const observed = makeAggregated({ low: [[makeCritique('conservative_mistake')]] })
    expect(scoreCriticOutput('conservative_mistake', observed)).toBe(1.0)
  })

  it('returns 0.0 when expected category does NOT surface in any bucket', () => {
    const observed = makeAggregated({
      high: [makeCritique('contradiction')],
      medium: [makeCritique('missed_mapping')],
    })
    expect(scoreCriticOutput('aggressive_mistake', observed)).toBe(0.0)
  })

  it('returns 0.0 when no critiques surfaced at all (Critic skipped)', () => {
    const observed = makeAggregated({})
    expect(scoreCriticOutput('aggressive_mistake', observed)).toBe(0.0)
  })
})

// ─── Source-pin: orchestrator structure invariants ──────────────────────────

describe('multi-agent orchestrator — structural invariants', () => {
  it('exports runMultiAgentMappingPipeline with locked signature', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/export async function runMultiAgentMappingPipeline\(/)
    expect(ORCHESTRATOR_SRC).toMatch(
      /\): Promise<MultiAgentResult>/,
    )
  })

  it('discriminated MultiAgentResult union', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/kind:\s*'ok';\s*result:\s*CallLLMResult;\s*telemetry:\s*MultiAgentMappingResult/)
    expect(ORCHESTRATOR_SRC).toMatch(/kind:\s*'pair_aborted';\s*reason:\s*string;\s*message:\s*string/)
  })

  it('exports vote aggregators + telemetry helper for runner consumption', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/export function aggregateCandidates\(/)
    expect(ORCHESTRATOR_SRC).toMatch(/export function aggregateCritiques\(/)
    expect(ORCHESTRATOR_SRC).toMatch(/export function jaccardSimilarity\(/)
    expect(ORCHESTRATOR_SRC).toMatch(/export async function applyVoteOutcomeMetadata\(/)
  })

  it('telemetry helper backoff schedule is locked (Phase A §C5: [100, 200, 500, 1000, 2000])', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/backoffMs\s*=\s*\[\s*100,\s*200,\s*500,\s*1000,\s*2000\s*\]/)
  })

  it('per-pair cost cap enforcement at 3 stages: after Generator, specialists, Critic', () => {
    const matches = ORCHESTRATOR_SRC.match(/Pair cost cap exceeded after \w+/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it('Generator refinement (T3) uses runAgentLoop directly with EMIT_TABLE_MAPPINGS_TOOL (existing 3.4a tool)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/runAgentLoop\(\{[\s\S]{0,2000}EMIT_TABLE_MAPPINGS_TOOL/)
  })
})
