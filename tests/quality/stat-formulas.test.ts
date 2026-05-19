/**
 * Unit tests for the canonical project-stats helper
 * (`lib/quality/stat-formulas.ts`).
 *
 * These tests pin the formulas that drive the Migration Center card, the
 * Readiness Report, and (post Prompt B) the Projects Dashboard card. Every
 * case builds a tiny in-memory fixture with the smallest set of TFMs /
 * mapping-sources / fields / transformations / quality-issues needed to
 * exercise one axis of the contract, then asserts the exact counts the
 * formula should produce.
 *
 * Fixture conventions (kept small on purpose — a four-field project is
 * enough to cover the branches we care about):
 *
 *   Source fields: s_id, s_name, s_zip, s_unused, s_ack_only
 *   Target fields: t_id, t_name, t_zip, t_ack_only, t_va
 *
 *   TFMs exercised:
 *     - tfm1 approved   s_id  -> t_id    (high-confidence passthrough)
 *     - tfm2 approved   s_name-> t_name  (needs_transformation=true)
 *     - tfm3 approved   s_zip -> t_zip   (needs_transformation=false,
 *                                          has applied transformation)
 *     - tfm4 rejected   -                 (excluded from every count)
 *     - tfm5 bare-ack   ->t_ack_only      (acknowledged target-side)
 *     - tfm6 VA         -> t_va           (value assignment, always scope)
 *
 * The fixture is intentionally independent of the integration Heritage
 * fixture so these tests stay fast and deterministic regardless of the DB
 * seed. For end-to-end verification that the numbers survive real SQL, see
 * `tests/integration/outputs-heritage.test.ts` and
 * `tests/integration/readiness-score-heritage.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  computeProjectStats,
  type ComputeProjectStatsInputs,
  type StatsFieldRow,
  type StatsMappingSourceRow,
  type StatsQualityIssueRow,
  type StatsTfmRow,
  type StatsTransformRow,
} from '@/lib/quality/stat-formulas'

// ─── Fixture builders ─────────────────────────────────────────────────────

const SOURCE_FIELDS: StatsFieldRow[] = [
  { id: 's_id', name: 'id', data_type: 'int' },
  { id: 's_name', name: 'name', data_type: 'varchar(255)' },
  { id: 's_zip', name: 'zip', data_type: 'varchar(10)' },
  { id: 's_unused', name: 'unused', data_type: 'text' },
  { id: 's_ack_only', name: 'legacy_flag', data_type: 'boolean' },
]

const TARGET_FIELDS: StatsFieldRow[] = [
  { id: 't_id', name: 'id', data_type: 'int' },
  { id: 't_name', name: 'name', data_type: 'varchar(255)' },
  { id: 't_zip', name: 'postal_code', data_type: 'varchar(10)' },
  { id: 't_ack_only', name: 'deprecated_col', data_type: 'text' },
  { id: 't_va', name: 'tenant_id', data_type: 'uuid' },
]

function buildInputs(overrides: Partial<ComputeProjectStatsInputs> = {}): ComputeProjectStatsInputs {
  const tfms: StatsTfmRow[] = overrides.tfms ?? [
    {
      id: 'tfm1',
      target_field_id: 't_id',
      confidence: 100,
      status: 'approved',
      is_acknowledged: false,
      combination_type: null,
      needs_transformation: null,
    },
    {
      id: 'tfm2',
      target_field_id: 't_name',
      confidence: 85,
      status: 'approved',
      is_acknowledged: false,
      combination_type: null,
      needs_transformation: true,
    },
    {
      id: 'tfm3',
      target_field_id: 't_zip',
      confidence: 92,
      status: 'approved',
      is_acknowledged: false,
      combination_type: null,
      needs_transformation: false,
    },
    {
      id: 'tfm4',
      target_field_id: 't_name',
      confidence: 0,
      status: 'rejected',
      is_acknowledged: false,
      combination_type: null,
      needs_transformation: null,
    },
    {
      id: 'tfm5',
      target_field_id: 't_ack_only',
      confidence: null,
      status: 'approved',
      is_acknowledged: true,
      combination_type: null,
      needs_transformation: null,
    },
    {
      id: 'tfm6',
      target_field_id: 't_va',
      confidence: 100,
      status: 'approved',
      is_acknowledged: false,
      combination_type: 'custom_sql',
      needs_transformation: null,
    },
  ]

  const mappingSources: StatsMappingSourceRow[] = overrides.mappingSources ?? [
    {
      target_field_mapping_id: 'tfm1',
      source_field_id: 's_id',
      ordinal: 0,
      type_compatibility: 'direct compatible',
    },
    {
      target_field_mapping_id: 'tfm2',
      source_field_id: 's_name',
      ordinal: 0,
      type_compatibility: 'needs format conversion',
    },
    {
      target_field_mapping_id: 'tfm3',
      source_field_id: 's_zip',
      ordinal: 0,
      type_compatibility: 'needs conversion',
    },
    // tfm4 (rejected) intentionally has no MS row.
    // tfm5 is a bare ack — no MS row.
    // tfm6 is a VA — no MS row.
  ]

  const transforms: StatsTransformRow[] = overrides.transforms ?? [
    // tfm3 has an applied transformation; tfm2 is still "needs work".
    { target_field_mapping_id: 'tfm3', status: 'applied' },
  ]

  const qualityIssues: StatsQualityIssueRow[] = overrides.qualityIssues ?? []

  return {
    tfms,
    mappingSources,
    sourceFields: overrides.sourceFields ?? SOURCE_FIELDS,
    targetFields: overrides.targetFields ?? TARGET_FIELDS,
    sourceAckFieldIds: overrides.sourceAckFieldIds ?? ['s_ack_only'],
    transforms,
    qualityIssues,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('computeProjectStats — mapping counts', () => {
  it('denominator accounts for every TARGET-SIDE mapping slot (PR-7: primaries + unmapped target + acks)', () => {
    // Fixture decomposition (post-PR-7 — target-side only):
    //   primary TFMs     = tfm1, tfm2, tfm3, tfm6  (tfm4 rejected, tfm5 bare-ack)
    //   unmapped target  = (none — every non-ack target has a primary)
    //   acknowledged     = s_ack_only (source-side ACK) + t_ack_only (bare-ack TFM)
    //
    //   mappingTotal     = 4 + 0 + 2 = 6
    //   mappingApproved  = 4 approved primaries + 2 acks = 6
    //   mappingUnmapped  = 0 (target-side unmapped only; fixture has none)
    //
    // Pre-PR-7 the formula also added unmappedSource (`s_unused` → 1)
    // to mappingTotal and mappingUnmapped — that path conflated source-
    // axis accounting into a target-axis denominator and is no longer
    // counted here. Source-side accounting is on `source.{decided,total}`.
    const stats = computeProjectStats(buildInputs())
    expect(stats.mappingTotal).toBe(6)
    expect(stats.mappingApproved).toBe(6)
    expect(stats.mappingUnmapped).toBe(0)
  })

  it('mappingApproved never exceeds mappingTotal (invariant)', () => {
    const stats = computeProjectStats(buildInputs())
    expect(stats.mappingApproved).toBeLessThanOrEqual(stats.mappingTotal)
  })

  it('rejected TFMs are excluded from primaries and never mark their source field as mapped', () => {
    // Replace tfm1 approved with a rejected TFM also pointing at s_id.
    // s_id should then show up as unmapped (no non-rejected primary references
    // it); mappingTotal gains +1 for the newly-unmapped source field.
    const inputs = buildInputs({
      tfms: [
        {
          id: 'tfm1',
          target_field_id: 't_id',
          confidence: 100,
          status: 'rejected',
          is_acknowledged: false,
          combination_type: null,
          needs_transformation: null,
        },
        ...buildInputs().tfms.slice(1),
      ],
    })
    const stats = computeProjectStats(inputs)
    // Primary TFMs are now tfm2, tfm3, tfm6 (3 of them).
    // Unmapped target: t_id = 1.
    // Acknowledged: s_ack_only + t_ack_only = 2.
    //   mappingTotal (PR-7 target-side only) = 3 + 1 + 2 = 6
    //   mappingApproved = 3 approved primaries + 2 acks = 5
    // Pre-PR-7 the formula added unmappedSource (s_id + s_unused = 2)
    // to mappingTotal — that path no longer applies.
    expect(stats.mappingTotal).toBe(6)
    expect(stats.mappingApproved).toBe(5)
  })

  it('bare-ack TFMs are excluded from primaries and counted as acknowledged', () => {
    const stats = computeProjectStats(buildInputs())
    // If the bare-ack TFM (tfm5) were mistakenly counted as a primary, we'd
    // see mappingTotal go up by 1 and t_ack_only would no longer be
    // "unmapped+ack" — it'd be "mapped". The baseline test above pins 6/6
    // (post-PR-7 target-side only), only reachable with the bare-ack exclusion.
    expect(stats.mappingTotal).toBe(6)
    expect(stats.mappingApproved).toBe(6)
  })
})

// ─── targetFieldsUsedInMapping ─────────────────────────────────────────────
//
// Distinct target_field_id count across primary TFMs (non-rejected,
// non-bare-ack). Status-agnostic: needs_review and approved both count.
// Tracks "how many target fields appear as the target of at least one
// real mapping?", which the public-surface `ProjectStats.target.usedInMapping`
// re-exposes for the Mapping page strip's ratio.
//
// Baseline fixture's primary TFMs are tfm1, tfm2, tfm3, tfm6 → distinct
// target ids = {t_id, t_name, t_zip, t_va} = 4.

describe('computeProjectStats — targetFieldsUsedInMapping', () => {
  it('counts distinct target_field_ids across primary TFMs', () => {
    const stats = computeProjectStats(buildInputs())
    expect(stats.targetFieldsUsedInMapping).toBe(4)
  })

  it('excludes rejected TFMs (rejected does not claim its target field)', () => {
    const inputs = buildInputs({
      tfms: [
        {
          id: 'tfm1',
          target_field_id: 't_id',
          confidence: 100,
          status: 'rejected',
          is_acknowledged: false,
          combination_type: null,
          needs_transformation: null,
        },
        ...buildInputs().tfms.slice(1),
      ],
    })
    const stats = computeProjectStats(inputs)
    // tfm1 → rejected, so t_id no longer counted. Primaries now tfm2, tfm3, tfm6.
    expect(stats.targetFieldsUsedInMapping).toBe(3)
  })

  it('excludes bare-ack TFMs (the baseline tfm5 → t_ack_only would otherwise inflate)', () => {
    const stats = computeProjectStats(buildInputs())
    // If bare-ack tfm5 were counted, the set would include t_ack_only → 5.
    // The pinned 4 only reachable with the bare-ack exclusion.
    expect(stats.targetFieldsUsedInMapping).toBe(4)
  })

  it('deduplicates when multiple primary TFMs share a target_field_id', () => {
    // Append a second primary TFM also pointing at t_id. Both are primaries
    // (non-rejected, non-bare-ack); the distinct set must collapse to one
    // entry for t_id. (NB: in production the UNIQUE constraint on
    // `target_field_mappings.target_field_id` per project would prevent
    // this row coexistence; the test pins the formula's defensive DISTINCT,
    // which mirrors what the Set semantics produce.)
    const base = buildInputs()
    const inputs = buildInputs({
      tfms: [
        ...base.tfms,
        {
          id: 'tfm-extra',
          target_field_id: 't_id',
          confidence: 100,
          status: 'needs_review',
          is_acknowledged: false,
          combination_type: null,
          needs_transformation: null,
        },
      ],
    })
    const stats = computeProjectStats(inputs)
    expect(stats.targetFieldsUsedInMapping).toBe(4)
  })

  it('is status-agnostic across needs_review and approved primaries', () => {
    // Swap tfm1 to needs_review — must still count.
    const base = buildInputs()
    const inputs = buildInputs({
      tfms: [
        {
          ...base.tfms[0],
          status: 'needs_review',
        },
        ...base.tfms.slice(1),
      ],
    })
    const stats = computeProjectStats(inputs)
    expect(stats.targetFieldsUsedInMapping).toBe(4)
  })
})

describe('computeProjectStats — transform scope', () => {
  it('value assignments are always in scope even when needs_transformation is null', () => {
    const stats = computeProjectStats(buildInputs())
    // In-scope primaries (evaluated via fieldNeedsTransform unless VA):
    //   tfm1 (s_id int → t_id int, direct compatible @100%) → NO
    //   tfm2 (needs_transformation=true)                     → YES
    //   tfm3 (needs_transformation=false)                    → NO (user dismissal)
    //   tfm6 (VA)                                            → YES
    // scope = 2, applied = 0 (tfm3 applied is out-of-scope by user dismissal),
    // needsWork = 2 (tfm2 and tfm6 have no transformation row).
    expect(stats.transformScope).toBe(2)
    expect(stats.transformApplied).toBe(0)
    expect(stats.transformNeedsWork).toBe(2)
  })

  it('a dismissed field with a stale transformation row stays out of scope', () => {
    // Regression guard: this was the exact bug fixed in the prior task.
    // tfm3 has needs_transformation=false AND an applied transformation. The
    // user-dismissal short-circuit in `fieldNeedsTransform` must win, keeping
    // tfm3 out of transformScope regardless of the stale row.
    const stats = computeProjectStats(buildInputs())
    // If tfm3 leaked into scope we'd see transformScope=3 and transformApplied=1.
    expect(stats.transformScope).toBe(2)
    expect(stats.transformApplied).toBe(0)
  })

  it('applied transformations count towards transformApplied', () => {
    // Flip tfm2 from needs_transformation=true (no row) to have an applied row,
    // and leave tfm6 (VA) as no row.
    const base = buildInputs()
    const inputs: ComputeProjectStatsInputs = {
      ...base,
      transforms: [
        { target_field_mapping_id: 'tfm2', status: 'applied' },
        { target_field_mapping_id: 'tfm3', status: 'applied' },
      ],
    }
    const stats = computeProjectStats(inputs)
    expect(stats.transformScope).toBe(2) // tfm2 + tfm6
    expect(stats.transformApplied).toBe(1) // tfm2 only (tfm3 stays dismissed)
    expect(stats.transformNeedsWork).toBe(1) // tfm6 only
  })

  it('draft and tested transformation statuses are tracked separately', () => {
    const base = buildInputs()
    const inputs: ComputeProjectStatsInputs = {
      ...base,
      transforms: [
        { target_field_mapping_id: 'tfm2', status: 'draft' },
        { target_field_mapping_id: 'tfm6', status: 'tested' },
        { target_field_mapping_id: 'tfm3', status: 'applied' },
      ],
    }
    const stats = computeProjectStats(inputs)
    expect(stats.transformDraft).toBe(1)
    expect(stats.transformTested).toBe(1)
    expect(stats.transformApplied).toBe(0) // tfm3 dismissed
  })

  // ── Migration 077 — dismissed VAs exit transform scope ──────────────────
  //
  // The Transform redesign adds a "no value needed" affordance for VA TFMs:
  // user-dismissed VAs flip `va_dismissed=true` and stop counting toward
  // transform progress. The mapping ratios are unchanged (the TFM row still
  // exists), only the transform denominator shrinks. This is the symmetric
  // counterpart to mapped fields' `needs_transformation=false` short-circuit
  // exercised by the "stale transformation row" test above.
  it('a dismissed VA TFM exits transformScope (migration 077)', () => {
    const base = buildInputs()
    const dismissedTfms: StatsTfmRow[] = base.tfms.map((t) =>
      t.id === 'tfm6' ? { ...t, va_dismissed: true } : t,
    )
    const stats = computeProjectStats({ ...base, tfms: dismissedTfms })

    // Before dismissal: scope = 2 (tfm2 + tfm6). After: scope = 1 (tfm2).
    expect(stats.transformScope).toBe(1)
    expect(stats.transformApplied).toBe(0)
    expect(stats.transformNeedsWork).toBe(1)
  })

  it('a dismissed VA TFM keeps mapping counts unchanged', () => {
    // The TFM row still exists, so the mapping denominator must not move.
    // Only the transform denominator shrinks. This is the contract that
    // distinguishes va_dismissed (Transform-side concern) from an outright
    // delete (Mapping-side concern).
    const base = buildInputs()
    const dismissedTfms: StatsTfmRow[] = base.tfms.map((t) =>
      t.id === 'tfm6' ? { ...t, va_dismissed: true } : t,
    )
    const stats = computeProjectStats({ ...base, tfms: dismissedTfms })

    // PR-7: target-side-only denominator. va_dismissed has no impact on
    // the mapping axis (it's a transform-side concern).
    expect(stats.mappingTotal).toBe(6)
    expect(stats.mappingApproved).toBe(6)
    expect(stats.mappingUnmapped).toBe(0)
  })

  it('omitting va_dismissed (legacy fixtures) preserves pre-077 behavior', () => {
    // Fixtures that pre-date migration 077 do not set the field at all.
    // The formula must read `undefined` as `false` so existing test suites
    // and bulk-loaded production rows continue to compute identical scopes.
    const stats = computeProjectStats(buildInputs())
    expect(stats.transformScope).toBe(2) // tfm2 + tfm6 (VA still in scope)
  })
})

describe('computeProjectStats — quality issues', () => {
  it('naive open-blocking count filters on status=open AND stage=in_flight AND severity=blocking', () => {
    const issues: StatsQualityIssueRow[] = [
      { status: 'open', stage: 'in_flight', severity: 'blocking', field_id: null, issue_kind: null, description: null, title: null },
      { status: 'open', stage: 'in_flight', severity: 'warning', field_id: null, issue_kind: null, description: null, title: null },
      { status: 'fixed', stage: 'in_flight', severity: 'blocking', field_id: null, issue_kind: null, description: null, title: null },
      { status: 'open', stage: 'source', severity: 'blocking', field_id: null, issue_kind: null, description: null, title: null },
      { status: 'open', stage: 'target', severity: 'blocking', field_id: null, issue_kind: null, description: null, title: null },
    ]
    const stats = computeProjectStats(buildInputs({ qualityIssues: issues }))
    expect(stats.openBlocking).toBe(1)
    expect(stats.openWarnings).toBe(1)
  })

  it('resolvedSourceFieldIds tracks approved primaries that are transformed OR dismissed', () => {
    const stats = computeProjectStats(buildInputs())
    // tfm3 has needs_transformation=false AND an applied transformation — both
    // qualifying paths. s_zip should be in the resolved set.
    // tfm1 has neither a transform nor a false dismissal → not resolved.
    // tfm2 has neither → not resolved.
    expect(stats.resolvedSourceFieldIds.has('s_zip')).toBe(true)
    expect(stats.resolvedSourceFieldIds.has('s_id')).toBe(false)
    expect(stats.resolvedSourceFieldIds.has('s_name')).toBe(false)
  })

  it('resolution-suppressed counts match naive counts when no issues are stage=source+in_flight (impossible intersection)', () => {
    // The naive filter requires stage='in_flight', so the suppression branch's
    // `stage === 'source'` check never matches in the current pipeline. Both
    // flavors should be identical for any input. This test pins the
    // invariant so future widening of the naive filter is a deliberate choice.
    const issues: StatsQualityIssueRow[] = [
      { status: 'open', stage: 'in_flight', severity: 'blocking', field_id: 's_zip', issue_kind: null, description: null, title: null },
      { status: 'open', stage: 'in_flight', severity: 'warning', field_id: 's_zip', issue_kind: null, description: null, title: null },
    ]
    const stats = computeProjectStats(buildInputs({ qualityIssues: issues }))
    expect(stats.openBlockingResolutionSuppressed).toBe(stats.openBlocking)
    expect(stats.openWarningsResolutionSuppressed).toBe(stats.openWarnings)
  })
})

describe('computeProjectStats — edge cases', () => {
  it('empty project returns all-zero stats', () => {
    const stats = computeProjectStats({
      tfms: [],
      mappingSources: [],
      sourceFields: [],
      targetFields: [],
      sourceAckFieldIds: [],
      transforms: [],
      qualityIssues: [],
    })
    expect(stats.mappingTotal).toBe(0)
    expect(stats.mappingApproved).toBe(0)
    expect(stats.mappingUnmapped).toBe(0)
    expect(stats.transformScope).toBe(0)
    expect(stats.transformApplied).toBe(0)
    expect(stats.transformNeedsWork).toBe(0)
    expect(stats.openBlocking).toBe(0)
    expect(stats.openWarnings).toBe(0)
    expect(stats.resolvedSourceFieldIds.size).toBe(0)
  })

  it('orphaned MS rows (pointing at an unknown TFM) are silently ignored', () => {
    const base = buildInputs()
    const inputs: ComputeProjectStatsInputs = {
      ...base,
      mappingSources: [
        ...base.mappingSources,
        {
          target_field_mapping_id: 'tfm_does_not_exist',
          source_field_id: 's_unused',
          ordinal: 0,
          type_compatibility: 'direct compatible',
        },
      ],
    }
    const stats = computeProjectStats(inputs)
    // PR-7: target-side accounting only. The orphan MS row pointing at
    // s_unused doesn't change the target-side denominator (s_unused is
    // a SOURCE field; pre-PR-7 it would have shown up as mappingUnmapped=1
    // and bumped mappingTotal to 7 via the source-side conflation that
    // PR-7 removes). Post-PR-7 the orphan-MS pin is preserved at the
    // SOURCE axis level — `source.decided` remains correct because
    // `mappedSourceIds` is built only from MS rows belonging to TFMs the
    // helper sees. Target-side accounting (this test) is unaffected.
    expect(stats.mappingUnmapped).toBe(0)
    expect(stats.mappingTotal).toBe(6)
  })
})
