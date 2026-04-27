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
//   • monochrome pill (slate-100 background, slate-700 text)
//   • truncating max-width so long table names do not break row layout
//   • optional dataset subtitle renders as a secondary line ONLY when the
//     caller has a dataset worth surfacing (filter dropdown, not the row)
//
// Light-mode-only (Gap 5a hotfix 2026-04-23): deliberately no dark-prefix
// Tailwind modifiers. See `FieldMappingRow.tsx` file header for the full
// rationale. The grep invariant at
// `tests/lib/no-shim-in-redesign-path.test.ts` enforces this at CI time.

// Q11.G lock (drawer redesign): support a compact `'sm'` variant for the
// drawer header line 1, while keeping `'md'` (the existing visual) as the
// default for every existing call site. Adding `size?: 'sm' | 'md'` is a
// purely additive prop — no current caller passes `size`, so all rows,
// filters, and previews keep their current chrome unchanged.
type TableBadgeSize = 'sm' | 'md'

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
  /**
   * Visual size variant.
   *   • `'md'` (default): the established 11px row/filter chrome.
   *   • `'sm'`: a tighter 10px chrome used by the redesign drawer header
   *     line 1 where two badges + two field names + a close button must
   *     coexist on a single 480px row.
   */
  size?: TableBadgeSize
  /** Optional Tailwind class overrides (e.g. sizing inside a tight cell). */
  className?: string
}

const SIZE_CLASSES: Record<TableBadgeSize, { container: string; primary: string; secondary: string }> = {
  md: {
    container: 'max-w-[14rem] px-1.5 py-0.5 text-[11px]',
    primary: 'leading-tight',
    secondary: 'text-[10px]',
  },
  sm: {
    container: 'max-w-[10rem] px-1 py-0 text-[10px]',
    primary: 'leading-none',
    secondary: 'text-[9px]',
  },
}

export function TableBadge({ tableName, datasetName, size = 'md', className }: TableBadgeProps) {
  const sizeClasses = SIZE_CLASSES[size]
  return (
    <span
      className={cn(
        'inline-flex flex-col items-start rounded-md bg-slate-100 align-middle font-medium text-slate-700',
        sizeClasses.container,
        className,
      )}
      // Title attribute provides the non-truncated name on hover; the
      // visible text node always truncates to keep rows single-line.
      title={datasetName ? `${tableName} · ${datasetName}` : tableName}
    >
      <span className={cn('block w-full truncate font-mono', sizeClasses.primary)}>{tableName}</span>
      {datasetName ? (
        <span className={cn('block w-full truncate font-normal text-slate-500', sizeClasses.secondary)}>
          {datasetName}
        </span>
      ) : null}
    </span>
  )
}
