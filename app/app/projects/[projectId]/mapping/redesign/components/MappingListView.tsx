'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/components/ui/utils'
import {
  classifyRowConfidence,
  formatConfidencePercent,
  type RowConfidenceBand,
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
import { FlatRowActions } from './FlatRowActions'
import { InlineSourcePicker } from './InlineSourcePicker'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import type { MappingListMutations } from '../hooks/useMappingListMutations'

// Confidence band → text color for the Confidence cell. Matches the
// drawer's per-source card so a "92% green" reads the same on both
// surfaces. The flat view shows the colored number alone (no bar);
// the band is the visual signal.
const CONFIDENCE_BAND_TEXT: Record<RowConfidenceBand, string> = {
  high: 'text-green-700 font-medium',
  amber: 'text-amber-700',
  low: 'text-red-700',
}

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

const STATUS_DOT_CONFIG: Record<
  DisplayStatus,
  { label: string; dot: string }
> = {
  approved: { label: 'Approved', dot: 'bg-green-500' },
  needs_review: { label: 'Needs review', dot: 'bg-amber-400' },
  rejected: { label: 'Rejected', dot: 'bg-slate-400' },
  unmapped: { label: 'Unmapped', dot: 'bg-slate-300' },
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
        config.dot,
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

  /**
   * When true, source fields that are NOT referenced by any mapping
   * AND have no acknowledgment row are emitted as `unmapped-source`
   * rows in the flat output. Default false hides them (only
   * source-side acks appear on the source-only side).
   */
  showUnmappedSourceFields: boolean

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
  showUnmappedSourceFields,
  mutations,
  onOpenDrawer,
}: MappingListViewProps) {
  const [openPicker, setOpenPicker] = useState<OpenPickerState>(null)

  const flatRows = useMemo(
    () =>
      flattenRowsForListView(filteredResult, { showUnmappedSourceFields }),
    [filteredResult, showUnmappedSourceFields],
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
      // Source-cell click opens the source picker for rows with a
      // meaningful source slot to address:
      //   • mapped (any source count) → swap THIS row's source field.
      //     For multi-source TFMs the picker only affects this one
      //     attribution; siblings stay mapped to their own sources.
      //   • unmapped-target → create-mapping flow (target picks a source)
      //   • unmapped-source → noop (source IS the row identity)
      //   • value-assignment → no source cell, no click
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
      if (row.kind === 'unmapped-target') {
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
          <col style={{ width: '12%' }} />
          <col style={{ width: '26%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '26%' }} />
          <col style={{ width: '80px' }} />
          <col style={{ width: '40px' }} />
          <col style={{ width: '110px' }} />
        </colgroup>
        <thead className="bg-gray-50">
          <tr>
            {/* feat/mapping-list-toggle-and-columns: column order is
                now source-first (Source Table / Source Field / Target
                Table / Target Field / Confidence / Status / Actions),
                aligned with the locked sort. The Status column is
                header-less — the cell still renders a colored dot,
                but the th has no visible label (aria-label retained
                for assistive tech). */}
            <TableHeader column="sourceTable" label="Source Table" />
            <TableHeader column="sourceField" label="Source Field" />
            <TableHeader column="targetTable" label="Target Table" />
            <TableHeader column="targetField" label="Target Field" />
            <TableHeader column="confidence" label="Confidence" align="right" />
            <th
              scope="col"
              data-testid="flat-header-status"
              aria-label="Status"
              className="border-b border-gray-200 px-3 py-2.5 align-top"
            />
            <th
              scope="col"
              data-testid="flat-header-actions"
              aria-label="Actions"
              className="border-b border-gray-200 px-3 py-2.5 align-top"
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
            sortedRows.map((row) => (
              <FlatRowView
                key={row.id}
                row={row}
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
    | 'sourceTable'
    | 'sourceField'
    | 'targetTable'
    | 'targetField'
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
  mutations: MappingListMutations
  onSourceCellClick: (row: FlatRow, anchorEl: HTMLElement) => void
  onTargetCellClick: (row: FlatRow, anchorEl: HTMLElement) => void
  onRowBodyClick: (row: FlatRow) => void
}

function FlatRowView({
  row,
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

  const confidenceBand =
    confidence === null ? null : classifyRowConfidence(confidence)

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
      return {
        onApprove: alreadyApproved
          ? undefined
          : () => void mutations.approveTfm(row.id),
        approveTooltip: 'Approve value assignment',
        onReject: alreadyRejected
          ? undefined
          : () => void mutations.rejectTfm(row.id),
        rejectTooltip: 'Reject value assignment',
        onEdit: undefined,
        editTooltip: undefined,
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
        onEdit: undefined,
        editTooltip: undefined,
      }
    }
    // unmapped-source
    return {
      onApprove: undefined,
      approveTooltip: 'Nothing to approve — no mapping',
      onReject: alreadyRejected
        ? undefined
        : () =>
            void mutations.rejectUnmappedRow({
              pendingKey: row.id,
              target: { sourceFieldId: row.sourceField.id },
            }),
      rejectTooltip: 'Mark as rejected',
      onEdit: undefined,
      editTooltip: undefined,
    }
  }, [mutations, onRowBodyClick, row])

  // ── Render ────────────────────────────────────────────────────────
  //
  // Sixth polish pass — single-viewport table layout (no horizontal
  // scroll, no sticky columns). Column widths set via the parent
  // table's `<colgroup>`. Each cell uses uniform `px-3 py-2.5
  // align-top`, with `text-sm` body text and a subtle border-b on
  // every non-header row.
  //
  // Multi-source mapped TFMs emit N independent flat rows; each row
  // carries `sourceCount > 1` and renders with a `border-l-2
  // border-slate-300` left accent so siblings remain visually
  // identifiable even after the global sort scatters them.
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
        'cursor-pointer bg-white transition-colors hover:bg-gray-50',
      )}
    >
      {/* Source-first column order (feat/mapping-list-toggle-and-columns).
          Multi-source accent (feat/mapping-list-cluster-multi-source):
          painted on the Source FIELD cell — the field is the mapping
          unit; the table is incidental metadata. With the new target-
          first cluster sort, multi-source siblings are guaranteed
          adjacent, so the per-cell border reads as one contiguous
          vertical bar across the group. Brand teal at 50% opacity —
          obvious but not loud. */}
      <td
        data-testid="flat-cell-source-table"
        title={sourceTableName ?? undefined}
        className="truncate border-b border-gray-100 px-3 py-2.5 align-top text-sm text-slate-700"
      >
        {sourceTableName ?? <span className="text-gray-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-source-field"
        className={cn(
          'border-b border-gray-100 px-3 py-2.5 align-top text-sm',
          isMultiSource && 'border-l-2 border-settle-teal-500/50',
        )}
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
          // Target-only row clickable to pick a source. Routes
          // through createFromUnmapped on commit.
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
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-target-table"
        title={targetTable ?? undefined}
        className="truncate border-b border-gray-100 px-3 py-2.5 align-top text-sm text-slate-700"
      >
        {targetTable ?? <span className="text-gray-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-target-field"
        className="border-b border-gray-100 px-3 py-2.5 align-top text-sm"
      >
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
      </td>
      <td
        data-testid="flat-cell-confidence"
        className="border-b border-gray-100 px-3 py-2.5 align-top text-right text-sm tabular-nums"
      >
        {/* Scale-tolerant render via `formatConfidencePercent` — the
            helper handles both 0-1 fractional and 0-100 percent
            scales gracefully. Legacy data and re-run data may coexist
            on different scales during the transition window
            (per A's notes/flat-view-confidence-bug.md). For null
            confidence the helper returns "—" so the empty-state
            branch below is redundant; kept here so the band tinting
            short-circuits to neutral em-dash. */}
        {confidence === null || confidenceBand === null ? (
          <span className="text-gray-300">—</span>
        ) : (
          <span className={CONFIDENCE_BAND_TEXT[confidenceBand]}>
            {formatConfidencePercent(confidence)}
          </span>
        )}
      </td>
      <td
        data-testid="flat-cell-status"
        title={statusTooltip}
        className="border-b border-gray-100 px-3 py-2.5 align-top text-center"
      >
        <StatusDot status={displayStatus} />
      </td>
      <td className="border-b border-gray-100 px-3 py-2.5 align-top">
        <FlatRowActions
          rowId={row.id}
          isBusy={isBusy}
          onApprove={actions.onApprove}
          approveTooltip={actions.approveTooltip}
          onReject={actions.onReject}
          rejectTooltip={actions.rejectTooltip}
          onEdit={actions.onEdit}
          editTooltip={actions.editTooltip}
        />
      </td>
    </tr>
  )
}
