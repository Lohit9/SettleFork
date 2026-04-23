import { cn } from '@/components/ui/utils'

// ─────────────────────────────────────────────────────────────────────────────
// TableBadge — Phase 3 foundation primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Used to render a source-table identifier inline inside a mapping row. The
// redesign spec leans on this primitive for Rules 2-4 (multi-source, single
// or cross-table mappings) where the row prefixes the contributing fields
// with `[TABLE_NAME]`. See `docs/features/mapping-redesign.md` §Row design
// lines ~695-784.
//
// Gap 4c does NOT yet consume this badge in a row — Rules 1-6 are deferred
// to Gap 5. The primitive is introduced early so we have a single canonical
// home for table-name chip rendering; Gap 5 will consume it without a second
// design round.
//
// Visual:
//   • monochrome pill (slate-100 / slate-800 dark)
//   • truncating max-width so long table names do not break row layout
//   • optional dataset subtitle renders as a secondary line ONLY when the
//     caller has a dataset worth surfacing (filter dropdown, not the row)

interface TableBadgeProps {
  /** Table name to display. Required. */
  tableName: string
  /**
   * Optional dataset name, rendered below the table name in a muted
   * subtitle. Intended for filter dropdowns where disambiguating
   * two tables with the same name across datasets matters.
   * Omitted inside row chrome.
   */
  datasetName?: string
  /** Optional Tailwind class overrides (e.g. sizing inside a tight cell). */
  className?: string
}

export function TableBadge({ tableName, datasetName, className }: TableBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-[14rem] flex-col items-start rounded-md bg-slate-100 px-1.5 py-0.5 align-middle text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200',
        className,
      )}
      // Title attribute provides the non-truncated name on hover; the
      // visible text node always truncates to keep rows single-line.
      title={datasetName ? `${tableName} · ${datasetName}` : tableName}
    >
      <span className="block w-full truncate font-mono leading-tight">{tableName}</span>
      {datasetName ? (
        <span className="block w-full truncate text-[10px] font-normal text-slate-500 dark:text-slate-400">
          {datasetName}
        </span>
      ) : null}
    </span>
  )
}
