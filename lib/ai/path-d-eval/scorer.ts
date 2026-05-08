/**
 * Path D eval scorer — pure function over (actual, expected) pairs.
 *
 * Eight scoring dimensions, weighted aggregate, per-dimension details.
 * No I/O, no DB, no LLM. Deterministic — same inputs → same outputs.
 *
 * Scoring philosophy:
 *   - Hard scoring on structural fields (UUIDs, status enums,
 *     combination_type, decision_type, category names). Free-text
 *     fields (ai_reasoning, transformation_intent, description) are
 *     intentionally NOT scored — they're for human review.
 *   - F1 (precision + recall) for sets where extras are wrong:
 *     mapping_accuracy, coverage_completeness.
 *   - Recall-only for sets where extras are valuable: decisions,
 *     lookup tables, DQ findings, inferred_targets. Path D's value
 *     is partly in surfacing judgment opportunities; punishing
 *     extras would punish exactly the behaviour we want.
 *
 * See `types.ts` for dimension definitions and default weights.
 */

import type { PathDParsedOutput } from '@/lib/ai/path-d-parser'
import {
  DEFAULT_WEIGHTS,
  type DimensionScore,
  type EvalDimensionKey,
  type EvalScore,
  type EvalWeights,
  type ExpectedCoverageEntry,
  type ExpectedDataQualityFinding,
  type ExpectedDecision,
  type ExpectedInferredTarget,
  type ExpectedLookupTable,
  type ExpectedMapping,
  type ExpectedPathDOutput,
} from '@/lib/ai/path-d-eval/types'

// ── F1 helper (shared by mapping_accuracy + coverage_completeness) ─────────

interface F1Result {
  precision: number
  recall: number
  f1: number
  matched: number
  missed: number
  extra: number
}

/**
 * F1 over two sets of comparable string keys.
 *
 * Edge cases:
 *   - Both empty → 1.0 (perfect "nothing to predict, nothing predicted")
 *   - Empty proposed, non-empty expected → recall 0 → F1 0
 *   - Non-empty proposed, empty expected → precision 0 → F1 0
 */
function f1OverKeys(proposedKeys: Set<string>, expectedKeys: Set<string>): F1Result {
  const bothEmpty = proposedKeys.size === 0 && expectedKeys.size === 0
  if (bothEmpty) {
    return { precision: 1, recall: 1, f1: 1, matched: 0, missed: 0, extra: 0 }
  }

  let matched = 0
  let missed = 0
  let extra = 0
  for (const k of expectedKeys) {
    if (proposedKeys.has(k)) matched++
    else missed++
  }
  for (const k of proposedKeys) {
    if (!expectedKeys.has(k)) extra++
  }

  const precDenom = matched + extra
  const recDenom = matched + missed
  const precision = precDenom === 0 ? 0 : matched / precDenom
  const recall = recDenom === 0 ? 0 : matched / recDenom
  const f1Denom = precision + recall
  const f1 = f1Denom === 0 ? 0 : (2 * precision * recall) / f1Denom

  return { precision, recall, f1, matched, missed, extra }
}

// ── Recall helper (shared by decisions/lookup/DQ/inferred_targets) ─────────

interface RecallResult {
  recall: number
  matched: number
  missed: number
  extra: number
}

function recallOverKeys(
  proposedKeys: Set<string>,
  expectedKeys: Set<string>,
): RecallResult {
  if (expectedKeys.size === 0) {
    // No expectations → vacuously perfect recall. Extras don't count.
    return { recall: 1, matched: 0, missed: 0, extra: proposedKeys.size }
  }
  let matched = 0
  for (const k of expectedKeys) {
    if (proposedKeys.has(k)) matched++
  }
  const missed = expectedKeys.size - matched
  const extra = Math.max(0, proposedKeys.size - matched)
  return { recall: matched / expectedKeys.size, matched, missed, extra }
}

// ── Section-key extractors ─────────────────────────────────────────────────

/**
 * Mapping accuracy key: target_field_id + sorted source_field_ids,
 * joined by `::` and `|`. Ensures `[a, b]` and `[b, a]` map to the
 * same key (set semantics on source_field_ids).
 */
function mappingKey(m: { target_field_id: string; source_field_ids: string[] }): string {
  const sorted = [...m.source_field_ids].sort()
  return `${m.target_field_id}::${sorted.join('|')}`
}

function coverageKey(c: { target_field_id: string; coverage_status: string }): string {
  return `${c.target_field_id}::${c.coverage_status}`
}

function decisionKey(d: { decision_type: string }): string {
  return d.decision_type.toLowerCase().trim()
}

function lookupKey(l: { name: string }): string {
  return l.name.toLowerCase().trim()
}

function dqKey(d: { source_field_id: string | null; category: string }): string {
  return `${d.source_field_id ?? '<cross-field>'}::${d.category.toLowerCase().trim()}`
}

function inferredKey(t: { inferred_target_object: string }): string {
  return t.inferred_target_object.toLowerCase().trim()
}

// ── Per-dimension scorers ──────────────────────────────────────────────────

function scoreMappingAccuracy(
  actualMappings: Array<{ target_field_id: string; source_field_ids: string[] }>,
  expectedMappings: ExpectedMapping[],
): DimensionScore {
  const proposed = new Set(actualMappings.map(mappingKey))
  const expected = new Set(expectedMappings.map(mappingKey))
  const f1 = f1OverKeys(proposed, expected)
  return {
    score: f1.f1,
    details: { ...f1, proposedCount: proposed.size, expectedCount: expected.size },
  }
}

function scoreCombinationType(
  actualMappings: Array<{
    target_field_id: string
    source_field_ids: string[]
    combination_type: string
  }>,
  expectedMappings: ExpectedMapping[],
): DimensionScore {
  // For each expected mapping that the actual matches on
  // (target_field_id + source_field_ids), check whether
  // combination_type matches. Score = matched / matchedMappingCount.
  const expectedByKey = new Map(
    expectedMappings.map((m) => [mappingKey(m), m.combination_type]),
  )
  let comparable = 0
  let combinationMatched = 0
  for (const a of actualMappings) {
    const expectedType = expectedByKey.get(mappingKey(a))
    if (expectedType === undefined) continue
    comparable++
    if (a.combination_type === expectedType) combinationMatched++
  }
  if (comparable === 0) {
    // No mappings overlapped — combination_type is vacuously correct
    // (we never had a chance to check). Returning 1 here would be
    // misleading; we return 0 only if expectations existed but
    // nothing matched. If both sides are empty, it's a 1.
    if (expectedMappings.length === 0 && actualMappings.length === 0) {
      return { score: 1, details: { matched: 0, comparable: 0, note: 'both empty' } }
    }
    return {
      score: 0,
      details: {
        matched: 0,
        comparable: 0,
        note: 'no overlap on (target_field_id, source_field_ids); combination_type incomparable',
      },
    }
  }
  return {
    score: combinationMatched / comparable,
    details: {
      matched: combinationMatched,
      comparable,
      ratio: combinationMatched / comparable,
    },
  }
}

function scoreCoverageCompleteness(
  actualCoverage: Array<{ target_field_id: string; coverage_status: string }>,
  expectedCoverage: ExpectedCoverageEntry[],
): DimensionScore {
  const proposed = new Set(actualCoverage.map(coverageKey))
  const expected = new Set(expectedCoverage.map(coverageKey))
  const f1 = f1OverKeys(proposed, expected)
  return {
    score: f1.f1,
    details: { ...f1, proposedCount: proposed.size, expectedCount: expected.size },
  }
}

function scoreDecisionRecall(
  actualDecisions: Array<{ decision_type: string }>,
  expectedDecisions: ExpectedDecision[],
): DimensionScore {
  const proposed = new Set(actualDecisions.map(decisionKey))
  const expected = new Set(expectedDecisions.map(decisionKey))
  const r = recallOverKeys(proposed, expected)
  return { score: r.recall, details: { ...r } }
}

function scoreLookupRecall(
  actualLookups: Array<{ name: string }>,
  expectedLookups: ExpectedLookupTable[],
): DimensionScore {
  const proposed = new Set(actualLookups.map(lookupKey))
  const expected = new Set(expectedLookups.map(lookupKey))
  const r = recallOverKeys(proposed, expected)
  return { score: r.recall, details: { ...r } }
}

function scoreDqRecall(
  actualDq: ReadonlyArray<{
    source_field_id?: string | null
    category: string
  }>,
  expectedDq: ExpectedDataQualityFinding[],
): DimensionScore {
  const normalised = actualDq.map((d) => ({
    source_field_id: d.source_field_id ?? null,
    category: d.category,
  }))
  const proposed = new Set(normalised.map(dqKey))
  const expected = new Set(expectedDq.map(dqKey))
  const r = recallOverKeys(proposed, expected)
  return { score: r.recall, details: { ...r } }
}

function scoreInferredTargetsRecall(
  actualInferred: Array<{ inferred_target_object: string }>,
  expectedInferred: ExpectedInferredTarget[],
): DimensionScore {
  const proposed = new Set(actualInferred.map(inferredKey))
  const expected = new Set(expectedInferred.map(inferredKey))
  const r = recallOverKeys(proposed, expected)
  return { score: r.recall, details: { ...r } }
}

function scoreOutputCompleteness(
  actual: PathDParsedOutput,
  expected: ExpectedPathDOutput,
): DimensionScore {
  // Score = fraction of 7 sections that returned `parsed_ok`. Each
  // missing-or-failed section drops the score by 1/7. project_notes
  // is included in the count when the fixture expects it (almost
  // always true).
  const sectionStatuses: Array<[string, 'parsed_ok' | 'parse_error' | 'missing']> = [
    ['mappings', actual.mappings.status],
    ['coverage', actual.coverage.status],
    ['decisions', actual.decisions.status],
    ['lookup_tables', actual.lookup_tables.status],
    ['data_quality', actual.data_quality.status],
    ['inferred_targets', actual.inferred_targets.status],
    ['project_notes', actual.project_notes.status],
  ]
  // If the fixture explicitly does NOT expect project_notes, drop it
  // from the denominator so the section absence isn't penalised.
  const denominator = expected.project_notes_expected
    ? 7
    : sectionStatuses.length - 1
  const sections = expected.project_notes_expected
    ? sectionStatuses
    : sectionStatuses.filter(([name]) => name !== 'project_notes')
  const okCount = sections.filter(([, s]) => s === 'parsed_ok').length
  return {
    score: denominator === 0 ? 1 : okCount / denominator,
    details: {
      sectionsOk: okCount,
      sectionsTotal: denominator,
      perSection: Object.fromEntries(sections),
    },
  }
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Score a Path D run against a fixture's expected output.
 *
 * Returns per-dimension scores + the weighted aggregate. Always
 * succeeds — even if a section is missing or parse-errored on the
 * actual side, that dimension just scores 0 (or whatever the
 * dimension's empty-side semantics dictate).
 *
 * @param actual    The orchestrator's parsed output (PathDParsedOutput).
 * @param expected  The fixture's gold-standard ExpectedPathDOutput.
 * @param weights   Optional weight override; must sum to 1.0 to be
 *                  comparable across runs. Defaults to DEFAULT_WEIGHTS.
 */
export function scorePathDOutput(
  actual: PathDParsedOutput,
  expected: ExpectedPathDOutput,
  weights: EvalWeights = { ...DEFAULT_WEIGHTS },
): EvalScore {
  // Pull section data with fallback to empty arrays when a section is
  // missing or parse_error. Missing-data short-circuits to score=0 for
  // F1 dimensions and recall=1 for recall dimensions (vacuously
  // perfect when expected is also empty; see helpers).
  const actualMappings =
    actual.mappings.status === 'parsed_ok' ? actual.mappings.data : []
  const actualCoverage =
    actual.coverage.status === 'parsed_ok' ? actual.coverage.data : []
  const actualDecisions =
    actual.decisions.status === 'parsed_ok' ? actual.decisions.data : []
  const actualLookups =
    actual.lookup_tables.status === 'parsed_ok' ? actual.lookup_tables.data : []
  const actualDq =
    actual.data_quality.status === 'parsed_ok' ? actual.data_quality.data : []
  const actualInferred =
    actual.inferred_targets.status === 'parsed_ok'
      ? actual.inferred_targets.data
      : []

  const dimensions: Record<EvalDimensionKey, DimensionScore> = {
    mapping_accuracy: scoreMappingAccuracy(actualMappings, expected.mappings),
    combination_type: scoreCombinationType(actualMappings, expected.mappings),
    coverage_completeness: scoreCoverageCompleteness(actualCoverage, expected.coverage),
    decision_recall: scoreDecisionRecall(actualDecisions, expected.decisions),
    lookup_recall: scoreLookupRecall(actualLookups, expected.lookup_tables),
    dq_recall: scoreDqRecall(actualDq, expected.data_quality),
    inferred_targets_recall: scoreInferredTargetsRecall(
      actualInferred,
      expected.inferred_targets,
    ),
    output_completeness: scoreOutputCompleteness(actual, expected),
  }

  const aggregate = (Object.keys(dimensions) as EvalDimensionKey[])
    .map((k) => dimensions[k].score * weights[k])
    .reduce((a, b) => a + b, 0)

  return {
    dimensions,
    aggregate,
    weights: { ...weights },
  }
}
