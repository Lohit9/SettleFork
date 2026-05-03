// @vitest-environment node
//
// Path 2 PR 2 B-2 — unit tests for `scoreQualityIssueDetection`.
//
// Pure-function tests; no I/O, no LLM calls. Mirrors the structural
// pattern of tests/lib/scorers/mapping-suggestion.test.ts. The scorer
// has 4 axes with weights 0.40 / 0.40 / 0.10 / 0.10; tests cover the
// canonical pass case, per-axis fail isolation, the adversarial
// SQL-safety failure case, and edge cases (empty proposals, empty gold).

import { describe, it, expect } from 'vitest'

import {
  scoreQualityIssueDetection,
  type ProposedQualityIssues,
  type GoldQualityIssues,
} from '@/lib/eval/scorers/quality-issues'

const TID = '00000000-0000-0000-0000-deadbeef0001'

const SAFE_SQL = `SELECT COUNT(*) FROM data_rows WHERE table_id = '${TID}' AND row_data->>'name' IS NULL`

function makeProposal(overrides: Partial<ProposedQualityIssues[number]> = {}) {
  return {
    field_name: 'name',
    description: 'Null name on 5% of rows',
    severity: 'warning' as const,
    estimated_count: 5,
    verification_sql: SAFE_SQL,
    reasoning: 'Field profile shows 5/100 nulls on a NOT NULL field',
    ...overrides,
  }
}

describe('scoreQualityIssueDetection — canonical', () => {
  it('scores 1.0 on perfect match: 1 proposal matches 1 gold with safe SQL + correct severity', () => {
    const proposed: ProposedQualityIssues = [makeProposal()]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { score, details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.matched).toBe(1)
    expect(details.precision).toBe(1)
    expect(details.recall).toBe(1)
    expect(details.severityCorrectness).toBe(1)
    expect(details.sqlSafetyRate).toBe(1)
    expect(score).toBeCloseTo(1.0, 4)
  })

  it('case-insensitive field_name match', () => {
    const proposed: ProposedQualityIssues = [makeProposal({ field_name: 'NAME' })]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    expect(scoreQualityIssueDetection(proposed, gold, TID).details.matched).toBe(1)
  })
})

describe('scoreQualityIssueDetection — adversarial SQL safety', () => {
  it('every proposal with unsafe SQL → sqlSafetyRate = 0', () => {
    const unsafe = `DROP TABLE data_rows; -- ${TID}`
    const proposed: ProposedQualityIssues = [
      makeProposal({ verification_sql: unsafe }),
      makeProposal({ field_name: 'foo', verification_sql: 'UPDATE data_rows SET ...' }),
    ]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.sqlSafetyRate).toBe(0)
  })

  it('SQL missing the required tableId → unsafe', () => {
    const wrongId = '11111111-1111-1111-1111-111111111111'
    const sqlForOtherTable = `SELECT COUNT(*) FROM data_rows WHERE table_id = '${wrongId}'`
    const proposed: ProposedQualityIssues = [
      makeProposal({ verification_sql: sqlForOtherTable }),
    ]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.sqlSafetyRate).toBe(0)
  })
})

describe('scoreQualityIssueDetection — wrong field & severity', () => {
  it('wrong field_name → precision=0, recall=0, severityCorrectness=0', () => {
    const proposed: ProposedQualityIssues = [makeProposal({ field_name: 'wrongfield' })]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.matched).toBe(0)
    expect(details.precision).toBe(0)
    expect(details.recall).toBe(0)
    expect(details.severityCorrectness).toBe(0)
  })

  it('matched but wrong severity → severityCorrectness = 0', () => {
    const proposed: ProposedQualityIssues = [makeProposal({ severity: 'blocking' })]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.matched).toBe(1)
    expect(details.severityCorrectness).toBe(0)
  })
})

describe('scoreQualityIssueDetection — edge cases', () => {
  it('empty proposals + non-empty gold: precision=1 vacuous, recall=0, severity=0, sqlSafety=1 vacuous', () => {
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection([], gold, TID)
    expect(details.precision).toBe(1)
    expect(details.recall).toBe(0)
    expect(details.severityCorrectness).toBe(0)
    expect(details.sqlSafetyRate).toBe(1)
    // 0.40 + 0 + 0 + 0.10 = 0.50
  })

  it('proposals + empty gold: precision=0, recall=1 vacuous', () => {
    const proposed: ProposedQualityIssues = [makeProposal()]
    const { details } = scoreQualityIssueDetection(proposed, { expected_issues: [] }, TID)
    expect(details.recall).toBe(1)
    expect(details.precision).toBe(0)
    expect(details.severityCorrectness).toBe(0)
  })

  it('both empty: all axes vacuously 1', () => {
    const { score } = scoreQualityIssueDetection([], { expected_issues: [] }, TID)
    expect(score).toBeCloseTo(1.0, 4)
  })

  it('cross_field constraint enforced: gold has cross_field, proposal lacks → no match', () => {
    const proposed: ProposedQualityIssues = [makeProposal()] // no cross_field
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', cross_field: 'status', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.matched).toBe(0)
  })

  it('1:1 greedy matching: 2 proposals on the same field do not double-match 1 gold', () => {
    const proposed: ProposedQualityIssues = [makeProposal(), makeProposal()]
    const gold: GoldQualityIssues = {
      expected_issues: [{ field_name: 'name', expected_severity: 'warning' }],
    }
    const { details } = scoreQualityIssueDetection(proposed, gold, TID)
    expect(details.matched).toBe(1)
    expect(details.precision).toBeCloseTo(0.5, 4) // 1 matched / 2 proposed
  })
})
