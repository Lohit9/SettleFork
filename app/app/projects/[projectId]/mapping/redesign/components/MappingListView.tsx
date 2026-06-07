'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/components/ui/utils'
import {
  formatConfidencePercent,
  isRowConfidenceLow,
} from '@/lib/utils/confidence-format'
import type {
  MappingsForRedesignResult,
  SourceFieldWithState,
  TargetFieldRef,
} from '@/lib/types/mappings-for-redesign'
import {
  flattenRowsForListView,
  type FlatRow,
} from '@/lib/utils/flatten-rows-for-list-view'
import {
  filterFlatRows,
  DEFAULT_FILTER_STATE,
  type MappingFilterState,
} from '@/lib/utils/mapping-filters'
import { summarizeRationale } from '@/lib/utils/rationale-summary'
import { formatEmptySlotRationale } from '@/lib/utils/empty-slot-rationale'
import { Check, Edit3, X } from 'lucide-react'
import { ActionIconButton } from './FlatRowActions'
import { InlineSourcePicker } from './InlineSourcePicker'
import { RejectConfirmPopover } from './RejectConfirmPopover'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import { MockSpecTable } from './MockSpecTable'
import type { MappingListMutations } from '../hooks/useMappingListMutations'

// UI reskin flag — render the Settle MVP design's mocked spec table instead of
// the live data-wired list. Flip to false to restore the real table.
const MOCK_SPEC_TABLE: boolean = true

// Per-row rationale source. The TFM-level prose is the headline for the
// new RATIONALE column; the drawer continues to render the full text.
// Unmapped-target rows read `UnmappedRow.aiReasoning` (added to the wire
// shape in aa196e4 — sourced from `target_field_coverage.ai_reasoning` or
// the acknowledged TFM's `ai_reasoning`). Null falls through to em-dash.
// Unmapped-source rows prefer the user's acknowledgment reason; absent
// that, they fall back to `SourceFieldWithState.aiReasoning` — the
// display-only static-config explanation. Null falls through to em-dash.
function deriveRationaleSource(row: FlatRow): string | null {
  if (row.kind === 'mapped') return row.parentRow.aiReasoning
  if (row.kind === 'value-assignment') return row.parentRow.aiReasoning
  if (row.kind === 'unmapped-target') return row.parentRow.aiReasoning ?? null
  if (row.kind === 'unmapped-source') {
    // "Absent" means null OR empty/whitespace-only: the inline Approve path
    // persists an empty-string ack reason, and `??` alone would keep that
    // `''` instead of falling through. Trimming here matches the intent
    // comment above and `summarizeRationale`'s own trim-before-render.
    const ackReason = row.acknowledgmentReason?.trim()
    return ackReason ? ackReason : row.sourceField.aiReasoning
  }
  return null
}

// feat/mapping-list-toggle-and-columns refinement pass — confidence
// color simplified to a binary scheme: ≥50% renders in neutral slate
// (the number speaks for itself), <50% in muted amber as a soft warning.
// The prior 3-band gradient (green/amber/red) was retired because the
// green coloring duplicated the status dot's hue channel and the high-
// confidence number didn't need its own visual emphasis. `isRowConfidenceLow`
// in `lib/utils/confidence-format.ts` carries the predicate (50% cutoff,
// 0-1 vs 0-100 tolerant). The drawer / ExpandedSourceList / DQList still
// use the 3-band `classifyRowConfidence` — only the row-grid surfaces
// (this file + FieldMappingRow's ConfidenceCell) drop the gradient.
//
// Warning hue (`text-amber-700`) is intentionally NOT the status dot's
// amber-400 — the row dot's amber and the confidence amber-700 read as
// different dimensions (status vs. confidence) rather than competing
// instances of the same signal.

// ─── Visual subcomponents (Settle-platform-styled) ───────────────────────────
//
// FieldNameChip — gray monospace pill for individual field names.
// Mirrors the TableBadge aesthetic (`rounded bg-slate-100 font-mono`)
// at the row body's text-sm scale so a chip in this column reads as
// inline content, not as a column-level heading.
function FieldNameChip({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  return (
    <span
      title={name}
      className={cn(
        'inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 align-middle font-mono text-sm font-medium text-slate-700',
        className,
      )}
    >
      {name}
    </span>
  )
}

// Display status — three canonical buckets shared with the
// MappingSummaryStrip header chips. Linear-style polish: 8px fill + a
// 2px ring at 25% opacity for every hued state. The ring reads as a
// soft halo around the dot.
//
// feat/mapping-row-uniformity — the prior 4th `'unmapped'` bucket
// (gray-400, no ring) was retired here. It remapped unmapped-target /
// unmapped-source rows whose `status === 'needs_review'` onto a
// different gray + ring-less visual, causing the row dot to drift
// from the header `Needs Review N` indicator's slate-400 + ring
// treatment for rows of those kinds. Every needs-review row now
// renders the same slate dot regardless of kind — the dot reflects
// the row's APPROVAL STATE, not whether a source is present.
type DisplayStatus = 'approved' | 'needs_review' | 'rejected'

function deriveDisplayStatus(row: FlatRow): DisplayStatus {
  return row.status
}

const STATUS_DOT_CONFIG: Record<
  DisplayStatus,
  { label: string; fill: string; ring: string }
> = {
  approved: {
    label: 'Approved',
    fill: 'bg-emerald-500',
    ring: 'ring-2 ring-emerald-500/25',
  },
  needs_review: {
    // Source-of-truth alignment with the header `Needs Review N`
    // indicator in MappingSummaryStrip.tsx — keep both surfaces on the
    // same token so the dot reads as one status signal across the
    // page chrome.
    label: 'Needs review',
    fill: 'bg-slate-400',
    ring: 'ring-2 ring-slate-400/25',
  },
  rejected: {
    // Post-#157/#158/A2 'rejected' no longer carries a semantic
    // distinct from 'needs_review' (Reject = reset). Legacy
    // SimpleLegal mapped+rejected rows collapse onto the same
    // slate-400 + ring treatment as needs_review — the dot reflects
    // the unified needs-review state. `DisplayStatus` keeps its
    // 'rejected' member; only this visual token changed.
    label: 'Rejected',
    fill: 'bg-slate-400',
    ring: 'ring-2 ring-slate-400/25',
  },
}

function StatusDot({ status }: { status: DisplayStatus }) {
  const config = STATUS_DOT_CONFIG[status]
  return (
    <span
      data-testid="flat-status-dot"
      data-status={status}
      aria-label={`status: ${config.label}`}
      className={cn(
        'inline-block h-2 w-2 rounded-full align-middle',
        config.fill,
        config.ring,
      )}
    />
  )
}

function statusTooltipFor(row: FlatRow): string {
  const label = STATUS_DOT_CONFIG[deriveDisplayStatus(row)].label
  if (row.kind === 'unmapped-source' && row.acknowledgmentReason) {
    return `${label} · ${row.acknowledgmentReason}`
  }
  return label
}

// Review glyph — green ringed check (#16A34A) when the row is approved;
// quiet dashed hollow ring (#C4C9D0) when it still needs review.
// Replaces the status dot as the leftmost per-row glyph to match the
// design's "review vocabulary" (distinct from confidence dot + issue triangle).
function ReviewGlyph({ approved, title }: { approved: boolean; title?: string }) {
  if (approved) {
    return (
      <svg
        width={14}
        height={14}
        viewBox="0 0 20 20"
        aria-label={title ?? 'Reviewed'}
        data-testid="flat-review-glyph"
        data-reviewed="true"
        role="img"
      >
        <title>{title ?? 'Reviewed'}</title>
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="#16A34A" strokeWidth="1.5" />
        <path d="M6.2 10.4 L8.7 12.9 L13.9 7.3" fill="none" stroke="#16A34A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 20 20"
      aria-label={title ?? 'Needs review'}
      data-testid="flat-review-glyph"
      data-reviewed="false"
      role="img"
    >
      <title>{title ?? 'Needs review'}</title>
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="#C4C9D0" strokeWidth="1.5" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MappingListView — flat spreadsheet-style mapping view.
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders one row per "flat row" emitted by `flattenRowsForListView`.
// Per founder reference shot (third polish pass — dropped Option C
// parent/child):
//   • mapped TFM (any source count) → 1 row.
//     - 1 source  → standard row with FieldNameChip in source cells
//                   (clickable to swap source).
//     - 2+ sources → compact row with a blue `N×` badge in Source
//                    Table + "N fields combined" italic in Source
//                    Field. Per-contributor edits route through the
//                    drawer (row body click).
//   • value-assignment / unmapped-target → 1 row each, source cells
//     blank; unmapped-target's source-field cell renders a clickable
//     "Pick a source…" affordance routing through createFromUnmapped.
//   • source-side ack / source-only unmapped → 1 row each, target
//     cells blank; target-field cell renders "Pick a target…" for
//     source-side rows routing through createFromUnmapped.
//
// Columns (third polish pass — founder reference shot):
//   Target Table | Target Field | Source Table | Source Field |
//   Confidence | Status | Actions
//
// Sort: FIXED single-pass — Source Table ASC → Source Field ASC →
// Target Table ASC → Target Field ASC. Rows lacking a source value
// (value-assignment, unmapped-target) sort to the BOTTOM, ordered by
// their target columns. Headers are pure labels (no click-to-sort);
// FilterRow remains the filter surface.
//
// Interactions:
//   • Click row body → opens MappingDrawer (groupId = TFM uuid).
//   • Click Target Field cell → opens TargetFieldCellPicker
//     (single-pick autoCommit).
//   • Click Source Field cell (single-source mapped OR unmapped-target)
//     → opens InlineSourcePicker (single-pick autoCommit).
//   • Action buttons (✓ Approve, ✗ Reject) dispatch to
//     useMappingListMutations; e.stopPropagation prevents drawer-open
//     bubbling. Buttons are OMITTED (not greyed) when the action is
//     not applicable.
//
// Responsive layout:
//   • Outer wrapper carries `overflow-x-auto`.
//   • Target Table + Target Field are `sticky left-N`.
//   • Actions column is `sticky right-0`.
//   • Long table names use `truncate` + `title`; field names render
//     in `FieldNameChip` (small gray monospace pill) which itself
//     truncates.
//
// Visual subcomponents (Settle-platform-styled, defined above):
//   FieldNameChip, ConfidenceBar, MultiSourceBadge, StatusPill.
//
// Re-render orchestration:
//   • Mutations call router.refresh() on success (in the hook).
//   • Server-side unmapped-row synthesis handles last-source reject
//     + manual-create transitions atomically — no client-side state
//     plumbing needed.

// ─── Column widths ────────────────────────────────────────────────────────────
//
// Second polish pass — leading status-dot cell, target columns ahead
// of source columns (mirrors the founder's reference shot), Status
// column dropped (dot at left carries it), Edit action dropped (cell
// clicks cover every edit path).
//
//   Status dot     32px   (sticky left-0; no header, just a dot)
//   Target Table  176px   (sticky left-8)
//   Target Field  224px   (sticky left-52 = 8 + 44)
//   Source Table  176px
//   Source Field  224px
//   Confidence     96px   (colored number only)
//   Actions        80px   (sticky right-0; ✓ ✗ only)
//
// Sticky-left chain spans dot + target columns so the row's identity
// (target side leads) stays visible while the user scrolls right to
// see source attributions. `min-w-[1008px]` keeps the table honest
// under horizontal scroll on tablet / mobile widths.

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MappingListViewProps {
  /**
   * Server data feed, already filtered by `filterRows()` and merged
   * with the show-unmapped-source-fields toggle. The view flattens
   * INSIDE itself rather than expecting pre-flattened input so the
   * component owns its own row-derivation memoization — the parent
   * only has to thread the toggle state.
   */
  filteredResult: MappingsForRedesignResult

  /** Mutation handlers from useMappingListMutations. */
  mutations: MappingListMutations

  /**
   * Called when the user clicks a row body to open the drawer.
   * For multi-source split child rows, `highlightedSourceFieldId` is
   * the clicked child's source field id; the drawer can scroll to /
   * highlight the matching MappingSourceRef on mount.
   */
  onOpenDrawer: (rowId: string, highlightedSourceFieldId: string | null) => void

  /**
   * Active filter state. The flat view flattens `filteredResult` to the
   * canonical `FlatRow[]` projection and applies `filterFlatRows` over
   * it — so the synthesised `unmapped-source` rows are filtered too
   * (the wire `filterRows` pipeline alone never sees them). Optional;
   * omitting it (test mounts) defaults to the zero-filter state.
   */
  filters?: MappingFilterState

  /**
   * PR Ω.3.2.2 — flat-view partition chip selection. Empty set =
   * no partition filter (heritage byte-identity preserved via
   * filterFlatRows short-circuit). Non-empty = include only rows
   * whose `parentRow.tableMappingId` is in the set; `unmapped-source`
   * rows always pass through (no parent / no partition affiliation).
   * Optional; omitting it (test mounts / pre-Ω.3.2.2 callers) is
   * equivalent to passing the empty set.
   */
  flatPartitionSelection?: ReadonlySet<string>
}

// ─── Fixed sort (single pass, no UI state) ────────────────────────────────────
//
// Click-to-sort headers were dropped at an earlier polish pass.
// The flat view applies a single fixed ordering at render time:
//
//   Target Table ASC → Target Field ASC → hasSource ASC →
//   Source Table ASC → Source Field ASC
//
// Target-first (feat/mapping-list-cluster-multi-source): all
// source attributions for a given target field cluster as adjacent
// rows. Many-to-one mappings (the common AI-proposed multi-source
// case, e.g. Item_Description ← Assy_Desc + Item + ProductName)
// read as a contiguous group rather than scattered across the
// table.
//
// The `hasSource` flag is a within-target sub-discriminator: real
// mapped sources for a target appear first; constant defaults /
// unmapped-target rows for that same target sit at the bottom of
// the group.
//
// Source-only rows (unmapped-source) have no target to anchor to;
// they collect at the bottom of the table (bucket=1) and tiebreak
// by source columns.

// feat/mapping-table-refinements — source-first three-bucket ordering:
//
//   bucket 0: mapped TFMs                  — sort by source table → source field
//   bucket 1: unmapped-source rows         — sort by source table → source field
//   bucket 2: value-assignment + unmapped-target (target-only, no source field)
//                                          — sort by target table → target field
//
// Buckets 0 and 1 share the source-anchored sort so the flat view reads
// top-to-bottom as one continuous run grouped by source table — mapped
// rows first, then their unmapped source-side neighbours below. Bucket
// 2 collects the rows that lack a source field at the bottom, sorted by
// target columns. Value-assignment rows go in bucket 2 alongside
// unmapped-target since both share the "target-only" structural shape.
interface GroupSortKeys {
  bucket: 0 | 1 | 2
  /** Source-side keys — used in buckets 0 and 1. Empty string in bucket 2. */
  sourceTable: string
  sourceField: string
  /** Target-side keys — used in bucket 2. Empty string in buckets 0 and 1. */
  targetTable: string
  targetField: string
}

function buildSortKeys(row: FlatRow): GroupSortKeys {
  switch (row.kind) {
    case 'mapped':
      // PR Ω.3.8 — bucket 0 (mapped) now sorts TARGET-anchored (primary)
      // with the primary source as the tiebreaker. The data-layer collapse
      // produces M separate mapped rows when a target field has M distinct
      // dominant sources (e.g. `Item Number` from Assy.Item / ProductSKU /
      // Part #). Anchoring the primary key on target ensures those M rows
      // land consecutively under their shared target field; the source
      // tiebreaker keeps the within-target ordering deterministic.
      return {
        bucket: 0,
        sourceTable: row.sources[0].sourceTable.name,
        sourceField: row.sources[0].sourceField.name,
        targetTable: row.targetField.targetTable.name,
        targetField: row.targetField.name,
      }
    case 'unmapped-source':
      return {
        bucket: 1,
        sourceTable: row.sourceField.sourceTable.name,
        sourceField: row.sourceField.name,
        targetTable: '',
        targetField: '',
      }
    case 'value-assignment':
    case 'unmapped-target':
      return {
        bucket: 2,
        sourceTable: '',
        sourceField: '',
        targetTable: row.targetField.targetTable.name,
        targetField: row.targetField.name,
      }
  }
}

function compareStringsAsc(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function compareSortKeys(a: GroupSortKeys, b: GroupSortKeys): number {
  if (a.bucket !== b.bucket) return a.bucket - b.bucket
  if (a.bucket === 1) {
    // Unmapped-source — source-anchored (these rows have no target).
    const st = compareStringsAsc(a.sourceTable, b.sourceTable)
    if (st !== 0) return st
    return compareStringsAsc(a.sourceField, b.sourceField)
  }
  // Buckets 0 (mapped) and 2 (VA + unmapped-target) — target-anchored.
  // PR Ω.3.8 flipped bucket 0 from source-anchored to target-anchored;
  // bucket 2 was target-anchored pre-Ω.3.8. Source is carried as a
  // tiebreaker for bucket 0 (multi-source target fields); bucket 2
  // rows carry empty source keys so the tiebreaker is a no-op there.
  const tt = compareStringsAsc(a.targetTable, b.targetTable)
  if (tt !== 0) return tt
  const tf = compareStringsAsc(a.targetField, b.targetField)
  if (tf !== 0) return tf
  const st = compareStringsAsc(a.sourceTable, b.sourceTable)
  if (st !== 0) return st
  return compareStringsAsc(a.sourceField, b.sourceField)
}

// ─── Fixed sort ──────────────────────────────────────────────────────────────
//
// One flat row per TFM (feat/mapping-table-redesign). Decorate each
// row with sort keys and sort. No grouping pass — multi-source siblings
// no longer exist as separate sortable rows; they live as sub-rows
// inside their parent's expand/collapse pill.

interface SortableRow {
  row: FlatRow
  keys: GroupSortKeys
}

function buildSortableRows(rows: readonly FlatRow[]): SortableRow[] {
  const out: SortableRow[] = []
  for (const row of rows) {
    out.push({ row, keys: buildSortKeys(row) })
  }
  return out
}

function sortFlatRows(rows: readonly FlatRow[]): FlatRow[] {
  const decorated = buildSortableRows(rows)
  decorated.sort((a, b) => compareSortKeys(a.keys, b.keys))
  return decorated.map((d) => d.row)
}

// ─── Picker state ─────────────────────────────────────────────────────────────

type OpenPickerState =
  | {
      kind: 'source'
      rowId: string
      anchorEl: HTMLElement
      initialSourceFieldIds: string[]
      // For unmapped-target create-from-unmapped: the target field id
      // to map TO. Null for swap-source on an existing contributor.
      targetFieldIdForCreate: string | null
    }
  | {
      kind: 'target'
      rowId: string
      anchorEl: HTMLElement
      initialTargetFieldId: string | null
      // For unmapped-source create-from-unmapped: the source field id
      // to map from. Null for swap-target on an existing TFM.
      sourceFieldIdForCreate: string | null
    }
  | null

// ─── Main component ──────────────────────────────────────────────────────────

export function MappingListView({
  filteredResult,
  mutations,
  onOpenDrawer,
  filters = DEFAULT_FILTER_STATE,
  flatPartitionSelection,
}: MappingListViewProps) {
  const [openPicker, setOpenPicker] = useState<OpenPickerState>(null)

  // feat/mapping-table-redesign — multi-source expand/collapse state.
  // Set of TFM ids whose "+N source" pill is currently expanded; sub-
  // rows render only for ids in this set. Local component state — no
  // URL persistence, no server write. Reset on unmount.
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const toggleExpanded = useCallback((rowId: string) => {
    setExpandedRowIds((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }, [])

  // Flatten to the canonical FlatRow[] projection, THEN filter — the
  // synthesised unmapped-source rows exist only in this projection, so
  // filtering here (not on the wire MappingRow[]) is what makes the
  // source / target / status filters cover every row kind.
  //
  // PR Ω.3.2.2 — also feeds `flatPartitionSelection` through. Empty
  // set / undefined → filterFlatRows short-circuits and returns the
  // same array reference, preserving downstream memo identity for
  // heritage projects.
  const flatRows = useMemo(
    () =>
      filterFlatRows(
        flattenRowsForListView(filteredResult),
        filters,
        flatPartitionSelection,
      ),
    [filteredResult, filters, flatPartitionSelection],
  )

  // Fixed single-pass sort — see `compareSortKeys`. No UI state, no
  // re-sort on header click (per the polish pass).
  const sortedRows = useMemo(() => sortFlatRows(flatRows), [flatRows])

  // Target field universe — every target field appears in result.rows
  // exactly once (per the data contract).
  const availableTargetFields = useMemo<TargetFieldRef[]>(() => {
    const seen = new Set<string>()
    const out: TargetFieldRef[] = []
    for (const row of filteredResult.rows) {
      if (seen.has(row.targetField.id)) continue
      seen.add(row.targetField.id)
      out.push(row.targetField)
    }
    return out
  }, [filteredResult.rows])

  // Source field universe — already shaped as SourceFieldWithState[].
  const availableSourceFields: readonly SourceFieldWithState[] =
    filteredResult.sourceFields

  const handleSourceCellClick = useCallback(
    (row: FlatRow, anchorEl: HTMLElement) => {
      // Source-cell click opens the source picker for every row that
      // carries a target — including the empty-source cases:
      //   • mapped — swap the PRIMARY (sources[0], ordinal=0) source
      //     field. Multi-source rows use the shimmed contributor id
      //     `<tfmId>::<mappingSourceId>` so the server's
      //     `updateMappingSourceField` updates the right
      //     `mapping_sources` row. Per-source swap for non-primary
      //     sources moves to the drawer's source list.
      //   • unmapped-target → create-mapping flow (target picks a source).
      //   • value-assignment → create-mapping flow (the value-assignment
      //     TFM gets a source field attached). Routes through the same
      //     `createFromUnmapped` path as unmapped-target since neither
      //     has a `mapping_sources` slot to swap. Server-side concern
      //     for value-assignment: `createMappingFromUnmapped` currently
      //     rejects when a live TFM exists at the target (the existing
      //     value-assignment TFM trips this guard). The UI affordance
      //     ships ahead of the server change; the user will see a
      //     "target already mapped" error toast until the server side
      //     learns to convert value-assignment → mapped.
      //   • unmapped-source → noop (source IS the row identity).
      if (row.kind === 'mapped') {
        const primary = row.sources[0]
        const rowId =
          row.sources.length === 1 ? row.id : `${row.id}::${primary.id}`
        setOpenPicker({
          kind: 'source',
          rowId,
          anchorEl,
          initialSourceFieldIds: [primary.sourceField.id],
          targetFieldIdForCreate: null,
        })
        return
      }
      if (row.kind === 'unmapped-target' || row.kind === 'value-assignment') {
        setOpenPicker({
          kind: 'source',
          rowId: row.id,
          anchorEl,
          initialSourceFieldIds: [],
          targetFieldIdForCreate: row.targetField.id,
        })
      }
    },
    [],
  )

  const handleTargetCellClick = useCallback(
    (row: FlatRow, anchorEl: HTMLElement) => {
      // Target cell click opens the target picker:
      //   • mapped (any source count) → swap TFM target field
      //   • value-assignment | unmapped-target → swap target
      //   • unmapped-source → create-mapping flow (source picks target)
      if (row.kind === 'unmapped-source') {
        setOpenPicker({
          kind: 'target',
          rowId: row.id,
          anchorEl,
          initialTargetFieldId: null,
          sourceFieldIdForCreate: row.sourceField.id,
        })
        return
      }
      // mapped | value-assignment | unmapped-target — all carry a
      // `targetField` and route to swapMappingTarget on commit.
      const targetFieldId = row.targetField.id
      setOpenPicker({
        kind: 'target',
        rowId: row.id,
        anchorEl,
        initialTargetFieldId: targetFieldId,
        sourceFieldIdForCreate: null,
      })
    },
    [],
  )

  const handleRowBodyClick = useCallback(
    (row: FlatRow) => {
      // Open the drawer keyed on the TFM uuid. For mapped rows we
      // highlight the primary (ordinal=0) source so the drawer scrolls
      // there on mount — matches what's rendered inline on the main
      // row. Non-mapped rows have no source to highlight.
      const highlightedSourceFieldId =
        row.kind === 'mapped' ? row.sources[0].sourceField.id : null
      onOpenDrawer(row.groupId, highlightedSourceFieldId)
    },
    [onOpenDrawer],
  )

  const closePicker = useCallback(() => setOpenPicker(null), [])

  // Gap C (feat/drawer-body-editing-surface) — `openPicker` is keyed by
  // row id. A create/promote transition changes the row's id under us
  // (`unmapped::<x>` → TFM uuid), which would leave the picker open and
  // anchored to a now-unmounted row. Proactively drop picker state on a
  // successful commit so the open-picker state can never outlive its row.
  const handleSourcePickerCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      if (openPicker?.kind !== 'source') return { success: false }
      const newId = newSourceFieldIds[0]
      if (!newId) return { success: false }
      // Create-from-unmapped (target-only row picked a source):
      const result = openPicker.targetFieldIdForCreate
        ? await mutations.createFromUnmapped({
            sourceFieldId: newId,
            targetFieldId: openPicker.targetFieldIdForCreate,
            pendingKey: openPicker.rowId,
          })
        : await mutations.swapMappingSource(openPicker.rowId, newId)
      if (result.success) setOpenPicker(null)
      return result
    },
    [mutations, openPicker],
  )

  const handleTargetPickerCommit = useCallback(
    async (newTargetFieldId: string) => {
      if (openPicker?.kind !== 'target') return { success: false }
      let result: { success: boolean; mergeOpened?: boolean }
      if (openPicker.sourceFieldIdForCreate) {
        // Unmapped-source row picked a target → promote. Routes through
        // `promoteUnmappedSource` (not `createFromUnmapped`): the server
        // action case-detects target-unmapped (new 1:1 TFM) vs
        // target-already-mapped (append source to the existing TFM).
        result = await mutations.promoteUnmappedSource({
          sourceFieldId: openPicker.sourceFieldIdForCreate,
          targetFieldId: newTargetFieldId,
          pendingKey: openPicker.rowId,
        })
      } else {
        // Standard swap-target on an existing TFM. Multi-source flat
        // rows carry shimmed contributor ids (`<tfmId>::<sourceId>`);
        // strip the suffix so swapMappingTarget receives the bare TFM
        // uuid — target swap is TFM-atomic regardless of which
        // contributor row triggered the click.
        const bareTfmId = openPicker.rowId.split('::')[0]
        result = await mutations.swapMappingTarget(bareTfmId, newTargetFieldId)
      }
      // Close on success OR when a merge dialog took over the surface.
      if (result.success || result.mergeOpened) setOpenPicker(null)
      return result
    },
    [mutations, openPicker],
  )

  // UI reskin: render the Settle MVP design's mocked spec table (3 collapsible
  // sections, design rows, footer). The real data-wired table below is kept
  // intact for when MOCK_SPEC_TABLE is flipped off and the stub is replaced
  // with live data.
  if (MOCK_SPEC_TABLE) {
    return <MockSpecTable />
  }

  return (
    <div
      data-testid="mapping-list-view"
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <table className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          {/* Design-aligned column structure (Configure Map & Transform):
                [review] SOURCE | TARGET | TRANSFORMATION | RATIONALE | actions
              Review glyph (green check = approved, dashed ring = needs review)
              lives in its own narrow leftmost cell. Source/target each render
              `TABLE_NAME [field_chip]`. Transformation shows transform state
              (No transform / Draft · desc / Applied · desc). Rationale carries
              the AI match method + confidence number inline. Action icons
              (approve, reject, edit) cluster on the right edge, hover-only. */}
          <col style={{ width: '24px' }} />
          <col />
          <col />
          <col />
          <col />
          <col style={{ width: '104px' }} />
        </colgroup>
        <thead className="bg-gray-50">
          <tr>
            <th
              scope="col"
              data-testid="flat-header-review"
              aria-label="Review status"
              className="border-b border-gray-200 px-1 py-2.5 align-top"
            />
            <TableHeader column="source" label="Source" />
            <TableHeader column="target" label="Target" />
            <TableHeader column="transformation" label="Transformation" />
            <TableHeader column="rationale" label="Rationale" />
            {/* Design column: "Issues" (Settle MVP). Row-level issue
                indicators are a STUB pending data wiring — cells read as
                negative space (and still host hover row-actions) for now. */}
            <th
              scope="col"
              data-testid="flat-header-actions"
              className="border-b border-gray-200 px-3 py-2.5 align-top text-left text-xs font-medium uppercase tracking-wide text-gray-500"
            >
              Issues
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td
                colSpan={6}
                className="px-3 py-12 text-center text-sm italic text-gray-400"
              >
                No rows match the current filters.
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => (
              <FlatRowView
                key={row.id}
                row={row}
                isExpanded={expandedRowIds.has(row.id)}
                onToggleExpanded={toggleExpanded}
                mutations={mutations}
                onSourceCellClick={handleSourceCellClick}
                onTargetCellClick={handleTargetCellClick}
                onRowBodyClick={handleRowBodyClick}
              />
            ))
          )}
        </tbody>
      </table>

      {openPicker?.kind === 'source' ? (
        <InlineSourcePicker
          anchorRef={{ current: openPicker.anchorEl }}
          initialSourceFieldIds={openPicker.initialSourceFieldIds}
          availableSourceFields={[...availableSourceFields]}
          onCommit={handleSourcePickerCommit}
          onClose={closePicker}
          mode="single"
          autoCommit={true}
        />
      ) : null}

      {openPicker?.kind === 'target' ? (
        <TargetFieldCellPicker
          anchorRef={{ current: openPicker.anchorEl }}
          initialTargetFieldId={openPicker.initialTargetFieldId}
          availableTargetFields={availableTargetFields}
          onCommit={handleTargetPickerCommit}
          onClose={closePicker}
        />
      ) : null}
    </div>
  )
}

// ─── Header cell ─────────────────────────────────────────────────────────────
//
// Static text label — no click-to-sort (the FilterRow remains the
// canonical filter surface; row order is fixed per `compareSortKeys`).
// Typography matches the brief's spec for column headers:
// text-xs font-medium uppercase tracking-wide text-gray-500.

function TableHeader({
  column,
  label,
  align,
}: {
  column:
    | 'source'
    | 'target'
    | 'rationale'
    | 'transformation'
  label: string
  align?: 'right' | 'center'
}) {
  return (
    <th
      scope="col"
      data-testid={`flat-header-${column}`}
      className={cn(
        'border-b border-gray-200 px-3 py-2.5 align-top text-left text-xs font-medium uppercase tracking-wide text-gray-500',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
      )}
    >
      {label}
    </th>
  )
}

// ─── Single flat row ─────────────────────────────────────────────────────────

interface FlatRowViewProps {
  row: FlatRow
  /**
   * Whether this row's multi-source pill is currently expanded. Only
   * meaningful for mapped rows with sources.length > 1; ignored otherwise.
   */
  isExpanded: boolean
  /** Toggle the expanded/collapsed state for a row id. */
  onToggleExpanded: (rowId: string) => void
  mutations: MappingListMutations
  onSourceCellClick: (row: FlatRow, anchorEl: HTMLElement) => void
  onTargetCellClick: (row: FlatRow, anchorEl: HTMLElement) => void
  onRowBodyClick: (row: FlatRow) => void
}

function FlatRowView({
  row,
  isExpanded,
  onToggleExpanded,
  mutations,
  onSourceCellClick,
  onTargetCellClick,
  onRowBodyClick,
}: FlatRowViewProps) {
  const isBusy = mutations.isRowBusy(row.id)
  // Multi-source = mapped TFM with >1 sources. The main row shows the
  // primary inline; sources[1..] appear as indented sub-rows when the
  // "+N source" pill is expanded.
  const sourceCount = row.kind === 'mapped' ? row.sources.length : 0
  const isMultiSource = sourceCount > 1

  const sourceCellRef = useRef<HTMLButtonElement | null>(null)
  const targetCellRef = useRef<HTMLButtonElement | null>(null)
  // feat/dashboard-cleanup-reject-confirm — anchor + open-state for the
  // row-hover ✗ reject confirmation popover. Per-row local state: the
  // popover is keyed to this row's reject button and closes itself on
  // confirm / cancel / click-outside.
  const rejectButtonRef = useRef<HTMLButtonElement | null>(null)
  const [rejectConfirmOpen, setRejectConfirmOpen] = useState(false)

  // ── Cell display values ───────────────────────────────────────────
  const targetTable =
    row.kind === 'mapped' ||
    row.kind === 'value-assignment' ||
    row.kind === 'unmapped-target'
      ? row.targetField.targetTable.name
      : null

  const targetFieldName =
    row.kind === 'mapped' ||
    row.kind === 'value-assignment' ||
    row.kind === 'unmapped-target'
      ? row.targetField.name
      : null

  const sourceTableName = (() => {
    if (row.kind === 'mapped') return row.sources[0].sourceTable.name
    if (row.kind === 'unmapped-source') return row.sourceField.sourceTable.name
    return null
  })()

  const sourceFieldName = (() => {
    if (row.kind === 'mapped') return row.sources[0].sourceField.name
    if (row.kind === 'unmapped-source') return row.sourceField.name
    return null
  })()

  // Every FlatRow kind carries `confidence` (number | null) — mapped /
  // value-assignment / unmapped-target from the TFM aggregate, and
  // unmapped-source from the static-config entry. The Confidence cell
  // renders `null` as an em-dash, so no per-kind branching is needed.
  const confidence = row.confidence

  // Target-cell editability: every row that carries a `targetField`.
  const targetCellEditable =
    row.kind === 'mapped' ||
    row.kind === 'value-assignment' ||
    row.kind === 'unmapped-target' ||
    row.kind === 'unmapped-source'

  // Source-cell editability:
  //   • mapped (any source count) → swap THIS row's source field
  //     (per-source on multi-source TFMs).
  //   • unmapped-target → create-from-unmapped (target picks source)
  const sourceCellClickable =
    row.kind === 'mapped' || row.kind === 'unmapped-target'

  const displayStatus = deriveDisplayStatus(row)
  const statusTooltip = statusTooltipFor(row)

  // ── Action handlers per row kind ──────────────────────────────────
  //
  // feat/mapping-table-redesign — three actions per mapped row, all
  // TFM-atomic:
  //   • Approve  → mutations.approveTfm(row.id)  (bare TFM uuid)
  //   • Reject   → mutations.rejectTfm(row.id)   (bare TFM uuid)
  //   • Edit     → opens drawer keyed on the TFM with the primary
  //                source highlighted.
  // Per-source reject (deleting a single contributing source without
  // dropping the whole TFM) lives in the drawer's source list. The
  // flat view's main row no longer carries that affordance.
  //
  // Non-mapped rows: Approve/Reject behave per the row kind (see
  // branches below); Edit always opens the drawer.
  //
  // feat/dashboard-cleanup-reject-confirm — Reject is destructive and
  // is now gated behind `RejectConfirmPopover`: the ✗ button opens the
  // popover (it no longer dispatches the mutation directly), and the
  // popover's confirm runs `onReject`. `rejectConsequence` is the
  // per-kind copy for the popover's consequence line.
  const actions = useMemo(() => {
    const alreadyApproved = row.status === 'approved'
    const alreadyRejected = row.status === 'rejected'

    if (row.kind === 'mapped') {
      return {
        onApprove: alreadyApproved
          ? undefined
          : () => void mutations.approveTfm(row.id),
        approveTooltip: 'Approve mapping',
        onReject: alreadyRejected
          ? undefined
          : () => void mutations.rejectTfm(row.id),
        rejectTooltip: 'Unmap mapping',
        rejectConsequence: {
          fieldName: row.targetField.name,
          text: 'will become unmapped.',
        },
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open mapping in drawer',
      }
    }
    if (row.kind === 'value-assignment') {
      // feat/mapping-list-toggle-and-columns refinement pass: the edit
      // pencil now renders on every row that carries a target (value-
      // assignment + unmapped-target included), removing the prior
      // mapped-only gating. The drawer is the canonical edit surface
      // for the row's TFM (or to-be-created TFM, for unmapped-target).
      return {
        onApprove: alreadyApproved
          ? undefined
          : () => void mutations.approveTfm(row.id),
        approveTooltip: 'Approve value assignment',
        onReject: alreadyRejected
          ? undefined
          : () => void mutations.rejectTfm(row.id),
        rejectTooltip: 'Unmap value assignment',
        rejectConsequence: {
          fieldName: row.targetField.name,
          text: 'will become unmapped.',
        },
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open value assignment in drawer',
      }
    }
    if (row.kind === 'unmapped-target') {
      // feat/mapping-table-redesign refinement pass 2: approve renders
      // on unmapped-target rows. The row.id is the synthetic
      // `unmapped::<targetFieldId>` sentinel; `approveTfm` dispatches
      // through `approveFieldMapping`, which branches on the
      // `unmapped::` prefix and routes to `setCoverageStatus`
      // server-side.
      //
      // feat/reject-to-unmap — unmapped rows carry NO reject/unmap
      // affordance. Under the post-#157 model "reject" on an unmapped
      // row is non-destructive (it only clears AI rationale text), so
      // it is not worth a button; the destructive Unmap action exists
      // only on mapped/VA rows. The reject keys stay on the returned
      // object (set to `undefined`) so the `actions` union shape is
      // uniform across kinds and the render gates (`actions.onReject`)
      // simply skip the ✗ button.
      return {
        onApprove: alreadyApproved
          ? undefined
          : () => void mutations.approveTfm(row.id),
        approveTooltip: 'Acknowledge unmapped target',
        onReject: undefined,
        rejectTooltip: undefined,
        rejectConsequence: undefined,
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open target field in drawer',
      }
    }
    // unmapped-source
    // feat/mapping-row-uniformity — source-side rows surface Approve +
    // Edit. Approve acknowledges the source field will not be migrated
    // (UPSERTs `source_field_acknowledgments` with
    // `decision='acknowledged'`). Edit opens the drawer mounted on a
    // source-only `SourceFieldDrawerRow` projection. An already-
    // acknowledged row omits Approve so the user can't double-fire
    // (the row's `status` is the projected acknowledgment state, set
    // by `flattenRowsForListView`).
    //
    // feat/reject-to-unmap — unmapped-source rows carry NO reject/unmap
    // affordance (see the unmapped-target branch above for the
    // rationale). The reject keys stay `undefined` to keep the
    // `actions` union shape uniform.
    return {
      onApprove: alreadyApproved
        ? undefined
        : () =>
            void mutations.approveUnmappedSource({
              pendingKey: row.id,
              sourceFieldId: row.sourceField.id,
            }),
      approveTooltip: 'Acknowledge unmapped source',
      onReject: undefined,
      rejectTooltip: undefined,
      rejectConsequence: undefined,
      onEdit: () => onRowBodyClick(row),
      editTooltip: 'Open source field in drawer',
    }
  }, [mutations, onRowBodyClick, row])

  // ── Render ────────────────────────────────────────────────────────
  //
  // feat/mapping-table-redesign — Banking Core mockup. Seven columns:
  //   [●] | SOURCE | → | TARGET | RATIONALE | CONFIDENCE | actions
  // The status dot lives in its own narrow leftmost cell flush against
  // SOURCE so it reads as a prefix to source. All three action buttons
  // (approve, reject, edit) cluster on the right side and are
  // hover-only, revealed via the `group` class on the <tr> root.
  //
  // Multi-source TFMs render as ONE main row showing sources[0] inline
  // plus a "+N source" pill. Clicking the pill toggles indented
  // "Also contributes to <target>" sub-rows for sources[1..]. Sub-rows
  // are read-only — per-source actions (notably reject) live in the
  // edit drawer's source list. The stacked rows + left-bracket pattern
  // is retired by this revision.
  //
  // Em-dashes for blank cells use `text-gray-300` — visibly muted
  // against the surrounding text-slate-700 data.
  return (
    <>
    <tr
      data-testid="flat-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-group-id={row.groupId}
      data-source-count={
        row.kind === 'mapped' ? String(sourceCount) : undefined
      }
      data-multi-source={isMultiSource ? 'true' : 'false'}
      onClick={() => onRowBodyClick(row)}
      className={cn(
        'group cursor-pointer bg-white transition-colors hover:bg-gray-50',
      )}
    >
      {/* Review glyph — narrow leftmost cell. Green ringed check when
          approved; dashed hollow ring when needs review. Tooltip carries
          the status label + ack reason for unmapped-source rows. */}
      <td
        data-testid="flat-cell-review"
        title={statusTooltip}
        className="pl-3 pr-0 py-2.5 align-middle"
      >
        <ReviewGlyph
          approved={displayStatus === 'approved'}
          title={statusTooltip}
        />
      </td>
      {/* Merged SOURCE — `TABLE_NAME [primary_chip] [+N source]?` in one
          cell. Sits flush against the status dot on the left (pl-2). */}
      <td
        data-testid="flat-cell-source"
        className="pl-2 pr-3 py-2.5 align-top text-sm"
      >
        <div className="flex min-w-0 items-center gap-2">
          {sourceTableName ? (
            <span
              data-testid="flat-cell-source-table"
              title={sourceTableName}
              className="min-w-0 shrink-[9999] truncate text-[11px] font-normal text-slate-500"
            >
              {sourceTableName}
            </span>
          ) : null}
          <span
            data-testid="flat-cell-source-field"
            className="min-w-0"
          >
            {sourceFieldName ? (
              sourceCellClickable ? (
                <button
                  ref={sourceCellRef}
                  type="button"
                  data-testid="flat-cell-source-field-button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSourceCellClick(row, e.currentTarget)
                  }}
                  className={cn(
                    'inline-flex max-w-full items-center justify-start rounded',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                  )}
                >
                  <FieldNameChip name={sourceFieldName} />
                </button>
              ) : (
                <FieldNameChip name={sourceFieldName} />
              )
            ) : row.kind === 'unmapped-target' || row.kind === 'value-assignment' ? (
              // Rows with no source field on the wire share a single
              // "Pick a source…" affordance. Both kinds open the same
              // InlineSourcePicker on click; the server flow behind it
              // (createMappingFromUnmapped) accepts either. The VA's
              // "constant value" nature is conveyed by the rationale
              // column + drawer Transform tab — no need to distinguish
              // it with a different source-cell glyph.
              <button
                ref={sourceCellRef}
                type="button"
                data-testid="flat-cell-source-field-button"
                aria-label="Pick a source field"
                title="Pick a source field"
                onClick={(e) => {
                  e.stopPropagation()
                  onSourceCellClick(row, e.currentTarget)
                }}
                className={cn(
                  'inline-flex cursor-pointer items-center justify-start rounded px-1 py-0.5 text-sm',
                  'italic text-slate-400 hover:bg-blue-100/60 hover:text-slate-600',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                )}
              >
                Pick a source…
              </button>
            ) : (
              // Final fallback reached when `sourceFieldName` is falsy
              // for a kind that has no explicit branch above —
              // typically an `unmapped-source` row whose
              // `sourceField.name` is the empty string. The wire type
              // `SourceFieldWithState.name: string` is non-nullable but
              // the empty-string case can land here when a `fields`
              // row was seeded / ingested without a name. UI degrades
              // gracefully to em-dash; data fix is server-side
              // (worktree A scope). Pinned by feat/mapping-row-uniformity
              // audit — see investigation notes for the ENGINEERING BOM
              // MASTERS example.
              <span className="text-gray-300">—</span>
            )}
          </span>
          {/* "+N source" expand/collapse pill — only for multi-source
              mapped TFMs. Clicking toggles inline sub-rows below the
              main row. stopPropagation so the pill doesn't bubble to
              the row's drawer-open click handler. Always singular
              "source" per mockup. */}
          {isMultiSource ? (
            <button
              type="button"
              data-testid="flat-multi-source-pill"
              data-expanded={isExpanded ? 'true' : 'false'}
              aria-expanded={isExpanded}
              aria-label={
                isExpanded
                  ? 'Collapse additional sources'
                  : 'Expand additional sources'
              }
              title={
                isExpanded
                  ? 'Collapse additional sources'
                  : `Show ${sourceCount - 1} more source${sourceCount - 1 === 1 ? '' : 's'}`
              }
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpanded(row.id)
              }}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600',
                'hover:bg-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
              )}
            >
              <span aria-hidden="true" className="text-[10px] leading-none">
                {isExpanded ? '^' : '⌄'}
              </span>
              <span>+ {sourceCount - 1} source</span>
            </button>
          ) : null}
        </div>
      </td>
      {/* Merged TARGET — `table_name [field_chip]` in one cell. */}
      <td
        data-testid="flat-cell-target"
        className="px-3 py-2.5 align-top text-sm"
      >
        <div className="flex min-w-0 items-center gap-2">
          {targetTable ? (
            <span
              data-testid="flat-cell-target-table"
              title={targetTable}
              className="min-w-0 shrink-[9999] truncate text-[11px] font-normal text-slate-500"
            >
              {targetTable}
            </span>
          ) : null}
          <span data-testid="flat-cell-target-field" className="min-w-0">
            {targetFieldName ? (
              targetCellEditable ? (
                <button
                  ref={targetCellRef}
                  type="button"
                  data-testid="flat-cell-target-field-button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onTargetCellClick(row, e.currentTarget)
                  }}
                  className={cn(
                    'inline-flex max-w-full items-center justify-start rounded',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                  )}
                >
                  <FieldNameChip name={targetFieldName} />
                </button>
              ) : (
                <FieldNameChip name={targetFieldName} />
              )
            ) : row.kind === 'unmapped-source' ? (
              // Unmapped-source rows have no target — render a "Pick a
              // target…" affordance mirroring the unmapped-target
              // "Pick a source…" cell. Commit routes through
              // `promoteUnmappedSource`.
              <button
                ref={targetCellRef}
                type="button"
                data-testid="flat-cell-target-field-button"
                onClick={(e) => {
                  e.stopPropagation()
                  onTargetCellClick(row, e.currentTarget)
                }}
                className={cn(
                  'inline-flex items-center justify-start rounded px-1 py-0.5 text-sm',
                  'italic text-slate-400 hover:bg-blue-100/60 hover:text-slate-600',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                )}
              >
                Pick a target…
              </button>
            ) : (
              <span className="text-gray-300">—</span>
            )}
          </span>
        </div>
      </td>
      {/* Transformation — current transform state for mapped / value-assignment
          rows. Reads `parentRow.hasTransformation`, `transformationStatus`,
          and `transformationDescription`. Unmapped rows show an em-dash. */}
      <td
        data-testid="flat-cell-transformation"
        className="px-3 py-2.5 align-top text-sm"
      >
        {(() => {
          if (row.kind !== 'mapped' && row.kind !== 'value-assignment') {
            return <span className="text-gray-300">—</span>
          }
          const pr = row.parentRow
          if (!pr.hasTransformation) {
            if (pr.transformationNeeded) {
              return <span className="text-amber-700">Needs transform</span>
            }
            return <span className="text-slate-400">No transform</span>
          }
          const status = pr.transformationStatus
          const desc = pr.transformationDescription ?? null
          const descNode = desc ? (
            <>
              <span className="text-slate-300"> · </span>
              <span className="truncate text-slate-700">{desc}</span>
            </>
          ) : null
          if (status === 'stale') {
            return <span className="inline-flex min-w-0 max-w-full items-baseline gap-0"><span className="shrink-0 text-amber-700">Stale</span>{descNode}</span>
          }
          if (status === 'draft') {
            return <span className="inline-flex min-w-0 max-w-full items-baseline gap-0"><span className="shrink-0 text-slate-500">Draft</span>{descNode}</span>
          }
          return <span className="inline-flex min-w-0 max-w-full items-baseline gap-0"><span className="shrink-0 text-slate-500">Applied</span>{descNode}</span>
        })()}
      </td>
      {/* Rationale — one-line summary of the row's AI reasoning or
          (for source-side acks) the ack reason. Full text on hover via
          `title`. PR Ω.3.7.5: unmapped-target rows (empty slots — no
          TFM yet) fall back to a 2-tier schema label (loader-populated
          `fields.description` → `data_type, Required|Optional`) with a
          "· Not mapped in <partition>" suffix, styled italic + muted to
          distinguish it from real AI rationale. Em-dash remains the
          last-resort placeholder for any other row kind with nothing to
          surface. */}
      <td
        data-testid="flat-cell-rationale"
        className="px-3 py-2.5 align-top text-sm text-slate-700"
      >
        {(() => {
          const raw = deriveRationaleSource(row)
          const summary = summarizeRationale(raw)
          if (summary !== null) {
            return (
              <span title={raw ?? undefined} className="block truncate">
                {summary}
              </span>
            )
          }
          if (row.kind === 'unmapped-target') {
            const fallback = formatEmptySlotRationale({
              description: row.targetField.description,
              dataType: row.targetField.dataType,
              isNullable: row.targetField.isNullable,
            })
            return (
              <span
                data-testid="flat-cell-rationale-empty-slot"
                title={fallback}
                className="block truncate italic text-slate-500"
              >
                {fallback}
              </span>
            )
          }
          return <span className="text-gray-300">—</span>
        })()}
        {/* Confidence folded into rationale as an inline muted number —
            the design fuses match-method + confidence into one cell. */}
        {confidence !== null ? (
          <span
            data-testid="flat-cell-confidence-value"
            data-confidence-low={isRowConfidenceLow(confidence) ? 'true' : 'false'}
            className={cn(
              'ml-2 inline-block shrink-0 tabular-nums text-xs',
              isRowConfidenceLow(confidence) ? 'text-amber-600' : 'text-slate-400',
            )}
          >
            {formatConfidencePercent(confidence)}
          </span>
        ) : null}
      </td>
      {/* Right-side action cluster — order left-to-right:
          approve (✓) → reject (✗) → edit (✎). All three icons are
          hover-only (opacity-0 at rest, faded in via `group-hover` on
          the <tr>); `group-focus-within` keeps them keyboard-reachable.
          Review glyph on the left edge is the only always-visible
          per-row affordance. Action button clicks stopPropagation so
          they don't bubble to the row body's drawer-open handler. */}
      <td className="px-2 py-2.5 align-top">
        <div
          className={cn(
            'flex items-center justify-end gap-1 transition-opacity',
            // Keep the cluster visible while the reject confirmation
            // popover is open — the popover anchors to the ✗ button, so
            // the button must not fade out from under it when the mouse
            // leaves the row to reach the popover.
            rejectConfirmOpen
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          {actions.onApprove ? (
            <ActionIconButton
              testId="flat-row-action-approve"
              ariaLabel="Approve mapping"
              tooltip={actions.approveTooltip ?? 'Approve mapping'}
              variant="approve"
              disabled={isBusy}
              onClick={actions.onApprove}
            >
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
            </ActionIconButton>
          ) : null}
          {actions.onReject ? (
            <ActionIconButton
              ref={rejectButtonRef}
              testId="flat-row-action-reject"
              ariaLabel="Unmap mapping"
              tooltip={actions.rejectTooltip ?? 'Unmap mapping'}
              variant="reject"
              disabled={isBusy}
              // Reject is destructive — open the confirmation popover
              // instead of dispatching the mutation directly.
              onClick={() => setRejectConfirmOpen(true)}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </ActionIconButton>
          ) : null}
          {actions.onEdit ? (
            <ActionIconButton
              testId="flat-row-action-edit"
              ariaLabel="Edit mapping"
              tooltip={actions.editTooltip ?? 'Open mapping in drawer'}
              variant="edit"
              disabled={isBusy}
              onClick={actions.onEdit}
            >
              <Edit3 aria-hidden="true" className="h-3.5 w-3.5" />
            </ActionIconButton>
          ) : null}
        </div>
      </td>
    </tr>
    {/* Reject confirmation popover — anchored to this row's ✗ button.
        `RejectConfirmPopover` portals to document.body, so rendering it
        here (inside the row fragment, nominally under <tbody>) emits no
        DOM node into the table. Confirm closes the popover, then runs
        the destructive `onReject`; cancel / Esc / click-outside close
        it without rejecting. */}
    {rejectConfirmOpen && actions.onReject ? (
      <RejectConfirmPopover
        anchorRef={rejectButtonRef}
        title="Unmap this mapping?"
        confirmLabel="Unmap"
        consequence={actions.rejectConsequence}
        onConfirm={() => {
          // Close first so the popover unmounts before the mutation's
          // router.refresh() reshapes the row beneath it.
          setRejectConfirmOpen(false)
          actions.onReject?.()
        }}
        onCancel={() => setRejectConfirmOpen(false)}
      />
    ) : null}
    {/* Expanded multi-source sub-rows. One <tr> per source[1..] with
        grid-aligned content: SOURCE column carries an indented
        `↳ SOURCE_TABLE [chip]`; RATIONALE column carries the muted
        "Also contributes to <target_field_name>" caption. All other
        columns blank to preserve the column structure. Read-only — no
        status dot, no actions, no row hover effect, no drawer open on
        click (sub-rows aren't event surfaces). Sub-row DOM only exists
        when the pill is expanded; collapsing removes the elements. */}
    {row.kind === 'mapped' && isMultiSource && isExpanded
      ? row.sources.slice(1).map((src) => (
          <tr
            key={`${row.id}::sub::${src.id}`}
            data-testid="flat-row-subrow"
            data-parent-row-id={row.id}
            data-sub-source-id={src.id}
            className="bg-white"
          >
            <td className="pl-3 pr-0 py-1.5 align-middle" />
            <td className="pl-2 pr-3 py-1.5 align-middle text-sm">
              <div className="flex min-w-0 items-center gap-2 pl-6">
                <span
                  aria-hidden="true"
                  className="text-slate-300"
                >
                  ↳
                </span>
                <span
                  data-testid="flat-subrow-source-table"
                  title={src.sourceTable.name}
                  className="min-w-0 shrink-[9999] truncate text-[11px] font-normal text-slate-500"
                >
                  {src.sourceTable.name}
                </span>
                <span data-testid="flat-subrow-source-field" className="min-w-0">
                  <FieldNameChip name={src.sourceField.name} />
                </span>
              </div>
            </td>
            <td className="px-3 py-1.5 align-middle" />
            <td className="px-3 py-1.5 align-middle" />
            <td
              data-testid="flat-subrow-caption"
              className="px-3 py-1.5 align-middle text-xs italic text-slate-400"
            >
              Also contributes to {row.targetField.name}
            </td>
            <td className="px-2 py-1.5 align-middle" />
          </tr>
        ))
      : null}
    </>
  )
}
