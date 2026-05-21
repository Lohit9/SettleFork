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
// still carry status='rejected'.
//
// Visual-collapse update (feat/normalize-rejected-rows-null-confidence):
// post-#157/#158/A2 'rejected' no longer carries a semantic distinct
// from 'needs_review'. The dot now renders the SAME slate-400 grey as
// needs_review — rejected rows visually collapse into the unified
// needs-review state. The type's 'rejected' member is unchanged; only
// the color mapping moved. This test locks the new grey rendering.

describe('FlatStatusDot', () => {
  it('renders a grey dot for status=rejected (collapsed onto needs_review)', () => {
    render(<FlatStatusDot status="rejected" />)
    const dot = screen.getByTestId('flat-status-dot')
    expect(dot.className).toContain('bg-slate-400')
    expect(dot.className).not.toContain('bg-red-500')
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
