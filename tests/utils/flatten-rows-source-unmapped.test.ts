import { describe, it, expect } from 'vitest'
import type {
  MappingsForRedesignResult,
  MappingRow,
  MappedRow,
  UnmappedRow,
  TargetFieldRef,
  SourceFieldWithState,
  SourceFieldAcknowledgmentSummary,
} from '@/lib/types/mappings-for-redesign'
import {
  flattenRowsForListView,
  countFlatRowStatuses,
} from '@/lib/utils/flatten-rows-for-list-view'

// ─────────────────────────────────────────────────────────────────────────────
// flatten-rows-for-list-view — source-side row synthesis behavior.
// ─────────────────────────────────────────────────────────────────────────────
//
// The flatten utility is responsible for:
//   • Emitting one row per mapped TFM with the full sources[] array
//     (feat/mapping-table-redesign — per-TFM emission; the prior
//     N-rows-per-TFM stacking was retired with the bracket pattern)
//   • Emitting source-side acknowledgment rows (always visible)
//   • Emitting source-only unmapped rows for fields with no mapping
//     and no ack
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
    aiReasoning: null,
    confidence: null,
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
  it('emits source-side acknowledgment rows', () => {
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

    const rows = flattenRowsForListView(result)
    const ackRow = rows.find((r) => r.kind === 'unmapped-source')

    expect(ackRow).toBeDefined()
    if (ackRow?.kind !== 'unmapped-source') throw new Error('shape')
    expect(ackRow.acknowledgmentId).toBe('ack-1')
    expect(ackRow.acknowledgmentReason).toBe('OUT_OF_SCOPE')
    expect(ackRow.status).toBe('approved')
    expect(ackRow.id).toBe('ack::source::ack-1')
  })

  it('renders ack rows with decision="rejected" as needs_review status (Reject = reset)', () => {
    // PR #157 unified the Reject semantic: reject removes the AI's
    // proposal and returns the row to the neutral needs_review (grey)
    // state. The source-side case was the straggler — a rejected source
    // ack now produces a needs_review flat row, identical in rendered
    // status to the mapped / VA / unmapped-target reject outcomes.
    //
    // `buildSourceFieldsWithState` (upstream) has already suppressed the
    // static-config rationale + confidence on the SourceFieldWithState
    // for a rejected field; this fixture mirrors that suppressed shape
    // (aiReasoning: null, confidence: null, isRejected: true). The flat
    // row must faithfully carry the suppressed values — no AI commentary
    // resurfaces — and render the neutral status.
    const sf = makeSourceField({
      id: 'sf-rej',
      isRejected: true,
      aiReasoning: null,
      confidence: null,
    })
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

    const rows = flattenRowsForListView(result)
    const ackRow = rows.find((r) => r.kind === 'unmapped-source')

    expect(ackRow).toBeDefined()
    if (ackRow?.kind !== 'unmapped-source') throw new Error('shape')
    // Neutral grey status — NOT a distinct 'rejected'.
    expect(ackRow.status).toBe('needs_review')
    // Suppression carried through: no rationale, no confidence.
    expect(ackRow.sourceField.aiReasoning).toBeNull()
    expect(ackRow.confidence).toBeNull()
    // The ack row stays visible and addressable — its id/reason are
    // preserved so the audit trail and re-decision affordances work.
    expect(ackRow.acknowledgmentId).toBe('ack-rej')
  })

  it('keeps decision="rejected" suppression independent of the rendered status', () => {
    // Defense-in-depth: even if a rejected ack's SourceFieldWithState
    // still carried rationale (it should not — buildSourceFieldsWithState
    // zeroes it), the flat row's status mapping is decided solely by
    // `ack.decision`, never by the presence of rationale. This pins the
    // status mapping against an accidental coupling to AI commentary.
    const sf = makeSourceField({
      id: 'sf-rej-2',
      isRejected: true,
      aiReasoning: 'stale rationale that should never have survived',
      confidence: 88,
    })
    const ack: SourceFieldAcknowledgmentSummary = {
      id: 'ack-rej-2',
      sourceFieldId: 'sf-rej-2',
      reason: '',
      decision: 'rejected',
    }
    const result = makeResult({
      sourceFields: [sf],
      sourceFieldAcknowledgments: [ack],
    })

    const rows = flattenRowsForListView(result)
    const ackRow = rows.find((r) => r.kind === 'unmapped-source')
    if (ackRow?.kind !== 'unmapped-source') throw new Error('shape')
    expect(ackRow.status).toBe('needs_review')
  })

  it('always emits source-only unmapped rows (toggle retired)', () => {
    // The prior `showUnmappedSourceFields` flatten option was retired
    // at the feat/mapping-list-toggle-and-columns refinement pass —
    // unaddressed source fields ALWAYS surface as
    // 'unmapped-source' rows. Audit workflows need a complete
    // picture; target-first cluster sort keeps these rows contained
    // at the bottom of the table.
    const sf = makeSourceField({ id: 'sf-untouched', name: 'OPEN_COL' })
    const result = makeResult({ sourceFields: [sf] })

    const rows = flattenRowsForListView(result)
    const row = rows.find((r) => r.kind === 'unmapped-source')
    expect(row).toBeDefined()
    if (row?.kind !== 'unmapped-source') throw new Error('shape')
    expect(row.acknowledgmentId).toBeNull()
    expect(row.status).toBe('needs_review')
    expect(row.id).toBe('unmapped-source::sf-untouched')
  })

  it('carries SourceFieldWithState.aiReasoning onto the fall-through unmapped-source row', () => {
    // The unmapped-source FlatRow embeds the full `sourceField`, so the
    // static-config rationale on `SourceFieldWithState.aiReasoning` is
    // available downstream (the RATIONALE column reads it as a fallback
    // when there is no acknowledgment reason).
    const sf = makeSourceField({
      id: 'sf-with-rationale',
      name: 'PRODUCT_NOTES',
      aiReasoning: 'Free-text notes — about 30% null; not migrated.',
    })
    const result = makeResult({ sourceFields: [sf] })

    const rows = flattenRowsForListView(result)
    const row = rows.find((r) => r.kind === 'unmapped-source')
    if (row?.kind !== 'unmapped-source') throw new Error('shape')
    expect(row.acknowledgmentId).toBeNull()
    expect(row.sourceField.aiReasoning).toBe(
      'Free-text notes — about 30% null; not migrated.',
    )
  })

  it('carries a null aiReasoning when the source field has no static rationale', () => {
    const sf = makeSourceField({ id: 'sf-no-rationale', name: 'OPEN_COL' })
    const result = makeResult({ sourceFields: [sf] })

    const rows = flattenRowsForListView(result)
    const row = rows.find((r) => r.kind === 'unmapped-source')
    if (row?.kind !== 'unmapped-source') throw new Error('shape')
    expect(row.sourceField.aiReasoning).toBeNull()
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
        isPrimaryKey: false,
        isForeignKey: false,
        fkReference: null,
        description: null,
        sampleValues: [],
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

    const rows = flattenRowsForListView(result)
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

    const rows = flattenRowsForListView(result)
    // Exactly one unmapped-source row, and it carries the ack id (not
    // the synthetic "unmapped-source::<sf-id>" id).
    const sourceRows = rows.filter((r) => r.kind === 'unmapped-source')
    expect(sourceRows).toHaveLength(1)
    expect(sourceRows[0].id).toBe('ack::source::ack-1')
  })

  it('emits a multi-source TFM as ONE flat row carrying the full sources[] array sorted by ordinal ASC', () => {
    // feat/mapping-table-redesign: per-TFM emission. The renderer
    // shows `sources[0]` inline on the main row and surfaces sources[1..]
    // via the "+N source" expand/collapse pill. No more shimmed
    // contributor ids — the row id IS the bare TFM uuid.
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
        isPrimaryKey: false,
        isForeignKey: false,
        fkReference: null,
        description: null,
        sampleValues: [],
      },
      confidence: 80,
      status: 'needs_review',
      hasTransformation: false,
      transformationStatus: null,
      // Intentionally provided in REVERSE ordinal order so the test
      // asserts the flatten step sorts by ordinal ASC.
      sources: [
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
      ],
      combinationType: 'concat_space',
      combinationSql: null,
      aiReasoning: null,
    }
    const result = makeResult({ rows: [mappedRow] })

    const rows = flattenRowsForListView(result)
    // ONE flat row for the TFM, regardless of source count.
    expect(rows.length).toBe(1)
    const flat = rows[0]
    if (flat.kind !== 'mapped') throw new Error('shape')

    // Bare TFM uuid — no shimmed contributor suffix.
    expect(flat.id).toBe('tfm-multi')
    expect(flat.groupId).toBe('tfm-multi')

    // Full sources array, sorted by ordinal ASC. ms-1 (ordinal=0) is
    // the primary even though it appeared second in the input.
    expect(flat.sources.length).toBe(2)
    expect(flat.sources[0].id).toBe('ms-1')
    expect(flat.sources[0].ordinal).toBe(0)
    expect(flat.sources[1].id).toBe('ms-2')
    expect(flat.sources[1].ordinal).toBe(1)
  })

  it('emits a single-source mapped TFM as ONE flat row carrying a one-element sources[]', () => {
    const mappedRow: MappingRow = {
      kind: 'mapped',
      id: 'tfm-single',
      targetField: {
        id: 'tf-1',
        name: 'customer_id',
        dataType: 'VARCHAR(50)',
        isNullable: false,
        defaultValue: null,
        targetTable: { id: 'tt-1', name: 'Customers' },
        ordinalPosition: 1,
        isPrimaryKey: false,
        isForeignKey: false,
        fkReference: null,
        description: null,
        sampleValues: [],
      },
      confidence: 95,
      status: 'approved',
      hasTransformation: false,
      transformationStatus: null,
      sources: [
        {
          id: 'ms-1',
          ordinal: 0,
          confidence: 95,
          aiReasoning: null,
          typeCompatibility: null,
          sourceField: {
            id: 'sf-1',
            name: 'entityid',
            dataType: 'VARCHAR(50)',
            isNullable: false,
          },
          sourceTable: { id: 'st-1', name: 'Customer' },
          joinAnnotation: null,
          joinSpec: null,
          sampleValues: [],
        },
      ],
      combinationType: 'single',
      combinationSql: null,
      aiReasoning: null,
    }
    const result = makeResult({ rows: [mappedRow] })

    const rows = flattenRowsForListView(result)
    expect(rows.length).toBe(1)
    const flat = rows[0]
    if (flat.kind !== 'mapped') throw new Error('shape')
    expect(flat.id).toBe('tfm-single')
    expect(flat.sources.length).toBe(1)
    expect(flat.sources[0].id).toBe('ms-1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// countFlatRowStatuses — shared status tally.
// ─────────────────────────────────────────────────────────────────────────────
//
// Canonical counter for the Mapping page summary strip's Approved /
// Needs Review chips AND the Migration Center "Mapping Coverage" card.
// Both surfaces flatten the same result and tally it here, so the two
// numbers must agree. Pins: rejected folds into needsReview, and all
// four flat-row kinds (incl. unmapped-source) are counted.

function makeTargetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-default',
    name: 'tgt_col',
    dataType: 'VARCHAR(50)',
    isNullable: false,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'TGT_TABLE' },
    ordinalPosition: 1,
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
    ...overrides,
  }
}

function makeMappedRow(
  id: string,
  status: MappedRow['status'],
  sourceFieldId: string,
): MappedRow {
  return {
    kind: 'mapped',
    id,
    targetField: makeTargetField({ id: `tf-${id}` }),
    confidence: 90,
    status,
    hasTransformation: false,
    transformationStatus: null,
    sources: [
      {
        id: `ms-${id}`,
        ordinal: 0,
        confidence: 90,
        aiReasoning: null,
        typeCompatibility: null,
        sourceField: {
          id: sourceFieldId,
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
}

function makeUnmappedTargetRow(
  id: string,
  status: UnmappedRow['status'],
): UnmappedRow {
  return {
    kind: 'unmapped',
    id,
    targetField: makeTargetField({ id: `tf-${id}` }),
    confidence: null,
    status,
    hasTransformation: false,
    transformationStatus: null,
  }
}

describe('countFlatRowStatuses', () => {
  it('returns zero counts for an empty projection', () => {
    expect(countFlatRowStatuses([])).toEqual({ approved: 0, needsReview: 0 })
  })

  it('counts approved and needs_review across mapped + unmapped-target rows', () => {
    const result = makeResult({
      rows: [
        makeMappedRow('tfm-a', 'approved', 'sf-a'),
        makeMappedRow('tfm-b', 'needs_review', 'sf-b'),
        makeUnmappedTargetRow('unm-1', 'approved'),
        makeUnmappedTargetRow('unm-2', 'needs_review'),
      ],
    })
    expect(countFlatRowStatuses(flattenRowsForListView(result))).toEqual({
      approved: 2,
      needsReview: 2,
    })
  })

  it('folds rejected rows into needsReview (Reject = reset, no distinct bucket)', () => {
    const result = makeResult({
      rows: [
        makeMappedRow('tfm-a', 'approved', 'sf-a'),
        makeMappedRow('tfm-r', 'rejected', 'sf-r'),
      ],
    })
    expect(countFlatRowStatuses(flattenRowsForListView(result))).toEqual({
      approved: 1,
      needsReview: 1,
    })
  })

  it('counts unmapped-source rows — the target-axis-only count would miss these', () => {
    // A pure unmapped source field flattens to an unmapped-source row
    // with status 'needs_review'. This is exactly the contribution
    // `projectStats.target.needsReview` omits — the divergence the
    // Migration Center card adopts this counter to avoid.
    const result = makeResult({
      rows: [makeMappedRow('tfm-a', 'approved', 'sf-mapped')],
      sourceFields: [
        makeSourceField({ id: 'sf-mapped' }),
        makeSourceField({ id: 'sf-orphan-1' }),
        makeSourceField({ id: 'sf-orphan-2' }),
      ],
    })
    // sf-mapped is referenced by the TFM, so only the two orphans emit
    // unmapped-source rows — both 'needs_review'.
    expect(countFlatRowStatuses(flattenRowsForListView(result))).toEqual({
      approved: 1,
      needsReview: 2,
    })
  })
})
