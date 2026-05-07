import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DecisionCard } from '@/components/path-d/DecisionCard'
import type { ProjectDecisionRow } from '@/components/path-d/types'

// ─────────────────────────────────────────────────────────────────────────────
// DecisionCard — Path D primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Anchored to the project_decisions row shape from migration 093:117-134.
// AI recommendation / alternatives JSONB are scaffold-rendered as
// JSON.stringify; tests assert the stringified content is present rather
// than the eventual structured form.

function decision(
  overrides: Partial<ProjectDecisionRow> = {},
): ProjectDecisionRow {
  return {
    id: 'pd-1',
    project_id: 'proj-1',
    decision_type: 'picklist_transform',
    title: 'Normalize unit-of-measure picklist values',
    description: 'Source UOM strings are inconsistent; AI recommends mapping via lookup.',
    ai_recommendation: { option: 'lookup_table', value: 'uom_normalization' },
    alternatives: [
      { option: 'inline_case', value: 'CASE WHEN ...' },
      { option: 'reject', value: null },
    ],
    customer_decision: null,
    applies_to: { tfm_ids: ['tfm-1'], coverage_ids: ['tfc-1'] },
    status: 'pending',
    decided_at: null,
    decided_by: null,
    created_at: '2026-05-06T10:00:00Z',
    updated_at: '2026-05-06T10:00:00Z',
    experiment_run_id: null,
    ...overrides,
  }
}

describe('DecisionCard', () => {
  it('renders the title, decision_type, and status', () => {
    render(<DecisionCard decision={decision()} />)
    expect(
      screen.getByText('Normalize unit-of-measure picklist values'),
    ).toBeInTheDocument()
    expect(screen.getByText('picklist_transform')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('renders the description when present', () => {
    render(<DecisionCard decision={decision()} />)
    expect(
      screen.getByText(/Source UOM strings are inconsistent/),
    ).toBeInTheDocument()
  })

  it('omits the description when null', () => {
    render(<DecisionCard decision={decision({ description: null })} />)
    expect(
      screen.queryByText(/Source UOM strings are inconsistent/),
    ).not.toBeInTheDocument()
  })

  it('renders the AI recommendation as pretty-printed JSON', () => {
    render(<DecisionCard decision={decision()} />)
    const block = screen.getByTestId('ai-recommendation')
    expect(block.textContent).toContain('"option"')
    expect(block.textContent).toContain('"lookup_table"')
    expect(block.textContent).toContain('"value"')
    expect(block.textContent).toContain('"uom_normalization"')
  })

  it('renders the alternatives array as pretty-printed JSON', () => {
    render(<DecisionCard decision={decision()} />)
    const block = screen.getByTestId('alternatives')
    expect(block.textContent).toContain('inline_case')
    expect(block.textContent).toContain('reject')
  })

  it('renders the decided status label when status is decided', () => {
    render(<DecisionCard decision={decision({ status: 'decided' })} />)
    expect(screen.getByText('Decided')).toBeInTheDocument()
  })

  it('renders the auto-applied status label', () => {
    render(<DecisionCard decision={decision({ status: 'auto_applied' })} />)
    expect(screen.getByText('Auto-applied')).toBeInTheDocument()
  })

  it('invokes onAccept when Accept button is clicked', () => {
    const onAccept = vi.fn()
    render(<DecisionCard decision={decision()} onAccept={onAccept} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('invokes onDecline when Decline button is clicked', () => {
    const onDecline = vi.fn()
    render(<DecisionCard decision={decision()} onDecline={onDecline} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onDecline).toHaveBeenCalledTimes(1)
  })

  it('renders both buttons even when no callbacks are provided (no-op click)', () => {
    render(<DecisionCard decision={decision()} />)
    const acceptBtn = screen.getByRole('button', { name: 'Accept' })
    const declineBtn = screen.getByRole('button', { name: 'Decline' })
    expect(acceptBtn).not.toBeDisabled()
    expect(declineBtn).not.toBeDisabled()
    // Clicking should not throw
    fireEvent.click(acceptBtn)
    fireEvent.click(declineBtn)
  })

  it('exposes the decision status via data-status on the root', () => {
    const { container } = render(
      <DecisionCard decision={decision({ status: 'auto_applied' })} />,
    )
    expect(container.firstChild).toHaveAttribute('data-status', 'auto_applied')
  })
})
