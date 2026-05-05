// @vitest-environment node
//
// PR 3.4b — source-level pins for the AI_PHASE_3_ENABLED gate in
// lib/actions/mappings.ts (`runMappingGenerationForPair` callsite —
// the eval-runner-exercised path) + business_context propagation.

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

  it('agent path registers 4 tools + locked llmOptions; system prompt is the agent variant', () => {
    expect(MAPPINGS_SRC).toMatch(/tool:\s*QUERY_FIELD_DATA_TOOL,\s*handler:\s*makeQueryFieldDataHandler\(/)
    expect(MAPPINGS_SRC).toMatch(/tool:\s*COUNT_DISTINCT_PATTERNS_TOOL,\s*handler:\s*makeCountDistinctPatternsHandler\(/)
    expect(MAPPINGS_SRC).toMatch(/tool:\s*CROSS_FIELD_CORRELATION_TOOL,\s*handler:\s*makeCrossFieldCorrelationHandler\(/)
    expect(MAPPINGS_SRC).toMatch(/\{\s*tool:\s*EMIT_TABLE_MAPPINGS_TOOL\s*\}/)
    expect(MAPPINGS_SRC).toMatch(/model:\s*'claude-opus-4-7'/)
    expect(MAPPINGS_SRC).toMatch(/promptVersion:\s*'mapping-v2-agent'/)
    expect(MAPPINGS_SRC).toMatch(/thinking:\s*\{\s*type:\s*'adaptive'\s*\}/)
    expect(MAPPINGS_SRC).toMatch(/output_config:\s*\{\s*effort:\s*'max'\s*\}/)
    expect(MAPPINGS_SRC).toMatch(/agent_loop:\s*true/)
    expect(MAPPINGS_SRC).toMatch(/systemPrompt:\s*MAPPING_GENERATION_AGENT_SYSTEM_PROMPT/)
  })

  it('single-pair agent path does NOT enable cacheControl (PR 13.1 audit posture preserved per LOCK #4)', () => {
    const agentPathSlice = sliceBetween(MAPPINGS_SRC, 'runAgentLoop({', '})')
    expect(agentPathSlice).not.toMatch(/cacheControl/)
  })

  it('aborted-loop handling: schema_error → fallback; other reasons → return error (single-pair semantics)', () => {
    expect(MAPPINGS_SRC).toMatch(/agentResult\.reason\s*===\s*'schema_error'/)
    expect(MAPPINGS_SRC).toMatch(/agent_fallback:\s*true/)
    expect(MAPPINGS_SRC).toMatch(/Agent aborted:\s*\$\{agentResult\.reason\}[\s\S]{0,200}return\s*\{\s*inserted:\s*0/)
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

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}
