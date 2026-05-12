// @vitest-environment node
//
// Unit tests for formatPocAnswerKeyBlock. Verifies the helper byte-matches
// Path D's bespoke inlining at path-d-system-prompt.ts:672-684 — Path D
// migration to call the shared helper is a follow-up (see notes/follow-ups.md).

import { describe, it, expect } from 'vitest'
import { formatPocAnswerKeyBlock } from '@/lib/ai/context-builder'

describe('formatPocAnswerKeyBlock', () => {
  it('returns empty string when key is null (universal case)', () => {
    expect(formatPocAnswerKeyBlock(null)).toBe('')
  })

  it('returns empty string when key is empty string', () => {
    expect(formatPocAnswerKeyBlock('')).toBe('')
  })

  it('wraps a populated key in <poc_answer_key authoritative="true"> tags', () => {
    const key = '# Rootstock POC\n\nDivision: DIV1\nEngineer: ENG-100'
    const out = formatPocAnswerKeyBlock(key)
    expect(out).toContain('<poc_answer_key authoritative="true">')
    expect(out).toContain('takes precedence over general')
    expect(out).toContain(key)
    expect(out).toContain('</poc_answer_key>')
  })

  it('byte-matches Path D inlining shape', () => {
    // Path D template — lib/ai/path-d-system-prompt.ts:672-684. If this
    // snapshot diverges, Path D's bespoke inlining needs to be updated in
    // lockstep (or migrated to call this helper — see follow-ups).
    const key = '<TEMPLATE_BODY>'
    const out = formatPocAnswerKeyBlock(key)
    expect(out).toBe(`<poc_answer_key authoritative="true">
The following project-specific answer key takes precedence over general
guidance in the system prompt and any earlier document blocks. Generate
mapping output (target_field_mappings, mapping_sources, project_decisions,
project_lookup_tables, project_data_quality_issues, target_field_coverage,
project_inferred_targets, project_notes) matching this specification.

${key}
</poc_answer_key>`)
  })

  it('passes through markdown / XML in the key without escaping', () => {
    // The POC answer key is authoritative content. Escaping its angle brackets
    // would mangle XML examples and markdown the LLM is meant to read literally.
    const key = 'Section: <foo>\n- bullet & ampersand\n- code: `<bar/>`'
    const out = formatPocAnswerKeyBlock(key)
    expect(out).toContain('<foo>')
    expect(out).toContain('& ampersand')
    expect(out).toContain('<bar/>')
  })
})
