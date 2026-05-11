import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MappingListView } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingListView'
import type { MappingListMutations } from '@/app/app/projects/[projectId]/mapping/redesign/hooks/useMappingListMutations'
import type {
  MappingsForRedesignResult,
  MappingRow,
  SourceFieldWithState,
  TargetFieldRef,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// MappingListView — action button behavior per row kind.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked rules from the architecture review:
//   • Actions are ALWAYS visible (no hover-reveal). Divergence from
//     target-led FieldMappingRow, justified by Big-4 audit workflow.
//   • Approve is disabled for already-approved rows; Reject is disabled
//     for already-rejected rows.
//   • Single-source mapped row: Approve/Reject route through the TFM id.
//   • Multi-source: parent's actions route through TFM id; child's
//     reject deletes that contributor only.
//   • Unmapped-target: Approve disabled; Reject calls
//     setUnmappedRowRejected({ targetFieldId }).
//   • Unmapped-source: Approve disabled; Reject calls
//     setUnmappedRowRejected({ sourceFieldId }).
//   • Row body click opens drawer; for split children, the clicked
//     child's source field id is passed as highlightedSourceFieldId.
//   • Action button clicks DO NOT bubble to the row's onClick.

function makeTargetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-default',
    name: 'col',
    dataType: 'VARCHAR(50)',
    isNullable: false,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'TGT' },
    ordinalPosition: 1,
    ...overrides,
  }
}

function makeSourceField(
  overrides: Partial<SourceFieldWithState> = {},
): SourceFieldWithState {
  return {
    id: 'sf-default',
    name: 'src_col',
    dataType: 'VARCHAR(50)',
    ordinalPosition: 1,
    sourceTable: { id: 'st-1', name: 'SRC' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
    ...overrides,
  }
}

function makeSingleSourceMapped(
  overrides: { id?: string; status?: 'needs_review' | 'approved' | 'rejected' } = {},
): MappingRow {
  return {
    kind: 'mapped',
    id: overrides.id ?? 'tfm-1',
    targetField: makeTargetField({ id: 'tf-1', name: 'customer_id' }),
    confidence: 90,
    status: overrides.status ?? 'needs_review',
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
          name: 'CUST_ID',
          dataType: 'VARCHAR(50)',
          isNullable: false,
        },
        sourceTable: { id: 'st-1', name: 'CUST_MASTER' },
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

function makeMultiSourceMapped(): MappingRow {
  return {
    kind: 'mapped',
    id: 'tfm-multi',
    targetField: makeTargetField({ id: 'tf-2', name: 'item_number' }),
    confidence: 80,
    status: 'needs_review',
    hasTransformation: false,
    transformationStatus: null,
    sources: [
      {
        id: 'ms-a',
        ordinal: 0,
        confidence: 90,
        aiReasoning: null,
        typeCompatibility: null,
        sourceField: {
          id: 'sf-prodsku',
          name: 'ProductSKU',
          dataType: 'VARCHAR(50)',
          isNullable: false,
        },
        sourceTable: { id: 'st-prod', name: 'Products' },
        joinAnnotation: null,
        joinSpec: null,
        sampleValues: [],
      },
      {
        id: 'ms-b',
        ordinal: 1,
        confidence: 80,
        aiReasoning: null,
        typeCompatibility: null,
        sourceField: {
          id: 'sf-assyitem',
          name: 'Assy_Item',
          dataType: 'VARCHAR(50)',
          isNullable: false,
        },
        sourceTable: { id: 'st-asm', name: 'Assemblies' },
        joinAnnotation: null,
        joinSpec: null,
        sampleValues: [],
      },
    ],
    combinationType: 'concat_space',
    combinationSql: null,
    aiReasoning: null,
  }
}

function makeUnmappedTarget(
  overrides: { status?: 'needs_review' | 'rejected' } = {},
): MappingRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-9',
    targetField: makeTargetField({ id: 'tf-9', name: 'orphan_col' }),
    confidence: null,
    status: overrides.status ?? 'needs_review',
    hasTransformation: false,
    transformationStatus: null,
  }
}

function makeResult(rows: MappingRow[], sourceFields: SourceFieldWithState[] = []) {
  const result: MappingsForRedesignResult = {
    projectId: 'proj-1',
    rows,
    targetTables: [],
    sourceTables: [],
    sourceFieldAcknowledgments: [],
    sourceFields,
    counts: {
      total: 0,
      approved: 0,
      needsReview: 0,
      rejected: 0,
      unmapped: 0,
    },
    targetSchemaEmpty: false,
  }
  return result
}

function makeMutations(): MappingListMutations & {
  approveTfm: ReturnType<typeof vi.fn>
  rejectTfm: ReturnType<typeof vi.fn>
  swapMappingSource: ReturnType<typeof vi.fn>
  swapMappingTarget: ReturnType<typeof vi.fn>
  createFromUnmapped: ReturnType<typeof vi.fn>
  rejectUnmappedRow: ReturnType<typeof vi.fn>
} {
  const success = { success: true }
  return {
    isRowBusy: () => false,
    approveTfm: vi.fn().mockResolvedValue(success),
    rejectTfm: vi.fn().mockResolvedValue(success),
    swapMappingSource: vi.fn().mockResolvedValue(success),
    swapMappingTarget: vi.fn().mockResolvedValue(success),
    createFromUnmapped: vi.fn().mockResolvedValue(success),
    rejectUnmappedRow: vi.fn().mockResolvedValue(success),
  }
}

function findRow(rowId: string): HTMLTableRowElement {
  const el = document.querySelector(`[data-row-id="${rowId}"]`)
  if (!(el instanceof HTMLTableRowElement)) {
    throw new Error(`Row not found for id=${rowId}`)
  }
  return el
}

describe('MappingListView — action buttons per row kind', () => {
  it('approve+reject route through TFM id for a single-source mapped row', async () => {
    const mutations = makeMutations()
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-1')
    fireEvent.click(within(row).getByTestId('flat-row-action-approve'))
    expect(mutations.approveTfm).toHaveBeenCalledWith('tfm-1')

    fireEvent.click(within(row).getByTestId('flat-row-action-reject'))
    expect(mutations.rejectTfm).toHaveBeenCalledWith('tfm-1')
  })

  it('approve button is omitted when row is already approved', () => {
    // Polish pass (second round): buttons are no longer rendered in a
    // disabled state — they're simply omitted from the gutter when
    // not applicable. Cleaner visual that matches the founder's
    // reference shot (no greyed-out chrome).
    const mutations = makeMutations()
    const result = makeResult([
      makeSingleSourceMapped({ status: 'approved' }),
    ])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-1')
    expect(
      within(row).queryByTestId('flat-row-action-approve'),
    ).toBeNull()
    // Reject still renders on an approved row — "un-approve" is a
    // legitimate action for an auditor reviewing past decisions.
    expect(
      within(row).getByTestId('flat-row-action-reject'),
    ).toBeInTheDocument()
  })

  it('reject button is omitted when row is already rejected', () => {
    const mutations = makeMutations()
    const result = makeResult([
      makeSingleSourceMapped({ status: 'rejected' }),
    ])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-1')
    expect(
      within(row).queryByTestId('flat-row-action-reject'),
    ).toBeNull()
    expect(
      within(row).getByTestId('flat-row-action-approve'),
    ).toBeInTheDocument()
  })

  it('multi-source TFM renders N independent flat rows with shimmed contributor ids + bracket accent', () => {
    // Sixth polish pass: multi-source TFMs emit N independent flat
    // rows (one per source). feat/mapping-list-toggle-and-columns
    // refinement pass: target-first sort clusters them adjacent, and
    // the bracket-style accent (┌ first, │ middle, └ last) on the
    // Source Field cell of each row reads as one closed bracket
    // across the group.
    const mutations = makeMutations()
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const rowA = findRow('tfm-multi::ms-a')
    const rowB = findRow('tfm-multi::ms-b')

    for (const row of [rowA, rowB]) {
      expect(row.getAttribute('data-row-kind')).toBe('mapped')
      expect(row.getAttribute('data-multi-source')).toBe('true')
      expect(row.getAttribute('data-source-count')).toBe('2')
      // Both siblings share the TFM uuid as groupId.
      expect(row.getAttribute('data-group-id')).toBe('tfm-multi')
    }

    // The bare TFM uuid is NOT itself a row id when sourceCount > 1.
    expect(document.querySelector('[data-row-id="tfm-multi"]')).toBeNull()

    // The bracket accent lives on the Source FIELD cell (the field
    // is the mapping unit) as an inner span overlay — not on the
    // cell's own className. Position is exposed via
    // data-group-position on the cell.
    // Within a target group, sources sort by source table ASC →
    // source field ASC. The fixture has ms-a in 'Products' and ms-b
    // in 'Assemblies'; 'Assemblies' < 'Products', so ms-b is the
    // first row of the group and ms-a is the last.
    const sourceFieldA = within(rowA).getByTestId('flat-cell-source-field')
    const sourceFieldB = within(rowB).getByTestId('flat-cell-source-field')
    expect(sourceFieldB.getAttribute('data-group-position')).toBe('first')
    expect(sourceFieldA.getAttribute('data-group-position')).toBe('last')
    expect(
      within(sourceFieldA).getByTestId('flat-source-field-bracket'),
    ).toBeInTheDocument()
    expect(
      within(sourceFieldB).getByTestId('flat-source-field-bracket'),
    ).toBeInTheDocument()
  })

  it('single-source mapped rows carry NO multi-source bracket accent', () => {
    const mutations = makeMutations()
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-1')
    const sourceFieldCell = within(row).getByTestId(
      'flat-cell-source-field',
    )
    expect(row.getAttribute('data-multi-source')).toBe('false')
    expect(sourceFieldCell.getAttribute('data-group-position')).toBe('none')
    expect(
      within(sourceFieldCell).queryByTestId('flat-source-field-bracket'),
    ).toBeNull()
  })

  it('multi-source row: Approve is TFM-atomic (parent uuid); Reject is per-source (shimmed id)', async () => {
    const mutations = makeMutations()
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const rowA = findRow('tfm-multi::ms-a')
    fireEvent.click(within(rowA).getByTestId('flat-row-action-approve'))
    // Approve routes through parentRow.id — TFM-atomic, siblings inherit.
    expect(mutations.approveTfm).toHaveBeenCalledWith('tfm-multi')

    fireEvent.click(within(rowA).getByTestId('flat-row-action-reject'))
    // Reject routes through the shimmed contributor id so the server
    // deletes only this attribution (sibling row 'tfm-multi::ms-b'
    // stays mapped).
    expect(mutations.rejectTfm).toHaveBeenCalledWith('tfm-multi::ms-a')
  })

  it('multi-source row: Edit button surfaces; click opens drawer with this source highlighted', async () => {
    const mutations = makeMutations()
    const onOpenDrawer = vi.fn()
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={onOpenDrawer}
      />,
    )

    const rowA = findRow('tfm-multi::ms-a')
    fireEvent.click(within(rowA).getByTestId('flat-row-action-edit'))
    // Edit reuses the row-body click handler — drawer opens keyed on
    // the TFM uuid (groupId) with the clicked contributor's source
    // field id as highlight.
    expect(onOpenDrawer).toHaveBeenCalledWith('tfm-multi', 'sf-prodsku')
  })

  it('unmapped-target: Approve omitted; Reject calls setUnmappedRowRejected with targetFieldId', () => {
    const mutations = makeMutations()
    const result = makeResult([makeUnmappedTarget()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('unmapped::tf-9')
    // No mapping to approve → Approve button is omitted entirely.
    expect(
      within(row).queryByTestId('flat-row-action-approve'),
    ).toBeNull()

    fireEvent.click(within(row).getByTestId('flat-row-action-reject'))
    expect(mutations.rejectUnmappedRow).toHaveBeenCalledWith({
      pendingKey: 'unmapped::tf-9',
      target: { targetFieldId: 'tf-9' },
    })
  })
})

describe('MappingListView — row body click + cell click', () => {
  it('clicking a single-source row body opens the drawer with the source highlighted', () => {
    // Sixth polish pass: every mapped flat row represents one source
    // attribution and the drawer opens anchored to that source. For
    // single-source TFMs the highlight is the lone source.
    const mutations = makeMutations()
    const onOpenDrawer = vi.fn()
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={onOpenDrawer}
      />,
    )

    fireEvent.click(findRow('tfm-1'))
    expect(onOpenDrawer).toHaveBeenCalledWith('tfm-1', 'sf-1')
  })

  it('clicking a multi-source row body opens the drawer keyed on the TFM with this contributor highlighted', () => {
    const mutations = makeMutations()
    const onOpenDrawer = vi.fn()
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={onOpenDrawer}
      />,
    )

    fireEvent.click(findRow('tfm-multi::ms-b'))
    // groupId (bare TFM uuid) + the clicked row's own source field id.
    expect(onOpenDrawer).toHaveBeenCalledWith('tfm-multi', 'sf-assyitem')
  })

  it('clicking an action button does NOT bubble to the row body (drawer does not open)', () => {
    const mutations = makeMutations()
    const onOpenDrawer = vi.fn()
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={onOpenDrawer}
      />,
    )

    const row = findRow('tfm-1')
    fireEvent.click(within(row).getByTestId('flat-row-action-approve'))
    expect(onOpenDrawer).not.toHaveBeenCalled()
  })
})

describe('MappingListView — headers + fixed sort', () => {
  it('renders 6 column headers plus an Actions header', () => {
    const mutations = makeMutations()
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    expect(screen.getByTestId('flat-header-sourceTable')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-sourceField')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-targetTable')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-targetField')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-confidence')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-status')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-actions')).toBeInTheDocument()
  })

  it('applies the fixed sort: target-first → source within target group, blank-source rows last within target', () => {
    // feat/mapping-list-cluster-multi-source: sort flipped from
    // source-first to target-first. Primary keys are target table +
    // target field, then a hasSource flag (real sources first,
    // constant-defaults last within the same target group), then
    // source columns. This clusters multi-source TFMs as adjacent
    // rows and keeps constant-default rows at the bottom of their
    // target's slot.
    const mutations = makeMutations()
    const mapped = makeSingleSourceMapped({ id: 'tfm-mapped' })
    const unmapped = makeUnmappedTarget()
    // Pass unmapped FIRST in the input to verify the sort moves it
    // to its proper place regardless of input order.
    const result = makeResult([unmapped, mapped])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    // Both rows share target table 'TGT'. Their target fields
    // differ: mapped='customer_id', unmapped='orphan_col'.
    // Target-first sort puts customer_id before orphan_col.
    const rows = document.querySelectorAll('[data-testid="flat-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0].getAttribute('data-row-id')).toBe('tfm-mapped')
    expect(rows[1].getAttribute('data-row-id')).toBe('unmapped::tf-9')
  })

  it('multi-source rows cluster as adjacent rows regardless of source-side alphabetical order', () => {
    // The defining behavior of feat/mapping-list-cluster-multi-source:
    // a 2-source TFM (with sources from Assemblies + Products tables)
    // + a single-source TFM mapped to a DIFFERENT target — the
    // multi-source TFM's siblings must appear adjacent in the output.
    // Under the previous source-first sort, the single-source row
    // (source from Products) would sort BETWEEN the multi-source
    // rows alphabetically; under target-first cluster sort it sits
    // separately under its own target.
    const mutations = makeMutations()
    const multi = makeMultiSourceMapped() // target = 'item_number' on TGT
    const single = makeSingleSourceMapped() // target = 'customer_id' on TGT
    const result = makeResult([multi, single])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const rows = document.querySelectorAll('[data-testid="flat-row"]')
    expect(rows.length).toBe(3)
    // Single-source first (target 'customer_id' < 'item_number'),
    // then both multi-source rows clustered.
    expect(rows[0].getAttribute('data-row-id')).toBe('tfm-1')
    expect(rows[1].getAttribute('data-group-id')).toBe('tfm-multi')
    expect(rows[2].getAttribute('data-group-id')).toBe('tfm-multi')
  })
})
