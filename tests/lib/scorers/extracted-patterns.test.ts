// @vitest-environment node
//
// Path 2 PR 2 B-2 — unit tests for `scoreExtractedPatterns`.
//
// Pure-function tests; no I/O, no LLM calls. The scorer has 4 axes
// with weights 0.20 / 0.30 / 0.30 / 0.20; tests cover canonical pass,
// the load-bearing canonicalPatternTypeUsage axis (incl. adversarial
// "all unknown pattern_types"), and category-correctness fail.

import { describe, it, expect } from 'vitest'

import {
  scoreExtractedPatterns,
  type ProposedExtractedPatterns,
  type GoldExtractedPatterns,
} from '@/lib/eval/scorers/extracted-patterns'

function txPattern(pattern_type: string) {
  return {
    category: 'transformation_recipe' as const,
    title: 't',
    pattern_description: 'd',
    pattern_config: { pattern_type },
    tags: ['x'],
  }
}

function dqPattern(pattern_type: string) {
  return {
    category: 'data_quality_pattern' as const,
    title: 't',
    pattern_description: 'd',
    pattern_config: { pattern_type },
    tags: ['x'],
  }
}

function dkPattern(domain: string) {
  return {
    category: 'domain_knowledge' as const,
    title: 't',
    pattern_description: 'd',
    pattern_config: { domain },
    tags: ['x'],
  }
}

function ssPattern(system_type: string) {
  return {
    category: 'source_system_hint' as const,
    title: 't',
    pattern_description: 'd',
    pattern_config: { system_type },
    tags: ['x'],
  }
}

describe('scoreExtractedPatterns — canonical', () => {
  it('scores 1.0 when count met, all categories valid, all canonical, all expected categories present', () => {
    const proposed: ProposedExtractedPatterns = [
      txPattern('currency_cleanup'),
      dqPattern('null_violation'),
      dkPattern('entity_relationship_model'),
    ]
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 3,
      expected_categories: ['transformation_recipe', 'data_quality_pattern'],
    }
    const { score, details } = scoreExtractedPatterns(proposed, gold)
    expect(details.patternCountMet).toBe(true)
    expect(details.categoryCorrectness).toBe(1)
    expect(details.canonicalPatternTypeUsage).toBe(1)
    expect(details.expectedCategoriesPresent).toBe(1)
    expect(score).toBeCloseTo(1.0, 4)
  })
})

describe('scoreExtractedPatterns — adversarial canonical-usage', () => {
  it('all 8 patterns with ad-hoc made-up pattern_types → canonicalPatternTypeUsage = 0', () => {
    const proposed: ProposedExtractedPatterns = Array.from({ length: 8 }, () =>
      txPattern('ad_hoc_made_up'),
    )
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 5,
      expected_categories: ['transformation_recipe'],
    }
    const { details } = scoreExtractedPatterns(proposed, gold)
    expect(details.canonicalPatternTypeUsage).toBe(0)
    expect(details.canonicalUsageCount).toBe(0)
  })

  it('source_system_hint with non-canonical system_type contributes 0 to canonical axis', () => {
    const proposed: ProposedExtractedPatterns = [ssPattern('completely_invented')]
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 1,
      expected_categories: ['source_system_hint'],
    }
    const { details } = scoreExtractedPatterns(proposed, gold)
    expect(details.canonicalPatternTypeUsage).toBe(0)
  })
})

describe('scoreExtractedPatterns — category correctness', () => {
  it('all patterns with invalid category → categoryCorrectness = 0', () => {
    const proposed = [
      {
        category: 'invalid_category' as unknown as ProposedExtractedPatterns[number]['category'],
        title: 't',
        pattern_description: 'd',
        pattern_config: { pattern_type: 'currency_cleanup' },
        tags: ['x'],
      },
    ]
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 1,
      expected_categories: [],
    }
    const { details } = scoreExtractedPatterns(proposed, gold)
    expect(details.categoryCorrectness).toBe(0)
  })

  it('mixed valid/invalid categories: categoryCorrectness reflects fraction', () => {
    const proposed: ProposedExtractedPatterns = [
      txPattern('currency_cleanup'),
      {
        category: 'bogus' as unknown as ProposedExtractedPatterns[number]['category'],
        title: 't',
        pattern_description: 'd',
        pattern_config: { pattern_type: 'currency_cleanup' },
        tags: ['x'],
      },
    ]
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 1,
      expected_categories: [],
    }
    const { details } = scoreExtractedPatterns(proposed, gold)
    expect(details.categoryCorrectness).toBe(0.5)
  })
})

describe('scoreExtractedPatterns — edge cases', () => {
  it('empty proposals: count not met, both correctness axes 0, expected-categories vacuously 1', () => {
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 1,
      expected_categories: [],
    }
    const { details } = scoreExtractedPatterns([], gold)
    expect(details.patternCountMet).toBe(false)
    expect(details.categoryCorrectness).toBe(0)
    expect(details.canonicalPatternTypeUsage).toBe(0)
    expect(details.expectedCategoriesPresent).toBe(1)
  })

  it('count below minimum → patternCountMet = false, other axes still computed', () => {
    const proposed: ProposedExtractedPatterns = [txPattern('currency_cleanup')]
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 5,
      expected_categories: ['transformation_recipe'],
    }
    const { details } = scoreExtractedPatterns(proposed, gold)
    expect(details.patternCountMet).toBe(false)
    expect(details.categoryCorrectness).toBe(1)
    expect(details.canonicalPatternTypeUsage).toBe(1)
    expect(details.expectedCategoriesPresent).toBe(1)
  })

  it('expected category not present in proposed: expectedCategoriesPresent < 1', () => {
    const proposed: ProposedExtractedPatterns = [txPattern('currency_cleanup')]
    const gold: GoldExtractedPatterns = {
      min_pattern_count: 1,
      expected_categories: ['transformation_recipe', 'data_quality_pattern'],
    }
    const { details } = scoreExtractedPatterns(proposed, gold)
    expect(details.expectedCategoriesPresent).toBe(0.5)
  })
})
