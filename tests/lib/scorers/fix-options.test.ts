// @vitest-environment node
//
// Path 2 PR 2 B-2 — unit tests for `scoreFixOptions`.
//
// Pure-function tests (validateFixSQL is sync, no I/O). The scorer
// has 5 axes with weights 0.40 / 0.20 / 0.20 / 0.10 / 0.10; tests
// cover canonical pass, the load-bearing sqlValidityRate axis (with
// adversarial DDL), and risk-level diversity / hasLowRiskOption.

import { describe, it, expect } from 'vitest'

import {
  scoreFixOptions,
  type ProposedFixOptions,
  type GoldFixOptions,
} from '@/lib/eval/scorers/fix-options'

const TID = '00000000-0000-0000-0000-deadbeef0001'

const VALID_UPDATE_SQL = `UPDATE data_rows SET row_data = jsonb_set(row_data, '{name}', '"Anonymous"') WHERE table_id = '${TID}' AND (row_data->>'name' IS NULL OR row_data->>'name' = '')`
const VALID_DELETE_SQL = `DELETE FROM data_rows WHERE table_id = '${TID}' AND row_data->>'name' IS NULL`
const VALID_LOW_DESC = 'Replace null name values with "Anonymous" — preserves the row but loses identity.'
const VALID_HIGH_DESC = 'Hard-delete rows with null name — guarantees clean target but loses data.'

function fixOpt(overrides: Partial<ProposedFixOptions[number]> = {}): ProposedFixOptions[number] {
  return {
    label: 'Substitute',
    description: VALID_LOW_DESC,
    sql: VALID_UPDATE_SQL,
    tradeoff: 'Cheap, but loses identity',
    downstream_impact: 'No PII fidelity',
    risk_level: 'low',
    estimated_rows_affected: 5,
    ...overrides,
  }
}

describe('scoreFixOptions — canonical', () => {
  it('scores 1.0 on perfect output: 2 options, ≥1 low-risk, both SQL valid, 2 risk levels, descriptions long', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ risk_level: 'low' }),
      fixOpt({ risk_level: 'high', sql: VALID_DELETE_SQL, description: VALID_HIGH_DESC }),
    ]
    const gold: GoldFixOptions = {
      min_option_count: 2,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { score, details } = scoreFixOptions(proposed, gold, TID)
    expect(details.sqlValidityRate).toBe(1)
    expect(details.optionCountInRange).toBe(true)
    expect(details.hasLowRiskOption).toBe(true)
    expect(details.riskLevelDiversity).toBe(true)
    expect(details.descriptionNonEmpty).toBe(1)
    expect(score).toBeCloseTo(1.0, 4)
  })
})

describe('scoreFixOptions — adversarial SQL validity', () => {
  it('all options with invalid SQL → sqlValidityRate = 0', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ sql: 'DROP TABLE data_rows' }),
      fixOpt({ sql: 'SELECT * FROM data_rows' }), // SELECT not UPDATE/DELETE
    ]
    const gold: GoldFixOptions = {
      min_option_count: 2,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.sqlValidityRate).toBe(0)
    expect(details.sqlValidCount).toBe(0)
  })

  it('SQL missing tableId → invalid', () => {
    const wrongTable = '11111111-1111-1111-1111-111111111111'
    const sqlWrongTable = `UPDATE data_rows SET row_data = jsonb_set(row_data, '{name}', '"x"') WHERE table_id = '${wrongTable}'`
    const proposed: ProposedFixOptions = [fixOpt({ sql: sqlWrongTable })]
    const gold: GoldFixOptions = {
      min_option_count: 1,
      max_option_count: 3,
      requires_low_risk_option: false,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.sqlValidityRate).toBe(0)
  })
})

describe('scoreFixOptions — risk level constraints', () => {
  it('all options high-risk → hasLowRiskOption = false, riskLevelDiversity = false', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ risk_level: 'high', description: VALID_HIGH_DESC }),
      fixOpt({ risk_level: 'high', description: VALID_HIGH_DESC }),
    ]
    const gold: GoldFixOptions = {
      min_option_count: 2,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.hasLowRiskOption).toBe(false)
    expect(details.riskLevelDiversity).toBe(false)
  })

  it('hasLowRiskOption is vacuously true when gold does NOT require low-risk', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ risk_level: 'high', description: VALID_HIGH_DESC }),
    ]
    const gold: GoldFixOptions = {
      min_option_count: 1,
      max_option_count: 3,
      requires_low_risk_option: false,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.hasLowRiskOption).toBe(true)
  })

  it('riskLevelDiversity = true when proposed has ≥2 unique risk levels', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ risk_level: 'low' }),
      fixOpt({ risk_level: 'medium', sql: VALID_DELETE_SQL, description: VALID_HIGH_DESC }),
    ]
    const gold: GoldFixOptions = {
      min_option_count: 2,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.riskLevelDiversity).toBe(true)
  })
})

describe('scoreFixOptions — edge cases', () => {
  it('empty options: optionCountInRange=false, hasLowRisk=false, diversity=false, descNonEmpty=0', () => {
    const gold: GoldFixOptions = {
      min_option_count: 1,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { details } = scoreFixOptions([], gold, TID)
    expect(details.optionCountInRange).toBe(false)
    expect(details.hasLowRiskOption).toBe(false)
    expect(details.riskLevelDiversity).toBe(false)
    expect(details.descriptionNonEmpty).toBe(0)
    // sqlValidityRate vacuously 1 → axisScore 0.40
  })

  it('count above max → optionCountInRange = false', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ risk_level: 'low' }),
      fixOpt({ risk_level: 'medium' }),
      fixOpt({ risk_level: 'high' }),
      fixOpt({ risk_level: 'low' }),
    ]
    const gold: GoldFixOptions = {
      min_option_count: 2,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.optionCountInRange).toBe(false)
  })

  it('descriptionNonEmpty: short descriptions reduce the axis fractionally', () => {
    const proposed: ProposedFixOptions = [
      fixOpt({ description: 'short' }),
      fixOpt({ description: VALID_LOW_DESC, sql: VALID_DELETE_SQL }),
    ]
    const gold: GoldFixOptions = {
      min_option_count: 2,
      max_option_count: 3,
      requires_low_risk_option: true,
    }
    const { details } = scoreFixOptions(proposed, gold, TID)
    expect(details.descriptionNonEmpty).toBeCloseTo(0.5, 4)
  })
})
