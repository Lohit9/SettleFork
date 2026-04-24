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
      tableCount={targetTables.length}
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

  it('renders the table-count gutter when tableCount > 0', () => {
    renderFilterRow()
    expect(screen.getByTestId('filter-row-table-count')).toHaveTextContent(
      '2 tables',
    )
  })

  it('uses singular "1 table" when tableCount === 1', () => {
    const onFiltersChange = vi.fn()
    render(
      <FilterRow
        filters={DEFAULT_FILTER_STATE}
        onFiltersChange={onFiltersChange}
        targetTables={targetTables}
        sourceTables={sourceTables}
        tableCount={1}
      />,
    )
    expect(screen.getByTestId('filter-row-table-count')).toHaveTextContent(
      '1 table',
    )
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
        tableCount={targetTables.length}
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
        tableCount={targetTables.length}
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
