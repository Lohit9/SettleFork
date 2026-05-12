// @vitest-environment node
//
// PR 3a — buildTargetFieldRef contract tests.
//
// Exercises the additive read-shape extension that surfaces target-side
// metadata (isPrimaryKey, isForeignKey, fkReference, description,
// sampleValues) onto `TargetFieldRef`. The drawer body redesign's
// TARGET FIELD section (PR 3b) reads these directly without a separate
// fetch — the contract pinned here is the boundary between the
// translator and the UI.
//
// Mirrors the testability-export pattern used for
// `buildAgentUserMessage` (tests/lib/mapping-engine-agent-gate.test.ts).
// `buildTargetFieldRef` itself is a pure function: given a `RawFieldRow`
// + a `tablesById` Map, it returns a `TargetFieldRef | null` (null when
// the parent table is missing — a defensive guard for orphan rows).

import { describe, it, expect } from 'vitest'
import { buildTargetFieldRef } from '@/lib/ai/mapping-engine'

type FieldRowShape = Parameters<typeof buildTargetFieldRef>[0]
type TablesByIdShape = Parameters<typeof buildTargetFieldRef>[1]

function makeTable(
  overrides: Partial<{ id: string; dataset_id: string; name: string }> = {},
): { id: string; dataset_id: string; name: string } {
  return {
    id: 'tt-default',
    dataset_id: 'ds-default',
    name: 'Engineering Item Master',
    ...overrides,
  }
}

function makeField(overrides: Partial<FieldRowShape> = {}): FieldRowShape {
  return {
    id: 'tf-default',
    table_id: 'tt-default',
    name: 'Item_Description',
    data_type: 'VARCHAR(100)',
    is_nullable: false,
    is_primary_key: false,
    is_foreign_key: false,
    fk_reference: null,
    default_value: null,
    ordinal_position: 1,
    description: null,
    field_profiles: null,
    ...overrides,
  }
}

function makeTablesById(
  tables: Array<ReturnType<typeof makeTable>> = [makeTable()],
): TablesByIdShape {
  return new Map(tables.map((t) => [t.id, t]))
}

// ── Base shape (existing fields stay populated) ─────────────────────────────

describe('buildTargetFieldRef — base shape', () => {
  it('populates the existing required fields verbatim', () => {
    const ref = buildTargetFieldRef(makeField(), makeTablesById())
    expect(ref).not.toBeNull()
    expect(ref!.id).toBe('tf-default')
    expect(ref!.name).toBe('Item_Description')
    expect(ref!.dataType).toBe('VARCHAR(100)')
    expect(ref!.isNullable).toBe(false)
    expect(ref!.defaultValue).toBeNull()
    expect(ref!.targetTable).toEqual({
      id: 'tt-default',
      name: 'Engineering Item Master',
    })
    expect(ref!.ordinalPosition).toBe(1)
  })

  it('returns null when the parent table is missing from tablesById', () => {
    const ref = buildTargetFieldRef(
      makeField({ table_id: 'tt-orphan' }),
      makeTablesById(),
    )
    expect(ref).toBeNull()
  })

  it('coerces null is_nullable to true (matches Postgres DDL default)', () => {
    const ref = buildTargetFieldRef(
      makeField({ is_nullable: null }),
      makeTablesById(),
    )
    expect(ref!.isNullable).toBe(true)
  })
})

// ── PR 3a additive fields ──────────────────────────────────────────────────

describe('buildTargetFieldRef — PR 3a additive: isPrimaryKey / isForeignKey / fkReference', () => {
  it('surfaces is_primary_key=true as isPrimaryKey:true', () => {
    const ref = buildTargetFieldRef(
      makeField({ is_primary_key: true }),
      makeTablesById(),
    )
    expect(ref!.isPrimaryKey).toBe(true)
    expect(ref!.isForeignKey).toBe(false)
    expect(ref!.fkReference).toBeNull()
  })

  it('surfaces is_foreign_key=true + fk_reference verbatim', () => {
    const ref = buildTargetFieldRef(
      makeField({
        is_foreign_key: true,
        fk_reference: 'Unit Of Measure.rstk__externalid__c',
      }),
      makeTablesById(),
    )
    expect(ref!.isPrimaryKey).toBe(false)
    expect(ref!.isForeignKey).toBe(true)
    expect(ref!.fkReference).toBe('Unit Of Measure.rstk__externalid__c')
  })

  it('coerces null is_primary_key / is_foreign_key to false (DDL DEFAULT false)', () => {
    const ref = buildTargetFieldRef(
      makeField({ is_primary_key: null, is_foreign_key: null }),
      makeTablesById(),
    )
    expect(ref!.isPrimaryKey).toBe(false)
    expect(ref!.isForeignKey).toBe(false)
  })

  it('PK + FK can both be true (compound key reference)', () => {
    const ref = buildTargetFieldRef(
      makeField({
        is_primary_key: true,
        is_foreign_key: true,
        fk_reference: 'Division Master.rstk__externalid__c',
      }),
      makeTablesById(),
    )
    expect(ref!.isPrimaryKey).toBe(true)
    expect(ref!.isForeignKey).toBe(true)
    expect(ref!.fkReference).toBe('Division Master.rstk__externalid__c')
  })
})

describe('buildTargetFieldRef — PR 3a additive: description', () => {
  it('surfaces description verbatim when present', () => {
    const ref = buildTargetFieldRef(
      makeField({ description: 'Item-level commodity classification code.' }),
      makeTablesById(),
    )
    expect(ref!.description).toBe('Item-level commodity classification code.')
  })

  it('returns null when description is absent (DEFAULT NULL on legacy rows)', () => {
    const ref = buildTargetFieldRef(makeField(), makeTablesById())
    expect(ref!.description).toBeNull()
  })

  it('treats missing description property as null (forward-compat for old reads)', () => {
    // Constructed via spread to force the description key absent from
    // the literal — exercises the `?? null` fallback.
    const fieldWithoutDescription: FieldRowShape = (() => {
      const base = makeField()
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { description: _drop, ...rest } = base
      return rest as FieldRowShape
    })()
    const ref = buildTargetFieldRef(fieldWithoutDescription, makeTablesById())
    expect(ref!.description).toBeNull()
  })
})

describe('buildTargetFieldRef — PR 3a additive: sampleValues', () => {
  it('returns empty array when field_profiles is null', () => {
    const ref = buildTargetFieldRef(
      makeField({ field_profiles: null }),
      makeTablesById(),
    )
    expect(ref!.sampleValues).toEqual([])
  })

  it('returns empty array when field_profiles is an empty array', () => {
    const ref = buildTargetFieldRef(
      makeField({ field_profiles: [] }),
      makeTablesById(),
    )
    expect(ref!.sampleValues).toEqual([])
  })

  it('surfaces sample_values from the first profile row, coerced to strings', () => {
    const ref = buildTargetFieldRef(
      makeField({
        field_profiles: [
          {
            field_id: 'tf-default',
            sample_values: ['DIV1', 'DIV2', 'DIV3'],
          },
        ],
      }),
      makeTablesById(),
    )
    expect(ref!.sampleValues).toEqual(['DIV1', 'DIV2', 'DIV3'])
  })

  it('caps sample_values at MAX_SAMPLE_VALUES=10 (server-side wire cap)', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `v${i + 1}`)
    const ref = buildTargetFieldRef(
      makeField({
        field_profiles: [{ field_id: 'tf-default', sample_values: fifteen }],
      }),
      makeTablesById(),
    )
    expect(ref!.sampleValues).toHaveLength(10)
    expect(ref!.sampleValues[0]).toBe('v1')
    expect(ref!.sampleValues[9]).toBe('v10')
  })

  it('coerces non-string sample values to strings (defense in depth)', () => {
    const ref = buildTargetFieldRef(
      makeField({
        field_profiles: [
          {
            field_id: 'tf-default',
            sample_values: [1, 2.5, true, null, 'mixed'],
          },
        ],
      }),
      makeTablesById(),
    )
    expect(ref!.sampleValues).toEqual(['1', '2.5', 'true', 'null', 'mixed'])
  })

  it('returns empty array when sample_values is malformed (non-array)', () => {
    const ref = buildTargetFieldRef(
      makeField({
        field_profiles: [
          {
            field_id: 'tf-default',
            // Real-world malformed shape: JSONB stored a string instead.
            sample_values: 'not an array',
          },
        ],
      }),
      makeTablesById(),
    )
    expect(ref!.sampleValues).toEqual([])
  })
})

// ── Integration: realistic Test #7 Rootstock target field ──────────────────

describe('buildTargetFieldRef — realistic Rootstock target field', () => {
  it('round-trips a typical Test #7 target field with full metadata', () => {
    const ref = buildTargetFieldRef(
      makeField({
        id: 'tf-commodity-code',
        table_id: 'tt-icc',
        name: 'COMMODITY_CODE',
        data_type: 'VARCHAR(20)',
        is_nullable: false,
        is_primary_key: true,
        is_foreign_key: false,
        fk_reference: null,
        default_value: null,
        description: null,
        ordinal_position: 1,
        field_profiles: [
          {
            field_id: 'tf-commodity-code',
            sample_values: [
              'Test-Manufactued-Phantom-CC1',
              'Test-Purchased-CC1',
              'Test-Subcontract-CC1',
            ],
          },
        ],
      }),
      makeTablesById([
        makeTable({ id: 'tt-icc', name: 'Inventory Commodity Code' }),
      ]),
    )
    expect(ref).toEqual({
      id: 'tf-commodity-code',
      name: 'COMMODITY_CODE',
      dataType: 'VARCHAR(20)',
      isNullable: false,
      defaultValue: null,
      targetTable: { id: 'tt-icc', name: 'Inventory Commodity Code' },
      ordinalPosition: 1,
      isPrimaryKey: true,
      isForeignKey: false,
      fkReference: null,
      description: null,
      sampleValues: [
        'Test-Manufactued-Phantom-CC1',
        'Test-Purchased-CC1',
        'Test-Subcontract-CC1',
      ],
    })
  })
})
