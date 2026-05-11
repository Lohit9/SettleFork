// @vitest-environment node
//
// Unit tests for the Rootstock POC token-substitution helper.
//
// applyPocOverrides is the read-time bridge between the JSONB column
// `projects.poc_overrides` and the answer-key markdown stored in
// `schema_documents` (doc_type='poc_answer_key'). The five cases below
// pin the contract documented in Stop 0 Task 2:
//
//   POC1.  Empty overrides → template returned unchanged (cheap fast-path
//          taken by every flag-OFF read, and by flag-ON projects whose
//          overrides JSONB is the default '{}'::jsonb).
//   POC2.  Single substitution → exactly one {{key}} is rewritten.
//   POC3.  Multiple substitutions → every {{key}} in the template is
//          rewritten in a single pass.
//   POC4.  Missing key → {{token}} is left INTACT (not silently dropped).
//          Silent loss would let a typo in the overrides JSONB ship a
//          broken answer key to the model with no detectable signal.
//   POC5.  Non-string value → coerced via String(). Mirrors the JSONB
//          column contract: numbers, booleans, and stringy values all
//          land here as raw JS values after Supabase parses them.
//
// Sunset: INF-73 — this whole file goes away with the helper.

import { describe, it, expect } from 'vitest'
import { applyPocOverrides } from '@/lib/ai/poc-overrides'

describe('applyPocOverrides', () => {
  // POC1
  it('returns the template unchanged when overrides is empty', () => {
    const template = 'Hello {{name}}, the engineer is {{engineer}}.'
    expect(applyPocOverrides(template, {})).toBe(template)
  })

  // POC2
  it('substitutes a single {{key}} placeholder', () => {
    const template = 'Division external id is {{division_external_id}}.'
    const result = applyPocOverrides(template, {
      division_external_id: 'DIV1',
    })
    expect(result).toBe('Division external id is DIV1.')
  })

  // POC3
  it('substitutes every {{key}} placeholder in one pass', () => {
    const template = [
      'Division: {{division_external_id}}',
      'Engineer: {{responsible_engineer}}',
      'Planner: {{responsible_planner}}',
      'Buyer: {{responsible_buyer}}',
      'Org/Dept: {{org_department}}',
    ].join('\n')
    const result = applyPocOverrides(template, {
      division_external_id: 'DIV1',
      responsible_engineer: '1990',
      responsible_planner: '1990',
      responsible_buyer: '1990',
      org_department: 'DIV1_Org-Dept1',
    })
    expect(result).toBe(
      [
        'Division: DIV1',
        'Engineer: 1990',
        'Planner: 1990',
        'Buyer: 1990',
        'Org/Dept: DIV1_Org-Dept1',
      ].join('\n'),
    )
  })

  // POC4 — Missing keys must remain visible as `{{token}}` in the rendered
  // markdown so a typo or omission in the overrides JSONB surfaces in the
  // next llm_calls.user_message inspection rather than silently shipping a
  // half-baked answer key to the model.
  it('leaves missing-key placeholders intact (no silent data loss)', () => {
    const template = 'Known: {{present}}. Unknown: {{missing}}.'
    const result = applyPocOverrides(template, { present: 'yes' })
    expect(result).toBe('Known: yes. Unknown: {{missing}}.')
  })

  // POC5 — JSONB round-trips numbers + booleans as raw JS values; the
  // helper accepts a `Record<string, unknown>` and coerces every emitted
  // value via String(). The {{flag}} → "true" path is the case that
  // motivates the test: a boolean override would otherwise stringify as
  // "[object Object]" or similar.
  it('coerces non-string override values via String()', () => {
    const template = 'count={{count}}, flag={{flag}}'
    const result = applyPocOverrides(template, { count: 42, flag: true })
    expect(result).toBe('count=42, flag=true')
  })
})
