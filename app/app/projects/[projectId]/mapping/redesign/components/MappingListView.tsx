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
import { summarizeRationale } from '@/lib/utils/rationale-summary'
import { Check, Edit3, X } from 'lucide-react'
import { ActionIconButton } from './FlatRowActions'
import { InlineSourcePicker } from './InlineSourcePicker'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import type { MappingListMutations } from '../hooks/useMappingListMutations'

// Per-row rationale source. The TFM-level prose is the headline for the
// new RATIONALE column; the drawer continues to render the full text.
// Unmapped-target rows currently have no wire field for the coverage's
// acknowledgment reason — they render em-dash. Adding the wire field is
// a separate additive change in worktree A.
function deriveRationaleSource(row: FlatRow): string | null {
  if (row.kind === 'mapped') return row.parentRow.aiReasoning
  if (row.kind === 'value-assignment') return row.parentRow.aiReasoning
  if (row.kind === 'unmapped-source') return row.acknowledgmentReason
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

// Display status — derives a 4-bucket label/color (the canonical 3
// status buckets plus an "Unmapped" 4th for unaddressed rows). The
// flat view paints only a dot (sixth polish pass — pill text dropped);
// the cell's `title` attribute carries the label, so the user still
// gets the status name on hover.
type DisplayStatus =
  | 'approved'
  | 'needs_review'
  | 'rejected'
  | 'unmapped'

function deriveDisplayStatus(row: FlatRow): DisplayStatus {
  if (row.kind === 'unmapped-target' || row.kind === 'unmapped-source') {
    if (row.status === 'needs_review') return 'unmapped'
  }
  return row.status
}

// Linear-style polish (feat/mapping-list-toggle-and-columns refinement
// pass): 8px fill + a 2px ring at 25% opacity for the hued states. The
// ring reads as a soft halo around the dot. Neutral unmapped renders
// without a ring; rejected now uses a distinct red fill so it reads as
// a third decision state rather than another neutral bucket.
const STATUS_DOT_CONFIG: Record<
  DisplayStatus,
  { label: string; fill: string; ring: string | null }
> = {
  approved: {
    label: 'Approved',
    fill: 'bg-emerald-500',
    ring: 'ring-2 ring-emerald-500/25',
  },
  needs_review: {
    label: 'Needs review',
    fill: 'bg-slate-400',
    ring: 'ring-2 ring-slate-400/25',
  },
  rejected: {
    label: 'Rejected',
    fill: 'bg-red-500',
    ring: 'ring-2 ring-red-500/25',
  },
  unmapped: {
    label: 'Unmapped',
    fill: 'bg-gray-400',
    ring: null,
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

interface GroupSortKeys {
  /**
   * 0 = group has a target (mapped, value-assignment,
   * unmapped-target); 1 = group is source-only (unmapped-source).
   * Primary discriminator so source-only rows sort to the bottom
   * of the table — they have no target to anchor to in the
   * target-first sort below.
   */
  bucket: 0 | 1
  /** Target-side keys drive the primary clustering. */
  targetTable: string
  targetField: string
  /**
   * Within a target group, 0 = real source attribution
   * (mapped), 1 = constant default / unmapped-target.
   * Sub-discriminator so all mapped rows for a target appear
   * before the constant-defaults for that same target.
   */
  hasSource: 0 | 1
  /** Source-side keys tiebreak within a target group. */
  sourceTable: string
  sourceField: string
}

function buildSortKeys(row: FlatRow): GroupSortKeys {
  switch (row.kind) {
    case 'mapped':
      // Each mapped flat row represents one source attribution.
      // Target-first sort below clusters all sources for a given
      // target field as adjacent rows. Source columns tiebreak
      // within the target group.
      return {
        bucket: 0,
        targetTable: row.targetField.targetTable.name,
        targetField: row.targetField.name,
        hasSource: 0,
        sourceTable: row.source.sourceTable.name,
        sourceField: row.source.sourceField.name,
      }
    case 'value-assignment':
    case 'unmapped-target':
      // Same target group as mapped rows for that field, but with
      // hasSource=1 so they sort to the BOTTOM of the group (real
      // mapped sources first, constant-defaults last within the
      // target's slot).
      return {
        bucket: 0,
        targetTable: row.targetField.targetTable.name,
        targetField: row.targetField.name,
        hasSource: 1,
        sourceTable: '',
        sourceField: '',
      }
    case 'unmapped-source':
      // Source-only rows have no target to cluster under; they
      // collect at the bottom of the table (bucket=1) and tiebreak
      // among themselves by source columns.
      return {
        bucket: 1,
        targetTable: '',
        targetField: '',
        hasSource: 0,
        sourceTable: row.sourceField.sourceTable.name,
        sourceField: row.sourceField.name,
      }
  }
}

function compareStringsAsc(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function compareSortKeys(a: GroupSortKeys, b: GroupSortKeys): number {
  if (a.bucket !== b.bucket) return a.bucket - b.bucket
  const tt = compareStringsAsc(a.targetTable, b.targetTable)
  if (tt !== 0) return tt
  const tf = compareStringsAsc(a.targetField, b.targetField)
  if (tf !== 0) return tf
  if (a.hasSource !== b.hasSource) return a.hasSource - b.hasSource
  const st = compareStringsAsc(a.sourceTable, b.sourceTable)
  if (st !== 0) return st
  return compareStringsAsc(a.sourceField, b.sourceField)
}

// ─── Fixed sort ──────────────────────────────────────────────────────────────
//
// Every flat row is now its own anchor (Option C parent/child split
// was dropped at the second visual polish pass — multi-source TFMs
// render as a single row with a `N×` badge). So we no longer need a
// group abstraction; just decorate each row with sort keys and sort.

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

// ─── Bracket position for multi-source groups ────────────────────────────────
//
// With the target-first cluster sort, multi-source siblings are
// guaranteed adjacent in the output. The Source Field cell paints a
// bracket-style accent: ┌ on the first row, │ on middle rows, └ on
// the last row — so stacked groups remain visually separated by the
// horizontal caps even when no row sits between them.
//
// `groupPosition` is computed in the parent by inspecting each row's
// neighbours in the sorted output. Single-source mapped rows return
// 'none' (no bracket renders). 'solo' is a defensive case — a
// multi-source TFM where only this single contributor row survives
// a filter — and renders as both first AND last caps.

export type GroupPosition = 'none' | 'first' | 'middle' | 'last' | 'solo'

function computeGroupPositions(rows: readonly FlatRow[]): GroupPosition[] {
  const positions: GroupPosition[] = new Array(rows.length).fill('none')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind !== 'mapped' || row.sourceCount <= 1) continue
    const prev = rows[i - 1]
    const next = rows[i + 1]
    const sameAsPrev =
      prev?.kind === 'mapped' && prev.groupId === row.groupId
    const sameAsNext =
      next?.kind === 'mapped' && next.groupId === row.groupId
    if (sameAsPrev && sameAsNext) positions[i] = 'middle'
    else if (sameAsNext) positions[i] = 'first'
    else if (sameAsPrev) positions[i] = 'last'
    else positions[i] = 'solo'
  }
  return positions
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
}: MappingListViewProps) {
  const [openPicker, setOpenPicker] = useState<OpenPickerState>(null)

  const flatRows = useMemo(
    () => flattenRowsForListView(filteredResult),
    [filteredResult],
  )

  // Fixed single-pass sort — see `compareSortKeys`. No UI state, no
  // re-sort on header click (per the polish pass).
  const sortedRows = useMemo(() => sortFlatRows(flatRows), [flatRows])

  // Per-row bracket position (first / middle / last / solo / none)
  // for the multi-source accent. Computed once over the sorted
  // array so each row knows its place in its group without an
  // O(n) lookup inside its own render.
  const groupPositions = useMemo(
    () => computeGroupPositions(sortedRows),
    [sortedRows],
  )

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
      //   • mapped (any source count) → swap THIS row's source field.
      //     For multi-source TFMs the picker only affects this one
      //     attribution; siblings stay mapped to their own sources.
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
        setOpenPicker({
          kind: 'source',
          rowId: row.id,
          anchorEl,
          initialSourceFieldIds: [row.source.sourceField.id],
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
      // For mapped flat rows (which now represent ONE source each),
      // open the drawer with this row's source highlighted so the
      // user lands inside the Sources section anchored to the
      // contributor they clicked. Non-mapped rows have no source to
      // highlight; they open the drawer with no highlight.
      const highlightedSourceFieldId =
        row.kind === 'mapped' ? row.source.sourceField.id : null
      onOpenDrawer(row.groupId, highlightedSourceFieldId)
    },
    [onOpenDrawer],
  )

  const closePicker = useCallback(() => setOpenPicker(null), [])

  const handleSourcePickerCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      if (openPicker?.kind !== 'source') return { success: false }
      const newId = newSourceFieldIds[0]
      if (!newId) return { success: false }
      // Create-from-unmapped (target-only row picked a source):
      if (openPicker.targetFieldIdForCreate) {
        return mutations.createFromUnmapped({
          sourceFieldId: newId,
          targetFieldId: openPicker.targetFieldIdForCreate,
          pendingKey: openPicker.rowId,
        })
      }
      return mutations.swapMappingSource(openPicker.rowId, newId)
    },
    [mutations, openPicker],
  )

  const handleTargetPickerCommit = useCallback(
    async (newTargetFieldId: string) => {
      if (openPicker?.kind !== 'target') return { success: false }
      // Create-from-unmapped (source-side row picked a target):
      if (openPicker.sourceFieldIdForCreate) {
        return mutations.createFromUnmapped({
          sourceFieldId: openPicker.sourceFieldIdForCreate,
          targetFieldId: newTargetFieldId,
          pendingKey: openPicker.rowId,
        })
      }
      // Standard swap-target on an existing TFM. Multi-source flat
      // rows carry shimmed contributor ids (`<tfmId>::<sourceId>`);
      // strip the suffix so swapMappingTarget receives the bare TFM
      // uuid — target swap is TFM-atomic regardless of which
      // contributor row triggered the click.
      const bareTfmId = openPicker.rowId.split('::')[0]
      return mutations.swapMappingTarget(bareTfmId, newTargetFieldId)
    },
    [mutations, openPicker],
  )

  return (
    <div
      data-testid="mapping-list-view"
      className="overflow-hidden rounded-lg border border-gray-200 bg-white"
    >
      <table className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          {/* feat/mapping-table-redesign column structure (Banking Core
              mockup, refinement pass 1):
                [●] SOURCE | → | TARGET | RATIONALE | CONFIDENCE | actions
              The status dot lives in its own narrow cell flush against
              source so the dot reads as a prefix to the source, not its
              own column. Source / target each render
              `TABLE_NAME [field_chip]`. Arrow is a muted glyph between.
              The right-side actions cluster carries approve + reject
              (always visible) + edit pencil (hover-only via `group`
              class on each <tr>) — 3×24px buttons with gap-1 plus side
              padding. */}
          <col style={{ width: '24px' }} />
          <col />
          <col style={{ width: '24px' }} />
          <col />
          <col />
          <col style={{ width: '80px' }} />
          <col style={{ width: '104px' }} />
        </colgroup>
        <thead className="bg-gray-50">
          <tr>
            <th
              scope="col"
              data-testid="flat-header-status"
              aria-label="Status"
              className="border-b border-gray-200 px-1 py-2.5 align-top"
            />
            <TableHeader column="source" label="Source" />
            <th
              scope="col"
              data-testid="flat-header-arrow"
              aria-hidden="true"
              className="border-b border-gray-200 px-0 py-2.5 align-top"
            />
            <TableHeader column="target" label="Target" />
            <TableHeader column="rationale" label="Rationale" />
            <TableHeader column="confidence" label="Confidence" align="right" />
            <th
              scope="col"
              data-testid="flat-header-actions"
              aria-label="Actions"
              className="border-b border-gray-200 px-1 py-2.5 align-top"
            />
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="px-3 py-12 text-center text-sm italic text-gray-400"
              >
                No rows match the current filters.
              </td>
            </tr>
          ) : (
            sortedRows.map((row, idx) => (
              <FlatRowView
                key={row.id}
                row={row}
                groupPosition={groupPositions[idx]}
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
    | 'confidence'
    | 'status'
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
   * Position within a multi-source group (first/middle/last/solo)
   * or 'none' for single-source rows. Drives the bracket-style
   * accent painted on the Source Field cell.
   */
  groupPosition: GroupPosition
  mutations: MappingListMutations
  onSourceCellClick: (row: FlatRow, anchorEl: HTMLElement) => void
  onTargetCellClick: (row: FlatRow, anchorEl: HTMLElement) => void
  onRowBodyClick: (row: FlatRow) => void
}

function FlatRowView({
  row,
  groupPosition,
  mutations,
  onSourceCellClick,
  onTargetCellClick,
  onRowBodyClick,
}: FlatRowViewProps) {
  const isBusy = mutations.isRowBusy(row.id)
  // Multi-source flag drives the left-accent visual cue. Each mapped
  // flat row already represents one source; we look at `sourceCount`
  // (carried on the row) to know whether this row has siblings.
  const isMultiSource = row.kind === 'mapped' && row.sourceCount > 1

  const sourceCellRef = useRef<HTMLButtonElement | null>(null)
  const targetCellRef = useRef<HTMLButtonElement | null>(null)

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
    if (row.kind === 'mapped') return row.source.sourceTable.name
    if (row.kind === 'unmapped-source') return row.sourceField.sourceTable.name
    return null
  })()

  const sourceFieldName = (() => {
    if (row.kind === 'mapped') return row.source.sourceField.name
    if (row.kind === 'unmapped-source') return row.sourceField.name
    return null
  })()

  const confidence =
    row.kind === 'mapped' ||
    row.kind === 'value-assignment' ||
    row.kind === 'unmapped-target'
      ? row.confidence
      : null

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
  // Three actions per mapped row: ✓ Approve, ✗ Reject, ✏ Edit.
  //
  //   • Approve: TFM-atomic — uses the bare TFM uuid (parentRow.id).
  //     For a multi-source TFM, approving any contributor row
  //     approves ALL siblings via the server's TFM-level approve.
  //     Tooltip surfaces the cross-source semantics so the user
  //     isn't surprised.
  //   • Reject: per-source — uses the shimmed contributor id (which
  //     IS row.id for multi-source) so A's `rejectFieldMapping`
  //     deletes just this attribution. Single-source rejects the
  //     whole TFM (the row id IS the TFM uuid for single source).
  //   • Edit: opens the drawer with this row's source highlighted.
  //     Drops the user into the drawer's Sources section anchored
  //     to the specific contributor they clicked.
  //
  // Non-mapped rows render only Reject (with row-kind-specific
  // dispatch). Edit is omitted because the cell-level "Pick a
  // source…" / "Pick a target…" buttons cover their edit path.
  const actions = useMemo(() => {
    const alreadyApproved = row.status === 'approved'
    const alreadyRejected = row.status === 'rejected'

    if (row.kind === 'mapped') {
      const parentTfmId = row.parentRow.id
      const sourceFieldId = row.source.sourceField.id
      return {
        onApprove: alreadyApproved
          ? undefined
          : () => void mutations.approveTfm(parentTfmId),
        approveTooltip:
          row.sourceCount > 1
            ? `Approves all ${row.sourceCount} sources of this mapping`
            : 'Approve mapping',
        onReject: alreadyRejected
          ? undefined
          : () => void mutations.rejectTfm(row.id),
        rejectTooltip:
          row.sourceCount > 1
            ? 'Remove this source attribution'
            : 'Reject mapping',
        // Edit reuses handleRowBodyClick — for mapped rows that helper
        // already derives the highlighted source from row.source, so
        // the Edit button and a row-body click land on the same drawer
        // state. `sourceFieldId` retained as documentation of intent.
        onEdit: () => {
          void sourceFieldId
          onRowBodyClick(row)
        },
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
        rejectTooltip: 'Reject value assignment',
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open value assignment in drawer',
      }
    }
    if (row.kind === 'unmapped-target') {
      return {
        onApprove: undefined,
        approveTooltip: 'Nothing to approve — no mapping',
        onReject: alreadyRejected
          ? undefined
          : () =>
              void mutations.rejectUnmappedRow({
                pendingKey: row.id,
                target: { targetFieldId: row.targetField.id },
              }),
        rejectTooltip: 'Mark as rejected',
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open target field in drawer',
      }
    }
    // unmapped-source
    // feat/mapping-list-toggle-and-columns refinement pass: unmapped
    // source rows are now informational only — no Approve, no
    // Reject, no Edit. Interactive assignment lives elsewhere; the
    // flat view's role for these rows is to surface the schema gap
    // at the bottom of the list. The `rejectUnmappedRow` action
    // remains wired in the hook for future use; this branch just
    // doesn't surface it.
    return {
      onApprove: undefined,
      approveTooltip: 'Nothing to approve — no mapping',
      onReject: undefined,
      rejectTooltip: undefined,
      onEdit: undefined,
      editTooltip: undefined,
    }
  }, [mutations, onRowBodyClick, row])

  // ── Render ────────────────────────────────────────────────────────
  //
  // feat/mapping-table-redesign refinement pass 1 — Banking Core mockup.
  // Seven columns in order:
  //   [●] | SOURCE | → | TARGET | RATIONALE | CONFIDENCE | actions
  // The status dot lives in its own narrow leftmost cell flush against
  // SOURCE so it reads as a prefix to source, not its own column. All
  // three action buttons (approve, reject, edit) cluster on the right
  // side. Approve + reject are always visible; the edit pencil is
  // hover-only, revealed via the `group` class on the <tr> root.
  //
  // Multi-source siblings are still indicated by the bracket accent on
  // the left edge of the SOURCE cell, anchored to the chip's vertical
  // center (22px from cell top). The bar parts (first/middle/last)
  // span the cell padding and stitch adjacent rows together.
  //
  // Em-dashes for blank cells use `text-gray-300` — visibly muted
  // against the surrounding text-slate-700 data.
  return (
    <tr
      data-testid="flat-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-group-id={row.groupId}
      data-source-count={
        row.kind === 'mapped' ? String(row.sourceCount) : undefined
      }
      data-multi-source={isMultiSource ? 'true' : 'false'}
      onClick={() => onRowBodyClick(row)}
      className={cn(
        'group cursor-pointer bg-white transition-colors hover:bg-gray-50',
      )}
    >
      {/* Status dot — narrow leftmost cell, sits flush against SOURCE.
          No own column header text; tooltip carries the status label +
          ack reason. The dot is the only inhabitant of this cell —
          action icons live in the right-side cluster. */}
      <td
        data-testid="flat-cell-status"
        title={statusTooltip}
        className="pl-3 pr-0 py-2.5 align-middle"
      >
        <StatusDot status={displayStatus} />
      </td>
      {/* Merged SOURCE — `TABLE_NAME [field_chip]` in one cell. Sits
          flush against the status dot on the left (pl-2 — just enough
          breathing room for the 8px multi-source bracket overlay). The
          bracket is absolute-positioned at the cell's left edge; its
          horizontal cap aligns with the chip's vertical center. */}
      <td
        data-testid="flat-cell-source"
        className="relative pl-2 pr-3 py-2.5 align-top text-sm"
      >
        {groupPosition !== 'none' && (
          <span
            aria-hidden="true"
            data-testid="flat-source-field-bracket"
            className="pointer-events-none absolute inset-y-0 left-0 w-2"
          >
            {(groupPosition === 'middle' || groupPosition === 'last') && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 w-0 border-l border-gray-400"
                style={{ height: '22px' }}
              />
            )}
            {(groupPosition === 'first' || groupPosition === 'middle') && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-0 w-0 border-l border-gray-400"
                style={{ top: '22px' }}
              />
            )}
            {(groupPosition === 'first' ||
              groupPosition === 'last' ||
              groupPosition === 'solo') && (
              <span
                aria-hidden="true"
                className="absolute left-0 h-0 w-2 border-t border-gray-400"
                style={{ top: '22px' }}
              />
            )}
          </span>
        )}
        <div className="flex min-w-0 items-center gap-2">
          {sourceTableName ? (
            <span
              data-testid="flat-cell-source-table"
              title={sourceTableName}
              className="shrink-0 truncate text-[10px] font-medium uppercase tracking-wide text-slate-500"
            >
              {sourceTableName}
            </span>
          ) : null}
          <span
            data-testid="flat-cell-source-field"
            data-group-position={groupPosition}
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
            ) : row.kind === 'unmapped-target' ? (
              <button
                ref={sourceCellRef}
                type="button"
                data-testid="flat-cell-source-field-button"
                onClick={(e) => {
                  e.stopPropagation()
                  onSourceCellClick(row, e.currentTarget)
                }}
                className={cn(
                  'inline-flex items-center justify-start rounded px-1 py-0.5 text-sm',
                  'italic text-slate-400 hover:bg-blue-100/60 hover:text-slate-600',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                )}
              >
                Pick a source…
              </button>
            ) : row.kind === 'value-assignment' ? (
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
                  'text-gray-300 hover:bg-blue-100/60 hover:text-slate-600',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                )}
              >
                —
              </button>
            ) : (
              <span className="text-gray-300">—</span>
            )}
          </span>
        </div>
      </td>
      {/* Arrow glyph between source and target. Muted, decorative. */}
      <td
        aria-hidden="true"
        className="px-0 py-2.5 align-middle text-center text-base leading-tight text-slate-300"
      >
        →
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
              className="shrink-0 truncate text-[10px] font-medium uppercase tracking-wide text-slate-500"
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
            ) : (
              <span className="text-gray-300">—</span>
            )}
          </span>
        </div>
      </td>
      {/* Rationale — one-line summary of the row's AI reasoning or
          (for source-side acks) the ack reason. Full text on hover via
          `title`. Em-dash when nothing to surface (includes unmapped-
          target rows, which today don't carry coverage acknowledgment
          reason on the wire — additive wire change is a separate PR). */}
      <td
        data-testid="flat-cell-rationale"
        className="px-3 py-2.5 align-top text-sm text-slate-700"
      >
        {(() => {
          const raw = deriveRationaleSource(row)
          const summary = summarizeRationale(raw)
          if (summary === null) {
            return <span className="text-gray-300">—</span>
          }
          return (
            <span title={raw ?? undefined} className="block truncate">
              {summary}
            </span>
          )
        })()}
      </td>
      <td
        data-testid="flat-cell-confidence"
        className="px-3 py-2.5 align-top text-right text-sm tabular-nums"
      >
        {/* Scale-tolerant render via `formatConfidencePercent` — the
            helper handles both 0-1 fractional and 0-100 percent
            scales gracefully. Legacy data and re-run data may coexist
            on different scales during the transition window
            (per A's notes/flat-view-confidence-bug.md).
            feat/mapping-list-toggle-and-columns refinement pass:
            color simplified to a binary slate / amber-700 split at
            50% — see the helper-block comment at the top of this file. */}
        {confidence === null ? (
          <span className="text-gray-300">—</span>
        ) : (
          <span
            data-testid="flat-cell-confidence-value"
            data-confidence-low={isRowConfidenceLow(confidence) ? 'true' : 'false'}
            className={
              isRowConfidenceLow(confidence)
                ? 'text-amber-700'
                : 'text-slate-700'
            }
          >
            {formatConfidencePercent(confidence)}
          </span>
        )}
      </td>
      {/* Right-side action cluster — order left-to-right:
          approve (✓) → reject (✗) → edit (✎). Approve + reject are
          always visible; the edit pencil is opacity-0 at rest and
          fades in on row hover (or keyboard focus within the row so
          keyboard users still reach it). Action button clicks
          stopPropagation so they don't bubble to the row body's
          drawer-open handler. */}
      <td className="px-2 py-2.5 align-top">
        <div className="flex items-center justify-end gap-1">
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
              testId="flat-row-action-reject"
              ariaLabel="Reject mapping"
              tooltip={actions.rejectTooltip ?? 'Reject mapping'}
              variant="reject"
              disabled={isBusy}
              onClick={actions.onReject}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </ActionIconButton>
          ) : null}
          {actions.onEdit ? (
            <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
