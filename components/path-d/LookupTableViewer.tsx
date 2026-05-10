import { cn } from '@/components/ui/utils'
import { AlertTriangle } from '@/components/icons'
import type { ProjectLookupTableRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// LookupTableViewer — Path D primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Read-only display of one project_lookup_tables row (migration 093:183-196):
//
//   • header — name, description, customer_approved badge
//   • two-column table — source value → target value, sorted by source value
//   • inline DQ warning chip per source value present in data_quality_notes
//
// data_quality_notes is keyed by source value (per the canonical
// {"<source_value>": "<note>"} shape implied by migration 093:200-202).
// Notes render as an amber chip beneath the matching row's source cell;
// rows without a note are unmarked.
//
// Empty mappings → empty-state message. Lookup tables with zero entries
// can exist transiently while Phase B is still proposing values.

interface LookupTableViewerProps {
  lookup: ProjectLookupTableRow
  className?: string
}

export function LookupTableViewer({
  lookup,
  className,
}: LookupTableViewerProps) {
  const entries = Object.entries(lookup.mappings).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const notes = lookup.data_quality_notes ?? {}

  return (
    <section
      data-testid='lookup-table-viewer'
      className={cn(
        'flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
        className,
      )}
    >
      {/* Header */}
      <header className='flex items-start justify-between gap-3'>
        <div className='flex flex-col gap-1 min-w-0'>
          <h3 className='text-base font-semibold text-slate-900 leading-tight'>
            {lookup.name}
          </h3>
          {lookup.description ? (
            <p className='text-sm text-slate-600 leading-relaxed'>
              {lookup.description}
            </p>
          ) : null}
        </div>
        <span
          data-testid='approval-badge'
          className={cn(
            'shrink-0 inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
            lookup.customer_approved
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-amber-50 text-amber-800 border-amber-200',
          )}
        >
          {lookup.customer_approved ? 'Approved' : 'Pending review'}
        </span>
      </header>

      {/* Mappings table */}
      {entries.length === 0 ? (
        <p className='text-sm text-slate-500 italic'>
          No values mapped yet.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='border-b border-slate-200'>
                <th className='py-2 pr-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500'>
                  Source value
                </th>
                <th className='py-2 pl-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500'>
                  Target value
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([sourceValue, targetValue]) => {
                const note = notes[sourceValue]
                return (
                  <tr
                    key={sourceValue}
                    className='border-b border-slate-100 last:border-b-0'
                  >
                    <td className='py-2 pr-4 align-top'>
                      <div className='flex flex-col gap-1.5'>
                        <code className='font-mono text-slate-800'>
                          {sourceValue}
                        </code>
                        {note ? (
                          <span
                            data-testid='dq-note'
                            data-source-value={sourceValue}
                            className='inline-flex items-start gap-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 w-fit'
                          >
                            <AlertTriangle className='size-3 mt-0.5 shrink-0' />
                            <span>{note}</span>
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className='py-2 pl-4 align-top font-mono text-slate-800'>
                      {targetValue}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
