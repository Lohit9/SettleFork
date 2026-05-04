// @vitest-environment node
//
// PR 3.4a — `resolveOutputConfig` resolution branches + source-level
// pins for the new thinking / output_config plumbing in callLLM and
// callLLMStreaming. Pure helpers; no SDK calls.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'

import { resolveOutputConfig } from '@/lib/ai/llm-client'

const ORIGINAL_PHASE_2_FLAG = process.env.AI_PHASE_2_ENABLED

afterEach(() => {
  if (ORIGINAL_PHASE_2_FLAG === undefined) delete process.env.AI_PHASE_2_ENABLED
  else process.env.AI_PHASE_2_ENABLED = ORIGINAL_PHASE_2_FLAG
})

describe('resolveOutputConfig — caller override + legacy fallback', () => {
  it('caller-supplied opts.output_config wins over Phase-2 fallback', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(
      resolveOutputConfig({
        output_config: { effort: 'max' },
        feature: 'mapping_generate',
      }),
    ).toEqual({ effort: 'max' })
  })

  it('falls back to Phase-2 effort when output_config is omitted', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveOutputConfig({ feature: 'mapping_generate' })).toEqual({
      effort: 'high',
    })
  })

  it('LOW_EFFORT_FEATURES under Phase 2 → undefined (no output_config sent)', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveOutputConfig({ feature: 'transform_describe' })).toBeUndefined()
  })

  it('Phase 2 OFF + no override → undefined (Sonnet default)', () => {
    process.env.AI_PHASE_2_ENABLED = '0'
    expect(resolveOutputConfig({ feature: 'mapping_generate' })).toBeUndefined()
  })
})

const LLM_CLIENT_SRC = readFileSync(
  resolve(__dirname, '../../lib/ai/llm-client.ts'),
  'utf8',
)

describe('llm-client — thinking + output_config plumbing pins', () => {
  it('CallLLMOptions declares optional thinking + output_config typed via SDK', () => {
    expect(LLM_CLIENT_SRC).toMatch(/thinking\?:\s*ThinkingConfigParam/)
    expect(LLM_CLIENT_SRC).toMatch(/output_config\?:\s*OutputConfig/)
    expect(LLM_CLIENT_SRC).toMatch(
      /import\s+type\s*\{[\s\S]*?OutputConfig[\s\S]*?ThinkingConfigParam[\s\S]*?\}\s*from\s*'@anthropic-ai\/sdk\/resources\/messages'/,
    )
  })

  it('both wrappers spread output_config + thinking into request body (twice each)', () => {
    const outputConfigSpreads = LLM_CLIENT_SRC.match(
      /\.\.\.\(\s*outputConfig\s*&&\s*\{\s*output_config:\s*outputConfig\s*\}\s*\)/g,
    )
    const thinkingSpreads = LLM_CLIENT_SRC.match(
      /\.\.\.\(\s*opts\.thinking\s*&&\s*\{\s*thinking:\s*opts\.thinking\s*\}\s*\)/g,
    )
    expect(outputConfigSpreads?.length).toBe(2) // callLLM + callLLMStreaming
    expect(thinkingSpreads?.length).toBe(2)
  })

  it('agent-loop.ts Pick widening includes thinking + output_config', () => {
    const agentLoopSrc = readFileSync(
      resolve(__dirname, '../../lib/ai/agent-loop.ts'),
      'utf8',
    )
    expect(agentLoopSrc).toMatch(/\|\s*'thinking'/)
    expect(agentLoopSrc).toMatch(/\|\s*'output_config'/)
  })
})
