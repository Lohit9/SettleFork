import { cn } from '@/components/ui/utils'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  MappingTransformationStatus,
  TargetAcknowledgedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import { TableBadge } from './TableBadge'

// ─────────────────────────────────────────────────────────────────────────────
// FieldMappingRow — Phase 3 Gap 5a (Rules 1, 5, 6 + VA).
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders a single MappingRow per the canonical spec §Row design
// (docs/features/mapping-redesign.md lines ~695-784). This file is the
// rule-dispatch surface; column layout is shared across all kinds so the
// vertical scan across rows stays consistent regardless of mapping
// complexity.
//
// COLUMN LAYOUT (CSS grid, fixed template):
//
//   ┌──────────────────┬──────┬──────────────────┬────────┬─┐
//   │ source           │ conf │ target           │ status │T│
//   │ 1fr (flex)       │ 5rem │ 1fr (flex)       │ 8rem   │ │
//   └──────────────────┴──────┴──────────────────┴────────┴─┘
//
// Grid is used (vs. flex) so every row column aligns vertically down a
// target-table group — eyes can scan a column top-to-bottom without the
// shimmer that flex widths cause when neighboring content differs.
//
// KIND DISPATCH (strict):
//
//   'mapped'             → Rule 1 if sources.length === 1 (Heritage: 99/100)
//                        → Rule 1 FALLBACK when sources.length > 1 (Heritage:
//                          1/100 — the full_name concat_space row). Gap 5b
//                          adds Rule 2/3/4 + chevron. Intentionally ignores
//                          the non-dominant sources for now.
//   'value_assignment'   → Rule 1 visual; source slot shows "No source mapped"
//                          per founder Gap 4a §9 Q5 decision. VA SQL lives in
//                          the drawer (Gaps 7-10), NOT on the row.
//   'target_acknowledged'→ Rule 5. Em-dash source + confidence. Target name
//                          with "acknowledged[: reason]" subtitle.
//   'unmapped'           → Rule 6. Em-dash source + confidence. Bare target
//                          name, no subtitle.
//
// NOT rendered in Gap 5a (deferred):
//   • Chevron + in-place expansion (Gap 5b for Rule 2/3/4; Gap 6 sourced list)
//   • Row click → drawer open (Gaps 7-10)
//   • Approve / reject / remove action buttons
//   • Per-source join annotation on the collapsed row — spec §Row design
//     Rule 3 explicitly says "the badge divergence is sufficient signal
//     on the collapsed row; annotations surface when expanded"
//
// NOT rendered, moved to drawer:
//   • "required" NOT-NULL badge (Gap 3 amendment 2026-04-21 — 95% of
//     Heritage rows hit it, so it communicates nothing per-row.
//     `row.targetField.isNullable` stays on the contract — the drawer
//     header consumes it per spec §Drawer header lines 864-890)
//
// ─── NO-DARK-MODE INVARIANT (Gap 5a hotfix 2026-04-23) ───────────────────────
//
// This file MUST NOT use any Tailwind dark-prefix modifier (the
// `d-a-r-k` + colon variant, kept unspelled here so the grep
// invariant in `tests/lib/no-shim-in-redesign-path.test.ts`
// does not flag this comment). Reason:
//
//   Tailwind's default `darkMode` strategy is `'media'` (no `darkMode`
//   key in `tailwind.config.ts`). Under `'media'`, every dark-prefix
//   class fires automatically when the user's OS/browser reports
//   `prefers-color-scheme: dark` — there is no `.dark` class gate.
//
//   The rest of this application does NOT support dark mode:
//   • Legacy `MappingContent.tsx` uses zero dark-prefix modifiers.
//   • Redesign surfaces (`MappingContent.tsx`, `TargetTableGroup.tsx`,
//     `FilterRow.tsx`, `CountersRow`, all empty-state cards) all
//     hardcode light-mode backgrounds (`bg-white`, `bg-gray-50`, etc.)
//     with no corresponding dark background counterpart.
//   • Only `components/ui/*` (shadcn primitives) carry dark modifiers.
//
//   Result of mixing: a user on macOS with dark mode ON would see
//   a dark text-slate-100 variant fire (near-white text) over a
//   `bg-white` row (hardcoded, no dark variant) — near-white-on-white
//   text is what the 2026-04-23 smoke test surfaced. Gap 4c introduced
//   the regression; Gap 5a propagated it; this header lock prevents a
//   repeat.
//
//   If/when the app adopts dark mode app-wide, this file must be
//   revisited together with every sibling surface — not in isolation.
//
// The grep invariant enforces "no dark-prefix Tailwind class anywhere
// under `app/app/projects/[projectId]/mapping/redesign/`" at CI time.

interface FieldMappingRowProps {
  row: MappingRow
}

export function FieldMappingRow({ row }: FieldMappingRowProps) {
  return (
    <div
      role="listitem"
      data-testid="field-mapping-row"
      data-row-kind={row.kind}
      aria-label={buildAriaLabel(row)}
      className={cn(
        // Column template documented above; keep this literal in sync with
        // the ASCII figure in the file header.
        'grid grid-cols-[1fr_5rem_1fr_8rem_1.25rem] items-center gap-4 px-5 py-2.5',
      )}
    >
      <SourceCell row={row} />
      <ConfidenceCell confidence={row.confidence} />
      <TargetCell row={row} />
      <StatusChip status={row.status} />
      <TransformSlot row={row} />
    </div>
  )
}

// ─── Source cell (Rules 1 / 5 / 6 + VA dispatch) ─────────────────────────────

function SourceCell({ row }: { row: MappingRow }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedSourceCell row={row} />
    case 'value_assignment':
      return <ValueAssignmentSourceCell row={row} />
    case 'target_acknowledged':
    case 'unmapped':
      return <EmDashCell srLabel="no source mapped" />
  }
}

/**
 * Rule 1 source rendering. For Gap 5a, multi-source rows (mapped with
 * `sources.length > 1`) also land here and render only the dominant
 * source — Gap 5b layers Rule 2/3/4 on top.
 */
function MappedSourceCell({ row }: { row: MappedRow }) {
  if (row.sources.length === 0) {
    // Contract defense: a 'mapped' row without sources is a server-side
    // violation of the discriminated union (would be 'value_assignment'
    // or 'target_acknowledged' depending on combination_type /
    // is_acknowledged). Render em-dash rather than crashing.
    return <EmDashCell srLabel="no source mapped" />
  }

  const dominant = pickDominantSource(row.sources)
  // TODO(Gap 5b): replace single-source render with Rule 2/3/4 when
  // row.sources.length > 1. The additional sources are present on the
  // row but intentionally ignored by the Gap 5a visual — see the kind-
  // dispatch block comment at the top of this file.

  return (
    <div className="flex min-w-0 items-center gap-2">
      <TableBadge tableName={dominant.sourceTable.name} />
      <span
        className="truncate font-mono text-[13px] text-slate-700"
        title={dominant.sourceField.name}
      >
        {dominant.sourceField.name}
      </span>
    </div>
  )
}

function ValueAssignmentSourceCell({ row }: { row: ValueAssignmentRow }) {
  // Founder Gap 4a §9 Q5 (2026-04-22): VAs render as Rule 1 visually
  // EXCEPT the source slot shows "No source mapped" instead of a
  // TableBadge. The VA expression itself lives in the drawer (slim-drawer
  // decision, §Drawer).
  //
  // `row` kept in the signature (vs. destructured arg) so the component
  // stays consistent with its siblings and so Gap 7-10 can surface VA-
  // specific hover affordances without a signature change.
  void row
  return (
    <div className="flex min-w-0 items-center">
      <span className="truncate text-[13px] italic text-slate-500">
        No source mapped
      </span>
    </div>
  )
}

/**
 * Pick the dominant source. The contract (MappedRow JSDoc) guarantees
 * `sources` is sorted by ordinal ASC, so `sources[0]` is canonical. We
 * still scan for `ordinal === 0` defensively so a server-side sort
 * regression can't cause silent rendering of the wrong source. The
 * array is small (<= 10 in practice) — O(n) scan is fine.
 */
function pickDominantSource(sources: MappingSourceRef[]): MappingSourceRef {
  for (const s of sources) {
    if (s.ordinal === 0) return s
  }
  return sources[0]!
}

// ─── Confidence cell ─────────────────────────────────────────────────────────

function ConfidenceCell({ confidence }: { confidence: number | null }) {
  if (confidence === null) {
    return (
      <EmDashCell
        srLabel="no confidence available"
        align="right"
        className="tabular-nums text-xs"
      />
    )
  }
  return (
    <span className="text-right text-xs tabular-nums text-slate-500">
      {formatConfidence(confidence)}
    </span>
  )
}

/**
 * 2-decimal precision per Gap 4c spec. Accepts either a 0-100 integer
 * (legacy storage convention) or a 0-1 fraction (defensive — contract
 * documents the former but DB decimals can drift) and renders the 0-100
 * form with 2 decimals. Values >1 are assumed already 0-100.
 */
function formatConfidence(confidence: number): string {
  const normalized = confidence > 1 ? confidence : confidence * 100
  return `${normalized.toFixed(2)}%`
}

// ─── Target cell (shared across all kinds, with Rule 5 subtitle) ─────────────

function TargetCell({ row }: { row: MappingRow }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span
        className="truncate font-mono text-sm font-medium text-slate-900"
        title={row.targetField.name}
      >
        {row.targetField.name}
      </span>
      {row.kind === 'target_acknowledged' ? (
        <AcknowledgedSubtitle row={row} />
      ) : null}
    </div>
  )
}

function AcknowledgedSubtitle({ row }: { row: TargetAcknowledgedRow }) {
  // Spec §Row design Rule 5:
  //   —                    —    target_field_name
  //                              (acknowledged: reason_text)
  //
  // Parentheses in the spec are visual; we drop them in favor of a
  // muted, italicized subtitle keyed for screen readers.
  const text = row.acknowledgmentReason
    ? `acknowledged: ${row.acknowledgmentReason}`
    : 'acknowledged'
  return (
    <span
      className="truncate text-xs italic text-slate-500"
      title={text}
    >
      {text}
    </span>
  )
}

// ─── Em-dash cell (shared placeholder for Rules 5 & 6 & VA-adjacent) ─────────

/**
 * Visible em-dash with a screen-reader-only description. Callers pass
 * an `srLabel` appropriate to the column ("no source mapped" vs. "no
 * confidence available").
 */
function EmDashCell({
  srLabel,
  align = 'left',
  className,
}: {
  srLabel: string
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <span
      aria-label={srLabel}
      className={cn(
        'inline-flex items-center text-slate-400',
        align === 'right' ? 'justify-end text-right' : 'justify-start',
        className,
      )}
    >
      <span aria-hidden="true">—</span>
    </span>
  )
}

// ─── Status chip (dot + label) ───────────────────────────────────────────────
// Matches legacy MappingContent.tsx:95-121 visual vocabulary exactly so the
// redesign and legacy pages read consistently during the Phase 3 rollout.

type RowStatus = MappingRow['status']

function StatusChip({ status }: { status: RowStatus }) {
  const config = STATUS_CONFIG[status]
  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`status: ${config.label}`}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', config.dotClassName)}
      />
      <span className={cn('text-xs', config.labelClassName)}>{config.label}</span>
    </div>
  )
}

const STATUS_CONFIG: Record<
  RowStatus,
  { label: string; dotClassName: string; labelClassName: string }
> = {
  approved: {
    label: 'Approved',
    dotClassName: 'bg-green-500',
    labelClassName: 'text-settle-slate-500',
  },
  needs_review: {
    label: 'Needs Review',
    dotClassName: 'bg-amber-400',
    labelClassName: 'text-settle-slate-500',
  },
  rejected: {
    label: 'Rejected',
    dotClassName: 'bg-red-500',
    labelClassName: 'text-settle-slate-400',
  },
  unmapped: {
    label: 'Unmapped',
    dotClassName: 'bg-settle-slate-300',
    labelClassName: 'text-settle-slate-400',
  },
}

// ─── Transformation indicator slot ───────────────────────────────────────────
// The transformations FK is EITHER the TFM id (mapped) OR NULL (VA/ack/
// unmapped). Rule 5/6 rows never have a transformation; Rule 1 / VA rows
// may. Render the dot only when `hasTransformation === true` so the grid
// cell width is still claimed (keeps columns aligned) even when empty.

function TransformSlot({ row }: { row: MappingRow }) {
  if (!row.hasTransformation) {
    return <span aria-hidden="true" />
  }
  return <TransformationIndicator status={row.transformationStatus} />
}

function TransformationIndicator({
  status,
}: {
  status: MappingTransformationStatus | null
}) {
  const { className, label } = TRANSFORM_INDICATOR_CONFIG[status ?? 'draft']
  return (
    <span
      aria-label={`transformation: ${label}`}
      title={`Transformation ${label}`}
      className={cn('inline-block h-1.5 w-1.5 rounded-full', className)}
    />
  )
}

const TRANSFORM_INDICATOR_CONFIG: Record<
  MappingTransformationStatus,
  { className: string; label: string }
> = {
  applied: { className: 'bg-green-500', label: 'applied' },
  stale: { className: 'bg-red-500', label: 'stale' },
  draft: { className: 'bg-amber-400', label: 'draft' },
  tested: { className: 'bg-amber-400', label: 'tested' },
  saved: { className: 'bg-amber-400', label: 'saved' },
}

// ─── A11y helper ─────────────────────────────────────────────────────────────

/**
 * Full-sentence aria-label describing the row so screen readers can
 * announce a row's semantic content without hunting across columns.
 *
 * Examples:
 *   "ACCT_MASTER.ACCT_NO mapped to accounts.account_id at 98% confidence,
 *    approved"
 *   "accounts.created_at value assignment at 95% confidence, approved"
 *   "customers.internal_flag acknowledged as not migratable: system default"
 *   "accounts.new_field not yet mapped"
 */
function buildAriaLabel(row: MappingRow): string {
  const targetQualified = `${row.targetField.targetTable.name}.${row.targetField.name}`
  const confPhrase =
    row.confidence !== null
      ? ` at ${formatConfidence(row.confidence)} confidence`
      : ''
  const statusPhrase = `, ${STATUS_CONFIG[row.status].label.toLowerCase()}`

  switch (row.kind) {
    case 'mapped': {
      const dominant = pickDominantSource(row.sources)
      const sourceQualified = dominant
        ? `${dominant.sourceTable.name}.${dominant.sourceField.name}`
        : 'unknown source'
      const multi =
        row.sources.length > 1 ? ` (+${row.sources.length - 1} more)` : ''
      return `${sourceQualified}${multi} mapped to ${targetQualified}${confPhrase}${statusPhrase}`
    }
    case 'value_assignment':
      return `${targetQualified} value assignment${confPhrase}${statusPhrase}`
    case 'target_acknowledged': {
      return buildAckAriaLabel(row, targetQualified)
    }
    case 'unmapped':
      return `${targetQualified} not yet mapped`
  }
}

function buildAckAriaLabel(row: TargetAcknowledgedRow, targetQualified: string): string {
  const reasonPhrase = row.acknowledgmentReason
    ? `: ${row.acknowledgmentReason}`
    : ''
  return `${targetQualified} acknowledged as not migratable${reasonPhrase}`
}
