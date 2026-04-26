'use client'

import { useId, useState } from 'react'
import { cn } from '@/components/ui/utils'
import { ChevronDown, ChevronRight } from '@/components/icons'
import { formatConfidencePercent } from '@/lib/utils/confidence-format'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  MappingTransformationStatus,
  TargetAcknowledgedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import { classifyMappedRow, type MappingRowRule } from '@/lib/utils/mapping-row-rules'
import { TableBadge } from './TableBadge'
import { ExpandedSourceList } from './ExpandedSourceList'

// ─────────────────────────────────────────────────────────────────────────────
// FieldMappingRow — Phase 3 Gap 5a + 5b.
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders a single MappingRow per the canonical spec §Row design
// (docs/features/mapping-redesign.md lines ~695-784). This file is the
// rule-dispatch surface; column layout is shared across all kinds so the
// vertical scan across rows stays consistent regardless of mapping
// complexity.
//
// COLUMN LAYOUT (CSS grid, fixed template — 6 columns, Gap 5b):
//
//   ┌──────────────────┬──────┬──────────────────┬────────┬─┬─┐
//   │ source           │ conf │ target           │ status │T│C│
//   │ 1fr (flex)       │ 5rem │ 1fr (flex)       │ 8rem   │ │ │
//   └──────────────────┴──────┴──────────────────┴────────┴─┴─┘
//                                                          ↑  ↑
//                                       transformation dot ─┘  │
//                                                chevron (Gap 5b)
//
// Chevron column added in Gap 5b. Claimed by every row (empty span for
// Rule 1 / 5 / 6 / VA) so column alignment stays consistent down a group.
//
// KIND DISPATCH (strict):
//
//   'mapped'             → Rule 1 / 2 / 3 / 4 determined by
//                          `classifyMappedRow(sources)` (lib/utils/mapping-
//                          row-rules.ts). Rule 2/3/4 expose a chevron and
//                          an ExpandedSourceList below the collapsed row.
//   'value_assignment'   → Rule 1 visual; source slot shows "No source mapped"
//                          per founder Gap 4a §9 Q5 decision. VA SQL lives in
//                          the drawer (Gaps 7-10), NOT on the row.
//   'target_acknowledged'→ Rule 5. Em-dash source + confidence. Target name
//                          with "acknowledged[: reason]" subtitle.
//   'unmapped'           → Rule 6. Em-dash source + confidence. Bare target
//                          name, no subtitle.
//
// EXPANSION SEMANTICS (Gap 5b, spec §Expanded view):
//   • Chevron toggles per-row local state (useState, NOT URL-synced).
//   • Default collapsed.
//   • Chevron click stops propagation so Gaps 7-10 can layer row-body →
//     drawer-open click on top without conflict.
//   • Expand uses a CSS grid-rows trick (0fr ↔ 1fr) for smooth 150ms
//     animation without JS height measurement.
//   • aria-expanded + aria-controls wired on the chevron button.
//
// NOT rendered in Gap 5b (deferred):
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
  /**
   * Phase 3 Gap 7 — drawer-open trigger. When provided, the row body
   * becomes a `role="button"` keyboard-and-mouse-clickable surface that
   * invokes this callback with `row.id`. The chevron continues to
   * `stopPropagation` so chevron clicks toggle the in-place expansion
   * without bubbling here.
   *
   * Omitted in fixtures and storybook scenarios that render rows
   * without a drawer host (e.g. legacy MappingContent never sets this).
   */
  onRowClick?: (rowId: string) => void
  /**
   * Phase 3 Gap 7 — drawer-open visual highlight. When `true`, the row
   * body gets a subtle `bg-slate-50` tint to anchor the user's eye to
   * the row whose drawer is open. Provided by the parent based on its
   * own drawer state (`drawerRowId === row.id`).
   */
  isActive?: boolean
  /**
   * Phase 3 Gap 11b — source-schema sidebar highlight. When `true`,
   * the row body gets a 2 px blue left border so the user can spot
   * every main-view row that consumes the source field they clicked
   * in the sidebar. Distinct from `isActive` (drawer-open) so the two
   * states can coexist on the same row without visual conflict.
   *
   * Combined with `data-highlighted-row="true"` on the body element so
   * the parent's click-outside listener can treat clicks ON the
   * highlight as "stay highlighted" rather than "clear."
   */
  isHighlighted?: boolean
}

export function FieldMappingRow({
  row,
  onRowClick,
  isActive,
  isHighlighted,
}: FieldMappingRowProps) {
  const expandedId = useId()
  const rule = resolveMappedRule(row)
  const canExpand = rule === 'rule_2' || rule === 'rule_3' || rule === 'rule_4'
  const [isExpanded, setIsExpanded] = useState(false)
  const isClickable = onRowClick !== undefined

  const handleActivate = isClickable
    ? () => onRowClick!(row.id)
    : undefined

  const handleKeyDown = isClickable
    ? (e: React.KeyboardEvent<HTMLDivElement>) => {
        // Only swallow Enter / Space when the activation target is the row
        // body itself — chevron / future drawer-internal buttons should
        // continue to receive their own keyboard events.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onRowClick!(row.id)
        }
      }
    : undefined

  return (
    <div
      role="listitem"
      data-testid="field-mapping-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-row-rule={row.kind === 'mapped' ? rule : undefined}
      aria-label={buildAriaLabel(row, rule, isExpanded, isClickable)}
    >
      <div
        data-testid="field-mapping-row-body"
        data-highlighted-row={isHighlighted ? 'true' : undefined}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        className={cn(
          // Column template documented above; keep this literal in sync with
          // the ASCII figure in the file header.
          'grid grid-cols-[1fr_5rem_1fr_8rem_1.25rem_1rem] items-center gap-4 px-5 py-2.5',
          isClickable && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300',
          isActive && 'bg-slate-50',
          isHighlighted && 'border-l-2 border-blue-500',
        )}
      >
        <SourceCell row={row} rule={rule} />
        <ConfidenceCell confidence={row.confidence} />
        <TargetCell row={row} />
        <StatusChip status={row.status} />
        <TransformSlot row={row} />
        <ChevronSlot
          canExpand={canExpand}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((v) => !v)}
          expandedId={expandedId}
        />
      </div>
      {canExpand && row.kind === 'mapped' ? (
        <ExpansionRegion isExpanded={isExpanded}>
          <ExpandedSourceList
            id={expandedId}
            sources={row.sources}
            // Type narrowing: canExpand excludes rule_1.
            rule={rule as Exclude<MappingRowRule, 'rule_1'>}
          />
        </ExpansionRegion>
      ) : null}
    </div>
  )
}

// ─── Rule resolution ─────────────────────────────────────────────────────────

/**
 * Rule classification is meaningful only for 'mapped' rows. Other kinds
 * have a fixed layout; we still return 'rule_1' as a harmless sentinel so
 * the caller can keep a single variable + switch.
 */
function resolveMappedRule(row: MappingRow): MappingRowRule {
  if (row.kind !== 'mapped' || row.sources.length < 1) return 'rule_1'
  return classifyMappedRow(row.sources)
}

// ─── Source cell (kind + rule dispatcher) ────────────────────────────────────

function SourceCell({ row, rule }: { row: MappingRow; rule: MappingRowRule }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedSourceCell row={row} rule={rule} />
    case 'value_assignment':
      return <ValueAssignmentSourceCell row={row} />
    case 'target_acknowledged':
    case 'unmapped':
      return <EmDashCell srLabel="no source mapped" />
  }
}

function MappedSourceCell({ row, rule }: { row: MappedRow; rule: MappingRowRule }) {
  if (row.sources.length === 0) {
    // Contract defense: a 'mapped' row without sources is a server-side
    // violation of the discriminated union (would be 'value_assignment'
    // or 'target_acknowledged' depending on combination_type /
    // is_acknowledged). Render em-dash rather than crashing.
    return <EmDashCell srLabel="no source mapped" />
  }

  switch (rule) {
    case 'rule_1':
      return <Rule1SourceRender source={pickDominantSource(row.sources)} />
    case 'rule_2':
      return <Rule2SourceRender sources={row.sources} />
    case 'rule_3':
      return <Rule3SourceRender sources={row.sources} />
    case 'rule_4':
      return <Rule4SourceRender sources={row.sources} />
  }
}

function Rule1SourceRender({ source }: { source: MappingSourceRef }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TableBadge tableName={source.sourceTable.name} />
      <span
        className="truncate font-mono text-[13px] text-slate-700"
        title={source.sourceField.name}
      >
        {source.sourceField.name}
      </span>
    </div>
  )
}

/**
 * Rule 2 — multi-source, same table: one badge + comma-separated field names.
 * The classifier guarantees all sources share a `sourceTable.id` when this
 * renderer fires; we still read from `sources[0].sourceTable.name` (cheaper
 * than a Set lookup) — every element has the same value by definition.
 */
function Rule2SourceRender({ sources }: { sources: MappingSourceRef[] }) {
  const fieldList = sources.map((s) => s.sourceField.name).join(', ')
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TableBadge tableName={sources[0]!.sourceTable.name} />
      <span
        className="truncate font-mono text-[13px] text-slate-700"
        title={fieldList}
      >
        {fieldList}
      </span>
    </div>
  )
}

/**
 * Rule 3 — cross-table, two tables: `[Badge] fields, [Badge] fields` where
 * the groups are derived by walking sources in ORDINAL ORDER and starting a
 * new group whenever the adjacent source's `sourceTable.id` differs.
 *
 * Why ordinal-order grouping (vs. group-by-table-then-sort):
 *   • Contract forbids consumer-side re-sorting of the sources array.
 *   • The server's ordinal ordering is canonical — non-dominant sources get
 *     higher ordinals regardless of table, so natural grouping usually
 *     already produces `[A] fields, [B] fields`.
 *   • On the rare interleaved case (A, B, A) the user sees exactly what
 *     the server-side state describes — no hidden reshuffling.
 */
function Rule3SourceRender({ sources }: { sources: MappingSourceRef[] }) {
  const groups = groupAdjacentSourcesByTable(sources)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {groups.map((g, i) => (
        <div key={`${g.tableId}-${i}`} className="flex min-w-0 items-center gap-2">
          <TableBadge tableName={g.tableName} />
          <span
            className="truncate font-mono text-[13px] text-slate-700"
            title={g.fields.join(', ')}
          >
            {g.fields.join(', ')}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Rule 4 — summary line. No badges, no field names inline. The full roster
 * lives in the ExpandedSourceList. Numbers use `tabular-nums` so the column
 * stays steady across rows of similar shape.
 */
function Rule4SourceRender({ sources }: { sources: MappingSourceRef[] }) {
  const tableCount = new Set(sources.map((s) => s.sourceTable.id)).size
  const fieldCount = sources.length
  const summary = `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} across ${tableCount} ${tableCount === 1 ? 'table' : 'tables'}`
  return (
    <div className="flex min-w-0 items-center">
      <span
        className="truncate text-[13px] tabular-nums text-slate-500"
        title={summary}
      >
        {summary}
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

/**
 * Walk `sources` in order, opening a new group whenever the next source's
 * `sourceTable.id` differs from the previous. Returns groups with the table
 * name and the ordered field-name list per group.
 *
 * Contract-safe: no consumer-side sorting; the output faithfully mirrors the
 * server's ordinal order.
 */
interface SourceGroup {
  tableId: string
  tableName: string
  fields: string[]
}
function groupAdjacentSourcesByTable(sources: MappingSourceRef[]): SourceGroup[] {
  const out: SourceGroup[] = []
  for (const s of sources) {
    const last = out[out.length - 1]
    if (last && last.tableId === s.sourceTable.id) {
      last.fields.push(s.sourceField.name)
    } else {
      out.push({
        tableId: s.sourceTable.id,
        tableName: s.sourceTable.name,
        fields: [s.sourceField.name],
      })
    }
  }
  return out
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
      {formatConfidencePercent(confidence)}
    </span>
  )
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

// ─── Chevron slot (Gap 5b) ───────────────────────────────────────────────────

/**
 * Column 6 — chevron button for Rule 2/3/4. Rule 1 / 5 / 6 / VA rows render
 * an empty span so the grid column stays claimed and vertical alignment is
 * preserved down a group.
 *
 * Click handler calls `stopPropagation` so Gaps 7-10 can layer a row-body
 * click (→ drawer open) without the chevron interfering. `aria-expanded` +
 * `aria-controls` wire the button to the ExpandedSourceList for screen
 * readers.
 */
function ChevronSlot({
  canExpand,
  isExpanded,
  onToggle,
  expandedId,
}: {
  canExpand: boolean
  isExpanded: boolean
  onToggle: () => void
  expandedId: string
}) {
  if (!canExpand) {
    return <span aria-hidden="true" />
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      aria-expanded={isExpanded}
      aria-controls={expandedId}
      aria-label={isExpanded ? 'Hide source details' : 'Show source details'}
      data-testid="field-mapping-row-chevron"
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded',
        'text-slate-400 transition-colors hover:text-slate-700',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
      )}
    >
      {isExpanded ? (
        <ChevronDown className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </button>
  )
}

// ─── Expansion region (animated) ─────────────────────────────────────────────

/**
 * Collapses content to 0 height when `isExpanded=false`, animates to full
 * height otherwise. Uses the CSS grid-rows 0fr↔1fr trick so we never have
 * to measure DOM heights in JS. 150ms matches the spec's "subtle" guidance.
 *
 * Always renders the child (not conditionally) so:
 *   • `aria-controls` on the chevron always resolves to a real DOM node
 *   • The expand animation has content to animate in on first click
 *
 * `aria-hidden` is flipped with the state so screen readers ignore the
 * collapsed region.
 */
function ExpansionRegion({
  isExpanded,
  children,
}: {
  isExpanded: boolean
  children: React.ReactNode
}) {
  return (
    <div
      aria-hidden={!isExpanded}
      className="grid transition-[grid-template-rows] duration-150 ease-out"
      style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
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
 *
 * Gap 5b addition: multi-source rows (Rule 2/3/4) gain a count phrase
 * ("N source fields across M tables") + expansion state ("currently
 * collapsed" / "currently expanded"). Rule 1 and non-mapped kinds are
 * unchanged so existing expectations stay stable.
 */
function buildAriaLabel(
  row: MappingRow,
  rule: MappingRowRule,
  isExpanded: boolean,
  isClickable: boolean,
): string {
  const targetQualified = `${row.targetField.targetTable.name}.${row.targetField.name}`
  const confPhrase =
    row.confidence !== null
      ? ` at ${formatConfidencePercent(row.confidence)} confidence`
      : ''
  const statusPhrase = `, ${STATUS_CONFIG[row.status].label.toLowerCase()}`

  // Gap 7: append a click-affordance hint so screen readers signal that
  // the row is interactable beyond simple description. Suffix only applies
  // when `onRowClick` was provided (legacy callers without a drawer host
  // keep their pre-Gap-7 aria-labels verbatim).
  const clickPhrase = isClickable ? ' — click to open details' : ''

  switch (row.kind) {
    case 'mapped': {
      if (rule === 'rule_1') {
        const dominant = pickDominantSource(row.sources)
        const sourceQualified = dominant
          ? `${dominant.sourceTable.name}.${dominant.sourceField.name}`
          : 'unknown source'
        return `${sourceQualified} mapped to ${targetQualified}${confPhrase}${statusPhrase}${clickPhrase}`
      }
      // Rule 2/3/4: summary phrase + expansion state.
      const tableCount = new Set(row.sources.map((s) => s.sourceTable.id)).size
      const fieldCount = row.sources.length
      const countPhrase = `mapped from ${fieldCount} source ${fieldCount === 1 ? 'field' : 'fields'} across ${tableCount} ${tableCount === 1 ? 'table' : 'tables'}`
      const expandPhrase = `, currently ${isExpanded ? 'expanded' : 'collapsed'}`
      return `${targetQualified} ${countPhrase}${confPhrase}${statusPhrase}${expandPhrase}${clickPhrase}`
    }
    case 'value_assignment':
      return `${targetQualified} value assignment${confPhrase}${statusPhrase}${clickPhrase}`
    case 'target_acknowledged': {
      return buildAckAriaLabel(row, targetQualified) + clickPhrase
    }
    case 'unmapped':
      return `${targetQualified} not yet mapped${clickPhrase}`
  }
}

function buildAckAriaLabel(row: TargetAcknowledgedRow, targetQualified: string): string {
  const reasonPhrase = row.acknowledgmentReason
    ? `: ${row.acknowledgmentReason}`
    : ''
  return `${targetQualified} acknowledged as not migratable${reasonPhrase}`
}
