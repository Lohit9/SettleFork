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
    target: {
      approved: 60,
      total: 72,
      unmapped: 12,
      needsReview: 12,
      // Chip ratio source — distinct count of target fields used in any
      // primary (non-rejected, non-bare-ack) TFM. Defaults to `approved`
      // here so the legacy `Target Fields 60/72` ratio assertion below
      // still reads identically.
      usedInMapping: 60,
      // Schema-wide target field count (`datasets.role='target'`).
      // Defaults to `total` here for the same reason — preserve the
      // pre-change ratio in the legacy assertion.
      schemaTotal: 72,
    },
    source: {
      decided: 53,
      total: 70,
      // Chip ratio source — distinct count of source fields contributing
      // to any non-rejected mapping_sources row. Defaults to `decided`
      // here so the legacy `Source Fields 53/70` assertion reads
      // identically.
      usedInMapping: 53,
    },
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

  // ─── Ratio shape ─────────────────────────────────────────────────────────
  //
  // The two axis chips read `usedInMapping / (source.total | target.schemaTotal)`.
  // These tests pin the SOURCE FIELDS chip to `source.usedInMapping`
  // (not `source.decided`) and the TARGET FIELDS chip to
  // `target.usedInMapping / target.schemaTotal` (not `target.approved / target.total`).
  // If either reverts, the visual ratio drifts away from "fields used in
  // mapping" back to "approved over addressable slots".

  it('Source Fields chip uses source.usedInMapping (not source.decided)', () => {
    render(
      <MappingSummaryStrip
        projectStats={projectStats({
          source: { decided: 999, total: 70, usedInMapping: 41 },
        })}
      />,
    )
    expect(
      screen.getByTestId('mapping-summary-chip-project-source'),
    ).toHaveTextContent('Source Fields 41/70')
  })

  it('Target Fields chip uses target.usedInMapping and target.schemaTotal (not approved/total)', () => {
    render(
      <MappingSummaryStrip
        projectStats={projectStats({
          target: {
            approved: 999,
            total: 999,
            unmapped: 0,
            needsReview: 0,
            usedInMapping: 80,
            schemaTotal: 121,
          },
        })}
      />,
    )
    expect(
      screen.getByTestId('mapping-summary-chip-project-target'),
    ).toHaveTextContent('Target Fields 80/121')
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

  it('Approved chip carries an emerald dot with ring, Needs Review carries slate with ring', () => {
    // feat/mapping-list-toggle-and-columns refinement pass: dots
    // switched from green-500/amber-400 (no ring) to
    // emerald-500 / slate-400 each with a 2px ring at 25% opacity.
    // Mirrors the row-level `StatusDot` in MappingListView so the
    // summary and row dots read identically.
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const approved = screen.getByTestId('mapping-summary-chip-approved')
    const needsReview = screen.getByTestId('mapping-summary-chip-needs-review')
    expect(approved.innerHTML).toContain('bg-emerald-500')
    expect(approved.innerHTML).toContain('ring-emerald-500/25')
    expect(needsReview.innerHTML).toContain('bg-slate-400')
    expect(needsReview.innerHTML).toContain('ring-slate-400/25')
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
          target: { approved: 0, total: 0, unmapped: 0, needsReview: 0, usedInMapping: 0, schemaTotal: 0 },
          source: { decided: 0, total: 0, usedInMapping: 0 },
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
          target: { approved: 5, total: 5, unmapped: 0, needsReview: 0, usedInMapping: 5, schemaTotal: 5 },
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

// ─── PR ε — chip tooltips ──────────────────────────────────────────────────
//
// Every chip carries a native `title=` hover tooltip explaining the metric
// in customer-facing terms (pilot demo for Joanna/Greg). Native title was
// chosen over a Radix-based component to avoid a new dependency and match
// the codebase's existing hover-hint pattern (FieldMappingRow.tsx,
// MappingListView.tsx all use native title=). Matchers are loose
// (`toMatch`, not `toEqual`) so future copy tweaks don't fail unrelated
// tests — the assertion is "tooltip is present and on-topic", not
// "tooltip says exactly X". A future swap to Radix should keep these
// tests green by mirroring the title text into the component's
// equivalent prop.

describe('MappingSummaryStrip — chip tooltips (PR ε)', () => {
  it('Source Fields chip carries a title attribute explaining the metric', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const chip = screen.getByTestId('mapping-summary-chip-project-source')
    expect(chip).toHaveAttribute('title')
    expect(chip.getAttribute('title')).toMatch(/source fields contributing/i)
  })

  it('Target Fields chip tooltip mentions both mapped and fixed-value paths', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const chip = screen.getByTestId('mapping-summary-chip-project-target')
    expect(chip).toHaveAttribute('title')
    const title = chip.getAttribute('title') ?? ''
    expect(title).toMatch(/target fields receiving a value/i)
    expect(title).toMatch(/mapped from source/i)
    expect(title).toMatch(/fixed value/i)
  })

  it('Approved chip tooltip references reviewed-and-approved decisions', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const chip = screen.getByTestId('mapping-summary-chip-approved')
    expect(chip).toHaveAttribute('title')
    expect(chip.getAttribute('title')).toMatch(/reviewed and approved/i)
  })

  it('Needs Review chip tooltip references awaiting-review decisions', () => {
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const chip = screen.getByTestId('mapping-summary-chip-needs-review')
    expect(chip).toHaveAttribute('title')
    expect(chip.getAttribute('title')).toMatch(/awaiting your review/i)
  })

  it('chips with tooltips carry the cursor-help affordance class', () => {
    // Visual hint that a hover-tooltip is available; one-line CSS, no
    // layout impact. Pinned so a future class refactor doesn't drop it.
    render(<MappingSummaryStrip projectStats={projectStats()} />)
    const source = screen.getByTestId('mapping-summary-chip-project-source')
    const target = screen.getByTestId('mapping-summary-chip-project-target')
    const approved = screen.getByTestId('mapping-summary-chip-approved')
    const needsReview = screen.getByTestId('mapping-summary-chip-needs-review')
    expect(source.className).toContain('cursor-help')
    expect(target.className).toContain('cursor-help')
    expect(approved.className).toContain('cursor-help')
    expect(needsReview.className).toContain('cursor-help')
  })
})
