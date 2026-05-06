// @vitest-environment node
//
// May 2026 incident — locked invariants for the streaming switch +
// 32k token bump + HOT-FIX 4 (AGENT_TOOL_GUIDANCE empty) + HOT-FIX 5
// (data-scanning tool registrations removed). Pre-incident shape:
//
//   - mapping_generate ran on `callLLM` (non-streaming) at all 3
//     callsites (BULK legacy, BULK agent, single-pair legacy).
//   - PER_BATCH_MAX_TOKENS = 16000 (truncated tool inputs on projects
//     with 100+ field-pair sets).
//   - AGENT_TOOL_GUIDANCE advertised 3 data-scanning tools the agent
//     was using without producing emit_table_mappings.
//   - runSingleAgentMappingLoop registered 4 tools (3 data-scanning +
//     1 answer) on runAgentLoop; the model burned the iteration /
//     cost cap on the data-scanning tools without persisting mappings.
//
// Post-incident shape (this file pins it):
//
//   - All 3 mapping_generate callsites use `callLLMStreaming`.
//   - PER_BATCH_MAX_TOKENS = 32000 at both call points.
//   - AGENT_TOOL_GUIDANCE constant is empty.
//   - runSingleAgentMappingLoop bypasses runAgentLoop and calls
//     callLLMStreaming directly with EMIT_TABLE_MAPPINGS_TOOL forced.
//
// The pre-existing source-text pins in
// tests/lib/mapping-engine-agent-gate.test.ts +
// tests/lib/mappings-agent-gate.test.ts +
// tests/actions/generate-mappings-orchestration.test.ts +
// tests/lib/mapping-engine-agent-system-prompt.test.ts already cover
// individual pieces. This file aggregates them into one set so the
// May 2026 incident is locked behind a single, explicitly named
// describe block — easier to find and trace later.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function read(rel: string): string {
  return readFileSync(resolve(__dirname, '../../', rel), 'utf8')
}

describe('[May 2026 incident] mapping_generate uses callLLMStreaming + 32k tokens + no data-scanning advertisement', () => {
  it('AGENT_TOOL_GUIDANCE is the empty string (HOT-FIX 4)', () => {
    const src = read('lib/ai/agent-tool-guidance.ts')
    expect(src).toMatch(/export const AGENT_TOOL_GUIDANCE\s*=\s*['"]['"]/)
  })

  it('runSingleAgentMappingLoop tools array carries ZERO data-scanning tool registrations (HOT-FIX 5)', () => {
    const src = read('lib/ai/single-agent-mapping.ts')
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(codeOnly).not.toMatch(/QUERY_FIELD_DATA_TOOL,\s*handler:/)
    expect(codeOnly).not.toMatch(/COUNT_DISTINCT_PATTERNS_TOOL,\s*handler:/)
    expect(codeOnly).not.toMatch(/CROSS_FIELD_CORRELATION_TOOL,\s*handler:/)
  })

  it('runSingleAgentMappingLoop streams via callLLMStreaming with EMIT_TABLE_MAPPINGS_TOOL forced', () => {
    const src = read('lib/ai/single-agent-mapping.ts')
    expect(src).toMatch(/await callLLMStreaming\(/)
    expect(src).toMatch(/\btool:\s*EMIT_TABLE_MAPPINGS_TOOL\b/)
    // No leftover runAgentLoop import or call.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(codeOnly).not.toMatch(/await runAgentLoop\(/)
    expect(codeOnly).not.toMatch(/import\s*\{[^}]*\brunAgentLoop\b/)
  })

  it('HOT-FIX 6: thinking is { type: "disabled" } at the agent callsite (forced single tool requires thinking off)', () => {
    // Anthropic API rejects `tool_choice: { type: 'tool' }` (forced)
    // combined with `thinking: 'adaptive' | 'enabled'` with HTTP 400
    // ("Thinking may not be enabled when tool_choice forces tool use").
    // The agent callsite uses `tool: EMIT_TABLE_MAPPINGS_TOOL` (forced
    // single tool), so thinking MUST stay disabled. Negative pin
    // guards against an accidental revert to adaptive that would
    // break production again. See mapping-engine-agent-gate.test.ts
    // for the pre-PR (multi-tool / auto choice) → post-HOT-FIX-6 pin
    // history.
    const src = read('lib/ai/single-agent-mapping.ts')
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(codeOnly).toMatch(/thinking:\s*\{\s*type:\s*'disabled'\s*\}/)
    expect(codeOnly).not.toMatch(/thinking:\s*\{\s*type:\s*'adaptive'\s*\}/)
    expect(codeOnly).not.toMatch(/thinking:\s*\{\s*type:\s*'enabled'/)
  })

  it('BULK legacy callsite (mapping-engine.ts) calls callLLMStreaming with feature mapping_generate', () => {
    const src = read('lib/ai/mapping-engine.ts')
    expect(src).toMatch(
      /callLLMStreaming\(\{[\s\S]{0,800}feature:\s*['"]mapping_generate['"]/,
    )
  })

  it('single-pair legacy callsite (mappings.ts) calls callLLMStreaming', () => {
    const src = read('lib/actions/mappings.ts')
    expect(src).toMatch(/callLLMStreaming\(\{/)
  })

  it('PER_BATCH_MAX_TOKENS = 32000 at both BULK and single-pair callsites', () => {
    const engineSrc = read('lib/ai/mapping-engine.ts')
    const mappingsSrc = read('lib/actions/mappings.ts')
    expect(engineSrc).toMatch(/const\s+PER_BATCH_MAX_TOKENS\s*=\s*32000\b/)
    expect(mappingsSrc).toMatch(/const\s+PER_BATCH_MAX_TOKENS\s*=\s*32000\b/)
  })

  it('promptVersion bumped to "-streaming" suffix on the 3 mapping_generate callsites (analytics distinction)', () => {
    const engineSrc = read('lib/ai/mapping-engine.ts')
    const helperSrc = read('lib/ai/single-agent-mapping.ts')
    const mappingsSrc = read('lib/actions/mappings.ts')
    // Each callsite carries a distinct promptVersion so llm_calls
    // analytics can split pre-incident from post-incident runs.
    expect(engineSrc).toMatch(/promptVersion:\s*'mapping-v1-streaming'/)
    expect(helperSrc).toMatch(/promptVersion:\s*'mapping-v2-agent-streaming'/)
    expect(mappingsSrc).toMatch(/promptVersion:\s*'mapping-v1-streaming'/)
  })

  it('callLLMStreaming is imported from lib/ai/llm-client at every adopting callsite', () => {
    const engineSrc = read('lib/ai/mapping-engine.ts')
    const helperSrc = read('lib/ai/single-agent-mapping.ts')
    const mappingsSrc = read('lib/actions/mappings.ts')
    const importRe =
      /import\s*\{[^}]*\bcallLLMStreaming\b[^}]*\}\s*from\s*['"]@\/lib\/ai\/llm-client['"]/
    expect(engineSrc).toMatch(importRe)
    expect(helperSrc).toMatch(importRe)
    expect(mappingsSrc).toMatch(importRe)
  })

  it('multi-agent path (multi-agent-orchestrator.ts) is NOT switched to streaming (gated OFF, out of incident scope)', () => {
    // Defensive: the user's prompt explicitly said "Do not switch
    // other callLLM sites to streaming — only mapping_generate" and
    // "Do not touch multi-agent-prompts.ts or multi-agent-orchestrator.ts".
    // Pin that the multi-agent orchestrator stays on its existing
    // wrapper choice (it uses runAgentLoop internally; the wrapper
    // is callLLM there). If a future PR converts multi-agent to
    // streaming, that's a separate decision and this pin should be
    // updated deliberately.
    const orchestratorSrc = read('lib/ai/multi-agent-orchestrator.ts')
    expect(orchestratorSrc).not.toMatch(/await callLLMStreaming\(/)
  })
})
