// @vitest-environment node
//
// PR 3.4b — pure-helper tests + source-level pins for the AI_PHASE_3_ENABLED
// gate in lib/ai/mapping-engine.ts (`runMappingGeneration` BULK callsite)
// and the schema-overview helper in lib/ai/context-builder.ts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import {
  buildAgentUserMessage,
  synthesizeToolUseResult,
} from '@/lib/ai/mapping-engine'
import { formatSchemaOverviewBlock } from '@/lib/ai/context-builder'
import type { AgentLoopResult } from '@/lib/ai/agent-loop'
import type { ProjectAIContext, TableContext } from '@/lib/ai/context-builder'

const ENGINE_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/mapping-engine.ts'),
  'utf8',
)

// ─── buildAgentUserMessage ──────────────────────────────────────────────────

describe('buildAgentUserMessage — prelude composition', () => {
  it('returns base message unchanged when both preludes empty', () => {
    expect(
      buildAgentUserMessage({ baseUserMessage: 'BASE', schemaOverview: '', businessContext: null }),
    ).toBe('BASE')
  })

  it('emits both preludes in order: business-context, schema-overview, base', () => {
    expect(
      buildAgentUserMessage({
        baseUserMessage: 'BASE',
        schemaOverview: 'OVERVIEW',
        businessContext: 'CTX',
      }),
    ).toBe('<customer_business_context>\nCTX\n</customer_business_context>\n\nOVERVIEW\n\nBASE')
  })
})

// ─── synthesizeToolUseResult ────────────────────────────────────────────────

describe('synthesizeToolUseResult — agent → CallLLMResult adapter', () => {
  const finalAgentResult = {
    kind: 'final',
    finalToolUse: { name: 'emit_table_mappings', input: { table_mappings: [] } },
    iterations: 3,
    totalCostUsd: 0.42,
    callIds: ['head-id', 'mid-id', 'tail-id'],
  } as const satisfies AgentLoopResult & { kind: 'final' }

  it('maps to kind=toolUse with the head-of-chain callId, aggregate cost, zeroed token counters', () => {
    const result = synthesizeToolUseResult(finalAgentResult)
    expect(result.kind).toBe('toolUse')
    if (result.kind !== 'toolUse') return
    expect(result.toolUse.name).toBe('emit_table_mappings')
    expect(result.callId).toBe('tail-id')
    expect(result.costUsd).toBe(0.42)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.cacheReadTokens).toBe(0)
    expect(result.cacheCreationTokens).toBe(0)
    expect(result.anthropicRequestId).toBeNull()
  })
})

// ─── formatSchemaOverviewBlock ──────────────────────────────────────────────

describe('formatSchemaOverviewBlock — naming + FK + doc summary', () => {
  function table(name: string, fields: Array<Partial<TableContext['fields'][number]> & { name: string }>): TableContext {
    return {
      table_id: 't', table_name: name, dataset_name: 'd', role: 'source', row_count: 10,
      fields: fields.map((f) => ({
        field_id: 'f-stub', data_type: 'text', inferred_type: null, is_nullable: true,
        is_primary_key: false, is_foreign_key: false, fk_reference: null, check_constraint: null,
        schema_source: 'inferred' as const, default_value: null, description: null,
        null_percentage: 0, cardinality: 0, unique_percentage: 0, format_issues_count: 0,
        min_value: null, max_value: null, value_distribution: [], sample_values: [],
        ...f,
      })),
    }
  }

  function ctx(overrides: Partial<ProjectAIContext> = {}): ProjectAIContext {
    return {
      project_id: 'p', project_name: 'P', source_tables: [], target_tables: [],
      documents: { source_documents: [], target_documents: [], business_context_documents: [], poc_answer_key: null },
      intelligence_context: '', poc_template: null, ...overrides,
    }
  }

  it('emits XML-tagged block with all 5 lines, computes counts + naming + FK density + doc flags', () => {
    const out = formatSchemaOverviewBlock(
      ctx({
        source_tables: [table('customers', [{ name: 'id', is_primary_key: true }, { name: 'org_id', is_foreign_key: true, fk_reference: 'orgs.id' }])],
        target_tables: [table('ACCOUNTS', [{ name: 'ACCOUNT_ID', is_primary_key: true }])],
        documents: { source_documents: [{ filename: 'a', text: 'x' }], target_documents: [], business_context_documents: [{ filename: 'b', text: 'y' }], poc_answer_key: null },
        intelligence_context: 'present',
      }),
    )
    expect(out.startsWith('<schema_overview>')).toBe(true)
    expect(out.endsWith('</schema_overview>')).toBe(true)
    expect(out).toMatch(/Source: 1 table\(s\), 2 field\(s\) across 10 profiled row\(s\); naming: snake_case; FK density: 1\/2 \(50%\)/)
    expect(out).toMatch(/Target: 1 table\(s\), 1 field\(s\); naming: UPPER_SNAKE_CASE/)
    expect(out).toMatch(/Schema docs: 1; business-context docs: 1; migration intelligence: present/)
  })
})

// ─── Source-level pins for the BULK callsite gate ───────────────────────────
//
// PR 3.4cd commit 2: the 3.4b inline agent body has been extracted to
// `lib/ai/single-agent-mapping.ts` (`runSingleAgentMappingLoop` helper).
// The gate at this callsite now DELEGATES to that helper. Source pins
// for the BODY patterns (tool registration, llmOptions, schema_error
// fallback) live in `tests/lib/single-agent-mapping.test.ts` instead.
// Here we pin the GATE shape: per-role sample bumps, business_context +
// schema_overview pre-loop reads, two-level gate (phase3Enabled +
// multiAgentEnabled), legacy else branch heritage args.

const HELPER_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/single-agent-mapping.ts'),
  'utf8',
)

describe('mapping-engine — runMappingGeneration agent gate (source pins)', () => {
  it('declares phase3Enabled + threads per-role sample bumps + reads businessContext + schemaOverview pre-loop', () => {
    expect(ENGINE_SRC).toMatch(/const phase3Enabled = process\.env\.AI_PHASE_3_ENABLED === '1'/)
    expect(ENGINE_SRC).toMatch(
      /\.\.\.\(phase3Enabled\s*&&\s*\{\s*maxSourceSampleValues:\s*50,\s*maxTargetSampleValues:\s*30\s*\}\)/,
    )
    expect(ENGINE_SRC).toMatch(/const businessContext\s*=\s*phase3Enabled\s*\?\s*await\s+readBusinessContext\(/)
    expect(ENGINE_SRC).toMatch(/const schemaOverviewBlock\s*=\s*phase3Enabled\s*\?\s*formatSchemaOverviewBlock\(/)
  })

  it('S1.1: multi-agent removed from BULK callsite — only single-agent helper dispatched', () => {
    // S1.1 removed runMultiAgentMappingPipeline and AI_PHASE_3_MULTI_AGENT_ENABLED from
    // mapping-engine.ts (the BULK callsite). The single-pair callsite in mappings.ts still
    // carries the multi-agent gate. This pin ensures the dead code stays gone.
    expect(ENGINE_SRC).not.toMatch(/runMultiAgentMappingPipeline\(/)
    expect(ENGINE_SRC).not.toMatch(/AI_PHASE_3_MULTI_AGENT_ENABLED/)
    expect(ENGINE_SRC).toMatch(/runSingleAgentMappingLoop\(/)
  })

  it('extracted helper streams via callLLMStreaming with EMIT_TABLE_MAPPINGS_TOOL forced + locked llmOptions (Opus 4.7 + adaptive thinking + max effort + agent_loop)', () => {
    // May 2026 incident: HOT-FIX 5 stripped the 3 data-scanning tool
    // registrations (QUERY_FIELD_DATA_TOOL, COUNT_DISTINCT_PATTERNS_TOOL,
    // CROSS_FIELD_CORRELATION_TOOL) — production telemetry showed the
    // model dispatching them in turns where it never reached
    // emit_table_mappings, draining the loop's iterations / cost cap.
    // The streaming switch then collapsed runAgentLoop down to a
    // direct callLLMStreaming({ tool: EMIT_TABLE_MAPPINGS_TOOL })
    // because the agent loop was degenerate with one answer-only tool.
    //
    // Negative pins on the data-scanning tools — they MUST stay out
    // of the helper's tools array until cohort eval validates lift.
    expect(HELPER_SRC).not.toMatch(/QUERY_FIELD_DATA_TOOL,\s*handler:/)
    expect(HELPER_SRC).not.toMatch(/COUNT_DISTINCT_PATTERNS_TOOL,\s*handler:/)
    expect(HELPER_SRC).not.toMatch(/CROSS_FIELD_CORRELATION_TOOL,\s*handler:/)
    // Positive pin: the streaming wrapper is the entry point now.
    expect(HELPER_SRC).toMatch(/await callLLMStreaming\(/)
    expect(HELPER_SRC).toMatch(/tool:\s*EMIT_TABLE_MAPPINGS_TOOL/)
    expect(HELPER_SRC).toMatch(/model:\s*'claude-opus-4-7'/)
    // promptVersion bumped to v2-agent-streaming so llm_calls
    // analytics can distinguish the streaming-era runs.
    expect(HELPER_SRC).toMatch(/promptVersion:\s*'mapping-v2-agent-streaming'/)
    // HOT-FIX 6 (May 2026): thinking flipped from 'adaptive' to
    // 'disabled' to satisfy the Anthropic constraint that
    // tool_choice: { type: 'tool' } (forced) is incompatible with
    // adaptive/enabled thinking. The agent callsite uses forced
    // single-tool (EMIT_TABLE_MAPPINGS_TOOL), so thinking must be
    // disabled. See investigation report in this same session +
    // mapping-streaming-incident.test.ts for the locking pin.
    expect(HELPER_SRC).toMatch(/thinking:\s*\{\s*type:\s*'disabled'\s*\}/)
    expect(HELPER_SRC).toMatch(/output_config:\s*\{\s*effort:\s*'max'\s*\}/)
    expect(HELPER_SRC).toMatch(/agent_loop:\s*true/)
    // PR-A wrapped this with withProvenanceGuidance(...) so the prompt
    // picks up the 4-tier priority block at flag-ON. Allow either form.
    expect(HELPER_SRC).toMatch(
      /systemPrompt:\s*(?:withProvenanceGuidance\()?MAPPING_GENERATION_AGENT_SYSTEM_PROMPT/,
    )
  })

  it('extracted helper no longer carries the schema_error fallback (degenerate agent loop collapsed to direct callLLMStreaming)', () => {
    // May 2026 streaming switch: the agent-loop wrapper is gone, so
    // the schema_error fallback (which retried via callLLM with the
    // legacy prompt) is no longer reachable. With a single forced
    // tool, the model can't emit text — there's nothing for
    // schema_error to detect. Negative pins guarantee the fallback
    // doesn't sneak back via a partial revert. Strip block + line
    // comments before matching so historical mentions in docblock
    // prose (PR 3.4cd's docblock references agent_fallback: true)
    // don't trip the negative pin.
    const codeOnly = HELPER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
      /\/\/[^\n]*/g,
      '',
    )
    expect(codeOnly).not.toMatch(/agentResult\.reason\s*===\s*'schema_error'/)
    expect(codeOnly).not.toMatch(/agent_fallback:\s*true/)
    // Note: the SingleAgentResult union still carries `'aborted_other'`
    // and `'fallback_threw'` members for caller-side API stability —
    // they're intentionally preserved as type-shape forward-compat. The
    // helper just never emits them anymore. Pin "kind: 'aborted_other'"
    // (the return shape) rather than the string itself, so the union
    // declaration doesn't trip the negative match.
    expect(codeOnly).not.toMatch(/return\s*\{\s*kind:\s*'aborted_other'/)
    expect(codeOnly).not.toMatch(/return\s*\{\s*kind:\s*'fallback_threw'/)
  })

  it('legacy else branch preserves heritage args (phase2Enabled tool spread + cacheControl + error-then-continue) under streaming', () => {
    expect(ENGINE_SRC).toMatch(/\.\.\.\(phase2Enabled\s*&&\s*\{\s*tool:\s*EMIT_TABLE_MAPPINGS_TOOL\s*\}\)/)
    // May 2026 streaming switch: legacy promptVersion is now
    // 'mapping-v1-streaming' (was 'mapping-v1') for analytics parity
    // with the agent path's '-streaming' suffix.
    expect(ENGINE_SRC).toMatch(/promptVersion:\s*'mapping-v1(?:-streaming)?'/)
    expect(ENGINE_SRC).toMatch(/Claude call failed for source table[\s\S]{0,150}continue/)
  })
})
