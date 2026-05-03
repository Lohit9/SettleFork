/**
 * Path 2 PR 2 B-2 — extracted-patterns structural scorer.
 *
 * Scores `extractMigrationIntelligence` raw `rawPatterns` output across
 * four axes (locked weights per Phase A §3):
 *
 *   - patternCountMet:           proposed.length >= gold.min_pattern_count    (weight 0.20)
 *   - categoryCorrectness:       fraction of patterns with a valid category    (weight 0.30)
 *   - canonicalPatternTypeUsage: fraction of patterns whose pattern_config
 *                                key (pattern_type / domain / system_type)
 *                                resolves to a key in ALL_CANONICAL_PATTERNS  (weight 0.30)
 *   - expectedCategoriesPresent: fraction of gold.expected_categories that
 *                                appear at least once in proposed             (weight 0.20)
 *
 * Total possible = 1.0. Pure: no I/O, no DB, deterministic.
 *
 * `canonicalPatternTypeUsage` is the load-bearing axis — it measures
 * whether the description-embedded canonical vocabulary actually shapes
 * the AI's output. By category, the canonical key lives in a different
 * pattern_config slot:
 *
 *   transformation_recipe / data_quality_pattern → pattern_config.pattern_type
 *   domain_knowledge                              → pattern_config.domain
 *   source_system_hint                            → pattern_config.system_type
 *
 * Patterns with an unknown category contribute 0 to this axis (they're
 * already penalized by categoryCorrectness, but double-counting an
 * obvious failure isn't unfair — it strengthens the gradient).
 */

import { ALL_CANONICAL_PATTERNS } from '@/lib/ai/canonical-patterns'
import type { ExtractedPattern } from '@/lib/actions/migration-intelligence'

// ─── Public input/output shapes ───────────────────────────────────────────────

export type ProposedExtractedPatterns = ExtractedPattern[]

export type GoldExtractedPatterns = {
  /** Minimum number of patterns the AI must produce. */
  min_pattern_count: number
  /**
   * Categories we expect to see at least once. Each must be one of the
   * 4 valid `category` enum values.
   */
  expected_categories: Array<
    'transformation_recipe' | 'data_quality_pattern' | 'domain_knowledge' | 'source_system_hint'
  >
}

const W_COUNT = 0.2
const W_CATEGORY = 0.3
const W_CANONICAL = 0.3
const W_EXPECTED_CATS = 0.2

const VALID_CATEGORIES = new Set([
  'transformation_recipe',
  'data_quality_pattern',
  'domain_knowledge',
  'source_system_hint',
])

const CANONICAL_KEYS = new Set(Object.keys(ALL_CANONICAL_PATTERNS))

export type ExtractedPatternsScoreDetails = {
  patternCountMet: boolean
  categoryCorrectness: number
  canonicalPatternTypeUsage: number
  expectedCategoriesPresent: number
  proposedCount: number
  validCategoryCount: number
  canonicalUsageCount: number
  matchedExpectedCategoryCount: number
  axisScores: {
    patternCountMet: number
    categoryCorrectness: number
    canonicalPatternTypeUsage: number
    expectedCategoriesPresent: number
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCanonicalSlot(p: ExtractedPattern): string | null {
  const cfg = (p.pattern_config ?? {}) as Record<string, unknown>
  switch (p.category) {
    case 'transformation_recipe':
    case 'data_quality_pattern': {
      const v = cfg.pattern_type
      return typeof v === 'string' ? v : null
    }
    case 'domain_knowledge': {
      const v = cfg.domain
      return typeof v === 'string' ? v : null
    }
    case 'source_system_hint': {
      const v = cfg.system_type
      return typeof v === 'string' ? v : null
    }
    default:
      return null
  }
}

// ─── Public scorer ────────────────────────────────────────────────────────────

export function scoreExtractedPatterns(
  proposed: ProposedExtractedPatterns,
  gold: GoldExtractedPatterns,
): { score: number; details: ExtractedPatternsScoreDetails } {
  const proposedSafe = Array.isArray(proposed) ? proposed : []
  const proposedCount = proposedSafe.length

  // Axis 1: patternCountMet
  const patternCountMet = proposedCount >= gold.min_pattern_count

  // Axis 2: categoryCorrectness
  let validCategoryCount = 0
  for (const p of proposedSafe) {
    if (VALID_CATEGORIES.has(p.category as string)) validCategoryCount++
  }
  const categoryCorrectness = proposedCount === 0 ? 0 : validCategoryCount / proposedCount

  // Axis 3: canonicalPatternTypeUsage
  let canonicalUsageCount = 0
  for (const p of proposedSafe) {
    const slot = getCanonicalSlot(p)
    if (slot !== null && CANONICAL_KEYS.has(slot)) canonicalUsageCount++
  }
  const canonicalPatternTypeUsage =
    proposedCount === 0 ? 0 : canonicalUsageCount / proposedCount

  // Axis 4: expectedCategoriesPresent — fraction of gold.expected_categories
  // that appear at least once in the proposal.
  const proposedCategorySet = new Set(proposedSafe.map((p) => p.category as string))
  const expectedCount = gold.expected_categories.length
  let matchedExpectedCategoryCount = 0
  for (const c of gold.expected_categories) {
    if (proposedCategorySet.has(c)) matchedExpectedCategoryCount++
  }
  const expectedCategoriesPresent =
    expectedCount === 0 ? 1 : matchedExpectedCategoryCount / expectedCount

  const axisScores = {
    patternCountMet: patternCountMet ? W_COUNT : 0,
    categoryCorrectness: categoryCorrectness * W_CATEGORY,
    canonicalPatternTypeUsage: canonicalPatternTypeUsage * W_CANONICAL,
    expectedCategoriesPresent: expectedCategoriesPresent * W_EXPECTED_CATS,
  }
  const score =
    axisScores.patternCountMet +
    axisScores.categoryCorrectness +
    axisScores.canonicalPatternTypeUsage +
    axisScores.expectedCategoriesPresent

  return {
    score,
    details: {
      patternCountMet,
      categoryCorrectness,
      canonicalPatternTypeUsage,
      expectedCategoriesPresent,
      proposedCount,
      validCategoryCount,
      canonicalUsageCount,
      matchedExpectedCategoryCount,
      axisScores,
    },
  }
}
