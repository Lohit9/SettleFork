'use client'

import { useId, useState } from 'react'
import { cn } from '@/components/ui/utils'
import { ChevronDown, ChevronRight } from '@/components/icons'
import {
  classifyRowConfidence,
  formatConfidencePercent,
  type RowConfidenceBand,
} from '@/lib/utils/confidence-format'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
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
// COLUMN LAYOUT (CSS grid, fixed template — 5 columns, Phase 4-polish-1
// final refinements pass):
//
//   ┌─┬─────────┬─────────────────┬──────────────┬─────────┐
//   │S│ src tbl │ src field [▸/▾] │ target field │  conf%  │
//   │ │ 6-8rem  │ 8-14rem         │ 1fr (flex)   │ 5rem    │
//   └─┴─────────┴─────────────────┴──────────────┴─────────┘
//    ↑                ↑                            ↑
//    status dot —     │                            │
//    label dropped,   │                            │
//    aria + tooltip   │                            │
//    preserved        │                            │
//                     │                       confidence percent
//                     │                       (integer-rounded post
//                     │                       Refinement H), right-
//                     │                       aligned. No trailing
//                     │                       transform indicator
//                     │                       (Refinement F: dropped).
//                     │
//        inline expand chevron rendered in col 3 next to the field-
//        name render — multi-source rows only (Rule 2/3/4). Single-
//        source rows render no chevron. Refinement G (2026-04-26).
//
// Comprehensive pass changes vs. the prior 7-column layout:
//
//   • Col 2 tightened from `minmax(7rem, 12rem)` to `minmax(6rem, 8rem)`.
//     Heritage's longest source-table badge is 12 chars (`STATUS_CODES`,
//     `ACCT_TYPE_CD`, …) which renders to ~5.7rem at the badge's
//     `text-[11px] font-mono` density — `min 6rem` accommodates with a
//     hair of breathing room, `max 8rem` caps growth so the source
//     group reads as a tight unit. Extra-long badges (>14 chars, none
//     exist in Heritage) still truncate gracefully via `TableBadge`'s
//     own `max-w-[14rem]` + title= tooltip.
//   • The dedicated 5rem actions column was DROPPED. The original
//     justification (host inline ✓/✗ buttons in Phase 4-polish-3) was
//     reframed: 4-polish-3 buttons land as a hover-only overlay
//     (absolute-positioned), not as a structural column. Reserving 5rem
//     of resting whitespace for a hover-only affordance was wrong.
//   • Refinement F (final pass, 2026-04-26): the row-level transform
//     indicator was REMOVED entirely. Earlier passes relocated the
//     dot inline into the confidence cell (slate-400 muted treatment);
//     canary review found it too subtle to convey meaning, and a
//     saturated hue would have stolen disproportionate attention from
//     the percent number. The drawer's Transformation section is now
//     the single source of truth for transform status — the row data
//     plane (`hasTransformation`, `transformationStatus`) remains
//     intact for non-row consumers.
//
// Why the constrained source-field column (Refinement 4, retained)?
// Spreading both source-field (col 3) and target-field (col 4) as `1fr`
// pushed the source-table badge (col 2) far away from the source-field
// name (col 3) at wide viewports — the eye lost the "source side /
// target side" grouping. Capping col 3 at 14rem keeps the source group
// visually adjacent and lets the target column own the bulk of the
// remaining horizontal space, conveying source→target flow via
// whitespace alone (no per-row arrow needed).
//
// Status dot collapses the legacy "dot + label" chip into just the dot
// per founder Q1 lock — the label was visual noise on Heritage where
// 90%+ of rows are approved. The aria-label preserves screen-reader
// semantics ("status: Approved") so AT users lose nothing.
//
// Refinement G (final pass, 2026-04-26): the dedicated chevron column
// (col 6, 1rem) was DROPPED. The expand chevron now renders inline in
// col 3 (source field area) for multi-source rows only. Single-source
// rows render no chevron. Row-body click continues to open the drawer
// (when `onRowClick` is wired); the chevron's stopPropagation isolates
// "click to expand sources" from "click to open drawer" — visually
// adjacent to the field list it controls, semantically distinct from
// the row-body affordance. The 5-col grid template is the canonical
// post-refinement layout: status, src tbl, src field+chevron, target,
// confidence.
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

  // Refinement 4 (Phase 4-polish-1 final-final, 2026-04-26): empty
  // rows (unmapped + target_acknowledged) fade to opacity-70 so the
  // eye skips past them when scanning for actionable mappings. They
  // stay readable (still ~70% contrast) and the status dot's color +
  // hover tooltip remain the at-a-glance disambiguators. Mapped /
  // value-assignment rows render at full opacity (1.0) — these are
  // the rows users act on.
  //
  // Trade-off: opacity is multiplicative, so the status dot fades
  // along with the rest of the row. Acceptable — the dot at 70% is
  // still clearly visible and the title=tooltip lets a hovering user
  // disambiguate without relying on the dot color alone. Honoring
  // the "dot stays full opacity" qualifier would require either an
  // opacity arbitrary-selector exception (e.g. `[&>*:not(.dot)]:
  // opacity-70`) or rewiring the grid; both are heavier than the
  // signal warrants.
  const isEmptyRow = row.kind === 'target_acknowledged' || row.kind === 'unmapped'

  return (
    <div
      role="listitem"
      data-testid="field-mapping-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-row-rule={row.kind === 'mapped' ? rule : undefined}
      aria-label={buildAriaLabel(row, rule, isExpanded, isClickable)}
      className={cn(isEmptyRow && 'opacity-70')}
    >
      <div
        data-testid="field-mapping-row-body"
        data-highlighted-row={isHighlighted ? 'true' : undefined}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        className={cn(
          // Column template documented above; keep this literal in sync
          // with the ASCII figure in the file header. The column-template
          // invariant test in `tests/components/field-mapping-row-column-
          // template.test.ts` regex-asserts this exact literal — update
          // both together if the layout shifts again.
          //
          // Refinement G (Phase 4-polish-1 final, 2026-04-26): the
          // dedicated col 6 (chevron column) was DROPPED. The expand
          // chevron now renders inline in col 3 (source field) for
          // multi-source rows only. Single-source rows have no chevron.
          // Template went from 6 cols → 5 cols.
          'grid grid-cols-[0.75rem_minmax(6rem,8rem)_minmax(8rem,14rem)_1fr_5rem] items-center gap-3 px-5 py-1.5',
          isClickable && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300',
          isActive && 'bg-slate-50',
          isHighlighted && 'border-l-2 border-blue-500',
        )}
      >
        <StatusDot status={row.status} kind={row.kind} />
        <SourceTableCell row={row} rule={rule} />
        <div className="flex min-w-0 items-center gap-1.5">
          <SourceFieldCell row={row} rule={rule} />
          {canExpand ? (
            <InlineExpandChevron
              isExpanded={isExpanded}
              onToggle={() => setIsExpanded((v) => !v)}
              expandedId={expandedId}
            />
          ) : null}
        </div>
        <TargetCell row={row} />
        <ConfidenceCell row={row} />
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

// ─── Source-table cell (column 2 — kind + rule dispatcher) ──────────────────
//
// Renders ONLY the table chip(s). Field names live in `SourceFieldCell`
// (column 3) so the visual columns line up across all rules. Splitting the
// legacy single-cell layout into table-then-field is the core Phase
// 4-polish-1 restoration — it's what gives the user a fast "table column"
// scan path down a group without sacrificing field-name legibility.

function SourceTableCell({ row, rule }: { row: MappingRow; rule: MappingRowRule }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedSourceTableCell row={row} rule={rule} />
    case 'value_assignment':
      // VAs have no source table; an em-dash here matches the Rule 5/6
      // visual vocabulary so the table column reads consistently.
      return <EmDashCell srLabel="no source table" />
    case 'target_acknowledged':
    case 'unmapped':
      return <EmDashCell srLabel="no source mapped" />
  }
}

function MappedSourceTableCell({ row, rule }: { row: MappedRow; rule: MappingRowRule }) {
  if (row.sources.length === 0) {
    // Contract defense — see SourceFieldCell for the same guard.
    return <EmDashCell srLabel="no source mapped" />
  }
  switch (rule) {
    case 'rule_1':
      return (
        <div className="flex min-w-0 items-center">
          <TableBadge tableName={pickDominantSource(row.sources).sourceTable.name} />
        </div>
      )
    case 'rule_2':
      return (
        <div className="flex min-w-0 items-center">
          <TableBadge tableName={row.sources[0]!.sourceTable.name} />
        </div>
      )
    case 'rule_3':
      // Up to N badges horizontally, one per group. The grid column is
      // capped at 8rem (Phase 4-polish-1 comprehensive pass) so very wide
      // cross-table mappings will truncate aggressively — TableBadge
      // already truncates per-name with title= tooltip, so the cell
      // stays single-row and scannable.
      return <Rule3TableBadges sources={row.sources} />
    case 'rule_4':
      // 3+ tables: founder-locked decision Q1 — empty badge cell, the
      // summary phrase ("N fields across M tables") owns the field column.
      return <span aria-hidden="true" />
  }
}

function Rule3TableBadges({ sources }: { sources: MappingSourceRef[] }) {
  const groups = groupAdjacentSourcesByTable(sources)
  return (
    <div className="flex min-w-0 items-center gap-1">
      {groups.map((g, i) => (
        <TableBadge
          key={`${g.tableId}-${i}`}
          tableName={g.tableName}
          // Tightened from `max-w-[6rem]` to `max-w-[3.5rem]` (Phase
          // 4-polish-1 comprehensive pass) when col 2 narrowed from
          // `minmax(7rem, 12rem)` to `minmax(6rem, 8rem)`. Two side-by-
          // side badges with `gap-1` (4px) need to fit inside 8rem ≈
          // 128px → ~62px per badge → ~7 chars before truncation.
          // Heritage Rule 3 names truncate to e.g. `STATUS…` with the
          // full name still surfaced via TableBadge's title= tooltip.
          className="max-w-[3.5rem]"
        />
      ))}
    </div>
  )
}

// ─── Source-field cell (column 3 — kind + rule dispatcher) ──────────────────

function SourceFieldCell({ row, rule }: { row: MappingRow; rule: MappingRowRule }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedSourceFieldCell row={row} rule={rule} />
    case 'value_assignment':
      return <ValueAssignmentSourceFieldCell row={row} />
    case 'target_acknowledged':
    case 'unmapped':
      // Rule 5/6 — em-dash in field column too. The aria-label here is
      // distinct from the table-column em-dash so screen readers don't
      // hear the same phrase twice.
      return <EmDashCell srLabel="no source field" />
  }
}

function MappedSourceFieldCell({ row, rule }: { row: MappedRow; rule: MappingRowRule }) {
  if (row.sources.length === 0) {
    // Contract defense: a 'mapped' row without sources is a server-side
    // violation of the discriminated union (would be 'value_assignment'
    // or 'target_acknowledged' depending on combination_type /
    // is_acknowledged). Render em-dash rather than crashing.
    return <EmDashCell srLabel="no source field" />
  }
  switch (rule) {
    case 'rule_1':
      return <Rule1FieldRender source={pickDominantSource(row.sources)} />
    case 'rule_2':
      return <Rule2FieldRender sources={row.sources} />
    case 'rule_3':
      return <Rule3FieldRender sources={row.sources} />
    case 'rule_4':
      return <Rule4FieldRender sources={row.sources} />
  }
}

function Rule1FieldRender({ source }: { source: MappingSourceRef }) {
  return (
    <span
      className="block truncate font-mono text-[13px] font-normal text-slate-900"
      title={source.sourceField.name}
    >
      {source.sourceField.name}
    </span>
  )
}

/**
 * Rule 2 — multi-source, same table: comma-separated field names. The
 * shared table name lives in `SourceTableCell`; this column owns the
 * field-list rendering only.
 */
function Rule2FieldRender({ sources }: { sources: MappingSourceRef[] }) {
  const fieldList = sources.map((s) => s.sourceField.name).join(', ')
  return (
    <span
      className="block truncate font-mono text-[13px] font-normal text-slate-900"
      title={fieldList}
    >
      {fieldList}
    </span>
  )
}

/**
 * Rule 3 — cross-table, two tables: groups of comma-separated field names
 * separated by a thin middle dot. Walks sources in ORDINAL ORDER (no
 * consumer-side resort) and starts a new group whenever the adjacent
 * source's `sourceTable.id` differs.
 *
 * Why per-group spans (vs. one flat string):
 *   • Tests assert `getByText('FNAME, LNAME')` and `getByText('EMAIL')`
 *     as distinct text nodes — the legacy contract preserved here.
 *   • A future a11y polish can wrap each group in its own
 *     `aria-describedby` linking back to the corresponding badge.
 */
function Rule3FieldRender({ sources }: { sources: MappingSourceRef[] }) {
  const groups = groupAdjacentSourcesByTable(sources)
  return (
    <div className="flex min-w-0 items-center gap-2 truncate">
      {groups.map((g, i) => (
        <span key={`${g.tableId}-${i}`} className="flex min-w-0 items-center gap-2">
          {i > 0 ? (
            <span aria-hidden="true" className="flex-shrink-0 text-slate-300">
              ·
            </span>
          ) : null}
          <span
            className="truncate font-mono text-[13px] font-normal text-slate-900"
            title={g.fields.join(', ')}
          >
            {g.fields.join(', ')}
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * Rule 4 — summary line owns the field column entirely. No badges, no
 * field names inline. The full roster lives in the ExpandedSourceList.
 * Numbers use `tabular-nums` so the column stays steady across rows.
 */
function Rule4FieldRender({ sources }: { sources: MappingSourceRef[] }) {
  const tableCount = new Set(sources.map((s) => s.sourceTable.id)).size
  const fieldCount = sources.length
  const summary = `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} across ${tableCount} ${tableCount === 1 ? 'table' : 'tables'}`
  return (
    <span
      className="block truncate text-[13px] tabular-nums text-slate-500"
      title={summary}
    >
      {summary}
    </span>
  )
}

function ValueAssignmentSourceFieldCell({ row }: { row: ValueAssignmentRow }) {
  // Founder Gap 4a §9 Q5 (2026-04-22): VAs render the inline phrase
  // "No source mapped" — the VA expression itself lives in the drawer.
  // Phase 4-polish-1 keeps this phrase verbatim and pairs it with an
  // em-dash in the source-table column (see `SourceTableCell`).
  void row
  return (
    <span className="block truncate text-[13px] italic text-slate-500">
      No source mapped
    </span>
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
//
// Phase 4-polish-1: color-graded by `classifyRowConfidence` (≥85 high,
// 40-84 amber, <40 low). The high band pairs green text with a slightly
// heavier weight to satisfy the deuteranopia/protanopia accessibility note
// (founder Q9.1) — color alone is insufficient signal for users who can't
// distinguish red/green; the weight cue gives "this row is safe to defer
// to" a second channel. Amber and low rely on hue alone for now (Q9.1
// defers further pairings until we have a concrete user need).
//
// Refinement 3 (2026-04-26): the number itself is de-emphasized in favor
// of the color-band signal. text-[11px] (one step below Tailwind's
// text-xs ladder), high-band weight font-medium (not font-semibold) so
// the band doesn't outweigh adjacent body text.
//
// Refinement F (Phase 4-polish-1 final, 2026-04-26): the row-level
// transformation indicator dot was REMOVED. Earlier passes
// relocated it inline next to the percent (`92% •` shape); canary
// review found the muted-slate-400 treatment too subtle to convey
// meaning. The cell now renders just the percent (or the em-dash on
// the null branch). The drawer's Transformation section is the sole
// surface for transform status. Q9.2 lock still holds: no color when
// no number.
//
// Refinement H (Phase 4-polish-1 final, 2026-04-26): the percent is
// now integer-rounded ("92%" not "92.00%"). The `formatConfidencePercent`
// helper carries the rounding contract — see `lib/utils/confidence-format.ts`.

const CONFIDENCE_BAND_CLASSNAME: Record<RowConfidenceBand, string> = {
  high: 'text-green-600 font-medium',
  amber: 'text-amber-600',
  low: 'text-red-600',
}

function ConfidenceCell({ row }: { row: MappingRow }) {
  // Phase 4-polish-1 final refinements (Refinement F, 2026-04-26):
  // the inline transformation indicator dot was removed entirely.
  // The muted-slate dot was too subtle to convey "this row has a
  // transform" — canary review showed users could not identify
  // what the dot meant, so we'd rather not render it than half-
  // keep it. The transform info is fully surfaced in the drawer's
  // Transformation section, which is the source of truth.
  //
  // The `hasTransformation` and `transformationStatus` props remain
  // on `MappingRow` (data plane) — they're still consumed by the
  // drawer and by other downstream surfaces. Only the row-cell
  // visual was dropped.
  const confidence = row.confidence
  if (confidence === null) {
    // Em-dash branch: Rule 5/6/most-VAs land here.
    return (
      <EmDashCell
        srLabel="no confidence available"
        align="right"
        className="tabular-nums text-[11px]"
      />
    )
  }
  const band = classifyRowConfidence(confidence)
  return (
    <span
      className={cn(
        'flex items-center justify-end text-[11px] tabular-nums',
        CONFIDENCE_BAND_CLASSNAME[band],
      )}
      data-confidence-band={band}
    >
      {formatConfidencePercent(confidence)}
    </span>
  )
}

// ─── Target cell ─────────────────────────────────────────────────────────────
//
// Phase 4-polish-1 final refinements (Refinement B, 2026-04-26): the
// inline "(acknowledged)" suffix was DROPPED. The visual signals
// already present (slate-300 status dot vs. the slate-300 unmapped
// dot is differentiated via the StatusDot's hover tooltip; em-dashes
// in the source columns; em-dash in the confidence column) carry the
// distinction without the parenthetical. The row-level aria-label
// still states "acknowledged as not migratable" verbatim for AT
// users, and the drawer's Acknowledgment section is the source of
// truth for the reason text. Hover-tooltip on the StatusDot
// preserves the at-a-glance verification path for sighted users.
//
// Earlier passes (founder Q6 lock): the inline suffix was the
// preferred pattern, which we now revert based on canary review —
// the suffix duplicated information already conveyed by the dot
// color and the em-dashes, reading as visual noise in dense groups.

function TargetCell({ row }: { row: MappingRow }) {
  // Refinement 6 (Phase 4-polish-1 final-final, 2026-04-26): the target
  // field name dropped its prior `font-medium` weight to render at
  // `font-normal`, matching the source-side cells (Rule1/2/3FieldRender).
  // Hierarchy is now carried entirely by the column-header strip
  // ("Source Table | Source Field | Target Field | Conf.") and the
  // visual whitespace gap between source and target columns — not by
  // typography weight. This mirrors the parallel drawer-redesign
  // session's same-field-weight unification.
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span
        className="truncate font-mono text-sm font-normal text-slate-900"
        title={row.targetField.name}
      >
        {row.targetField.name}
      </span>
    </div>
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

// ─── Status dot (column 1 — leftmost) ────────────────────────────────────────
//
// Phase 4-polish-1 (founder Q1.3 lock): legacy "dot + label" status chip
// collapses to dot-only. The 12px column was chosen so the dot has a
// consistent left margin from the row's px-5 edge (centers cleanly) and
// every group's status column reads as a thin colored gutter.
//
// Refinement 1 (2026-04-26): dot shrunk from h-2 w-2 (8px) to h-1.5 w-1.5
// (6px). Without the legacy text label next to it, the larger dot read
// as visual noise across a dense group; the smaller version reads as a
// pure gutter cue. The 0.75rem (12px) grid column is unchanged, so the
// dot still centers cleanly inside it.
//
// The aria-label is preserved verbatim ("status: Approved") so screen-
// reader users continue to hear the status on row entry. Founder Q7.2
// unified slate-300 for the unmapped + acknowledged dots — both are
// "not actionable" states; merging the dot color removes a subtle
// distraction.
//
// Refinement B (Phase 4-polish-1 final, 2026-04-26): a `title=` hover
// tooltip is now wired so sighted users can disambiguate the slate-300
// dot (acknowledged vs. unmapped — same hue post-Q7.2) without relying
// on AT. The tooltip text branches on `kind`:
//
//   • kind === 'target_acknowledged' → "Acknowledged"
//   • otherwise                       → STATUS_CONFIG[status].label
//
// The aria-label remains the canonical screen-reader surface; the
// title is purely a sighted-user fallback (mouse hover).

type RowStatus = MappingRow['status']
type RowKind = MappingRow['kind']

function StatusDot({ status, kind }: { status: RowStatus; kind: RowKind }) {
  const config = STATUS_CONFIG[status]
  // Acknowledged rows carry status='unmapped' but visually share the
  // slate-300 dot with truly-unmapped rows (Q7.2 unification). The
  // sighted-user tooltip branches here so hover-to-disambiguate
  // works without relying on AT alone (Refinement B).
  const tooltipLabel = kind === 'target_acknowledged' ? 'Acknowledged' : config.label
  // Refinement 3 (Phase 4-polish-1 final-final, 2026-04-26): unmapped
  // rows render a HOLLOW circle (border-only, transparent fill);
  // every other kind (mapped / value-assignment / target_
  // acknowledged) renders a filled circle in its status color. The
  // form-vs-fill distinction is robust under colorblindness or low-
  // contrast monitors — color alone (slate-300 vs green/amber/red)
  // can collapse for some users, but a hollow ring is unambiguous
  // regardless of hue perception.
  //
  // Note: target_acknowledged rows reuse the *status* color (e.g.
  // bg-green-500 when status='approved') — they are filled, not
  // hollow. The kind=='unmapped' branch is the SOLE hollow case.
  const isUnmapped = kind === 'unmapped'
  return (
    <span
      aria-label={`status: ${config.label}`}
      title={tooltipLabel}
      data-status-dot-style={isUnmapped ? 'hollow' : 'filled'}
      className={cn(
        'inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
        isUnmapped ? 'border border-slate-400 bg-transparent' : config.dotClassName,
      )}
    />
  )
}

const STATUS_CONFIG: Record<
  RowStatus,
  { label: string; dotClassName: string }
> = {
  approved: { label: 'Approved', dotClassName: 'bg-green-500' },
  needs_review: { label: 'Needs Review', dotClassName: 'bg-amber-400' },
  rejected: { label: 'Rejected', dotClassName: 'bg-red-500' },
  unmapped: { label: 'Unmapped', dotClassName: 'bg-slate-300' },
}

// ─── Transformation indicator — REMOVED (Refinement F, 2026-04-26) ──────────
//
// Phase 4-polish-1 final refinements (Refinement F): the row-level
// transformation indicator dot was removed entirely. Earlier passes
// rendered an inline dot inside `ConfidenceCell` to signal "this row
// has a transform"; the muted-slate-400 treatment proved too subtle
// in canary review (users couldn't identify the dot's meaning) and a
// saturated hue would have stolen disproportionate attention from
// the percent number. Removing it cleanly is preferable to half-
// keeping it.
//
// The transform info remains fully surfaced in the drawer's
// Transformation section (the source of truth) and the row's
// `hasTransformation` / `transformationStatus` props are still
// available on the data plane for any future use.

// ─── Inline expand chevron (Refinement G, 2026-04-26) ───────────────────────
//
// Multi-source rows (Rule 2/3/4) render this chevron inline at the right
// edge of col 3 (source field area), next to the field name list. Click
// toggles the local `isExpanded` state, which mounts/unmounts
// `ExpandedSourceList` below the row.
//
// Pre-Refinement G the chevron lived as `ChevronSlot` at col 6 (its own
// dedicated grid column) and did double duty: it was the only "click to
// expand" affordance, while a row-body click opened the drawer. Canary
// review found this confusing — one icon at col 6 carried two different
// affordances depending on what part of the row the user clicked.
// Splitting the affordances visually (chevron in source area = expand;
// row body click = open drawer) makes the contract obvious.
//
// Single-source rows (Rule 1, VA, target_acknowledged, unmapped) render
// no chevron at all (this component is gated by `canExpand` at the call
// site, so single-source rows don't even instantiate it).
//
// Click handler still calls `stopPropagation` so the row-body click
// (drawer open) doesn't fire when the chevron is clicked. Keyboard
// activation works through the button's native Enter/Space — the row
// body's keyboard handler swallows Enter/Space only when the event
// target IS the row body itself (`e.target !== e.currentTarget`
// short-circuits), so chevron focus + Enter still toggles expansion.

function InlineExpandChevron({
  isExpanded,
  onToggle,
  expandedId,
}: {
  isExpanded: boolean
  onToggle: () => void
  expandedId: string
}) {
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
        'inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded',
        'text-slate-400 transition-colors hover:text-slate-700',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
      )}
    >
      {isExpanded ? (
        <ChevronDown className="h-3.5 w-3.5" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5" />
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
