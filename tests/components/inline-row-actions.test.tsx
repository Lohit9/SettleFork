import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldMappingRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow'
import type {
  MappedRow,
  MappingSourceRef,
  SourceFieldWithState,
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
//   needs_review (mapped/VA/unmapped) → ✓ approve  + ✗ reject
//   approved (mapped/VA/unmapped)     →             ✗ reject
//   rejected (mapped/VA/unmapped)     → ✓ approve  (un-reject)
//
// INF-57 cleanup (2026-05-10): the prior `target_acknowledged → ✗ un-
// acknowledge (opens drawer)` row was dropped — coverage-approved
// no-source rows now surface as kind='unmapped' + status='approved' and
// participate in the symmetric status-driven dispatch above. To
// un-approve back to needs_review, the user opens the drawer (footer
// Un-approve button calls resetMappingStatus).
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

// INF-57 cleanup — coverage-approved no-source row (formerly target_acknowledged).
// Surfaces as kind='unmapped' with status='approved'.
function targetAck(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-3',
    targetField: targetField({ id: 'tf-3', name: 'internal_id' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    mapping_content: 'no-source',
    coverageStatus: 'gap',
    statusSetBy: 'user',
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

  it('coverage-approved no-source row renders ✗ reject ONLY (INF-57 cleanup — symmetric with mapped/VA approved)', () => {
    // INF-57 cleanup design lock 1: coverage-approved no-source rows fall
    // through to α₀'s standard status-driven dispatch (no suppression
    // guard). With status='approved' the cell renders × reject only —
    // identical to mapped/VA approved rows. To un-approve, the user
    // opens the drawer (footer Un-approve button → resetMappingStatus).
    render(
      <FieldMappingRow
        row={targetAck()}
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
    // The legacy unacknowledge button no longer exists at this surface.
    expect(
      screen.queryByTestId('field-mapping-row-unacknowledge-button'),
    ).toBeNull()
  })

  it('unmapped + needs_review renders ✓ approve AND ✗ reject ONLY (PR α₀ Path A — no + or ⊘)', () => {
    // PR α₀ Path A (2026-05-09): the kind='unmapped' overlay was
    // dropped from the action cell. unmapped rows now show only the
    // status-driven approve/reject pair, identical to mapped/VA.
    // Re-mapping moves to the source-field cell's hover pencil
    // affordance (covered by the "Inline source-edit hint" describe
    // block).
    render(
      <FieldMappingRow
        row={unmapped({ status: 'needs_review' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
        availableSourceFields={[]}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-approve-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('field-mapping-row-reject-button'),
    ).toBeInTheDocument()
    // The dropped kind='unmapped' overlay buttons MUST NOT render —
    // re-map is now exclusively reachable via the source-field pencil.
    expect(screen.queryByTestId('field-mapping-row-map-button')).toBeNull()
    expect(
      screen.queryByTestId('field-mapping-row-acknowledge-button'),
    ).toBeNull()
  })

  it('value_assignment + needs_review renders BOTH ✓ approve AND ✗ reject (PR α₀ — VA joined the lifecycle)', () => {
    // Pre-α₀ VA rows fell through with no inline buttons (drawer-only).
    // PR α₀ extended the inline approve/reject affordances to every
    // row kind that participates in the status lifecycle — VA now
    // shows the same approve/reject pair as a mapped row.
    render(
      <FieldMappingRow
        row={valueAssignment({ status: 'needs_review' })}
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
    // VA does NOT get the kind='unmapped'-only affordances.
    expect(screen.queryByTestId('field-mapping-row-map-button')).toBeNull()
    expect(
      screen.queryByTestId('field-mapping-row-acknowledge-button'),
    ).toBeNull()
    // The legacy unacknowledge button (dropped in INF-57 cleanup) is
    // also absent.
    expect(
      screen.queryByTestId('field-mapping-row-unacknowledge-button'),
    ).toBeNull()
  })

  it('mapped + rejected renders ✓ approve ONLY (PR α₀ — re-approve is the un-reject affordance)', () => {
    // Pre-α₀: rejected rows fell through with no inline buttons. The
    // legacy assumption was that reject DELETEs the TFM, so the row
    // would soon refresh into kind='unmapped' anyway. PR α₀ replaces
    // that fall-through with an approve-only button so a freshly-
    // rejected row (still mounted via the optimistic override or a
    // stale fetch) can be un-rejected without a round-trip through
    // the drawer. On live data, mapped+rejected is unreachable
    // post-PR-γ — reject still deletes — but the optimistic override
    // produces kind='unmapped' + status='rejected' which falls under
    // the same approve-only rule.
    render(
      <FieldMappingRow
        row={mapped({ status: 'rejected' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-approve-button'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('field-mapping-row-reject-button')).toBeNull()
  })

  it('unmapped + rejected renders ✓ approve ONLY (status-driven) — no + overlay (PR α₀ Path A)', () => {
    // The optimistic-override case: rejecting a mapped/VA row produces
    // kind='unmapped' + status='rejected'. The user un-rejects via the
    // inline approve. With Path A's overlay removal, + map no longer
    // renders here either — re-mapping goes through the source-field
    // pencil.
    render(
      <FieldMappingRow
        row={unmapped({ status: 'rejected' })}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
        availableSourceFields={[]}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-approve-button'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('field-mapping-row-reject-button')).toBeNull()
    expect(screen.queryByTestId('field-mapping-row-map-button')).toBeNull()
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

// ── INF-57 cleanup — symmetric inline dispatch on coverage-approved no-source ─

describe('Inline action buttons — INF-57 symmetric dispatch (unmapped + approved)', () => {
  // Locked design decision 1: coverage-approved no-source rows fall through
  // to α₀'s standard status-driven dispatch — × reject IS rendered and
  // direct-writes to rejected, identical to mapped/VA approved rows. No
  // suppression guard. To un-approve back to needs_review, the user opens
  // the drawer (footer Un-approve button calls resetMappingStatus).

  it('renders × reject only on a coverage-approved no-source row (mirrors mapped/VA approved)', () => {
    render(
      <FieldMappingRow
        row={targetAck()}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-reject-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('field-mapping-row-approve-button'),
    ).toBeNull()
  })

  it('clicking × on a coverage-approved no-source row fires onInlineReject(row.id, anchorEl) — direct-writes to rejected via the standard path', async () => {
    const onInlineReject = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={targetAck({ id: 'unmapped::tf-cov-X' })}
        onInlineApprove={vi.fn()}
        onInlineReject={onInlineReject}
      />,
    )
    const rejectBtn = screen.getByTestId('field-mapping-row-reject-button')
    await user.click(rejectBtn)
    expect(onInlineReject).toHaveBeenCalledTimes(1)
    expect(onInlineReject).toHaveBeenCalledWith(
      'unmapped::tf-cov-X',
      expect.any(HTMLElement),
    )
  })

  it('does NOT render the legacy un-acknowledge button (dropped in INF-57 cleanup)', () => {
    render(
      <FieldMappingRow
        row={targetAck()}
        onInlineApprove={vi.fn()}
        onInlineReject={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-unacknowledge-button'),
    ).toBeNull()
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

  it('PR α₀ Path A — the + (re-map) button is no longer rendered on unmapped rows', () => {
    // Pre-α₀: clicking the + button opened the inline source picker.
    // PR α₀ Path A removed the button from the action cell — re-mapping
    // is now exclusively reachable via the source-field cell's hover
    // pencil affordance (which routes through the same picker portal).
    // Pin the absence of the test-id so a regression that re-introduces
    // the button is caught immediately.
    render(
      <FieldMappingRow
        row={unmapped({ id: 'unmapped::tf-Z' })}
        availableSourceFields={[]}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('field-mapping-row-map-button')).toBeNull()
  })

  it('PR α₀ Path A + INF-57 — the ⊘ (acknowledge) button is no longer rendered on unmapped rows', () => {
    // Pre-α₀: clicking ⊘ fired onInlineAcknowledge(row.id) which wrote
    // is_acknowledged=true on the TFM. PR α₀ Path A relocated acknowledge
    // entirely to the drawer. INF-57 cleanup (2026-05-10) further dropped
    // the onInlineAcknowledge prop from FieldMappingRow's surface — the
    // inline acknowledge surface is fully gone.
    render(
      <FieldMappingRow
        row={unmapped({ id: 'unmapped::tf-W' })}
        availableSourceFields={[]}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-acknowledge-button'),
    ).toBeNull()
  })

  // The legacy test "clicking ✗ on a target_acknowledged row fires
  // onInlineUnacknowledge (drawer entry path)" was dropped by INF-57
  // cleanup. Coverage-approved no-source rows now participate in the
  // standard status-driven dispatch — clicking ✗ direct-writes to
  // rejected via onInlineReject, identical to mapped/VA approved rows.
  // To un-approve back to needs_review the user opens the drawer (footer
  // Un-approve button calls resetMappingStatus). The ✗ → reject payload
  // contract for unmapped+approved is exercised by the new test in the
  // describe block below.

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
    // The pencil hides at rest (opacity-0) and reveals on hover of the
    // unified source-trigger wrapper (cols 2-3). Source-cell unification
    // (2026-04-28) narrowed the hover scope from the row body to the
    // wrapper via Tailwind's named-group syntax: the wrapper carries
    // `group/source`, the pencil reveals on `group-hover/source:`. Pre-
    // unification this asserted the unscoped `group-hover:opacity-100`
    // (the row body owned the `group` class), which fired on hover
    // ANYWHERE in the row including Target / Confidence / Actions cells.
    expect(pencilClass).toContain('opacity-0')
    expect(pencilClass).toContain('group-hover/source:opacity-100')
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

  it('renders the Pencil hint on coverage-approved no-source rows (INF-57: kind="unmapped" is source-editable)', () => {
    // INF-57 cleanup folded target_acknowledged into kind='unmapped' with
    // status='approved'. The `isInlineSourceEditable` predicate accepts
    // `kind === 'unmapped'`, so the pencil affordance renders here as
    // collateral effect of the body unification (locked design decision 3).
    // Pre-cleanup, target_acknowledged was excluded.
    render(
      <FieldMappingRow
        row={targetAck()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-source-edit-hint'),
    ).toBeInTheDocument()
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

  it('PR α₀ Path A — clicking the source-field trigger on an unmapped row opens the picker (replaces the dropped + button)', async () => {
    // Pre-α₀ the + (re-map) action button on the right was the
    // primary entry to the inline picker for unmapped rows. PR α₀
    // Path A removed that button; the pencil/source-cell click on
    // the LEFT side is the sole inline entry now. Pin that the
    // cell-click → picker contract still holds for unmapped rows
    // (was previously tested only on mapped rows).
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={unmapped({ id: 'unmapped::tf-pencil' })}
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

  it('PR α₀ Path A — the hover pencil hint renders on unmapped rows (re-map affordance moved here from the action cell)', () => {
    // Companion test to "renders a hover-revealed Pencil hint on
    // inline-eligible rows" (mapped-row variant). Unmapped rows
    // satisfy the eligibility predicate (kind === 'unmapped') and
    // therefore must surface the pencil — without it, no-source rows
    // would lose the inline re-map entry point post-α₀.
    render(
      <FieldMappingRow
        row={unmapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const pencil = screen.getByTestId('field-mapping-row-source-edit-hint')
    const pencilClass = pencil.getAttribute('class') ?? ''
    expect(pencilClass).toContain('opacity-0')
    expect(pencilClass).toContain('group-hover/source:opacity-100')
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
