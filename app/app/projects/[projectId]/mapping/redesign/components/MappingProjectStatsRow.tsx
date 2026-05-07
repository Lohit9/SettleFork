import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// MappingProjectStatsRow — PR-3 of the stats redesign.
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders project-WIDE stats above the existing `MappingSummaryStrip`
// (which carries grid-LEVEL chips). The two surfaces answer different
// questions:
//
//   Project-wide row (this component):  "What's the project-level truth?"
//                                       (target, source, transforms axes)
//   Grid-level strip (sibling):         "What's in the visible grid right
//                                       now after filters?"
//
// Both render simultaneously when the strip is shown — they're not
// alternatives. Brief (PR-3 Stop 1 Q3) calls for project-wide row above
// strip, no replacement.
//
// State-aware empty (Q4): when state ≠ 'mappings_generated', a single
// state label replaces the stat row — same wording as PR-2's tile badge
// for visual continuity:
//
//   awaiting_data   → "Awaiting data ingestion"
//   data_ingested   → "Data ingested"
//
// Defensive null fallback (Q5): `projectStats === null` (shouldn't happen
// post-PR-1) renders the awaiting_data empty state.
//
// Q2 transforms numerator note: `transforms.complete` is saved+applied
// (PR-1 redefinition). User-visible numeric jump on MC + Mapping page;
// disclosed in commit body + PR description.

interface MappingProjectStatsRowProps {
  projectStats: ProjectStats | null
}

const STATE_LABEL: Record<ProjectStats['state'], string> = {
  awaiting_data: 'Awaiting data ingestion',
  data_ingested: 'Data ingested',
  mappings_generated: '',
}

export function MappingProjectStatsRow({ projectStats }: MappingProjectStatsRowProps) {
  const state = projectStats?.state ?? 'awaiting_data'
  const isPopulated = state === 'mappings_generated' && projectStats !== null

  if (!isPopulated || !projectStats) {
    return (
      <div
        data-testid='mapping-project-stats-row'
        data-state={state}
        className='flex items-center px-4 py-2 border-b border-slate-100 bg-slate-50'
      >
        <span data-testid='project-stats-empty-label' className='text-xs text-slate-500'>
          {STATE_LABEL[state]}
        </span>
      </div>
    )
  }

  const { target, source, transforms } = projectStats
  return (
    <div
      data-testid='mapping-project-stats-row'
      data-state={state}
      className='flex items-center gap-4 px-4 py-2 border-b border-slate-100 bg-slate-50'
    >
      <span className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
        Project
      </span>
      <span data-testid='project-stat-target' className='text-xs text-slate-700'>
        Mapped:{' '}
        <span className='font-medium text-slate-900'>
          {target.approved}/{target.total}
        </span>{' '}
        fields
      </span>
      <span className='text-slate-300'>·</span>
      <span data-testid='project-stat-source' className='text-xs text-slate-700'>
        Sources:{' '}
        <span className='font-medium text-slate-900'>
          {source.decided}/{source.total}
        </span>
      </span>
      <span className='text-slate-300'>·</span>
      <span data-testid='project-stat-transforms' className='text-xs text-slate-700'>
        Transforms:{' '}
        <span className='font-medium text-slate-900'>
          {transforms.complete}/{transforms.total}
        </span>
      </span>
    </div>
  )
}
