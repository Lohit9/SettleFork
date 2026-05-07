import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MappingSummaryStrip } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingSummaryStrip'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// MappingSummaryStrip — Phase 4-polish-1 + PR-6 consolidation tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// PR-6 (feat/ui-consolidation): the strip renders BOTH project-wide axes
// (target mapped/total + source decided/total) AND grid-level status chips
// (Approved / Needs Review / conditional Rejected + Unmapped). The legacy
// Total chip was retired — the project-wide target denominator replaces it.
// The previously-separate `MappingProjectStatsRow` was folded in here.
//
// State-aware empty wording (Awaiting data ingestion / Data ingested) moved
// into this component as part of the consolidation; the chip row is
// suppressed when projectStats.state ≠ 'mappings_generated'.

type Counts = MappingsForRedesignResult['counts']

const fullCounts: Counts = {
  total: 10,
  approved: 6,
  needsReview: 2,
  rejected: 1,
  unmapped: 1,
}

const minimalCounts: Counts = {
  total: 5,
  approved: 5,
  needsReview: 0,
  rejected: 0,
  unmapped: 0,
}

function projectStats(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    state: 'mappings_generated',
    target: { approved: 59, total: 89, unmapped: 30, needsReview: 0 },
    source: { decided: 53, total: 70 },
    transforms: { complete: 1, total: 24 },
    blocking: 0,
    ...overrides,
  }
}

// ─── PR-6 consolidated content: project-wide axes ───────────────────────────

describe('MappingSummaryStrip — PR-6 consolidated content', () => {
  it('renders project-wide target and source axis chips when projectStats is populated', () => {
    render(
      <MappingSummaryStrip counts={fullCounts} projectStats={projectStats()} />,
    )
    expect(
      screen.getByTestId('mapping-summary-chip-project-target'),
    ).toHaveTextContent('Mapped 59/89')
    expect(
      screen.getByTestId('mapping-summary-chip-project-source'),
    ).toHaveTextContent('Sources 53/70')
  })

  it('project-wide chips are dot-less (denominator truth, not filter chips)', () => {
    render(
      <MappingSummaryStrip counts={fullCounts} projectStats={projectStats()} />,
    )
    const target = screen.getByTestId('mapping-summary-chip-project-target')
    const source = screen.getByTestId('mapping-summary-chip-project-source')
    expect(target.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(source.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(target.innerHTML).not.toMatch(/bg-(green|amber|red|slate)-/)
  })

  it('renders a block divider (║) between project-wide axes and grid-level chips', () => {
    const { container } = render(
      <MappingSummaryStrip counts={fullCounts} projectStats={projectStats()} />,
    )
    expect(container.textContent).toContain('║')
  })

  it('legacy Total chip is retired (project-wide denominator replaces it)', () => {
    render(
      <MappingSummaryStrip counts={fullCounts} projectStats={projectStats()} />,
    )
    expect(screen.queryByTestId('mapping-summary-chip-total')).toBeNull()
  })

  it('exposes data-state attribute matching projectStats.state', () => {
    const { container } = render(
      <MappingSummaryStrip counts={fullCounts} projectStats={projectStats()} />,
    )
    const strip = container.querySelector('[data-testid="mapping-summary-strip"]')
    expect(strip).toHaveAttribute('data-state', 'mappings_generated')
  })
})

// ─── PR-6 state-aware empty ─────────────────────────────────────────────────

describe('MappingSummaryStrip — state-aware empty (PR-6)', () => {
  it('renders "Awaiting data ingestion" label when state === awaiting_data', () => {
    render(
      <MappingSummaryStrip
        counts={minimalCounts}
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
        counts={minimalCounts}
        projectStats={projectStats({ state: 'data_ingested' })}
      />,
    )
    expect(
      screen.getByTestId('mapping-summary-empty-label'),
    ).toHaveTextContent('Data ingested')
  })

  it('falls back to awaiting_data label when projectStats === null (defensive)', () => {
    render(<MappingSummaryStrip counts={minimalCounts} projectStats={null} />)
    expect(
      screen.getByTestId('mapping-summary-empty-label'),
    ).toHaveTextContent('Awaiting data ingestion')
  })
})

// ─── Back-compat: when projectStats prop is omitted ────────────────────────

describe('MappingSummaryStrip — back-compat (no projectStats prop)', () => {
  it('renders only the grid-level chip row when projectStats is omitted', () => {
    // Test fixtures and pre-PR-6 callers may render the strip without
    // threading projectStats. The component degrades to its
    // pre-consolidation chip-only behaviour: no project-wide axes, no
    // empty-state label, no block divider.
    render(<MappingSummaryStrip counts={fullCounts} />)
    expect(
      screen.queryByTestId('mapping-summary-chip-project-target'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-summary-chip-project-source'),
    ).toBeNull()
    expect(screen.queryByTestId('mapping-summary-empty-label')).toBeNull()
    expect(
      screen.getByTestId('mapping-summary-chip-approved'),
    ).toBeInTheDocument()
  })
})

// ─── Refinement 1 — breadcrumb dropped (preserved from Phase 4-polish-1) ───

describe('MappingSummaryStrip — Refinement 1: breadcrumb dropped', () => {
  it('does NOT render the breadcrumb wrapper (legacy redundancy with page header)', () => {
    render(<MappingSummaryStrip counts={fullCounts} />)
    expect(
      screen.queryByTestId('mapping-summary-strip-breadcrumb'),
    ).toBeNull()
  })

  it('strip rendered tree contains no `→` arrow glyph (breadcrumb separator)', () => {
    const { container } = render(<MappingSummaryStrip counts={fullCounts} />)
    expect(container.textContent).not.toContain('→')
  })
})

// ─── Always-visible status chips (Approved / Needs Review) ─────────────────

describe('MappingSummaryStrip — always-visible status chips', () => {
  it('renders Approved and Needs Review chips with their values regardless of zero state', () => {
    render(<MappingSummaryStrip counts={minimalCounts} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(
      within(strip).getByTestId('mapping-summary-chip-approved'),
    ).toBeInTheDocument()
    expect(
      within(strip).getByTestId('mapping-summary-chip-needs-review'),
    ).toBeInTheDocument()
    expect(strip.textContent).toContain('Approved')
    expect(strip.textContent).toContain('5')
  })

  it('renders the Approved chip with a green dot, Needs Review with amber', () => {
    render(<MappingSummaryStrip counts={fullCounts} />)
    const approved = screen.getByTestId('mapping-summary-chip-approved')
    const needsReview = screen.getByTestId('mapping-summary-chip-needs-review')
    expect(approved.innerHTML).toContain('bg-green-500')
    expect(needsReview.innerHTML).toContain('bg-amber-400')
  })
})

// ─── Conditional chips (Rejected / Unmapped) ────────────────────────────────

describe('MappingSummaryStrip — conditional chips', () => {
  it('hides the Rejected chip when counts.rejected === 0 (legacy §9 Q6 gating)', () => {
    render(<MappingSummaryStrip counts={minimalCounts} />)
    expect(screen.queryByTestId('mapping-summary-chip-rejected')).toBeNull()
  })

  it('shows the Rejected chip with a red dot when counts.rejected > 0', () => {
    render(
      <MappingSummaryStrip counts={{ ...minimalCounts, rejected: 2 }} />,
    )
    const chip = screen.getByTestId('mapping-summary-chip-rejected')
    expect(chip.textContent).toContain('Rejected')
    expect(chip.textContent).toContain('2')
    expect(chip.innerHTML).toContain('bg-red-500')
  })

  it('hides the Unmapped chip when counts.unmapped === 0 (Phase 3 Gap 13 gating)', () => {
    render(<MappingSummaryStrip counts={minimalCounts} />)
    expect(screen.queryByTestId('mapping-summary-chip-unmapped')).toBeNull()
  })

  it('shows the Unmapped chip with a slate-300 dot when counts.unmapped > 0 (Q7.2 unification)', () => {
    render(
      <MappingSummaryStrip counts={{ ...minimalCounts, unmapped: 4 }} />,
    )
    const chip = screen.getByTestId('mapping-summary-chip-unmapped')
    expect(chip.textContent).toContain('Unmapped')
    expect(chip.textContent).toContain('4')
    expect(chip.innerHTML).toContain('bg-slate-300')
  })

  it('renders BOTH Rejected and Unmapped chips when both are non-zero', () => {
    render(<MappingSummaryStrip counts={fullCounts} />)
    expect(
      screen.getByTestId('mapping-summary-chip-rejected'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-summary-chip-unmapped'),
    ).toBeInTheDocument()
  })
})

// ─── Styling invariants (founder Q2.3) ─────────────────────────────────────

describe('MappingSummaryStrip — styling invariants', () => {
  it('uses white background and NO border / shadow (Phase 4-polish-1 comprehensive pass)', () => {
    render(<MappingSummaryStrip counts={fullCounts} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    const cls = strip.className
    expect(cls).toContain('bg-white')
    expect(cls).not.toContain('border-b')
    expect(cls).not.toMatch(/\bshadow-/)
  })

  it('carries no `mb-N` margin (Refinement C zero-margin contract)', () => {
    render(<MappingSummaryStrip counts={fullCounts} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(strip.className).not.toMatch(/\bmb-\d/)
  })

  it('rendered tree contains no Tailwind dark-prefix modifiers', () => {
    const { container } = render(<MappingSummaryStrip counts={fullCounts} />)
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})
