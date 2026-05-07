import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceCoverageWidget } from '@/components/app/SourceCoverageWidget'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// PR-3 (feat/inner-page-stats-redesign) — SourceCoverageWidget tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the contract for the new 5th Migration Center widget. The widget
// surfaces the source axis (`projectStats.source.decided / total`) for the
// first time on MC. State-aware empty (Q4) renders a state label matching
// the PR-2 tile badge wording when state ≠ 'mappings_generated'.

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

describe('SourceCoverageWidget — populated state', () => {
  it('renders source.decided and source.total when state === mappings_generated', () => {
    render(<SourceCoverageWidget projectStats={projectStats()} projectId='proj-1' />)
    expect(screen.getByTestId('source-decided')).toHaveTextContent('57')
    expect(screen.getByText('/ 70')).toBeInTheDocument()
  })

  it('renders "X undecided" secondary text when undecided > 0', () => {
    render(
      <SourceCoverageWidget
        projectStats={projectStats({ source: { decided: 57, total: 70 } })}
        projectId='proj-1'
      />,
    )
    expect(screen.getByText('13 undecided')).toBeInTheDocument()
  })

  it('renders "All sources decided" secondary text when undecided === 0', () => {
    render(
      <SourceCoverageWidget
        projectStats={projectStats({ source: { decided: 70, total: 70 } })}
        projectId='proj-1'
      />,
    )
    expect(screen.getByText('All sources decided')).toBeInTheDocument()
  })
})

describe('SourceCoverageWidget — state-aware empty (Q4)', () => {
  it('renders "Awaiting data ingestion" label for awaiting_data state', () => {
    render(
      <SourceCoverageWidget
        projectStats={projectStats({
          state: 'awaiting_data',
          target: { approved: 0, total: 0, unmapped: 0 },
          source: { decided: 0, total: 0 },
        })}
        projectId='proj-1'
      />,
    )
    expect(screen.getByTestId('source-coverage-empty-label')).toHaveTextContent(
      'Awaiting data ingestion',
    )
    // Numeric stat suppressed in empty state.
    expect(screen.queryByTestId('source-decided')).not.toBeInTheDocument()
  })

  it('renders "Data ingested" label for data_ingested state', () => {
    render(
      <SourceCoverageWidget
        projectStats={projectStats({
          state: 'data_ingested',
          target: { approved: 0, total: 68, unmapped: 68 },
          source: { decided: 0, total: 70 },
        })}
        projectId='proj-1'
      />,
    )
    expect(screen.getByTestId('source-coverage-empty-label')).toHaveTextContent('Data ingested')
    expect(screen.queryByTestId('source-decided')).not.toBeInTheDocument()
  })

  it('falls back to awaiting_data when projectStats is null (Q5 defensive)', () => {
    render(<SourceCoverageWidget projectStats={null} projectId='proj-1' />)
    expect(screen.getByTestId('source-coverage-empty-label')).toHaveTextContent(
      'Awaiting data ingestion',
    )
    expect(screen.queryByTestId('source-decided')).not.toBeInTheDocument()
  })
})

describe('SourceCoverageWidget — footer link', () => {
  it('points to the project Mapping page', () => {
    const { container } = render(
      <SourceCoverageWidget projectStats={projectStats()} projectId='proj-xyz' />,
    )
    const link = container.querySelector('a[href]')
    expect(link).toHaveAttribute('href', '/app/projects/proj-xyz/mapping')
  })
})
