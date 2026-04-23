import type {
  MappingRow,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import { FieldMappingRow } from './FieldMappingRow'

// ─────────────────────────────────────────────────────────────────────────────
// TargetTableGroup — Phase 3 Gap 4c.
// ─────────────────────────────────────────────────────────────────────────────
//
// One target table's worth of mapping rows, under a shared header. The spec
// (docs/features/mapping-redesign.md §Information architecture) replaces the
// legacy `source → target` pair in group headers with a single target-table
// identity; cross-table sources surface on individual rows via TableBadge.
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
}

export function TargetTableGroup({ targetTable, rows }: TargetTableGroupProps) {
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
        <span className="flex-shrink-0 text-xs text-gray-500" data-testid="target-table-field-count">
          {targetTable.fieldCount} {targetTable.fieldCount === 1 ? 'field' : 'fields'}
        </span>
      </header>

      {rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-gray-400">
          No fields to display for this table.
        </div>
      ) : (
        <div role="list" className="divide-y divide-gray-100">
          {rows.map((row) => (
            <FieldMappingRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </section>
  )
}
