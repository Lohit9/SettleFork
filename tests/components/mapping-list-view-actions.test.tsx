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

  it('unmapped-target: Approve routes through approveTfm with the unmapped::<targetFieldId> sentinel; Reject calls setUnmappedRowRejected with targetFieldId', () => {
    // feat/mapping-table-redesign refinement pass 2: approve renders on
    // unmapped-target rows so the user can one-click "acknowledge this
    // target as intentionally unmapped" without opening the drawer.
    // approveTfm dispatches `approveFieldMapping`, which branches on the
    // `unmapped::` row id prefix and writes target_field_coverage.status
    // via setCoverageStatus (per the server action contract).
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
    expect(mutations.rejectUnmappedRow).toHaveBeenCalledWith({
      pendingKey: 'unmapped::tf-9',
      target: { targetFieldId: 'tf-9' },
    })
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

  it('multi-source and single-source TFMs each render as one row, sorted by target field name', () => {
    // feat/mapping-table-redesign — multi-source TFMs are one row, so
    // the "clustering" concern from the stacked-row era is moot. Sort
    // is still target table → target field; multi-source rows take
    // their place by their target like any other row.
    const mutations = makeMutations()
    const multi = makeMultiSourceMapped() // target = 'item_number'
    const single = makeSingleSourceMapped() // target = 'customer_id'
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
    // Target field sort: 'customer_id' < 'item_number'.
    expect(rows[0].getAttribute('data-row-id')).toBe('tfm-1')
    expect(rows[1].getAttribute('data-row-id')).toBe('tfm-multi')
  })
})
