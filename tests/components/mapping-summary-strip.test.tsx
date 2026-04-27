import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MappingSummaryStrip } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingSummaryStrip'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// MappingSummaryStrip — Phase 4-polish-1 final refinements tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// The strip restores legacy `MappingStatPills` density at the page-header
// layer of the redesigned Mapping page. This file exercises:
//
//   • Pipe-separated chip rendering for the always-visible chips
//     (Total / Approved / Needs Review).
//   • Conditional Rejected + Unmapped chips (count > 0 gating, mirrors
//     the legacy CountersRow contract that this strip absorbs).
//   • Styling invariants (white background, NO bottom border, no
//     shadow, no breadcrumb).
//   • Refinement 1 (2026-04-26): the breadcrumb wrapper was DROPPED
//     entirely (it duplicated the page header above this strip). A
//     regression guard test asserts the breadcrumb subtree never
//     renders, regardless of any future prop additions.
//   • No-dark-prefix invariant (Phase 4-polish-1 inherits the same
//     light-mode-only contract as every redesign surface).

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

// ─── Refinement 1 — breadcrumb dropped entirely ─────────────────────────────

describe('MappingSummaryStrip — Refinement 1: breadcrumb dropped', () => {
  it('does NOT render the breadcrumb wrapper (legacy redundancy with page header)', () => {
    // Refinement 1 dropped the breadcrumb because it duplicated the
    // page header above this strip ("Mapping | <project name>" carries
    // the same source→target axis). The breadcrumb test-id must never
    // appear in the rendered tree.
    render(<MappingSummaryStrip counts={fullCounts} />)
    expect(screen.queryByTestId('mapping-summary-strip-breadcrumb')).toBeNull()
  })

  it('strip rendered tree contains no `→` arrow glyph (breadcrumb separator)', () => {
    // Source-tree-level guard: the arrow glyph was the canonical
    // breadcrumb separator. Pin its absence so a future refactor that
    // re-introduces a breadcrumb-like element fails this test
    // immediately rather than silently shipping the redundancy.
    const { container } = render(<MappingSummaryStrip counts={fullCounts} />)
    expect(container.textContent).not.toContain('→')
  })
})

// ─── Always-visible chips ───────────────────────────────────────────────────

describe('MappingSummaryStrip — always-visible chips', () => {
  it('renders Total / Approved / Needs Review chips with their values regardless of zero state', () => {
    render(<MappingSummaryStrip counts={minimalCounts} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(within(strip).getByTestId('mapping-summary-chip-total')).toBeInTheDocument()
    expect(within(strip).getByTestId('mapping-summary-chip-approved')).toBeInTheDocument()
    expect(within(strip).getByTestId('mapping-summary-chip-needs-review')).toBeInTheDocument()
    expect(strip.textContent).toContain('Total')
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
    // Founder Q7.2: unified slate-300 for the unmapped + acknowledged
    // dots — this strip uses the same hue here as `FieldMappingRow`'s
    // unmapped status dot so the project-level chip and per-row dot
    // read consistently.
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
    expect(screen.getByTestId('mapping-summary-chip-rejected')).toBeInTheDocument()
    expect(screen.getByTestId('mapping-summary-chip-unmapped')).toBeInTheDocument()
  })
})

// ─── Styling invariants (founder Q2.3) ──────────────────────────────────────

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
    // Refinement C: the strip and the sticky FilterRow read as a
    // single two-line toolbar. The strip MUST NOT carry a bottom
    // margin or it would push the toolbar apart. The DOM-level
    // zero-gap regression guard lives in
    // `mapping-redesign-content.test.tsx` — it walks the rendered
    // tree and asserts the strip and FilterRow are immediate
    // siblings (or share a non-padding parent). This per-component
    // assertion just pins the strip's own class contract.
    render(<MappingSummaryStrip counts={fullCounts} />)
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(strip.className).not.toMatch(/\bmb-\d/)
  })

  it('renders the Total chip without a flex-wrapper or colored dot', () => {
    // Phase 4-polish-1 comprehensive pass: Total is the single dot-less
    // chip and reads more cleanly as a bare text span (no `flex
    // items-center gap-1.5` wrapper, no dot slot). Hued chips
    // (Approved / Needs Review / Rejected / Unmapped) keep the
    // wrapper because they carry semantic dots.
    render(<MappingSummaryStrip counts={fullCounts} />)
    const total = screen.getByTestId('mapping-summary-chip-total')
    expect(total.className).not.toContain('flex')
    expect(total.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(total.innerHTML).not.toMatch(/bg-(green|amber|red|slate)-/)

    const approved = screen.getByTestId('mapping-summary-chip-approved')
    expect(approved.className).toContain('flex')
  })

  it('rendered tree contains no Tailwind dark-prefix modifiers', () => {
    const { container } = render(<MappingSummaryStrip counts={fullCounts} />)
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})
