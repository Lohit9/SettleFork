import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MappingProjectStatsRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingProjectStatsRow'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// PR-3 (feat/inner-page-stats-redesign) — MappingProjectStatsRow tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the contract for the new project-WIDE stats row that renders ABOVE
// `MappingSummaryStrip` on the redesigned Mapping page. Q3 from PR-3 Stop 1:
// project-wide above grid-level; both render simultaneously when the
// toolbar is shown — they answer different questions, both useful.
//
// State-aware empty (Q4): a single state label replaces the stat row
// when state ≠ 'mappings_generated', matching the tile badge wording
// from PR-2 for visual continuity.

function projectStats(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    state: 'mappings_generated',
    target: { approved: 52, total: 68, unmapped: 16 },
    source: { decided: 57, total: 70 },
    transforms: { complete: 15, total: 51 },
    blocking: 0,
    ...overrides,
  }
}

describe('MappingProjectStatsRow — populated state', () => {
  it('renders all 3 axes when state === mappings_generated', () => {
    render(<MappingProjectStatsRow projectStats={projectStats()} />)
    expect(screen.getByTestId('project-stat-target')).toHaveTextContent('Mapped: 52/68 fields')
    expect(screen.getByTestId('project-stat-source')).toHaveTextContent('Sources: 57/70')
    expect(screen.getByTestId('project-stat-transforms')).toHaveTextContent('Transforms: 15/51')
  })

  it('exposes data-state="mappings_generated" on the row root', () => {
    const { container } = render(<MappingProjectStatsRow projectStats={projectStats()} />)
    expect(container.firstChild).toHaveAttribute('data-state', 'mappings_generated')
  })

  it('does NOT render the empty-state label when populated', () => {
    render(<MappingProjectStatsRow projectStats={projectStats()} />)
    expect(screen.queryByTestId('project-stats-empty-label')).not.toBeInTheDocument()
  })
})

describe('MappingProjectStatsRow — state-aware empty (Q4)', () => {
  it('renders "Awaiting data ingestion" label for awaiting_data', () => {
    render(
      <MappingProjectStatsRow
        projectStats={projectStats({
          state: 'awaiting_data',
          target: { approved: 0, total: 0, unmapped: 0 },
          source: { decided: 0, total: 0 },
          transforms: { complete: 0, total: 0 },
        })}
      />,
    )
    expect(screen.getByTestId('project-stats-empty-label')).toHaveTextContent(
      'Awaiting data ingestion',
    )
    expect(screen.queryByTestId('project-stat-target')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-stat-source')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-stat-transforms')).not.toBeInTheDocument()
  })

  it('renders "Data ingested" label for data_ingested', () => {
    render(
      <MappingProjectStatsRow
        projectStats={projectStats({
          state: 'data_ingested',
          target: { approved: 0, total: 68, unmapped: 68 },
          source: { decided: 0, total: 70 },
          transforms: { complete: 0, total: 0 },
        })}
      />,
    )
    expect(screen.getByTestId('project-stats-empty-label')).toHaveTextContent('Data ingested')
  })

  it('falls back to awaiting_data when projectStats is null (Q5 defensive)', () => {
    render(<MappingProjectStatsRow projectStats={null} />)
    expect(screen.getByTestId('project-stats-empty-label')).toHaveTextContent(
      'Awaiting data ingestion',
    )
  })
})

describe('MappingProjectStatsRow — Q2 transforms numerator (saved + applied)', () => {
  it('renders projectStats.transforms.complete (NOT a derivative of legacy applied-only)', () => {
    // Differential check: a fixture where complete=15 (saved+applied per Q2)
    // would diverge from a hypothetical applied-only display. We verify the
    // visible string is `15/51` and explicitly NOT `2/51` — which would
    // appear if a future regression rebound to a legacy field.
    render(
      <MappingProjectStatsRow
        projectStats={projectStats({ transforms: { complete: 15, total: 51 } })}
      />,
    )
    expect(screen.getByTestId('project-stat-transforms')).toHaveTextContent('Transforms: 15/51')
    expect(screen.getByTestId('project-stat-transforms')).not.toHaveTextContent('Transforms: 2/51')
  })
})
