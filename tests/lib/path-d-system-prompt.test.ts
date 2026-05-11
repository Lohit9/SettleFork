// @vitest-environment node
//
// Path D system-prompt + user-message builder tests.
//
// INF-41: regression guard for the buildPathDUserMessage intelligence
// forwarding contract. Pre-INF-41, the production call site at
// path-d-mapping.ts:251 invoked `buildPathDUserMessage({ ctx })` —
// dropping the optional intelligenceCtx arg silently — even though
// buildAIContext was correctly populating ctx.intelligence_context
// upstream. The context-flow audit (PR #107) flagged this. This file
// pins the BUILDER's contract: when intelligenceCtx is provided, the
// rendered prompt contains it; when omitted/empty/null, the prompt
// contains no intelligence block.
//
// Companion call-site forwarding test lives in
// tests/lib/path-d-mapping.test.ts — see "INF-41 regression guard"
// describe-it blocks at the bottom of that file.

import { describe, it, expect } from 'vitest'
import { buildPathDUserMessage } from '@/lib/ai/path-d-system-prompt'
import type { ProjectAIContext } from '@/lib/ai/context-builder'

function emptyCtx(overrides: Partial<ProjectAIContext> = {}): ProjectAIContext {
  return {
    project_id: 'eval-test-project',
    project_name: 'INF-41 Test',
    source_tables: [],
    target_tables: [],
    documents: {
      source_documents: [],
      target_documents: [],
      business_context_documents: [],
      poc_answer_key: null,
    },
    intelligence_context: '',
    poc_template: null,
    ...overrides,
  }
}

describe('buildPathDUserMessage — INF-41 intelligence forwarding contract', () => {
  it('positive — when intelligenceCtx is provided, the marker appears in the rendered prompt', () => {
    const MARKER = 'INF_41_BUILDER_MARKER_xyz123'
    const out = buildPathDUserMessage({
      ctx: emptyCtx(),
      intelligenceCtx: MARKER,
    })
    expect(out).toContain(MARKER)
  })

  it('positive — multi-paragraph intelligenceCtx is preserved verbatim (not truncated, not reformatted)', () => {
    const MARKER = [
      '## Migration Intelligence (Reference Only — Do Not Copy Directly)',
      '',
      '★★★ Lead status enum normalization (confirmed in 3 migrations)',
      'Recipe: lowercase + map via picklist normalization, surface decision for any value not in documented allowed list.',
      '',
      '★★ Email canonicalization (seen in 2 migrations)',
      'Lowercase + trim before hashing for dedup keys.',
    ].join('\n')
    const out = buildPathDUserMessage({
      ctx: emptyCtx(),
      intelligenceCtx: MARKER,
    })
    expect(out).toContain(MARKER)
    expect(out).toContain('Lead status enum normalization')
    expect(out).toContain('Email canonicalization')
  })

  it('negative — when intelligenceCtx is omitted, no intelligence block renders', () => {
    // The pre-INF-41 production call site shape — only `{ ctx }` passed.
    // Since `intelligenceCtx` is optional with no default, the builder's
    // ternary `intelligenceCtx ? ... : ''` falls through to empty. Pin
    // that the rendered prompt does NOT contain typical intelligence-
    // block tokens that would indicate an unintended leak.
    const out = buildPathDUserMessage({ ctx: emptyCtx() })
    expect(out).not.toContain('Migration Intelligence')
    expect(out).not.toContain('★★★')
    expect(out).not.toContain('★★')
  })

  it('negative — when intelligenceCtx is null, builder treats it as absent (no leak)', () => {
    const out = buildPathDUserMessage({ ctx: emptyCtx(), intelligenceCtx: null })
    expect(out).not.toContain('Migration Intelligence')
    expect(out).not.toContain('★★★')
  })

  it('negative — when intelligenceCtx is empty string, builder treats it as absent', () => {
    // Empty string is falsy in the builder's ternary — same end-state as
    // null/undefined. Pin this so a future refactor that switches to
    // `intelligenceCtx != null` (non-falsy guard) doesn't accidentally
    // emit an empty intelligence block followed by `\n\n`, which would
    // shift prompt bytes and invalidate the v0 baseline.
    const out = buildPathDUserMessage({ ctx: emptyCtx(), intelligenceCtx: '' })
    expect(out).not.toContain('Migration Intelligence')
  })
})
