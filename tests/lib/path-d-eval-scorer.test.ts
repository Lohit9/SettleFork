/**
 * Unit tests for `lib/ai/path-d-eval/scorer.ts`.
 *
 * Pure-function tests — no LLM, no DB, no fixtures. Synthetic
 * actual/expected pairs constructed inline. Covers each of the 8
 * dimensions plus aggregate weighting and edge cases.
 *
 * 15 tests total per Sub-PR 6 Stop 1 plan.
 */

import { describe, it, expect } from 'vitest'
import { scorePathDOutput } from '@/lib/ai/path-d-eval/scorer'
import type { PathDParsedOutput } from '@/lib/ai/path-d-parser'
import type {
  EvalWeights,
  ExpectedPathDOutput,
} from '@/lib/ai/path-d-eval/types'
import { DEFAULT_WEIGHTS } from '@/lib/ai/path-d-eval/types'

// ── Helpers — fluent builders for actual / expected output ─────────────────

const TF1 = '11111111-1111-4111-8111-000000000001'
const TF2 = '11111111-1111-4111-8111-000000000002'
const TF3 = '11111111-1111-4111-8111-000000000003'
const SF1 = '22222222-2222-4222-8222-000000000001'
const SF2 = '22222222-2222-4222-8222-000000000002'
const SF3 = '22222222-2222-4222-8222-000000000003'

function makeActual(overrides: Partial<PathDParsedOutput> = {}): PathDParsedOutput {
  return {
    mappings: { status: 'parsed_ok', data: [] },
    coverage: { status: 'parsed_ok', data: [] },
    decisions: { status: 'parsed_ok', data: [] },
    lookup_tables: { status: 'parsed_ok', data: [] },
    data_quality: { status: 'parsed_ok', data: [] },
    inferred_targets: { status: 'parsed_ok', data: [] },
    project_notes: { status: 'parsed_ok', data: '' },
    ...overrides,
  }
}

function makeExpected(
  overrides: Partial<ExpectedPathDOutput> = {},
): ExpectedPathDOutput {
  return {
    mappings: [],
    coverage: [],
    decisions: [],
    lookup_tables: [],
    data_quality: [],
    inferred_targets: [],
    project_notes_expected: true,
    ...overrides,
  }
}

function mappingPayload(overrides: {
  target_field_id: string
  source_field_ids: string[]
  combination_type?: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql'
}) {
  return {
    target_field_id: overrides.target_field_id,
    source_field_ids: overrides.source_field_ids,
    combination_type: overrides.combination_type ?? 'single',
    combination_sql: null,
    ai_reasoning: 'r',
    transformation_intent: 't',
    mapping_cardinality: '1:1' as const,
    dedup_required: false,
    dedup_strategy: null,
    data_quality_flag_indices: [],
    confidence: 0.9,
    status: 'needs_review' as const,
  }
}

function coveragePayload(target_field_id: string, coverage_status: 'covered' | 'partial' | 'gap' | 'optional' | 'out_of_scope') {
  return { target_field_id, coverage_status }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('scorePathDOutput — overall behaviour', () => {
  // Test 1
  it('empty actual + empty expected → all dimensions = 1.0, aggregate = 1.0', () => {
    const result = scorePathDOutput(makeActual(), makeExpected())
    expect(result.dimensions.mapping_accuracy.score).toBe(1)
    expect(result.dimensions.combination_type.score).toBe(1)
    expect(result.dimensions.coverage_completeness.score).toBe(1)
    expect(result.dimensions.decision_recall.score).toBe(1)
    expect(result.dimensions.lookup_recall.score).toBe(1)
    expect(result.dimensions.dq_recall.score).toBe(1)
    expect(result.dimensions.inferred_targets_recall.score).toBe(1)
    expect(result.dimensions.output_completeness.score).toBe(1)
    expect(result.aggregate).toBeCloseTo(1, 5)
  })

  // Test 2
  it('aggregate weighting — weighted sum produces expected', () => {
    // Construct an actual that scores 0.5 on every dimension.
    // Mapping accuracy: 1 expected, 0 proposed → F1=0
    // Make a custom set of inputs that each score 0.5 individually...
    // Simpler: assert the math with explicit weights.
    const customWeights: EvalWeights = {
      mapping_accuracy: 0.5,
      combination_type: 0.5,
      coverage_completeness: 0,
      decision_recall: 0,
      lookup_recall: 0,
      dq_recall: 0,
      inferred_targets_recall: 0,
      output_completeness: 0,
    }
    const result = scorePathDOutput(makeActual(), makeExpected(), customWeights)
    // mapping_accuracy = 1, combination_type = 1, others irrelevant.
    expect(result.aggregate).toBeCloseTo(1, 5)
    expect(result.weights).toEqual(customWeights)
  })

  // Test 3
  it('custom weights override is reflected in returned weights', () => {
    const w: EvalWeights = { ...DEFAULT_WEIGHTS, mapping_accuracy: 0.5 }
    // (Note: this set doesn't sum to 1 — that's the caller's
    // responsibility to enforce. Scorer just trusts the input.)
    const result = scorePathDOutput(makeActual(), makeExpected(), w)
    expect(result.weights.mapping_accuracy).toBe(0.5)
  })
})

describe('mapping_accuracy dimension', () => {
  // Test 4
  it('full F1 happy path — all proposed mappings match all expected', () => {
    const actual = makeActual({
      mappings: {
        status: 'parsed_ok',
        data: [
          mappingPayload({ target_field_id: TF1, source_field_ids: [SF1] }),
          mappingPayload({ target_field_id: TF2, source_field_ids: [SF2] }),
        ],
      },
    })
    const expected = makeExpected({
      mappings: [
        { target_field_id: TF1, source_field_ids: [SF1], combination_type: 'single' },
        { target_field_id: TF2, source_field_ids: [SF2], combination_type: 'single' },
      ],
    })
    const result = scorePathDOutput(actual, expected)
    expect(result.dimensions.mapping_accuracy.score).toBe(1)
  })

  // Test 5
  it('extra proposed mappings hurt precision (F1 drops)', () => {
    const actual = makeActual({
      mappings: {
        status: 'parsed_ok',
        data: [
          mappingPayload({ target_field_id: TF1, source_field_ids: [SF1] }),
          mappingPayload({ target_field_id: TF2, source_field_ids: [SF2] }),
          mappingPayload({ target_field_id: TF3, source_field_ids: [SF3] }), // extra
        ],
      },
    })
    const expected = makeExpected({
      mappings: [
        { target_field_id: TF1, source_field_ids: [SF1], combination_type: 'single' },
        { target_field_id: TF2, source_field_ids: [SF2], combination_type: 'single' },
      ],
    })
    const result = scorePathDOutput(actual, expected)
    // 2 matched, 1 extra, 0 missed → P=2/3, R=2/2=1, F1=2*(2/3)*1/(2/3+1) = 0.8
    expect(result.dimensions.mapping_accuracy.score).toBeCloseTo(0.8, 5)
  })

  // Test 6
  it('many-to-one source set equality — order does not matter', () => {
    const actual = makeActual({
      mappings: {
        status: 'parsed_ok',
        data: [
          mappingPayload({
            target_field_id: TF1,
            source_field_ids: [SF2, SF1], // reversed order
            combination_type: 'concat_space',
          }),
        ],
      },
    })
    const expected = makeExpected({
      mappings: [
        {
          target_field_id: TF1,
          source_field_ids: [SF1, SF2],
          combination_type: 'concat_space',
        },
      ],
    })
    const result = scorePathDOutput(actual, expected)
    expect(result.dimensions.mapping_accuracy.score).toBe(1)
  })
})

describe('combination_type dimension', () => {
  // Test 7
  it('per-mapping accuracy on combination_type', () => {
    const actual = makeActual({
      mappings: {
        status: 'parsed_ok',
        data: [
          mappingPayload({
            target_field_id: TF1,
            source_field_ids: [SF1],
            combination_type: 'single',
          }),
          mappingPayload({
            target_field_id: TF2,
            source_field_ids: [SF2],
            combination_type: 'concat_space', // wrong — expected 'single'
          }),
        ],
      },
    })
    const expected = makeExpected({
      mappings: [
        { target_field_id: TF1, source_field_ids: [SF1], combination_type: 'single' },
        { target_field_id: TF2, source_field_ids: [SF2], combination_type: 'single' },
      ],
    })
    const result = scorePathDOutput(actual, expected)
    // 2 matched on field-pair, 1 of those matched on combination_type
    expect(result.dimensions.combination_type.score).toBe(0.5)
  })
})

describe('coverage_completeness dimension', () => {
  // Test 8
  it('F1 over (target_field_id, coverage_status) pairs', () => {
    const actual = makeActual({
      coverage: {
        status: 'parsed_ok',
        data: [
          coveragePayload(TF1, 'covered'),
          coveragePayload(TF2, 'gap'),
        ],
      },
    })
    const expected = makeExpected({
      coverage: [
        { target_field_id: TF1, coverage_status: 'covered' },
        { target_field_id: TF2, coverage_status: 'gap' },
        { target_field_id: TF3, coverage_status: 'optional' },
      ],
    })
    const result = scorePathDOutput(actual, expected)
    // 2 matched, 1 missed, 0 extra → P=1, R=2/3, F1=2*1*(2/3)/(1+2/3)=0.8
    expect(result.dimensions.coverage_completeness.score).toBeCloseTo(0.8, 5)
  })

  // Test 9
  it('wrong coverage_status counts as missed (not partial credit)', () => {
    const actual = makeActual({
      coverage: {
        status: 'parsed_ok',
        data: [coveragePayload(TF1, 'covered')], // expected 'gap'
      },
    })
    const expected = makeExpected({
      coverage: [{ target_field_id: TF1, coverage_status: 'gap' }],
    })
    const result = scorePathDOutput(actual, expected)
    // No matches (key (TF1, covered) ≠ (TF1, gap)). 0 matched, 1 missed, 1 extra → F1=0
    expect(result.dimensions.coverage_completeness.score).toBe(0)
  })
})

describe('recall-only dimensions (decision/lookup/dq/inferred_targets)', () => {
  // Test 10
  it('decision_recall: extras do NOT hurt the score', () => {
    const actual = makeActual({
      decisions: {
        status: 'parsed_ok',
        data: [
          {
            decision_type: 'duplicate_resolution',
            title: 't',
            ai_recommendation: {},
            alternatives: {},
            status: 'pending',
          },
          {
            decision_type: 'naming_convention', // extra
            title: 't',
            ai_recommendation: {},
            alternatives: {},
            status: 'pending',
          },
        ],
      },
    })
    const expected = makeExpected({
      decisions: [{ decision_type: 'duplicate_resolution' }],
    })
    const result = scorePathDOutput(actual, expected)
    // 1 expected, 1 matched → recall = 1.0; extra doesn't penalise
    expect(result.dimensions.decision_recall.score).toBe(1)
  })

  // Test 11
  it('lookup_recall: case-insensitive name match', () => {
    const actual = makeActual({
      lookup_tables: {
        status: 'parsed_ok',
        data: [{ name: 'STATUS_LOOKUP', mappings: {} }], // upper
      },
    })
    const expected = makeExpected({
      lookup_tables: [{ name: 'status_lookup' }], // lower
    })
    const result = scorePathDOutput(actual, expected)
    expect(result.dimensions.lookup_recall.score).toBe(1)
  })

  // Test 12
  it('dq_recall: matches on (source_field_id, category) pair', () => {
    const actual = makeActual({
      data_quality: {
        status: 'parsed_ok',
        data: [
          {
            source_field_id: SF1,
            severity: 'warning',
            category: 'format_drift',
            description: 'd',
          },
          {
            source_field_id: SF2,
            severity: 'critical',
            category: 'duplicates',
            description: 'd',
          }, // wrong source field
        ],
      },
    })
    const expected = makeExpected({
      data_quality: [
        { source_field_id: SF1, category: 'format_drift' }, // matches
        { source_field_id: SF1, category: 'duplicates' }, // missed (different source_field_id)
      ],
    })
    const result = scorePathDOutput(actual, expected)
    // 1 of 2 expected matched → recall = 0.5
    expect(result.dimensions.dq_recall.score).toBe(0.5)
  })
})

describe('output_completeness dimension', () => {
  // Test 13
  it('partial section parse — missing project_notes drops score', () => {
    const actual = makeActual({
      project_notes: { status: 'missing' },
    })
    const expected = makeExpected({ project_notes_expected: true })
    const result = scorePathDOutput(actual, expected)
    // 6 of 7 sections parsed_ok → 6/7
    expect(result.dimensions.output_completeness.score).toBeCloseTo(6 / 7, 5)
  })

  // Test 14
  it('parse_error counts as not-ok for output_completeness', () => {
    const actual = makeActual({
      mappings: { status: 'parse_error', error: 'Zod failed' },
    })
    const expected = makeExpected()
    const result = scorePathDOutput(actual, expected)
    expect(result.dimensions.output_completeness.score).toBeCloseTo(6 / 7, 5)
  })
})

describe('parse-error / missing data handling', () => {
  // Test 15
  it('mapping section in parse_error → mapping_accuracy=0 when expected has mappings; aggregate reflects', () => {
    const actual = makeActual({
      mappings: { status: 'parse_error', error: 'Zod failed' },
    })
    const expected = makeExpected({
      mappings: [
        { target_field_id: TF1, source_field_ids: [SF1], combination_type: 'single' },
      ],
    })
    const result = scorePathDOutput(actual, expected)
    // No proposed mappings (parse_error treated as empty), 1 expected → recall=0, F1=0
    expect(result.dimensions.mapping_accuracy.score).toBe(0)
    // output_completeness drops by 1/7 too
    expect(result.dimensions.output_completeness.score).toBeCloseTo(6 / 7, 5)
  })
})
