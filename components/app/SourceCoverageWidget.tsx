import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// SourceCoverageWidget — PR-3 of the stats redesign.
// ─────────────────────────────────────────────────────────────────────────────
//
// 5th Card in the Migration Center widget grid (`OutputsContent.tsx`),
// surfacing the source axis for the first time on MC. Reads
// `projectStats.source` (PR-1's canonical helper output): decided =
// |mapped ∪ acknowledged| (distinct source_field_ids).
//
// Style mirrors the existing 4 inline widgets in `OutputsContent.tsx` lines
// 926-1038: `<div class="rounded-lg border border-gray-100 bg-white p-4 ...">`,
// title, big numerator + small denominator, optional secondary text, thin
// progress bar, footer link. Co-located in `components/app/` (sibling to
// `ProjectStateBadge` / `BlockingPill` from PR-2).
//
// State-aware empty (Q4): when `projectStats.state !== 'mappings_generated'`,
// the numeric stat is replaced by a state label matching the tile badge
// wording from PR-2 ("Awaiting data ingestion" / "Data ingested"). Card
// height is preserved — no layout shift between states.
//
// Defensive null fallback (Q5): `projectStats === null` (shouldn't happen
// post-PR-1; guard for data-layer regressions) renders the
// `awaiting_data` empty state.

interface SourceCoverageWidgetProps {
  /** The full ProjectStats from `OutputsPageData.projectStats`. Pass null
   *  for the defensive fallback (renders awaiting_data styling). */
  projectStats: ProjectStats | null
  /** Project id for the footer link. */
  projectId: string
}

const STATE_LABEL: Record<ProjectStats['state'], string> = {
  awaiting_data: 'Awaiting data ingestion',
  data_ingested: 'Data ingested',
  mappings_generated: '',
}

export function SourceCoverageWidget({
  projectStats,
  projectId,
}: SourceCoverageWidgetProps) {
  const state = projectStats?.state ?? 'awaiting_data'
  const decided = projectStats?.source.decided ?? 0
  const total = projectStats?.source.total ?? 0
  const undecided = total - decided
  const pct = total > 0 ? Math.round((decided / total) * 100) : 0
  const isPopulated = state === 'mappings_generated'

  return (
    <div
      data-testid='source-coverage-widget'
      data-state={state}
      className='rounded-lg border border-gray-100 bg-white p-4 flex flex-col justify-between gap-3'
    >
      <div>
        <p className='text-xs text-gray-500 mb-2'>Source Coverage</p>
        {isPopulated ? (
          <>
            <div className='flex items-baseline gap-1'>
              <span
                data-testid='source-decided'
                className='text-2xl font-semibold text-settle-slate-900'
              >
                {decided}
              </span>
              <span className='text-sm text-settle-slate-400'>/ {total}</span>
            </div>
            {undecided > 0 ? (
              <p className='text-xs text-settle-slate-400 mt-1'>{undecided} undecided</p>
            ) : (
              <p className='text-xs text-green-600 mt-1'>All sources decided</p>
            )}
            {total > 0 && (
              <div className='mt-2 h-0.5 bg-settle-slate-100 rounded-full overflow-hidden'>
                <div
                  className='h-full bg-settle-slate-400 rounded-full'
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </>
        ) : (
          <p
            data-testid='source-coverage-empty-label'
            className='text-sm text-settle-slate-400 mt-1'
          >
            {STATE_LABEL[state]}
          </p>
        )}
      </div>
      <div className='border-t border-settle-slate-100 pt-2.5'>
        <a
          href={`/app/projects/${projectId}/mapping`}
          className='text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors inline-flex items-center gap-1'
        >
          Go to Mapping
          <svg
            width='10'
            height='10'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2.5'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <line x1='5' y1='12' x2='19' y2='12' />
            <polyline points='12 5 19 12 12 19' />
          </svg>
        </a>
      </div>
    </div>
  )
}
