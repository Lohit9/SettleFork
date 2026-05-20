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
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
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
    aiReasoning: null,
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

function makeValueAssignment(
  overrides: { status?: 'needs_review' | 'approved' | 'rejected' } = {},
): MappingRow {
  return {
    kind: 'value_assignment',
    id: 'tfm-va-1',
    targetField: makeTargetField({ id: 'tf-va', name: 'created_at' }),
    confidence: 92,
    status: overrides.status ?? 'approved',
    hasTransformation: true,
    transformationStatus: 'applied',
    combinationType: 'custom_sql',
    combinationSql: 'NOW()',
    aiReasoning: null,
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
  approveUnmappedSource: ReturnType<typeof vi.fn>
  promoteUnmappedSource: ReturnType<typeof vi.fn>
  editMappingSources: ReturnType<typeof vi.fn>
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
    approveUnmappedSource: vi.fn().mockResolvedValue(success),
    promoteUnmappedSource: vi.fn().mockResolvedValue(success),
    editMappingSources: vi.fn().mockResolvedValue(success),
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

  it('multi-source TFM renders ONE row with sources[0] inline + "+N source" pill', () => {
    // feat/mapping-table-redesign: one flat row per TFM regardless of
    // source count. sources[0] (ordinal=0) shows inline; the pill
    // surfaces sources[1..] via expand/collapse. The fixture has
    // ms-a at ordinal=0 (ProductSKU / Products) and ms-b at ordinal=1
    // (Assy_Item / Assemblies), so ms-a is the inline primary.
    const mutations = makeMutations()
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    // ONE row for the TFM — no shimmed contributor rows.
    const rows = document.querySelectorAll('[data-testid="flat-row"]')
    expect(rows.length).toBe(1)

    const row = findRow('tfm-multi')
    expect(row.getAttribute('data-row-kind')).toBe('mapped')
    expect(row.getAttribute('data-multi-source')).toBe('true')
    expect(row.getAttribute('data-source-count')).toBe('2')
    expect(row.getAttribute('data-group-id')).toBe('tfm-multi')

    // Pill exists and renders "+ 1 source" (sourceCount - 1, singular).
    const pill = within(row).getByTestId('flat-multi-source-pill')
    expect(pill.textContent).toContain('+ 1 source')
    expect(pill.getAttribute('aria-expanded')).toBe('false')

    // No sub-rows render while collapsed.
    expect(
      document.querySelectorAll('[data-testid="flat-row-subrow"]').length,
    ).toBe(0)

    // sources[0] is shown inline — primary by ordinal, not by source
    // table name alphabetical order.
    const sourceTableLabel = within(row).getByTestId('flat-cell-source-table')
    expect(sourceTableLabel.textContent).toBe('Products')
  })

  it('clicking the +N pill expands sub-rows; clicking again collapses', () => {
    // Sub-rows render only when expanded. Each sub-row carries the
    // source-table label, field chip, and a muted "Also contributes
    // to <target>" caption. Sub-rows have NO action buttons (per-source
    // reject moves to the drawer).
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-multi')
    const pill = within(row).getByTestId('flat-multi-source-pill')

    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(
      document.querySelectorAll('[data-testid="flat-row-subrow"]').length,
    ).toBe(0)

    fireEvent.click(pill)

    expect(pill.getAttribute('aria-expanded')).toBe('true')
    const subRows = document.querySelectorAll('[data-testid="flat-row-subrow"]')
    expect(subRows.length).toBe(1)
    const subRow = subRows[0] as HTMLTableRowElement
    expect(subRow.getAttribute('data-parent-row-id')).toBe('tfm-multi')
    expect(subRow.getAttribute('data-sub-source-id')).toBe('ms-b')
    expect(
      within(subRow).getByTestId('flat-subrow-source-table').textContent,
    ).toBe('Assemblies')
    expect(
      within(subRow).getByTestId('flat-subrow-caption').textContent,
    ).toBe('Also contributes to item_number')
    // No actions on sub-rows.
    expect(within(subRow).queryByTestId('flat-row-action-approve')).toBeNull()
    expect(within(subRow).queryByTestId('flat-row-action-reject')).toBeNull()
    expect(within(subRow).queryByTestId('flat-row-action-edit')).toBeNull()

    // Collapse.
    fireEvent.click(pill)
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(
      document.querySelectorAll('[data-testid="flat-row-subrow"]').length,
    ).toBe(0)
  })

  it('single-source mapped rows carry NO "+N source" pill', () => {
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-1')
    expect(row.getAttribute('data-multi-source')).toBe('false')
    expect(within(row).queryByTestId('flat-multi-source-pill')).toBeNull()
    expect(
      document.querySelectorAll('[data-testid="flat-row-subrow"]').length,
    ).toBe(0)
  })

  it('multi-source row: both Approve and Reject are TFM-atomic on the bare TFM uuid', async () => {
    // feat/mapping-table-redesign — reject is no longer per-source on
    // the main row. Per-source reject moves into the drawer's source
    // list. The flat view's main row operates TFM-atomically.
    const mutations = makeMutations()
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-multi')
    fireEvent.click(within(row).getByTestId('flat-row-action-approve'))
    expect(mutations.approveTfm).toHaveBeenCalledWith('tfm-multi')

    fireEvent.click(within(row).getByTestId('flat-row-action-reject'))
    expect(mutations.rejectTfm).toHaveBeenCalledWith('tfm-multi')
  })

  it('multi-source row: Edit opens the drawer for the TFM with the primary source highlighted', async () => {
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

    const row = findRow('tfm-multi')
    fireEvent.click(within(row).getByTestId('flat-row-action-edit'))
    // Primary source (ms-a, ordinal=0) is highlighted; bare TFM uuid as drawer key.
    expect(onOpenDrawer).toHaveBeenCalledWith('tfm-multi', 'sf-prodsku')
  })

  it('unmapped-target: Approve and Reject both route through the TFM helpers with the unmapped::<targetFieldId> sentinel', () => {
    // feat/mapping-table-redesign refinement pass 2 + post-rebase reject
    // alignment: both approve and reject on the flat-view unmapped-target
    // dispatch through approveTfm/rejectTfm (the same helpers used for
    // mapped rows). The server actions `approveFieldMapping` /
    // `rejectFieldMapping` branch on the `unmapped::` prefix and route to
    // `setCoverageStatus`. This keeps flat-view reject identical to the
    // target-led view's reject (which also calls `rejectFieldMapping`).
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
    fireEvent.click(within(row).getByTestId('flat-row-action-approve'))
    expect(mutations.approveTfm).toHaveBeenCalledWith('unmapped::tf-9')

    fireEvent.click(within(row).getByTestId('flat-row-action-reject'))
    expect(mutations.rejectTfm).toHaveBeenCalledWith('unmapped::tf-9')
    // Reject no longer routes through `rejectUnmappedRow` — that helper
    // remains in the hook for future use but the flat-view dispatch was
    // consolidated post-rebase.
    expect(mutations.rejectUnmappedRow).not.toHaveBeenCalled()
  })

  // feat/mapping-list-toggle-and-columns refinement pass: the Edit pencil
  // now renders on every row with a target — value-assignment AND
  // unmapped-target — not just rows with a mapped source. Mirrors the
  // flat view's "every row carries an edit affordance" contract. Click
  // routes through the row-body handler so the same drawer-open behavior
  // applies as clicking the row body itself.
  it('unmapped-target: Edit pencil surfaces and clicking it opens the drawer', () => {
    const onOpenDrawer = vi.fn()
    const result = makeResult([makeUnmappedTarget()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={onOpenDrawer}
      />,
    )

    const row = findRow('unmapped::tf-9')
    const editButton = within(row).getByTestId('flat-row-action-edit')
    expect(editButton).toBeInTheDocument()
    fireEvent.click(editButton)
    // Drawer opens keyed on the row's groupId (the unmapped-target row's
    // own id since there's no TFM yet); no source to highlight.
    expect(onOpenDrawer).toHaveBeenCalledWith('unmapped::tf-9', null)
  })
})

// ─── Clickable "—" in the Source Field column ──────────────────────────────
//
// feat/mapping-list-toggle-and-columns refinement pass: value-assignment
// rows render "—" in the Source Field cell (no source is mapped — the
// target gets a constant SQL value instead). The "—" is now CLICKABLE:
// the same InlineSourcePicker that opens for a mapped source pill or
// the unmapped-target "Pick a source…" affordance opens for the dash.
// Cursor-pointer on hover signals clickability. The Source TABLE cell
// stays non-interactive ("—" is purely informational there).

describe('MappingListView — clickable "—" on value-assignment source field', () => {
  it('value-assignment renders the Source Field cell as a clickable button (not a plain span)', () => {
    const result = makeResult([makeValueAssignment()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-va-1')
    const sourceFieldCell = within(row).getByTestId('flat-cell-source-field')
    const button = within(sourceFieldCell).getByTestId(
      'flat-cell-source-field-button',
    )
    expect(button).toBeInTheDocument()
    expect(button.tagName).toBe('BUTTON')
    expect(button.textContent).toContain('—')
    // Cursor-pointer + hover signal clickability.
    expect(button.className).toContain('cursor-pointer')
  })

  it('renders no separate Source TABLE label on value-assignment rows (merged Source cell only carries the field affordance)', () => {
    // feat/mapping-table-redesign — Source TABLE and Source FIELD
    // collapsed into one cell. On value-assignment rows there is no
    // source field, so the cell holds only the clickable em-dash for
    // picking a source. The source-table label span is conditional and
    // does NOT render when the row has no source — the table identity
    // is undefined until a source is picked. Preserves the prior intent
    // (no interactive source-table affordance on VA rows) under the new
    // merged structure.
    const result = makeResult([makeValueAssignment()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-va-1')
    expect(within(row).queryByTestId('flat-cell-source-table')).toBeNull()
    // The merged Source cell still surfaces the em-dash via the field
    // affordance — verify it sits inside the source-field button, not
    // a standalone source-table span.
    const sourceCell = within(row).getByTestId('flat-cell-source')
    expect(sourceCell.textContent).toContain('—')
  })

  it('clicking the value-assignment "—" opens the InlineSourcePicker', async () => {
    // Pin the affordance: same picker that opens for a populated source
    // pill or the unmapped-target "Pick a source…" button opens here.
    const sourceField: SourceFieldWithState = {
      id: 'sf-new',
      name: 'NEW_SOURCE',
      dataType: 'VARCHAR(50)',
      ordinalPosition: 1,
      sourceTable: { id: 'st-x', name: 'SRC_X' },
      mappingStatus: 'unmapped',
      sampleValues: [],
      isAcknowledged: false,
      isRejected: false,
      aiReasoning: null,
    }
    const result = makeResult([makeValueAssignment()], [sourceField])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )

    const row = findRow('tfm-va-1')
    const button = within(row).getByTestId('flat-cell-source-field-button')
    fireEvent.click(button)
    expect(
      await screen.findByTestId('inline-source-picker'),
    ).toBeInTheDocument()
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

  it('clicking a multi-source row body opens the drawer keyed on the TFM with the primary source highlighted', () => {
    // feat/mapping-table-redesign — multi-source TFMs render as one
    // row. Row-body click opens the drawer with sources[0] highlighted
    // (the inline primary by ordinal). Per-source navigation to other
    // contributors happens inside the drawer.
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

    fireEvent.click(findRow('tfm-multi'))
    expect(onOpenDrawer).toHaveBeenCalledWith('tfm-multi', 'sf-prodsku')
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

    // feat/mapping-table-redesign — header testids reflect the merged
    // column structure. Source/Target table+field columns collapsed
    // into single Source / Target columns; new Rationale column inserted
    // before Confidence; arrow glyph between Source and Target carries
    // its own (empty) header for sort-tracking parity.
    expect(screen.getByTestId('flat-header-source')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-arrow')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-target')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-rationale')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-confidence')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-status')).toBeInTheDocument()
    expect(screen.getByTestId('flat-header-actions')).toBeInTheDocument()
  })

  it('applies source-first ordering: mapped rows (bucket 0) precede unmapped-target (bucket 2) regardless of input order', () => {
    // feat/mapping-table-refinements — source-first three-bucket order:
    //   bucket 0: mapped (sort by source table → source field)
    //   bucket 1: unmapped-source
    //   bucket 2: value-assignment + unmapped-target (sort by target columns)
    // Mapped rows are always above unmapped-target rows across the
    // bucket boundary — independent of how their target tables compare.
    const mutations = makeMutations()
    const mapped = makeSingleSourceMapped({ id: 'tfm-mapped' }) // source: CUST_MASTER/CUST_ID
    const unmapped = makeUnmappedTarget() // target: TGT/orphan_col
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

    const rows = document.querySelectorAll('[data-testid="flat-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0].getAttribute('data-row-id')).toBe('tfm-mapped')
    expect(rows[1].getAttribute('data-row-id')).toBe('unmapped::tf-9')
  })

  it('mapped rows sort alphabetically by primary source table within bucket 0', () => {
    // feat/mapping-table-refinements — within the mapped bucket, sort
    // is source-anchored. Multi-source TFMs use sources[0] (the
    // primary by ordinal) as the sort key.
    //   single-source fixture: CUST_MASTER / CUST_ID
    //   multi-source fixture:  Products    / ProductSKU  (sources[0])
    // 'CUST_MASTER' < 'Products' alphabetically → single comes first.
    const mutations = makeMutations()
    const multi = makeMultiSourceMapped()
    const single = makeSingleSourceMapped()
    const result = makeResult([multi, single])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const rows = document.querySelectorAll('[data-testid="flat-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0].getAttribute('data-row-id')).toBe('tfm-1')
    expect(rows[1].getAttribute('data-row-id')).toBe('tfm-multi')
  })

  it('emits unmapped-source rows in bucket 1, between mapped (bucket 0) and unmapped-target (bucket 2)', () => {
    // feat/mapping-table-refinements — pin the full three-bucket order.
    // Construct a result with one mapped row, one source-only field
    // (no mapping, no ack — flat view always emits these), and one
    // unmapped-target row. Expected output order:
    //   1. mapped         (bucket 0, source CUST_MASTER/CUST_ID)
    //   2. unmapped-source (bucket 1, source ZZ_LEGACY/ZZ_COL)
    //   3. unmapped-target (bucket 2, target TGT/orphan_col)
    const mutations = makeMutations()
    const mapped = makeSingleSourceMapped({ id: 'tfm-mapped' })
    const unmappedTarget = makeUnmappedTarget()
    const orphanSourceField: SourceFieldWithState = {
      id: 'sf-orphan',
      name: 'ZZ_COL',
      dataType: 'VARCHAR(50)',
      ordinalPosition: 1,
      sourceTable: { id: 'st-zz', name: 'ZZ_LEGACY' },
      mappingStatus: 'unmapped',
      sampleValues: [],
      isAcknowledged: false,
      isRejected: false,
      aiReasoning: null,
    }
    const result = makeResult([mapped, unmappedTarget], [orphanSourceField])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )

    const rows = document.querySelectorAll('[data-testid="flat-row"]')
    expect(rows.length).toBe(3)
    expect(rows[0].getAttribute('data-row-id')).toBe('tfm-mapped')
    expect(rows[1].getAttribute('data-row-id')).toBe('unmapped-source::sf-orphan')
    expect(rows[2].getAttribute('data-row-id')).toBe('unmapped::tf-9')
  })
})

// ─── feat/mapping-row-uniformity — unmapped-source affordances ────────────

describe('MappingListView — unmapped-source affordance uniformity (feat/mapping-row-uniformity)', () => {
  function makeOrphanSourceField(
    overrides: Partial<SourceFieldWithState> = {},
  ): SourceFieldWithState {
    return {
      id: 'sf-orphan',
      name: 'BOM_QUANTITY',
      dataType: 'NUMBER',
      ordinalPosition: 1,
      sourceTable: { id: 'st-bom', name: 'BOM_MASTERS' },
      mappingStatus: 'unmapped',
      sampleValues: [],
      isAcknowledged: false,
      isRejected: false,
      aiReasoning: null,
      ...overrides,
    }
  }

  it('renders the approve / reject / edit hover cluster on unmapped-source rows', () => {
    // Pre-uniformity these rows rendered no action affordances. Post
    // feat/mapping-row-uniformity they match every other row kind.
    const result = makeResult([], [makeOrphanSourceField()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    expect(
      within(row).getByTestId('flat-row-action-approve'),
    ).toBeInTheDocument()
    expect(
      within(row).getByTestId('flat-row-action-reject'),
    ).toBeInTheDocument()
    expect(
      within(row).getByTestId('flat-row-action-edit'),
    ).toBeInTheDocument()
  })

  it('renders SourceFieldWithState.aiReasoning in the RATIONALE cell of an unmapped-source row', () => {
    // deriveRationaleSource falls back to the static-config rationale on
    // `sourceField.aiReasoning` when there is no acknowledgment reason.
    // The cell shows a one-line summary; the raw text is on the span's
    // `title`. Assert the raw rationale reached the cell.
    const result = makeResult(
      [],
      [
        makeOrphanSourceField({
          aiReasoning:
            'Internal numeric primary key from the source system (Prosys).',
        }),
      ],
    )
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    const cell = within(row).getByTestId('flat-cell-rationale')
    expect(cell.querySelector('span')?.getAttribute('title')).toBe(
      'Internal numeric primary key from the source system (Prosys).',
    )
  })

  it('renders an em-dash in the RATIONALE cell when an unmapped-source row has no aiReasoning', () => {
    const result = makeResult([], [makeOrphanSourceField({ aiReasoning: null })])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    const cell = within(row).getByTestId('flat-cell-rationale')
    expect(cell.textContent).toBe('—')
  })

  it('clicking Approve on an unmapped-source row calls mutations.approveUnmappedSource({pendingKey, sourceFieldId})', async () => {
    const mutations = makeMutations()
    const result = makeResult([], [makeOrphanSourceField()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    fireEvent.click(within(row).getByTestId('flat-row-action-approve'))
    expect(mutations.approveUnmappedSource).toHaveBeenCalledWith({
      pendingKey: 'unmapped-source::sf-orphan',
      sourceFieldId: 'sf-orphan',
    })
  })

  it('clicking Reject on an unmapped-source row calls mutations.rejectUnmappedRow with the source-side payload', async () => {
    const mutations = makeMutations()
    const result = makeResult([], [makeOrphanSourceField()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={mutations}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    fireEvent.click(within(row).getByTestId('flat-row-action-reject'))
    expect(mutations.rejectUnmappedRow).toHaveBeenCalledWith({
      pendingKey: 'unmapped-source::sf-orphan',
      target: { sourceFieldId: 'sf-orphan' },
    })
  })

  it('clicking Edit on an unmapped-source row opens the drawer keyed on the source-side row id', () => {
    const onOpenDrawer = vi.fn()
    const result = makeResult([], [makeOrphanSourceField()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={onOpenDrawer}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    fireEvent.click(within(row).getByTestId('flat-row-action-edit'))
    expect(onOpenDrawer).toHaveBeenCalledWith(
      'unmapped-source::sf-orphan',
      null,
    )
  })

  it('clicking the row body on an unmapped-source row also opens the drawer (same flow as Edit)', () => {
    const onOpenDrawer = vi.fn()
    const result = makeResult([], [makeOrphanSourceField()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={onOpenDrawer}
      />,
    )
    fireEvent.click(findRow('unmapped-source::sf-orphan'))
    expect(onOpenDrawer).toHaveBeenCalledWith(
      'unmapped-source::sf-orphan',
      null,
    )
  })

  it('Approve button is omitted on already-acknowledged source rows (status="approved")', () => {
    // Source-side acks render the row with status='approved' (per
    // flatten — decision='acknowledged' → 'approved'); the approve
    // affordance should drop just like on already-approved TFM rows.
    const sourceField = makeOrphanSourceField({ id: 'sf-acked' })
    const result = makeResult([], [sourceField])
    // Add an ack to set the row's status to 'approved'.
    result.sourceFieldAcknowledgments = [
      {
        id: 'ack-1',
        sourceFieldId: 'sf-acked',
        reason: 'Legacy column',
        decision: 'acknowledged',
      },
    ]
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('ack::source::ack-1')
    expect(
      within(row).queryByTestId('flat-row-action-approve'),
    ).toBeNull()
    expect(
      within(row).getByTestId('flat-row-action-reject'),
    ).toBeInTheDocument()
  })
})

// ─── feat/mapping-row-uniformity — slate dot regression guard ─────────────

describe('MappingListView — needs-review dot color uniformity (feat/mapping-row-uniformity)', () => {
  // feat/mapping-row-uniformity dropped the 'unmapped' display-status
  // bucket that previously remapped unmapped-target / unmapped-source
  // rows with status='needs_review' onto a gray-400 ring-less dot.
  // Every needs-review row — regardless of kind — should now render
  // the same slate-400 + ring-2 ring-slate-400/25 dot that the header
  // `Needs Review N` indicator uses.

  it('needs-review unmapped-target row renders the slate-400 dot with a ring', () => {
    const result = makeResult([makeUnmappedTarget()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped::tf-9')
    const dot = within(row).getByTestId('flat-status-dot')
    expect(dot.getAttribute('data-status')).toBe('needs_review')
    expect(dot.className).toContain('bg-slate-400')
    expect(dot.className).toContain('ring-2')
    // Regression guard: the retired 'unmapped' bucket used `bg-gray-400`
    // without a ring. Neither token should appear on a needs-review row.
    expect(dot.className).not.toContain('bg-gray-400')
  })

  it('needs-review unmapped-source row renders the slate-400 dot with a ring', () => {
    const sf: SourceFieldWithState = {
      id: 'sf-orphan',
      name: 'BOM_QUANTITY',
      dataType: 'NUMBER',
      ordinalPosition: 1,
      sourceTable: { id: 'st-bom', name: 'BOM_MASTERS' },
      mappingStatus: 'unmapped',
      sampleValues: [],
      isAcknowledged: false,
      isRejected: false,
      aiReasoning: null,
    }
    const result = makeResult([], [sf])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('unmapped-source::sf-orphan')
    const dot = within(row).getByTestId('flat-status-dot')
    expect(dot.getAttribute('data-status')).toBe('needs_review')
    expect(dot.className).toContain('bg-slate-400')
    expect(dot.className).toContain('ring-2')
    expect(dot.className).not.toContain('bg-gray-400')
  })
})

describe('MappingListView — responsive column priority + typography (feat/mapping-row-responsive-typography)', () => {
  // Mockup alignment: table names render AS-IS (no uppercase), one step
  // smaller and lighter than the field chip. Responsive contract: table
  // names truncate FIRST under width pressure; the field-name chip is the
  // most important data on the row and yields width LAST. Implemented
  // with asymmetric flex-shrink — table-name spans get `shrink-[9999]`,
  // field-chip wrappers keep the default `flex-shrink:1` via `min-w-0`.

  function renderSingleSourceRow() {
    const result = makeResult([makeSingleSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    return findRow('tfm-1')
  }

  it('source + target table names render as-is, not uppercased', () => {
    const row = renderSingleSourceRow()
    const sourceTable = within(row).getByTestId('flat-cell-source-table')
    const targetTable = within(row).getByTestId('flat-cell-target-table')

    // No CSS uppercase transform — names render with original casing.
    expect(sourceTable.className).not.toContain('uppercase')
    expect(targetTable.className).not.toContain('uppercase')
    expect(sourceTable.className).not.toContain('tracking-wide')
    expect(targetTable.className).not.toContain('tracking-wide')
  })

  it('table names are lighter + smaller than the field chip', () => {
    const row = renderSingleSourceRow()
    const sourceTable = within(row).getByTestId('flat-cell-source-table')
    const targetTable = within(row).getByTestId('flat-cell-target-table')

    // Lighter weight than the chip (chip is font-medium).
    expect(sourceTable.className).toContain('font-normal')
    expect(targetTable.className).toContain('font-normal')
    expect(sourceTable.className).not.toContain('font-medium')
    expect(targetTable.className).not.toContain('font-medium')

    // Sub-chip scale.
    expect(sourceTable.className).toContain('text-[11px]')
    expect(targetTable.className).toContain('text-[11px]')
  })

  it('table names yield width first — high flex-shrink + truncate', () => {
    const row = renderSingleSourceRow()
    const sourceTable = within(row).getByTestId('flat-cell-source-table')
    const targetTable = within(row).getByTestId('flat-cell-target-table')

    for (const span of [sourceTable, targetTable]) {
      // Regression guard: `shrink-0` would pin the table name full-width
      // and force the chip to collapse first — the inverted-priority bug.
      expect(span.className).not.toContain('shrink-0')
      // Collapses ahead of the chip and clips with an ellipsis.
      expect(span.className).toContain('shrink-[9999]')
      expect(span.className).toContain('min-w-0')
      expect(span.className).toContain('truncate')
    }
  })

  it('field-name chip wrapper shrinks last and keeps the monospace pill', () => {
    const row = renderSingleSourceRow()
    const sourceField = within(row).getByTestId('flat-cell-source-field')
    const targetField = within(row).getByTestId('flat-cell-target-field')

    for (const wrapper of [sourceField, targetField]) {
      // `min-w-0` keeps the default flex-shrink:1 — the chip CAN shrink,
      // but only after table names have collapsed (shrink-[9999]).
      expect(wrapper.className).toContain('min-w-0')
      // No `shrink-0` — a hard pin would force horizontal overflow
      // instead of graceful last-resort chip truncation.
      expect(wrapper.className).not.toContain('shrink-0')
    }

    // Chip itself keeps the bordered monospace pill aesthetic and is
    // allowed to truncate (no hard min-width pinning it open).
    const chip = within(row).getByText('CUST_ID')
    expect(chip.className).toContain('font-mono')
    expect(chip.className).toContain('truncate')
    expect(chip.className).toContain('max-w-full')
  })

  it('multi-source sub-row table name matches the as-is typography', () => {
    const result = makeResult([makeMultiSourceMapped()])
    render(
      <MappingListView
        filteredResult={result}
        mutations={makeMutations()}
        onOpenDrawer={vi.fn()}
      />,
    )
    const row = findRow('tfm-multi')
    fireEvent.click(within(row).getByTestId('flat-multi-source-pill'))

    const subTable = screen.getByTestId('flat-subrow-source-table')
    expect(subTable.className).not.toContain('uppercase')
    expect(subTable.className).toContain('font-normal')
    expect(subTable.className).toContain('text-[11px]')
    expect(subTable.className).toContain('shrink-[9999]')
  })
})
