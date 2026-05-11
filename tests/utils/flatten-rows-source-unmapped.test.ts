import { describe, it, expect } from 'vitest'
import type {
  MappingsForRedesignResult,
  MappingRow,
  SourceFieldWithState,
  SourceFieldAcknowledgmentSummary,
} from '@/lib/types/mappings-for-redesign'
import { flattenRowsForListView } from '@/lib/utils/flatten-rows-for-list-view'

// ─────────────────────────────────────────────────────────────────────────────
// flatten-rows-for-list-view — source-side row synthesis behavior.
// ─────────────────────────────────────────────────────────────────────────────
//
// The flatten utility is responsible for:
//   • Splitting multi-source mapped TFMs into parent + N child rows
//   • Emitting source-side acknowledgment rows (always visible)
//   • Emitting source-only unmapped rows (gated by toggle, default OFF)
//   • NOT emitting source-only rows for fields already referenced by
//     any mapping
//
// Coverage of mapped/VA/unmapped target row emission lives alongside
// the main MappingListView tests; this file pins the source-side
// asymmetric branches specifically because they were the v2 addition.

function makeSourceField(
  overrides: Partial<SourceFieldWithState> = {},
): SourceFieldWithState {
  return {
    id: 'sf-default',
    name: 'COL_DEFAULT',
    dataType: 'VARCHAR(50)',
    ordinalPosition: 1,
    sourceTable: { id: 'st-default', name: 'DEFAULT_TABLE' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
    ...overrides,
  }
}

function makeResult(
  overrides: Partial<MappingsForRedesignResult> = {},
): MappingsForRedesignResult {
  return {
    projectId: 'proj-1',
    rows: [],
    targetTables: [],
    sourceTables: [],
    sourceFieldAcknowledgments: [],
    sourceFields: [],
    counts: {
      total: 0,
      approved: 0,
      needsReview: 0,
      rejected: 0,
      unmapped: 0,
    },
    targetSchemaEmpty: false,
    ...overrides,
  }
}

describe('flattenRowsForListView — source-side rows', () => {
  it('emits source-side acknowledgment rows even when showUnmappedSourceFields is OFF', () => {
    const sf = makeSourceField({ id: 'sf-ack', name: 'LEGACY_COL' })
    const ack: SourceFieldAcknowledgmentSummary = {
      id: 'ack-1',
      sourceFieldId: 'sf-ack',
      reason: 'OUT_OF_SCOPE',
      decision: 'acknowledged',
    }
    const result = makeResult({
      sourceFields: [sf],
      sourceFieldAcknowledgments: [ack],
    })

    const rows = flattenRowsForListView(result, {
      showUnmappedSourceFields: false,
    })
    const ackRow = rows.find((r) => r.kind === 'unmapped-source')

    expect(ackRow).toBeDefined()
    if (ackRow?.kind !== 'unmapped-source') throw new Error('shape')
    expect(ackRow.acknowledgmentId).toBe('ack-1')
    expect(ackRow.acknowledgmentReason).toBe('OUT_OF_SCOPE')
    expect(ackRow.status).toBe('approved')
    expect(ackRow.id).toBe('ack::source::ack-1')
  })

  it('renders ack rows with decision="rejected" as rejected status (gray dot)', () => {
    const sf = makeSourceField({ id: 'sf-rej' })
    const ack: SourceFieldAcknowledgmentSummary = {
      id: 'ack-rej',
      sourceFieldId: 'sf-rej',
      reason: '',
      decision: 'rejected',
    }
    const result = makeResult({
      sourceFields: [sf],
      sourceFieldAcknowledgments: [ack],
    })

    const rows = flattenRowsForListView(result, {
      showUnmappedSourceFields: false,
    })
    const ackRow = rows.find((r) => r.kind === 'unmapped-source')

    expect(ackRow).toBeDefined()
    if (ackRow?.kind !== 'unmapped-source') throw new Error('shape')
    // Migration 103 / PR #132: ack.decision drives the row's status.
    // Rejected acks render gray (status='rejected'); acknowledged acks
    // render green (status='approved'). Both stay visible in the flat
    // view because they represent explicit user decisions.
    expect(ackRow.status).toBe('rejected')
  })

  it('skips source-only unmapped rows when showUnmappedSourceFields is OFF', () => {
    const sf = makeSourceField({ id: 'sf-untouched' })
    const result = makeResult({ sourceFields: [sf] })

    const rows = flattenRowsForListView(result, {
      showUnmappedSourceFields: false,
    })
    expect(rows).toHaveLength(0)
  })

  it('emits source-only unmapped rows when showUnmappedSourceFields is ON', () => {
    const sf = makeSourceField({ id: 'sf-untouched', name: 'OPEN_COL' })
    const result = makeResult({ sourceFields: [sf] })

    const rows = flattenRowsForListView(result, {
      showUnmappedSourceFields: true,
    })
    const row = rows.find((r) => r.kind === 'unmapped-source')
    expect(row).toBeDefined()
    if (row?.kind !== 'unmapped-source') throw new Error('shape')
    expect(row.acknowledgmentId).toBeNull()
    expect(row.status).toBe('needs_review')
    expect(row.id).toBe('unmapped-source::sf-untouched')
  })

  it('does NOT emit source-only rows for fields referenced by any mapping', () => {
    const sf = makeSourceField({ id: 'sf-mapped' })
    const mappedRow: MappingRow = {
      kind: 'mapped',
      id: 'tfm-1',
      targetField: {
        id: 'tf-1',
        name: 'tgt_col',
        dataType: 'VARCHAR(50)',
        isNullable: false,
        defaultValue: null,
        targetTable: { id: 'tt-1', name: 'TGT_TABLE' },
        ordinalPosition: 1,
      },
      confidence: 90,
      status: 'approved',
      hasTransformation: false,
      transformationStatus: null,
      sources: [
        {
          id: 'ms-1',
          ordinal: 0,
          confidence: 90,
          aiReasoning: null,
          typeCompatibility: null,
          sourceField: {
            id: 'sf-mapped',
            name: 'src_col',
            dataType: 'VARCHAR(50)',
            isNullable: false,
          },
          sourceTable: { id: 'st-1', name: 'SRC_TABLE' },
          joinAnnotation: null,
          joinSpec: null,
          sampleValues: [],
        },
      ],
      combinationType: 'single',
      combinationSql: null,
      aiReasoning: null,
    }
    const result = makeResult({
      rows: [mappedRow],
      sourceFields: [sf],
    })

    const rows = flattenRowsForListView(result, {
      showUnmappedSourceFields: true,
    })
    expect(rows.some((r) => r.kind === 'unmapped-source')).toBe(false)
  })

  it('prefers acknowledgment row over source-only unmapped when both could apply', () => {
    const sf = makeSourceField({ id: 'sf-ack' })
    const ack: SourceFieldAcknowledgmentSummary = {
      id: 'ack-1',
      sourceFieldId: 'sf-ack',
      reason: 'OUT_OF_SCOPE',
      decision: 'acknowledged',
    }
    const result = makeResult({
      sourceFields: [sf],
      sourceFieldAcknowledgments: [ack],
    })

    const rows = flattenRowsForListView(result, {
      showUnmappedSourceFields: true,
    })
    // Exactly one unmapped-source row, and it carries the ack id (not
    // the synthetic "unmapped-source::<sf-id>" id).
    const sourceRows = rows.filter((r) => r.kind === 'unmapped-source')
    expect(sourceRows).toHaveLength(1)
    expect(sourceRows[0].id).toBe('ack::source::ack-1')
  })

  it('emits a multi-source TFM as a single row with sources array (Option C dropped)', () => {
    const mappedRow: MappingRow = {
      kind: 'mapped',
      id: 'tfm-multi',
      targetField: {
        id: 'tf-1',
        name: 'Item_Number',
        dataType: 'VARCHAR(50)',
        isNullable: false,
        defaultValue: null,
        targetTable: { id: 'tt-1', name: 'Items' },
        ordinalPosition: 1,
      },
      confidence: 80,
      status: 'needs_review',
      hasTransformation: false,
      transformationStatus: null,
      sources: [
        {
          id: 'ms-1',
          ordinal: 0,
          confidence: 90,
          aiReasoning: null,
          typeCompatibility: null,
          sourceField: {
            id: 'sf-1',
            name: 'ProductSKU',
            dataType: 'VARCHAR(50)',
            isNullable: false,
          },
          sourceTable: { id: 'st-1', name: 'Products' },
          joinAnnotation: null,
          joinSpec: null,
          sampleValues: [],
        },
        {
          id: 'ms-2',
          ordinal: 1,
          confidence: 80,
          aiReasoning: null,
          typeCompatibility: null,
          sourceField: {
            id: 'sf-2',
            name: 'Assy_Item',
            dataType: 'VARCHAR(50)',
            isNullable: false,
          },
          sourceTable: { id: 'st-2', name: 'Assemblies' },
          joinAnnotation: null,
          joinSpec: null,
          sampleValues: [],
        },
      ],
      combinationType: 'concat_space',
      combinationSql: null,
      aiReasoning: null,
    }
    const result = makeResult({ rows: [mappedRow] })

    const rows = flattenRowsForListView(result)
    // Sixth polish pass: multi-source TFMs emit N INDEPENDENT flat
    // rows (one per source attribution). Each row carries `source`
    // (singular) + `sourceCount=N` so the renderer can paint the
    // left-accent border to identify sibling rows post-sort.
    expect(rows.length).toBe(2)
    expect(rows[0].kind).toBe('mapped')
    expect(rows[1].kind).toBe('mapped')
    // Row ids use the shimmed contributor form for multi-source so
    // A's `rejectFieldMapping` deletes the right `mapping_sources`
    // row on per-source reject.
    expect(rows[0].id).toBe('tfm-multi::ms-1')
    expect(rows[1].id).toBe('tfm-multi::ms-2')
    if (rows[0].kind !== 'mapped' || rows[1].kind !== 'mapped') {
      throw new Error('shape')
    }
    expect(rows[0].source.id).toBe('ms-1')
    expect(rows[1].source.id).toBe('ms-2')
    expect(rows[0].sourceCount).toBe(2)
    expect(rows[1].sourceCount).toBe(2)
    // groupId stays the TFM uuid for both — used by the renderer to
    // identify sibling rows post-sort.
    expect(rows[0].groupId).toBe('tfm-multi')
    expect(rows[1].groupId).toBe('tfm-multi')
  })
})
