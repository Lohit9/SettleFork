// @vitest-environment node
//
// PR-A — source-text invariants pinning that EVERY agent system-prompt
// callsite is wrapped with `withProvenanceGuidance(...)`. These tests
// fail loudly if a future refactor:
//   - adds a new agent that forgets the wrapper
//   - inlines a systemPrompt without going through the helper
//   - removes the wrapper from an existing callsite
//
// They DO NOT test the runtime LLM behaviour — that's covered by the
// helper-level unit tests in `agent-provenance-guidance.test.ts` plus
// the integration heritage gates (Captures A / B / C).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function read(rel: string): string {
  return readFileSync(resolve(__dirname, '../../', rel), 'utf8')
}

// ─── Per-agent callsite inventory (matches INV-1 §B's 8 agents +
//     the 4 multi-agent prompts + 2 mapping-agent variants + 2
//     fallback paths the wiring sweep caught). 16 callsites total. ────

interface CallsiteSpec {
  agent: string
  file: string
  /**
   * Regex matching the wrapped form. The space before / after may vary
   * (different indentation across the codebase) so we use [\s\S] rather
   * than fixed whitespace.
   */
  wrappedRegex: RegExp
}

const CALLSITES: CallsiteSpec[] = [
  // 1. mapping_generate (BULK)
  {
    agent: 'mapping_generate (BULK)',
    file: 'lib/ai/mapping-engine.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(MAPPING_GENERATION_SYSTEM_PROMPT\)/,
  },
  // 2. mapping_suggest (single-pair Suggest action)
  {
    agent: 'mapping_suggest',
    file: 'lib/ai/mapping-engine.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(MAPPING_SUGGESTION_SYSTEM_PROMPT\)/,
  },
  // 3. mapping_generate_legacy_pair (single-pair legacy non-agent path)
  {
    agent: 'mapping_generate_legacy_pair',
    file: 'lib/actions/mappings.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(MAPPING_GENERATION_SYSTEM_PROMPT\)/,
  },
  // 4. mapping_generate (Phase 3 agent loop — single-agent variant)
  {
    agent: 'mapping_generate (single-agent loop)',
    file: 'lib/ai/single-agent-mapping.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(MAPPING_GENERATION_AGENT_SYSTEM_PROMPT\)/,
  },
  // 5. mapping_generate (Phase 3 agent — schema-error fallback) [REMOVED]
  //
  // The May 2026 streaming switch collapsed runSingleAgentMappingLoop
  // to a direct callLLMStreaming call (the agent loop was degenerate
  // after HOT-FIX 5 left only the answer tool registered). The
  // schema_error fallback path that used MAPPING_GENERATION_SYSTEM_PROMPT
  // (legacy prompt) is no longer reachable — with a single forced
  // tool, the model can't emit text, so schema_error never fires.
  // Pin removed; the negative-pin file audit below catches any future
  // re-introduction of the legacy fallback.
  //
  // 6–10. multi-agent orchestrator callsites [REMOVED — SET-201]
  // lib/ai/multi-agent-orchestrator.ts was deleted (SET-40 multi-agent
  // teardown); the path is inert. Provenance pins removed with the file.
  //
  // 11. transform_generate (SQL generation)
  {
    agent: 'transform_generate',
    file: 'lib/actions/transformations.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(TRANSFORM_SYSTEM_PROMPT\)/,
  },
  // 12. transform_describe (NL description suggester)
  {
    agent: 'transform_describe (suggestTransformDescription)',
    file: 'lib/actions/transformations.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(SUGGEST_SYSTEM_PROMPT\)/,
  },
  // 13. validation_rule_from_nl (uses an inline `systemPrompt` const)
  {
    agent: 'validation_rule_from_nl',
    file: 'lib/actions/validation-rules.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(systemPrompt\)/,
  },
  // 14. quality_detection_ai
  {
    agent: 'quality_detection_ai',
    file: 'lib/actions/ai-quality-detection.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(AI_DETECTION_SYSTEM_PROMPT\)/,
  },
  // 15. quality_fix_options
  {
    agent: 'quality_fix_options',
    file: 'lib/quality/fix-engine.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(SYSTEM_PROMPT\)/,
  },
  // 16. migration_intelligence (extracted_patterns)
  {
    agent: 'migration_intelligence',
    file: 'lib/actions/migration-intelligence.ts',
    wrappedRegex: /systemPrompt:\s*withProvenanceGuidance\(EXTRACTION_SYSTEM_PROMPT\)/,
  },
]

describe('PR-A wiring — every agent callsite wraps systemPrompt with withProvenanceGuidance', () => {
  for (const c of CALLSITES) {
    it(`${c.agent} — ${c.file}`, () => {
      const src = read(c.file)
      expect(src, `Agent "${c.agent}" expected wrapped systemPrompt at ${c.file}`).toMatch(
        c.wrappedRegex,
      )
    })
  }
})

describe('PR-A wiring — no unwrapped systemPrompt callsites remain', () => {
  // Negative pin: this rejects the bare-constant form in any of the
  // adopting files. If a future PR adds a new agent and forgets the
  // wrapper, this lights up. The pattern intentionally lists every
  // tracked constant; adding a new agent requires adding to BOTH the
  // CALLSITES array above AND this list (forces the author to think
  // about wrapping).
  const FILES_TO_AUDIT = [
    'lib/ai/mapping-engine.ts',
    'lib/ai/single-agent-mapping.ts',
    'lib/actions/transformations.ts',
    'lib/actions/validation-rules.ts',
    'lib/actions/ai-quality-detection.ts',
    'lib/quality/fix-engine.ts',
    'lib/actions/migration-intelligence.ts',
    'lib/actions/mappings.ts',
  ]
  const TRACKED_CONSTANTS = [
    'MAPPING_GENERATION_SYSTEM_PROMPT',
    'MAPPING_GENERATION_AGENT_SYSTEM_PROMPT',
    'MAPPING_SUGGESTION_SYSTEM_PROMPT',
    'TRANSFORM_SYSTEM_PROMPT',
    'SUGGEST_SYSTEM_PROMPT',
    'AI_DETECTION_SYSTEM_PROMPT',
    'EXTRACTION_SYSTEM_PROMPT',
    'GENERATOR_SYSTEM_PROMPT',
    'CRITIC_SYSTEM_PROMPT',
    'CROSS_TABLE_SPECIALIST_SYSTEM_PROMPT',
    'CARDINALITY_SPECIALIST_SYSTEM_PROMPT',
    'SYSTEM_PROMPT', // fix-engine's local naming
  ]

  for (const file of FILES_TO_AUDIT) {
    it(`${file} — every constant systemPrompt usage is wrapped`, () => {
      const src = read(file)
      for (const constant of TRACKED_CONSTANTS) {
        // Reject `systemPrompt: <CONSTANT>` (no withProvenanceGuidance).
        // Whitespace variants between the colon and the constant are
        // tolerated; the constant must be at a word boundary.
        const bareForm = new RegExp(
          String.raw`systemPrompt:\s+\b${constant}\b(?!\s*\))`,
        )
        const match = src.match(bareForm)
        expect(
          match,
          `${file} contains an unwrapped \`systemPrompt: ${constant}\` — wrap it via withProvenanceGuidance(${constant})`,
        ).toBeNull()
      }
    })
  }
})

// ─── formatSchemaForPrompt — provenance flag emission gate ─────────────────

describe('PR-A wiring — formatSchemaForPrompt emits provenance flag conditionally', () => {
  const src = read('lib/ai/context-builder.ts')

  it('imports provenanceFlagFor + provenanceLabelsEnabled', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bprovenanceFlagFor\b[^}]*\bprovenanceLabelsEnabled\b[^}]*\}\s*from\s*['"]@\/lib\/ai\/agent-provenance-guidance['"]/,
    )
  })

  it('flag-OFF guard precedes the provenance-flag push (existing flag list byte-identical when flag is OFF)', () => {
    // The push lives inside an `if (provenanceLabelsEnabled())` block.
    // Without the guard, every formatSchemaForPrompt call would emit
    // a new flag — breaking heritage.
    expect(src).toMatch(
      /if\s*\(\s*provenanceLabelsEnabled\(\)\s*\)\s*\{[\s\S]{0,200}provenanceFlagFor\(/,
    )
  })

  it('default "inferred" case skips the push (cleaner prompts when no signal)', () => {
    // The conditional inside the gate skips empty strings so the
    // 'inferred' default does not pollute the flag list.
    expect(src).toMatch(/if\s*\(\s*provenanceFlag\s*\)\s*flagList\.push\(provenanceFlag\)/)
  })

  it('provenance flag goes to flagList (same channel as PK / FK / nullable)', () => {
    expect(src).toMatch(/flagList\.push\(provenanceFlag\)/)
  })
})
