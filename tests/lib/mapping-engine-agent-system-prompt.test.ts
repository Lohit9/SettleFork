// @vitest-environment node
//
// PR 3.4a — source-level pins for MAPPING_GENERATION_AGENT_SYSTEM_PROMPT.
// Same source-text-invariant convention as
// tests/actions/generate-mappings-orchestration.test.ts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const ENGINE_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/mapping-engine.ts'),
  'utf8',
)

describe('mapping-engine — agent-mode system prompt', () => {
  it('exports the agent variant alongside the original constant', () => {
    expect(ENGINE_SRC).toMatch(/export const MAPPING_GENERATION_SYSTEM_PROMPT\s*=\s*`/)
    expect(ENGINE_SRC).toMatch(/export const MAPPING_GENERATION_AGENT_SYSTEM_PROMPT\s*=/)
    expect(ENGINE_SRC).toMatch(
      /MAPPING_GENERATION_AGENT_SYSTEM_PROMPT\s*=\s*\n?\s*MAPPING_GENERATION_SYSTEM_PROMPT\s*\+\s*'\\n\\n'\s*\+\s*AGENT_TOOL_GUIDANCE/,
    )
  })

  it('AGENT_TOOL_GUIDANCE is empty post-HOT-FIX-4 (data-scanning tool advertisement removed); export shape preserved', () => {
    // HOT-FIX 4 (May 2026): the previous content advertised three
    // live data-scanning tools (query_field_data /
    // count_distinct_patterns / cross_field_correlation) which the AI
    // was calling without ever producing emit_table_mappings — the
    // agent loop drained iterations / cost-cap and persisted zero
    // mappings. Constant is now empty; agent prompts no longer
    // advertise these tools. HOT-FIX 5 additionally removed the
    // tool registrations from runSingleAgentMappingLoop's tools
    // array (single-agent-mapping.ts:138-141 pre-fix).
    //
    // PR 3.4cd commit 4 history: AGENT_TOOL_GUIDANCE was moved to a
    // dependency-free module (agent-tool-guidance.ts) to break the
    // circular-import cycle between mapping-engine.ts and
    // multi-agent-prompts.ts. mapping-engine.ts re-exports it for
    // import-path stability — that re-export is still in place.
    const GUIDANCE_SRC = readFileSync(
      resolve(__dirname, '../../lib/ai/agent-tool-guidance.ts'),
      'utf8',
    )
    // Export shape preserved (consumers compose this constant via
    // string concatenation; deleting the export would break every
    // import site).
    expect(GUIDANCE_SRC).toMatch(/export const AGENT_TOOL_GUIDANCE\s*=\s*['"]['"]/)
    // Negative pins: the data-scanning tool advertisements MUST stay
    // out of the constant body until a deliberate restore lands.
    // Comment lines that REFERENCE the names historically (in the
    // hot-fix-4 docblock) don't count — strip line comments first.
    const codeOnly = GUIDANCE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(codeOnly).not.toContain('query_field_data')
    expect(codeOnly).not.toContain('count_distinct_patterns')
    expect(codeOnly).not.toContain('cross_field_correlation')
    expect(codeOnly).not.toMatch(/HARD LIMITS/)
    expect(codeOnly).not.toMatch(/WHAT NOT TO DO/)
    // mapping-engine still re-exports for backward-compat import paths.
    expect(ENGINE_SRC).toMatch(/export\s*\{\s*AGENT_TOOL_GUIDANCE\s*\}/)
  })

  it('original prompt heritage anchors remain present (byte-stability spot-check)', () => {
    expect(ENGINE_SRC).toContain('TRANSFORMATION RULES — A field needs_transformation')
    expect(ENGINE_SRC).toContain('TABLE-LEVEL MATCHING — WHEN TO EMIT A table_mapping')
    expect(ENGINE_SRC).toContain(
      'CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.',
    )
  })
})
