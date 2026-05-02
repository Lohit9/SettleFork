// @vitest-environment node
//
// Phase 1 PR 10.3 — validation-rule structural scorer tests.
//
// Pure-logic scorer; no mocks, no async. Each test pins:
//   - the score scalar (with toBeCloseTo for non-trivial values)
//   - all six axis booleans
//   - axisScores object where the per-axis contribution matters
//
// Severity literal values: 'blocking' | 'warning' (production schema
// at supabase/migrations/006_data_quality.sql:20). The PR 10.3 spec
// proposed 'error' | 'warning' but the scorer follows reality.

import { describe, it, expect } from 'vitest'
import {
  scoreValidationRuleStructural,
  type ProposedValidationRule,
  type GoldValidationRule,
} from '@/lib/eval/scorers/validation-rule'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const GOLD_BASE: GoldValidationRule = {
  rule_type: 'range',
  rule_config: { min: 0, max: 100 },
  field_id: 'field-uuid-001',
  severity: 'warning',
  name: 'Score must be 0-100',
}

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe('scoreValidationRuleStructural — perfect / null', () => {
  it('all-axes match: proposed === gold → score 1.0', () => {
    const result = scoreValidationRuleStructural({ ...GOLD_BASE }, GOLD_BASE)
    expect(result.score).toBe(1)
    expect(result.details.jsonValid).toBe(true)
    expect(result.details.ruleTypeMatch).toBe(true)
    expect(result.details.fieldMatch).toBe(true)
    expect(result.details.configKeysMatch).toBe(true)
    expect(result.details.configValuesMatch).toBe(true)
    expect(result.details.severityMatch).toBe(true)
    expect(result.details.axisScores).toEqual({
      jsonValid: 0.3,
      ruleTypeMatch: 0.25,
      fieldMatch: 0.2,
      configKeysMatch: 0.1,
      configValuesMatch: 0.1,
      severityMatch: 0.05,
    })
  })

  it('null proposed → score 0; jsonValid false; all others false', () => {
    const result = scoreValidationRuleStructural(null, GOLD_BASE)
    expect(result.score).toBe(0)
    expect(result.details.jsonValid).toBe(false)
    expect(result.details.ruleTypeMatch).toBe(false)
    expect(result.details.fieldMatch).toBe(false)
    expect(result.details.configKeysMatch).toBe(false)
    expect(result.details.configValuesMatch).toBe(false)
    expect(result.details.severityMatch).toBe(false)
    expect(result.details.axisScores.jsonValid).toBe(0)
  })
})

// ─── jsonValid short-circuit cases ────────────────────────────────────────────

describe('scoreValidationRuleStructural — malformed proposals', () => {
  it('missing rule_type → jsonValid false; score 0', () => {
    const proposed = { ...GOLD_BASE } as Partial<ProposedValidationRule>
    delete proposed.rule_type
    const result = scoreValidationRuleStructural(
      proposed as ProposedValidationRule,
      GOLD_BASE,
    )
    expect(result.score).toBe(0)
    expect(result.details.jsonValid).toBe(false)
  })

  it('missing field_id → jsonValid false; score 0', () => {
    const proposed = { ...GOLD_BASE } as Partial<ProposedValidationRule>
    delete proposed.field_id
    const result = scoreValidationRuleStructural(
      proposed as ProposedValidationRule,
      GOLD_BASE,
    )
    expect(result.score).toBe(0)
    expect(result.details.jsonValid).toBe(false)
  })

  it('missing severity → jsonValid false; score 0', () => {
    const proposed = { ...GOLD_BASE } as Partial<ProposedValidationRule>
    delete proposed.severity
    const result = scoreValidationRuleStructural(
      proposed as ProposedValidationRule,
      GOLD_BASE,
    )
    expect(result.score).toBe(0)
    expect(result.details.jsonValid).toBe(false)
  })

  it('severity is a string but not blocking/warning → jsonValid false', () => {
    // The schema CHECK constraint enforces this; a runtime AI proposal
    // with severity='error' is malformed even though it's a string.
    const proposed = { ...GOLD_BASE, severity: 'error' as 'blocking' }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.score).toBe(0)
    expect(result.details.jsonValid).toBe(false)
  })
})

// ─── Single-axis-wrong cases (each axis independently) ────────────────────────

describe('scoreValidationRuleStructural — one axis wrong at a time', () => {
  it('wrong rule_type only → 0.75 (lose 0.25)', () => {
    const proposed = { ...GOLD_BASE, rule_type: 'allowed_values' }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.score).toBeCloseTo(0.75, 6)
    expect(result.details.jsonValid).toBe(true)
    expect(result.details.ruleTypeMatch).toBe(false)
    expect(result.details.fieldMatch).toBe(true)
    expect(result.details.severityMatch).toBe(true)
  })

  it('wrong field_id only → 0.8 (lose 0.2)', () => {
    const proposed = { ...GOLD_BASE, field_id: 'field-uuid-OTHER' }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.score).toBeCloseTo(0.8, 6)
    expect(result.details.jsonValid).toBe(true)
    expect(result.details.ruleTypeMatch).toBe(true)
    expect(result.details.fieldMatch).toBe(false)
    expect(result.details.configValuesMatch).toBe(true)
  })

  it('wrong severity only → 0.95 (lose 0.05)', () => {
    const proposed = { ...GOLD_BASE, severity: 'blocking' as const }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.score).toBeCloseTo(0.95, 6)
    expect(result.details.severityMatch).toBe(false)
  })
})

// ─── rule_config axis cases ───────────────────────────────────────────────────

describe('scoreValidationRuleStructural — rule_config axes', () => {
  it('different config keys → configKeysMatch=false; configValuesMatch=false (gated); score 0.7', () => {
    const proposed = {
      ...GOLD_BASE,
      rule_config: { min: 1 }, // gold has {min: 0, max: 100}
    }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    // Lose 0.1 (configKeys) + 0.1 (configValues, gated) = 0.2 → score 0.8
    expect(result.score).toBeCloseTo(0.8, 6)
    expect(result.details.configKeysMatch).toBe(false)
    expect(result.details.configValuesMatch).toBe(false)
  })

  it('disjoint keys → configKeysMatch=false; score 0.8', () => {
    const proposed = {
      ...GOLD_BASE,
      rule_config: { foo: 1, bar: 2 }, // gold has {min, max}
    }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.score).toBeCloseTo(0.8, 6)
    expect(result.details.configKeysMatch).toBe(false)
    expect(result.details.configValuesMatch).toBe(false)
  })

  it('same keys, different values → configKeysMatch=true; configValuesMatch=false; score 0.9', () => {
    const proposed = {
      ...GOLD_BASE,
      rule_config: { min: 5, max: 100 }, // gold min=0
    }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.score).toBeCloseTo(0.9, 6)
    expect(result.details.configKeysMatch).toBe(true)
    expect(result.details.configValuesMatch).toBe(false)
  })

  it('both empty rule_config → configKeysMatch=true, configValuesMatch=true; score 1.0', () => {
    const empty = { ...GOLD_BASE, rule_config: {} }
    const result = scoreValidationRuleStructural(empty, empty)
    expect(result.score).toBe(1)
    expect(result.details.configKeysMatch).toBe(true)
    expect(result.details.configValuesMatch).toBe(true)
  })

  it('rule_config is an array (wrong shape) → configKeysMatch=false; score 0.8', () => {
    // Per the PR 10.3 §3 'different shape' edge-case: top-level fields
    // exist so jsonValid=true, but the config keys won't match.
    const proposed = {
      ...GOLD_BASE,
      rule_config: ['min', 'max'] as unknown as Record<string, unknown>,
    }
    const result = scoreValidationRuleStructural(proposed, GOLD_BASE)
    expect(result.details.jsonValid).toBe(true)
    expect(result.details.configKeysMatch).toBe(false)
    expect(result.details.configValuesMatch).toBe(false)
    expect(result.score).toBeCloseTo(0.8, 6)
  })
})

// ─── Case-sensitivity + nested + array values ─────────────────────────────────

describe('scoreValidationRuleStructural — string equality + nested + arrays', () => {
  it('case-sensitivity: "Regex" vs "regex" → ruleTypeMatch=false', () => {
    // Strict equality — AI's job is to produce the canonical rule_type
    // string. If Phase 2 evidence shows AI consistently inflects case,
    // a normalization pass can be added; for now we surface the disagreement.
    const gold = { ...GOLD_BASE, rule_type: 'regex' }
    const proposed = { ...gold, rule_type: 'Regex' }
    const result = scoreValidationRuleStructural(proposed, gold)
    expect(result.details.ruleTypeMatch).toBe(false)
    expect(result.score).toBeCloseTo(0.75, 6)
  })

  it('nested config values that match → configValuesMatch=true', () => {
    const gold = {
      ...GOLD_BASE,
      rule_type: 'custom_sql',
      rule_config: { bounds: { min: 1 } },
    }
    const proposed = {
      ...gold,
      rule_config: { bounds: { min: 1 } },
    }
    const result = scoreValidationRuleStructural(proposed, gold)
    expect(result.score).toBe(1)
    expect(result.details.configValuesMatch).toBe(true)
  })

  it('nested config values that differ → configKeysMatch=true, configValuesMatch=false; score 0.9', () => {
    const gold = {
      ...GOLD_BASE,
      rule_type: 'custom_sql',
      rule_config: { bounds: { min: 1 } },
    }
    const proposed = {
      ...gold,
      rule_config: { bounds: { min: 2 } }, // nested diff
    }
    const result = scoreValidationRuleStructural(proposed, gold)
    expect(result.score).toBeCloseTo(0.9, 6)
    expect(result.details.configKeysMatch).toBe(true)
    expect(result.details.configValuesMatch).toBe(false)
  })

  it('array config values, same order → configValuesMatch=true', () => {
    const gold = {
      ...GOLD_BASE,
      rule_type: 'allowed_values',
      rule_config: { allowed: ['a', 'b'] },
    }
    const proposed = {
      ...gold,
      rule_config: { allowed: ['a', 'b'] },
    }
    const result = scoreValidationRuleStructural(proposed, gold)
    expect(result.score).toBe(1)
    expect(result.details.configValuesMatch).toBe(true)
  })

  it('array config values, different order → configValuesMatch=false (strict ordering)', () => {
    // Per the PR 10.3 §3 + the deepEqual docstring: array order is
    // significant. Recommendation documented in code; pinned here.
    const gold = {
      ...GOLD_BASE,
      rule_type: 'allowed_values',
      rule_config: { allowed: ['a', 'b'] },
    }
    const proposed = {
      ...gold,
      rule_config: { allowed: ['b', 'a'] },
    }
    const result = scoreValidationRuleStructural(proposed, gold)
    expect(result.details.configKeysMatch).toBe(true)
    expect(result.details.configValuesMatch).toBe(false)
    expect(result.score).toBeCloseTo(0.9, 6)
  })
})
