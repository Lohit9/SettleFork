// @vitest-environment node
//
// PR 3.4cd commit 4 — source-level pins for the two-level gate
// (`AI_PHASE_3_ENABLED` outer + `AI_PHASE_3_MULTI_AGENT_ENABLED` inner)
// at both production callsites. The actual runtime behavior of the
// pipeline is covered by:
//   - `tests/lib/multi-agent-vote-aggregator.test.ts` (commit 3)
//   - the BULK + single-pair gate tests in `mapping-engine-agent-gate`
//     and `mappings-agent-gate` (commit 2)
//
// This file pins the multi-agent-specific gate dispatch — that
// `runMultiAgentMappingPipeline` is called at both callsites under
// the right flag combination, and that the dispatch passes the
// right `cacheControl` posture per Phase A LOCK #4.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const ENGINE_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/mapping-engine.ts'),
  'utf8',
)
const MAPPINGS_SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/mappings.ts'),
  'utf8',
)
const ORCHESTRATOR_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/multi-agent-orchestrator.ts'),
  'utf8',
)

describe('multi-agent gate — BULK callsite (S1.1: single-agent only)', () => {
  // S1.1 removed runMultiAgentMappingPipeline and AI_PHASE_3_MULTI_AGENT_ENABLED
  // from lib/ai/mapping-engine.ts (the BULK callsite). The single-pair callsite
  // in lib/actions/mappings.ts still carries the multi-agent gate.
  // These pins lock the post-S1.1 shape: BULK always uses single-agent.

  it('mapping-engine no longer declares multiAgentEnabled or runMultiAgentMappingPipeline (S1.1 removal)', () => {
    expect(ENGINE_SRC).not.toMatch(/const multiAgentEnabled = process\.env\.AI_PHASE_3_MULTI_AGENT_ENABLED === '1'/)
    expect(ENGINE_SRC).not.toMatch(/runMultiAgentMappingPipeline\(/)
  })

  it('mapping-engine still declares phase3Enabled + uses runSingleAgentMappingLoop (BULK now always single-agent)', () => {
    expect(ENGINE_SRC).toMatch(/const phase3Enabled = process\.env\.AI_PHASE_3_ENABLED === '1'/)
    expect(ENGINE_SRC).toMatch(/runSingleAgentMappingLoop\(/)
  })

  it('mapping-engine no longer carries multi_agent: true metadata (removed with multi-agent gate)', () => {
    expect(ENGINE_SRC).not.toMatch(/multi_agent:\s*true/)
  })
})

describe('multi-agent gate — two-level dispatch (single-pair callsite)', () => {
  it('mappings.ts declares both flags + dispatches to multi-agent OR single-agent helper', () => {
    expect(MAPPINGS_SRC).toMatch(/const phase3Enabled = process\.env\.AI_PHASE_3_ENABLED === '1'/)
    expect(MAPPINGS_SRC).toMatch(/const multiAgentEnabled = process\.env\.AI_PHASE_3_MULTI_AGENT_ENABLED === '1'/)
    expect(MAPPINGS_SRC).toMatch(/runMultiAgentMappingPipeline\(/)
    expect(MAPPINGS_SRC).toMatch(/runSingleAgentMappingLoop\(/)
  })

  it('single-pair callsite passes cacheControl: false to multi-agent pipeline (LOCK #4)', () => {
    // Phase A LOCK #4: bulk = cacheControl true; single-pair = false.
    expect(MAPPINGS_SRC).toMatch(/runMultiAgentMappingPipeline\(\{[\s\S]{0,400}cacheControl:\s*false/)
  })

  it('multi_agent: true marker threaded into baseMetadata at single-pair callsite', () => {
    expect(MAPPINGS_SRC).toMatch(/multi_agent:\s*true/)
  })

  it('pair_aborted result returns single-pair-shape error (NOT continue)', () => {
    expect(MAPPINGS_SRC).toMatch(/r\.kind\s*===\s*'pair_aborted'/)
    expect(MAPPINGS_SRC).toMatch(/Multi-agent pair aborted:[\s\S]{0,200}return\s*\{\s*inserted:\s*0/)
  })
})

describe('multi-agent orchestrator — locked configuration constants', () => {
  it('VOTE_COUNT = 3 (Phase A §C1)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/const VOTE_COUNT = 3/)
  })

  it('VOTE_TEMPERATURE = 0.6 (Phase A D-3 / OQ1)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/const VOTE_TEMPERATURE = 0\.6/)
  })

  it('PER_AGENT_MAX_ITERATIONS = 6 (Phase A R4 / OQ2)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/const PER_AGENT_MAX_ITERATIONS = 6/)
  })

  it('PER_AGENT_MAX_COST_USD = 1.5 (Phase A R4 / OQ2)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/const PER_AGENT_MAX_COST_USD = 1\.5/)
  })

  it('PER_PAIR_MAX_COST_USD = 15 (Phase A R4 aggregate cap)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/const PER_PAIR_MAX_COST_USD = 15\.0/)
  })

  it('CONFIDENCE constants 95 / 67 / 50 (Phase A §C4)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/CONFIDENCE_UNANIMOUS\s*=\s*95/)
    expect(ORCHESTRATOR_SRC).toMatch(/CONFIDENCE_MAJORITY\s*=\s*67/)
    expect(ORCHESTRATOR_SRC).toMatch(/CONFIDENCE_CONTROVERSIAL\s*=\s*50/)
  })
})

describe('multi-agent orchestrator — pipeline structure', () => {
  it('T0 runs 3× Generator in parallel via Promise.all', () => {
    expect(ORCHESTRATOR_SRC).toMatch(
      /Promise\.all\([\s\S]{0,300}Array\.from\(\{\s*length:\s*VOTE_COUNT\s*\}[\s\S]{0,200}runGeneratorAgent/,
    )
  })

  it('T1 runs Cross-Table + Cardinality specialists in parallel via Promise.all', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/Promise\.all\(\[[\s\S]{0,800}runCrossTableSpecialistAgent[\s\S]{0,800}runCardinalitySpecialistAgent/)
  })

  it('T2 runs 3× Critic in parallel via Promise.all', () => {
    expect(ORCHESTRATOR_SRC).toMatch(
      /Promise\.all\([\s\S]{0,300}Array\.from\(\{\s*length:\s*VOTE_COUNT\s*\}[\s\S]{0,200}runCriticAgent/,
    )
  })

  it('T3 refinement uses MAPPING_GENERATION_AGENT_SYSTEM_PROMPT + EMIT_TABLE_MAPPINGS_TOOL (PR 3.4a frozen surface)', () => {
    // PR-A wrapped this with withProvenanceGuidance(...) so the prompt
    // picks up the 4-tier priority block at flag-ON. Allow either form.
    expect(ORCHESTRATOR_SRC).toMatch(
      /systemPrompt:\s*(?:withProvenanceGuidance\()?MAPPING_GENERATION_AGENT_SYSTEM_PROMPT/,
    )
    expect(ORCHESTRATOR_SRC).toMatch(/promptVersion:\s*'mapping-v3-refinement'/)
  })

  it('voted agents (Generator + Critic) declare disabled thinking + Opus-4.7-API-constraint DIVERGENCE comment; specialists keep adaptive thinking', () => {
    // PR 3.4cd commit 4 DIVERGENCE: Opus 4.7 deprecates `temperature`
    // entirely AND rejects temperature != 1 when thinking is 'adaptive'.
    // Voted agents drop both temperature AND set thinking: 'disabled' as
    // a marker. Voting variance is currently disabled awaiting follow-up
    // (model swap to Sonnet 4.6 or Anthropic-side fix).
    const generatorBlock = sliceBetween(
      ORCHESTRATOR_SRC,
      'async function runGeneratorAgent(',
      'interface SpecialistAgentArgs',
    )
    const criticBlock = sliceBetween(
      ORCHESTRATOR_SRC,
      'async function runCriticAgent(',
      '// ─── Vote aggregators',
    )
    // Voted agents: thinking disabled + DIVERGENCE comment present.
    expect(generatorBlock).toMatch(/thinking:\s*\{\s*type:\s*'disabled'\s*\}/)
    expect(criticBlock).toMatch(/thinking:\s*\{\s*type:\s*'disabled'\s*\}/)
    expect(generatorBlock).toMatch(/DIVERGENCE/i)
    expect(criticBlock).toMatch(/DIVERGENCE/i)

    // Specialists: keep adaptive thinking (single-shot, no variance need).
    const crossTableBlock = sliceBetween(
      ORCHESTRATOR_SRC,
      'async function runCrossTableSpecialistAgent(',
      'async function runCardinalitySpecialistAgent(',
    )
    const cardinalityBlock = sliceBetween(
      ORCHESTRATOR_SRC,
      'async function runCardinalitySpecialistAgent(',
      'interface CriticAgentArgs',
    )
    expect(crossTableBlock).toMatch(/thinking:\s*\{\s*type:\s*'adaptive'\s*\}/)
    expect(cardinalityBlock).toMatch(/thinking:\s*\{\s*type:\s*'adaptive'\s*\}/)
  })

  it('per-vote metadata threaded into runAgentLoop calls (vote_index + vote_role)', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/vote_role:\s*'generator'/)
    expect(ORCHESTRATOR_SRC).toMatch(/vote_role:\s*'critic'/)
    expect(ORCHESTRATOR_SRC).toMatch(/vote_index:\s*i\s*\+\s*1/)
  })

  it('post-aggregation telemetry: applyVoteOutcomeMetadata called for both Generator and Critic', () => {
    expect(ORCHESTRATOR_SRC).toMatch(/applyVoteOutcomeMetadata\(\{[\s\S]{0,300}voteRole:\s*'generator'/)
    expect(ORCHESTRATOR_SRC).toMatch(/applyVoteOutcomeMetadata\(\{[\s\S]{0,300}voteRole:\s*'critic'/)
  })
})

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}
