import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { DecisionList } from '@/app/app/projects/[projectId]/mapping/redesign/components/DecisionList'
import type { ProjectDecisionRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — DecisionList primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the empty-collapse, populated render, status pill colors, and
// ai_recommendation summary extraction (prose vs omit on absence).

function decisionRow(
  partial: Partial<ProjectDecisionRow>,
): ProjectDecisionRow {
  return {
    id: 'dec-1',
    project_id: 'proj-1',
    decision_type: 'mapping',
    title: 'Decision title',
    description: null,
    ai_recommendation: {},
    alternatives: [],
    customer_decision: null,
    applies_to: null,
    status: 'pending',
    decided_at: null,
    decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

describe('DecisionList — empty collapse', () => {
  it('returns null when decisions array is empty', () => {
    const { container } = render(<DecisionList decisions={[]} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('drawer-decision-list')).toBeNull()
  })
})

describe('DecisionList — populated render', () => {
  it('renders one item per decision with title + status pill', () => {
    render(
      <DecisionList
        decisions={[
          decisionRow({ id: 'd1', title: 'Map customer to account', status: 'pending' }),
          decisionRow({ id: 'd2', title: 'Bundle SKUs', status: 'decided' }),
        ]}
      />,
    )
    const items = screen.getAllByTestId('drawer-decision-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.getAttribute('data-decision-id')).toBe('d1')
    expect(items[1]?.getAttribute('data-decision-id')).toBe('d2')

    const titles = screen.getAllByTestId('drawer-decision-title')
    expect(titles[0]?.textContent).toBe('Map customer to account')
    expect(titles[1]?.textContent).toBe('Bundle SKUs')
  })

  it('renders status pill labels per the three enum variants', () => {
    const cases = [
      ['pending', 'Pending'],
      ['decided', 'Decided'],
      ['auto_applied', 'Auto-applied'],
    ] as const
    for (const [status, label] of cases) {
      const { unmount } = render(
        <DecisionList
          decisions={[decisionRow({ id: `d-${status}`, status })]}
        />,
      )
      const pill = screen.getByTestId('drawer-decision-status-pill')
      expect(pill.textContent).toBe(label)
      const item = screen.getByTestId('drawer-decision-item')
      expect(item.getAttribute('data-decision-status')).toBe(status)
      unmount()
    }
  })

  it('renders description block when description is non-null', () => {
    render(
      <DecisionList
        decisions={[
          decisionRow({ description: 'These customers were merged in 2024.' }),
        ]}
      />,
    )
    expect(
      screen.getByTestId('drawer-decision-description').textContent,
    ).toBe('These customers were merged in 2024.')
  })

  it('omits description block when description is null', () => {
    render(<DecisionList decisions={[decisionRow({ description: null })]} />)
    expect(screen.queryByTestId('drawer-decision-description')).toBeNull()
  })
})

describe('DecisionList — ai_recommendation summary extraction', () => {
  it('renders summary prose when ai_recommendation has a non-empty summary string', () => {
    render(
      <DecisionList
        decisions={[
          decisionRow({
            ai_recommendation: { summary: 'Merge into account hierarchy.' },
          }),
        ]}
      />,
    )
    expect(
      screen.getByTestId('drawer-decision-recommendation').textContent,
    ).toBe('Merge into account hierarchy.')
  })

  it('omits recommendation block when summary is missing or non-string', () => {
    const cases: unknown[] = [
      {},
      { summary: '' },
      { summary: '   ' },
      { summary: 42 },
      null,
      [],
      'a top-level string is not an object',
    ]
    for (const recommendation of cases) {
      const { unmount } = render(
        <DecisionList
          decisions={[decisionRow({ ai_recommendation: recommendation })]}
        />,
      )
      expect(screen.queryByTestId('drawer-decision-recommendation')).toBeNull()
      unmount()
    }
  })

  it('trims surrounding whitespace from the summary string', () => {
    render(
      <DecisionList
        decisions={[
          decisionRow({
            ai_recommendation: { summary: '   Merge into hierarchy.   ' },
          }),
        ]}
      />,
    )
    expect(
      screen.getByTestId('drawer-decision-recommendation').textContent,
    ).toBe('Merge into hierarchy.')
  })
})

describe('DecisionList — list ordering preserved', () => {
  it('renders decisions in the input order (no client-side sort)', () => {
    const decisions = [
      decisionRow({ id: 'z', title: 'Z first' }),
      decisionRow({ id: 'a', title: 'A second' }),
      decisionRow({ id: 'm', title: 'M last' }),
    ]
    render(<DecisionList decisions={decisions} />)
    const list = screen.getByTestId('drawer-decision-list')
    const ids = within(list)
      .getAllByTestId('drawer-decision-item')
      .map((el) => el.getAttribute('data-decision-id'))
    expect(ids).toEqual(['z', 'a', 'm'])
  })
})
