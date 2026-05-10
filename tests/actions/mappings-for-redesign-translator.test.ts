// @vitest-environment node
//
// Phase 3 Gap 4b — unit tests for the pure assembly function in
// `lib/actions/_mappings-for-redesign-core.ts`.
//
// Each case exercises one invariant from design doc §7.1. The
// fixtures are in-memory and minimal — they set exactly the columns
// needed to drive the assembly branch under test and leave everything
// else at DB-consistent defaults. Where possible, shapes mirror
// `tests/fixtures/outputs/seed.ts` (the outputs-golden fixture) to
// keep the mental model consistent.

import { describe, it, expect } from 'vitest'

import {
  assembleMappingsForRedesign,
  type AssembleInput,
  type RawDatasetRow,
  type RawFieldRow,
  type RawMappingSourceRow,
  type RawSourceAckRow,
  type RawTableRow,
  type RawTfmRow,
  type RawTransformationRow,
} from '@/lib/ai/mapping-engine'
import type {
  MappedRow,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─── Fixture helpers ─────────────────────────────────────────────────

const PROJECT_ID = 'proj-0001'
const DS_SOURCE: RawDatasetRow = { id: 'ds-src', role: 'source', name: 'CRM' }
const DS_TARGET: RawDatasetRow = { id: 'ds-tgt', role: 'target', name: 'DWH' }

const TBL_S_CUST: RawTableRow = { id: 'tbl-s-cust', dataset_id: DS_SOURCE.id, name: 'customers' }
const TBL_S_ORD: RawTableRow = { id: 'tbl-s-ord', dataset_id: DS_SOURCE.id, name: 'orders' }
const TBL_T_CUST: RawTableRow = { id: 'tbl-t-cust', dataset_id: DS_TARGET.id, name: 'dim_customer' }
const TBL_T_ORD: RawTableRow = { id: 'tbl-t-ord', dataset_id: DS_TARGET.id, name: 'fct_order' }

function field(partial: Partial<RawFieldRow> & Pick<RawFieldRow, 'id' | 'table_id' | 'name' | 'data_type' | 'ordinal_position'>): RawFieldRow {
  return {
    is_nullable: true,
    is_primary_key: false,
    is_foreign_key: false,
    fk_reference: null,
    default_value: null,
    field_profiles: null,
    ...partial,
  }
}

// Source fields
const F_S_CUSTID = field({ id: 'f-s-custid', table_id: TBL_S_CUST.id, name: 'CustomerID', data_type: 'INT', ordinal_position: 1, is_primary_key: true, is_nullable: false })
const F_S_FIRST = field({ id: 'f-s-first', table_id: TBL_S_CUST.id, name: 'FirstName', data_type: 'VARCHAR(50)', ordinal_position: 2,
  field_profiles: [{ field_id: 'f-s-first', sample_values: ['Alice', 'Bob', 'Carol', 'Dora'] }] })
const F_S_LAST = field({ id: 'f-s-last', table_id: TBL_S_CUST.id, name: 'LastName', data_type: 'VARCHAR(50)', ordinal_position: 3,
  field_profiles: [{ field_id: 'f-s-last', sample_values: ['Smith', 'Jones'] }] })
const F_S_CONTACTFK = field({ id: 'f-s-contactfk', table_id: TBL_S_CUST.id, name: 'PrimaryContactID', data_type: 'INT', ordinal_position: 4,
  is_foreign_key: true, fk_reference: 'orders.ContactID' })
const F_S_ORDID = field({ id: 'f-s-ordid', table_id: TBL_S_ORD.id, name: 'ContactID', data_type: 'INT', ordinal_position: 1, is_primary_key: true, is_nullable: false })
const F_S_ORDTOTAL = field({ id: 'f-s-ordtotal', table_id: TBL_S_ORD.id, name: 'TotalCents', data_type: 'INT', ordinal_position: 2 })

// Target fields
const F_T_CUSTID = field({ id: 'f-t-custid', table_id: TBL_T_CUST.id, name: 'customer_id', data_type: 'INT', ordinal_position: 1, is_nullable: false })
const F_T_FULLNAME = field({ id: 'f-t-fullname', table_id: TBL_T_CUST.id, name: 'full_name', data_type: 'VARCHAR(200)', ordinal_position: 2 })
const F_T_TENANT = field({ id: 'f-t-tenant', table_id: TBL_T_CUST.id, name: 'tenant_id', data_type: 'UUID', ordinal_position: 3, default_value: 'gen_random_uuid()' })
const F_T_NOTES = field({ id: 'f-t-notes', table_id: TBL_T_CUST.id, name: 'notes', data_type: 'TEXT', ordinal_position: 4 })
const F_T_LEGACY = field({ id: 'f-t-legacy', table_id: TBL_T_CUST.id, name: 'legacy_flag', data_type: 'BOOLEAN', ordinal_position: 5 })
const F_T_ORDCONTACT = field({ id: 'f-t-ordcontact', table_id: TBL_T_ORD.id, name: 'contact_id', data_type: 'INT', ordinal_position: 1 })
const F_T_ORDTOTAL = field({ id: 'f-t-ordtotal', table_id: TBL_T_ORD.id, name: 'total_dollars', data_type: 'NUMERIC(10,2)', ordinal_position: 2 })

function tfm(partial: Partial<RawTfmRow> & Pick<RawTfmRow, 'id' | 'target_field_id'>): RawTfmRow {
  return {
    confidence: 85,
    status: 'approved',
    ai_reasoning: null,
    is_acknowledged: false,
    acknowledgment_reason: null,
    combination_type: 'single',
    combination_sql: null,
    ...partial,
  }
}

function ms(partial: Partial<RawMappingSourceRow> & Pick<RawMappingSourceRow, 'id' | 'target_field_mapping_id' | 'source_field_id' | 'source_table_id' | 'ordinal'>): RawMappingSourceRow {
  return {
    confidence: 85,
    ai_reasoning: null,
    type_compatibility: null,
    join_spec: null,
    ...partial,
  }
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    projectId: PROJECT_ID,
    datasets: [DS_SOURCE, DS_TARGET],
    tables: [TBL_S_CUST, TBL_S_ORD, TBL_T_CUST, TBL_T_ORD],
    fields: [
      F_S_CUSTID, F_S_FIRST, F_S_LAST, F_S_CONTACTFK, F_S_ORDID, F_S_ORDTOTAL,
      F_T_CUSTID, F_T_FULLNAME, F_T_TENANT, F_T_NOTES, F_T_LEGACY, F_T_ORDCONTACT, F_T_ORDTOTAL,
    ],
    tfms: [],
    mappingSources: [],
    sourceAcks: [],
    transformations: [],
    ...overrides,
  }
}

// ─── Tests (11 cases per design §7.1) ────────────────────────────────

describe('assembleMappingsForRedesign — discriminator cases', () => {
  // Case 1 ------------------------------------------------------------
  it('case 1: single-source mapped row (Rule 1)', () => {
    const t1 = tfm({
      id: 'tfm-1',
      target_field_id: F_T_CUSTID.id,
      combination_type: 'single',
      confidence: 95,
    })
    const m1 = ms({
      id: 'ms-1',
      target_field_mapping_id: 'tfm-1',
      source_field_id: F_S_CUSTID.id,
      source_table_id: F_S_CUSTID.table_id,
      ordinal: 0,
      confidence: 95,
    })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t1], mappingSources: [m1] }))
    const row = out.rows.find((r) => r.id === 'tfm-1') as MappedRow
    expect(row.kind).toBe('mapped')
    expect(row.combinationType).toBe('single')
    expect(row.sources).toHaveLength(1)
    expect(row.sources[0].sourceField.name).toBe('CustomerID')
    expect(row.sources[0].joinAnnotation).toBeNull()
    expect(row.sources[0].joinSpec).toBeNull()
    expect(row.confidence).toBe(95)
  })

  // Case 2 ------------------------------------------------------------
  it('case 2: multi-source same-table concat mapped row (Rule 2)', () => {
    const t2 = tfm({
      id: 'tfm-2',
      target_field_id: F_T_FULLNAME.id,
      combination_type: 'concat_space',
      confidence: 85,
    })
    const m2a = ms({ id: 'ms-2a', target_field_mapping_id: 'tfm-2', source_field_id: F_S_FIRST.id, source_table_id: F_S_FIRST.table_id, ordinal: 0 })
    const m2b = ms({ id: 'ms-2b', target_field_mapping_id: 'tfm-2', source_field_id: F_S_LAST.id, source_table_id: F_S_LAST.table_id, ordinal: 1 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t2], mappingSources: [m2a, m2b] }))
    const row = out.rows.find((r) => r.id === 'tfm-2') as MappedRow
    expect(row.kind).toBe('mapped')
    expect(row.combinationType).toBe('concat_space')
    expect(row.sources.map((s) => s.ordinal)).toEqual([0, 1])
    // Gap 6 (2026-04-24): wire cap raised from 3 → 10. Input of 4
    // flows through unchanged since it's below the cap.
    expect(row.sources[0].sampleValues).toEqual(['Alice', 'Bob', 'Carol', 'Dora'])
    expect(row.sources.every((s) => s.joinAnnotation === null)).toBe(true)
  })

  // Case 3 ------------------------------------------------------------
  it('case 3: value assignment row (custom_sql with zero sources)', () => {
    const t3 = tfm({
      id: 'tfm-3',
      target_field_id: F_T_TENANT.id,
      combination_type: 'custom_sql',
      combination_sql: "'00000000-0000-0000-0000-000000000000'",
      confidence: 100,
    })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t3], mappingSources: [] }))
    const row = out.rows.find((r) => r.id === 'tfm-3') as ValueAssignmentRow
    expect(row.kind).toBe('value_assignment')
    expect(row.combinationType).toBe('custom_sql')
    expect(row.combinationSql).toBe("'00000000-0000-0000-0000-000000000000'")
    expect(row.confidence).toBe(100)
  })

  // Case 4 ------------------------------------------------------------
  // INF-57: legacy bare-ack TFM (is_acknowledged=true, combination_type=NULL)
  // is absorbed under UnmappedRow. Migration 098 backfilled paired coverage
  // rows (status='approved', status_set_by='user', coverage_status='gap'),
  // so the surface is fully driven off the coverage row. Row id is the
  // synthetic `unmapped::<targetFieldId>` format, NOT the bare-ack TFM's UUID.
  // The translator's bare-ack branch routes through `buildUnmappedRow`, which
  // sources status/statusSetBy/coverageStatus from the coverage row.
  it('case 4: legacy bare-ack TFM emits UnmappedRow driven by paired coverage row', () => {
    const t4 = tfm({
      id: 'tfm-4',
      target_field_id: F_T_NOTES.id,
      combination_type: null,
      is_acknowledged: true,
      acknowledgment_reason: 'populated downstream by legacy process',
      confidence: null,
    })
    // Migration 098 backfill: every legacy bare-ack TFM has a paired
    // coverage row with status='approved', status_set_by='user'.
    const cov4 = {
      id: 'cov-4',
      target_field_id: F_T_NOTES.id,
      coverage_status: 'gap',
      status: 'approved',
      status_set_by: 'user',
      confidence: null,
    }
    const out = assembleMappingsForRedesign(
      baseInput({ tfms: [t4], coverage: [cov4] }),
    )
    const row = out.rows.find(
      (r) => r.targetField.id === F_T_NOTES.id,
    ) as UnmappedRow
    expect(row.kind).toBe('unmapped')
    expect(row.id).toBe(`unmapped::${F_T_NOTES.id}`)
    expect(row.status).toBe('approved')
    expect(row.statusSetBy).toBe('user')
    expect(row.coverageStatus).toBe('gap')
    expect(row.confidence).toBeNull()
    expect(row.hasTransformation).toBe(false)
    expect(row.mapping_content).toBe('no-source')
  })

  // Case 5 ------------------------------------------------------------
  it('case 5: unmapped row (target field with no TFM) uses sentinel id', () => {
    const out = assembleMappingsForRedesign(baseInput({ tfms: [] }))
    const row = out.rows.find((r) => r.targetField.id === F_T_LEGACY.id) as UnmappedRow
    expect(row.kind).toBe('unmapped')
    expect(row.id).toBe(`unmapped::${F_T_LEGACY.id}`)
    // PR γ resolution priority — orphan target field (no TFM, no
    // coverage row) emits synthesized status 'needs_review' with
    // statusSetBy='system_default'. The 'unmapped' literal is retained
    // in the type union for back-compat with fixture builders + the
    // optimistic-reject construction in MappingContent.tsx, but the
    // translator never emits it for live wire data.
    expect(row.status).toBe('needs_review')
    expect(row.statusSetBy).toBe('system_default')
    expect(row.coverageStatus).toBeNull()
    expect(row.mapping_content).toBe('no-source')
    expect(row.confidence).toBeNull()
  })

  // Case 6 ------------------------------------------------------------
  it('case 6: cross-table mapped row emits joinAnnotation via FK inference', () => {
    // dim_customer.contact_id ← orders.ContactID, but the dominant
    // source is customers (ordinal=0). customers.PrimaryContactID
    // FK→orders, so the annotation is "(join: PrimaryContactID)".
    const t6 = tfm({
      id: 'tfm-6',
      target_field_id: F_T_FULLNAME.id,
      combination_type: 'concat_space',
      confidence: 80,
    })
    const m6a = ms({ id: 'ms-6a', target_field_mapping_id: 'tfm-6', source_field_id: F_S_FIRST.id, source_table_id: F_S_FIRST.table_id, ordinal: 0 })
    const m6b = ms({ id: 'ms-6b', target_field_mapping_id: 'tfm-6', source_field_id: F_S_ORDTOTAL.id, source_table_id: F_S_ORDTOTAL.table_id, ordinal: 1 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t6], mappingSources: [m6a, m6b] }))
    const row = out.rows.find((r) => r.id === 'tfm-6') as MappedRow
    expect(row.sources[0].joinAnnotation).toBeNull() // dominant (customers) → no annotation
    expect(row.sources[1].joinAnnotation).toBe('(join: PrimaryContactID)')
  })

  // Case 7 ------------------------------------------------------------
  it('case 7: cross-table mapped row falls back to join_spec when FK inference misses', () => {
    // Remove the FK annotation on PrimaryContactID so FK inference
    // fails; provide an explicit join_spec on the orders source.
    const fieldsNoFk = baseInput().fields.map((f) =>
      f.id === F_S_CONTACTFK.id
        ? { ...f, is_foreign_key: false, fk_reference: null }
        : f,
    )
    const t7 = tfm({
      id: 'tfm-7',
      target_field_id: F_T_FULLNAME.id,
      combination_type: 'concat_space',
    })
    const m7a = ms({ id: 'ms-7a', target_field_mapping_id: 'tfm-7', source_field_id: F_S_FIRST.id, source_table_id: F_S_FIRST.table_id, ordinal: 0 })
    const m7b = ms({
      id: 'ms-7b',
      target_field_mapping_id: 'tfm-7',
      source_field_id: F_S_ORDTOTAL.id,
      source_table_id: F_S_ORDTOTAL.table_id,
      ordinal: 1,
      join_spec: {
        via_source_table: 'customers',
        via_fk_field: 'ExplicitFkName',
        to_fk_field: 'ContactID',
      },
    })
    const out = assembleMappingsForRedesign({
      ...baseInput(),
      fields: fieldsNoFk,
      tfms: [t7],
      mappingSources: [m7a, m7b],
    })
    const row = out.rows.find((r) => r.id === 'tfm-7') as MappedRow
    expect(row.sources[1].joinAnnotation).toBe('(join: ExplicitFkName)')
    expect(row.sources[1].joinSpec).toEqual({
      viaSourceTable: 'customers',
      viaFkField: 'ExplicitFkName',
      toFkField: 'ContactID',
    })
  })

  // Case 8 ------------------------------------------------------------
  it('case 8: transformation presence and status flow through to hasTransformation/transformationStatus', () => {
    const t8 = tfm({ id: 'tfm-8', target_field_id: F_T_CUSTID.id })
    const m8 = ms({ id: 'ms-8', target_field_mapping_id: 'tfm-8', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const tr8: RawTransformationRow = {
      id: 'tr-8',
      target_field_mapping_id: 'tfm-8',
      status: 'applied',
      description: 'Trim whitespace from id',
      generated_sql: 'TRIM(src.CustomerID)',
    }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t8], mappingSources: [m8], transformations: [tr8] }))
    const row = out.rows.find((r) => r.id === 'tfm-8') as MappedRow
    expect(row.hasTransformation).toBe(true)
    expect(row.transformationStatus).toBe('applied')
  })

  it('case 8b: null DB transformation status coerces to draft when a row exists', () => {
    const t = tfm({ id: 'tfm-8b', target_field_id: F_T_CUSTID.id })
    const m = ms({ id: 'ms-8b', target_field_mapping_id: 'tfm-8b', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const tr: RawTransformationRow = {
      id: 'tr-8b',
      target_field_mapping_id: 'tfm-8b',
      status: null,
      description: null,
      generated_sql: null,
    }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m], transformations: [tr] }))
    const row = out.rows.find((r) => r.id === 'tfm-8b') as MappedRow
    expect(row.hasTransformation).toBe(true)
    expect(row.transformationStatus).toBe('draft')
  })

  // Case 8c — drawer redesign Q11.E lock (2026-04-26): description +
  // SQL preview flow through to MappingRowBase.
  it('case 8c: transformation description and SQL preview flow through to MappingRowBase (mapped row)', () => {
    const t = tfm({ id: 'tfm-8c', target_field_id: F_T_CUSTID.id })
    const m = ms({ id: 'ms-8c', target_field_mapping_id: 'tfm-8c', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const tr: RawTransformationRow = {
      id: 'tr-8c',
      target_field_mapping_id: 'tfm-8c',
      status: 'applied',
      description: 'Cast to VARCHAR and uppercase',
      generated_sql: 'UPPER(CAST(src.CustomerID AS VARCHAR))',
    }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m], transformations: [tr] }))
    const row = out.rows.find((r) => r.id === 'tfm-8c') as MappedRow
    expect(row.transformationDescription).toBe('Cast to VARCHAR and uppercase')
    expect(row.transformationSqlPreview).toBe('UPPER(CAST(src.CustomerID AS VARCHAR))')
  })

  it('case 8d: transformationSqlPreview is server-truncated to 300 chars with trailing ellipsis', () => {
    const t = tfm({ id: 'tfm-8d', target_field_id: F_T_CUSTID.id })
    const m = ms({ id: 'ms-8d', target_field_mapping_id: 'tfm-8d', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const longSql = 'A'.repeat(500)
    const tr: RawTransformationRow = {
      id: 'tr-8d',
      target_field_mapping_id: 'tfm-8d',
      status: 'draft',
      description: null,
      generated_sql: longSql,
    }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m], transformations: [tr] }))
    const row = out.rows.find((r) => r.id === 'tfm-8d') as MappedRow
    // 300 chars of payload + the trailing ellipsis character.
    expect(row.transformationSqlPreview).toHaveLength(301)
    expect(row.transformationSqlPreview?.endsWith('…')).toBe(true)
    expect(row.transformationSqlPreview?.startsWith('AAAA')).toBe(true)
  })

  it('case 8e: empty / null SQL on the transformation row yields a null preview', () => {
    const t = tfm({ id: 'tfm-8e', target_field_id: F_T_CUSTID.id })
    const m = ms({ id: 'ms-8e', target_field_mapping_id: 'tfm-8e', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const tr: RawTransformationRow = {
      id: 'tr-8e',
      target_field_mapping_id: 'tfm-8e',
      status: 'draft',
      description: null,
      generated_sql: '',
    }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m], transformations: [tr] }))
    const row = out.rows.find((r) => r.id === 'tfm-8e') as MappedRow
    expect(row.transformationSqlPreview).toBeNull()
    expect(row.transformationDescription).toBeNull()
  })

  it('case 8f: rows with no transformation row carry null description and null SQL preview across all kinds', () => {
    const t = tfm({ id: 'tfm-8f', target_field_id: F_T_CUSTID.id })
    const m = ms({ id: 'ms-8f', target_field_mapping_id: 'tfm-8f', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m], transformations: [] }))
    const mapped = out.rows.find((r) => r.id === 'tfm-8f') as MappedRow
    expect(mapped.transformationDescription).toBeNull()
    expect(mapped.transformationSqlPreview).toBeNull()

    // Every unmapped row in the same payload has the same nulls.
    const someUnmapped = out.rows.find((r) => r.kind === 'unmapped')
    expect(someUnmapped?.transformationDescription).toBeNull()
    expect(someUnmapped?.transformationSqlPreview).toBeNull()
  })

  // Case 9 ------------------------------------------------------------
  it('case 9: rejected TFM is still rendered as a mapped row with status=rejected', () => {
    const t9 = tfm({ id: 'tfm-9', target_field_id: F_T_CUSTID.id, status: 'rejected' })
    const m9 = ms({ id: 'ms-9', target_field_mapping_id: 'tfm-9', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t9], mappingSources: [m9] }))
    const row = out.rows.find((r) => r.id === 'tfm-9') as MappedRow
    expect(row.kind).toBe('mapped')
    expect(row.status).toBe('rejected')
    expect(out.counts.rejected).toBe(1)
  })

  // Case 10 -----------------------------------------------------------
  it('case 10: row ordering is (table.name ASC, field.ordinalPosition ASC, field.name ASC)', () => {
    // With no TFMs, every target field becomes an unmapped row. Confirm
    // ordering across both target tables.
    const out = assembleMappingsForRedesign(baseInput({ tfms: [] }))
    const orderedIds = out.rows.map((r) => r.targetField.id)
    // dim_customer (table name comes first alphabetically) fields in
    // ordinal order, then fct_order.
    expect(orderedIds).toEqual([
      F_T_CUSTID.id,
      F_T_FULLNAME.id,
      F_T_TENANT.id,
      F_T_NOTES.id,
      F_T_LEGACY.id,
      F_T_ORDCONTACT.id,
      F_T_ORDTOTAL.id,
    ])
  })

  // Case 11 -----------------------------------------------------------
  it('case 11: counts and filter universes are populated correctly', () => {
    const tA = tfm({ id: 'tfm-a', target_field_id: F_T_CUSTID.id, status: 'approved' })
    const mA = ms({ id: 'ms-a', target_field_mapping_id: 'tfm-a', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const tB = tfm({ id: 'tfm-b', target_field_id: F_T_NOTES.id, is_acknowledged: true, combination_type: null, confidence: null, acknowledgment_reason: 'n/a' })
    // INF-57: legacy bare-ack TFM tB is paired with a migration-098-backfilled
    // coverage row carrying status='approved'+status_set_by='user'. Without
    // it, tB falls into the orphan branch (status='needs_review') and the
    // approved count drops to 1.
    const covB = {
      id: 'cov-b',
      target_field_id: F_T_NOTES.id,
      coverage_status: 'gap',
      status: 'approved',
      status_set_by: 'user',
      confidence: null,
    }
    const ack: RawSourceAckRow = { id: 'ack-1', source_field_id: F_S_ORDTOTAL.id, reason: 'deprecated' }
    const out = assembleMappingsForRedesign(baseInput({
      tfms: [tA, tB],
      mappingSources: [mA],
      coverage: [covB],
      sourceAcks: [ack],
    }))
    expect(out.counts.total).toBe(7)       // 7 target fields
    expect(out.counts.approved).toBe(2)    // tfm-a (mapped) + tfm-b (bare-ack via coverage)
    expect(out.counts.needsReview).toBe(0)
    expect(out.counts.rejected).toBe(0)
    expect(out.counts.unmapped).toBe(5)    // 7 - 2

    expect(out.targetTables.map((t) => t.name)).toEqual(['dim_customer', 'fct_order'])
    expect(out.targetTables[0].fieldCount).toBe(5)
    expect(out.sourceTables.map((t) => t.name)).toEqual(['customers', 'orders'])
    expect(out.sourceFieldAcknowledgments).toEqual([
      { id: 'ack-1', sourceFieldId: F_S_ORDTOTAL.id, reason: 'deprecated' },
    ])
    expect(out.targetSchemaEmpty).toBe(false)
  })

  it('case 11b: empty target schema sets targetSchemaEmpty=true', () => {
    const out = assembleMappingsForRedesign(baseInput({
      tables: [TBL_S_CUST, TBL_S_ORD], // no target tables
      fields: [F_S_CUSTID, F_S_FIRST, F_S_LAST, F_S_CONTACTFK, F_S_ORDID, F_S_ORDTOTAL],
    }))
    expect(out.rows).toEqual([])
    expect(out.targetSchemaEmpty).toBe(true)
    expect(out.targetTables).toEqual([])
  })

  // ─── Gap 6 ────────────────────────────────────────────────────────────
  //
  // Sample-values wire cap. Locked at 10 per founder decision (2026-04-24);
  // UI previews first 3 and exposes remainder via `+N more`. Source of truth
  // is `MAX_SAMPLE_VALUES` in `_mappings-for-redesign-core.ts` — any change
  // there must update both `MappingSourceRef.sampleValues` JSDoc and this
  // test in lockstep.

  it('case 12a: sampleValues capped at 10 when DB has more', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `v${i + 1}`)
    const F_S_OVERFLOW = field({
      id: 'f-s-overflow',
      table_id: TBL_S_CUST.id,
      name: 'OverflowField',
      data_type: 'VARCHAR(50)',
      ordinal_position: 99,
      field_profiles: [{ field_id: 'f-s-overflow', sample_values: fifteen }],
    })
    const t = tfm({
      id: 'tfm-overflow',
      target_field_id: F_T_FULLNAME.id,
      combination_type: 'single',
    })
    const m = ms({
      id: 'ms-overflow',
      target_field_mapping_id: 'tfm-overflow',
      source_field_id: F_S_OVERFLOW.id,
      source_table_id: F_S_OVERFLOW.table_id,
      ordinal: 0,
    })
    const out = assembleMappingsForRedesign(
      baseInput({
        fields: [
          F_S_CUSTID, F_S_FIRST, F_S_LAST, F_S_CONTACTFK, F_S_ORDID, F_S_ORDTOTAL, F_S_OVERFLOW,
          F_T_CUSTID, F_T_FULLNAME, F_T_TENANT, F_T_NOTES, F_T_LEGACY, F_T_ORDCONTACT, F_T_ORDTOTAL,
        ],
        tfms: [t],
        mappingSources: [m],
      }),
    )
    const row = out.rows.find((r) => r.id === 'tfm-overflow') as MappedRow
    expect(row.sources[0].sampleValues).toHaveLength(10)
    expect(row.sources[0].sampleValues).toEqual([
      'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10',
    ])
  })

  it('case 12b: sampleValues passes through when DB has exactly 10 (no truncation, no pad)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `v${i + 1}`)
    const F_S_TEN = field({
      id: 'f-s-ten',
      table_id: TBL_S_CUST.id,
      name: 'TenField',
      data_type: 'VARCHAR(50)',
      ordinal_position: 98,
      field_profiles: [{ field_id: 'f-s-ten', sample_values: ten }],
    })
    const t = tfm({
      id: 'tfm-ten',
      target_field_id: F_T_FULLNAME.id,
      combination_type: 'single',
    })
    const m = ms({
      id: 'ms-ten',
      target_field_mapping_id: 'tfm-ten',
      source_field_id: F_S_TEN.id,
      source_table_id: F_S_TEN.table_id,
      ordinal: 0,
    })
    const out = assembleMappingsForRedesign(
      baseInput({
        fields: [
          F_S_CUSTID, F_S_FIRST, F_S_LAST, F_S_CONTACTFK, F_S_ORDID, F_S_ORDTOTAL, F_S_TEN,
          F_T_CUSTID, F_T_FULLNAME, F_T_TENANT, F_T_NOTES, F_T_LEGACY, F_T_ORDCONTACT, F_T_ORDTOTAL,
        ],
        tfms: [t],
        mappingSources: [m],
      }),
    )
    const row = out.rows.find((r) => r.id === 'tfm-ten') as MappedRow
    expect(row.sources[0].sampleValues).toEqual(ten)
  })

  // ─── Gap 11b — sourceFields contract extension ──────────────────────────
  //
  // Source schema sidebar (`MappingsForRedesignResult.sourceFields`) is a
  // server-assembled view over every source field in the project, decorated
  // with mapping state and sample values. Founder-locked semantics:
  //   • mappingStatus='mapped' iff the field appears in mapping_sources for
  //     a non-rejected TFM.
  //   • Rejected TFMs do NOT claim contributing sources as mapped.
  //   • isAcknowledged plumbs through `source_field_acknowledgments` rows
  //     (no visual treatment in Gap 11b — Gap 11c will design it).
  //   • Server emits canonical order: (sourceTable.name ASC,
  //     ordinalPosition ASC, name ASC).
  //   • Always present (possibly empty array) — never `null`.

  it('case 13a: sourceFields contains every source field with status + samples', () => {
    const out = assembleMappingsForRedesign(baseInput({ tfms: [] }))
    expect(out.sourceFields).toHaveLength(6)
    const byId = new Map(out.sourceFields.map((f) => [f.id, f]))
    const first = byId.get(F_S_FIRST.id)!
    expect(first.name).toBe('FirstName')
    expect(first.dataType).toBe('VARCHAR(50)')
    expect(first.sourceTable).toEqual({ id: TBL_S_CUST.id, name: 'customers' })
    expect(first.sampleValues).toEqual(['Alice', 'Bob', 'Carol', 'Dora'])
    expect(first.mappingStatus).toBe('unmapped')
    expect(first.isAcknowledged).toBe(false)
  })

  it('case 13b: mappingStatus="mapped" for fields contributing to non-rejected TFMs', () => {
    const t = tfm({ id: 'tfm-13b', target_field_id: F_T_CUSTID.id, status: 'approved' })
    const m = ms({ id: 'ms-13b', target_field_mapping_id: 'tfm-13b', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m] }))
    const cust = out.sourceFields.find((f) => f.id === F_S_CUSTID.id)!
    expect(cust.mappingStatus).toBe('mapped')
    const others = out.sourceFields.filter((f) => f.id !== F_S_CUSTID.id)
    others.forEach((f) => expect(f.mappingStatus).toBe('unmapped'))
  })

  it('case 13c: mappingStatus="mapped" includes needs_review TFMs', () => {
    const t = tfm({ id: 'tfm-13c', target_field_id: F_T_CUSTID.id, status: 'needs_review' })
    const m = ms({ id: 'ms-13c', target_field_mapping_id: 'tfm-13c', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m] }))
    const cust = out.sourceFields.find((f) => f.id === F_S_CUSTID.id)!
    expect(cust.mappingStatus).toBe('mapped')
  })

  it('case 13d: rejected TFMs do NOT claim their sources as mapped', () => {
    // Founder-locked decision 2 (Gap 11b): rejected TFMs are
    // explicitly excluded from the mapped set. Defends against the
    // legacy SimpleLegal rejected row + any future write path that
    // retains rejected TFMs.
    const t = tfm({ id: 'tfm-13d', target_field_id: F_T_CUSTID.id, status: 'rejected' })
    const m = ms({ id: 'ms-13d', target_field_mapping_id: 'tfm-13d', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m] }))
    const cust = out.sourceFields.find((f) => f.id === F_S_CUSTID.id)!
    expect(cust.mappingStatus).toBe('unmapped')
  })

  it('case 13e: isAcknowledged reflects source_field_acknowledgments rows', () => {
    const ack: RawSourceAckRow = { id: 'ack-13e', source_field_id: F_S_ORDTOTAL.id, reason: 'deprecated' }
    const out = assembleMappingsForRedesign(baseInput({ sourceAcks: [ack] }))
    const ordTotal = out.sourceFields.find((f) => f.id === F_S_ORDTOTAL.id)!
    expect(ordTotal.isAcknowledged).toBe(true)
    const others = out.sourceFields.filter((f) => f.id !== F_S_ORDTOTAL.id)
    others.forEach((f) => expect(f.isAcknowledged).toBe(false))
  })

  it('case 13f: server emits canonical order (sourceTable.name ASC, ordinal ASC, name ASC)', () => {
    const out = assembleMappingsForRedesign(baseInput({ tfms: [] }))
    expect(out.sourceFields.map((f) => `${f.sourceTable.name}.${f.name}`)).toEqual([
      'customers.CustomerID',
      'customers.FirstName',
      'customers.LastName',
      'customers.PrimaryContactID',
      'orders.ContactID',
      'orders.TotalCents',
    ])
  })

  it('case 13g: sourceFields is always an array (empty when no source schema)', () => {
    const out = assembleMappingsForRedesign(baseInput({
      tables: [TBL_T_CUST, TBL_T_ORD],
      fields: [F_T_CUSTID, F_T_FULLNAME, F_T_TENANT, F_T_NOTES, F_T_LEGACY, F_T_ORDCONTACT, F_T_ORDTOTAL],
    }))
    expect(out.sourceFields).toEqual([])
  })

  it('case 12c: aiReasoning on mapping_sources flows through to MappingSourceRef', () => {
    const t = tfm({
      id: 'tfm-reasoning',
      target_field_id: F_T_CUSTID.id,
      combination_type: 'single',
    })
    const m = ms({
      id: 'ms-reasoning',
      target_field_mapping_id: 'tfm-reasoning',
      source_field_id: F_S_CUSTID.id,
      source_table_id: F_S_CUSTID.table_id,
      ordinal: 0,
      ai_reasoning: 'Direct 1:1 on the primary key; no transformation required.',
    })
    const out = assembleMappingsForRedesign(
      baseInput({ tfms: [t], mappingSources: [m] }),
    )
    const row = out.rows.find((r) => r.id === 'tfm-reasoning') as MappedRow
    expect(row.sources[0].aiReasoning).toBe(
      'Direct 1:1 on the primary key; no transformation required.',
    )
  })
})
