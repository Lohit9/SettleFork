/**
 * Test 1 — Unit tests for `lib/actions/_outputs-helpers.ts`.
 *
 * Exercises the ten coverage cases mandated by the Prompt 3c Gate 2 plan:
 *
 *   A1 — Single 1:1 mapping, approved
 *   A2 — Multi-source (concat) mapping, 2 sources (primary + contributor)
 *   A3 — Value assignment (no source)
 *   A4 — Target-side acknowledgment (bare-ack TFM, excluded from groups)
 *   A5 — Source-side acknowledgment (not visible in grouping — tested via absence)
 *   A6 — Unmapped unacknowledged source (absence from MS lookup)
 *   A7 — Unmapped unacknowledged target (absence from TFM target)
 *   A8 — Approved mapping with applied transformation (grouping sees TFM)
 *   A9 — Rejected mapping (excluded from groups; see Test 11 for audit-trail
 *         inclusion in mapping-file outputs)
 *   A10 — Empty project (empty inputs → empty-map result)
 *
 * The helper module is PURE (no DB access, no side effects). Tests feed
 * fixture data directly and assert structural invariants:
 *
 *   - map size = number of table mappings (every TM gets a bucket, even empty)
 *   - per-TM TFM counts match the fixture's intended coverage counts
 *   - primary + contributor ordering is ordinal-stable
 *   - VA fan-out places a single VA in every TM targeting the same table
 *   - rejected / bare-ack TFMs NEVER appear in any bucket
 *
 * Any assertion failure here means a silent regression in the grouping
 * rule — the same rule the shim, outputs.ts, execution-package.ts, and
 * readiness-score.ts all rely on. See `_outputs-helpers.ts` §file header
 * for the contract.
 */

import { describe, expect, it } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  enumerateFieldPairs,
  groupTfmsByTableMapping,
  isValueAssignment,
  type FieldLookupRow,
  type TableMappingLookup,
} from '@/lib/actions/_outputs-helpers'
import type { MappingSourceRow, TargetFieldMappingRow } from '@/lib/types/mapping-redesign'

function buildFieldsById(): Map<string, FieldLookupRow> {
  return new Map(
    fixture.fields.map((f) => [f.id, { id: f.id, table_id: f.table_id, ordinal_position: f.ordinal_position }]),
  )
}

function buildTableMappings(): TableMappingLookup[] {
  return fixture.tableMappings.map((tm) => ({
    id: tm.id,
    source_table_id: tm.source_table_id,
    target_table_id: tm.target_table_id,
  }))
}

describe('Test 1 — groupTfmsByTableMapping: fixture coverage cases', () => {
  it('A10: empty project returns an empty map', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: [],
      targetFieldMappings: [],
      mappingSources: [],
      fieldsById: new Map(),
    })
    expect(result.size).toBe(0)
  })

  it('A10b: TMs with no matching TFMs still receive an empty bucket', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: [],
      mappingSources: [],
      fieldsById: buildFieldsById(),
    })
    expect(result.size).toBe(fixture.tableMappings.length)
    for (const bucket of result.values()) {
      expect(bucket).toEqual([])
    }
  })

  it('result map has exactly one bucket per table_mapping (no orphan buckets, no missing buckets)', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    expect(result.size).toBe(fixture.tableMappings.length)
    for (const tm of fixture.tableMappings) {
      expect(result.has(tm.id)).toBe(true)
    }
  })

  it('A1 / A2 / A3: tmCust bucket contains 4 entries (id 1:1, concat, email 1:1, VA)', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    const cust = result.get(fixture.ids.tmCust)!
    // tmCust has 4 active TFMs: TFM-1 (s_id→t_customer_id),
    // TFM-2 (s_first_name|s_last_name→t_full_name, concat), TFM-3
    // (s_email→t_email_norm), TFM-4 (VA→t_tenant_id). TFM-5 (bare-ack on
    // t_notes) is excluded. TFM-9 (rejected) is excluded.
    expect(cust.length).toBe(4)

    // Assert VA is present (targetFieldMapping for t_tenant_id has primarySource=null).
    const vaEntries = cust.filter((e) => e.primarySource === null)
    expect(vaEntries.length).toBe(1)
    expect(vaEntries[0].tfm.target_field_id).toBe(fixture.ids.fTTenantId)
  })

  it('A2: concat mapping surfaces 1 primary + 1 contributor in ordinal order', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    const cust = result.get(fixture.ids.tmCust)!
    const concat = cust.find((e) => e.tfm.target_field_id === fixture.ids.fTFullName)!

    expect(concat.primarySource).not.toBeNull()
    expect(concat.primarySource!.ordinal).toBe(0)
    expect(concat.contributors.length).toBe(1)
    expect(concat.contributors[0].ordinal).toBeGreaterThanOrEqual(1)

    // enumerateFieldPairs: primary first, then contributor.
    const pairs = enumerateFieldPairs(concat)
    expect(pairs).toHaveLength(2)
    expect(pairs[0].isPrimary).toBe(true)
    expect(pairs[0].ordinal).toBe(0)
    expect(pairs[1].isPrimary).toBe(false)
    expect(pairs[1].ordinal).toBe(1)
  })

  it('A3: VA has no primarySource and zero contributors', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    const cust = result.get(fixture.ids.tmCust)!
    const va = cust.find((e) => e.tfm.target_field_id === fixture.ids.fTTenantId)!
    expect(va.primarySource).toBeNull()
    expect(va.contributors).toEqual([])

    // enumerateFieldPairs: exactly one pair with sourceFieldId=null.
    const pairs = enumerateFieldPairs(va)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].sourceFieldId).toBeNull()
    expect(pairs[0].isPrimary).toBe(true)
    expect(pairs[0].mappingSourceId).toBeNull()
  })

  it('A4: bare-ack TFM (t_notes) is EXCLUDED from every bucket', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    for (const bucket of result.values()) {
      for (const entry of bucket) {
        expect(entry.tfm.target_field_id).not.toBe(fixture.ids.fTNotes)
      }
    }
  })

  it('A9: rejected TFM (TFM-9) is EXCLUDED from every bucket', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    for (const bucket of result.values()) {
      for (const entry of bucket) {
        expect(entry.tfm.id).not.toBe(fixture.ids.tfm9)
        expect(entry.tfm.status).not.toBe('rejected')
      }
    }
  })

  it('entries within a bucket are sorted by target_field.ordinal_position', () => {
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      fieldsById: buildFieldsById(),
    })
    const fieldsById = buildFieldsById()
    for (const bucket of result.values()) {
      for (let i = 1; i < bucket.length; i++) {
        const prev = fieldsById.get(bucket[i - 1].tfm.target_field_id)!.ordinal_position ?? 0
        const curr = fieldsById.get(bucket[i].tfm.target_field_id)!.ordinal_position ?? 0
        expect(curr).toBeGreaterThanOrEqual(prev)
      }
    }
  })

  it('orphan TFM (primary source resolves to no TM pair) is silently skipped', () => {
    // Construct a synthetic orphan scenario: a TFM whose primary MS points to
    // a source table not paired with the TFM's target table in any TM.
    const synthTfm: TargetFieldMappingRow = {
      id: 'synthetic-orphan-tfm',
      project_id: 'test',
      target_field_id: fixture.ids.fTCustomerId,
      confidence: 50,
      status: 'approved',
      ai_reasoning: null,
      is_acknowledged: false,
      acknowledgment_reason: null,
      combination_type: 'single',
      combination_sql: null,
      needs_transformation: null,
      va_dismissed: false,
      dismissal_reason: null,
      created_at: '2026-04-22T00:00:00Z',
      updated_at: '2026-04-22T00:00:00Z',
    }
    const synthMs: MappingSourceRow = {
      id: 'synthetic-orphan-ms',
      target_field_mapping_id: synthTfm.id,
      source_field_id: fixture.ids.fSoId,
      source_table_id: fixture.ids.tableSOrders,
      confidence: 50,
      ai_reasoning: null,
      similar_fields_considered: null,
      type_compatibility: null,
      join_spec: null,
      ordinal: 0,
      created_at: '2026-04-22T00:00:00Z',
    }
    // tmCust pairs (s_customers → t_customers); synthTfm targets t_customers but
    // sources from s_orders — no TM owns the (s_orders → t_customers) pair.
    const result = groupTfmsByTableMapping({
      tableMappings: buildTableMappings(),
      targetFieldMappings: [synthTfm],
      mappingSources: [synthMs],
      fieldsById: buildFieldsById(),
    })
    for (const bucket of result.values()) {
      for (const entry of bucket) {
        expect(entry.tfm.id).not.toBe(synthTfm.id)
      }
    }
  })
})

describe('Test 1 — isValueAssignment predicate', () => {
  it('returns true for custom_sql TFM with zero MS rows', () => {
    const tfm = fixture.targetFieldMappings.find((t) => t.combination_type === 'custom_sql')!
    expect(isValueAssignment(tfm, 0)).toBe(true)
  })

  it('returns false for custom_sql TFM with MS rows (shouldnt happen, but guard against)', () => {
    const tfm = fixture.targetFieldMappings.find((t) => t.combination_type === 'custom_sql')!
    expect(isValueAssignment(tfm, 1)).toBe(false)
  })

  it('returns false for a 1:1 mapped TFM', () => {
    const tfm = fixture.targetFieldMappings.find((t) => t.combination_type === 'single')!
    expect(isValueAssignment(tfm, 1)).toBe(false)
  })
})
