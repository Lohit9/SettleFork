'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { formatConfidencePercent } from '@/lib/utils/confidence-format'
import type {
  MappingsForRedesignResult,
  SourceFieldWithState,
  TargetFieldRef,
} from '@/lib/types/mappings-for-redesign'
import {
  flattenRowsForListView,
  type FlatRow,
  type FlatRowStatus,
  type MappedChildFlatRow,
  type MappedSingleFlatRow,
  type UnmappedSourceFlatRow,
} from '@/lib/utils/flatten-rows-for-list-view'
import { FlatStatusDot, flatStatusLabel } from './FlatStatusDot'
import { FlatRowActions } from './FlatRowActions'
import { InlineSourcePicker } from './InlineSourcePicker'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import type { MappingListMutations } from '../hooks/useMappingListMutations'

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
// Columns (locked at architecture review):
//   Source Table | Source Field | Target Table | Target Field | Confidence | Status | Actions
//
// Default sort: Source Table ASC → Source Field ASC → Target Table ASC → Target Field ASC.
// Click headers to override. Sort operates at the GROUP level (multi-
// source children stay attached to their parent in DOM order). Within
// a group, children follow the server's `sources[].ordinal` order.
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
// Re-render orchestration:
//   • All mutations call router.refresh() on success (in the hook).
//   • Server-side unmapped-row synthesis handles last-source reject +
//     manual-create transitions atomically — no client-side state
//     plumbing needed.

// ─── Sort state ───────────────────────────────────────────────────────────────

export type SortColumn =
  | 'sourceTable'
  | 'sourceField'
  | 'targetTable'
  | 'targetField'
  | 'confidence'
  | 'status'

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  column: SortColumn
  direction: SortDirection
}

const DEFAULT_SORT: SortState = {
  column: 'sourceTable',
  direction: 'asc',
}

// Default sort: source-first → fallback to target. Implemented as a
// composite comparator at the group level (see comparators below).

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

// ─── Comparators ──────────────────────────────────────────────────────────────

interface GroupSortKeys {
  sourceTable: string
  sourceField: string
  targetTable: string
  targetField: string
  confidence: number
  status: FlatRowStatus
}

/**
 * Compute group-level sort keys from the parent/leaf flat row of a
 * group. For multi-source mapped groups, the parent is the
 * MappedParentFlatRow and its source-side keys are derived from the
 * dominant child (ordinal=0); for everything else the leaf row's own
 * source/target fields are used directly. Confidence is the group's
 * aggregate (server-emitted TFM-level confidence for mapped, the row's
 * own confidence for leaves). Status uses the parent's status.
 */
function buildGroupSortKeys(
  parent: FlatRow,
  dominantChildSource: MappedChildFlatRow | null,
): GroupSortKeys {
  let sourceTable = ''
  let sourceField = ''
  let targetTable = ''
  let targetField = ''
  let confidence = Number.POSITIVE_INFINITY
  const status = parent.status

  switch (parent.kind) {
    case 'mapped-single': {
      const row = parent as MappedSingleFlatRow
      sourceTable = row.source.sourceTable.name
      sourceField = row.source.sourceField.name
      targetTable = row.targetField.targetTable.name
      targetField = row.targetField.name
      confidence = row.confidence ?? Number.POSITIVE_INFINITY
      break
    }
    case 'mapped-parent': {
      if (dominantChildSource) {
        sourceTable = dominantChildSource.source.sourceTable.name
        sourceField = dominantChildSource.source.sourceField.name
      }
      targetTable = parent.targetField.targetTable.name
      targetField = parent.targetField.name
      confidence = parent.confidence ?? Number.POSITIVE_INFINITY
      break
    }
    case 'value-assignment':
    case 'unmapped-target': {
      targetTable = parent.targetField.targetTable.name
      targetField = parent.targetField.name
      confidence = parent.confidence ?? Number.POSITIVE_INFINITY
      break
    }
    case 'unmapped-source': {
      const row = parent as UnmappedSourceFlatRow
      sourceTable = row.sourceField.sourceTable.name
      sourceField = row.sourceField.name
      break
    }
    case 'mapped-child':
      // Children are sorted within their parent group; this branch is
      // unreachable when buildGroupSortKeys is called on the group's
      // anchor row. Guarded for exhaustiveness.
      break
  }

  return { sourceTable, sourceField, targetTable, targetField, confidence, status }
}

function compareStringsAsc(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

const STATUS_ORDER: Record<FlatRowStatus, number> = {
  needs_review: 0,
  approved: 1,
  rejected: 2,
}

function compareKeys(
  a: GroupSortKeys,
  b: GroupSortKeys,
  sort: SortState,
): number {
  const dir = sort.direction === 'asc' ? 1 : -1
  let primary = 0
  switch (sort.column) {
    case 'sourceTable':
      primary = compareStringsAsc(a.sourceTable, b.sourceTable)
      break
    case 'sourceField':
      primary = compareStringsAsc(a.sourceField, b.sourceField)
      break
    case 'targetTable':
      primary = compareStringsAsc(a.targetTable, b.targetTable)
      break
    case 'targetField':
      primary = compareStringsAsc(a.targetField, b.targetField)
      break
    case 'confidence':
      primary = a.confidence - b.confidence
      break
    case 'status':
      primary = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      break
  }
  if (primary !== 0) return primary * dir
  // Stable tiebreak chain — applied in the SAME direction as primary.
  const ts = compareStringsAsc(a.sourceTable, b.sourceTable)
  if (ts !== 0) return ts * dir
  const sf = compareStringsAsc(a.sourceField, b.sourceField)
  if (sf !== 0) return sf * dir
  const tt = compareStringsAsc(a.targetTable, b.targetTable)
  if (tt !== 0) return tt * dir
  const tf = compareStringsAsc(a.targetField, b.targetField)
  return tf * dir
}

// ─── Row grouping for sort ────────────────────────────────────────────────────

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
        sourceTable: '',
        sourceField: '',
        targetTable: '',
        targetField: '',
        confidence: Number.POSITIVE_INFINITY,
        status: row.status,
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
  | { kind: 'source'; rowId: string; anchorEl: HTMLElement; initialSourceFieldIds: string[] }
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
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT)
  const [openPicker, setOpenPicker] = useState<OpenPickerState>(null)

  const flatRows = useMemo(
    () =>
      flattenRowsForListView(filteredResult, { showUnmappedSourceFields }),
    [filteredResult, showUnmappedSourceFields],
  )

  const sortedRows = useMemo(() => {
    const groups = buildGroups(flatRows)
    groups.sort((a, b) => compareKeys(a.sortKeys, b.sortKeys, sort))
    return flattenGroups(groups)
  }, [flatRows, sort])

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

  const handleSortClick = useCallback((column: SortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) {
        return { column, direction: 'asc' }
      }
      return {
        column,
        direction: prev.direction === 'asc' ? 'desc' : 'asc',
      }
    })
  }, [])

  const handleSourceCellClick = useCallback(
    (row: FlatRow, anchorEl: HTMLElement) => {
      // Source-cell click opens the source picker for the rows that
      // have a meaningful source slot to edit:
      //   • mapped-single → swap that source's source field
      //   • mapped-child  → swap that contributor's source field
      //   • unmapped-source → noop (the source is the row's identity)
      //   • everything else → no source cell, no click
      if (row.kind !== 'mapped-single' && row.kind !== 'mapped-child') {
        return
      }
      setOpenPicker({
        kind: 'source',
        rowId: row.id,
        anchorEl,
        initialSourceFieldIds: [row.source.sourceField.id],
      })
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
      const result = await mutations.swapMappingSource(
        openPicker.rowId,
        newId,
      )
      return result
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
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
          <tr>
            <SortableTh
              column="sourceTable"
              label="Source Table"
              sort={sort}
              onClick={handleSortClick}
              className="w-[14%]"
            />
            <SortableTh
              column="sourceField"
              label="Source Field"
              sort={sort}
              onClick={handleSortClick}
              className="w-[18%]"
            />
            <SortableTh
              column="targetTable"
              label="Target Table"
              sort={sort}
              onClick={handleSortClick}
              className="w-[14%]"
            />
            <SortableTh
              column="targetField"
              label="Target Field"
              sort={sort}
              onClick={handleSortClick}
              className="w-[18%]"
            />
            <SortableTh
              column="confidence"
              label="Confidence"
              sort={sort}
              onClick={handleSortClick}
              align="right"
              className="w-[10%]"
            />
            <SortableTh
              column="status"
              label="Status"
              sort={sort}
              onClick={handleSortClick}
              className="w-[12%]"
            />
            <th
              scope="col"
              data-testid="flat-header-actions"
              className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-600"
            >
              Actions
            </th>
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

function SortableTh({
  column,
  label,
  sort,
  onClick,
  className,
  align,
}: {
  column: SortColumn
  label: string
  sort: SortState
  onClick: (column: SortColumn) => void
  className?: string
  align?: 'right'
}) {
  const isActive = sort.column === column
  const Icon = isActive
    ? sort.direction === 'asc'
      ? ChevronUp
      : ChevronDown
    : ChevronsUpDown
  return (
    <th
      scope="col"
      data-testid={`flat-header-${column}`}
      data-sort-active={isActive ? 'true' : 'false'}
      data-sort-direction={isActive ? sort.direction : undefined}
      className={cn(
        'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-600',
        align === 'right' && 'text-right',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onClick(column)}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-gray-900',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        <span>{label}</span>
        <Icon
          aria-hidden="true"
          className={cn(
            'h-3 w-3',
            isActive ? 'text-gray-700' : 'text-gray-400',
          )}
        />
      </button>
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
  const actions = useMemo(() => {
    const approveDisabledReason = (() => {
      if (row.status === 'approved') return 'Already approved'
      return null
    })()

    const rejectDisabledReason = (() => {
      if (row.status === 'rejected') return 'Already rejected'
      return null
    })()

    if (row.kind === 'mapped-single' || row.kind === 'mapped-parent') {
      return {
        onApprove:
          approveDisabledReason === null
            ? () => void mutations.approveTfm(row.id)
            : undefined,
        approveTooltip: approveDisabledReason ?? 'Approve mapping',
        onReject:
          rejectDisabledReason === null
            ? () => void mutations.rejectTfm(row.id)
            : undefined,
        rejectTooltip: rejectDisabledReason ?? 'Reject mapping',
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open mapping in drawer',
      }
    }
    if (row.kind === 'mapped-child') {
      return {
        onApprove:
          approveDisabledReason === null
            ? () => void mutations.approveTfm(row.parentRow.id)
            : undefined,
        approveTooltip: approveDisabledReason ?? 'Approve parent mapping',
        onReject: () => void mutations.rejectTfm(row.id),
        rejectTooltip: 'Remove this source attribution',
        onEdit: () => {
          if (sourceCellRef.current) {
            onSourceCellClick(row, sourceCellRef.current)
          }
        },
        editTooltip: 'Swap source field',
      }
    }
    if (row.kind === 'value-assignment') {
      return {
        onApprove:
          approveDisabledReason === null
            ? () => void mutations.approveTfm(row.id)
            : undefined,
        approveTooltip: approveDisabledReason ?? 'Approve value assignment',
        onReject:
          rejectDisabledReason === null
            ? () => void mutations.rejectTfm(row.id)
            : undefined,
        rejectTooltip: rejectDisabledReason ?? 'Reject value assignment',
        onEdit: () => onRowBodyClick(row),
        editTooltip: 'Open value assignment in drawer',
      }
    }
    if (row.kind === 'unmapped-target') {
      return {
        onApprove: undefined,
        approveTooltip: 'Nothing to approve — no mapping',
        onReject:
          rejectDisabledReason === null
            ? () =>
                void mutations.rejectUnmappedRow({
                  pendingKey: row.id,
                  target: { targetFieldId: row.targetField.id },
                })
            : undefined,
        rejectTooltip: rejectDisabledReason ?? 'Mark as rejected',
        onEdit: () => {
          if (targetCellRef.current) {
            onTargetCellClick(row, targetCellRef.current)
          }
        },
        editTooltip: 'Pick a source field to map this target',
      }
    }
    // unmapped-source
    return {
      onApprove: undefined,
      approveTooltip: 'Nothing to approve — no mapping',
      onReject:
        rejectDisabledReason === null
          ? () =>
              void mutations.rejectUnmappedRow({
                pendingKey: row.id,
                target: { sourceFieldId: row.sourceField.id },
              })
          : undefined,
      rejectTooltip: rejectDisabledReason ?? 'Mark as rejected',
      onEdit: () => {
        if (targetCellRef.current) {
          onTargetCellClick(row, targetCellRef.current)
        }
      },
      editTooltip: 'Pick a target field to map this source',
    }
  }, [
    mutations,
    onRowBodyClick,
    onSourceCellClick,
    onTargetCellClick,
    row,
  ])

  // ── Render ────────────────────────────────────────────────────────
  return (
    <tr
      data-testid="flat-row"
      data-row-id={row.id}
      data-row-kind={row.kind}
      data-group-id={row.groupId}
      onClick={() => onRowBodyClick(row)}
      className={cn(
        'cursor-pointer border-b border-gray-100 transition-colors hover:bg-blue-50/40',
        isParent && 'bg-slate-50/40 font-medium',
        isChild && 'bg-white',
      )}
    >
      <td
        data-testid="flat-cell-source-table"
        className={cn('px-3 py-2 text-slate-700', isChild && 'pl-6')}
      >
        {sourceTable ?? <span className="text-slate-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-source-field"
        className="px-3 py-2 font-mono text-[11px] text-slate-700"
      >
        {sourceField ? (
          sourceCellEditable ? (
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
                'hover:bg-blue-100/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
              )}
            >
              {sourceField}
            </button>
          ) : (
            <span>{sourceField}</span>
          )
        ) : isParent ? (
          <span className="text-slate-400 italic">
            {row.sourceCount} sources
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-target-table"
        className="px-3 py-2 text-slate-700"
      >
        {targetTable ?? <span className="text-slate-300">—</span>}
      </td>
      <td
        data-testid="flat-cell-target-field"
        className="px-3 py-2 font-mono text-[11px] text-slate-700"
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
                'inline-flex w-full items-center justify-start rounded px-1 py-0.5 text-left',
                'hover:bg-blue-100/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
              )}
            >
              {targetField}
            </button>
          ) : (
            <span>{targetField}</span>
          )
        ) : row.kind === 'unmapped-source' && targetCellEditable ? (
          // Source-only row clickable to pick a target.
          <button
            ref={targetCellRef}
            type="button"
            data-testid="flat-cell-target-field-button"
            onClick={(e) => {
              e.stopPropagation()
              onTargetCellClick(row, e.currentTarget)
            }}
            className={cn(
              'inline-flex w-full items-center justify-start rounded px-1 py-0.5 text-left',
              'italic text-slate-400 hover:bg-blue-100/60 hover:text-slate-600',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
            )}
          >
            Pick a target…
          </button>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td
        data-testid="flat-cell-confidence"
        className="px-3 py-2 text-right tabular-nums text-slate-700"
      >
        {confidence === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          formatConfidencePercent(confidence)
        )}
      </td>
      <td
        data-testid="flat-cell-status"
        className="px-3 py-2"
      >
        <span className="inline-flex items-center gap-1.5">
          <FlatStatusDot status={row.status} />
          <span className="text-slate-700">{flatStatusLabel(row.status)}</span>
          {row.kind === 'unmapped-source' && row.acknowledgmentReason ? (
            <span
              className="text-[10px] italic text-slate-400"
              title={row.acknowledgmentReason}
            >
              · {row.acknowledgmentReason}
            </span>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2">
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
