// @vitest-environment node
//
// PR 3.4cd commit 2 — source-level pins for the AI_PHASE_3_ENABLED +
// AI_PHASE_3_MULTI_AGENT_ENABLED two-level gate at
// `runMappingGenerationForPair` (lib/actions/mappings.ts) — the
// eval-runner-exercised path. The 3.4b inline body has been extracted
// to `lib/ai/single-agent-mapping.ts`; pins here cover the GATE shape
// and helper-result discrimination. Body patterns are pinned in
// `tests/lib/single-agent-mapping.test.ts` (commit 4) and in this
// file under the "extracted helper" describe.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const MAPPINGS_SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/mappings.ts'),
  'utf8',
)
const SYNTHETIC_BUILDER_SRC = readFileSync(
  resolve(__dirname, '../../lib/eval/synthetic-context-builder.ts'),
  'utf8',
)
const RUNNER_SRC = readFileSync(
  resolve(__dirname, '../../lib/eval/runner.ts'),
  'utf8',
)

describe('mappings — runMappingGenerationForPair agent gate (source pins)', () => {
  it('declares phase3Enabled + threads per-role bumps + reads businessContext + schemaOverview', () => {
    expect(MAPPINGS_SRC).toMatch(/const phase3Enabled = process\.env\.AI_PHASE_3_ENABLED === '1'/)
    expect(MAPPINGS_SRC).toMatch(
      /\.\.\.\(phase3Enabled\s*&&\s*\{\s*maxSourceSampleValues:\s*50,\s*maxTargetSampleValues:\s*30\s*\}\)/,
    )
    expect(MAPPINGS_SRC).toMatch(/const businessContext\s*=\s*phase3Enabled\s*\?\s*await\s+readBusinessContext\(/)
    expect(MAPPINGS_SRC).toMatch(/const schemaOverviewBlock\s*=\s*phase3Enabled\s*\?\s*formatSchemaOverviewBlock\(/)
  })

  it('PR 3.4cd: declares multiAgentEnabled + dispatches to single-agent helper or multi-agent orchestrator', () => {
    expect(MAPPINGS_SRC).toMatch(/const multiAgentEnabled = process\.env\.AI_PHASE_3_MULTI_AGENT_ENABLED === '1'/)
    expect(MAPPINGS_SRC).toMatch(/runSingleAgentMappingLoop\(/)
    expect(MAPPINGS_SRC).toMatch(/runMultiAgentMappingPipeline\(/)
  })

  it('single-pair gate passes cacheControl: false (PR 13.1 audit posture preserved per LOCK #4)', () => {
    // Per LOCK #4: bulk callsite has cacheControl: true; single-pair
    // does NOT. The gate now passes this flag explicitly to the helper.
    expect(MAPPINGS_SRC).toMatch(/cacheControl:\s*false/)
  })

  it('aborted-loop handling: helper-result discrimination preserves single-pair return-error semantics', () => {
    // Extracted helper returns SingleAgentResult discriminated union;
    // single-pair callsite maps each kind to its own error-return.
    expect(MAPPINGS_SRC).toMatch(/r\.kind\s*===\s*'agent_threw'/)
    expect(MAPPINGS_SRC).toMatch(/r\.kind\s*===\s*'fallback_threw'/)
    expect(MAPPINGS_SRC).toMatch(/r\.kind\s*===\s*'aborted_other'/)
    // Single-pair returns on hard-fail (BULK uses `continue`).
    expect(MAPPINGS_SRC).toMatch(/return\s*\{\s*inserted:\s*0,\s*error:/)
  })

  it('extracted helper preserves agent body patterns (tools + llmOptions + schema_error fallback)', () => {
    // PR 3.4b body patterns now live in single-agent-mapping.ts (commit 2 extraction).
    const HELPER_SRC = readFileSync(
      resolve(__dirname, '../../lib/ai/single-agent-mapping.ts'),
      'utf8',
    )
    expect(HELPER_SRC).toMatch(/tool:\s*QUERY_FIELD_DATA_TOOL,\s*handler:\s*makeQueryFieldDataHandler\(/)
    expect(HELPER_SRC).toMatch(/\btool:\s*EMIT_TABLE_MAPPINGS_TOOL\b/)
    expect(HELPER_SRC).toMatch(/agent_fallback:\s*true/)
    expect(HELPER_SRC).toMatch(/agentResult\.reason\s*===\s*'schema_error'/)
    expect(HELPER_SRC).toMatch(/systemPrompt:\s*MAPPING_GENERATION_AGENT_SYSTEM_PROMPT/)
  })

  it('legacy else branch preserves featureOverride routing + phase2Enabled tool spread (heritage)', () => {
    expect(MAPPINGS_SRC).toMatch(/feature:\s*featureOverride\s*\?\?\s*'mapping_generate_legacy_pair'/)
    expect(MAPPINGS_SRC).toMatch(/\.\.\.\(phase2Enabled\s*&&\s*\{\s*tool:\s*EMIT_TABLE_MAPPINGS_TOOL\s*\}\)/)
  })
})

describe('eval — business_context propagation', () => {
  it('BuildMappingContextInput accepts optional businessContext + UPDATEs projects.business_context with column-missing fallback', () => {
    expect(SYNTHETIC_BUILDER_SRC).toMatch(/businessContext\?:\s*string/)
    expect(SYNTHETIC_BUILDER_SRC).toMatch(
      /\.from\('projects'\)\s*\.update\(\{\s*business_context:\s*input\.businessContext/,
    )
    // Migration 086 dependency: graceful fallback when column missing.
    expect(SYNTHETIC_BUILDER_SRC).toMatch(/business_context[\s\S]*schema cache|column[\s\S]*business_context/i)
  })

  it('runner.ts threads metadata.business_context to buildSyntheticMappingContext (mapping task only)', () => {
    expect(RUNNER_SRC).toMatch(
      /args\.example\.metadata\.business_context\s*\?\s*\{\s*businessContext:\s*args\.example\.metadata\.business_context\s*\}/,
    )
  })
})
