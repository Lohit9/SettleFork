'use client'

import { forwardRef, useId, useRef, useState } from 'react'
import { Check, Edit3, Pencil, X } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { ChevronDown, ChevronRight } from '@/components/icons'
import {
  classifyRowConfidence,
  formatConfidencePercent,
  isRowConfidenceLow,
} from '@/lib/utils/confidence-format'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  SourceFieldWithState,
} from '@/lib/types/mappings-for-redesign'
import { classifyMappedRow, type MappingRowRule } from '@/lib/utils/mapping-row-rules'
import { TableBadge } from './TableBadge'
import { ExpandedSourceList } from './ExpandedSourceList'
import { InlineSourcePicker } from './InlineSourcePicker'

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
// COLUMN LAYOUT (CSS grid, fixed template — 6 columns, INF-50 fr-based
// growth pass on top of Phase 4-polish-3):
//
//   ┌─┬─────────┬─────────────────┬──────────────┬─────────┬─────────┐
//   │S│ src tbl │ src field [▸/▾] │ target field │  conf%  │ actions │
//   │ │ 8rem→1fr│ 10rem→1.5fr     │ 12rem→2fr    │  5rem   │  5rem   │
//   └─┴─────────┴─────────────────┴──────────────┴─────────┴─────────┘
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
//   • Col 2 originally tightened (polish-1) from `minmax(7rem, 12rem)`
//     to `minmax(6rem, 8rem)` on the rationale that Heritage's longest
//     source-table badge was ~12 chars. INF-50 (2026-05-09) reverted
//     that fixed cap to `minmax(8rem, 1fr)` after enterprise tenants
//     surfaced longer human-readable table names ("Engineering BOM
//     Master", 22 chars) that overflowed an 8rem track because
//     `TableBadge`'s own `max-w-[14rem]` exceeded the column. The
//     paired fix: `TableBadge` now accepts `maxWidth` and rule-1/2
//     callsites pass `'100%'` so the badge respects its grid track.
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
// Why fr-based growth with weighted ratios (INF-50)?
// Refinement 4 originally capped col 3 at `1fr` to prevent the source-
// table badge (col 2) from drifting away from the source-field name
// at wide viewports. INF-50 preserves that "source group adjacent,
// target column dominant" intent by using fr-based growth with a
// 1 : 1.5 : 2 ratio across cols 2, 3, 4. The target column still owns
// the largest share of remaining horizontal space (2fr vs 1fr/1.5fr),
// so source→target flow is still conveyed via whitespace alone — but
// each column now has a sensible minimum (8/10/12rem) that scales
// generously into the 1920px+ viewport range used by enterprise
// tenants, instead of clamping at fixed-rem maxes that overflow on
// long human-readable table names.
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

/**
 * Phase 4-polish-3 — optimistic per-row UI state. The parent owns this
 * map keyed by row id; rows render the appropriate animation while the
 * wrapper call is in flight. States:
 *   • 'approving'     — brief green highlight while approveFieldMapping runs
 *   • 'rejecting'     — slide-fade-out while rejectFieldMapping runs
 *   • 'mapping'       — brief blue highlight while createFieldMapping /
 *                        editMappingSources runs
 * All transitions honor `motion-reduce:transition-none`.
 */
export type FieldMappingRowOptimisticState =
  | 'approving'
  | 'rejecting'
  | 'mapping'

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
  /**
   * Phase 4-polish-3 — page-level source fields universe (one entry per
   * source field across all source tables). Required for the inline
   * source picker. When omitted, the source cell falls back to the
   * pre-polish-3 contract (clicking a source-eligible row opens the
   * drawer rather than the inline picker).
   */
  availableSourceFields?: SourceFieldWithState[]
  /**
   * Phase 4-polish-3 — optimistic UI hint for the row. When set, the
   * row renders the corresponding animation overlay while the parent's
   * wrapper call is in flight. See `FieldMappingRowOptimisticState`.
   */
  optimisticState?: FieldMappingRowOptimisticState
  /**
   * Optimistic-data override map. When present and contains an entry
   * for `row.id`, the entry's `MappingRow` shape is rendered in place
   * of the prop-supplied `row`. Used by reject paths (inline + bulk +
   * drawer) to pre-apply the post-reject unmapped shape so the row
   * settles to its new identity BEFORE `router.refresh()` swaps the
   * React key (`tfm-<id>` → `unmapped::<targetFieldId>`). Mask the
   * unmount/remount blip that otherwise produces a 200-500ms blank
   * flash on the inline path.
   */
  optimisticData?: Map<string, MappingRow>
  /**
   * Phase 4-polish-3 — inline approve handler. Wired only for mapped
   * rows with status='needs_review'. Parent dispatches
   * `approveFieldMapping` and surfaces the post-approve highlight via
   * `optimisticState`.
   */
  onInlineApprove?: (rowId: string) => void
  /**
   * Phase 4-polish-3 — inline reject handler. Wired for mapped rows
   * with status ∈ {needs_review, approved}. The handler receives the
   * ✗ button as the popover anchor; the parent renders
   * `RejectConfirmPopover` and dispatches `rejectFieldMapping` only on
   * confirm.
   */
  onInlineReject?: (rowId: string, anchorEl: HTMLElement) => void
  /**
   * Phase 4-polish-3 — fired when the user clicks Save in the inline
   * picker with a non-empty pending set differing from the initial
   * set. The parent dispatches `createFieldMapping` (for unmapped
   * rows) or `editMappingSources` (for mapped rows) and surfaces the
   * appropriate post-save toast. Returns a result so the picker can
   * close on success or stay open on error. Receives the row id and
   * the final selected source-field id list in user-pick order.
   *
   * Phase A refit (post-Phase-3): explicit Save button replaces the
   * earlier commit-on-close model; `onSourceCommit` is now async.
   */
  onSourceCommit?: (
    rowId: string,
    finalSourceFieldIds: string[],
  ) => Promise<{ success: boolean }>
  /**
   * Lifted chevron-expansion state. When provided, the row uses this
   * value for `isExpanded` and calls `onExpandedChange(next)` on
   * chevron toggle. When omitted, the row uses local useState (legacy
   * behavior; survives only as long as the row is mounted, which is
   * fine for non-virtualized callers).
   */
  isExpanded?: boolean
  onExpandedChange?: (next: boolean) => void
  /**
   * Lifted inline-source-picker open state. Same pattern as
   * isExpanded — when provided, parent owns the state.
   */
  isPickerOpen?: boolean
  onPickerOpenChange?: (next: boolean) => void
  /**
   * Virtualizer index used for keying / debugging when the row is
   * rendered inside a virtualized list. Surfaced as `data-index` on
   * the outer div for measureElement keying. Optional — non-
   * virtualized callers omit it.
   */
  dataIndex?: number
}

export const FieldMappingRow = forwardRef<HTMLDivElement, FieldMappingRowProps>(function FieldMappingRow(
  {
    row: providedRow,
    onRowClick,
    isActive,
    isHighlighted,
    availableSourceFields,
    optimisticState,
    optimisticData,
    onInlineApprove,
    onInlineReject,
    onSourceCommit,
    isExpanded: controlledExpanded,
    onExpandedChange,
    isPickerOpen: controlledPickerOpen,
    onPickerOpenChange,
    dataIndex,
  },
  ref,
) {
  // Resolve to the optimistic-data override if one exists for this
  // row's id. The override carries the post-reject unmapped shape
  // (kind: 'unmapped', no sources, no confidence) so every render
  // branch downstream — `resolveMappedRule`, `buildAriaLabel`, the
  // status-dot color, the source / target / confidence cells — all
  // pattern-match on the override's `kind === 'unmapped'` and produce
  // the post-reject look without waiting for the server round-trip.
  const row = optimisticData?.get(providedRow.id) ?? providedRow
  const expandedId = useId()
  const rule = resolveMappedRule(row)
  const canExpand = rule === 'rule_2' || rule === 'rule_3' || rule === 'rule_4'
  // Chevron-expansion state: lifted when the parent passes
  // controlledExpanded + onExpandedChange (virtualized callers do this
  // so the state survives row unmount/remount during scroll). Falls
  // back to local useState for legacy / fixture callers.
  const [localExpanded, setLocalExpanded] = useState(false)
  const isExpanded =
    controlledExpanded !== undefined ? controlledExpanded : localExpanded
  const setIsExpanded = (next: boolean) => {
    if (onExpandedChange !== undefined) {
      onExpandedChange(next)
    } else {
      setLocalExpanded(next)
    }
  }
  const isClickable = onRowClick !== undefined

  // ── Phase 4-polish-3 — inline source-picker state ───────────────────
  //
  // Eligibility: the inline picker hosts source-set edits for rows where
  // multi-select picking is meaningful AND the wrapper contract supports
  // it. Rows that need the drawer (custom_sql combination, Rule 4
  // 3+-tables-or-many-fields, value assignments) continue to open the
  // drawer on row-body click. Eligibility ALSO
  // requires the parent to have wired the `onSourceCommit` /
  // `availableSourceFields` props — legacy fixtures and storybook
  // callers that omit them fall through to the drawer path.
  const isInlineSourceEditable =
    availableSourceFields !== undefined &&
    onSourceCommit !== undefined &&
    ((row.kind === 'mapped' &&
      row.combinationType !== 'custom_sql' &&
      rule !== 'rule_4') ||
      row.kind === 'unmapped')

  const [localPickerOpen, setLocalPickerOpen] = useState(false)
  const isPickerOpen =
    controlledPickerOpen !== undefined ? controlledPickerOpen : localPickerOpen
  const setIsPickerOpen = (next: boolean) => {
    if (onPickerOpenChange !== undefined) {
      onPickerOpenChange(next)
    } else {
      setLocalPickerOpen(next)
    }
  }
  const rowBodyRef = useRef<HTMLDivElement | null>(null)
  const sourceWrapperRef = useRef<HTMLDivElement | null>(null)

  // Source-cell unification (2026-04-28): the picker anchors to the
  // unified source-trigger wrapper that spans cols 2-3 (Source Table +
  // Source Field) — NOT the full row body. This keeps the picker
  // visually paired with the cells it edits and leaves the Target Field
  // + Confidence cells visible while the picker is open, so the user
  // can see what they are mapping TO while choosing the source. The
  // existing PICKER_MIN_WIDTH_PX (352px) floor in InlineSourcePicker
  // still applies for narrow viewports where the cols-2-3 wrapper is
  // narrower than 352px; in that case the portal positioning logic
  // already flips to the left edge to keep the picker on-screen.
  const pickerAnchorRef = sourceWrapperRef

  const initialSourceFieldIds =
    row.kind === 'mapped'
      ? row.sources.map((s) => s.sourceField.id)
      : []

  const handleOpenPicker = () => {
    if (!isInlineSourceEditable) return
    setIsPickerOpen(true)
  }

  const handlePickerCommit = async (
    finalIds: string[],
  ): Promise<{ success: boolean }> => {
    if (!onSourceCommit) return { success: false }
    return onSourceCommit(row.id, finalIds)
  }

  const handlePickerClose = () => {
    setIsPickerOpen(false)
  }

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

  // Phase 4-polish-3 follow-up (2026-05-04) — row-level optimistic
  // background tints (bg-green-50 / bg-slate-100 / bg-blue-50) were
  // replaced with a Linear-style button-level pulse animation
  // (`.animate-button-pulse` keyframe in globals.css). The pulse is
  // applied to the action button corresponding to the in-flight
  // optimistic state inside `InlineActionsCell` below. Status-dot
  // transition (amber → green on approve etc.) remains the canonical
  // success confirmation; it triggers when `router.refresh()` rehydrates
  // the row's status field. Reject keeps its slide cue (PR #60) — not
  // pulsed.
  const isRejecting = optimisticState === 'rejecting'

  return (
    <div
      ref={ref}
      role="listitem"
      data-testid="field-mapping-row"
      data-index={dataIndex}
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-row-rule={row.kind === 'mapped' ? rule : undefined}
      data-optimistic-state={optimisticState ?? undefined}
      aria-label={buildAriaLabel(row, rule, isExpanded, isClickable)}
      className={cn(
        // Reject slide cue: the row slides 1px left + becomes
        // pointer-inert during the rejection round-trip. PR #58's
        // optimisticData override (in MappingContent) takes care of
        // the visual content swap from mapped → unmapped shape; this
        // class only adds the subtle motion cue. `opacity-0` was
        // here in PR #58 but hid the override entirely — dropped in
        // the hotfix.
        'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
        isRejecting && 'pointer-events-none -translate-x-1',
      )}
    >
      <div
        ref={rowBodyRef}
        data-testid="field-mapping-row-body"
        data-highlighted-row={isHighlighted ? 'true' : undefined}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        className={cn(
          // Column template documented above; keep this literal in sync
          // with the ASCII figure in the file header. The column-template
          // invariant test in `tests/components/field-mapping-row.test.tsx`
          // regex-asserts this exact literal — update both together if
          // the layout shifts again.
          //
          // Phase 4-polish-3 (2026-04-27): the trailing 5rem actions
          // column was ADDED back to host inline approve / reject /
          // map / acknowledge buttons. The column was dropped during
          // the polish-1 comprehensive pass on the rationale that
          // hover-only buttons did not deserve a structural column;
          // polish-3's row-state-aware button set (e.g. ✓ + ✗ on
          // needs_review, ✗ alone on approved, + + ⊘ on unmapped)
          // makes the column predictable per row state and the 5rem
          // resting whitespace re-earns its place. Template went
          // from 5 cols → 6 cols.
          //
          // INF-50 (2026-05-09): the three text columns moved from
          // fixed-rem `minmax(min, max-rem)` caps to fr-based growth
          // (`minmax(min, Nfr)`) so they expand with viewport width.
          // The prior caps (col 2: max 8rem, col 3: max 14rem, col 4
          // 1fr) caused long table names like "Engineering BOM Master"
          // (22 chars) to overflow col 2 because `TableBadge` carried
          // its own `max-w-[14rem]` cap > the col-2 8rem track. Two
          // coordinated fixes: (a) badges now accept `maxWidth` and
          // FieldMappingRow passes `100%` so they respect their grid
          // track; (b) tracks 2/3/4 grow proportionally via fr ratios
          // (1 : 1.5 : 2), so at 1280px viewports columns hit minimums
          // (8/10/12rem) and at 1920px+ viewports they expand and
          // truncation becomes rare. Action columns remain 5rem each.
          'group grid grid-cols-[0.75rem_minmax(8rem,1fr)_minmax(10rem,1.5fr)_minmax(12rem,2fr)_5rem_5rem] items-center gap-3 px-5 py-1.5',
          // Color overlays for optimistic UI — added on top of the
          // base layout so animations layer cleanly with the existing
          // `isActive` (drawer-open) and `isHighlighted` (sidebar)
          // states.
          'transition-colors duration-150 ease-out motion-reduce:transition-none',
          isClickable && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300',
          isActive && 'bg-slate-50',
          isHighlighted && 'border-l-2 border-blue-500',
        )}
      >
        <StatusDot status={row.status} />
        {isInlineSourceEditable ? (
          <UnifiedSourceTrigger
            wrapperRef={sourceWrapperRef}
            onActivate={handleOpenPicker}
            ariaLabel={buildSourceTriggerAriaLabel(row)}
          >
            <div
              data-testid="field-mapping-row-source-table-trigger"
              className="flex min-w-0 items-center text-left"
            >
              <SourceTableCell row={row} rule={rule} />
            </div>
            <div
              data-testid="field-mapping-row-source-field-trigger"
              className="flex min-w-0 items-center gap-1.5"
            >
              <SourceFieldCell row={row} rule={rule} />
              {canExpand ? (
                <InlineExpandChevron
                  isExpanded={isExpanded}
                  onToggle={() => setIsExpanded(!isExpanded)}
                  expandedId={expandedId}
                />
              ) : null}
              <Pencil
                aria-hidden="true"
                data-testid="field-mapping-row-source-edit-hint"
                className="ml-auto h-3 w-3 flex-shrink-0 text-slate-300 opacity-0 transition-opacity duration-150 ease-out group-hover/source:opacity-100 motion-reduce:transition-none"
              />
            </div>
          </UnifiedSourceTrigger>
        ) : (
          <>
            <SourceTableCell row={row} rule={rule} />
            <div className="flex min-w-0 items-center gap-1.5">
              <SourceFieldCell row={row} rule={rule} />
              {canExpand ? (
                <InlineExpandChevron
                  isExpanded={isExpanded}
                  onToggle={() => setIsExpanded(!isExpanded)}
                  expandedId={expandedId}
                />
              ) : null}
            </div>
          </>
        )}
        <TargetCell row={row} />
        <ConfidenceCell row={row} />
        <InlineActionsCell
          row={row}
          rule={rule}
          optimisticState={optimisticState}
          onInlineApprove={onInlineApprove}
          onInlineReject={onInlineReject}
          onInlineMap={isInlineSourceEditable ? handleOpenPicker : undefined}
          onInlineEdit={onRowClick}
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
      {isPickerOpen && availableSourceFields ? (
        <InlineSourcePicker
          anchorRef={pickerAnchorRef}
          initialSourceFieldIds={initialSourceFieldIds}
          availableSourceFields={availableSourceFields}
          onCommit={handlePickerCommit}
          onClose={handlePickerClose}
        />
      ) : null}
    </div>
  )
})

// ─── Unified source-cell trigger (Source-cell unification, 2026-04-28) ──────
//
// Single click+focus surface that spans grid cols 2-3 (Source Table +
// Source Field). Replaces the prior pair of separate triggers
// (`SourceTableTriggerButton` + `SourceFieldTriggerSurface`) which each
// owned their own focus ring and were perceived as two adjacent click
// targets across the gap-3 (12px) seam between cols.
//
// Layout: the wrapper is a single grid item placed in col 2 with
// `col-span-2`, so it occupies tracks 2 + 3 (and the inter-track gap)
// as a single visual block. Internally it uses `grid-cols-subgrid` to
// re-expose cols 2-3 to its two children, preserving the parent's
// column widths exactly — the inner Source Table / Source Field cells
// land at the same x-coordinates they did pre-unification.
//
// Tab order: ONE focus stop. The wrapper owns `tabIndex={0}` +
// `role="button"` + the focus ring. Inner children are passive divs
// (no tabIndex, no role) so keyboard tab does not stop on them.
//
// Hover scope: the wrapper carries Tailwind's named group `group/source`
// which the Pencil icon's `group-hover/source:opacity-100` class keys
// off. Hovering anywhere in cols 2-3 (over either inner child OR the
// inter-track gap) reveals the Pencil — communicates "click anywhere
// in this region to edit the source."
//
// Click handling: a single onClick on the wrapper handles activation
// for clicks anywhere inside the wrapper's bounding box. The wrapper
// `stopPropagation`s so the click does not bubble to the row body's
// drawer-open handler. The InlineExpandChevron continues to
// `stopPropagation` on its own click so chevron expand-toggle stays
// independent of picker open; chevron clicks therefore never trigger
// the wrapper's onClick.
//
// Eligibility: this wrapper is rendered ONLY when `isInlineSourceEditable`
// is true (mapped non-custom-sql non-rule-4, or unmapped). All other
// row kinds (Rule 4, value_assignment, custom_sql) render the legacy
// pre-unification fallback (separate SourceTableCell + SourceFieldCell
// with no triggers, falling through to the row-body drawer-open handler).
// Eligibility logic is unchanged from the prior two-trigger implementation.

function UnifiedSourceTrigger({
  wrapperRef,
  onActivate,
  ariaLabel,
  children,
}: {
  wrapperRef: React.Ref<HTMLDivElement>
  onActivate: () => void
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <div
      ref={wrapperRef}
      role="button"
      tabIndex={0}
      data-testid="field-mapping-row-source-trigger"
      aria-label={ariaLabel}
      onClick={(e) => {
        // The chevron button (when rendered inside col 3) already
        // calls `stopPropagation` on its own click, so chevron clicks
        // never reach here. Clicks on the table badge / field-name
        // text / pencil icon / inter-cell gap all fall through to
        // this handler and open the picker. We `stopPropagation` so
        // the click does not bubble to the row body's drawer-open
        // handler (the row body sits one level up in the DOM).
        e.stopPropagation()
        onActivate()
      }}
      onKeyDown={(e) => {
        // Only swallow Enter/Space when the activation target is the
        // wrapper itself — the chevron button's own native keyboard
        // handling stays intact.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onActivate()
        }
      }}
      className={cn(
        'group/source col-span-2 grid grid-cols-subgrid items-center gap-3',
        'cursor-pointer rounded transition-colors duration-150 ease-out motion-reduce:transition-none',
        'hover:bg-slate-50',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300',
      )}
    >
      {children}
    </div>
  )
}

function buildSourceTriggerAriaLabel(row: MappingRow): string {
  if (row.kind === 'unmapped') return 'Pick source fields for this target'
  return 'Edit source fields for this mapping'
}

// ─── Inline actions cell (Phase 4-polish-3, col 6) ───────────────────────────
//
// Rightmost grid cell hosting row-state-aware action buttons. PR α₀
// unified the dispatch around the row's `status` (lifecycle) for every
// row kind:
//
//   • status='needs_review'  →  ✓ approve  + ✗ reject
//   • status='approved'      →              ✗ reject
//   • status='rejected'      →  ✓ approve   (un-reject)
//
// INF-57 cleanup (2026-05-10): coverage-approved no-source rows
// (kind='unmapped', status='approved') participate in the symmetric
// dispatch — × reject direct-writes to rejected, mirroring mapped/VA
// approved rows. To un-approve back to needs_review the user opens the
// drawer (drawer footer's Un-approve button calls resetMappingStatus).
//
// PR α₀ Path A (2026-05-09): the kind='unmapped' overlay (+ map and
// ⊘ acknowledge) was DROPPED from the action cell. Re-mapping is now
// served by the source-field cell's hover pencil affordance (which
// opens the same `InlineSourcePicker`). The action cell stays focused
// on the approve/reject lifecycle pair.
// `onInlineMap` remains on the cell's interface for upstream pass-
// through compatibility but is no longer consumed here.
//
// Buttons are `opacity-0` at rest and reveal on `group-hover` /
// `focus-within` so the column reads as quiet whitespace until the user
// signals intent. Each button `stopPropagation` so a click on a button
// does not also trigger the row-body's drawer-open. The cell itself is
// not focusable; tab-order flows through the buttons individually.

interface InlineActionsCellProps {
  row: MappingRow
  rule: MappingRowRule
  optimisticState?: FieldMappingRowOptimisticState
  onInlineApprove?: (rowId: string) => void
  onInlineReject?: (rowId: string, anchorEl: HTMLElement) => void
  onInlineMap?: () => void
  /**
   * feat/mapping-list-toggle-and-columns refinement pass — the row-edit
   * pencil. Routes through the parent's `onRowClick` so the click opens
   * the same MappingDrawer the row-body click opens. Always surfaced
   * (every row gets the pencil) when `onRowClick` is wired by the
   * parent; omitted in fixture renders that don't pass a drawer host.
   */
  onInlineEdit?: (rowId: string) => void
}

function InlineActionsCell({
  row,
  rule: _rule,
  optimisticState,
  onInlineApprove,
  onInlineReject,
  onInlineMap,
  onInlineEdit,
}: InlineActionsCellProps) {
  // Disable all buttons while an optimistic action is in flight so the
  // user cannot double-fire (e.g. spam Approve, then Reject before the
  // first round-trip resolves).
  const isBusy = optimisticState !== undefined

  // Map optimistic state → which button should pulse. Reject is
  // intentionally absent — it uses the slide cue (PR #60), not the
  // pulse.
  const pulseApprove = optimisticState === 'approving'
  const pulseMap = optimisticState === 'mapping'

  const buttons: React.ReactNode[] = []

  // PR α₀ — status-driven approve/reject. feat/reject-to-unmap gates the
  // ✗ (now "Unmap") action to mapped / value_assignment rows only.
  // Dispatch table (the ✗ rows additionally require kind !== 'unmapped'):
  //   needs_review → ✓ + ✗   (approve + unmap)
  //   approved     →     ✗   (unmap only)
  //   rejected     → ✓       (un-reject only — re-runs approve flow)
  //
  // The kind gate lives here because this cell is status-driven; it has
  // no per-kind `actions` table to drop the reject wiring from (unlike
  // the flat view's `MappingListView`). Under the post-#157 model
  // "reject" on an unmapped row is a non-destructive no-op (it only
  // clears AI rationale text), so unmapped rows surface no ✗.
  const showApprove =
    (row.status === 'needs_review' || row.status === 'rejected') &&
    onInlineApprove !== undefined
  const showReject =
    row.kind !== 'unmapped' &&
    (row.status === 'needs_review' || row.status === 'approved') &&
    onInlineReject !== undefined

  if (showApprove) {
    buttons.push(
      <ActionIconButton
        key="approve"
        testId="field-mapping-row-approve-button"
        ariaLabel="Approve mapping"
        tooltip="Approve mapping"
        onClick={() => onInlineApprove!(row.id)}
        disabled={isBusy}
        variant="approve"
        pulse={pulseApprove}
      >
        <Check aria-hidden="true" className="h-3.5 w-3.5" />
      </ActionIconButton>,
    )
  }
  if (showReject) {
    buttons.push(
      <ActionIconButton
        key="reject"
        testId="field-mapping-row-reject-button"
        ariaLabel="Unmap mapping"
        tooltip="Unmap mapping"
        onClick={(e) => onInlineReject!(row.id, e.currentTarget)}
        disabled={isBusy}
        variant="reject"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </ActionIconButton>,
    )
  }

  // PR α₀ Path A (2026-05-09): the kind='unmapped' overlay (+ map) was
  // DROPPED. Re-mapping moves to the source-field hover pencil. See
  // header comment. `onInlineMap` and `pulseMap` are intentionally
  // unread inside this cell.
  void onInlineMap
  void pulseMap

  // feat/mapping-list-toggle-and-columns refinement pass — Edit pencil
  // sits at the end of the approve/reject pair. Always surfaced when
  // `onInlineEdit` is wired (the parent provides it whenever the row
  // is mounted with a drawer host), regardless of row kind or status —
  // every row carries an edit affordance, mirroring the flat view's
  // pencil contract. Click routes through `onRowClick(row.id)` so the
  // drawer opens on the same target as a row-body click.
  if (onInlineEdit !== undefined) {
    buttons.push(
      <ActionIconButton
        key="edit"
        testId="field-mapping-row-edit-button"
        ariaLabel="Open mapping in drawer"
        tooltip="Open mapping in drawer"
        onClick={() => onInlineEdit(row.id)}
        disabled={isBusy}
        variant="edit"
      >
        <Edit3 aria-hidden="true" className="h-3.5 w-3.5" />
      </ActionIconButton>,
    )
  }

  return (
    <div
      data-testid="field-mapping-row-actions"
      className={cn(
        'flex items-center justify-end gap-1',
        // Resting state hides the buttons so the column reads as
        // negative space; hover or keyboard focus within the row
        // reveals them. focus-within covers the case of a keyboard
        // user tabbing into a button.
        'opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none',
        'group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100',
      )}
    >
      {buttons}
    </div>
  )
}

interface ActionIconButtonProps {
  testId: string
  ariaLabel: string
  tooltip: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  variant: 'approve' | 'reject' | 'map' | 'edit'
  /**
   * When true, applies the `.animate-button-pulse` keyframe (defined
   * in globals.css) so the button does a Linear-style soft scale +
   * green ring fade-out for ~280ms. Set by the parent based on which
   * optimistic state is in flight (approving / mapping). Honors
   * `prefers-reduced-motion: reduce` via the keyframe's own media-query
   * gate. Reject's slide cue is unrelated (PR #60).
   */
  pulse?: boolean
  children: React.ReactNode
}

function ActionIconButton({
  testId,
  ariaLabel,
  tooltip,
  onClick,
  disabled,
  variant,
  pulse,
  children,
}: ActionIconButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-action-variant={variant}
      data-pulsing={pulse ? 'true' : undefined}
      aria-label={ariaLabel}
      title={tooltip}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
        }
      }}
      className={cn(
        'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded',
        'transition-colors duration-150 ease-out motion-reduce:transition-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        'disabled:cursor-not-allowed disabled:opacity-50',
        ACTION_VARIANT_CLASSNAME[variant],
        pulse && 'animate-button-pulse',
      )}
    >
      {children}
    </button>
  )
}

const ACTION_VARIANT_CLASSNAME: Record<
  ActionIconButtonProps['variant'],
  string
> = {
  approve: 'text-slate-500 hover:bg-green-100 hover:text-green-700',
  reject: 'text-slate-500 hover:bg-red-100 hover:text-red-700',
  map: 'text-slate-500 hover:bg-blue-100 hover:text-blue-700',
  edit: 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
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
  // PR α₀ — non-mapped rows render the italic "No source mapped" phrase
  // in the source-table column (the canonical visual identity for the
  // unified state-machine "no-source" treatment). VA / target_ack /
  // unmapped all share this rendering — the row's lifecycle is signaled
  // by the status dot + inline action buttons, not by the cell content.
  if (row.kind === 'mapped') {
    return <MappedSourceTableCell row={row} rule={rule} />
  }
  return <NoSourceMappedCell />
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
          <TableBadge tableName={pickDominantSource(row.sources).sourceTable.name} maxWidth="100%" />
        </div>
      )
    case 'rule_2':
      return (
        <div className="flex min-w-0 items-center">
          <TableBadge tableName={row.sources[0]!.sourceTable.name} maxWidth="100%" />
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
  // PR α₀ — non-mapped rows render an em-dash in the field column. The
  // italic "No source mapped" phrase that previously lived here for VA
  // rows moved to the source-table column (see `SourceTableCell`) so the
  // table + field columns no longer carry duplicate "no source"
  // signaling. The aria-label is distinct from the table-column em-dash
  // so screen readers don't hear the same phrase twice.
  if (row.kind === 'mapped') {
    return <MappedSourceFieldCell row={row} rule={rule} />
  }
  return <EmDashCell srLabel="no source field" />
}

function MappedSourceFieldCell({ row, rule }: { row: MappedRow; rule: MappingRowRule }) {
  if (row.sources.length === 0) {
    // Contract defense: a 'mapped' row without sources is a server-side
    // violation of the discriminated union (would be 'value_assignment'
    // when combination_type='custom_sql', else 'unmapped'). Render
    // em-dash rather than crashing.
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

/**
 * Italic "No source mapped" phrase used by every non-mapped row kind in
 * the source-table column (PR α₀ unification — VA and unmapped rows
 * share this rendering). Replaces the prior
 * `ValueAssignmentSourceFieldCell` which rendered the same phrase in the
 * source-FIELD column for VA rows only — α₀ moved the phrase to the
 * table column and collapsed the three em-dash branches into a single
 * "no-source" treatment so the user can scan a dense grid without
 * context-switching between em-dashes and italic phrases.
 */
function NoSourceMappedCell() {
  return (
    <span
      aria-label="no source mapped"
      className="block truncate text-[13px] italic text-slate-500"
    >
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

// feat/mapping-list-toggle-and-columns refinement pass — confidence
// color simplified to a binary slate / amber-700 split at 50%. Replaces
// the prior 3-band gradient (green ≥85 / amber 40-84 / red <40); the
// green coloring was retired because the high-confidence number speaks
// for itself, and the gradient duplicated the status dot's hue channel.
//
// `data-confidence-band` is preserved as a TEST-STABLE selector — still
// reads from `classifyRowConfidence` (3-band) so existing selectors
// continue to work. The visual color is independent now, driven by
// `isRowConfidenceLow` (binary 50% cutoff). Warning hue `text-amber-700`
// is intentionally NOT the status dot's amber-400 — the two color
// systems read as different dimensions (status vs. confidence).
function rowConfidenceTextClass(confidence: number): string {
  return isRowConfidenceLow(confidence) ? 'text-amber-700' : 'text-slate-700'
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
        rowConfidenceTextClass(confidence),
      )}
      data-confidence-band={band}
      data-confidence-low={isRowConfidenceLow(confidence) ? 'true' : 'false'}
    >
      {formatConfidencePercent(confidence)}
    </span>
  )
}

// ─── Target cell ─────────────────────────────────────────────────────────────

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
// unified slate-300 for unmapped+needs_review dots; INF-57 cleanup
// (2026-05-10) collapsed acknowledged into the canonical approved dot,
// so the only kind-conditional tooltip override was dropped — the
// `title=` hover tooltip now mirrors STATUS_CONFIG[status].label
// uniformly across kinds.

type RowStatus = MappingRow['status']

function StatusDot({ status }: { status: RowStatus }) {
  const config = STATUS_CONFIG[status]
  const tooltipLabel = config.label
  // PR α₀ — hollow signals REJECTED (status-driven), not UNMAPPED
  // (kind-driven). The form-vs-fill distinction stays as the
  // colorblind-robust signal: a hollow ring is unambiguous regardless
  // of hue perception. Rejected rows are the ones the user explicitly
  // marked "do not migrate", so the unique visual treatment now tracks
  // that explicit lifecycle decision rather than the synthesized
  // "no-TFM-yet" kind dimension. Pre-α₀, kind === 'unmapped' was the
  // sole hollow case; post-α₀, status === 'rejected' is.
  //
  // Knock-on: a kind === 'unmapped' row with status === 'needs_review'
  // (the orphan case post-PR-γ) now renders a filled amber dot — the
  // same as a mapped+needs_review row. The state-machine unification is
  // the point: visually, "this row needs review" reads identically
  // regardless of whether a TFM backs it.
  const isRejected = status === 'rejected'
  return (
    <span
      aria-label={`status: ${config.label}`}
      title={tooltipLabel}
      data-status-dot-style={isRejected ? 'hollow' : 'filled'}
      className={cn(
        'inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
        isRejected ? 'border border-red-500 bg-transparent' : config.dotClassName,
      )}
    />
  )
}

const STATUS_CONFIG: Record<
  RowStatus,
  { label: string; dotClassName: string }
> = {
  approved: { label: 'Approved', dotClassName: 'bg-green-500' },
  needs_review: { label: 'Needs Review', dotClassName: 'bg-slate-400' },
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
// Single-source rows (Rule 1, VA, unmapped) render no chevron at all
// (this component is gated by `canExpand` at the call site, so
// single-source rows don't even instantiate it).
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
    case 'unmapped':
      return `${targetQualified} not yet mapped${clickPhrase}`
  }
}
