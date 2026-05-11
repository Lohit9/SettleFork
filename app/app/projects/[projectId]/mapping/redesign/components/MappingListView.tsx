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
  type MappedChildFlatRow,
} from '@/lib/utils/flatten-rows-for-list-view'
import { FlatStatusDot, flatStatusLabel } from './FlatStatusDot'
import { FlatRowActions } from './FlatRowActions'
import { InlineSourcePicker } from './InlineSourcePicker'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import type { MappingListMutations } from '../hooks/useMappingListMutations'

// Confidence band → text color. Matches the drawer's per-source card
// (SOURCE_CONFIDENCE_BAND_CLASSNAME) so a "92% green" on the row's
// Confidence cell reads the same as the per-source card the user
// would land on after clicking the row body.
const CONFIDENCE_BAND_CLASSNAME: Record<RowConfidenceBand, string> = {
  high: 'text-green-600 font-medium',
  amber: 'text-amber-600',
  low: 'text-red-600',
}

// ─────────────────────────────────────────────────────────────────────────────
// MappingListView — flat spreadsheet-style mapping view.
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders one row per "flat row" emitted by `flattenRowsForListView`.
// Per founder review (Option C):
//   • single-source mapped TFM  → 1 row
//   • multi-source mapped TFM   → 1 parent row + N child rows (indented)
//   • value-assignment / unmapped target → 1 row each (source cells blank)
//   • source-side ack / source-only unmapped → 1 row each (target cells blank)
//
// Columns (locked at architecture review + polish pass):
//   Source Table | Source Field | Target Table | Target Field | Confidence | Status | Actions
//
// Sort: FIXED single-pass — Source Table ASC → Source Field ASC →
// Target Table ASC → Target Field ASC. Rows lacking a source value
// (value-assignment, unmapped-target) sort to the BOTTOM, ordered by
// their target columns. Sort applies at the GROUP level — multi-source
// children stay attached to their parent in DOM order; children
// themselves follow the server's `sources[].ordinal` order. Headers
// are pure labels, no click-to-sort (v1 polish).
//
// Interactions:
//   • Click row body (anywhere except cells with their own click handler
//     or action buttons) → opens MappingDrawer with optional
//     highlightedSourceFieldId for split rows.
//   • Click Source Field cell on a mapped row → opens InlineSourcePicker
//     in single-pick autoCommit mode.
//   • Click Target Field cell on a mapped / unmapped row → opens
//     TargetFieldCellPicker in single-pick autoCommit mode.
//   • Action buttons (Approve / Reject / Edit) dispatch to
//     useMappingListMutations; e.stopPropagation stops drawer-open
//     bubbling.
//
// Responsive layout (polish pass):
//   • Outer wrapper carries `overflow-x-auto` so the table can scroll
//     horizontally at narrow viewports.
//   • Source Table + Source Field columns are `sticky left-N` so the
//     row's identity stays visible while the user scrolls right.
//   • Actions column is `sticky right-0` so the action affordances
//     stay reachable.
//   • Long field names use `truncate` + `title` for full text on
//     hover.
//
// Re-render orchestration:
//   • All mutations call router.refresh() on success (in the hook).
//   • Server-side unmapped-row synthesis handles last-source reject +
//     manual-create transitions atomically — no client-side state
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

function buildGroupSortKeys(
  parent: FlatRow,
  dominantChildSource: MappedChildFlatRow | null,
): GroupSortKeys {
  switch (parent.kind) {
    case 'mapped-single':
      return {
        bucket: 0,
        sourceTable: parent.source.sourceTable.name,
        sourceField: parent.source.sourceField.name,
        targetTable: parent.targetField.targetTable.name,
        targetField: parent.targetField.name,
      }
    case 'mapped-parent':
      return {
        bucket: 0,
        sourceTable: dominantChildSource?.source.sourceTable.name ?? '',
        sourceField: dominantChildSource?.source.sourceField.name ?? '',
        targetTable: parent.targetField.targetTable.name,
        targetField: parent.targetField.name,
      }
    case 'unmapped-source':
      return {
        bucket: 0,
        sourceTable: parent.sourceField.sourceTable.name,
        sourceField: parent.sourceField.name,
        targetTable: '',
        targetField: '',
      }
    case 'value-assignment':
    case 'unmapped-target':
      return {
        bucket: 1,
        sourceTable: '',
        sourceField: '',
        targetTable: parent.targetField.targetTable.name,
        targetField: parent.targetField.name,
      }
    case 'mapped-child':
      // Children are sorted with their parent group; this branch is
      // unreachable when buildGroupSortKeys runs on the group's anchor.
      return {
        bucket: 0,
        sourceTable: '',
        sourceField: '',
        targetTable: '',
        targetField: '',
      }
  }
}

function compareStringsAsc(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function compareGroupKeys(a: GroupSortKeys, b: GroupSortKeys): number {
  if (a.bucket !== b.bucket) return a.bucket - b.bucket
  const st = compareStringsAsc(a.sourceTable, b.sourceTable)
  if (st !== 0) return st
  const sf = compareStringsAsc(a.sourceField, b.sourceField)
  if (sf !== 0) return sf
  const tt = compareStringsAsc(a.targetTable, b.targetTable)
  if (tt !== 0) return tt
  return compareStringsAsc(a.targetField, b.targetField)
}

// ─── Row grouping for fixed sort ──────────────────────────────────────────────

interface FlatGroup {
  anchor: FlatRow
  children: MappedChildFlatRow[]
  sortKeys: GroupSortKeys
}

function buildGroups(rows: readonly FlatRow[]): FlatGroup[] {
  const groups: FlatGroup[] = []
  let current: FlatGroup | null = null

  const finalize = () => {
    if (current === null) return
    const dominant =
      current.anchor.kind === 'mapped-parent'
        ? current.children[0] ?? null
        : null
    current.sortKeys = buildGroupSortKeys(current.anchor, dominant)
    groups.push(current)
    current = null
  }

  for (const row of rows) {
    if (row.kind === 'mapped-child') {
      // Attach to current parent group; falls back to standalone group
      // if the producer order put a child without a preceding parent
      // (shouldn't happen).
      if (current && current.anchor.kind === 'mapped-parent') {
        current.children.push(row)
        continue
      }
    }
    finalize()
    current = {
      anchor: row,
      children: [],
      // sortKeys is populated by finalize(); placeholder for type.
      sortKeys: {
        bucket: 0,
        sourceTable: '',
        sourceField: '',
        targetTable: '',
        targetField: '',
      },
    }
  }
  finalize()
  return groups
}

function flattenGroups(groups: readonly FlatGroup[]): FlatRow[] {
  const out: FlatRow[] = []
  for (const group of groups) {
    out.push(group.anchor)
    for (const child of group.children) out.push(child)
  }
  return out
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

  // Fixed single-pass sort — see `compareGroupKeys` for the contract.
  // No UI state, no re-sort on header click (polish pass).
  const sortedRows = useMemo(() => {
    const groups = buildGroups(flatRows)
    groups.sort((a, b) => compareGroupKeys(a.sortKeys, b.sortKeys))
    return flattenGroups(groups)
  }, [flatRows])

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
      //   • mapped-single  → swap that source's source field
      //   • mapped-child   → swap that contributor's source field
      //   • unmapped-target → create-mapping flow (target picks a source)
      //   • unmapped-source → noop (the source is the row's identity)
      //   • value-assignment → no source cell, no click
      if (row.kind === 'mapped-single' || row.kind === 'mapped-child') {
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
      //   • mapped-single | mapped-parent → swap TFM target field
      //   • value-assignment | unmapped-target → swap target (unusual,
      //     but allowed for target swaps from unmapped state)
      //   • unmapped-source → create-mapping flow (source picks a target)
      //   • mapped-child → resolves to parent TFM target swap
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
      const targetFieldId =
        row.kind === 'mapped-child'
          ? row.parentRow.targetField.id
          : row.kind === 'mapped-single' ||
              row.kind === 'mapped-parent' ||
              row.kind === 'value-assignment' ||
              row.kind === 'unmapped-target'
            ? row.targetField.id
            : null
      if (targetFieldId === null) return
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
      const tfmId =
        row.kind === 'mapped-child' ? row.parentRow.id : row.groupId
      const highlightedSourceFieldId =
        row.kind === 'mapped-child' ? row.source.sourceField.id : null
      onOpenDrawer(tfmId, highlightedSourceFieldId)
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
      // Standard swap-target on an existing TFM. For mapped-child, the
      // tfmId is parentRow.id (groupId).
      return mutations.swapMappingTarget(
        openPicker.rowId.split('::')[0],
        newTargetFieldId,
      )
    },
    [mutations, openPicker],
  )

  return (
    <div data-testid="mapping-list-view" className="overflow-x-auto">
      <table className="w-full min-w-[1008px] border-separate border-spacing-0 text-xs">
        <thead className="bg-gray-50">
          <tr>
            {/*
              Leftmost column = status dot only (no header text). The
              dot's title attribute carries the status label, so the
              column does not need its own header for accessibility.
            */}
            <th
              scope="col"
              data-testid="flat-header-status"
              aria-label="Status"
              className="sticky left-0 z-20 w-8 border-b border-gray-200 bg-gray-50 px-2 py-2"
            />
            <TableHeader
              column="targetTable"
              label="Target Table"
              className="sticky left-8 z-20 w-44 bg-gray-50"
            />
            <TableHeader
              column="targetField"
              label="Target Field"
              className="sticky left-52 z-20 w-56 bg-gray-50"
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
              align="right"
              className="w-24 bg-gray-50"
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
  const isChild = row.kind === 'mapped-child'
  const isParent = row.kind === 'mapped-parent'

  const sourceCellRef = useRef<HTMLButtonElement | null>(null)
  const targetCellRef = useRef<HTMLButtonElement | null>(null)

  // ── Cell display values ───────────────────────────────────────────
  const sourceTable = useMemo(() => {
    switch (row.kind) {
      case 'mapped-single':
      case 'mapped-child':
        return row.source.sourceTable.name
      case 'unmapped-source':
        return row.sourceField.sourceTable.name
      default:
        return null
    }
  }, [row])

  const sourceField = useMemo(() => {
    switch (row.kind) {
      case 'mapped-single':
      case 'mapped-child':
        return row.source.sourceField.name
      case 'unmapped-source':
        return row.sourceField.name
      default:
        return null
    }
  }, [row])

  const targetTable = useMemo(() => {
    switch (row.kind) {
      case 'mapped-single':
      case 'mapped-parent':
      case 'value-assignment':
      case 'unmapped-target':
        return row.targetField.targetTable.name
      default:
        return null
    }
  }, [row])

  const targetField = useMemo(() => {
    switch (row.kind) {
      case 'mapped-single':
      case 'mapped-parent':
      case 'value-assignment':
      case 'unmapped-target':
        return row.targetField.name
      default:
        return null
    }
  }, [row])

  const confidence = useMemo(() => {
    switch (row.kind) {
      case 'mapped-single':
      case 'mapped-child':
      case 'mapped-parent':
      case 'value-assignment':
      case 'unmapped-target':
        return row.confidence
      default:
        return null
    }
  }, [row])

  // ── Source-cell editability ───────────────────────────────────────
  const sourceCellEditable =
    row.kind === 'mapped-single' || row.kind === 'mapped-child'

  // ── Target-cell editability ───────────────────────────────────────
  const targetCellEditable =
    row.kind === 'mapped-single' ||
    row.kind === 'mapped-parent' ||
    row.kind === 'unmapped-source'

  // ── Action handlers per row kind ──────────────────────────────────
  //
  // Polish pass (second round) — only ✓ Approve and ✗ Reject render.
  // Edit was dropped: every edit path has a direct cell-click
  // affordance (source/target cells open inline pickers; row body
  // click opens the drawer for full edits). When an action is not
  // applicable (already-approved, already-rejected, unmapped without
  // any mapping to approve), the handler is left `undefined` and
  // FlatRowActions simply omits the button — no greyed-out chrome.
  const actions = useMemo(() => {
    const alreadyApproved = row.status === 'approved'
    const alreadyRejected = row.status === 'rejected'

    if (row.kind === 'mapped-single' || row.kind === 'mapped-parent') {
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
    if (row.kind === 'mapped-child') {
      return {
        onApprove: alreadyApproved
          ? undefined
          : () => void mutations.approveTfm(row.parentRow.id),
        approveTooltip: 'Approve parent mapping',
        onReject: () => void mutations.rejectTfm(row.id),
        rejectTooltip: 'Remove this source attribution',
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
        // Nothing to approve on an unmapped row — the Approve button is
        // omitted (cleaner than rendering a greyed-out icon).
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

  // Status tooltip: combine status label with the optional ack reason
  // so the dot's `title` attribute carries everything the user could
  // previously see in the text column.
  const statusTooltip =
    row.kind === 'unmapped-source' && row.acknowledgmentReason
      ? `${flatStatusLabel(row.status)} · ${row.acknowledgmentReason}`
      : flatStatusLabel(row.status)

  // Source-cell editability now includes unmapped-target (the user
  // can pick a source for an unaddressed target, which routes through
  // createFromUnmapped). mapped-single / mapped-child still
  // swap-in-place via updateMappingSourceField.
  const sourceCellClickable =
    sourceCellEditable || row.kind === 'unmapped-target'

  // Confidence band color — matches the drawer's per-source card.
  const confidenceBand =
    confidence === null ? null : classifyRowConfidence(confidence)

  // ── Render ────────────────────────────────────────────────────────
  //
  // Sticky-column layout (second polish pass):
  //   • Status dot     →  sticky left-0     (32px; no header)
  //   • Target Table   →  sticky left-8     (176px)
  //   • Target Field   →  sticky left-52    (224px)  (52 = 8 + 44)
  //   • Source Table / Field / Confidence — scroll naturally
  //   • Actions        →  sticky right-0    (✓ ✗ only)
  //
  // The `group` class on the `<tr>` lets sticky cells participate in
  // the row's hover state. Sticky cells need their own white bg to
  // cover scrolled content underneath, and an explicit
  // `group-hover:bg-gray-50` to lift on hover.
  //
  // Zebra striping dropped; rows are uniformly white. Multi-source
  // parent rows are distinguished by `font-medium` only; children
  // retain a small `pl-6` indent on the Target Table cell to mark
  // the Option C parent-child hierarchy visually.
  return (
    <tr
      data-testid="flat-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-group-id={row.groupId}
      onClick={() => onRowBodyClick(row)}
      className={cn(
        'group cursor-pointer bg-white transition-colors hover:bg-gray-50',
        isParent && 'font-medium',
      )}
    >
      <td
        data-testid="flat-cell-status"
        title={statusTooltip}
        className="sticky left-0 z-10 w-8 border-b border-gray-100 bg-white px-2 py-2 transition-colors group-hover:bg-gray-50"
      >
        <FlatStatusDot status={row.status} />
      </td>
      <td
        data-testid="flat-cell-target-table"
        title={targetTable ?? undefined}
        className={cn(
          'sticky left-8 z-10 w-44 truncate border-b border-gray-100 bg-white px-3 py-2 text-slate-700 transition-colors group-hover:bg-gray-50',
          isChild && 'pl-6',
        )}
      >
        {targetTable ?? <span className="text-slate-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-target-field"
        title={typeof targetField === 'string' ? targetField : undefined}
        className="sticky left-52 z-10 w-56 truncate border-b border-gray-100 bg-white px-3 py-2 font-mono text-[11px] text-slate-700 transition-colors group-hover:bg-gray-50"
      >
        {targetField ? (
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
                'inline-flex w-full max-w-full items-center justify-start truncate rounded px-1 py-0.5 text-left',
                'hover:bg-blue-100/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
              )}
            >
              {targetField}
            </button>
          ) : (
            <span className="block truncate">{targetField}</span>
          )
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-source-table"
        title={sourceTable ?? undefined}
        className="w-44 truncate border-b border-gray-100 px-3 py-2 text-slate-700"
      >
        {sourceTable ?? <span className="text-slate-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-source-field"
        title={
          typeof sourceField === 'string' && sourceCellClickable
            ? sourceField
            : undefined
        }
        className="w-56 truncate border-b border-gray-100 px-3 py-2 font-mono text-[11px] text-slate-700"
      >
        {sourceField ? (
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
                'inline-flex w-full max-w-full items-center justify-start truncate rounded px-1 py-0.5 text-left',
                'hover:bg-blue-100/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
              )}
            >
              {sourceField}
            </button>
          ) : (
            <span className="block truncate">{sourceField}</span>
          )
        ) : isParent ? (
          <span className="italic text-slate-400">
            {row.sourceCount} sources
          </span>
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
              'inline-flex w-full items-center justify-start rounded px-1 py-0.5 text-left',
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
        className="w-24 border-b border-gray-100 px-3 py-2 text-right tabular-nums"
      >
        {confidence === null || confidenceBand === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span className={CONFIDENCE_BAND_CLASSNAME[confidenceBand]}>
            {formatConfidencePercent(confidence)}
          </span>
        )}
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
