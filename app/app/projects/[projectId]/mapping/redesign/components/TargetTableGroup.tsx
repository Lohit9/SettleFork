import type {
  MappingRow,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import { FieldMappingRow } from './FieldMappingRow'

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
}

export function TargetTableGroup({
  targetTable,
  rows,
  filteredCount,
  onRowClick,
  openRowId,
}: TargetTableGroupProps) {
  const label = resolveFieldCountLabel(targetTable, filteredCount)
  const isFilteredEmpty = filteredCount !== undefined && filteredCount.matching === 0

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
            />
          ))}
        </div>
      )}
    </section>
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
