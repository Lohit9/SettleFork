/**
 * @file Phase 3 Gap 11a (shell) + 11b (content + interactions) —
 * `SourceSchemaSidebar` tests.
 *
 * Covers:
 *   - Collapsed-state rendering (vertical rail, label, count badge)
 *   - Expanded-state rendering (header, search, filter pills, list)
 *   - State-toggle interaction (rail click expands; chevron click collapses)
 *   - Width values match the exported constants (28 / 200)
 *   - Aria labels and roles correct in both states
 *   - Focus management on user-initiated toggle (rail → chevron, chevron → rail)
 *
 * Gap 11b additions:
 *   - Field rendering grouped by source table, in server order
 *   - Status dot per field reflects mappingStatus
 *   - Filter pill counts derived client-side from sourceFields
 *   - Filter pill predicates narrow the visible list
 *   - Debounced search filters by name + sourceTable.name (case-insensitive)
 *   - Empty states for "no schema" vs "no match"
 *   - Click on a field row invokes onFieldClick
 *   - Hover tooltip surfaces dataType + formatted sample values
 *   - aria-pressed reflects highlightedSourceFieldId
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  SIDEBAR_COLLAPSED_WIDTH_PX,
  SIDEBAR_EXPANDED_WIDTH_PX,
  SIDEBAR_SEARCH_DEBOUNCE_MS,
  SourceSchemaSidebar,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/SourceSchemaSidebar'
import type {
  SidebarFilter,
  SidebarState,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/useSidebarState'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

interface RenderOptions {
  state?: SidebarState
  filter?: SidebarFilter
  sourceFields?: SourceFieldWithState[]
  highlightedSourceFieldId?: string | null
  onFieldClick?: (id: string) => void
}

function renderSidebar(opts: RenderOptions = {}) {
  const onStateChange = vi.fn()
  const onFilterChange = vi.fn()
  const onFieldClick = opts.onFieldClick ?? vi.fn()
  const utils = render(
    <SourceSchemaSidebar
      state={opts.state ?? 'collapsed'}
      filter={opts.filter ?? 'unmapped'}
      onStateChange={onStateChange}
      onFilterChange={onFilterChange}
      sourceFields={opts.sourceFields ?? []}
      highlightedSourceFieldId={opts.highlightedSourceFieldId ?? null}
      onFieldClick={onFieldClick}
    />,
  )
  return { ...utils, onStateChange, onFilterChange, onFieldClick }
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeField(
  overrides: Partial<SourceFieldWithState> & { id: string; name: string },
): SourceFieldWithState {
  return {
    id: overrides.id,
    name: overrides.name,
    dataType: overrides.dataType ?? 'VARCHAR(50)',
    ordinalPosition: overrides.ordinalPosition ?? 0,
    sourceTable: overrides.sourceTable ?? { id: 'tbl-cif', name: 'CIF_MASTER' },
    mappingStatus: overrides.mappingStatus ?? 'unmapped',
    sampleValues: overrides.sampleValues ?? [],
    isAcknowledged: overrides.isAcknowledged ?? false,
    isRejected: overrides.isRejected ?? false,
  }
}

// FIXTURE_FIELDS reflects the server-guaranteed canonical order:
// `sourceTable.name ASC, ordinalPosition ASC, name ASC`.
// ACCT_HIST < CIF_MASTER alphabetically, so ACCT_HIST fields come first.
// The component preserves this order via Map insertion order — the
// "no client-side sort" invariant means the fixture order IS the
// rendered order.
const FIXTURE_FIELDS: SourceFieldWithState[] = [
  makeField({
    id: 'sf-acct-num',
    name: 'ACCOUNT_NUM',
    sourceTable: { id: 'tbl-acct', name: 'ACCT_HIST' },
    mappingStatus: 'mapped',
    ordinalPosition: 0,
  }),
  makeField({
    id: 'sf-acct-bal',
    name: 'BALANCE',
    sourceTable: { id: 'tbl-acct', name: 'ACCT_HIST' },
    mappingStatus: 'unmapped',
    ordinalPosition: 1,
    isAcknowledged: true,
  }),
  makeField({
    id: 'sf-cust-id',
    name: 'CUSTOMER_ID',
    sourceTable: { id: 'tbl-cif', name: 'CIF_MASTER' },
    mappingStatus: 'mapped',
    ordinalPosition: 0,
    dataType: 'INT',
    sampleValues: ['1001', '1002', '1003'],
  }),
  makeField({
    id: 'sf-cust-name',
    name: 'CUSTOMER_NAME',
    sourceTable: { id: 'tbl-cif', name: 'CIF_MASTER' },
    mappingStatus: 'unmapped',
    ordinalPosition: 1,
  }),
]

describe('SourceSchemaSidebar — width invariant', () => {
  it('exports the locked founder widths (28 / 200)', () => {
    expect(SIDEBAR_COLLAPSED_WIDTH_PX).toBe(28)
    expect(SIDEBAR_EXPANDED_WIDTH_PX).toBe(200)
  })

  it('inline width is 28px when collapsed', () => {
    renderSidebar({ state: 'collapsed' })
    const aside = screen.getByTestId('source-schema-sidebar')
    expect(aside.style.width).toBe('28px')
  })

  it('inline width is 200px when expanded', () => {
    renderSidebar({ state: 'expanded' })
    const aside = screen.getByTestId('source-schema-sidebar')
    expect(aside.style.width).toBe('200px')
  })
})

describe('SourceSchemaSidebar — collapsed state', () => {
  beforeEach(() => {
    renderSidebar({ state: 'collapsed' })
  })

  it('renders the aside with the source-schema-browser aria-label', () => {
    const aside = screen.getByLabelText('Source schema browser')
    expect(aside.tagName).toBe('ASIDE')
  })

  it('exposes data-state="collapsed" for downstream styling/queries', () => {
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('collapsed')
  })

  it('renders the vertical rail as a button labelled "Expand source schema browser"', () => {
    const rail = screen.getByRole('button', {
      name: 'Expand source schema browser',
    })
    expect(rail).toBeInTheDocument()
    expect(rail.getAttribute('data-testid')).toBe('source-schema-sidebar-rail')
  })

  it('renders the vertical "Source fields" label', () => {
    const label = screen.getByText('Source fields')
    expect(label).toBeInTheDocument()
    // The vertical label uses the `[writing-mode:vertical-rl]` arbitrary
    // utility — assert the class is present so the visual contract is
    // regression-guarded against accidental Tailwind/CSS purges.
    expect(label.className).toContain('[writing-mode:vertical-rl]')
    expect(label.className).toContain('[transform:rotate(180deg)]')
  })

  it('renders the em-dash placeholder when sourceFields is empty', () => {
    expect(screen.getByTestId('source-schema-sidebar-count')).toHaveTextContent(
      '—',
    )
  })

  it('does NOT render the close chevron, search, or filter pills', () => {
    expect(screen.queryByTestId('source-schema-sidebar-collapse')).toBeNull()
    expect(screen.queryByTestId('source-schema-sidebar-search')).toBeNull()
    expect(screen.queryByTestId('source-schema-sidebar-filter-all')).toBeNull()
  })

  it('top-anchors the label + count (justify-start, no bottom anchoring)', () => {
    // Founder amendment (2026-04-25): the rail's label/count block
    // must sit at the TOP of the rail so the affordance lands in the
    // user's first scan zone. Regression-guard against accidental
    // re-introduction of `justify-end` / `mt-auto` etc.
    const rail = screen.getByTestId('source-schema-sidebar-rail')
    expect(rail.className).toContain('justify-start')
    expect(rail.className).not.toContain('justify-end')
    expect(rail.className).not.toContain('justify-center')
    expect(rail.className).not.toContain('mt-auto')
  })
})

describe('SourceSchemaSidebar — expanded state', () => {
  it('renders the header with title and close chevron', () => {
    renderSidebar({ state: 'expanded' })
    expect(screen.getByText('Source fields')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Collapse source schema browser' }),
    ).toBeInTheDocument()
  })

  it('renders the search input with an accessible label', () => {
    renderSidebar({ state: 'expanded' })
    const search = screen.getByLabelText('Search source fields')
    expect(search.tagName).toBe('INPUT')
    expect(search.getAttribute('placeholder')).toBe('Search…')
  })

  it('renders the three filter pills (All / Mapped / Unmapped)', () => {
    renderSidebar({ state: 'expanded' })
    expect(
      screen.getByTestId('source-schema-sidebar-filter-all'),
    ).toHaveTextContent('All')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-mapped'),
    ).toHaveTextContent('Mapped')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-unmapped'),
    ).toHaveTextContent('Unmapped')
  })

  it('marks the active filter pill with aria-pressed="true"', () => {
    renderSidebar({ state: 'expanded', filter: 'mapped' })
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-mapped')
        .getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-all')
        .getAttribute('aria-pressed'),
    ).toBe('false')
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-unmapped')
        .getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('renders the no-schema empty state when sourceFields is empty', () => {
    renderSidebar({ state: 'expanded' })
    expect(
      screen.getByTestId('source-schema-sidebar-empty-no-schema'),
    ).toHaveTextContent('No source schema ingested for this project.')
  })

  it('does NOT render the collapsed rail when expanded', () => {
    renderSidebar({ state: 'expanded' })
    expect(screen.queryByTestId('source-schema-sidebar-rail')).toBeNull()
  })

  it('groups the filter pills in a labelled region', () => {
    renderSidebar({ state: 'expanded' })
    const group = screen.getByRole('group', { name: 'Filter source fields' })
    expect(group).toBeInTheDocument()
  })
})

describe('SourceSchemaSidebar — interaction (Gap 11a)', () => {
  it('clicking the collapsed rail calls onStateChange("expanded")', () => {
    const { onStateChange } = renderSidebar({ state: 'collapsed' })
    fireEvent.click(screen.getByTestId('source-schema-sidebar-rail'))
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith('expanded')
  })

  it('clicking the close chevron calls onStateChange("collapsed")', () => {
    const { onStateChange } = renderSidebar({ state: 'expanded' })
    fireEvent.click(screen.getByTestId('source-schema-sidebar-collapse'))
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith('collapsed')
  })

  it('clicking a filter pill calls onFilterChange with that value', () => {
    const { onFilterChange } = renderSidebar({
      state: 'expanded',
      filter: 'unmapped',
    })
    fireEvent.click(screen.getByTestId('source-schema-sidebar-filter-mapped'))
    expect(onFilterChange).toHaveBeenCalledTimes(1)
    expect(onFilterChange).toHaveBeenCalledWith('mapped')
  })
})

describe('SourceSchemaSidebar — focus management (Gap 11a)', () => {
  // Focus moves on USER-initiated toggles only. We simulate a user
  // click by firing the click handler, then re-render with the new
  // state (mirroring how the parent's `setSidebarState` would flow).
  // The focus-move effect runs after the state-change render commits.

  it('focuses the close chevron after the user clicks the rail to expand', () => {
    const onStateChange = vi.fn()
    const { rerender } = render(
      <SourceSchemaSidebar
        state="collapsed"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
        sourceFields={[]}
      />,
    )
    // User click — flag the action as user-initiated inside the
    // component (the click handler sets `lastUserActionRef`).
    fireEvent.click(screen.getByTestId('source-schema-sidebar-rail'))
    // Parent now flips state to 'expanded'. Re-render with the new
    // prop. The focus effect should fire and move focus to the
    // chevron.
    rerender(
      <SourceSchemaSidebar
        state="expanded"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
        sourceFields={[]}
      />,
    )
    expect(document.activeElement).toBe(
      screen.getByTestId('source-schema-sidebar-collapse'),
    )
  })

  it('focuses the rail after the user clicks the chevron to collapse', () => {
    const onStateChange = vi.fn()
    const { rerender } = render(
      <SourceSchemaSidebar
        state="expanded"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
        sourceFields={[]}
      />,
    )
    fireEvent.click(screen.getByTestId('source-schema-sidebar-collapse'))
    rerender(
      <SourceSchemaSidebar
        state="collapsed"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
        sourceFields={[]}
      />,
    )
    expect(document.activeElement).toBe(
      screen.getByTestId('source-schema-sidebar-rail'),
    )
  })

  it('does NOT steal focus on a non-interactive state change (hydration pop)', () => {
    // Mount in 'collapsed' (no user click), then rerender as
    // 'expanded' simulating the hydration pass in `useSidebarState`.
    // Focus should remain on the previously-active body, not move to
    // the chevron.
    const onStateChange = vi.fn()
    const { rerender } = render(
      <>
        <button data-testid="external-trigger">trigger</button>
        <SourceSchemaSidebar
          state="collapsed"
          filter="unmapped"
          onStateChange={onStateChange}
          onFilterChange={vi.fn()}
          sourceFields={[]}
        />
      </>,
    )
    const trigger = screen.getByTestId('external-trigger')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    rerender(
      <>
        <button data-testid="external-trigger">trigger</button>
        <SourceSchemaSidebar
          state="expanded"
          filter="unmapped"
          onStateChange={onStateChange}
          onFilterChange={vi.fn()}
          sourceFields={[]}
        />
      </>,
    )
    expect(document.activeElement).toBe(trigger)
  })
})

describe('SourceSchemaSidebar — light-mode-only invariant', () => {
  it('rendered HTML contains no Tailwind dark-prefix classes (collapsed)', () => {
    const { container } = renderSidebar({ state: 'collapsed' })
    expect(container.innerHTML).not.toMatch(/\bdark:[a-z]/i)
  })

  it('rendered HTML contains no Tailwind dark-prefix classes (expanded)', () => {
    const { container } = renderSidebar({ state: 'expanded' })
    expect(container.innerHTML).not.toMatch(/\bdark:[a-z]/i)
  })
})

// ─── Gap 11b — content + interactions ────────────────────────────────────────

describe('SourceSchemaSidebar — count badge (Gap 11b)', () => {
  it('shows the total field count on the collapsed rail', () => {
    renderSidebar({ state: 'collapsed', sourceFields: FIXTURE_FIELDS })
    expect(screen.getByTestId('source-schema-sidebar-count')).toHaveTextContent(
      '4',
    )
  })

  it('shows the total field count next to the expanded header', () => {
    renderSidebar({ state: 'expanded', sourceFields: FIXTURE_FIELDS })
    expect(screen.getByTestId('source-schema-sidebar-count')).toHaveTextContent(
      '4',
    )
  })
})

describe('SourceSchemaSidebar — filter pill counts (Gap 11b)', () => {
  it('derives All/Mapped/Unmapped counts client-side', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    expect(
      screen.getByTestId('source-schema-sidebar-filter-all'),
    ).toHaveTextContent('All 4')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-mapped'),
    ).toHaveTextContent('Mapped 2')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-unmapped'),
    ).toHaveTextContent('Unmapped 2')
  })

  it('shows zero counts when sourceFields is empty', () => {
    renderSidebar({ state: 'expanded', sourceFields: [] })
    expect(
      screen.getByTestId('source-schema-sidebar-filter-all'),
    ).toHaveTextContent('All 0')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-mapped'),
    ).toHaveTextContent('Mapped 0')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-unmapped'),
    ).toHaveTextContent('Unmapped 0')
  })
})

describe('SourceSchemaSidebar — field rendering (Gap 11b)', () => {
  it('renders all fields when filter="all"', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    expect(fields).toHaveLength(4)
    expect(fields.map((f) => f.getAttribute('data-source-field-id'))).toEqual([
      'sf-acct-num',
      'sf-acct-bal',
      'sf-cust-id',
      'sf-cust-name',
    ])
  })

  it('preserves server order across groups (no client-side sort)', () => {
    // Server-provided fields are pre-sorted (sourceTable ASC,
    // ordinalPosition ASC, name ASC). We rely on Map insertion order
    // for grouping; passing the canonical fixture must yield groups
    // in the same order.
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const groups = screen.getAllByTestId('source-schema-sidebar-group')
    expect(
      groups.map((g) => g.getAttribute('data-source-table-name')),
    ).toEqual(['ACCT_HIST', 'CIF_MASTER'])
  })

  it('groups fields by source table with header + count', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const groups = screen.getAllByTestId('source-schema-sidebar-group')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveTextContent('ACCT_HIST')
    expect(groups[0]).toHaveTextContent('2')
    expect(groups[1]).toHaveTextContent('CIF_MASTER')
    expect(groups[1]).toHaveTextContent('2')
  })

  it('emits a status dot per field with data-mapping-status', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const dots = screen.getAllByTestId('source-schema-sidebar-status-dot')
    expect(dots).toHaveLength(4)
    const mappedDots = dots.filter(
      (d) => d.getAttribute('data-mapping-status') === 'mapped',
    )
    const unmappedDots = dots.filter(
      (d) => d.getAttribute('data-mapping-status') === 'unmapped',
    )
    expect(mappedDots).toHaveLength(2)
    expect(unmappedDots).toHaveLength(2)
  })
})

describe('SourceSchemaSidebar — filter pill predicate (Gap 11b)', () => {
  it('filter="mapped" hides unmapped fields', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'mapped',
      sourceFields: FIXTURE_FIELDS,
    })
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    expect(fields).toHaveLength(2)
    fields.forEach((f) => {
      expect(f.getAttribute('data-mapping-status')).toBe('mapped')
    })
  })

  it('filter="unmapped" hides mapped fields (acknowledged still renders)', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'unmapped',
      sourceFields: FIXTURE_FIELDS,
    })
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    expect(fields).toHaveLength(2)
    fields.forEach((f) => {
      expect(f.getAttribute('data-mapping-status')).toBe('unmapped')
    })
    // Acknowledged field renders identically — Gap 11c will design
    // the dedicated visual treatment.
    expect(
      screen.getByText('BALANCE').closest('button')?.getAttribute(
        'data-source-field-id',
      ),
    ).toBe('sf-acct-bal')
  })

  it('filter="all" shows mapped + unmapped together', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    expect(
      screen.getAllByTestId('source-schema-sidebar-field'),
    ).toHaveLength(4)
  })

  it('shows the no-match empty state when filter narrows to zero', () => {
    const onlyMapped = FIXTURE_FIELDS.filter(
      (f) => f.mappingStatus === 'mapped',
    )
    renderSidebar({
      state: 'expanded',
      filter: 'unmapped',
      sourceFields: onlyMapped,
    })
    expect(
      screen.getByTestId('source-schema-sidebar-empty-no-match'),
    ).toHaveTextContent('No source fields match the current filter.')
  })
})

describe('SourceSchemaSidebar — search wiring with debounce (Gap 11b)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not filter immediately on input change (debounce window)', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const search = screen.getByTestId('source-schema-sidebar-search')
    fireEvent.change(search, { target: { value: 'CUSTOMER' } })
    // Before the debounce fires, all 4 fields still render.
    expect(
      screen.getAllByTestId('source-schema-sidebar-field'),
    ).toHaveLength(4)
  })

  it('applies the search filter after the 200ms debounce window', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const search = screen.getByTestId('source-schema-sidebar-search')
    fireEvent.change(search, { target: { value: 'CUSTOMER' } })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_SEARCH_DEBOUNCE_MS)
    })
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    expect(fields).toHaveLength(2)
    expect(fields.map((f) => f.getAttribute('data-source-field-id'))).toEqual([
      'sf-cust-id',
      'sf-cust-name',
    ])
  })

  it('matches against source-table name as well as field name', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const search = screen.getByTestId('source-schema-sidebar-search')
    fireEvent.change(search, { target: { value: 'ACCT_HIST' } })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_SEARCH_DEBOUNCE_MS)
    })
    expect(
      screen.getAllByTestId('source-schema-sidebar-field'),
    ).toHaveLength(2)
  })

  it('search is case-insensitive', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const search = screen.getByTestId('source-schema-sidebar-search')
    fireEvent.change(search, { target: { value: 'customer_name' } })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_SEARCH_DEBOUNCE_MS)
    })
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    expect(fields).toHaveLength(1)
    expect(fields[0].getAttribute('data-source-field-id')).toBe(
      'sf-cust-name',
    )
  })

  it('whitespace-only input is treated as empty', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const search = screen.getByTestId('source-schema-sidebar-search')
    fireEvent.change(search, { target: { value: '   ' } })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_SEARCH_DEBOUNCE_MS)
    })
    expect(
      screen.getAllByTestId('source-schema-sidebar-field'),
    ).toHaveLength(4)
  })

  it('shows the no-match empty state when search yields zero results', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const search = screen.getByTestId('source-schema-sidebar-search')
    fireEvent.change(search, { target: { value: 'zzz_no_match' } })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_SEARCH_DEBOUNCE_MS)
    })
    expect(
      screen.getByTestId('source-schema-sidebar-empty-no-match'),
    ).toBeInTheDocument()
  })
})

describe('SourceSchemaSidebar — click-to-highlight (Gap 11b)', () => {
  it('clicking a field row invokes onFieldClick with that fieldId', () => {
    const onFieldClick = vi.fn()
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
      onFieldClick,
    })
    const target = screen
      .getAllByTestId('source-schema-sidebar-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cust-id')!
    fireEvent.click(target)
    expect(onFieldClick).toHaveBeenCalledTimes(1)
    expect(onFieldClick).toHaveBeenCalledWith('sf-cust-id')
  })

  it('marks the highlighted field with aria-pressed="true" and bg-blue-50', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
      highlightedSourceFieldId: 'sf-cust-id',
    })
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    const highlighted = fields.find(
      (f) => f.getAttribute('data-source-field-id') === 'sf-cust-id',
    )!
    expect(highlighted.getAttribute('aria-pressed')).toBe('true')
    expect(highlighted.getAttribute('data-is-highlighted')).toBe('true')
    expect(highlighted.className).toContain('bg-blue-50')
    const others = fields.filter(
      (f) => f.getAttribute('data-source-field-id') !== 'sf-cust-id',
    )
    others.forEach((o) => {
      expect(o.getAttribute('aria-pressed')).toBe('false')
      expect(o.getAttribute('data-is-highlighted')).toBe('false')
    })
  })
})

describe('SourceSchemaSidebar — hover tooltip (Gap 11b)', () => {
  it('renders a tooltip per field with dataType and sample values', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const tooltips = screen.getAllByTestId('source-schema-sidebar-tooltip')
    expect(tooltips).toHaveLength(4)
    const custIdTooltip = tooltips.find((t) =>
      t.textContent?.includes('1001, 1002, 1003'),
    )
    expect(custIdTooltip).toBeDefined()
    expect(custIdTooltip).toHaveTextContent('INT')
  })

  it('shows the no-samples placeholder when sample values are empty', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: [
        makeField({
          id: 'sf-no-samples',
          name: 'NO_SAMPLES',
          dataType: 'TEXT',
          sampleValues: [],
        }),
      ],
    })
    expect(
      screen.getByTestId('source-schema-sidebar-tooltip'),
    ).toHaveTextContent('No sample values profiled')
  })

  it('field row references its tooltip via aria-describedby', () => {
    renderSidebar({
      state: 'expanded',
      filter: 'all',
      sourceFields: FIXTURE_FIELDS,
    })
    const field = screen
      .getAllByTestId('source-schema-sidebar-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cust-id')!
    const tooltipId = field.getAttribute('aria-describedby')
    expect(tooltipId).toBeTruthy()
    expect(document.getElementById(tooltipId!)).toBeInTheDocument()
  })
})

describe('SourceSchemaSidebar — no-shim invariant (Gap 11b)', () => {
  it('does not call Array.prototype.sort during render', () => {
    // Defense-in-depth: the no-shim test guards the redesign path
    // against `.sort(` literals at the source level. Here we add a
    // runtime check — instrument Array.prototype.sort and assert it
    // is never invoked during a sidebar render with realistic input.
    const originalSort = Array.prototype.sort
    const sortSpy = vi.fn(function (this: unknown[], ...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalSort as any).apply(this, args)
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Array.prototype as any).sort = sortSpy
    try {
      renderSidebar({
        state: 'expanded',
        filter: 'all',
        sourceFields: FIXTURE_FIELDS,
      })
    } finally {
      Array.prototype.sort = originalSort
    }
    expect(sortSpy).not.toHaveBeenCalled()
  })
})

// ─── Refinement 1 — sidebar mounts in-flow below the page header ────────────
//
// Refinement 1 (Phase 4-polish-1 final-final, 2026-04-26): the user
// observed that "the source fields sidebar covers the page header
// when expanded." Investigation confirmed the SourceSchemaSidebar
// is NOT in fact a viewport-fixed overlay — it mounts as a regular
// flex child inside `MappingContent`'s horizontal flex row, which
// itself sits BELOW the `<PageHeader>` in the parent flex column.
// Width changes (28px ↔ 200px) only resize the column within the
// row beneath the header; the sidebar can't physically extend up
// past the row's top edge.
//
// Concretely the layout is:
//
//   <MappingContent>            flex h-full flex-col       (column)
//     <PageHeader />            shrink-0, min-h-[60px]
//     <div ...>                 flex flex-1 (row, fills below header)
//       <SourceSchemaSidebar /> width 28 ↔ 200 (in-flow flex child)
//       <div>{body}</div>
//     </div>
//   </MappingContent>
//
// The aside carries `position: relative` (NOT fixed/absolute), so
// it's bound by its parent flex row. No portal. No `top: 0`. No
// `inset-y-0`. The sidebar's stretch is `self-stretch` against the
// row's height — it does NOT stretch beyond the row.
//
// These regression guards pin that contract so a future refactor
// to `position: fixed` (which would re-introduce the very bug the
// user was reporting against an imagined fixed-positioned sidebar)
// fails this test rather than silently shipping a header-covering
// overlay. If a future iteration intentionally adopts a fixed-
// positioned sidebar, update the contract here AND the
// `MappingContent` layout in tandem.

describe('SourceSchemaSidebar — Refinement 1 (in-flow positioning)', () => {
  it('aside element is positioned `relative` (in flow), NOT fixed or absolute', () => {
    renderSidebar({ state: 'expanded', filter: 'all', sourceFields: [] })
    const sidebar = screen.getByTestId('source-schema-sidebar')
    expect(sidebar.tagName).toBe('ASIDE')
    const cls = sidebar.className
    expect(cls).toContain('relative')
    // Forbid any positioning utility that would take it out of flow
    // and let it overlay the PageHeader above.
    expect(cls).not.toMatch(/\bfixed\b/)
    expect(cls).not.toMatch(/\babsolute\b/)
    expect(cls).not.toMatch(/\binset-y-0\b/)
    expect(cls).not.toMatch(/\binset-0\b/)
    expect(cls).not.toMatch(/\btop-0\b/)
  })

  it('aside stretches to its parent flex row only (self-stretch, not h-screen)', () => {
    renderSidebar({ state: 'expanded', filter: 'all', sourceFields: [] })
    const sidebar = screen.getByTestId('source-schema-sidebar')
    const cls = sidebar.className
    // self-stretch is the cross-axis stretch within the parent flex
    // row — it bounds the sidebar's height to the row, NOT the
    // viewport. h-screen would let it extend above PageHeader.
    expect(cls).toContain('self-stretch')
    expect(cls).not.toMatch(/\bh-screen\b/)
    expect(cls).not.toMatch(/\bh-\[100vh\]/)
  })

  it('aside does NOT carry an inline style top/bottom that would anchor it to the viewport', () => {
    renderSidebar({ state: 'expanded', filter: 'all', sourceFields: [] })
    const sidebar = screen.getByTestId('source-schema-sidebar')
    const style = sidebar.getAttribute('style') ?? ''
    // The sidebar's only inline style is `width: <px>` (toggling
    // between collapsed and expanded). Anything else is suspect.
    expect(style).not.toMatch(/top:/)
    expect(style).not.toMatch(/bottom:/)
    expect(style).not.toMatch(/position:/)
  })
})
