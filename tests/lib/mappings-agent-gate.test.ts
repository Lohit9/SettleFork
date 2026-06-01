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

  it('dispatches to the single-agent helper; multi-agent path removed (SET-201)', () => {
    expect(MAPPINGS_SRC).toMatch(/runSingleAgentMappingLoop\(/)
    // SET-40 teardown removed the multi-agent dispatch: no multiAgentEnabled
    // gate, no runMultiAgentMappingPipeline call. Pin their absence so the
    // dead path can't silently return.
    expect(MAPPINGS_SRC).not.toMatch(/runMultiAgentMappingPipeline\(/)
    expect(MAPPINGS_SRC).not.toMatch(/AI_PHASE_3_MULTI_AGENT_ENABLED/)
  })

  it('single-pair gate passes cacheControl: false (PR 13.1 audit posture preserved per LOCK #4)', () => {
    // Per LOCK #4: single-pair NEVER cached. The gate passes this flag
    // explicitly to the helper. PR-CACHE-HOTFIX additionally flipped the
    // BULK callsite to false (see tests/lib/multi-agent-gate.test.ts);
    // pending INF-5 selective re-enable, ALL mapping callsites are now
    // cacheControl: false.
    expect(MAPPINGS_SRC).toMatch(/cacheControl:\s*false/)
  })

  it('aborted-loop handling: helper-result discrimination preserves single-pair return-error semantics', () => {
    // Extracted helper returns SingleAgentResult discriminated union;
    // single-pair callsite maps each kind to its own error-return.
    expect(MAPPINGS_SRC).toMatch(/r\.kind\s*===\s*'agent_threw'/)
    // May 2026 streaming switch: single-pair callsite still references
    // the full SingleAgentResult union for forward-compatibility, but
    // the helper no longer emits 'fallback_threw' / 'aborted_other'
    // (the schema_error fallback is dead code; the agent loop is
    // collapsed to a direct callLLMStreaming call). Pin lifted on
    // those two cases — they're still in the union shape but never
    // emitted at runtime.
    // Single-pair returns on hard-fail (BULK uses `continue`).
    expect(MAPPINGS_SRC).toMatch(/return\s*\{\s*inserted:\s*0,\s*error:/)
  })

  it('extracted helper streams via callLLMStreaming with EMIT_TABLE_MAPPINGS_TOOL forced (May 2026 streaming switch)', () => {
    const HELPER_SRC = readFileSync(
      resolve(__dirname, '../../lib/ai/single-agent-mapping.ts'),
      'utf8',
    )
    // HOT-FIX 5 + streaming switch: the 3 data-scanning tools are
    // gone from the helper's tools array and the agent loop is
    // bypassed entirely. Negative pins on the data-scanning tool
    // registrations + positive pin on the streaming wrapper. Strip
    // comments before matching so historical references in the
    // docblock don't trip the negative pin.
    const codeOnly = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
      /\/\/[^\n]*/g,
      '',
    )
    expect(codeOnly).not.toMatch(/QUERY_FIELD_DATA_TOOL,\s*handler:/)
    expect(codeOnly).not.toMatch(/COUNT_DISTINCT_PATTERNS_TOOL,\s*handler:/)
    expect(codeOnly).not.toMatch(/CROSS_FIELD_CORRELATION_TOOL,\s*handler:/)
    expect(HELPER_SRC).toMatch(/await callLLMStreaming\(/)
    expect(HELPER_SRC).toMatch(/\btool:\s*EMIT_TABLE_MAPPINGS_TOOL\b/)
    // Schema_error fallback collapsed — no longer reachable with a
    // single forced tool.
    expect(codeOnly).not.toMatch(/agent_fallback:\s*true/)
    expect(codeOnly).not.toMatch(/agentResult\.reason\s*===\s*'schema_error'/)
    // PR-A wrapped this with withProvenanceGuidance(...) so the prompt
    // picks up the 4-tier priority block at flag-ON. Allow either form.
    expect(HELPER_SRC).toMatch(
      /systemPrompt:\s*(?:withProvenanceGuidance\()?MAPPING_GENERATION_AGENT_SYSTEM_PROMPT/,
    )
  })

  it('legacy else branch preserves featureOverride routing + phase2Enabled tool spread (heritage) — under streaming', () => {
    expect(MAPPINGS_SRC).toMatch(/feature:\s*featureOverride\s*\?\?\s*'mapping_generate_legacy_pair'/)
    expect(MAPPINGS_SRC).toMatch(/\.\.\.\(phase2Enabled\s*&&\s*\{\s*tool:\s*EMIT_TABLE_MAPPINGS_TOOL\s*\}\)/)
    // May 2026 streaming switch: legacy single-pair callsite uses
    // callLLMStreaming.
    expect(MAPPINGS_SRC).toMatch(/await callLLMStreaming\(/)
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
