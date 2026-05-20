import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { FilterRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/FilterRow'
import type {
  SourceTableSummary,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import {
  DEFAULT_FILTER_STATE,
  type MappingFilterState,
} from '@/lib/utils/mapping-filters'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 3 — FilterRow tests (render + user interactions).
// ─────────────────────────────────────────────────────────────────────────────
//
// The filter row is controlled by its parent: events dispatch onFiltersChange
// with the next state. We verify:
//   • all three Selects + the search input render
//   • user interactions emit the correct next-state payload
//   • clear-all resets all four filter fields
//   • Escape on focused search clears the search
//
// URL-param seeding, legacy-param ignore behavior, and URL-write debouncing
// are validated at the pipeline level (tests/utils/mapping-filters.test.ts)
// and in the MappingContent wiring — FilterRow itself is stateless w.r.t.
// URL and timers, so those behaviors are tested on the utility directly.

const targetTables: TargetTableSummary[] = [
  { id: 'tt-a', name: 'accounts', datasetName: 'heritage', fieldCount: 4 },
  { id: 'tt-b', name: 'customers', datasetName: 'heritage', fieldCount: 2 },
]

const sourceTables: SourceTableSummary[] = [
  { id: 'st-x', name: 'ACCT_MASTER', datasetName: 'legacy', fieldCount: 12 },
  { id: 'st-y', name: 'CIF_MASTER', datasetName: 'legacy', fieldCount: 8 },
]

function renderFilterRow(overrides: Partial<MappingFilterState> = {}) {
  const onFiltersChange = vi.fn()
  const filters: MappingFilterState = { ...DEFAULT_FILTER_STATE, ...overrides }
  const utils = render(
    <FilterRow
      filters={filters}
      onFiltersChange={onFiltersChange}
      targetTables={targetTables}
      sourceTables={sourceTables}
    />,
  )
  return { ...utils, onFiltersChange }
}

afterEach(() => {
  vi.useRealTimers()
})

// ─── Render ──────────────────────────────────────────────────────────────────

describe('FilterRow — render', () => {
  it('renders the three selects and the search input', () => {
    renderFilterRow()
    expect(screen.getByTestId('filter-target')).toBeInTheDocument()
    expect(screen.getByTestId('filter-source')).toBeInTheDocument()
    expect(screen.getByTestId('filter-status')).toBeInTheDocument()
    expect(screen.getByTestId('filter-search-input')).toBeInTheDocument()
  })

  // Refinement 5 (Phase 4-polish-1 final-final, 2026-04-26): the
  // passive table-count gutter ("8 tables") was DROPPED entirely.
  // It was non-actionable visual chrome at the right edge. Pin its
  // absence here as a regression guard — a future revert that re-
  // introduces the count would silently fail this assertion.
  it('does NOT render the table-count gutter (Refinement 5 dropped it)', () => {
    renderFilterRow()
    expect(screen.queryByTestId('filter-row-table-count')).not.toBeInTheDocument()
  })

  it('does not render a clear-all button when all filters are default', () => {
    renderFilterRow()
    expect(screen.queryByTestId('filter-clear-all')).not.toBeInTheDocument()
  })

  it('renders the clear-all button when any filter is active', () => {
    renderFilterRow({ status: 'approved' })
    expect(screen.getByTestId('filter-clear-all')).toBeInTheDocument()
  })

  it('renders the search-clear button only when search is non-empty', () => {
    const { rerender, onFiltersChange } = renderFilterRow()
    expect(screen.queryByTestId('filter-search-clear')).not.toBeInTheDocument()

    rerender(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, search: 'hello' }}
        onFiltersChange={onFiltersChange}
        targetTables={targetTables}
        sourceTables={sourceTables}
      />,
    )
    expect(screen.getByTestId('filter-search-clear')).toBeInTheDocument()
  })
})

// ─── Interactions ────────────────────────────────────────────────────────────

describe('FilterRow — search input', () => {
  it('emits onFiltersChange on every keystroke', () => {
    const { onFiltersChange } = renderFilterRow()
    const input = screen.getByTestId('filter-search-input')
    fireEvent.change(input, { target: { value: 'loan' } })
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTER_STATE,
      search: 'loan',
    })
  })

  it('mirrors the prop value when the parent changes it externally', () => {
    const { rerender, onFiltersChange } = renderFilterRow({ search: 'abc' })
    expect(
      (screen.getByTestId('filter-search-input') as HTMLInputElement).value,
    ).toBe('abc')

    rerender(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, search: 'xyz' }}
        onFiltersChange={onFiltersChange}
        targetTables={targetTables}
        sourceTables={sourceTables}
      />,
    )
    expect(
      (screen.getByTestId('filter-search-input') as HTMLInputElement).value,
    ).toBe('xyz')
  })

  it('Escape clears the search when a value is present', () => {
    const { onFiltersChange } = renderFilterRow({ search: 'hello' })
    const input = screen.getByTestId('filter-search-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTER_STATE,
      search: '',
    })
  })

  it('search-clear button empties the search', () => {
    const { onFiltersChange } = renderFilterRow({ search: 'abc' })
    fireEvent.click(screen.getByTestId('filter-search-clear'))
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTER_STATE,
      search: '',
    })
  })
})

describe('FilterRow — clear-all', () => {
  it('resets all four filter fields', () => {
    const { onFiltersChange } = renderFilterRow({
      target: 'tt-a',
      source: 'st-x',
      status: 'approved',
      search: 'hello',
    })
    fireEvent.click(screen.getByTestId('filter-clear-all'))
    expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_FILTER_STATE)
  })
})

// ─── Radix Select interactions ───────────────────────────────────────────────
// Radix's Select portal + pointer-event mocking is awkward in jsdom. The
// Select primitives are library code and exhaustively unit-tested upstream;
// here we verify the integration surface (trigger renders, value prop is
// reflected) without exercising the portal open/close keyboard flow. Direct
// state flow through onValueChange is already covered by the pipeline tests.

describe('FilterRow — Radix Select integration', () => {
  it('reflects the current target value in the trigger', () => {
    renderFilterRow({ target: 'tt-a' })
    const trigger = screen.getByTestId('filter-target')
    // The Radix trigger renders the selected item's text via <SelectValue/>.
    // We assert the trigger's textContent includes the selected table's name.
    expect(within(trigger).getByText(/accounts/i)).toBeInTheDocument()
  })

  it('reflects the current status value in the trigger', () => {
    renderFilterRow({ status: 'needs_review' })
    const trigger = screen.getByTestId('filter-status')
    expect(within(trigger).getByText(/needs review/i)).toBeInTheDocument()
  })

  it('applies the "active" visual state class when a non-default value is selected', () => {
    renderFilterRow({ status: 'approved' })
    expect(screen.getByTestId('filter-status').className).toMatch(/bg-blue-50/)
  })

  it('does NOT apply the active class when the status is "all"', () => {
    renderFilterRow()
    expect(screen.getByTestId('filter-status').className).not.toMatch(/bg-blue-50/)
  })
})

// ─── "Rejected" status option retired ───────────────────────────────────────
//
// Reject = reset (PR #157/#158): rejecting any row returns it to
// needs_review, so the app never produces a status='rejected' row. The
// "Rejected" status-filter option (and its `rejectedCount` gating) was
// removed — the dropdown now offers exactly All status / Needs Review /
// Approved.

describe('FilterRow — status dropdown options', () => {
  it('offers exactly All status / Needs Review / Approved — no "Rejected"', () => {
    renderFilterRow()
    fireEvent.click(screen.getByTestId('filter-status'))
    expect(
      screen.getByRole('option', { name: /all status/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: /needs review/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: /^approved$/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: /rejected/i }),
    ).not.toBeInTheDocument()
  })
})

// ─── Phase 4-polish-1 final refinements — noun-carrying default labels ──────
//
// Refinement 3 dropped prefix labels and hairline dividers from the
// toolbar. Each dropdown's default "all" label is now noun-carrying
// and self-documents the filter axis (no prefix label to lean on):
//
//   • Status      → "All status"
//   • Confidence  → "All confidence"
//   • Source      → "All source tables"  (already was)
//   • Target      → "All target tables"  (already was)

describe('FilterRow — Refinement 3: noun-carrying default labels', () => {
  it('Status dropdown trigger renders "All status" at the default state', () => {
    renderFilterRow()
    const status = screen.getByTestId('filter-status')
    expect(within(status).getByText(/all status/i)).toBeInTheDocument()
  })

  it('Source dropdown trigger renders "All source tables" at the default state', () => {
    renderFilterRow()
    const source = screen.getByTestId('filter-source')
    expect(within(source).getByText(/all source tables/i)).toBeInTheDocument()
  })

  it('Target dropdown trigger renders "All target tables" at the default state', () => {
    renderFilterRow()
    const target = screen.getByTestId('filter-target')
    expect(within(target).getByText(/all target tables/i)).toBeInTheDocument()
  })

  it('Confidence dropdown trigger renders "All confidence" at the default state', () => {
    renderFilterRow()
    const conf = screen.getByTestId('filter-confidence')
    expect(within(conf).getByText(/all confidence/i)).toBeInTheDocument()
  })
})

// ─── Phase 4-polish-1 final refinements — prefix labels dropped ─────────────
//
// Refinement 3: the prefix-label aesthetic ("Target: [▾]", "Status: [▾]"
// etc.) was reverted in favor of noun-carrying default values. The
// toolbar now contains zero standalone `<label>` elements paired with
// dropdowns, and zero `[data-testid="filter-row-divider"]` hairline
// dividers between groups. Pin both as regression guards.

describe('FilterRow — Refinement 3: prefix labels and dividers dropped', () => {
  it('renders no `filter-row-divider` hairline dividers in the toolbar', () => {
    renderFilterRow()
    expect(screen.queryAllByTestId('filter-row-divider')).toHaveLength(0)
  })

  it('toolbar contains no standalone label-prefix nodes ("Target:", "Source:", "Status:", "Confidence:")', () => {
    // The prefix-label aesthetic rendered each axis name as a static
    // span beside its dropdown. Pin the absence of those text nodes
    // so a future refactor cannot silently re-add them.
    renderFilterRow()
    const toolbar = screen.getByTestId('mapping-redesign-filter-row')
    // The colon-suffixed axis names were only ever rendered as
    // standalone prefix labels (the dropdown values themselves never
    // include a trailing colon). Pin their absence.
    expect(toolbar.textContent).not.toMatch(/\bTarget:/)
    expect(toolbar.textContent).not.toMatch(/\bSource:/)
    expect(toolbar.textContent).not.toMatch(/\bStatus:/)
    expect(toolbar.textContent).not.toMatch(/\bConfidence:/)
  })
})

// ─── Phase 4-polish-1 comprehensive pass — Confidence filter dropdown ───────

describe('FilterRow — Confidence dropdown', () => {
  it('renders the Confidence dropdown', () => {
    renderFilterRow()
    expect(screen.getByTestId('filter-confidence')).toBeInTheDocument()
  })

  it('reflects the current confidence value in the trigger (high)', () => {
    renderFilterRow({ confidence: 'high' })
    const trigger = screen.getByTestId('filter-confidence')
    expect(within(trigger).getByText(/high/i)).toBeInTheDocument()
  })

  it('reflects the current confidence value in the trigger (medium)', () => {
    renderFilterRow({ confidence: 'medium' })
    const trigger = screen.getByTestId('filter-confidence')
    expect(within(trigger).getByText(/medium/i)).toBeInTheDocument()
  })

  it('reflects the current confidence value in the trigger (low)', () => {
    renderFilterRow({ confidence: 'low' })
    const trigger = screen.getByTestId('filter-confidence')
    expect(within(trigger).getByText(/low/i)).toBeInTheDocument()
  })

  it('applies the active visual state class when confidence is non-default', () => {
    renderFilterRow({ confidence: 'high' })
    expect(screen.getByTestId('filter-confidence').className).toContain(
      'bg-blue-50/60',
    )
  })

  it('does NOT apply the active class when confidence is "all"', () => {
    renderFilterRow()
    expect(screen.getByTestId('filter-confidence').className).not.toContain(
      'bg-blue-50/60',
    )
  })

  it('clear-all resets the confidence filter to "all"', () => {
    const { onFiltersChange } = renderFilterRow({ confidence: 'high' })
    fireEvent.click(screen.getByTestId('filter-clear-all'))
    expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_FILTER_STATE)
  })
})

// ─── Phase 4-polish-1 comprehensive pass — Search-to-right-edge layout ──────

describe('FilterRow — search-to-right-edge layout', () => {
  it('search wrapper is fixed w-72 and pushed to the right edge via ml-auto (Refinement C)', () => {
    // Refinement C (Phase 4-polish-1 final, 2026-04-26): the prior
    // `flex-1 min-w-[14rem] max-w-md` pattern absorbed all available
    // horizontal space up to 28rem. Canary review found the search
    // box dominated the toolbar at wide viewports. New pattern:
    // fixed `w-72` (288px) + `ml-auto` to push the search to the
    // right edge, leaving big whitespace between dropdowns and
    // search.
    renderFilterRow()
    const wrapper = screen.getByTestId('filter-row-search-wrapper')
    expect(wrapper.className).toContain('w-72')
    expect(wrapper.className).toContain('ml-auto')
    expect(wrapper.className).toContain('flex-shrink-0')
    // Pin the absence of the prior absorbing classes.
    expect(wrapper.className).not.toContain('flex-1')
    expect(wrapper.className).not.toContain('min-w-[14rem]')
    expect(wrapper.className).not.toContain('max-w-md')
  })

  it('search wrapper sits AFTER the dropdown filters in the DOM order (Refinement C)', () => {
    // The visual right-edge alignment relies on (a) the search
    // wrapper being later in the DOM than every dropdown, and
    // (b) the search wrapper carrying `ml-auto`. JSDOM doesn't
    // simulate visual layout, so we test on the structural
    // contract: every dropdown SelectTrigger appears before the
    // search wrapper in the toolbar's children order.
    renderFilterRow()
    const toolbar = screen.getByTestId('mapping-redesign-filter-row')
    const searchWrapper = screen.getByTestId('filter-row-search-wrapper')
    const targetTrigger = screen.getByTestId('filter-target')
    const sourceTrigger = screen.getByTestId('filter-source')
    const statusTrigger = screen.getByTestId('filter-status')
    const confidenceTrigger = screen.getByTestId('filter-confidence')
    const order = [targetTrigger, sourceTrigger, statusTrigger, confidenceTrigger]
    for (const trigger of order) {
      const cmp = searchWrapper.compareDocumentPosition(trigger)
      // DOCUMENT_POSITION_PRECEDING = 2; if `trigger` precedes the
      // search wrapper, the bit is set.
      expect(cmp & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    }
    // Belt and suspenders: the search wrapper IS a direct child of
    // the toolbar, so its position is well-defined within the
    // siblings.
    expect(searchWrapper.parentElement).toBe(toolbar)
  })

  it('toolbar uses bg-white + border-b border-gray-100 (legacy toolbar aesthetic)', () => {
    renderFilterRow()
    const toolbar = screen.getByTestId('mapping-redesign-filter-row')
    expect(toolbar.className).toContain('bg-white')
    expect(toolbar.className).toContain('border-b')
    expect(toolbar.className).toContain('border-gray-100')
  })

  it('toolbar is NOT sticky after the sidebar architecture refactor', () => {
    // Phase 4-polish-1 sidebar architecture refactor (2026-04-26):
    // FilterRow lifted out of the body's scroll container and lives
    // at PAGE LEVEL — direct sibling of `<PageHeader>` and
    // `<MappingSummaryStrip>`. Outside any scroll container, sticky
    // positioning is meaningless; DOM order alone keeps it visible
    // at the top of the page. The compensating `-mx-6` (which used
    // to extend the white background past the centered max-w-5xl
    // column's `px-6`) and the `mb-4` (gap to the first group card,
    // now provided by the body reading column's own `py-6`) are
    // also gone. This guard pins their absence.
    renderFilterRow()
    const toolbar = screen.getByTestId('mapping-redesign-filter-row')
    expect(toolbar.className).not.toMatch(/\bsticky\b/)
    expect(toolbar.className).not.toMatch(/\btop-0\b/)
    expect(toolbar.className).not.toMatch(/\bz-10\b/)
    expect(toolbar.className).not.toMatch(/-mx-\d/)
    expect(toolbar.className).not.toMatch(/\bmb-\d/)
  })

  it('toolbar carries flex-shrink-0 to resist vertical compression in the page flex column', () => {
    // The strip + FilterRow live as direct children of the page-level
    // flex column. Without `flex-shrink-0` the toolbar can be
    // compressed when the body's `flex-1` claims more space than the
    // viewport can afford — collapsing the dropdowns into an unusable
    // sliver. The strip carries the same flag for the same reason.
    renderFilterRow()
    const toolbar = screen.getByTestId('mapping-redesign-filter-row')
    expect(toolbar.className).toContain('flex-shrink-0')
  })

})

// ─── Phase 4-polish-1 comprehensive pass — Contextual bulk-approve link ─────
//
// The legacy "Approve high-confidence (N)" button was removed from its
// permanent right-edge position. The same trigger surfaces as a
// contextual TEXT LINK near the "N tables" gutter, visible only when
// the user has narrowed the Confidence filter to 'high' AND the count
// is positive. Outside this context the affordance reads as visual
// noise.

describe('FilterRow — contextual bulk-approve link visibility', () => {
  function renderWithBulk(opts: {
    confidence: 'all' | 'high' | 'medium' | 'low'
    highConfidenceCount: number | undefined
    onApproveHighConfidenceClick?: () => void
  }) {
    const onFiltersChange = vi.fn()
    const onApprove = opts.onApproveHighConfidenceClick ?? vi.fn()
    render(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, confidence: opts.confidence }}
        onFiltersChange={onFiltersChange}
        targetTables={targetTables}
        sourceTables={sourceTables}
        highConfidenceCount={opts.highConfidenceCount}
        onApproveHighConfidenceClick={
          opts.onApproveHighConfidenceClick === undefined &&
          opts.highConfidenceCount === undefined
            ? undefined
            : onApprove
        }
      />,
    )
    return { onApprove, onFiltersChange }
  }

  it('hides the link when confidence filter is "all" even if highConfidenceCount > 0', () => {
    renderWithBulk({
      confidence: 'all',
      highConfidenceCount: 5,
      onApproveHighConfidenceClick: vi.fn(),
    })
    expect(
      screen.queryByTestId('filter-row-approve-high-confidence'),
    ).not.toBeInTheDocument()
  })

  it('hides the link when confidence is "medium" or "low"', () => {
    for (const band of ['medium', 'low'] as const) {
      const { unmount } = render(
        <FilterRow
          filters={{ ...DEFAULT_FILTER_STATE, confidence: band }}
          onFiltersChange={vi.fn()}
          targetTables={targetTables}
          sourceTables={sourceTables}
          highConfidenceCount={5}
          onApproveHighConfidenceClick={vi.fn()}
        />,
      )
      expect(
        screen.queryByTestId('filter-row-approve-high-confidence'),
      ).not.toBeInTheDocument()
      unmount()
    }
  })

  it('hides the link when highConfidenceCount === 0 (nothing to approve)', () => {
    renderWithBulk({
      confidence: 'high',
      highConfidenceCount: 0,
      onApproveHighConfidenceClick: vi.fn(),
    })
    expect(
      screen.queryByTestId('filter-row-approve-high-confidence'),
    ).not.toBeInTheDocument()
  })

  it('hides the link when highConfidenceCount is undefined (fixtures / storybook)', () => {
    renderWithBulk({
      confidence: 'high',
      highConfidenceCount: undefined,
    })
    expect(
      screen.queryByTestId('filter-row-approve-high-confidence'),
    ).not.toBeInTheDocument()
  })

  it('SHOWS the link with the correct count when confidence=high AND count > 0', () => {
    renderWithBulk({
      confidence: 'high',
      highConfidenceCount: 7,
      onApproveHighConfidenceClick: vi.fn(),
    })
    const link = screen.getByTestId('filter-row-approve-high-confidence')
    expect(link).toBeInTheDocument()
    expect(link.textContent).toMatch(/Approve 7 high-confidence/i)
  })

  it('clicking the link fires onApproveHighConfidenceClick', () => {
    const onApprove = vi.fn()
    renderWithBulk({
      confidence: 'high',
      highConfidenceCount: 3,
      onApproveHighConfidenceClick: onApprove,
    })
    fireEvent.click(screen.getByTestId('filter-row-approve-high-confidence'))
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  // Refinement 5 (Phase 4-polish-1 final-final, 2026-04-26): the
  // table-count gutter that the contextual link previously
  // "replaced" is gone entirely. The Q2 lock is now degenerate —
  // there's nothing for the link to replace, the link just IS or
  // ISN'T at the right edge depending on filter state. Pin both
  // the link's presence (filter=high, count>0) and its absence
  // (default state) explicitly; the right-edge slot now has at
  // most one occupant.
  it('contextual approve link surfaces alone at the right edge when active (no count to replace)', () => {
    renderWithBulk({
      confidence: 'high',
      highConfidenceCount: 4,
      onApproveHighConfidenceClick: vi.fn(),
    })
    expect(
      screen.getByTestId('filter-row-approve-high-confidence'),
    ).toBeInTheDocument()
    // Regression guard: the dropped table-count must NOT come back.
    expect(screen.queryByTestId('filter-row-table-count')).not.toBeInTheDocument()
  })

  it('right-edge slot is empty (no link, no count) in the default state', () => {
    renderWithBulk({
      confidence: 'all',
      highConfidenceCount: 4,
      onApproveHighConfidenceClick: vi.fn(),
    })
    expect(
      screen.queryByTestId('filter-row-approve-high-confidence'),
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('filter-row-table-count')).not.toBeInTheDocument()
  })

  // Refinement C (Phase 4-polish-1 final, 2026-04-26): under the
  // new compact-search layout, the search wrapper itself carries
  // `ml-auto`. The contextual approve link (when present) drops
  // `ml-auto` and sits naturally to the right of the search via
  // the toolbar's `gap-3`. Two `ml-auto` items in the same flex
  // container would split free space between them — only the
  // leading element (search) needs `ml-auto` to push the boundary.
  //
  // Refinement 5 (final-final): the count variant of this test is
  // gone — the table-count gutter no longer renders. The link
  // variant remains; the default state is verified via the
  // search-wrapper-only `ml-auto` assertion.
  it('Refinement C — approve link does NOT carry `ml-auto` (search owns the push)', () => {
    render(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, confidence: 'high' }}
        onFiltersChange={vi.fn()}
        targetTables={targetTables}
        sourceTables={sourceTables}
        highConfidenceCount={2}
        onApproveHighConfidenceClick={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('filter-row-approve-high-confidence').className,
    ).not.toContain('ml-auto')
    expect(
      screen.getByTestId('filter-row-search-wrapper').className,
    ).toContain('ml-auto')
  })

  it('Refinement C — search wrapper carries `ml-auto` even with no right-edge slot (Refinement 5 default)', () => {
    render(
      <FilterRow
        filters={DEFAULT_FILTER_STATE}
        onFiltersChange={vi.fn()}
        targetTables={targetTables}
        sourceTables={sourceTables}
      />,
    )
    expect(
      screen.getByTestId('filter-row-search-wrapper').className,
    ).toContain('ml-auto')
  })
})

// ─── Phase 4-polish-1 comprehensive pass — Q8 lock: threshold-derived labels ─

describe('FilterRow — Confidence dropdown threshold-derived labels (Q8)', () => {
  it('opens the Confidence dropdown and renders High/Medium/Low band labels using the threshold constants', async () => {
    const { CONFIDENCE_THRESHOLD_ROW_HIGH, CONFIDENCE_THRESHOLD_ROW_AMBER } =
      await import('@/lib/utils/confidence-format')
    // Construct expected labels at test-time from the same constants
    // the source uses — if a future PR shifts a threshold, the
    // dropdown labels and this test self-update in lock-step.
    const expectedHigh = `High (≥${CONFIDENCE_THRESHOLD_ROW_HIGH})`
    const expectedMedium = `Medium (${CONFIDENCE_THRESHOLD_ROW_AMBER}\u2013${
      CONFIDENCE_THRESHOLD_ROW_HIGH - 1
    })`
    const expectedLow = `Low (<${CONFIDENCE_THRESHOLD_ROW_AMBER})`

    // Render with each band selected so the trigger surfaces the
    // label without requiring us to open the radix popover. Trigger
    // text is the same string the dropdown options use.
    const high = render(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, confidence: 'high' }}
        onFiltersChange={vi.fn()}
        targetTables={targetTables}
        sourceTables={sourceTables}
      />,
    )
    expect(
      within(high.getByTestId('filter-confidence')).getByText(expectedHigh),
    ).toBeInTheDocument()
    high.unmount()

    const medium = render(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, confidence: 'medium' }}
        onFiltersChange={vi.fn()}
        targetTables={targetTables}
        sourceTables={sourceTables}
      />,
    )
    expect(
      within(medium.getByTestId('filter-confidence')).getByText(expectedMedium),
    ).toBeInTheDocument()
    medium.unmount()

    const low = render(
      <FilterRow
        filters={{ ...DEFAULT_FILTER_STATE, confidence: 'low' }}
        onFiltersChange={vi.fn()}
        targetTables={targetTables}
        sourceTables={sourceTables}
      />,
    )
    expect(
      within(low.getByTestId('filter-confidence')).getByText(expectedLow),
    ).toBeInTheDocument()
    low.unmount()
  })

  it('Q8 source-level invariant — FilterRow.tsx contains no literal threshold numbers in the Confidence label list', () => {
    // Pin: the CONFIDENCE_OPTIONS list must derive labels from the
    // imported constants, not hardcoded numbers. Catches a future
    // refactor that re-introduces literals.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../app/app/projects/[projectId]/mapping/redesign/components/FilterRow.tsx',
      ),
      'utf-8',
    )
    // Locate the CONFIDENCE_OPTIONS block and inspect its content.
    const match = file.match(
      /const CONFIDENCE_OPTIONS[\s\S]*?\]\s*$/m,
    )
    expect(match, 'CONFIDENCE_OPTIONS block must exist').not.toBeNull()
    const block = match![0]
    // No 2-or-3-digit literal between parentheses (e.g., `≥85`,
    // `(40\u201384)`). Allowed: the imported identifiers and the
    // `- 1` arithmetic on the high boundary.
    expect(block).not.toMatch(/\(\u2265\d/) // ≥<digit>
    expect(block).not.toMatch(/\(<\d/) // <<digit>
    expect(block).not.toMatch(/\(\d{2}\u2013\d{2}\)/) // (NN–NN)
    // And it must reference the canonical constants.
    expect(block).toContain('CONFIDENCE_THRESHOLD_ROW_HIGH')
    expect(block).toContain('CONFIDENCE_THRESHOLD_ROW_AMBER')
  })
})

describe('FilterRow — source-before-target ordering (feat/mapping-filter-bugs-ordering)', () => {
  it('renders the source filter to the LEFT of the target filter', () => {
    renderFilterRow()
    const source = screen.getByTestId('filter-source')
    const target = screen.getByTestId('filter-target')
    // DOCUMENT_POSITION_FOLLOWING set on target ⇒ target comes after
    // source in document order — i.e. source is left of target.
    expect(
      source.compareDocumentPosition(target) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps source + target ahead of status / confidence', () => {
    renderFilterRow()
    const source = screen.getByTestId('filter-source')
    const target = screen.getByTestId('filter-target')
    const status = screen.getByTestId('filter-status')
    const confidence = screen.getByTestId('filter-confidence')
    // Full left-to-right order: source → target → status → confidence.
    for (const [earlier, later] of [
      [source, target],
      [target, status],
      [status, confidence],
    ] as const) {
      expect(
        earlier.compareDocumentPosition(later) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })
})
