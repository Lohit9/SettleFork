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

  it('AGENT_TOOL_GUIDANCE covers all 3 data tools + hard limits + what-not-to-do', () => {
    expect(ENGINE_SRC).toMatch(/AGENT_TOOL_GUIDANCE\s*=/)
    expect(ENGINE_SRC).toContain('query_field_data')
    expect(ENGINE_SRC).toContain('count_distinct_patterns')
    expect(ENGINE_SRC).toContain('cross_field_correlation')
    expect(ENGINE_SRC).toMatch(/HARD LIMITS/)
    expect(ENGINE_SRC).toMatch(/WHAT NOT TO DO/)
  })

  it('original prompt heritage anchors remain present (byte-stability spot-check)', () => {
    expect(ENGINE_SRC).toContain('TRANSFORMATION RULES — A field needs_transformation')
    expect(ENGINE_SRC).toContain('TABLE-LEVEL MATCHING — WHEN TO EMIT A table_mapping')
    expect(ENGINE_SRC).toContain(
      'CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.',
    )
  })
})
