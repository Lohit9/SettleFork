'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  MappingRow,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import { FieldMappingRow } from './FieldMappingRow'
import { MoreHorizontal } from '@/components/icons'

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
}

export function TargetTableGroup({
  targetTable,
  rows,
  filteredCount,
  onRowClick,
  openRowId,
  highlightedRowIds,
  needsReviewCount,
  onApproveAllClick,
  onRejectAllClick,
}: TargetTableGroupProps) {
  const label = resolveFieldCountLabel(targetTable, filteredCount)
  const isFilteredEmpty = filteredCount !== undefined && filteredCount.matching === 0

  // Phase 4c-1 — kebab menu. Only rendered when both the count prop
  // and the click handler are wired (i.e. on the live redesign page;
  // not from legacy fixtures or storybook). Reject handler is
  // optional — when wired it surfaces a second menu item (4c-2).
  const showKebab =
    needsReviewCount !== undefined && onApproveAllClick !== undefined

  return (
    <section
      aria-label={`Target table ${targetTable.name}`}
      data-testid="target-table-group"
      data-target-table-id={targetTable.id}
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-100 bg-gray-50/50 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-gray-900">
            {targetTable.name}
          </h2>
          {targetTable.datasetName ? (
            <p className="truncate text-xs text-gray-400">
              {targetTable.datasetName}
            </p>
          ) : null}
        </div>
        <span
          className="flex-shrink-0 text-xs text-gray-500"
          data-testid="target-table-field-count"
        >
          {label}
        </span>
        {showKebab ? (
          <TargetTableKebabMenu
            targetTableId={targetTable.id}
            targetTableName={targetTable.name}
            needsReviewCount={needsReviewCount ?? 0}
            onApproveAllClick={onApproveAllClick!}
            onRejectAllClick={onRejectAllClick}
          />
        ) : null}
      </header>

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
        <div role="list" className="divide-y divide-gray-100">
          {rows.map((row) => (
            <FieldMappingRow
              key={row.id}
              row={row}
              onRowClick={onRowClick}
              isActive={openRowId === row.id}
              isHighlighted={highlightedRowIds?.has(row.id) ?? false}
            />
          ))}
        </div>
      )}
    </section>
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
