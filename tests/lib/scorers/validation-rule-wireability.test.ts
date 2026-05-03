// @vitest-environment node
//
// Path 2 PR 1 — wireability sanity check for the existing
// `scoreValidationRuleStructural` (PR 17, never imported until now).
//
// The full per-axis matrix is covered by the scorer's own tests
// (tests/lib/eval-scorers/validation-rule.test.ts). This file pins the
// wireability surface that the eval runner depends on:
//
//   - The exported function name + types match what the runner imports
//   - A canonical valid input scores 1.0 (the runner's "did the
//     production code path work end-to-end" smoke depends on this)
//   - A null proposal scores 0 with all axes false (mirrors the
//     runner's "AI returned no rule" branch)

import { describe, it, expect } from 'vitest'

import {
  scoreValidationRuleStructural,
  type ProposedValidationRule,
  type GoldValidationRule,
} from '@/lib/eval/scorers/validation-rule'

describe('scoreValidationRuleStructural — wireability sanity (Path 2 PR 1)', () => {
  it('exports the expected function with the expected types', () => {
    expect(typeof scoreValidationRuleStructural).toBe('function')
  })

  it('canonical valid input scores 1.0', () => {
    const proposed: ProposedValidationRule = {
      rule_type: 'not_null',
      rule_config: {},
      field_id: 'fixture-field-uuid',
      severity: 'warning',
      name: 'Name not empty',
    }
    const gold: GoldValidationRule = {
      rule_type: 'not_null',
      rule_config: {},
      field_id: 'fixture-field-uuid',
      severity: 'warning',
      name: 'Name not empty',
    }
    const { score, details } = scoreValidationRuleStructural(proposed, gold)
    expect(score).toBeCloseTo(1.0, 4)
    expect(details.jsonValid).toBe(true)
    expect(details.ruleTypeMatch).toBe(true)
    expect(details.fieldMatch).toBe(true)
    expect(details.configKeysMatch).toBe(true)
    expect(details.configValuesMatch).toBe(true)
    expect(details.severityMatch).toBe(true)
  })

  it('null proposal scores 0 with all axes false', () => {
    const gold: GoldValidationRule = {
      rule_type: 'not_null',
      rule_config: {},
      field_id: 'fixture-field-uuid',
      severity: 'warning',
    }
    const { score, details } = scoreValidationRuleStructural(null, gold)
    expect(score).toBe(0)
    expect(details.jsonValid).toBe(false)
    expect(details.ruleTypeMatch).toBe(false)
    expect(details.fieldMatch).toBe(false)
    expect(details.configKeysMatch).toBe(false)
    expect(details.configValuesMatch).toBe(false)
    expect(details.severityMatch).toBe(false)
  })

  it('partial-match proposal scores per axis weights (jsonValid only)', () => {
    // Wrong rule_type, wrong field_id, mismatched config, mismatched
    // severity → only jsonValid = 0.30 should fire.
    const proposed: ProposedValidationRule = {
      rule_type: 'unique',
      rule_config: { unrelated: true },
      field_id: 'wrong-field-uuid',
      severity: 'blocking',
    }
    const gold: GoldValidationRule = {
      rule_type: 'not_null',
      rule_config: {},
      field_id: 'fixture-field-uuid',
      severity: 'warning',
    }
    const { score } = scoreValidationRuleStructural(proposed, gold)
    expect(score).toBeCloseTo(0.3, 4)
  })
})
