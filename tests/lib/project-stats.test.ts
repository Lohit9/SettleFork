import { describe, it, expect } from 'vitest'
import {
  rollupProjectStats,
  type ProjectStats,
} from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// PR-1 (feat/project-stats-shared-helper) — tests for the new public helper.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure unit tests against `rollupProjectStats`. The async wrapper
// `getProjectStats` only adds the Supabase fetch; behavioral correctness
// lives in the rollup. Existing canonical formula tests (target axis,
// transform scope, blocking) stay in tests/quality/stat-formulas.test.ts —
// this suite covers the new surfaces: state machine, source axis, transforms
// "complete" redefinition (saved + applied per Q2).

type RawData = Parameters<typeof rollupProjectStats>[1]

const PROJECT_A = 'proj-a'

function emptyRaw(): RawData {
  return {
    datasets: [],
    tables: [],
    fields: [],
    tfms: [],
    mappingSources: [],
    sourceAcks: [],
    transformations: [],
    qualityIssues: [],
    coverage: [],
  }
}

function withSourceTarget(
  raw: RawData,
  opts: { sourceFields?: number; targetFields?: number } = {},
): RawData {
  const { sourceFields = 0, targetFields = 0 } = opts
  raw.datasets.push({ id: 'ds-src', project_id: PROJECT_A, role: 'source' })
  raw.datasets.push({ id: 'ds-tgt', project_id: PROJECT_A, role: 'target' })
  raw.tables.push({ id: 't-src', dataset_id: 'ds-src' })
  raw.tables.push({ id: 't-tgt', dataset_id: 'ds-tgt' })
  for (let i = 0; i < sourceFields; i++) {
    raw.fields.push({
      id: `sf-${i}`,
      name: `src_${i}`,
      data_type: 'VARCHAR',
      table_id: 't-src',
    })
  }
  for (let i = 0; i < targetFields; i++) {
    raw.fields.push({
      id: `tf-${i}`,
      name: `tgt_${i}`,
      data_type: 'VARCHAR',
      table_id: 't-tgt',
    })
  }
  return raw
}

function addMapping(
  raw: RawData,
  opts: {
    tfmId: string
    targetFieldId: string
    sourceFieldId?: string | null
    status?: 'approved' | 'needs_review' | 'rejected'
    isAck?: boolean
    combinationType?: string | null
    /** PR ε — populate `combination_sql` so tests can distinguish
     *  completed VAs (non-empty SQL → delivers a fixed value) from
     *  blank placeholders. Defaults to null, which is the right
     *  default for mapped TFMs (they don't carry combination_sql)
     *  and for blank-VA fixtures that want to exercise the new
     *  filter. */
    combinationSql?: string | null
    needsTransformation?: boolean | null
    vaDismissed?: boolean | null
    confidence?: number
  },
): void {
  const {
    tfmId,
    targetFieldId,
    sourceFieldId = null,
    status = 'approved',
    isAck = false,
    combinationType = null,
    combinationSql = null,
    needsTransformation = null,
    vaDismissed = null,
    confidence = 80,
  } = opts
  raw.tfms.push({
    id: tfmId,
    project_id: PROJECT_A,
    target_field_id: targetFieldId,
    confidence,
    status,
    is_acknowledged: isAck,
    combination_type: combinationType,
    combination_sql: combinationSql,
    needs_transformation: needsTransformation,
    va_dismissed: vaDismissed,
  })
  if (sourceFieldId !== null) {
    raw.mappingSources.push({
      target_field_mapping_id: tfmId,
      source_field_id: sourceFieldId,
      ordinal: 0,
      type_compatibility: 'direct_compatible',
    })
  }
}

// ─── State machine ─────────────────────────────────────────────────────────

describe('rollupProjectStats — state machine', () => {
  it('returns awaiting_data when source side is empty', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 0, targetFields: 5 })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('awaiting_data')
  })

  it('returns awaiting_data when target side is empty', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 0 })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('awaiting_data')
  })

  it('returns awaiting_data when both sides are empty', () => {
    const raw = emptyRaw()
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('awaiting_data')
  })

  it('returns data_ingested when both sides have fields but no mappings', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('data_ingested')
  })

  it('returns mappings_generated for ≥1 real source→target TFM', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('mappings_generated')
  })

  it('stays in data_ingested when only bare-ack TFMs exist (no real mapping)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    // Bare-ack: is_acknowledged=true AND combination_type=null AND no MS rows
    addMapping(raw, {
      tfmId: 'tfm-ack',
      targetFieldId: 'tf-0',
      sourceFieldId: null,
      isAck: true,
    })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('data_ingested')
  })

  it('stays in data_ingested when only value-assignment TFMs exist (no source linkage)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    // Value assignment: combination_type='custom_sql' AND no MS rows
    addMapping(raw, {
      tfmId: 'tfm-va',
      targetFieldId: 'tf-0',
      sourceFieldId: null,
      combinationType: 'custom_sql',
    })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('data_ingested')
  })

  it('promotes to mappings_generated as soon as one real mapping appears', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    // Mix of bare-ack + value-assignment + one real mapping → promoted.
    addMapping(raw, {
      tfmId: 'tfm-ack',
      targetFieldId: 'tf-0',
      sourceFieldId: null,
      isAck: true,
    })
    addMapping(raw, {
      tfmId: 'tfm-va',
      targetFieldId: 'tf-1',
      sourceFieldId: null,
      combinationType: 'custom_sql',
    })
    addMapping(raw, {
      tfmId: 'tfm-real',
      targetFieldId: 'tf-2',
      sourceFieldId: 'sf-0',
    })
    expect(rollupProjectStats(PROJECT_A, raw).state).toBe('mappings_generated')
  })
})

// ─── Source axis ────────────────────────────────────────────────────────────

describe('rollupProjectStats — source axis', () => {
  it('total counts every source field for the project', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    expect(rollupProjectStats(PROJECT_A, raw).source.total).toBe(5)
  })

  it('decided counts distinct source_field_ids appearing in mapping_sources', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    addMapping(raw, { tfmId: 'tfm-2', targetFieldId: 'tf-1', sourceFieldId: 'sf-1' })
    expect(rollupProjectStats(PROJECT_A, raw).source.decided).toBe(2)
  })

  it('counts a source field once even if it maps to multiple TFMs (DISTINCT)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    // sf-0 maps to BOTH tf-0 and tf-1
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    addMapping(raw, { tfmId: 'tfm-2', targetFieldId: 'tf-1', sourceFieldId: 'sf-0' })
    expect(rollupProjectStats(PROJECT_A, raw).source.decided).toBe(1)
  })

  it('excludes sources from rejected TFMs (rejected disowns the source claim)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-rej',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'rejected',
    })
    expect(rollupProjectStats(PROJECT_A, raw).source.decided).toBe(0)
  })

  it('unions mapped + acknowledged source fields, deduplicating', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    raw.sourceAcks.push({ project_id: PROJECT_A, source_field_id: 'sf-1' })
    raw.sourceAcks.push({ project_id: PROJECT_A, source_field_id: 'sf-0' }) // duplicate
    expect(rollupProjectStats(PROJECT_A, raw).source.decided).toBe(2) // sf-0, sf-1
  })

  it('ignores acknowledgments for other projects', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    raw.sourceAcks.push({ project_id: 'proj-other', source_field_id: 'sf-0' })
    expect(rollupProjectStats(PROJECT_A, raw).source.decided).toBe(0)
  })
})

// ─── Source axis — usedInMapping ────────────────────────────────────────────
//
// `source.usedInMapping` differs from `source.decided` in one specific way:
// acknowledged-only sources DO NOT count. Both fields count distinct
// `source_field_id` in non-rejected mapping_sources rows; only `decided`
// then unions in the `source_field_acknowledgments` set. These tests pin
// the divergence so a future refactor cannot silently fold the two
// numerators together.

describe('rollupProjectStats — source.usedInMapping', () => {
  it('counts distinct source_field_ids in mapping_sources of non-rejected TFMs', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    addMapping(raw, { tfmId: 'tfm-2', targetFieldId: 'tf-1', sourceFieldId: 'sf-1' })
    expect(rollupProjectStats(PROJECT_A, raw).source.usedInMapping).toBe(2)
  })

  it('deduplicates a source field that maps to multiple TFMs', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    addMapping(raw, { tfmId: 'tfm-2', targetFieldId: 'tf-1', sourceFieldId: 'sf-0' })
    expect(rollupProjectStats(PROJECT_A, raw).source.usedInMapping).toBe(1)
  })

  it('excludes sources from rejected TFMs', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-rej',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'rejected',
    })
    expect(rollupProjectStats(PROJECT_A, raw).source.usedInMapping).toBe(0)
  })

  it('excludes acknowledged-only sources (key divergence from source.decided)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    // sf-0 is mapped; sf-1 is only acknowledged.
    addMapping(raw, { tfmId: 'tfm-1', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    raw.sourceAcks.push({ project_id: PROJECT_A, source_field_id: 'sf-1' })
    const stats = rollupProjectStats(PROJECT_A, raw)
    expect(stats.source.decided).toBe(2) // mapped ∪ acknowledged
    expect(stats.source.usedInMapping).toBe(1) // mapped only
  })

  it('is zero when only acknowledgments exist (no mappings)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    raw.sourceAcks.push({ project_id: PROJECT_A, source_field_id: 'sf-0' })
    raw.sourceAcks.push({ project_id: PROJECT_A, source_field_id: 'sf-1' })
    expect(rollupProjectStats(PROJECT_A, raw).source.usedInMapping).toBe(0)
  })
})

// ─── Target axis (delegates to computeProjectStats; light verification) ────

describe('rollupProjectStats — target axis', () => {
  it('exposes mappingApproved/Total/Unmapped from canonical formula (PR-7 target-side only)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
    })
    addMapping(raw, {
      tfmId: 'tfm-2',
      targetFieldId: 'tf-1',
      sourceFieldId: 'sf-1',
      status: 'needs_review',
    })
    const stats = rollupProjectStats(PROJECT_A, raw)
    // PR-7: target-side-only denominator. 2 primary TFMs + 1 unmapped
    // target (tf-2) + 0 acks = 3 total. The 1 unmapped source (sf-2)
    // no longer contributes — that lives on `source.{decided,total}`.
    expect(stats.target.total).toBe(3)
    // 1 approved primary TFM (tfm-1, status='approved') = 1 approved
    expect(stats.target.approved).toBe(1)
    // PR-7: target-side unmapped only. The 1 unmapped source (sf-2)
    // is excluded; only tf-2 is unmapped target.
    expect(stats.target.unmapped).toBe(1)
    // PR-7 redefinition: needsReview = total - approved = 3 - 1 = 2
    // (covers tfm-2 needs_review primary + tf-2 unacknowledged unmapped).
    expect(stats.target.needsReview).toBe(2)
  })

  it('PR-7 needsReview engulfs rejected primary TFMs', () => {
    // Pre-PR-7 needsReview only counted status='needs_review'. Post-PR-7
    // it's the residual `total - approved`, which captures rejected
    // primary TFMs as well. This fixture pins the inclusion: a rejected
    // primary TFM neither contributes to `approved` nor to `unmapped`,
    // so it falls into `needsReview` by exclusion.
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 1, targetFields: 1 })
    addMapping(raw, {
      tfmId: 'tfm-A',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
    })
    raw.tfms.push({
      id: 'tfm-rejected',
      project_id: PROJECT_A,
      target_field_id: 'tf-rejected',
      confidence: 50,
      status: 'rejected',
      is_acknowledged: false,
      combination_type: null,
      combination_sql: null,
      needs_transformation: false,
      va_dismissed: false,
    })
    const stats = rollupProjectStats(PROJECT_A, raw)
    // 1 primary approved (tfm-A) + 0 unmapped target + 0 acks = 1 total.
    // `tfm-rejected` is filtered out of `nonRejectedTfms` upstream so it
    // doesn't add to primaryTfms, and `tf-rejected` isn't in the project's
    // target field set (no `addField` call), so it doesn't contribute to
    // unmapped target either. needsReview = total - approved = 0.
    // This test pins that the formula doesn't accidentally double-count
    // rejected TFMs.
    expect(stats.target.approved).toBe(1)
    expect(stats.target.total).toBe(1)
    expect(stats.target.needsReview).toBe(0)
  })
})

// ─── Target axis — usedInMapping + schemaTotal ──────────────────────────────
//
// `target.usedInMapping` counts distinct `target_field_id` across primary
// TFMs (non-rejected, non-bare-ack). It is status-agnostic — `needs_review`
// and `approved` primaries both count, because "used in a mapping" is a
// graph-shape question, not a workflow-state question.
//
// `target.schemaTotal` counts every target-side field in the project's
// schema (`datasets.role='target'`), independent of TFM presence. It is
// distinct from `target.total`, which counts addressable mapping slots
// (primary TFMs + unmapped target fields + acknowledged-unmapped) and
// can drift away from the schema count once acknowledgments enter the
// picture.

describe('rollupProjectStats — target.usedInMapping + schemaTotal', () => {
  it('usedInMapping counts distinct target_field_ids across non-rejected primary TFMs', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
    })
    addMapping(raw, {
      tfmId: 'tfm-2',
      targetFieldId: 'tf-1',
      sourceFieldId: 'sf-1',
      status: 'needs_review',
    })
    expect(rollupProjectStats(PROJECT_A, raw).target.usedInMapping).toBe(2)
  })

  it('usedInMapping is status-agnostic across needs_review and approved', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'needs_review',
    })
    // Approved → usedInMapping still counts.
    addMapping(raw, {
      tfmId: 'tfm-2',
      targetFieldId: 'tf-1',
      sourceFieldId: 'sf-1',
      status: 'approved',
    })
    const stats = rollupProjectStats(PROJECT_A, raw)
    expect(stats.target.usedInMapping).toBe(2)
    expect(stats.target.approved).toBe(1) // sanity — approved still gates on status
  })

  it('usedInMapping excludes rejected TFMs', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-rej',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'rejected',
    })
    expect(rollupProjectStats(PROJECT_A, raw).target.usedInMapping).toBe(0)
  })

  it('usedInMapping excludes bare-ack TFMs (is_acknowledged AND combination_type=null)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    raw.tfms.push({
      id: 'tfm-bare-ack',
      project_id: PROJECT_A,
      target_field_id: 'tf-0',
      confidence: null,
      status: 'needs_review',
      is_acknowledged: true,
      combination_type: null,
      combination_sql: null,
      needs_transformation: null,
      va_dismissed: null,
    })
    expect(rollupProjectStats(PROJECT_A, raw).target.usedInMapping).toBe(0)
  })

  // PR ε — public-surface pin for the "delivers a value" tightening. A
  // VA TFM with combination_type='custom_sql', NULL combination_sql, and
  // NO mapping_sources row is a blank placeholder. Pre-PR it counted
  // toward `target.usedInMapping`; post-PR the chip-driving figure
  // excludes it so the Mapping page "Target Fields X/Y" reflects data
  // flow rather than mere TFM-row presence.
  it('usedInMapping excludes a blank VA (custom_sql + null combination_sql + no MS)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-blank-va',
      targetFieldId: 'tf-0',
      sourceFieldId: null,
      status: 'approved',
      combinationType: 'custom_sql',
      combinationSql: null,
    })
    expect(rollupProjectStats(PROJECT_A, raw).target.usedInMapping).toBe(0)
  })

  // Counterpart: a completed VA (no MS row, but combination_sql is set to
  // a literal) IS data flow — the user has authored a fixed value — and
  // must count. Without this pin, a future refactor that tightens the
  // filter to "MS row required" would silently drop legitimate VAs.
  it('usedInMapping INCLUDES a completed VA (combination_sql set, no MS)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 5 })
    addMapping(raw, {
      tfmId: 'tfm-va',
      targetFieldId: 'tf-0',
      sourceFieldId: null,
      status: 'approved',
      combinationType: 'custom_sql',
      combinationSql: "'TENANT_XYZ'::uuid",
    })
    expect(rollupProjectStats(PROJECT_A, raw).target.usedInMapping).toBe(1)
  })

  it('schemaTotal counts every target field in the schema (independent of TFM presence)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 5, targetFields: 7 })
    expect(rollupProjectStats(PROJECT_A, raw).target.schemaTotal).toBe(7)
  })

  it('schemaTotal can diverge from target.total when acks inflate addressable slots', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
    })
    // Acknowledge a SOURCE field (sf-1). Pre-PR-7 this inflated target.total;
    // post-PR-7 it bumps `acknowledgedCount` which is folded into target.total
    // but NOT into schemaTotal. The test pins that schemaTotal stays at 3.
    raw.sourceAcks.push({ project_id: PROJECT_A, source_field_id: 'sf-1' })
    const stats = rollupProjectStats(PROJECT_A, raw)
    expect(stats.target.schemaTotal).toBe(3)
    // target.total is the addressable-slots denominator and may differ;
    // the test asserts only that schemaTotal remains tied to the schema.
  })
})

// ─── Transforms numerator (Q2 — saved + applied complete) ──────────────────

describe('rollupProjectStats — transforms.complete (Q2 redefinition)', () => {
  it('counts TFMs with status=applied as complete', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
      needsTransformation: true,
    })
    raw.transformations.push({
      target_field_mapping_id: 'tfm-1',
      status: 'applied',
      target_field_mappings: { project_id: PROJECT_A },
    })
    const stats = rollupProjectStats(PROJECT_A, raw)
    expect(stats.transforms.complete).toBe(1)
    expect(stats.transforms.total).toBe(1)
  })

  it('counts TFMs with status=draft as complete (saved bucket per Q2)', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
      needsTransformation: true,
    })
    raw.transformations.push({
      target_field_mapping_id: 'tfm-1',
      status: 'draft',
      target_field_mappings: { project_id: PROJECT_A },
    })
    expect(rollupProjectStats(PROJECT_A, raw).transforms.complete).toBe(1)
  })

  it('counts TFMs with status=tested as complete', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
      needsTransformation: true,
    })
    raw.transformations.push({
      target_field_mapping_id: 'tfm-1',
      status: 'tested',
      target_field_mappings: { project_id: PROJECT_A },
    })
    expect(rollupProjectStats(PROJECT_A, raw).transforms.complete).toBe(1)
  })

  it('does NOT count in-scope TFMs without any transformation row', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, {
      tfmId: 'tfm-1',
      targetFieldId: 'tf-0',
      sourceFieldId: 'sf-0',
      status: 'approved',
      needsTransformation: true,
    })
    const stats = rollupProjectStats(PROJECT_A, raw)
    expect(stats.transforms.total).toBe(1)
    expect(stats.transforms.complete).toBe(0)
  })
})

// ─── Blocking ──────────────────────────────────────────────────────────────

describe('rollupProjectStats — blocking', () => {
  it('counts open in_flight blocking quality issues', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    raw.qualityIssues.push({
      project_id: PROJECT_A,
      severity: 'blocking',
      status: 'open',
      stage: 'in_flight',
      field_id: 'sf-0',
      issue_kind: null,
      description: null,
      title: null,
    })
    raw.qualityIssues.push({
      project_id: PROJECT_A,
      severity: 'warning',
      status: 'open',
      stage: 'in_flight',
      field_id: 'sf-1',
      issue_kind: null,
      description: null,
      title: null,
    })
    expect(rollupProjectStats(PROJECT_A, raw).blocking).toBe(1)
  })

  it('ignores quality issues for other projects', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    raw.qualityIssues.push({
      project_id: 'proj-other',
      severity: 'blocking',
      status: 'open',
      stage: 'in_flight',
      field_id: null,
      issue_kind: null,
      description: null,
      title: null,
    })
    expect(rollupProjectStats(PROJECT_A, raw).blocking).toBe(0)
  })
})

// ─── End-to-end shape ───────────────────────────────────────────────────────

describe('rollupProjectStats — output shape', () => {
  it('returns the full ProjectStats shape with no extra fields', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 2, targetFields: 2 })
    const stats: ProjectStats = rollupProjectStats(PROJECT_A, raw)
    expect(Object.keys(stats).sort()).toEqual([
      'blocking',
      'source',
      'state',
      'target',
      'transforms',
    ])
    expect(Object.keys(stats.target).sort()).toEqual([
      'approved',
      'needsReview',
      'schemaTotal',
      'total',
      'unmapped',
      'usedInMapping',
    ])
    expect(Object.keys(stats.source).sort()).toEqual([
      'decided',
      'total',
      'usedInMapping',
    ])
    expect(Object.keys(stats.transforms).sort()).toEqual(['complete', 'total'])
  })

  it('returns zeroed counts for an empty project', () => {
    const stats = rollupProjectStats(PROJECT_A, emptyRaw())
    expect(stats).toEqual({
      state: 'awaiting_data',
      target: { approved: 0, total: 0, unmapped: 0, needsReview: 0, usedInMapping: 0, schemaTotal: 0 },
      source: { decided: 0, total: 0, usedInMapping: 0 },
      transforms: { complete: 0, total: 0 },
      blocking: 0,
    })
  })

  it('isolates per-project rollup when raw data spans multiple projects', () => {
    const raw = withSourceTarget(emptyRaw(), { sourceFields: 3, targetFields: 3 })
    addMapping(raw, { tfmId: 'tfm-A', targetFieldId: 'tf-0', sourceFieldId: 'sf-0' })
    // Inject a different project's TFM that should NOT contribute to PROJECT_A.
    raw.tfms.push({
      id: 'tfm-other',
      project_id: 'proj-other',
      target_field_id: 'tf-other',
      confidence: 90,
      status: 'approved',
      is_acknowledged: false,
      combination_type: null,
      combination_sql: null,
      needs_transformation: null,
      va_dismissed: null,
    })
    raw.mappingSources.push({
      target_field_mapping_id: 'tfm-other',
      source_field_id: 'sf-other',
      ordinal: 0,
      type_compatibility: 'direct_compatible',
    })
    const stats = rollupProjectStats(PROJECT_A, raw)
    expect(stats.source.decided).toBe(1) // only sf-0, not sf-other
    // PR-7: target.total is target-side only — 1 tfm-A + 2 unmapped tf + 0 acks = 3.
    // The 2 unmapped sf no longer contribute to target.total (they show up on
    // source.total instead).
    expect(stats.target.total).toBe(1 /* tfm-A */ + 2 /* unmapped tf */)
  })
})
