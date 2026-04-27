import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// MappingSummaryStrip — Phase 4-polish-1 final refinements.
// ─────────────────────────────────────────────────────────────────────────────
//
// Restores the legacy `MappingStatPills` density at the top of the mapping
// page. Modeled directly after `app/app/projects/[projectId]/mapping/
// MappingContent.tsx` lines ~353-395 (the legacy stat pills) so the
// redesign and legacy pages read identically during the Phase 4-polish-1
// canary window.
//
// Layout (post-Refinement 1):
//
//   Total N · Approved N · Needs Review N [· Rejected N · Unmapped N]
//
// The breadcrumb ("Source System → Target System") was DROPPED in
// Refinement 1 because it duplicates the page header above this strip
// ("Mapping | <project name>" carries the same information). Removing
// it eliminates the visual repetition without losing any axis of data.
// Conditional Rejected/Unmapped chips render only when count > 0
// (mirrors the Phase 3 Gap 13 / §9 Q6 gating from the retired
// `CountersRow`).
//
// Phase 4-polish-1 comprehensive pass (2026-04-26):
//
//   • Border DROPPED. The legacy reference renders the strip and the
//     filter row as a single two-line toolbar (zero pixels between
//     them); a `border-b` on the strip would draw a hairline INSIDE
//     that toolbar and break the unified read. The visual divider
//     instead lives on the FilterRow's bottom edge (where it now
//     carries `border-b border-gray-100` per Refinement B).
//   • The "Total" chip drops the colored-dot wrapper entirely — no
//     `flex` container, no dot slot. Approved / Needs Review /
//     Rejected / Unmapped retain the dot+label flex shape because
//     they each carry a semantic hue. "Total" is the single
//     unhued chip and reads more cleanly without the empty dot
//     gutter.
//
// Phase 4-polish-1 final refinements (Refinement 1, 2026-04-26):
//
//   • Breadcrumb wrapper REMOVED entirely — see contract above.
//     Component props simplified accordingly: `sourceSystem` and
//     `targetSystem` are gone; only `counts` remains.
//
// This replaces both the experimental `WipBanner` (dropped per Q2.1) and
// the `CountersRow` block. The strip is non-sticky (founder Q8.1) — it
// scrolls away naturally when the user dives into the row body, so the
// FilterRow (Block D) becomes the persistent toolbar.
//
// Refinement C zero-margin contract (Phase 4-polish-1 final): this
// component MUST NOT carry an `mb-N` class, AND no parent in the path
// to FilterRow may carry top-padding/margin between them. The earlier
// pass missed `py-6` on the centered max-w-5xl content column in
// `MappingContent.tsx`; that's now `pb-6` (top dropped) so the strip's
// bottom and the FilterRow's top read as flush.
//
// ─── Light-mode-only ─────────────────────────────────────────────────────────
// No dark-prefix Tailwind modifiers. See `FieldMappingRow.tsx` file
// header for the full rationale; the grep invariant at
// `tests/lib/no-shim-in-redesign-path.test.ts` enforces it at CI time.

interface MappingSummaryStripProps {
  counts: MappingsForRedesignResult['counts']
}

export function MappingSummaryStrip({ counts }: MappingSummaryStripProps) {
  return (
    <div
      data-testid="mapping-summary-strip"
      className="flex items-center bg-white px-5 py-2 flex-shrink-0"
    >
      <div className="flex items-center gap-3 text-sm text-settle-slate-600">
        <SummaryChip label="Total" value={counts.total} />
        <SummaryChipDivider />
        <SummaryChip
          label="Approved"
          value={counts.approved}
          dotClassName="bg-green-500"
        />
        <SummaryChipDivider />
        <SummaryChip
          label="Needs Review"
          value={counts.needsReview}
          dotClassName="bg-amber-400"
        />
        {counts.rejected > 0 ? (
          <>
            <SummaryChipDivider />
            <SummaryChip
              label="Rejected"
              value={counts.rejected}
              dotClassName="bg-red-500"
            />
          </>
        ) : null}
        {counts.unmapped > 0 ? (
          <>
            <SummaryChipDivider />
            <SummaryChip
              label="Unmapped"
              value={counts.unmapped}
              dotClassName="bg-slate-300"
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

function SummaryChip({
  label,
  value,
  dotClassName,
}: {
  label: string
  value: number
  /** Optional colored dot — Total is dot-less per the legacy aesthetic. */
  dotClassName?: string
}) {
  const testId = `mapping-summary-chip-${label.toLowerCase().replace(/\s+/g, '-')}`
  // Phase 4-polish-1 comprehensive pass: dot-less chips (Total) drop the
  // `flex items-center gap-1.5` wrapper entirely — without a dot the
  // wrapper just adds an inline-block with no visual effect, and the
  // legacy reference renders Total as a bare text span. Hued chips keep
  // the wrapper because they need it to align dot-with-text vertically.
  if (!dotClassName) {
    return (
      <span data-testid={testId}>
        {label}{' '}
        <span className="font-semibold text-settle-slate-900 tabular-nums">
          {value}
        </span>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5" data-testid={testId}>
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${dotClassName}`}
      />
      <span>
        {label}{' '}
        <span className="font-semibold text-settle-slate-900 tabular-nums">
          {value}
        </span>
      </span>
    </span>
  )
}

function SummaryChipDivider() {
  return <span aria-hidden="true" className="text-settle-slate-300">·</span>
}
