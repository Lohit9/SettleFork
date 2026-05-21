import type { ProjectStats } from '@/lib/quality/project-stats'
import type { MappingCounts } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// MappingSummaryStrip — Phase 4-polish-1 final refinements + PR-6 consolidation.
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
// PR-6 (feat/ui-consolidation, 2026-05-07):
//
//   • Consolidated single-strip — `MappingProjectStatsRow` retired;
//     this component now renders BOTH the project-wide axes AND the
//     grid-level status chips. A `║` block divider separates the two
//     groups so the eye reads "project truth ║ filter chips" rather
//     than one homogeneous chip row.
//   • The legacy "Total" chip was dropped — `target.total` denominator
//     in the project-wide axis already conveys the same number.
//
// PR-7 (feat/mapping-approvals, 2026-05-08):
//
//   • Source-first axis order: `Source Fields X/Y · Target Fields X/Y`.
//     Pre-PR-7 was target-first (`Mapped X/Y · Sources X/Y`). The new
//     order foregrounds the user's mental model: "which source data is
//     decided?" reads first; "what's the target-side migration scope?"
//     reads second.
//   • Label rename — "Mapped" → "Target Fields", "Sources" → "Source
//     Fields". Both labels now name the axis they measure rather than
//     the action.
//   • Conditional Rejected / Unmapped chips RETIRED. The redefined
//     `target.needsReview = total - approved` (PR-7 helper change)
//     subsumes both — every target-side slot that isn't approved
//     rolls up into Needs Review.
//   • The axis chips (Source Fields / Target Fields) read from
//     `projectStats` — project-wide truth.
//   • `projectStats` is REQUIRED (no longer optional). Test fixtures
//     and callers pass `null` explicitly to render the empty state.
//
// Status-chip source (current — supersedes a since-removed PR-7 note
// that claimed the `counts` prop was dropped entirely):
//
//   • The Approved / Needs Review chips render `counts` when supplied,
//     falling back to `projectStats.target.{approved,needsReview}`
//     only when it is absent. `MappingContent` always supplies
//     `counts` — it passes `effectiveCounts`, the flat-row tally from
//     `flattenRowsForListView` + `countFlatRowStatuses` — so in
//     practice the chips render the flat-row counts.
//   • The flat-row tally is the intended source: it spans all four
//     row kinds (incl. unmapped-source), whereas `projectStats.target.*`
//     is target-axis-only and undercounts Needs Review. The
//     `projectStats` fallback exists purely for defensive rendering
//     when a caller omits `counts`.
//   • The Migration Center "Mapping Coverage" card counts over the
//     same `countFlatRowStatuses` helper, so the two surfaces agree.
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
  /** Project-wide axes (Source Fields / Target Fields chips) and the
   *  fallback source for the Approved / Needs Review chips when `counts`
   *  is absent.
   *
   *  Required (no longer optional) when the strip is rendered for a
   *  populated project. Pass `null` for the defensive empty-state
   *  fallback (renders the awaiting_data label). */
  projectStats: ProjectStats | null
  /** Flat-row status tally — when supplied, the PRIMARY source for the
   *  Approved / Needs Review chips (`projectStats.target.*` is the
   *  fallback). `MappingContent` always passes this as `effectiveCounts`,
   *  the `flattenRowsForListView` + `countFlatRowStatuses` projection,
   *  so the chips reflect all four row kinds rather than the
   *  target-axis-only `projectStats` numbers. */
  counts?: Pick<MappingCounts, 'total' | 'approved' | 'needsReview'>
  /** feat/mapping-list-toggle-and-columns: optional trailing slot
   *  rendered right-aligned on the same horizontal line as the
   *  summary chips. The mapping page passes `<ViewModeToggle />`
   *  here so the toggle reads as part of the summary toolbar rather
   *  than a separate row. Unset → strip renders unchanged.
   */
  trailing?: React.ReactNode
}

const STATE_LABEL: Record<ProjectStats['state'], string> = {
  awaiting_data: 'Awaiting data ingestion',
  data_ingested: 'Data ingested',
  mappings_generated: '',
}

export function MappingSummaryStrip({
  projectStats,
  counts,
  trailing,
}: MappingSummaryStripProps) {
  // State-aware empty: when the project hasn't generated mappings yet
  // (or projectStats is null defensively), the strip renders a single
  // state label instead of the axis + chip row. Wording matches the
  // PR-2 tile badge for visual continuity.
  const state = projectStats?.state ?? 'awaiting_data'
  const isPopulated = state === 'mappings_generated' && projectStats !== null
  const approvedCount = counts?.approved ?? projectStats?.target.approved ?? 0
  const needsReviewCount =
    counts?.needsReview ?? projectStats?.target.needsReview ?? 0

  if (!isPopulated) {
    return (
      <div
        data-testid="mapping-summary-strip"
        data-state={state}
        className="flex items-center justify-between bg-white px-5 py-2 flex-shrink-0"
      >
        <span
          data-testid="mapping-summary-empty-label"
          className="text-xs text-settle-slate-500"
        >
          {STATE_LABEL[state]}
        </span>
        {trailing ? (
          <div
            data-testid="mapping-summary-trailing"
            className="flex items-center"
          >
            {trailing}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      data-testid="mapping-summary-strip"
      data-state={state}
      className="flex items-center justify-between bg-white px-5 py-2 flex-shrink-0"
    >
      <div className="flex items-center gap-3 text-sm text-settle-slate-600">
        {/* PR-7: source-first axis order. Source side answers "what's
            decided?" (mapped ∪ acknowledged); target side answers
            "what's the migration scope?". Both render dot-less because
            they're denominator-style truth, not filter chips. */}
        <SummaryChip
          testId="mapping-summary-chip-project-source"
          label="Source Fields"
          ratio={`${projectStats.source.usedInMapping}/${projectStats.source.total}`}
        />
        <SummaryChipDivider />
        <SummaryChip
          testId="mapping-summary-chip-project-target"
          label="Target Fields"
          ratio={`${projectStats.target.usedInMapping}/${projectStats.target.schemaTotal}`}
        />
        <SummaryChipBlockDivider />
        {/* Status chips read row-status counts. Post-#157/#158/A2
            'rejected' rows are folded into the Needs Review number
            (Reject = reset — no distinct rejected semantic). */}
        {/* Linear-style polish: 8px fill + 2px ring @ 25% opacity for
            the hued summary dots. Mirrors `StatusDot` in
            MappingListView so the row-level and summary dots read
            identically (emerald approved, slate needs-review). */}
        <SummaryChip
          label="Approved"
          value={approvedCount}
          dotClassName="bg-emerald-500 ring-2 ring-emerald-500/25"
        />
        <SummaryChipDivider />
        <SummaryChip
          label="Needs Review"
          value={needsReviewCount}
          dotClassName="bg-slate-400 ring-2 ring-slate-400/25"
        />
      </div>
      {trailing ? (
        <div
          data-testid="mapping-summary-trailing"
          className="flex items-center"
        >
          {trailing}
        </div>
      ) : null}
    </div>
  )
}

function SummaryChip({
  testId,
  label,
  value,
  ratio,
  dotClassName,
}: {
  /** Override the default `mapping-summary-chip-<label>` test id —
   *  the consolidated PR-6 project-wide chips use stable testids so
   *  callers don't depend on label text. */
  testId?: string
  label: string
  /** Single-number value (status chips). */
  value?: number
  /** Ratio rendering "X/Y" (project-wide axes). Mutually exclusive
   *  with `value`. */
  ratio?: string
  /** Optional colored dot — project-wide chips are dot-less, status
   *  chips carry a hue. */
  dotClassName?: string
}) {
  const resolvedTestId =
    testId ?? `mapping-summary-chip-${label.toLowerCase().replace(/\s+/g, '-')}`
  // Phase 4-polish-1 comprehensive pass: dot-less chips drop the
  // `flex items-center gap-1.5` wrapper entirely — without a dot the
  // wrapper just adds an inline-block with no visual effect. Hued chips
  // keep the wrapper because they need it to align dot-with-text
  // vertically.
  const valueNode =
    ratio !== undefined ? (
      <span className="font-semibold text-settle-slate-900 tabular-nums">
        {ratio}
      </span>
    ) : (
      <span className="font-semibold text-settle-slate-900 tabular-nums">
        {value}
      </span>
    )
  if (!dotClassName) {
    return (
      <span data-testid={resolvedTestId}>
        {label} {valueNode}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5" data-testid={resolvedTestId}>
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full ${dotClassName}`}
      />
      <span>
        {label} {valueNode}
      </span>
    </span>
  )
}

function SummaryChipDivider() {
  return <span aria-hidden="true" className="text-settle-slate-300">·</span>
}

// PR-6: heavier separator between the project-wide axis pair and the
// grid-level status chip group. Conveys the conceptual boundary (left
// = project truth; right = filter chips) without a hard border.
function SummaryChipBlockDivider() {
  return (
    <span
      aria-hidden="true"
      className="text-settle-slate-300 px-1 select-none"
    >
      ║
    </span>
  )
}
