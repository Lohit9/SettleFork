import { describe, expect, it } from 'vitest'
import {
  buildPathDOutputs,
  emptyPathDOutputs,
} from '@/lib/utils/_path-d-outputs-core'
import type {
  ProjectDataQualityIssueRow,
  ProjectDecisionRow,
  TargetFieldCoverageRow,
} from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — pure reducer tests for buildPathDOutputs.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the four index shapes the drawer consumes:
//   1. coverageByTargetFieldId — direct map (UNIQUE per migration 093:67)
//   2. decisionsByTfmId — fan-out across applies_to.tfm_ids
//   3. decisionsByCoverageId — fan-out across applies_to.coverage_ids
//   4. dqIssuesBySourceFieldId — append-only, NULL source_field_id skipped

function coverage(
  partial: Partial<TargetFieldCoverageRow>,
): TargetFieldCoverageRow {
  return {
    id: 'cov-1',
    project_id: 'proj-1',
    target_field_id: 'tf-1',
    coverage_status: 'gap',
    ai_reasoning: null,
    default_value_recommendation: null,
    default_value_decided: null,
    default_decided_at: null,
    default_decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

function decision(
  partial: Partial<ProjectDecisionRow>,
): ProjectDecisionRow {
  return {
    id: 'dec-1',
    project_id: 'proj-1',
    decision_type: 'mapping',
    title: 'Decision title',
    description: null,
    ai_recommendation: {},
    alternatives: [],
    customer_decision: null,
    applies_to: null,
    status: 'pending',
    decided_at: null,
    decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

function dq(
  partial: Partial<ProjectDataQualityIssueRow>,
): ProjectDataQualityIssueRow {
  return {
    id: 'dq-1',
    project_id: 'proj-1',
    source_field_id: 'sf-1',
    severity: 'warning',
    category: 'completeness',
    description: 'Missing values',
    example_values: null,
    recommendation: null,
    acknowledged_at: null,
    acknowledged_by: null,
    created_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

describe('emptyPathDOutputs', () => {
  it('returns four empty Maps with the expected keys', () => {
    const out = emptyPathDOutputs()
    expect(out.coverageByTargetFieldId.size).toBe(0)
    expect(out.decisionsByTfmId.size).toBe(0)
    expect(out.decisionsByCoverageId.size).toBe(0)
    expect(out.dqIssuesBySourceFieldId.size).toBe(0)
  })
})

describe('buildPathDOutputs — coverage index', () => {
  it('keys coverage rows by target_field_id', () => {
    const rows = [
      coverage({ id: 'c1', target_field_id: 'tfA' }),
      coverage({ id: 'c2', target_field_id: 'tfB' }),
    ]
    const out = buildPathDOutputs(rows, [], [])
    expect(out.coverageByTargetFieldId.size).toBe(2)
    expect(out.coverageByTargetFieldId.get('tfA')?.id).toBe('c1')
    expect(out.coverageByTargetFieldId.get('tfB')?.id).toBe('c2')
  })

  it('handles empty input cleanly (no throw, empty map)', () => {
    const out = buildPathDOutputs([], [], [])
    expect(out.coverageByTargetFieldId.size).toBe(0)
  })
})

describe('buildPathDOutputs — decisions fan-out', () => {
  it('indexes a decision under each tfm_id in applies_to.tfm_ids', () => {
    const d = decision({
      id: 'd1',
      applies_to: { tfm_ids: ['tfm-1', 'tfm-2', 'tfm-3'] },
    })
    const out = buildPathDOutputs([], [d], [])
    expect(out.decisionsByTfmId.get('tfm-1')).toEqual([d])
    expect(out.decisionsByTfmId.get('tfm-2')).toEqual([d])
    expect(out.decisionsByTfmId.get('tfm-3')).toEqual([d])
  })

  it('indexes a decision under each coverage_id in applies_to.coverage_ids', () => {
    const d = decision({
      id: 'd1',
      applies_to: { coverage_ids: ['cov-A', 'cov-B'] },
    })
    const out = buildPathDOutputs([], [d], [])
    expect(out.decisionsByCoverageId.get('cov-A')).toEqual([d])
    expect(out.decisionsByCoverageId.get('cov-B')).toEqual([d])
  })

  it('indexes a decision in BOTH maps when applies_to has both arrays', () => {
    const d = decision({
      id: 'd1',
      applies_to: { tfm_ids: ['tfm-1'], coverage_ids: ['cov-A'] },
    })
    const out = buildPathDOutputs([], [d], [])
    expect(out.decisionsByTfmId.get('tfm-1')).toEqual([d])
    expect(out.decisionsByCoverageId.get('cov-A')).toEqual([d])
  })

  it('appends multiple decisions sharing a TFM id under the same key', () => {
    const d1 = decision({ id: 'd1', applies_to: { tfm_ids: ['tfm-1'] } })
    const d2 = decision({ id: 'd2', applies_to: { tfm_ids: ['tfm-1'] } })
    const out = buildPathDOutputs([], [d1, d2], [])
    expect(out.decisionsByTfmId.get('tfm-1')).toEqual([d1, d2])
  })

  it('skips decisions with applies_to === null without throwing', () => {
    const d = decision({ id: 'd1', applies_to: null })
    const out = buildPathDOutputs([], [d], [])
    expect(out.decisionsByTfmId.size).toBe(0)
    expect(out.decisionsByCoverageId.size).toBe(0)
  })

  it('skips decisions with empty applies_to arrays', () => {
    const d = decision({
      id: 'd1',
      applies_to: { tfm_ids: [], coverage_ids: [] },
    })
    const out = buildPathDOutputs([], [d], [])
    expect(out.decisionsByTfmId.size).toBe(0)
    expect(out.decisionsByCoverageId.size).toBe(0)
  })
})

describe('buildPathDOutputs — DQ issues index', () => {
  it('keys DQ issues by source_field_id', () => {
    const issue = dq({ id: 'dq-A', source_field_id: 'sf-1' })
    const out = buildPathDOutputs([], [], [issue])
    expect(out.dqIssuesBySourceFieldId.get('sf-1')).toEqual([issue])
  })

  it('appends multiple issues under the same source_field_id', () => {
    const a = dq({ id: 'dq-A', source_field_id: 'sf-1', severity: 'critical' })
    const b = dq({ id: 'dq-B', source_field_id: 'sf-1', severity: 'info' })
    const out = buildPathDOutputs([], [], [a, b])
    expect(out.dqIssuesBySourceFieldId.get('sf-1')).toEqual([a, b])
  })

  it('skips issues with NULL source_field_id (project-level scope deferred)', () => {
    const projectLevel = dq({ id: 'dq-P', source_field_id: null })
    const out = buildPathDOutputs([], [], [projectLevel])
    expect(out.dqIssuesBySourceFieldId.size).toBe(0)
  })
})

describe('buildPathDOutputs — end-to-end fan-in', () => {
  it('fans coverage + decisions + dq into the four indexes simultaneously', () => {
    const cov = coverage({ id: 'cov-1', target_field_id: 'tf-1' })
    const dec = decision({
      id: 'dec-1',
      applies_to: { tfm_ids: ['tfm-1'], coverage_ids: ['cov-1'] },
    })
    const issue = dq({ id: 'dq-1', source_field_id: 'sf-1' })

    const out = buildPathDOutputs([cov], [dec], [issue])
    expect(out.coverageByTargetFieldId.get('tf-1')).toBe(cov)
    expect(out.decisionsByTfmId.get('tfm-1')).toEqual([dec])
    expect(out.decisionsByCoverageId.get('cov-1')).toEqual([dec])
    expect(out.dqIssuesBySourceFieldId.get('sf-1')).toEqual([issue])
  })
})
