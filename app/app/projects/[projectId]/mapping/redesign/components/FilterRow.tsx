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
  CONFIDENCE_THRESHOLD_ROW_AMBER,
  CONFIDENCE_THRESHOLD_ROW_HIGH,
} from '@/lib/utils/confidence-format'
import {
  hasActiveFilters,
  type MappingConfidenceFilter,
  type MappingFilterState,
  type MappingStatusFilter,
} from '@/lib/utils/mapping-filters'

// ─────────────────────────────────────────────────────────────────────────────
// FilterRow — Phase 4-polish-1 final refinements.
// ─────────────────────────────────────────────────────────────────────────────
//
// Four Selects + one search input + a right-edge `N tables` (or
// contextual approve link) gutter, arranged left-to-right as a
// SINGLE-LINE legacy-aesthetic toolbar.
//
//   [All target tables ▾]  [All source tables ▾]  [All status ▾]  [All confidence ▾]   [🔍 search…]   N tables / Approve N high-confidence
//
// Aesthetic timeline:
//   • Phase 3 / Gap 3 baseline: tinted `bg-gray-50` toolbar with
//     short noun-less Status/Confidence "all" labels and a permanent
//     "Approve high-confidence (N)" button at the right edge.
//   • Comprehensive pass (2026-04-26): switched to `bg-white` +
//     `border-b border-gray-100` (Refinement B), `h-8 text-xs`
//     compact triggers, prefix labels per axis, vertical hairline
//     dividers, the new Confidence filter, search-to-right-edge,
//     contextual bulk-approve link replacing the permanent button.
//   • Final refinements (Refinement 3, 2026-04-26): prefix labels
//     and hairline dividers DROPPED. Each dropdown's default value
//     is now noun-carrying and self-documents the filter axis
//     ("All target tables", "All source tables", "All status",
//     "All confidence"). Cleaner read, fewer DOM nodes, no axis
//     duplication between prefix and value.
//
// Standing locks:
//   • Q2 / mutex right-edge: the contextual "Approve N high-confidence"
//     link REPLACES the table-count gutter when active — they never
//     co-render. Whichever element claims the slot uses `ml-auto` to
//     sit flush against the toolbar's right edge.
//   • Q8 / threshold-derived labels: Confidence band labels derive
//     from `CONFIDENCE_THRESHOLD_ROW_HIGH` (85) and
//     `CONFIDENCE_THRESHOLD_ROW_AMBER` (40) imported from
//     `confidence-format.ts`. No literal threshold numbers in this
//     file — the dropdown self-updates if a future PR shifts a band.
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
   * Phase 4c-1 (4-polish-1 redesign) — count of project-wide
   * needs-review TFMs whose confidence ≥ HIGH_CONFIDENCE_THRESHOLD
   * (default 85). Drives the contextual "Approve N high-confidence"
   * link visibility + copy. The link surfaces ONLY when the
   * Confidence filter is set to 'high' AND the count is positive —
   * the user has explicitly narrowed to high-confidence rows, so the
   * bulk-approve affordance becomes contextually useful instead of a
   * permanent right-edge button. When the prop is unset (fixtures /
   * storybook), the link is hidden unconditionally.
   *
   * Derivation lives in the parent (`MappingContent`), client-side
   * over the already-loaded `data.rows` (no extra round-trip). Cap
   * at 999+ for display purposes is unnecessary at expected scale.
   */
  highConfidenceCount?: number
  /**
   * Fired when the user clicks the contextual "Approve N
   * high-confidence" link. Parent owns the dialog state and is
   * responsible for opening `BulkConfirmDialog` with
   * `scope='high_confidence'`.
   */
  onApproveHighConfidenceClick?: () => void
}

// Refinement 3 (2026-04-26): prefix labels DROPPED from the toolbar.
// Each dropdown's default value now self-documents the filter axis,
// so Status and Confidence return to noun-carrying "all" labels
// (parity with Source / Target which already carry their nouns):
//
//   • 'All status'      — was 'All' under the prefix-label aesthetic
//   • 'All source tables'
//   • 'All target tables'
//   • 'All confidence'  — was 'All' under the prefix-label aesthetic
//
// The hairline dividers between groups are also gone — without prefix
// labels there's nothing to separate, just dropdowns sitting in `gap-3`
// flow.
const BASE_STATUS_OPTIONS: Array<{ value: MappingStatusFilter; label: string }> = [
  { value: 'all', label: 'All status' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'approved', label: 'Approved' },
]

const REJECTED_STATUS_OPTION: { value: MappingStatusFilter; label: string } = {
  value: 'rejected',
  label: 'Rejected',
}

// Q8 lock — band labels derive from the canonical thresholds in
// `confidence-format.ts` so the dropdown copy and the row-level color
// band can never drift. If a future PR shifts a threshold, the
// dropdown self-updates with no edits here.
const CONFIDENCE_OPTIONS: Array<{ value: MappingConfidenceFilter; label: string }> = [
  { value: 'all', label: 'All confidence' },
  { value: 'high', label: `High (≥${CONFIDENCE_THRESHOLD_ROW_HIGH})` },
  {
    value: 'medium',
    label: `Medium (${CONFIDENCE_THRESHOLD_ROW_AMBER}–${
      CONFIDENCE_THRESHOLD_ROW_HIGH - 1
    })`,
  },
  { value: 'low', label: `Low (<${CONFIDENCE_THRESHOLD_ROW_AMBER})` },
]

export function FilterRow({
  filters,
  onFiltersChange,
  targetTables,
  sourceTables,
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
  const handleConfidenceChange = (value: string) => {
    if (
      value === 'all' ||
      value === 'high' ||
      value === 'medium' ||
      value === 'low'
    ) {
      onFiltersChange({ ...filters, confidence: value })
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
      confidence: 'all',
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

  // Contextual bulk-approve link visibility (Task 5c). Three conditions
  // compose with AND: the parent supplies a non-zero count AND the
  // Confidence filter has narrowed to 'high' AND the click handler is
  // wired. Outside this context the affordance is hidden.
  const showContextualBulkApprove =
    filters.confidence === 'high' &&
    highConfidenceCount !== undefined &&
    highConfidenceCount > 0 &&
    onApproveHighConfidenceClick !== undefined

  return (
    <div
      data-testid="mapping-redesign-filter-row"
      // Phase 4-polish-1 sidebar architecture refactor (2026-04-26):
      // FilterRow now lives at PAGE LEVEL — a direct child of the
      // outer `flex h-full flex-col bg-gray-50` column rendered by
      // `MappingRedesignContent`, sibling to `<PageHeader>` and
      // `<MappingSummaryStrip>`. Previously it lived inside the body's
      // `flex-1 overflow-auto` scroll container with `sticky top-0
      // z-10 -mx-6 mb-4` to compensate for that placement; now that
      // it's outside any scroll container, those classes are gone:
      //
      //   • `sticky top-0` removed — DOM order alone keeps the row
      //     visible at the top of the page (it never scrolls because
      //     it's not inside a scroll container).
      //   • `z-10` removed — there are no sticky siblings to layer
      //     against; popovers (kebab z-20, FieldPicker portal
      //     z-9999) still render above the toolbar by their own
      //     z-index.
      //   • `-mx-6` removed — the centered `max-w-5xl px-6` column no
      //     longer wraps this row, so no compensating negative
      //     margin is needed; the row spans the full viewport width.
      //   • `mb-4` removed — the body content's own `py-6` (on the
      //     reading column inside the body scroller) provides
      //     breathing room above the first group card.
      //
      // Retained from the prior comprehensive pass:
      //   • `bg-white` + `border-b border-gray-100` — legacy toolbar
      //     aesthetic; reads as a true toolbar against the gray-50
      //     page background.
      //   • `px-5 py-2.5` — toolbar's own internal padding.
      //   • `flex items-center gap-3` — single-row layout of the
      //     filter dropdowns + search; `gap-3` between adjacent
      //     controls. No `flex-wrap` — the toolbar is a single line
      //     at supported viewports (≥768px).
      //
      // `flex-shrink-0` is new and load-bearing here: without it, the
      // toolbar can be vertically compressed by the flex column when
      // the body's `flex-1` claims more space than the viewport can
      // afford. The strip carries the same flag for the same reason.
      className="flex flex-shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-5 py-2.5"
    >
      {/*
        Refinement 3 (2026-04-26): prefix labels and hairline dividers
        were removed. Each dropdown's default value is now noun-carrying
        and self-documents the filter axis ("All target tables", "All
        source tables", "All status", "All confidence"). The dropdowns
        sit in the toolbar's `gap-3` flow with no extra structure.
      */}
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
            'h-8 w-auto min-w-[7rem] text-xs',
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

      <Select value={filters.confidence} onValueChange={handleConfidenceChange}>
        <SelectTrigger
          aria-label="Filter by confidence"
          data-testid="filter-confidence"
          className={cn(
            'h-8 w-auto min-w-[8rem] text-xs',
            filters.confidence !== 'all' &&
              'border-blue-200 bg-blue-50/60 text-blue-900',
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONFIDENCE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/*
        Refinement C (Phase 4-polish-1 final, 2026-04-26): the search
        wrapper is now a fixed `w-72` (288px) compact box pushed to
        the right edge via `ml-auto`. The prior `flex-1 min-w-[14rem]
        max-w-md` pattern absorbed all available horizontal space up
        to 28rem, which read as visually unbalanced at wide viewports
        (search dominated the toolbar). Compact + right-aligned
        creates a clean dropdowns-left / search-right rhythm with
        large whitespace between, matching the legacy mapping page.
      */}
      <div
        className="relative ml-auto w-72 flex-shrink-0"
        data-testid="filter-row-search-wrapper"
      >
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
            'h-8 w-full rounded-md border bg-white pl-9 pr-9 text-xs text-gray-900 placeholder:text-gray-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/30',
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
          className="h-8 flex-shrink-0 rounded-md px-2.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
        >
          Clear filters
        </button>
      ) : null}

      {/*
        Right-edge slot. Refinement 5 (Phase 4-polish-1 final-final,
        2026-04-26): the passive table-count gutter ("8 tables") was
        DROPPED. It was passive informational, not actionable, and
        sat orphaned in tiny text adding visual chrome without
        function. The contextual bulk-approve link still surfaces
        in the same right-edge slot when filter=high AND count>0 —
        that affordance IS actionable and earns its place.

        Search wrapper (Refinement C) still owns `ml-auto`; the
        approve button sits naturally to its right via the toolbar's
        `gap-3` when present. When the approve button is absent,
        nothing else competes for the right edge.
      */}
      {showContextualBulkApprove ? (
        <button
          type="button"
          onClick={onApproveHighConfidenceClick}
          data-testid="filter-row-approve-high-confidence"
          className="h-8 flex-shrink-0 rounded-md px-2 text-xs font-medium text-blue-600 underline-offset-2 transition-colors hover:bg-blue-50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          Approve {highConfidenceCount} high-confidence
        </button>
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
          'h-8 w-auto min-w-[8rem] max-w-[14rem] text-xs',
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
