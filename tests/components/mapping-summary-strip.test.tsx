import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MappingSummaryStrip } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingSummaryStrip'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// MappingSummaryStrip — PR-7 single-source-of-truth tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// PR-7 (feat/mapping-approvals) made `projectStats` the SOLE source for
// every value the strip renders — both the project-wide axes (Source
// Fields / Target Fields) AND the status chips (Approved / Needs Review).
// The pre-PR-7 `counts: MappingsForRedesignResult['counts']` prop was
// dropped because grid-level counts produced numerators that didn't
// reconcile with the project-wide axis denominators on the same strip
// (e.g., grid-level "Approved 59" next to project-wide "Target Fields
// 60/72") — exactly the muddle PR-7 was created to close.
//
// Other PR-7 strip changes covered by this file:
//   • Source-first axis order (was target-first pre-PR-7).
//   • "Mapped" → "Target Fields", "Sources" → "Source Fields".
//   • Conditional Rejected / Unmapped chips RETIRED — both subsumed
//     in the redefined `target.needsReview = total − approved`.
//   • `projectStats` is REQUIRED (no longer optional). Pass `null`
//     explicitly for the empty-state fallback.

function projectStats(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    state: 'mappings_generated',
    target: { approved: 60, total: 72, unmapped: 12, needsReview: 12 },
    source: { decided: 53, total: 70 },
    transforms: { complete: 1, total: 24 },
    blocking: 21,
    ...overrides,
  }
}

// ─── Source-first axis order ────────────────────────────────────────────────

describe('MappingSummaryStrip — PR-7 source-first axis order', () => {
  it('renders Source Fields BEFORE Target Fields in DOM order', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const source = screen.getByTestId('mapping-summary-chip-project-source')
    const target = screen.getByTestId('mapping-summary-chip-project-target')
    // compareDocumentPosition returns DOCUMENT_POSITION_FOLLOWING (4) when
    // the argument follows the receiver. Source must come first.
    expect(
      source.compareDocumentPosition(target) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders the Source Fields chip with the source axis ratio', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    expect(
      screen.getByTestId('mapping-summary-chip-project-source'),
    ).toHaveTextContent('Source Fields 53/70')
  })

  it('renders the Target Fields chip with the target axis ratio', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    expect(
      screen.getByTestId('mapping-summary-chip-project-target'),
    ).toHaveTextContent('Target Fields 60/72')
  })

  it('project-wide chips are dot-less (denominator truth, not filter chips)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const source = screen.getByTestId('mapping-summary-chip-project-source')
    const target = screen.getByTestId('mapping-summary-chip-project-target')
    expect(source.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(target.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(source.innerHTML).not.toMatch(/bg-(green|amber|red|slate)-/)
  })

  it('renders a block divider (║) between project-wide axes and status chips', () => {
    const { container } = render(
      <MappingSummaryStrip projectStats={projectStats()} />,
    )
    expect(container.textContent).toContain('║')
  })
})

// ─── PR-7 single-source-of-truth status chips ──────────────────────────────

describe('MappingSummaryStrip — PR-7 chips read from projectStats', () => {
  it('Approved chip reads projectStats.target.approved (NOT a grid-level counts.approved)', () => {
    // The PR-7 spec change: status chips reconcile with project-wide axes.
    // A fixture where target.approved=60 (includes acks) renders 60, not
    // 59 (which would be the legacy data.counts.approved excluding acks).
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const approved = screen.getByTestId('mapping-summary-chip-approved')
    expect(approved.textContent).toContain('Approved')
    expect(approved.textContent).toContain('60')
  })

  it('Needs Review chip reads projectStats.target.needsReview (PR-7 = total − approved)', () => {
    // Pre-PR-7: needsReview was status='needs_review' TFM count only.
    // Post-PR-7: needsReview engulfs needs_review + rejected + unacknowledged
    // unmapped target. The chip shows the redefined value directly.
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const needsReview = screen.getByTestId('mapping-summary-chip-needs-review')
    expect(needsReview.textContent).toContain('Needs Review')
    expect(needsReview.textContent).toContain('12')
  })

  it('Approved + Needs Review = target.total (chip math reconciles with axis denominator)', () => {
    // The conceptual contract PR-7 enforces: sum of status chips equals the
    // project-wide target denominator. A fixture violating this would imply
    // the formula change drifted; this test pins the invariant.
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const approved = screen.getByTestId('mapping-summary-chip-approved')
    const needsReview = screen.getByTestId('mapping-summary-chip-needs-review')
    const target = screen.getByTestId('mapping-summary-chip-project-target')
    const approvedNum = Number(approved.textContent?.match(/\d+/)?.[0])
    const needsReviewNum = Number(needsReview.textContent?.match(/\d+/)?.[0])
    expect(approvedNum + needsReviewNum).toBe(72)
    expect(target.textContent).toContain('60/72')
  })

  it('Approved chip carries a green dot, Needs Review carries amber', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const approved = screen.getByTestId('mapping-summary-chip-approved')
    const needsReview = screen.getByTestId('mapping-summary-chip-needs-review')
    expect(approved.innerHTML).toContain('bg-green-500')
    expect(needsReview.innerHTML).toContain('bg-amber-400')
  })
})

// ─── PR-7 chip retirements ──────────────────────────────────────────────────

describe('MappingSummaryStrip — PR-7 retired chips', () => {
  it('does NOT render the Total chip (retired in PR-6, stays retired)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    expect(screen.queryByTestId('mapping-summary-chip-total')).toBeNull()
  })

  it('does NOT render the Rejected chip (retired in PR-7 — subsumed in needsReview)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    expect(screen.queryByTestId('mapping-summary-chip-rejected')).toBeNull()
  })

  it('does NOT render the Unmapped chip (retired in PR-7 — subsumed in needsReview)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    expect(screen.queryByTestId('mapping-summary-chip-unmapped')).toBeNull()
  })
})

// ─── State-aware empty (preserved from PR-6) ───────────────────────────────

describe('MappingSummaryStrip — state-aware empty (preserved from PR-6)', () => {
  it('renders "Awaiting data ingestion" label when state === awaiting_data', () => {
    render(
      <MappingSummaryStrip
        projectStats={projectStats({
          state: 'awaiting_data',
          target: { approved: 0, total: 0, unmapped: 0, needsReview: 0 },
          source: { decided: 0, total: 0 },
        })}
      />,
    )
    expect(
      screen.getByTestId('mapping-summary-empty-label'),
    ).toHaveTextContent('Awaiting data ingestion')
    expect(screen.queryByTestId('mapping-summary-chip-approved')).toBeNull()
  })

  it('renders "Data ingested" label when state === data_ingested', () => {
    render(
      <MappingSummaryStrip
        projectStats={projectStats({ state: 'data_ingested' })}
      />,
    )
    expect(
      screen.getByTestId('mapping-summary-empty-label'),
    ).toHaveTextContent('Data ingested')
  })

  it('falls back to awaiting_data label when projectStats === null (defensive)', () => {
    render(<MappingSummaryStrip projectStats={null} />)
    expect(
      screen.getByTestId('mapping-summary-empty-label'),
    ).toHaveTextContent('Awaiting data ingestion')
  })

  it('exposes data-state attribute matching projectStats.state', () => {
    const { container } = render(
      <MappingSummaryStrip projectStats={projectStats()} />,
    )
    const strip = container.querySelector(
      '[data-testid="mapping-summary-strip"]',
    )
    expect(strip).toHaveAttribute('data-state', 'mappings_generated')
  })
})

// ─── Refinement 1 — breadcrumb dropped (preserved from Phase 4-polish-1) ───

describe('MappingSummaryStrip — Refinement 1: breadcrumb dropped', () => {
  it('does NOT render the breadcrumb wrapper (legacy redundancy with page header)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    expect(
      screen.queryByTestId('mapping-summary-strip-breadcrumb'),
    ).toBeNull()
  })

  it('strip rendered tree contains no `→` arrow glyph (breadcrumb separator)', () => {
    const { container } = render(
      <MappingSummaryStrip projectStats={projectStats()} />,
    )
    expect(container.textContent).not.toContain('→')
  })
})

// ─── Always-visible status chips (Approved / Needs Review) ─────────────────

describe('MappingSummaryStrip — always-visible status chips', () => {
  it('renders Approved and Needs Review chips even at zero counts', () => {
    render(
      <MappingSummaryStrip
        projectStats={projectStats({
          target: { approved: 5, total: 5, unmapped: 0, needsReview: 0 },
        })}
      />,
    )
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(
      within(strip).getByTestId('mapping-summary-chip-approved'),
    ).toBeInTheDocument()
    expect(
      within(strip).getByTestId('mapping-summary-chip-needs-review'),
    ).toBeInTheDocument()
    expect(strip.textContent).toContain('Approved')
    expect(strip.textContent).toContain('Needs Review')
  })
})

// ─── Styling invariants (founder Q2.3) ─────────────────────────────────────

describe('MappingSummaryStrip — styling invariants', () => {
  it('uses white background and NO border / shadow (Phase 4-polish-1 comprehensive pass)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    const cls = strip.className
    expect(cls).toContain('bg-white')
    expect(cls).not.toContain('border-b')
    expect(cls).not.toMatch(/\bshadow-/)
  })

  it('carries no `mb-N` margin (Refinement C zero-margin contract)', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(strip.className).not.toMatch(/\bmb-\d/)
  })

  it('rendered tree contains no Tailwind dark-prefix modifiers', () => {
    const { container } = render(
      <MappingSummaryStrip projectStats={projectStats()} />,
    )
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})
