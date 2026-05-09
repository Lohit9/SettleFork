'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  MappingRow,
  SourceFieldWithState,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import {
  FieldMappingRow,
  type FieldMappingRowOptimisticState,
} from './FieldMappingRow'
import { ChevronRight, MoreHorizontal } from '@/components/icons'
import { cn } from '@/components/ui/utils'

// Threshold below which we skip virtualization. The virtualizer adds
// per-row overhead (measureElement + ResizeObserver) that's pure cost
// for small groups; the existing rows.map render path is faster for
// short lists. 50 was picked because the default Mitratech-tier
// project has ~20-40 fields per target table, so most groups stay on
// the non-virtualized path. Larger PE-backed M&A projects with 200+
// field tables hit the virtualized path automatically.
const VIRTUALIZATION_THRESHOLD = 50

// ─────────────────────────────────────────────────────────────────────────────
// TargetTableGroup — Phase 3 Gap 4c (extended in Gap 3 for filtered counts).
// ─────────────────────────────────────────────────────────────────────────────
//
// One target table's worth of mapping rows, under a shared header. The spec
// (docs/features/mapping-redesign.md §Information architecture) replaces the
// legacy `source → target` pair in group headers with a single target-table
// identity; cross-table sources surface on individual rows via TableBadge.
//
// Gap 3 addition: optional `filteredCount` prop drives a "3 of 19 fields"
// subtitle when a filter narrows the group, and a polite "no fields match"
// empty-state when all rows are filtered out. Pass no `filteredCount` at
// all when filters are not active; the component then reads `fieldCount`
// from `TargetTableSummary` directly (Gap 4c behavior).
//
// Order contract (see `MappingsForRedesignResult.rows` JSDoc): the server
// guarantees `(targetTable.name ASC, targetField.ordinalPosition ASC,
// targetField.name ASC)`. Consumers MUST NOT re-sort. This component passes
// `rows` through as-is.

interface TargetTableGroupProps {
  targetTable: TargetTableSummary
  /**
   * Rows belonging to this target table, pre-filtered by the parent.
   * Must be in server-guaranteed order; do NOT sort here.
   */
  rows: MappingRow[]
  /**
   * Ref to the page's body scroll container — the inner `flex-1
   * overflow-auto` div in `MappingContent`. Forwarded to
   * `VirtualizedRowList` so the virtualizer can target the correct
   * scroll element. Optional for legacy / fixture callers that don't
   * cross the virtualization threshold (≥50 rows); when omitted, a
   * group at the threshold falls back to a non-functional virtualizer
   * (acceptable in tests/storybook because no fixture exercises
   * 50+ rows).
   */
  scrollContainerRef?: RefObject<HTMLDivElement | null>
  /**
   * Optional filter-aware counts. When provided AND `matching < total`
   * the header shows "X of Y fields"; when equal it falls through to
   * the Gap 4c "Y fields" label. When `matching === 0` the component
   * renders a polite empty-state inline.
   *
   * Omit when filters are inactive (or when the feature doesn't apply);
   * the group renders its Gap 4c baseline.
   */
  filteredCount?: { total: number; matching: number }
  /**
   * Phase 3 Gap 7 — row-body click → drawer-open trigger. Threaded
   * untouched into each `FieldMappingRow`. Omit when the parent has
   * no drawer host (e.g. legacy fixtures, storybook).
   */
  onRowClick?: (rowId: string) => void
  /**
   * Phase 3 Gap 7 — id of the row whose drawer is currently open.
   * Each `FieldMappingRow` compares its own `row.id` against this and
   * applies the active-row highlight when they match. `null` means no
   * drawer open.
   */
  openRowId?: string | null
  /**
   * Phase 3 Gap 11b — set of row ids highlighted by the source-schema
   * sidebar's click-to-highlight interaction. Each `FieldMappingRow`
   * tests its own `row.id` for membership. `null` means no sidebar
   * highlight is active (treated as the empty set).
   */
  highlightedRowIds?: Set<string> | null
  /**
   * Phase 4c-1 — count of needs-review TFMs in this table that the
   * "Approve all needs-review" kebab item would act on. Derived
   * client-side from already-loaded `data.rows` by the parent
   * (cheap, no extra round-trip). When `0`, the kebab item renders
   * disabled with a "No needs-review mappings" subtitle. When the
   * caller does NOT provide this prop (e.g. legacy fixtures or
   * storybook), the kebab menu is omitted entirely.
   */
  needsReviewCount?: number
  /**
   * Phase 4c-1 — fired when the user clicks "Approve all needs-review"
   * in the kebab menu. Parent (`MappingContent`) owns the dialog state
   * and is responsible for opening `BulkConfirmDialog` with the right
   * scope. The kebab itself only emits the click event; it does NOT
   * gate on `needsReviewCount` (the menu item is disabled at the
   * primitive level, but parents that want to react to a disabled
   * click will see no event by virtue of the underlying button).
   */
  onApproveAllClick?: (targetTableId: string) => void
  /**
   * Phase 4c-2 — fired when the user clicks "Reject all needs-review"
   * in the kebab menu. Same shape + disabled-state contract as
   * `onApproveAllClick`. When omitted the reject menu item is
   * skipped entirely (legacy fixtures / storybook can opt out).
   */
  onRejectAllClick?: (targetTableId: string) => void
  /**
   * Phase 4-polish-2 — group collapsibility (URL-driven).
   *
   * `isCollapsed` reflects the persisted user choice (read from
   * `?collapsed=` via `useCollapsedGroups` in the parent). It does NOT
   * directly control whether rows render — see `isAutoExpanded` below.
   *
   * Default behavior when the prop is omitted (legacy fixtures /
   * storybook): the group renders fully expanded with NO chevron
   * affordance. The toggle UI only surfaces when `onToggleCollapse`
   * is also wired, keeping the kebab-only legacy contract intact.
   */
  isCollapsed?: boolean
  /**
   * Phase 4-polish-2 — set to `true` by `MappingContent` when ANY
   * filter (search, status, confidence, target, source) is non-default.
   * Forces the group expanded regardless of `isCollapsed` so the user
   * never sees zero results for an active filter just because the
   * matching rows live inside a collapsed group. The persisted
   * `?collapsed=` state is preserved (not modified by auto-expand);
   * clearing the filter restores the user's chosen disclosure state.
   */
  isAutoExpanded?: boolean
  /**
   * Phase 4-polish-2 — fired when the user clicks the group header
   * or presses Enter/Space on it. Receives the target-table NAME (not
   * id) because `?collapsed=` persists names for human-readable URLs
   * and stable cross-deploy state (ids may regenerate on schema
   * regeneration; names tend to be stable migration identities).
   *
   * When omitted, the chevron + click affordance are NOT rendered
   * (the group renders as a static disclosure-less header).
   */
  onToggleCollapse?: (tableName: string) => void
  /**
   * Phase 4-polish-3 — page-level source fields universe used by each
   * row's inline source picker. Forwarded untouched. Omit when no
   * inline editing surface is wired (legacy fixtures / storybook).
   */
  availableSourceFields?: SourceFieldWithState[]
  /**
   * Phase 4-polish-3 — row-id-keyed map of in-flight optimistic states
   * (approve / reject / acknowledge / map). The group looks up its own
   * rows in this map and forwards the state to each `FieldMappingRow`
   * via `optimisticState`.
   */
  optimisticStates?: Map<string, FieldMappingRowOptimisticState>
  /**
   * Optimistic-data overrides for the row data shape. Used during
   * reject paths (inline + bulk + drawer) to pre-apply the unmapped
   * shape BEFORE router.refresh() lands, masking the unmount/remount
   * blip when React swaps `tfm-<id>` → `unmapped::<targetFieldId>`.
   * Forwarded untouched to each FieldMappingRow.
   */
  optimisticData?: Map<string, MappingRow>
  /**
   * Lifted per-row chevron-expansion state. When provided, the row
   * reads its expanded flag from this map (keyed by rowId) instead
   * of a local useState — necessary so the state survives the row's
   * unmount/remount cycle when virtualization scrolls it out of and
   * back into view. Optional for backward compat: legacy fixtures
   * and standalone tests that omit this fall back to per-row local
   * state. Owner: MappingContent.
   */
  expandedRowIds?: Map<string, boolean>
  /**
   * Companion setter for `expandedRowIds`. Fired with `(rowId, next)`
   * when the row's chevron is clicked. Required if expandedRowIds is
   * provided; ignored otherwise.
   */
  onExpandedChange?: (rowId: string, next: boolean) => void
  /**
   * Lifted "which row's inline source picker is open" — at most one
   * row at a time. When provided AND `pickerOpenRowId === row.id`,
   * the row renders its picker open. Required to survive virtualizer
   * unmount/remount and to support the cleanup-on-row-dissolve
   * behavior owned by MappingContent.
   */
  pickerOpenRowId?: string | null
  /**
   * Companion setter for `pickerOpenRowId`. Fired with `rowId` to
   * open, `null` to close.
   */
  onPickerOpenChange?: (rowId: string | null) => void
  /**
   * Phase 4-polish-3 — inline action handlers. Forwarded untouched
   * to each row. Each is independently optional so individual call
   * sites can opt out of specific affordances (e.g. read-only
   * fixtures wire neither approve nor reject).
   */
  onInlineApprove?: (rowId: string) => void
  onInlineReject?: (rowId: string, anchorEl: HTMLElement) => void
  onInlineAcknowledge?: (rowId: string) => void
  onInlineUnacknowledge?: (rowId: string) => void
  onInlineSourceCommit?: (
    rowId: string,
    finalSourceFieldIds: string[],
  ) => Promise<{ success: boolean }>
}

export function TargetTableGroup({
  targetTable,
  rows,
  scrollContainerRef,
  filteredCount,
  onRowClick,
  openRowId,
  highlightedRowIds,
  needsReviewCount,
  onApproveAllClick,
  onRejectAllClick,
  isCollapsed = false,
  isAutoExpanded = false,
  onToggleCollapse,
  availableSourceFields,
  optimisticStates,
  optimisticData,
  expandedRowIds,
  onExpandedChange,
  pickerOpenRowId,
  onPickerOpenChange,
  onInlineApprove,
  onInlineReject,
  onInlineAcknowledge,
  onInlineUnacknowledge,
  onInlineSourceCommit,
}: TargetTableGroupProps) {
  const label = resolveFieldCountLabel(targetTable, filteredCount)
  const isFilteredEmpty = filteredCount !== undefined && filteredCount.matching === 0

  // Phase 4c-1 — kebab menu. Only rendered when both the count prop
  // and the click handler are wired (i.e. on the live redesign page;
  // not from legacy fixtures or storybook). Reject handler is
  // optional — when wired it surfaces a second menu item (4c-2).
  const showKebab =
    needsReviewCount !== undefined && onApproveAllClick !== undefined

  // Phase 4-polish-2 — collapsibility. The chevron + click affordance
  // is gated on `onToggleCollapse` being wired (so legacy fixtures /
  // storybook callers that omit it get the prior static-header
  // behaviour). The `isExpanded` boolean is the OR of the user's
  // persisted choice and any auto-expand pressure from active filters.
  const isCollapsible = onToggleCollapse !== undefined
  const isExpanded = !isCollapsed || isAutoExpanded
  const rowsContainerId = `target-table-rows-${targetTable.id}`

  // The toggle handler is only attached when collapsibility is wired.
  // Defining it inline keeps the dependency array trivial; the
  // closure cost is negligible compared to the render-time work
  // per row.
  const handleHeaderClick = () => {
    if (!isCollapsible) return
    onToggleCollapse!(targetTable.name)
  }

  // Keyboard activation — Enter and Space on the header button. Native
  // `<button>` already handles this, but explicit handlers let us
  // surface the same behaviour in tests without relying on the
  // browser's default keyboard-to-click translation.
  const handleHeaderKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isCollapsible) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggleCollapse!(targetTable.name)
    }
  }

  return (
    <section
      aria-label={`Target table ${targetTable.name}`}
      data-testid="target-table-group"
      data-target-table-id={targetTable.id}
      data-collapsed={isCollapsible ? String(!isExpanded) : undefined}
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      {/*
        Refinement A (Phase 4-polish-1 final, 2026-04-26): the dataset
        name subtitle ("Nymbus Core" etc.) was dropped. Every group is
        in the same target dataset, and the page header already
        identifies it ("Mapping | <project> Migration"). The subtitle
        was redundant and read as visual noise stacked under the
        target table name. The header is now single-line.

        Note: `targetTable.datasetName` is still part of the
        `TargetTableSummary` type — it remains accessible in props
        and can surface elsewhere (e.g. multi-dataset projects in
        the future) without being read here.

        Phase 4-polish-2 (2026-04-27): the header became a clickable
        toggle for group collapsibility. The toggle area (chevron +
        name + count) is a single `<button>`; the kebab menu lives
        as a sibling element outside the button so we don't nest
        interactives (HTML invariant). When `onToggleCollapse` is
        omitted (legacy fixtures), we fall back to a non-button
        layout that preserves the prior behaviour.
      */}
      <header className="flex items-stretch border-b border-gray-100 bg-gray-50/50">
        {isCollapsible ? (
          <button
            type="button"
            onClick={handleHeaderClick}
            onKeyDown={handleHeaderKeyDown}
            aria-expanded={isExpanded}
            aria-controls={rowsContainerId}
            aria-label={`Toggle ${targetTable.name} group`}
            data-testid="target-table-group-toggle"
            className={cn(
              'flex flex-1 items-center gap-2 px-5 py-3 text-left',
              'transition-colors hover:bg-gray-100/50',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              data-testid="target-table-group-chevron"
              data-expanded={String(isExpanded)}
              className={cn(
                'h-4 w-4 flex-shrink-0 text-gray-400 transition-transform duration-150 ease-out motion-reduce:transition-none',
                isExpanded && 'rotate-90',
              )}
            />
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
              {targetTable.name}
            </h2>
            <span
              className="flex-shrink-0 text-xs text-gray-500"
              data-testid="target-table-field-count"
            >
              {label}
            </span>
          </button>
        ) : (
          <div className="flex flex-1 items-center gap-3 px-5 py-3">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
              {targetTable.name}
            </h2>
            <span
              className="flex-shrink-0 text-xs text-gray-500"
              data-testid="target-table-field-count"
            >
              {label}
            </span>
          </div>
        )}
        {showKebab ? (
          <div className="flex items-center pr-5">
            <TargetTableKebabMenu
              targetTableId={targetTable.id}
              targetTableName={targetTable.name}
              needsReviewCount={needsReviewCount ?? 0}
              onApproveAllClick={onApproveAllClick!}
              onRejectAllClick={onRejectAllClick}
            />
          </div>
        ) : null}
      </header>

      {/*
        Phase 4-polish-2 — height-transition wrapper for the rows
        container. The `max-h-[10000px]` upper bound is generous enough
        for any realistic group (Mitratech-class enterprise migrations
        cap at hundreds of fields per table; a max-height of 10kpx
        unblocks 200+ rows even at the widest row heights). The
        transition is GPU-friendly and respects prefers-reduced-motion.

        We always render the rows DOM (just clipped when collapsed)
        so the height transition has content to animate to/from.
        Future optimisation: only mount when expanded for very large
        groups — deferred until a profiler call surfaces it.

        When the group is fully un-mounted from disclosure (e.g. the
        legacy non-collapsible variant, or filtered-empty / row-empty
        branches) we skip the wrapper entirely so the static CSS does
        not introduce any visual change for non-collapsible callers.
      */}
      {isFilteredEmpty ? (
        <div
          className="px-5 py-6 text-center text-xs text-gray-400"
          data-testid="target-table-filtered-empty"
        >
          No fields match the current filters.
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-gray-400">
          No fields to display for this table.
        </div>
      ) : (
        <div
          id={rowsContainerId}
          data-testid="target-table-rows-container"
          aria-hidden={isCollapsible ? !isExpanded : undefined}
          className={cn(
            'overflow-hidden',
            isCollapsible &&
              'transition-[max-height] duration-200 ease-out motion-reduce:transition-none',
            isCollapsible
              ? isExpanded
                ? 'max-h-[10000px]'
                : 'max-h-0'
              : '',
          )}
        >
          <ColumnHeaderRow />
          {rows.length < VIRTUALIZATION_THRESHOLD ? (
            <div role="list" className="divide-y divide-gray-100">
              {rows.map((row) => (
                <FieldMappingRow
                  key={row.id}
                  row={row}
                  onRowClick={onRowClick}
                  isActive={openRowId === row.id}
                  isHighlighted={highlightedRowIds?.has(row.id) ?? false}
                  availableSourceFields={availableSourceFields}
                  optimisticState={optimisticStates?.get(row.id)}
                  optimisticData={optimisticData}
                  isExpanded={
                    expandedRowIds !== undefined
                      ? expandedRowIds.get(row.id) ?? false
                      : undefined
                  }
                  onExpandedChange={
                    onExpandedChange !== undefined
                      ? (next) => onExpandedChange(row.id, next)
                      : undefined
                  }
                  isPickerOpen={
                    pickerOpenRowId !== undefined
                      ? pickerOpenRowId === row.id
                      : undefined
                  }
                  onPickerOpenChange={
                    onPickerOpenChange !== undefined
                      ? (next) =>
                          onPickerOpenChange(next ? row.id : null)
                      : undefined
                  }
                  onInlineApprove={onInlineApprove}
                  onInlineReject={onInlineReject}
                  onInlineAcknowledge={onInlineAcknowledge}
                  onInlineUnacknowledge={onInlineUnacknowledge}
                  onSourceCommit={onInlineSourceCommit}
                />
              ))}
            </div>
          ) : (
            <VirtualizedRowList
              rows={rows}
              scrollContainerRef={scrollContainerRef}
              onRowClick={onRowClick}
              openRowId={openRowId}
              highlightedRowIds={highlightedRowIds}
              availableSourceFields={availableSourceFields}
              optimisticStates={optimisticStates}
              optimisticData={optimisticData}
              expandedRowIds={expandedRowIds}
              onExpandedChange={onExpandedChange}
              pickerOpenRowId={pickerOpenRowId}
              onPickerOpenChange={onPickerOpenChange}
              onInlineApprove={onInlineApprove}
              onInlineReject={onInlineReject}
              onInlineAcknowledge={onInlineAcknowledge}
              onInlineUnacknowledge={onInlineUnacknowledge}
              onInlineSourceCommit={onInlineSourceCommit}
            />
          )}
        </div>
      )}
    </section>
  )
}

// ─── Virtualized row list (large-group renderer) ───────────────────────────
//
// Activated when the group has VIRTUALIZATION_THRESHOLD or more rows.
// Uses @tanstack/react-virtual's element-based `useVirtualizer`, with
// `getScrollElement` pointing at the body scroll container threaded
// down from `MappingContent` (the inner `flex-1 overflow-auto` div).
//
// Why not `useWindowVirtualizer`: the page's outer wrapper is
// `min-h-0 flex-1 overflow-hidden`, so the window itself does not
// scroll — only the inner body div does. A window-scoped virtualizer
// listens to window scroll events that never fire and computes the
// visible range against `window.innerHeight`, leaving everything past
// the first viewport's worth of rows unrendered (PR 111 fix).
//
// `scrollMargin` is the offset of the virtualized list within the
// scroll container. We rely on `MappingContent` having added
// `position: relative` to the scroll container so that
// `parentRef.current.offsetTop` resolves to the scroll container's
// coordinate space (every intermediate ancestor is statically
// positioned). The virtualizer measures each row via `measureElement`
// once it attaches its forwardRef'd outer div, so chevron-expansion
// height changes are observed automatically (no manual size table).
//
// Each visible row renders inside an absolute-positioned wrapper at
// `translateY(virtualItem.start - virtualizer.options.scrollMargin)`.
//
// Backwards-compat note: legacy callers that DON'T pass expandedRowIds
// / pickerOpenRowId fall back to per-row local state inside
// FieldMappingRow. With virtualization those local states would be
// lost on row remount; in practice the live MappingContent always
// passes the lifted state, so this is only a concern for storybook /
// test fixtures that opt into virtualization without lifting.

interface VirtualizedRowListProps {
  rows: MappingRow[]
  scrollContainerRef: TargetTableGroupProps['scrollContainerRef']
  onRowClick: TargetTableGroupProps['onRowClick']
  openRowId: TargetTableGroupProps['openRowId']
  highlightedRowIds: TargetTableGroupProps['highlightedRowIds']
  availableSourceFields: TargetTableGroupProps['availableSourceFields']
  optimisticStates: TargetTableGroupProps['optimisticStates']
  optimisticData: TargetTableGroupProps['optimisticData']
  expandedRowIds: TargetTableGroupProps['expandedRowIds']
  onExpandedChange: TargetTableGroupProps['onExpandedChange']
  pickerOpenRowId: TargetTableGroupProps['pickerOpenRowId']
  onPickerOpenChange: TargetTableGroupProps['onPickerOpenChange']
  onInlineApprove: TargetTableGroupProps['onInlineApprove']
  onInlineReject: TargetTableGroupProps['onInlineReject']
  onInlineAcknowledge: TargetTableGroupProps['onInlineAcknowledge']
  onInlineUnacknowledge: TargetTableGroupProps['onInlineUnacknowledge']
  onInlineSourceCommit: TargetTableGroupProps['onInlineSourceCommit']
}

function VirtualizedRowList({
  rows,
  scrollContainerRef,
  onRowClick,
  openRowId,
  highlightedRowIds,
  availableSourceFields,
  optimisticStates,
  optimisticData,
  expandedRowIds,
  onExpandedChange,
  pickerOpenRowId,
  onPickerOpenChange,
  onInlineApprove,
  onInlineReject,
  onInlineAcknowledge,
  onInlineUnacknowledge,
  onInlineSourceCommit,
}: VirtualizedRowListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef?.current ?? null,
    estimateSize: () => 40,
    overscan: 8,
    scrollMargin: parentRef.current?.offsetTop ?? 0,
  })

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      ref={parentRef}
      role="list"
      data-testid="target-table-virtualized-rows"
      style={{
        position: 'relative',
        height: virtualizer.getTotalSize(),
        width: '100%',
      }}
    >
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index]
        if (!row) return null
        return (
          <div
            key={row.id}
            data-virtual-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${
                virtualItem.start - virtualizer.options.scrollMargin
              }px)`,
            }}
          >
            <FieldMappingRow
              row={row}
              dataIndex={virtualItem.index}
              onRowClick={onRowClick}
              isActive={openRowId === row.id}
              isHighlighted={highlightedRowIds?.has(row.id) ?? false}
              availableSourceFields={availableSourceFields}
              optimisticState={optimisticStates?.get(row.id)}
              optimisticData={optimisticData}
              isExpanded={
                expandedRowIds !== undefined
                  ? expandedRowIds.get(row.id) ?? false
                  : undefined
              }
              onExpandedChange={
                onExpandedChange !== undefined
                  ? (next) => onExpandedChange(row.id, next)
                  : undefined
              }
              isPickerOpen={
                pickerOpenRowId !== undefined
                  ? pickerOpenRowId === row.id
                  : undefined
              }
              onPickerOpenChange={
                onPickerOpenChange !== undefined
                  ? (next) =>
                      onPickerOpenChange(next ? row.id : null)
                  : undefined
              }
              onInlineApprove={onInlineApprove}
              onInlineReject={onInlineReject}
              onInlineAcknowledge={onInlineAcknowledge}
              onInlineUnacknowledge={onInlineUnacknowledge}
              onSourceCommit={onInlineSourceCommit}
            />
          </div>
        )
      })}
    </div>
  )
}

// ─── Column header row (Phase 4-polish-1 comprehensive pass) ────────────────
//
// Legacy parity strip: the previous mapping page rendered three column
// labels ("Source Field", "Conf.", "Target Field") inside each table
// group's expanded body, between the group header and the first row
// (legacy `MappingContent.tsx` lines 1587-1593). The redesign dropped
// these in Gap 4c; this pass restores them.
//
// Architecture: the header reuses the EXACT grid template literal from
// `FieldMappingRow.tsx` so columns align byte-for-byte. The
// column-header invariant test in `tests/components/target-table-
// group.test.tsx` mirrors the row's column-template invariant — if a
// future refactor changes the row template, the header must update too
// or CI fails.
//
// Refinement E (Phase 4-polish-1 final, 2026-04-26): the prior unified
// "Source Field" header that spanned cols 2-3 (`col-start-2 col-end-4`)
// SPLIT into two single-cell headers — "Source Table" (col 2) and
// "Source Field" (col 3). Canary review found the unified header read
// as describing only col 3 (the field name); col 2 (the table badges)
// felt header-less. The visual separation between the two columns is
// real even after Refinement 4's tightening, and the split header
// matches that reality.
//
// Refinement G (Phase 4-polish-1 final, 2026-04-26): the row template
// dropped its trailing `1rem` chevron column when the row-end chevron
// was relocated inline next to source field names (multi-source rows
// only). The header strip mirrors that 5-column template byte-for-
// byte; the prior `<span aria-hidden />` for col 6 is gone.
//
// Label placement (vs. the 5-col grid):
//   • col 1 (status dot)   — empty (`<span aria-hidden />`)
//   • col 2 (source table) — "Source Table" (left-aligned)
//   • col 3 (source field) — "Source Field" (left-aligned)
//   • col 4 (target field) — "Target Field" (left-aligned)
//   • col 5 (confidence)   — "Conf." (right-aligned to match
//     ConfidenceCell content alignment)
//
// A11y: `aria-hidden="true"` on the container — each FieldMappingRow
// already carries a self-contained `aria-label` covering target /
// source / status / confidence; the visual header is purely a sighted-
// user navigation aid. Full ARIA grid semantics (role="grid",
// role="columnheader") would require restructuring `role="list"` →
// `role="grid"` everywhere, which is a separate A11y polish.
//
// Visibility: only rendered in the populated branch (rows.length > 0,
// not filtered-empty). When the group has no rendered rows, the
// header would be a confusing label without content.
//
// Classes mirror the legacy strip lines 1588-1591 verbatim:
//   text-xs font-medium text-gray-500
//   bg-settle-slate-50 border-b border-settle-slate-100 px-5 py-2

function ColumnHeaderRow() {
  return (
    <div
      role="row"
      aria-hidden="true"
      data-testid="target-table-column-headers"
      className="grid grid-cols-[0.75rem_minmax(8rem,1fr)_minmax(10rem,1.5fr)_minmax(12rem,2fr)_5rem_5rem] items-center gap-3 border-b border-settle-slate-100 bg-settle-slate-50 px-5 py-2"
    >
      <span aria-hidden="true" />
      <div
        className="text-xs font-medium text-gray-500"
        data-testid="target-table-column-header-source-table"
      >
        Source Table
      </div>
      <div
        className="text-xs font-medium text-gray-500"
        data-testid="target-table-column-header-source-field"
      >
        Source Field
      </div>
      <div
        className="text-xs font-medium text-gray-500"
        data-testid="target-table-column-header-target-field"
      >
        Target Field
      </div>
      <div
        className="text-right text-xs font-medium text-gray-500"
        data-testid="target-table-column-header-confidence"
      >
        Conf.
      </div>
      {/*
        Phase 4-polish-3 — col 6 hosts the inline action buttons in
        the row template. The header strip leaves it as quiet
        whitespace (no label) so the column reads as a hover-revealed
        gutter rather than a labelled column. Buttons themselves
        carry tooltips + aria-labels per row.
      */}
      <span aria-hidden="true" />
    </div>
  )
}

// ─── Kebab menu (Phase 4c-1, extended in 4c-2) ───────────────────────────────
//
// Lightweight inline popover. The codebase has no shadcn `DropdownMenu`
// primitive (intentional — see `components/ui/`), so this is a bespoke
// click-outside-closing menu. Two items in 4c-2:
//
//   1. "Approve all needs-review" — primary, gray text.
//   2. "Reject all needs-review"  — destructive, red text. Separator
//      above. Optional via `onRejectAllClick` so legacy fixtures /
//      storybook callers can opt out.
//
// Disabled-state subtitle ("No needs-review mappings") applies to BOTH
// items uniformly when `needsReviewCount === 0`.

function TargetTableKebabMenu({
  targetTableId,
  targetTableName,
  needsReviewCount,
  onApproveAllClick,
  onRejectAllClick,
}: {
  targetTableId: string
  targetTableName: string
  needsReviewCount: number
  onApproveAllClick: (targetTableId: string) => void
  onRejectAllClick?: (targetTableId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Click-outside + Escape close. Only registered while open.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isDisabled = needsReviewCount === 0
  return (
    <div
      ref={wrapperRef}
      className="relative flex-shrink-0"
      data-testid="target-table-kebab"
      data-target-table-id={targetTableId}
    >
      <button
        type="button"
        aria-label={`Bulk actions for ${targetTableName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        data-testid="target-table-kebab-trigger"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={`Bulk actions for ${targetTableName}`}
          className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg"
          data-testid="target-table-kebab-menu"
        >
          <button
            type="button"
            role="menuitem"
            disabled={isDisabled}
            onClick={() => {
              if (isDisabled) return
              setOpen(false)
              onApproveAllClick(targetTableId)
            }}
            className={
              isDisabled
                ? 'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm text-gray-400 cursor-not-allowed'
                : 'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none cursor-pointer'
            }
            data-testid="target-table-kebab-approve-all"
          >
            <span className="font-medium">Approve all needs-review</span>
            <span className="text-xs text-gray-500">
              {isDisabled
                ? 'No needs-review mappings'
                : `${needsReviewCount} mapping${needsReviewCount === 1 ? '' : 's'} pending`}
            </span>
          </button>
          {/* Phase 4c-2 — Reject all needs-review. Visual treatment:
              red text for the destructive verb, separator above,
              same disabled contract as approve. */}
          {onRejectAllClick !== undefined ? (
            <>
              <div
                className="border-t border-gray-100"
                data-testid="target-table-kebab-separator"
              />
              <button
                type="button"
                role="menuitem"
                disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return
                  setOpen(false)
                  onRejectAllClick(targetTableId)
                }}
                className={
                  isDisabled
                    ? 'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm text-gray-400 cursor-not-allowed'
                    : 'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none cursor-pointer'
                }
                data-testid="target-table-kebab-reject-all"
              >
                <span className="font-medium">Reject all needs-review</span>
                <span
                  className={
                    isDisabled ? 'text-xs text-gray-500' : 'text-xs text-red-500/80'
                  }
                >
                  {isDisabled
                    ? 'No needs-review mappings'
                    : `${needsReviewCount} mapping${needsReviewCount === 1 ? '' : 's'} will be deleted`}
                </span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ─── Label resolver ──────────────────────────────────────────────────────────

function resolveFieldCountLabel(
  summary: TargetTableSummary,
  filtered: { total: number; matching: number } | undefined,
): string {
  // When filters are active AND narrow the group, show "X of Y fields".
  if (filtered !== undefined && filtered.matching !== filtered.total) {
    return `${filtered.matching} of ${filtered.total} fields`
  }
  // Otherwise fall through to the unfiltered Gap 4c label.
  const total = filtered?.total ?? summary.fieldCount
  return `${total} ${total === 1 ? 'field' : 'fields'}`
}
