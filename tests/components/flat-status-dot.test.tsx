import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { FlatStatusDot } from '@/app/app/projects/[projectId]/mapping/redesign/components/FlatStatusDot'

// ─────────────────────────────────────────────────────────────────────────────
// FlatStatusDot — flat-view status indicator (3-bucket scheme).
// ─────────────────────────────────────────────────────────────────────────────
//
// Regression guard for the "Reject affordance + filter cleanup" PR: the
// status-FILTER dropdown dropped its "Rejected" option (Reject = reset,
// PR #157/#158), but `FlatRowStatus` deliberately KEEPS its 'rejected'
// member. Legacy heritage rows (e.g. SimpleLegal mapped+rejected data)
// still carry status='rejected' and must keep rendering the red dot.
// This test pins that the filter-level type narrowing did not couple
// into — or regress — the row-level rendering path.

describe('FlatStatusDot', () => {
  it('renders a red dot for status=rejected (legacy heritage data)', () => {
    render(<FlatStatusDot status="rejected" />)
    const dot = screen.getByTestId('flat-status-dot')
    expect(dot.className).toContain('bg-red-500')
    expect(dot.getAttribute('data-status')).toBe('rejected')
    expect(dot.getAttribute('aria-label')).toBe('status: Rejected')
  })

  it('renders a green dot for status=approved', () => {
    render(<FlatStatusDot status="approved" />)
    expect(screen.getByTestId('flat-status-dot').className).toContain(
      'bg-green-500',
    )
  })

  it('renders a grey dot for status=needs_review', () => {
    render(<FlatStatusDot status="needs_review" />)
    expect(screen.getByTestId('flat-status-dot').className).toContain(
      'bg-slate-400',
    )
  })
})
