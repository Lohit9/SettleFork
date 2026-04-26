'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, X } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/components/ui/utils'
import type {
  SourceTableSummary,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import {
  hasActiveFilters,
  type MappingFilterState,
  type MappingStatusFilter,
} from '@/lib/utils/mapping-filters'

// ─────────────────────────────────────────────────────────────────────────────
// FilterRow — Phase 3 Gap 3.
// ─────────────────────────────────────────────────────────────────────────────
//
// Three Selects + one search input, arranged left-to-right, with an
// optional "N tables" gutter on the right (per spec mockup at
// docs/features/mapping-redesign.md §Information architecture line 648).
// A "Clear filters" affordance appears whenever any filter is non-default.
//
// This component is controlled: it renders the provided `filters` state
// and emits updates through `onFiltersChange`. Debouncing the
// search-to-URL write lives in the parent (MappingContent), so the
// component stays pure aside from its own local search-input
// text-selection ergonomics.

interface FilterRowProps {
  /** Current filter state. Typically driven by URL params in the parent. */
  filters: MappingFilterState
  /**
   * Called on every filter change. The parent is responsible for
   * persisting to URL (and debouncing the search param if desired).
   */
  onFiltersChange: (next: MappingFilterState) => void
  /** Universe of target tables for the Target dropdown. */
  targetTables: readonly TargetTableSummary[]
  /** Universe of source tables for the Source dropdown. */
  sourceTables: readonly SourceTableSummary[]
  /**
   * Table count gutter label. Typically targetTables.length — rendered
   * on the right to match the spec mockup. Pass 0 to hide.
   */
  tableCount: number
  /**
   * Phase 3 Gap 9 — rejected TFM count, used to gate the "Rejected"
   * status option in the dropdown. The option is hidden when the count
   * is zero (mirroring the counter-pill pattern from Gap 4a §9 Q6),
   * with one exception: if the user already has Rejected selected
   * (e.g., via a legacy URL bookmark), keep the option visible so the
   * Select stays in a valid state. They can clear it explicitly.
   *
   * Optional for back-compat with existing tests that don't pass it;
   * default is 0 → option hidden, which matches "fresh project" UX.
   */
  rejectedCount?: number
  /**
   * Phase 4c-1 — count of project-wide needs-review TFMs whose
   * confidence ≥ HIGH_CONFIDENCE_THRESHOLD (default 85). Drives the
   * "Approve high-confidence (N)" button visibility and copy. When
   * `0`, the button is hidden entirely (no disabled state — at zero
   * the affordance is noise; the dialog's own count would also be 0
   * by the time the user reached it). When omitted, the button is
   * also hidden — fixtures and storybook never wire it.
   *
   * Derivation lives in the parent (`MappingContent`), client-side
   * over the already-loaded `data.rows` (no extra round-trip). Cap
   * at 999+ for display purposes is unnecessary at expected scale.
   */
  highConfidenceCount?: number
  /**
   * Phase 4c-1 — fired when the user clicks "Approve high-confidence
   * (N)". Parent owns the dialog state and is responsible for
   * opening `BulkConfirmDialog` with `scope='high_confidence'`.
   */
  onApproveHighConfidenceClick?: () => void
}

const BASE_STATUS_OPTIONS: Array<{ value: MappingStatusFilter; label: string }> = [
  { value: 'all', label: 'All status' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'approved', label: 'Approved' },
]

const REJECTED_STATUS_OPTION: { value: MappingStatusFilter; label: string } = {
  value: 'rejected',
  label: 'Rejected',
}

export function FilterRow({
  filters,
  onFiltersChange,
  targetTables,
  sourceTables,
  tableCount,
  rejectedCount = 0,
  highConfidenceCount,
  onApproveHighConfidenceClick,
}: FilterRowProps) {
  // Gate the "Rejected" option on rejectedCount > 0, with a fallback to
  // keep the option visible when the current filter value is already
  // 'rejected' (legacy URL bookmark scenario). Without the fallback the
  // Select would render an invalid value.
  const statusOptions =
    rejectedCount > 0 || filters.status === 'rejected'
      ? [...BASE_STATUS_OPTIONS, REJECTED_STATUS_OPTION]
      : BASE_STATUS_OPTIONS
  // Local mirror for the search input so typing stays instant even
  // when the parent debounces URL writes. We sync back FROM the parent
  // whenever `filters.search` changes externally (e.g., URL-driven
  // navigation, clear-all).
  const [searchInput, setSearchInput] = useState<string>(filters.search)

  // Parent-driven sync: reflect external filter updates (nav, reset)
  // into the controlled input. We do NOT depend on the local value
  // here — that would create a loop with the debounced commit.
  useEffect(() => {
    setSearchInput(filters.search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search])

  const searchInputRef = useRef<HTMLInputElement>(null)

  const handleTargetChange = (value: string) => {
    onFiltersChange({ ...filters, target: value })
  }
  const handleSourceChange = (value: string) => {
    onFiltersChange({ ...filters, source: value })
  }
  const handleStatusChange = (value: string) => {
    if (
      value === 'all' ||
      value === 'needs_review' ||
      value === 'approved' ||
      value === 'rejected'
    ) {
      onFiltersChange({ ...filters, status: value })
    }
  }
  const handleSearchInput = (value: string) => {
    setSearchInput(value)
    onFiltersChange({ ...filters, search: value })
  }
  const handleClearSearch = () => {
    setSearchInput('')
    onFiltersChange({ ...filters, search: '' })
    searchInputRef.current?.focus()
  }
  const handleClearAll = () => {
    setSearchInput('')
    onFiltersChange({
      target: 'all',
      source: 'all',
      status: 'all',
      search: '',
    })
  }

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (searchInput !== '') handleClearSearch()
      else searchInputRef.current?.blur()
    }
  }

  const filtersActive = hasActiveFilters(filters)

  return (
    <div
      data-testid="mapping-redesign-filter-row"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      <FilterSelect
        ariaLabel="Filter by target table"
        testId="filter-target"
        value={filters.target}
        onChange={handleTargetChange}
        allLabel="All target tables"
        options={targetTables}
        isActive={filters.target !== 'all'}
      />

      <FilterSelect
        ariaLabel="Filter by source table"
        testId="filter-source"
        value={filters.source}
        onChange={handleSourceChange}
        allLabel="All source tables"
        options={sourceTables}
        isActive={filters.source !== 'all'}
      />

      <Select value={filters.status} onValueChange={handleStatusChange}>
        <SelectTrigger
          aria-label="Filter by status"
          data-testid="filter-status"
          className={cn(
            'h-9 w-auto min-w-[9rem] text-sm',
            filters.status !== 'all' &&
              'border-blue-200 bg-blue-50/60 text-blue-900',
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statusOptions.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative flex-1 min-w-[14rem] max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchInput(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search fields, tables, and mappings..."
          aria-label="Search mappings"
          data-testid="filter-search-input"
          className={cn(
            'h-9 w-full rounded-lg border bg-white pl-9 pr-9 text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/30',
            searchInput === ''
              ? 'border-gray-200 focus:border-blue-500'
              : 'border-blue-200 bg-blue-50/60 focus:border-blue-500',
          )}
        />
        {searchInput !== '' ? (
          <button
            type="button"
            aria-label="Clear search"
            data-testid="filter-search-clear"
            onClick={handleClearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      {filtersActive ? (
        <button
          type="button"
          onClick={handleClearAll}
          data-testid="filter-clear-all"
          className="h-9 rounded-lg px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
        >
          Clear filters
        </button>
      ) : null}

      {/*
        Phase 4c-1 — project-wide bulk approve for high-confidence
        needs-review TFMs. Hidden when the count is zero (or the prop
        is unset, e.g. fixtures). Sits in the right-aligned region
        ahead of the table-count gutter via `ml-auto` on the first
        right-aligned element. When BOTH this button and the table
        count are visible, only the leftmost gets `ml-auto`.
      */}
      {highConfidenceCount !== undefined &&
      highConfidenceCount > 0 &&
      onApproveHighConfidenceClick !== undefined ? (
        <button
          type="button"
          onClick={onApproveHighConfidenceClick}
          data-testid="filter-row-approve-high-confidence"
          className="ml-auto h-9 flex-shrink-0 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          Approve high-confidence ({highConfidenceCount})
        </button>
      ) : null}

      {tableCount > 0 ? (
        <span
          className={cn(
            'flex-shrink-0 text-xs tabular-nums text-gray-500',
            // Only claim ml-auto when the button above didn't take it.
            !(
              highConfidenceCount !== undefined &&
              highConfidenceCount > 0 &&
              onApproveHighConfidenceClick !== undefined
            ) && 'ml-auto',
          )}
          data-testid="filter-row-table-count"
        >
          {tableCount} {tableCount === 1 ? 'table' : 'tables'}
        </span>
      ) : null}
    </div>
  )
}

// ─── Reusable labeled table-filter select ────────────────────────────────────

interface FilterSelectProps {
  value: string
  onChange: (next: string) => void
  allLabel: string
  options: readonly { id: string; name: string; datasetName: string }[]
  isActive: boolean
  ariaLabel: string
  testId: string
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  isActive,
  ariaLabel,
  testId,
}: FilterSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn(
          'h-9 w-auto min-w-[10rem] max-w-[16rem] text-sm',
          isActive && 'border-blue-200 bg-blue-50/60 text-blue-900',
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt.id} value={opt.id}>
            <span className="flex flex-col items-start">
              <span className="truncate">{opt.name}</span>
              {opt.datasetName ? (
                <span className="truncate text-[10px] text-gray-400">
                  {opt.datasetName}
                </span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
