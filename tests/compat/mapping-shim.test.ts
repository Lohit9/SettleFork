import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  ShimError,
  SHIMMED_ID_SEPARATOR,
  decodeShimmedRowId,
  encodeContributorRowId,
  encodeSourceAckRowId,
  encodeTargetAckRowId,
  shimToMappingsResult,
  type ShimDatasetRow,
  type ShimFieldRow,
  type ShimInput,
  type ShimTableMappingRow,
  type ShimTableRow,
  type ShimTransformationRow,
} from '@/lib/compat/mapping-shim'
import type {
  MappingSourceRow,
  SourceFieldAcknowledgmentRow,
  TargetFieldMappingRow,
} from '@/lib/types/mapping-redesign'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'

// UUIDs for fixtures (explicit to keep ordering deterministic in assertions).
const id = {
  srcDs: '10000000-0000-0000-0000-000000000001',
  tgtDs: '10000000-0000-0000-0000-000000000002',
  srcTbl: '20000000-0000-0000-0000-000000000001',
  tgtTbl: '20000000-0000-0000-0000-000000000002',
  srcTbl2: '20000000-0000-0000-0000-000000000003',
  tgtTbl2: '20000000-0000-0000-0000-000000000004',
  sFieldA: '30000000-0000-0000-0000-000000000001',
  sFieldB: '30000000-0000-0000-0000-000000000002',
  sFieldC: '30000000-0000-0000-0000-000000000003', // in srcTbl2
  tField: '30000000-0000-0000-0000-000000000010',
  tField2: '30000000-0000-0000-0000-000000000011',
  tm: '40000000-0000-0000-0000-000000000001',
  tm2: '40000000-0000-0000-0000-000000000002',
  tfm: '50000000-0000-0000-0000-000000000001',
  tfm2: '50000000-0000-0000-0000-000000000002',
  ms1: '60000000-0000-0000-0000-000000000001',
  ms2: '60000000-0000-0000-0000-000000000002',
  ack: '70000000-0000-0000-0000-000000000001',
  transform: '80000000-0000-0000-0000-000000000001',
}

const datasets: Record<string, ShimDatasetRow> = {
  [id.srcDs]: { id: id.srcDs, name: 'Legacy', role: 'source' },
  [id.tgtDs]: { id: id.tgtDs, name: 'Modern', role: 'target' },
}

const tables: Record<string, ShimTableRow> = {
  [id.srcTbl]: { id: id.srcTbl, name: 'src_customers', dataset_id: id.srcDs },
  [id.tgtTbl]: { id: id.tgtTbl, name: 'tgt_customers', dataset_id: id.tgtDs },
  [id.srcTbl2]: { id: id.srcTbl2, name: 'src_orgs', dataset_id: id.srcDs },
  [id.tgtTbl2]: { id: id.tgtTbl2, name: 'tgt_orgs', dataset_id: id.tgtDs },
}

const fields: Record<string, ShimFieldRow> = {
  [id.sFieldA]: {
    id: id.sFieldA,
    name: 'first_nm',
    data_type: 'varchar',
    table_id: id.srcTbl,
    inferred_type: 'string',
  },
  [id.sFieldB]: {
    id: id.sFieldB,
    name: 'last_nm',
    data_type: 'varchar',
    table_id: id.srcTbl,
    inferred_type: 'string',
  },
  [id.sFieldC]: {
    id: id.sFieldC,
    name: 'org_code',
    data_type: 'varchar',
    table_id: id.srcTbl2,
    inferred_type: 'string',
  },
  [id.tField]: {
    id: id.tField,
    name: 'full_name',
    data_type: 'text',
    table_id: id.tgtTbl,
    inferred_type: 'string',
  },
  [id.tField2]: {
    id: id.tField2,
    name: 'org_id',
    data_type: 'text',
    table_id: id.tgtTbl,
    inferred_type: 'string',
  },
}

function baseTm(overrides: Partial<ShimTableMappingRow> = {}): ShimTableMappingRow {
  return {
    id: id.tm,
    project_id: PROJECT_ID,
    source_table_id: id.srcTbl,
    target_table_id: id.tgtTbl,
    confidence: 0.9,
    status: 'approved',
    ai_reasoning: null,
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function baseTfm(overrides: Partial<TargetFieldMappingRow> = {}): TargetFieldMappingRow {
  return {
    id: id.tfm,
    project_id: PROJECT_ID,
    target_field_id: id.tField,
    confidence: 0.85,
    status: 'approved',
    ai_reasoning: 'fixture',
    is_acknowledged: false,
    acknowledgment_reason: null,
    combination_type: 'single',
    combination_sql: null,
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    ...overrides,
  }
}

function baseMs(overrides: Partial<MappingSourceRow> = {}): MappingSourceRow {
  return {
    id: id.ms1,
    target_field_mapping_id: id.tfm,
    source_field_id: id.sFieldA,
    source_table_id: id.srcTbl,
    confidence: 0.85,
    ai_reasoning: null,
    similar_fields_considered: null,
    type_compatibility: null,
    join_spec: null,
    ordinal: 0,
    created_at: '2026-04-02T00:00:00Z',
    ...overrides,
  }
}

function baseInput(overrides: Partial<ShimInput> = {}): ShimInput {
  return {
    projectId: PROJECT_ID,
    tableMappings: [baseTm()],
    targetFieldMappings: [],
    mappingSources: [],
    sourceAcks: [],
    fieldsById: fields,
    tablesById: tables,
    datasetsById: datasets,
    fieldSamples: {
      [id.sFieldA]: ['Alice', 'Bob'],
      [id.sFieldB]: ['Smith', 'Jones'],
      [id.tField]: ['Alice Smith'],
    },
    fieldNullPercentages: { [id.sFieldA]: 2, [id.sFieldB]: 5 },
    transformations: [],
    unmappedSourceFields: [],
    unmappedTargetFields: [],
    allFieldsByTable: {},
    allSourceTables: [],
    allTargetTables: [],
    ...overrides,
  }
}

// ─── Encoder/decoder ─────────────────────────────────────────────────────────

describe('[shim] id codec', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips tfm-primary', () => {
    expect(decodeShimmedRowId(id.tfm)).toEqual({ kind: 'tfm-primary', tfmId: id.tfm })
  })

  it('round-trips tfm-contributor via encodeContributorRowId', () => {
    const raw = encodeContributorRowId(id.tfm, id.ms1)
    expect(raw).toBe(`${id.tfm}${SHIMMED_ID_SEPARATOR}${id.ms1}`)
    expect(decodeShimmedRowId(raw)).toEqual({
      kind: 'tfm-contributor',
      tfmId: id.tfm,
      mappingSourceId: id.ms1,
    })
  })

  it('round-trips target-ack', () => {
    const raw = encodeTargetAckRowId(id.tfm)
    expect(raw).toBe(`ack${SHIMMED_ID_SEPARATOR}target${SHIMMED_ID_SEPARATOR}${id.tfm}`)
    expect(decodeShimmedRowId(raw)).toEqual({ kind: 'target-ack', tfmId: id.tfm })
  })

  it('round-trips source-ack', () => {
    const raw = encodeSourceAckRowId(id.ack)
    expect(decodeShimmedRowId(raw)).toEqual({ kind: 'source-ack', sourceAckId: id.ack })
  })

  it('returns unknown (and warns) for a non-UUID plain id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = decodeShimmedRowId('not-a-uuid')
    expect(result.kind).toBe('unknown')
    expect(warn).toHaveBeenCalled()
  })

  it('returns unknown for malformed contributor id', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(decodeShimmedRowId('abc::def').kind).toBe('unknown')
  })

  it('returns unknown for empty input', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(decodeShimmedRowId('').kind).toBe('unknown')
  })
})

// ─── Translation cases ───────────────────────────────────────────────────────

describe('[shim] shimToMappingsResult', () => {
  it('Case 1 — simple 1:1 mapping produces one primary RichFieldMapping', () => {
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [baseTfm()],
        mappingSources: [baseMs()],
      }),
    )
    expect(out.tableMappings).toHaveLength(1)
    const tm = out.tableMappings[0]
    expect(tm.fieldMappings).toHaveLength(1)
    const fm = tm.fieldMappings[0]
    expect(fm.id).toBe(id.tfm)
    expect(fm.is_contributing).toBe(false)
    expect(fm.source_field_id).toBe(id.sFieldA)
    expect(fm.target_field_id).toBe(id.tField)
    expect(fm.confidence).toBe(0.85)
    expect(fm.sourceFieldSamples).toEqual(['Alice', 'Bob'])
    expect(fm.targetFieldSamples).toEqual(['Alice Smith'])
    expect(fm.sourceFieldNullPercentage).toBe(2)
  })

  it('Case 2 — many-to-one same-table produces primary + contributors with composite ids', () => {
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [baseTfm({ combination_type: 'concat_space' })],
        mappingSources: [
          baseMs({ id: id.ms1, source_field_id: id.sFieldA, ordinal: 0 }),
          baseMs({
            id: id.ms2,
            source_field_id: id.sFieldB,
            ordinal: 1,
            confidence: 0.6,
            ai_reasoning: 'contributor reasoning',
          }),
        ],
      }),
    )
    const fms = out.tableMappings[0].fieldMappings
    expect(fms).toHaveLength(2)
    const primary = fms.find((f) => !f.is_contributing)!
    const contributor = fms.find((f) => f.is_contributing)!
    expect(primary.id).toBe(id.tfm)
    expect(contributor.id).toBe(`${id.tfm}${SHIMMED_ID_SEPARATOR}${id.ms2}`)
    expect(contributor.confidence).toBe(0.6)
    expect(contributor.ai_reasoning).toBe('contributor reasoning')
    expect(contributor.transformation).toBeNull()
  })

  it('Case 3 — value assignment appears under EVERY matching table_mapping', () => {
    const extraTm: ShimTableMappingRow = baseTm({
      id: id.tm2,
      source_table_id: id.srcTbl2,
    })
    const out = shimToMappingsResult(
      baseInput({
        tableMappings: [baseTm(), extraTm],
        targetFieldMappings: [
          baseTfm({
            combination_type: 'custom_sql',
            combination_sql: "'REDACTED'::text",
          }),
        ],
        mappingSources: [],
      }),
    )
    const tm1 = out.tableMappings.find((t) => t.id === id.tm)!
    const tm2 = out.tableMappings.find((t) => t.id === id.tm2)!
    expect(tm1.fieldMappings).toHaveLength(1)
    expect(tm2.fieldMappings).toHaveLength(1)
    for (const tm of [tm1, tm2]) {
      const fm = tm.fieldMappings[0]
      expect(fm.source_field_id).toBeNull()
      expect(fm.sourceField).toBeNull()
      expect(fm.target_field_id).toBe(id.tField)
      expect(fm.id).toBe(id.tfm)
    }
  })

  it('Case 4 — target-side acknowledgment is synthesized into FieldAcknowledgmentRow', () => {
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [
          baseTfm({
            is_acknowledged: true,
            combination_type: null,
            acknowledgment_reason: 'no-op',
            updated_at: '2026-04-03T00:00:00Z',
          }),
        ],
      }),
    )
    expect(out.tableMappings[0].fieldMappings).toHaveLength(0)
    expect(out.acknowledgments).toHaveLength(1)
    const ack = out.acknowledgments[0]
    expect(ack.side).toBe('target')
    expect(ack.field_id).toBe(id.tField)
    expect(ack.reason).toBe('no-op')
    expect(ack.id).toBe(`ack${SHIMMED_ID_SEPARATOR}target${SHIMMED_ID_SEPARATOR}${id.tfm}`)
    expect(ack.acknowledged_at).toBe('2026-04-03T00:00:00Z')
  })

  it('Case 5 — source-side acknowledgment is synthesized', () => {
    const sa: SourceFieldAcknowledgmentRow = {
      id: id.ack,
      project_id: PROJECT_ID,
      source_field_id: id.sFieldB,
      reason: 'deprecated',
      notes: 'legacy column, no target equivalent',
      acknowledged_by: null,
      acknowledged_at: '2026-04-04T00:00:00Z',
    }
    const out = shimToMappingsResult(baseInput({ sourceAcks: [sa] }))
    expect(out.acknowledgments).toHaveLength(1)
    const ack = out.acknowledgments[0]
    expect(ack.side).toBe('source')
    expect(ack.field_id).toBe(id.sFieldB)
    expect(ack.notes).toBe('legacy column, no target equivalent')
    expect(ack.id).toBe(`ack${SHIMMED_ID_SEPARATOR}source${SHIMMED_ID_SEPARATOR}${id.ack}`)
  })

  it('Case 6 — cross-table TFM (sources span two source tables) throws CROSS_TABLE', () => {
    expect(() =>
      shimToMappingsResult(
        baseInput({
          targetFieldMappings: [baseTfm({ combination_type: 'concat_space' })],
          mappingSources: [
            baseMs({ id: id.ms1, ordinal: 0, source_field_id: id.sFieldA, source_table_id: id.srcTbl }),
            baseMs({
              id: id.ms2,
              ordinal: 1,
              source_field_id: id.sFieldC,
              source_table_id: id.srcTbl2,
            }),
          ],
        }),
      ),
    ).toThrow(ShimError)
  })

  it('Case 7 — TFM for a target whose table has no table_mapping throws ORPHAN_TFM', () => {
    expect(() =>
      shimToMappingsResult(
        baseInput({
          tableMappings: [], // no TMs at all
          targetFieldMappings: [baseTfm()],
          mappingSources: [baseMs()],
        }),
      ),
    ).toThrowError(/ORPHAN_TFM|no table_mappings/)
  })

  it('Case 8 — TFM sourceTable without a matching table_mapping pairing throws CROSS_TABLE', () => {
    // TM exists for target table, but pairs a different source table than the TFM's sources.
    expect(() =>
      shimToMappingsResult(
        baseInput({
          tableMappings: [baseTm({ source_table_id: id.srcTbl2 })],
          targetFieldMappings: [baseTfm()],
          mappingSources: [baseMs()], // sourceTable = srcTbl
        }),
      ),
    ).toThrowError(ShimError)
  })

  it('Case 9 — mapping_sources references unknown field throws MISSING_FIELD', () => {
    expect(() =>
      shimToMappingsResult(
        baseInput({
          targetFieldMappings: [baseTfm()],
          mappingSources: [baseMs({ source_field_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })],
        }),
      ),
    ).toThrowError(/MISSING_FIELD|Field .* not present/)
  })

  it('Case 10 — transformation is attached to the primary row only', () => {
    const transformation: ShimTransformationRow = {
      id: id.transform,
      target_field_mapping_id: id.tfm,
      status: 'applied',
      description: 'uppercase',
      generated_sql: 'SELECT UPPER(first_nm)',
    }
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [baseTfm({ combination_type: 'concat_space' })],
        mappingSources: [
          baseMs({ id: id.ms1, ordinal: 0 }),
          baseMs({ id: id.ms2, ordinal: 1, source_field_id: id.sFieldB }),
        ],
        transformations: [transformation],
      }),
    )
    const fms = out.tableMappings[0].fieldMappings
    const primary = fms.find((f) => !f.is_contributing)!
    const contributor = fms.find((f) => f.is_contributing)!
    expect(primary.transformation?.id).toBe(id.transform)
    expect(contributor.transformation).toBeNull()
  })

  it('Case 11 — allFieldsByTable / allSourceTables / allTargetTables pass through unchanged', () => {
    const allFields = { [id.srcTbl]: [{ id: id.sFieldA, name: 'first_nm', data_type: 'varchar' }] }
    const allSrc = [{ id: id.srcTbl, name: 'src_customers', datasetName: 'Legacy' }]
    const allTgt = [{ id: id.tgtTbl, name: 'tgt_customers', datasetName: 'Modern' }]
    const out = shimToMappingsResult(
      baseInput({
        allFieldsByTable: allFields,
        allSourceTables: allSrc,
        allTargetTables: allTgt,
      }),
    )
    expect(out.allFieldsByTable).toBe(allFields)
    expect(out.allSourceTables).toBe(allSrc)
    expect(out.allTargetTables).toBe(allTgt)
  })

  it('Case 12 — unmapped source/target fields pass through unchanged', () => {
    const src = [
      {
        id: id.sFieldB,
        name: 'last_nm',
        data_type: 'varchar',
        table_id: id.srcTbl,
        table: { id: id.srcTbl, name: 'src_customers' },
      },
    ]
    const tgt = [
      {
        id: id.tField2,
        name: 'org_id',
        data_type: 'text',
        table_id: id.tgtTbl,
        table: { id: id.tgtTbl, name: 'tgt_customers' },
      },
    ]
    const out = shimToMappingsResult(
      baseInput({ unmappedSourceFields: src, unmappedTargetFields: tgt }),
    )
    expect(out.unmappedSourceFields).toBe(src)
    expect(out.unmappedTargetFields).toBe(tgt)
  })

  it('Case 13 — mapped TFM with zero mapping_sources throws INVARIANT', () => {
    expect(() =>
      shimToMappingsResult(
        baseInput({
          targetFieldMappings: [baseTfm({ combination_type: 'single' })],
          mappingSources: [],
        }),
      ),
    ).toThrowError(/Mapped TFM has zero mapping_sources/)
  })

  it('Case 14 — custom_sql TFM with NULL combination_sql is allowed (freshly-created VA lifecycle)', () => {
    // This is the exact row shape that `createValueAssignment` writes:
    //   combination_type = 'custom_sql'
    //   combination_sql  = NULL
    //   is_acknowledged  = false
    //   mapping_sources  = [] (zero children)
    //
    // The user then provides SQL via the Transform tab which writes to
    // `transformations.generated_sql` — NOT back to this column. The
    // shim must render the row as a VA RichFieldMapping throughout that
    // whole lifecycle, without throwing ShimError('INVARIANT'). If this
    // test ever regresses (reintroducing the NULL-combination_sql
    // throw), every newly-created VA in the app will crash the mapping
    // page before the user can fill in the Transform tab.
    const freshVaTfm = baseTfm({ combination_type: 'custom_sql', combination_sql: null })
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [freshVaTfm],
      }),
    )
    expect(out.tableMappings[0].fieldMappings).toHaveLength(1)
    const va = out.tableMappings[0].fieldMappings[0]
    expect(va.source_field_id).toBeNull()
    expect(va.sourceField).toBeNull()
    expect(va.target_field_id).toBe(id.tField)
    expect(va.id).toBe(freshVaTfm.id)
    // `transformation` is null when no transformations row has been attached
    // yet (the canonical state immediately after createValueAssignment).
    expect(va.transformation).toBeNull()
  })

  it('Case 14b — VA TFM with NULL combination_sql and an attached transformation renders the transform cleanly', () => {
    // Once the user saves in the Transform tab a `transformations` row is
    // attached to the TFM. `combination_sql` still stays NULL until
    // Prompt 3b mirrors it; the shim must prefer the transformation's SQL.
    const vaTfmId = '55000000-0000-0000-0000-0000000000aa'
    const transformRow: ShimTransformationRow = {
      id: id.transform,
      target_field_mapping_id: vaTfmId,
      status: 'saved',
      description: 'assign hardcoded value',
      generated_sql: `'2026-01-01'::date`,
    }
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [
          baseTfm({ id: vaTfmId, combination_type: 'custom_sql', combination_sql: null }),
        ],
        transformations: [transformRow],
      }),
    )
    const va = out.tableMappings[0].fieldMappings[0]
    expect(va.transformation?.id).toBe(id.transform)
    expect(va.transformation?.generated_sql).toBe(`'2026-01-01'::date`)
  })

  it('Case 15 — ordering within a TM: primary before contributors by ordinal', () => {
    // Create two TFMs against different target fields to verify alphabetical
    // sort by target field name, then primary-before-contributor within a TFM.
    const otherTfmId = id.tfm2
    const otherMsId = id.ms2
    const out = shimToMappingsResult(
      baseInput({
        targetFieldMappings: [
          baseTfm({ combination_type: 'concat_space' }), // target: full_name
          baseTfm({
            id: otherTfmId,
            target_field_id: id.tField2, // "org_id" — sorts before "full_name"? "full_name" vs "org_id" — f < o so full_name first
            combination_type: 'single',
            created_at: '2026-04-02T00:00:01Z',
            updated_at: '2026-04-02T00:00:01Z',
          }),
        ],
        mappingSources: [
          baseMs({ ordinal: 0, id: id.ms1 }),
          baseMs({ ordinal: 1, id: 'aa000000-0000-0000-0000-000000000099', source_field_id: id.sFieldB }),
          baseMs({
            target_field_mapping_id: otherTfmId,
            id: otherMsId,
            ordinal: 0,
            source_field_id: id.sFieldA,
            source_table_id: id.srcTbl,
          }),
        ],
      }),
    )
    const fms = out.tableMappings[0].fieldMappings
    expect(fms.map((f) => ({ name: f.targetField?.name, contrib: f.is_contributing }))).toEqual([
      { name: 'full_name', contrib: false },
      { name: 'full_name', contrib: true },
      { name: 'org_id', contrib: false },
    ])
  })

  it('Case 16 — VA TFM with no matching table_mapping throws ORPHAN_TFM', () => {
    expect(() =>
      shimToMappingsResult(
        baseInput({
          tableMappings: [], // target table has no TM
          targetFieldMappings: [
            baseTfm({
              combination_type: 'custom_sql',
              combination_sql: "'x'::text",
            }),
          ],
        }),
      ),
    ).toThrowError(/ORPHAN_TFM|no table_mappings/)
  })

  it('Case 17 — TFM with is_acknowledged=true AND combination_type != NULL throws INVARIANT (defense in depth)', () => {
    expect(() =>
      shimToMappingsResult(
        baseInput({
          targetFieldMappings: [
            baseTfm({ is_acknowledged: true, combination_type: 'single' }),
          ],
          mappingSources: [baseMs()],
        }),
      ),
    ).toThrowError(/is_acknowledged=true with non-null combination_type/)
  })
})
