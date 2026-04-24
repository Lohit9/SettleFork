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
} from '@/lib/actions/_mappings-for-redesign-core'
import type {
  MappedRow,
  TargetAcknowledgedRow,
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
    expect(row.sources[0].sampleValues).toEqual(['Alice', 'Bob', 'Carol']) // sliced to 3
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
  it('case 4: target-acknowledged row (is_acknowledged=true)', () => {
    const t4 = tfm({
      id: 'tfm-4',
      target_field_id: F_T_NOTES.id,
      combination_type: null,
      is_acknowledged: true,
      acknowledgment_reason: 'populated downstream by legacy process',
      confidence: null,
    })
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t4] }))
    const row = out.rows.find((r) => r.id === 'tfm-4') as TargetAcknowledgedRow
    expect(row.kind).toBe('target_acknowledged')
    expect(row.status).toBe('approved')
    expect(row.acknowledgmentReason).toBe('populated downstream by legacy process')
    expect(row.confidence).toBeNull()
    expect(row.hasTransformation).toBe(false)
  })

  // Case 5 ------------------------------------------------------------
  it('case 5: unmapped row (target field with no TFM) uses sentinel id', () => {
    const out = assembleMappingsForRedesign(baseInput({ tfms: [] }))
    const row = out.rows.find((r) => r.targetField.id === F_T_LEGACY.id) as UnmappedRow
    expect(row.kind).toBe('unmapped')
    expect(row.id).toBe(`unmapped::${F_T_LEGACY.id}`)
    expect(row.status).toBe('unmapped')
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
    const tr8: RawTransformationRow = { id: 'tr-8', target_field_mapping_id: 'tfm-8', status: 'applied' }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t8], mappingSources: [m8], transformations: [tr8] }))
    const row = out.rows.find((r) => r.id === 'tfm-8') as MappedRow
    expect(row.hasTransformation).toBe(true)
    expect(row.transformationStatus).toBe('applied')
  })

  it('case 8b: null DB transformation status coerces to draft when a row exists', () => {
    const t = tfm({ id: 'tfm-8b', target_field_id: F_T_CUSTID.id })
    const m = ms({ id: 'ms-8b', target_field_mapping_id: 'tfm-8b', source_field_id: F_S_CUSTID.id, source_table_id: F_S_CUSTID.table_id, ordinal: 0 })
    const tr: RawTransformationRow = { id: 'tr-8b', target_field_mapping_id: 'tfm-8b', status: null }
    const out = assembleMappingsForRedesign(baseInput({ tfms: [t], mappingSources: [m], transformations: [tr] }))
    const row = out.rows.find((r) => r.id === 'tfm-8b') as MappedRow
    expect(row.hasTransformation).toBe(true)
    expect(row.transformationStatus).toBe('draft')
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
    const ack: RawSourceAckRow = { id: 'ack-1', source_field_id: F_S_ORDTOTAL.id, reason: 'deprecated' }
    const out = assembleMappingsForRedesign(baseInput({
      tfms: [tA, tB],
      mappingSources: [mA],
      sourceAcks: [ack],
    }))
    expect(out.counts.total).toBe(7)       // 7 target fields
    expect(out.counts.approved).toBe(2)    // tfm-a (mapped) + tfm-b (ack)
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
})
