'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/components/ui/utils'
import {
  classifyRowConfidence,
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

// Confidence band → text color. Matches the drawer's per-source card
// (SOURCE_CONFIDENCE_BAND_CLASSNAME) so a "92% green" on the row's
// Confidence cell reads the same as the per-source card the user
// would land on after clicking the row body.
const CONFIDENCE_BAND_TEXT: Record<RowConfidenceBand, string> = {
  high: 'text-green-700 font-medium',
  amber: 'text-amber-700',
  low: 'text-red-700',
}
const CONFIDENCE_BAND_FILL: Record<RowConfidenceBand, string> = {
  high: 'bg-green-500',
  amber: 'bg-amber-500',
  low: 'bg-red-500',
}

// ─── Visual subcomponents (Settle-platform-styled) ───────────────────────────
//
// FieldNameChip — small gray monospace pill for individual field names.
// Mirrors the TableBadge aesthetic (`rounded bg-slate-100 font-mono`) at
// a slightly smaller size so the chip reads as a field identifier
// inside the row's flow, not a table heading.
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
        'inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 align-middle font-mono text-[11px] font-medium text-slate-700',
        className,
      )}
    >
      {name}
    </span>
  )
}

// ConfidenceBar — thin horizontal track (16px wide) + colored fill +
// percentage. Bar is decorative (carries the band visually), the
// percentage is the authoritative number.
function ConfidenceBar({
  confidence,
  band,
}: {
  confidence: number
  band: RowConfidenceBand
}) {
  const pct = Math.max(0, Math.min(100, Math.round(confidence)))
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="relative inline-block h-1 w-16 overflow-hidden rounded-full bg-slate-200"
      >
        <span
          className={cn('absolute inset-y-0 left-0', CONFIDENCE_BAND_FILL[band])}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={cn(
          'inline-block w-8 text-right tabular-nums text-[11px]',
          CONFIDENCE_BAND_TEXT[band],
        )}
      >
        {pct}%
      </span>
    </span>
  )
}

// MultiSourceBadge — blue chip carrying the source count, paired with
// a "Multiple sources" caption. Used in the source-table cell when a
// TFM has 2+ contributing sources (the founder's reference shot).
function MultiSourceBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <span
        data-testid="multi-source-count-badge"
        className="inline-flex items-center justify-center rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-700"
      >
        {count}×
      </span>
      <span className="text-[12px] text-slate-700">Multiple sources</span>
    </span>
  )
}

// Display status — derived from FlatRowStatus + row kind so that
// unaddressed unmapped rows (target-side or source-side) surface as
// "Unmapped" rather than "Needs Review". Matches the founder's
// reference shot: gray-pill "Unmapped" rows sit alongside amber-pill
// "Needs review" rows.
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

const STATUS_PILL_CONFIG: Record<
  DisplayStatus,
  { label: string; pill: string; dot: string }
> = {
  approved: {
    label: 'Approved',
    pill: 'bg-green-50 text-green-700',
    dot: 'bg-green-500',
  },
  needs_review: {
    label: 'Needs review',
    pill: 'bg-amber-50 text-amber-700',
    dot: 'bg-amber-500',
  },
  rejected: {
    label: 'Rejected',
    pill: 'bg-slate-100 text-slate-600',
    dot: 'bg-slate-400',
  },
  unmapped: {
    label: 'Unmapped',
    pill: 'bg-slate-100 text-slate-500',
    dot: 'bg-slate-300',
  },
}

function StatusPill({ status }: { status: DisplayStatus }) {
  const config = STATUS_PILL_CONFIG[status]
  return (
    <span
      data-testid="flat-status-pill"
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        config.pill,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 rounded-full', config.dot)}
      />
      {config.label}
    </span>
  )
}

function statusTooltipFor(row: FlatRow): string {
  const label = STATUS_PILL_CONFIG[deriveDisplayStatus(row)].label
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
// Polish pass dropped click-to-sort headers (v2 polish). The flat
// view now applies a single fixed ordering at render time:
//
//   Source Table ASC → Source Field ASC → Target Table ASC →
//   Target Field ASC
//
// Rows that LACK a source value (value-assignment, unmapped-target)
// sort to the BOTTOM, ordered by their target columns. This keeps
// mapped rows first (auditor-friendly: the meat is at the top) and
// "constant defaults" / unaddressed-target rows at the bottom.
//
// Sort operates at the GROUP level. Multi-source mapped TFMs (parent
// + N children) use the DOMINANT child's source for source-column
// sort keys; children themselves follow the server-emitted
// `sources[].ordinal` order within the group.

interface GroupSortKeys {
  /**
   * 0 = group has a source (mapped-single, mapped-parent,
   * unmapped-source); 1 = group lacks a source (value-assignment,
   * unmapped-target). Primary discriminator so blank-source rows
   * always sort to the bottom regardless of subsequent keys.
   */
  bucket: 0 | 1
  sourceTable: string
  sourceField: string
  targetTable: string
  targetField: string
}

function buildSortKeys(row: FlatRow): GroupSortKeys {
  switch (row.kind) {
    case 'mapped': {
      // Multi-source TFMs sort on the DOMINANT source (ordinal=0,
      // which is sources[0] per server contract).
      const dominant = row.sources[0]
      return {
        bucket: 0,
        sourceTable: dominant.sourceTable.name,
        sourceField: dominant.sourceField.name,
        targetTable: row.targetField.targetTable.name,
        targetField: row.targetField.name,
      }
    }
    case 'unmapped-source':
      return {
        bucket: 0,
        sourceTable: row.sourceField.sourceTable.name,
        sourceField: row.sourceField.name,
        targetTable: '',
        targetField: '',
      }
    case 'value-assignment':
    case 'unmapped-target':
      return {
        bucket: 1,
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
  const st = compareStringsAsc(a.sourceTable, b.sourceTable)
  if (st !== 0) return st
  const sf = compareStringsAsc(a.sourceField, b.sourceField)
  if (sf !== 0) return sf
  const tt = compareStringsAsc(a.targetTable, b.targetTable)
  if (tt !== 0) return tt
  return compareStringsAsc(a.targetField, b.targetField)
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
      // Source-cell click opens the source picker for the rows that
      // have a meaningful source slot to address:
      //   • mapped (single source) → swap that source's source field
      //   • mapped (multi source)  → no inline edit (open drawer instead)
      //   • unmapped-target        → create-mapping flow (target picks
      //                              a source)
      //   • unmapped-source        → noop (source IS the row identity)
      //   • value-assignment       → no source cell, no click
      if (row.kind === 'mapped' && row.sources.length === 1) {
        setOpenPicker({
          kind: 'source',
          rowId: row.id,
          anchorEl,
          initialSourceFieldIds: [row.sources[0].sourceField.id],
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
      // For multi-source mapped TFMs, the drawer opens with no
      // pre-highlighted source (all contributors render equally in
      // the Sources section). The flat view no longer routes through
      // a per-contributor click since multi-source renders as one
      // compact row.
      onOpenDrawer(row.groupId, null)
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
      // Standard swap-target on an existing TFM. With multi-source
      // TFMs rendered as a single row, rowId always equals the bare
      // TFM uuid (no `<tfm>::<source>` shim ids since the second
      // polish pass dropped per-contributor flat rows).
      return mutations.swapMappingTarget(openPicker.rowId, newTargetFieldId)
    },
    [mutations, openPicker],
  )

  return (
    <div data-testid="mapping-list-view" className="overflow-x-auto">
      <table className="w-full min-w-[1136px] border-separate border-spacing-0 text-xs">
        <thead className="bg-gray-50">
          <tr>
            <TableHeader
              column="targetTable"
              label="Target Table"
              className="sticky left-0 z-20 w-44 bg-gray-50"
            />
            <TableHeader
              column="targetField"
              label="Target Field"
              className="sticky left-44 z-20 w-56 bg-gray-50"
            />
            <TableHeader
              column="sourceTable"
              label="Source Table"
              className="w-44 bg-gray-50"
            />
            <TableHeader
              column="sourceField"
              label="Source Field"
              className="w-56 bg-gray-50"
            />
            <TableHeader
              column="confidence"
              label="Confidence"
              className="w-32 bg-gray-50"
            />
            <TableHeader
              column="status"
              label="Status"
              className="w-32 bg-gray-50"
            />
            <th
              scope="col"
              data-testid="flat-header-actions"
              aria-label="Actions"
              className="sticky right-0 z-20 w-20 border-b border-gray-200 bg-gray-50 px-3 py-2"
            />
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="px-3 py-12 text-center text-xs italic text-slate-400"
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
// Static label only — no click-to-sort (v2 polish). FilterRow remains
// the canonical filter surface; the flat view's row order is fixed
// per `compareGroupKeys`.

function TableHeader({
  column,
  label,
  className,
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
  className?: string
  align?: 'right'
}) {
  return (
    <th
      scope="col"
      data-testid={`flat-header-${column}`}
      className={cn(
        'border-b border-gray-200 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-600',
        align === 'right' && 'text-right',
        className,
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
  const isMultiSource = row.kind === 'mapped' && row.sources.length > 1
  const dominantSource =
    row.kind === 'mapped' ? row.sources[0] : null

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
    if (row.kind === 'mapped' && !isMultiSource && dominantSource) {
      return dominantSource.sourceTable.name
    }
    if (row.kind === 'unmapped-source') return row.sourceField.sourceTable.name
    return null
  })()

  const sourceFieldName = (() => {
    if (row.kind === 'mapped' && !isMultiSource && dominantSource) {
      return dominantSource.sourceField.name
    }
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
  //   • single-source mapped → swap source
  //   • unmapped-target → create-from-unmapped (target picks source)
  // Multi-source mapped intentionally does NOT support inline source
  // editing — the user opens the drawer to manage contributors.
  const sourceCellClickable =
    (row.kind === 'mapped' && !isMultiSource) ||
    row.kind === 'unmapped-target'

  const confidenceBand =
    confidence === null ? null : classifyRowConfidence(confidence)

  const displayStatus = deriveDisplayStatus(row)
  const statusTooltip = statusTooltipFor(row)

  // ── Action handlers per row kind ──────────────────────────────────
  //
  // Only ✓ Approve and ✗ Reject render. Edit was dropped: every edit
  // path has a direct cell-click affordance (source/target cells open
  // inline pickers; row body click opens the drawer). When an action
  // is not applicable (already-approved, already-rejected, unmapped
  // without a mapping to approve), the handler is left `undefined`
  // and FlatRowActions omits the button entirely.
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
        rejectTooltip: 'Reject mapping',
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
    }
  }, [mutations, row])

  // ── Render ────────────────────────────────────────────────────────
  //
  // Sticky-column layout (third polish pass — founder reference shot):
  //   • Target Table   →  sticky left-0   (176px)
  //   • Target Field   →  sticky left-44  (224px)
  //   • Source Table / Field / Confidence / Status — scroll naturally
  //   • Actions        →  sticky right-0  (✓ ✗ only)
  //
  // Multi-source mapped TFMs render as ONE row with a blue `N×` badge
  // in Source Table and "N fields combined" italic in Source Field —
  // per-contributor edits route through the drawer.
  //
  // Field names use FieldNameChip (gray rounded monospace pill);
  // table names render as plain truncated text. Status is a
  // text+dot pill at the right; confidence is a thin colored bar +
  // colored percentage.
  return (
    <tr
      data-testid="flat-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-group-id={row.groupId}
      data-multi-source={isMultiSource ? 'true' : 'false'}
      onClick={() => onRowBodyClick(row)}
      className="group cursor-pointer bg-white transition-colors hover:bg-gray-50"
    >
      <td
        data-testid="flat-cell-target-table"
        title={targetTable ?? undefined}
        className="sticky left-0 z-10 w-44 truncate border-b border-gray-100 bg-white px-3 py-2 text-slate-700 transition-colors group-hover:bg-gray-50"
      >
        {targetTable ?? <span className="text-slate-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-target-field"
        className="sticky left-44 z-10 w-56 border-b border-gray-100 bg-white px-3 py-2 transition-colors group-hover:bg-gray-50"
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
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-source-table"
        title={sourceTableName ?? undefined}
        className="w-44 truncate border-b border-gray-100 px-3 py-2 text-slate-700"
      >
        {isMultiSource && row.kind === 'mapped' ? (
          <MultiSourceBadge count={row.sources.length} />
        ) : sourceTableName ? (
          sourceTableName
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-source-field"
        className="w-56 border-b border-gray-100 px-3 py-2"
      >
        {isMultiSource && row.kind === 'mapped' ? (
          <span className="block truncate text-[11px] italic text-slate-500">
            {row.sources.length} fields combined
          </span>
        ) : sourceFieldName ? (
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
          // Target-only row clickable to pick a source. Routes through
          // createFromUnmapped on commit (handleSourcePickerCommit
          // branches on targetFieldIdForCreate).
          <button
            ref={sourceCellRef}
            type="button"
            data-testid="flat-cell-source-field-button"
            onClick={(e) => {
              e.stopPropagation()
              onSourceCellClick(row, e.currentTarget)
            }}
            className={cn(
              'inline-flex items-center justify-start rounded px-1 py-0.5 text-[11px]',
              'italic text-slate-400 hover:bg-blue-100/60 hover:text-slate-600',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
            )}
          >
            Pick a source…
          </button>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-confidence"
        className="w-32 border-b border-gray-100 px-3 py-2"
      >
        {confidence === null || confidenceBand === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          <ConfidenceBar confidence={confidence} band={confidenceBand} />
        )}
      </td>
      <td
        data-testid="flat-cell-status"
        title={statusTooltip}
        className="w-32 border-b border-gray-100 px-3 py-2"
      >
        <StatusPill status={displayStatus} />
      </td>
      <td className="sticky right-0 z-10 w-20 border-b border-gray-100 bg-white px-3 py-2 transition-colors group-hover:bg-gray-50">
        <FlatRowActions
          rowId={row.id}
          isBusy={isBusy}
          onApprove={actions.onApprove}
          approveTooltip={actions.approveTooltip}
          onReject={actions.onReject}
          rejectTooltip={actions.rejectTooltip}
        />
      </td>
    </tr>
  )
}
