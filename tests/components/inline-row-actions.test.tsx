import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldMappingRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow'
import type {
  MappedRow,
  MappingSourceRef,
  SourceFieldWithState,
  TargetAcknowledgedRow,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Inline row actions — Phase 4-polish-3 Block D unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked per-row-state button matrix:
//
//   Mapped + needs_review   → ✓ approve  + ✗ reject
//   Mapped + approved       →             ✗ reject
//   Mapped + rejected       → (filtered out — no buttons)
//   Target acknowledged     → ✗ un-acknowledge (opens drawer)
//   Unmapped                → + map         + ⊘ acknowledge
//   Value assignment        → (no inline buttons; drawer-only)
//
// Plus the visibility / optimistic-state / event-payload contracts.
// The picker integration (clicking the source cell to open the
// `InlineSourcePicker`) is exercised separately at the picker test
// layer; these tests focus on the actions cell + the click event
// payloads passed back up to `MappingContent`.

// ── Fixtures ────────────────────────────────────────────────────────────────

function targetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR(200)',
    isNullable: true,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'accounts' },
    ordinalPosition: 1,
    ...overrides,
  }
}

function source(overrides: Partial<MappingSourceRef> = {}): MappingSourceRef {
  return {
    id: 'ms-1',
    ordinal: 0,
    confidence: 98,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: {
      id: 'sf-1',
      name: 'ACCT_NO',
      dataType: 'NUMBER',
      isNullable: false,
    },
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
    ...overrides,
  }
}

function mapped(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    kind: 'mapped',
    id: 'tfm-1',
    targetField: targetField(),
    confidence: 98,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    sources: [source()],
    combinationType: 'single',
    combinationSql: null,
    aiReasoning: null,
    ...overrides,
  }
}

function unmapped(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-2',
    targetField: targetField({ id: 'tf-2', name: 'opened_at' }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    ...overrides,
  }
}

function targetAck(
  overrides: Partial<TargetAcknowledgedRow> = {},
): TargetAcknowledgedRow {
  return {
    kind: 'target_acknowledged',
    id: 'tfm-ack-1',
    targetField: targetField({ id: 'tf-3', name: 'internal_id' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    acknowledgmentReason: 'system default',
    ...overrides,
  }
}

function valueAssignment(
  overrides: Partial<ValueAssignmentRow> = {},
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: 'tfm-va-1',
    targetField: targetField({ id: 'tf-4', name: 'created_at' }),
    confidence: 92,
    status: 'approved',
    hasTransformation: true,
    transformationStatus: 'applied',
    transformationDescription: null,
    transformationSqlPreview: null,
    combinationType: 'custom_sql',
    combinationSql: 'NOW()',
    aiReasoning: null,
    ...overrides,
  }
}

// ── Per-row-state button rendering ──────────────────────────────────────────

describe('Inline action buttons — render matrix', () => {
  it('mapped + needs_review renders BOTH ✓ approve AND ✗ reject', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'needs_review' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-approve-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('field-mapping-row-reject-button'),
    ).toBeInTheDocument()
  })

  it('mapped + approved renders ✗ reject ONLY (no ✓ approve)', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'approved' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-approve-button'),
    ).toBeNull()
    expect(
      screen.getByTestId('field-mapping-row-reject-button'),
    ).toBeInTheDocument()
  })

  it('target_acknowledged renders ✗ un-acknowledge ONLY', () => {
    render(
      <FieldMappingRow
        row={targetAck()}
        onInlineUnacknowledge={vi.fn()}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-unacknowledge-button'),
    ).toBeInTheDocument()
    // Approve / reject must NOT render on an acknowledged row even if
    // their handlers are wired (defense-in-depth — the kind dispatch
    // hides them).
    expect(
      screen.queryByTestId('field-mapping-row-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('field-mapping-row-reject-button')).toBeNull()
  })

  it('unmapped renders BOTH + map AND ⊘ acknowledge', () => {
    render(
      <FieldMappingRow
        row={unmapped()}
        onInlineAcknowledge={vi.fn()}
        availableSourceFields={[]}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-map-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('field-mapping-row-acknowledge-button'),
    ).toBeInTheDocument()
  })

  it('value_assignment renders NO inline action buttons', () => {
    render(
      <FieldMappingRow
        row={valueAssignment()}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
        onInlineAcknowledge={vi.fn()}
        onInlineUnacknowledge={vi.fn()}
      />,
    )
    // The actions cell still renders structurally (col 6 of the
    // grid), but it carries zero buttons.
    expect(
      screen.queryByTestId('field-mapping-row-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('field-mapping-row-reject-button')).toBeNull()
    expect(screen.queryByTestId('field-mapping-row-map-button')).toBeNull()
    expect(
      screen.queryByTestId('field-mapping-row-acknowledge-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('field-mapping-row-unacknowledge-button'),
    ).toBeNull()
  })

  it('mapped + rejected renders NO inline action buttons (filtered upstream; defense-in-depth)', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'rejected' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('field-mapping-row-reject-button')).toBeNull()
  })

  it('omitting handlers omits the corresponding buttons (legacy fixture path)', () => {
    // Storybook / fixture callers that don't wire the inline action
    // props keep the prior actions-cell-empty behavior. Pin so a
    // future refactor can't accidentally make a button render
    // unconditionally.
    render(<FieldMappingRow row={mapped({ status: 'needs_review' })} />)
    expect(
      screen.queryByTestId('field-mapping-row-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('field-mapping-row-reject-button')).toBeNull()
  })
})

// ── Visibility (hover / focus reveal) ───────────────────────────────────────

describe('Inline action buttons — visibility', () => {
  it('the actions cell starts opacity-0 and reveals on group-hover / focus-within', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'needs_review' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    const actions = screen.getByTestId('field-mapping-row-actions')
    // The cell stays in the DOM at all times so its width reservation
    // never causes layout shift on hover. The tailwind class signature
    // is the contract.
    expect(actions.className).toContain('opacity-0')
    expect(actions.className).toContain('group-hover:opacity-100')
    expect(actions.className).toContain('focus-within:opacity-100')
    // motion-reduce honor: the opacity transition is gated behind a
    // motion-reduce skip so users with reduced-motion preferences
    // don't see a fade.
    expect(actions.className).toContain('motion-reduce:transition-none')
  })
})

// ── Click handlers (event payload contract) ─────────────────────────────────

describe('Inline action buttons — click payloads', () => {
  it('clicking ✓ on a needs_review mapped row fires onInlineApprove(row.id)', async () => {
    const onInlineApprove = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped({ id: 'tfm-X', status: 'needs_review' })}
        onInlineApprove={onInlineApprove}
        onInlineReject={vi.fn()}
      />,
    )
    await user.click(screen.getByTestId('field-mapping-row-approve-button'))
    expect(onInlineApprove).toHaveBeenCalledTimes(1)
    expect(onInlineApprove).toHaveBeenCalledWith('tfm-X')
  })

  it('clicking ✗ fires onInlineReject(row.id, anchorEl) — anchorEl is the button itself', async () => {
    const onInlineReject = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped({ id: 'tfm-Y', status: 'approved' })}
        onInlineReject={onInlineReject}
      />,
    )
    const rejectBtn = screen.getByTestId('field-mapping-row-reject-button')
    await user.click(rejectBtn)
    expect(onInlineReject).toHaveBeenCalledTimes(1)
    const [rowId, anchor] = onInlineReject.mock.calls[0]!
    expect(rowId).toBe('tfm-Y')
    // The handler receives the ✗ button as the popover anchor so the
    // parent can compute the popover position via
    // `getBoundingClientRect`. Defense-in-depth — pin that the anchor
    // is an HTMLElement (as required by `RejectConfirmPopover`'s
    // `anchorRef` prop).
    expect(anchor).toBeInstanceOf(HTMLElement)
    expect((anchor as HTMLElement).getAttribute('data-testid')).toBe(
      'field-mapping-row-reject-button',
    )
  })

  it('clicking + on an unmapped row fires the inline-map handler (opens picker via parent)', async () => {
    // The + button shares the same handler the source cell click uses
    // — both routes open the inline picker. Pin so the parent only
    // needs to wire one entry point.
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={unmapped({ id: 'unmapped::tf-Z' })}
        availableSourceFields={[]}
        onInlineAcknowledge={vi.fn()}
        onSourceCommit={vi.fn()}
      />,
    )
    const mapBtn = screen.getByTestId('field-mapping-row-map-button')
    await user.click(mapBtn)
    // After clicking +, the inline picker portal appears.
    expect(
      await screen.findByTestId('inline-source-picker'),
    ).toBeInTheDocument()
  })

  it('clicking ⊘ on an unmapped row fires onInlineAcknowledge(row.id)', async () => {
    const onInlineAcknowledge = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={unmapped({ id: 'unmapped::tf-W' })}
        onInlineAcknowledge={onInlineAcknowledge}
        availableSourceFields={[]}
        onSourceCommit={vi.fn()}
      />,
    )
    await user.click(
      screen.getByTestId('field-mapping-row-acknowledge-button'),
    )
    expect(onInlineAcknowledge).toHaveBeenCalledTimes(1)
    expect(onInlineAcknowledge).toHaveBeenCalledWith('unmapped::tf-W')
  })

  it('clicking ✗ on a target_acknowledged row fires onInlineUnacknowledge (drawer entry path)', async () => {
    const onInlineUnacknowledge = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={targetAck({ id: 'tfm-ack-Q' })}
        onInlineUnacknowledge={onInlineUnacknowledge}
      />,
    )
    await user.click(
      screen.getByTestId('field-mapping-row-unacknowledge-button'),
    )
    expect(onInlineUnacknowledge).toHaveBeenCalledTimes(1)
    expect(onInlineUnacknowledge).toHaveBeenCalledWith('tfm-ack-Q')
  })

  it('action button clicks do NOT bubble to the row-body drawer-open handler', async () => {
    // The row body itself becomes a `role="button"` drawer trigger
    // when `onRowClick` is wired. Action buttons in col 6 must
    // `stopPropagation` so a click on ✓ / ✗ / + / ⊘ does not also
    // open the drawer. Pin this contract — a regression here would
    // make every inline action also pop the drawer.
    const onRowClick = vi.fn()
    const onInlineApprove = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped({ status: 'needs_review' })}
        onRowClick={onRowClick}
        onInlineApprove={onInlineApprove}
        onInlineReject={vi.fn()}
      />,
    )
    await user.click(screen.getByTestId('field-mapping-row-approve-button'))
    expect(onInlineApprove).toHaveBeenCalled()
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

// ── Optimistic state — disabled buttons ────────────────────────────────────

describe('Inline action buttons — optimistic-state disable', () => {
  it('optimisticState="approving" disables the buttons (defense vs. double-fire)', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'needs_review' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
        optimisticState="approving"
      />,
    )
    const approveBtn = screen.getByTestId('field-mapping-row-approve-button')
    const rejectBtn = screen.getByTestId('field-mapping-row-reject-button')
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true)
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('optimisticState=undefined leaves buttons enabled (resting state)', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'needs_review' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    const approveBtn = screen.getByTestId('field-mapping-row-approve-button')
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false)
  })

  it('optimisticState="rejecting" disables the buttons even on an approved row', () => {
    render(
      <FieldMappingRow
        row={mapped({ status: 'approved' })}
        onInlineReject={vi.fn()}
        optimisticState="rejecting"
      />,
    )
    const rejectBtn = screen.getByTestId('field-mapping-row-reject-button')
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(true)
  })
})

// ── Source-edit affordance hint (Pencil icon on hover) ──────────────────────

describe('Inline source-edit hint', () => {
  function makeAvailableSourceFields(): SourceFieldWithState[] {
    return [
      {
        id: 'sf-1',
        name: 'ACCT_NO',
        dataType: 'NUMBER',
        ordinalPosition: 1,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'mapped',
        sampleValues: [],
        isAcknowledged: false,
      },
    ]
  }

  it('renders a hover-revealed Pencil hint on inline-eligible rows', () => {
    // Eligible: mapped Rule 1 with `availableSourceFields` +
    // `onSourceCommit` wired.
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const pencil = screen.getByTestId('field-mapping-row-source-edit-hint')
    // The pencil renders as an SVG (lucide-react), so its `className`
    // is an SVGAnimatedString. Read the raw attribute instead.
    const pencilClass = pencil.getAttribute('class') ?? ''
    // The pencil hides at rest (opacity-0) and reveals on group-hover.
    expect(pencilClass).toContain('opacity-0')
    expect(pencilClass).toContain('group-hover:opacity-100')
  })

  it('does NOT render the Pencil hint on ineligible rows (custom_sql)', () => {
    // Custom SQL rows are intentionally NOT inline-editable — the
    // drawer's edit mode handles them with a confirmation flow.
    render(
      <FieldMappingRow
        row={mapped({ combinationType: 'custom_sql', combinationSql: 'NOW()' })}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-source-edit-hint'),
    ).toBeNull()
  })

  it('does NOT render the Pencil hint on target_acknowledged rows', () => {
    render(
      <FieldMappingRow
        row={targetAck()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-source-edit-hint'),
    ).toBeNull()
  })

  it('does NOT render the Pencil hint when onSourceCommit is omitted (legacy fixture path)', () => {
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-source-edit-hint'),
    ).toBeNull()
  })
})

// ── Source cell click → opens picker on eligible rows ──────────────────────

describe('Inline source-edit click', () => {
  function makeAvailableSourceFields(): SourceFieldWithState[] {
    return [
      {
        id: 'sf-1',
        name: 'ACCT_NO',
        dataType: 'NUMBER',
        ordinalPosition: 1,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'mapped',
        sampleValues: [],
        isAcknowledged: false,
      },
      {
        id: 'sf-2',
        name: 'CUSTOMER_REF',
        dataType: 'VARCHAR(50)',
        ordinalPosition: 2,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'unmapped',
        sampleValues: [],
        isAcknowledged: false,
      },
    ]
  }

  it('clicking the source-field trigger surface opens the InlineSourcePicker', async () => {
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('field-mapping-row-source-field-trigger')
    await user.click(trigger)
    expect(
      await screen.findByTestId('inline-source-picker'),
    ).toBeInTheDocument()
  })

  it('clicking the source trigger does NOT bubble to the row drawer-open handler', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped()}
        onRowClick={onRowClick}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('field-mapping-row-source-field-trigger')
    await user.click(trigger)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
