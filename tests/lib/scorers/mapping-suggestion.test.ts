// @vitest-environment node
//
// Path 2 PR 1 — unit tests for `scoreMappingSuggestion`.
//
// Pure-function tests; no I/O, no LLM calls. Mirrors the structural
// pattern of tests/lib/scorers/mapping.test.ts (existing). The scorer
// has 3 axes with weights 0.60 / 0.30 / 0.10; tests cover the
// canonical pass case, the per-axis fail isolation, the
// acceptable_alternatives path, and malformed-proposal handling.

import { describe, it, expect } from 'vitest'

import {
  scoreMappingSuggestion,
  type ProposedMappingSuggestion,
  type GoldMappingSuggestion,
} from '@/lib/eval/scorers/mapping-suggestion'

const VALID_RATIONALE = 'Direct semantic match between source and target.'

describe('scoreMappingSuggestion — canonical cases', () => {
  it('scores 1.0 on exact source match + correct combination_type + valid rationale', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['name'],
      combination_type: 'single',
      confidence: 95,
      rationale: VALID_RATIONALE,
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    const { score, details } = scoreMappingSuggestion(proposed, gold)
    expect(score).toBeCloseTo(1.0, 4)
    expect(details.matchedAlternative).toBe('expected')
    expect(details.sourceFieldsMatch).toBe(true)
    expect(details.combinationTypeMatch).toBe(true)
    expect(details.rationalePresent).toBe(true)
  })

  it('handles concat combinations with order-preserving comparison', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['first_name', 'last_name'],
      combination_type: 'concat_space',
      confidence: 80,
      rationale: 'Combine first and last name with a space separator.',
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['first_name', 'last_name'],
      expected_combination_type: 'concat_space',
    }
    expect(scoreMappingSuggestion(proposed, gold).score).toBeCloseTo(1.0, 4)
  })

  it('reverse concat order does NOT match gold (strict ordering)', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['last_name', 'first_name'],
      combination_type: 'concat_space',
      confidence: 80,
      rationale: VALID_RATIONALE,
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['first_name', 'last_name'],
      expected_combination_type: 'concat_space',
    }
    const { score, details } = scoreMappingSuggestion(proposed, gold)
    expect(details.sourceFieldsMatch).toBe(false)
    // 0 source + 0.30 combination + 0.10 rationale = 0.40
    expect(score).toBeCloseTo(0.4, 4)
  })
})

describe('scoreMappingSuggestion — per-axis fail isolation', () => {
  it('wrong source field: 0.30 + 0.10 = 0.40', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['email'],
      combination_type: 'single',
      confidence: 50,
      rationale: VALID_RATIONALE,
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(proposed, gold).score).toBeCloseTo(0.4, 4)
  })

  it('wrong combination_type: 0.60 + 0.10 = 0.70', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['name'],
      combination_type: 'concat_space',
      confidence: 70,
      rationale: VALID_RATIONALE,
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(proposed, gold).score).toBeCloseTo(0.7, 4)
  })

  it('rationale too short: 0.60 + 0.30 = 0.90', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['name'],
      combination_type: 'single',
      confidence: 90,
      rationale: 'short',
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    const { score, details } = scoreMappingSuggestion(proposed, gold)
    expect(details.rationalePresent).toBe(false)
    expect(score).toBeCloseTo(0.9, 4)
  })

  it('all axes wrong: score 0', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['email'],
      combination_type: 'concat_space',
      confidence: 50,
      rationale: 'short',
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(proposed, gold).score).toBe(0)
  })
})

describe('scoreMappingSuggestion — acceptable_alternatives', () => {
  it('matches an alternative when expected does not match', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['fname'],
      combination_type: 'single',
      confidence: 80,
      rationale: 'Alternative match used (fname is a synonym for first_name).',
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['first_name'],
      acceptable_alternatives: [['fname']],
      expected_combination_type: 'single',
    }
    const { score, details } = scoreMappingSuggestion(proposed, gold)
    expect(details.matchedAlternative).toBe('alt:0')
    expect(details.sourceFieldsMatch).toBe(true)
    expect(score).toBeCloseTo(1.0, 4)
  })

  it('matched-alternative index reflects which alt matched', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['display_name'],
      combination_type: 'single',
      confidence: 70,
      rationale: 'Display name carries the semantic meaning of the target.',
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['first_name'],
      acceptable_alternatives: [['fname'], ['display_name']],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(proposed, gold).details.matchedAlternative).toBe(
      'alt:1',
    )
  })

  it('returns matchedAlternative=null when neither expected nor alts match', () => {
    const proposed: ProposedMappingSuggestion = {
      source_field_names: ['email'],
      combination_type: 'single',
      confidence: 50,
      rationale: VALID_RATIONALE,
    }
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['first_name'],
      acceptable_alternatives: [['fname']],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(proposed, gold).details.matchedAlternative).toBe(null)
  })
})

describe('scoreMappingSuggestion — malformed proposals', () => {
  it('null proposal scores 0 with all axes false', () => {
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    const { score, details } = scoreMappingSuggestion(null, gold)
    expect(score).toBe(0)
    expect(details.sourceFieldsMatch).toBe(false)
    expect(details.combinationTypeMatch).toBe(false)
    expect(details.rationalePresent).toBe(false)
    expect(details.proposedSourceFieldNames).toEqual([])
  })

  it('proposal with non-array source_field_names is malformed', () => {
    const malformed = {
      source_field_names: 'name',
      combination_type: 'single',
      confidence: 90,
      rationale: VALID_RATIONALE,
    } as unknown as ProposedMappingSuggestion
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(malformed, gold).score).toBe(0)
  })

  it('proposal with invalid combination_type is malformed', () => {
    const malformed = {
      source_field_names: ['name'],
      combination_type: 'concat_dash',
      confidence: 90,
      rationale: VALID_RATIONALE,
    } as unknown as ProposedMappingSuggestion
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: ['name'],
      expected_combination_type: 'single',
    }
    expect(scoreMappingSuggestion(malformed, gold).score).toBe(0)
  })
})
