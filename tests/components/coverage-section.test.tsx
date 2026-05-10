import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoverageSection } from '@/app/app/projects/[projectId]/mapping/redesign/components/CoverageSection'
import type { TargetFieldCoverageRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — CoverageSection primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the three-line render shape (label, reasoning, suggested action),
// the synthesized orphan case (`coverage = null`), and the collapse-on-
// undefined contract used by AcknowledgedBody.

function coverageRow(
  partial: Partial<TargetFieldCoverageRow>,
): TargetFieldCoverageRow {
  return {
    id: 'cov-1',
    project_id: 'proj-1',
    target_field_id: 'tf-1',
    coverage_status: 'gap',
    ai_reasoning: null,
    default_value_recommendation: null,
    default_value_decided: null,
    default_decided_at: null,
    default_decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

describe('CoverageSection — render shapes', () => {
  it('renders label + reasoning + suggested action when all three are present (gap)', () => {
    render(
      <CoverageSection
        coverage={coverageRow({
          coverage_status: 'gap',
          ai_reasoning: 'No source field provides shipping_status equivalents.',
        })}
      />,
    )
    expect(screen.getByTestId('drawer-coverage-label').textContent).toBe('Gap')
    expect(screen.getByTestId('drawer-coverage-reasoning').textContent).toBe(
      'No source field provides shipping_status equivalents.',
    )
    expect(screen.getByTestId('drawer-coverage-action').textContent).toBe(
      'Pick a source via the pencil, or acknowledge as not migratable.',
    )
  })

  it('omits reasoning line when ai_reasoning is null', () => {
    render(
      <CoverageSection
        coverage={coverageRow({ coverage_status: 'optional', ai_reasoning: null })}
      />,
    )
    expect(screen.getByTestId('drawer-coverage-label').textContent).toBe(
      'Optional',
    )
    expect(screen.queryByTestId('drawer-coverage-reasoning')).toBeNull()
  })

  it('omits suggested action line for informational statuses (optional, out_of_scope)', () => {
    render(
      <CoverageSection
        coverage={coverageRow({
          coverage_status: 'out_of_scope',
          ai_reasoning: 'Field is internal-only on the source side.',
        })}
      />,
    )
    expect(screen.getByTestId('drawer-coverage-label').textContent).toBe(
      'Out of scope',
    )
    expect(screen.getByTestId('drawer-coverage-reasoning')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-coverage-action')).toBeNull()
  })

  it('renders all five enum statuses with the right labels', () => {
    const cases = [
      ['covered', 'Covered'],
      ['partial', 'Partial'],
      ['gap', 'Gap'],
      ['optional', 'Optional'],
      ['out_of_scope', 'Out of scope'],
    ] as const
    for (const [status, label] of cases) {
      const { unmount } = render(
        <CoverageSection coverage={coverageRow({ coverage_status: status })} />,
      )
      expect(screen.getByTestId('drawer-coverage-label').textContent).toBe(label)
      expect(
        screen
          .getByTestId('drawer-coverage-section')
          .getAttribute('data-coverage-status'),
      ).toBe(status)
      unmount()
    }
  })
})

describe('CoverageSection — synthesized orphan (null coverage)', () => {
  it('renders the orphan label + reasoning when coverage is null', () => {
    render(<CoverageSection coverage={null} />)
    expect(screen.getByTestId('drawer-coverage-label').textContent).toBe(
      'Manual entry required',
    )
    expect(screen.getByTestId('drawer-coverage-reasoning').textContent).toBe(
      'No AI verdict yet — provide a source or acknowledge.',
    )
    expect(screen.queryByTestId('drawer-coverage-action')).toBeNull()
    expect(
      screen
        .getByTestId('drawer-coverage-section')
        .getAttribute('data-coverage-status'),
    ).toBe('orphan')
  })
})

describe('CoverageSection — collapse on undefined', () => {
  it('renders nothing when coverage is undefined (acknowledged-row collapse path)', () => {
    const { container } = render(<CoverageSection coverage={undefined} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('drawer-coverage-section')).toBeNull()
  })
})
