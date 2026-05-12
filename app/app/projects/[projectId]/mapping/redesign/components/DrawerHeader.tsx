'use client'

import { useCallback, useRef, useState } from 'react'
import { cn } from '@/components/ui/utils'
import { ArrowRight, Pencil, X } from '@/components/icons'
import type {
  MappingRow,
  MappingSourceRef,
  SourceFieldWithState,
  TargetFieldRef,
} from '@/lib/types/mappings-for-redesign'
import { formatConfidencePercent } from '@/lib/utils/confidence-format'
import { TableBadge } from './TableBadge'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import { InlineSourcePicker } from './InlineSourcePicker'

// ─────────────────────────────────────────────────────────────────────────────
// DrawerHeader — PR 1 of drawer redesign (feat/drawer-header-rewrite).
// ─────────────────────────────────────────────────────────────────────────────
//
// Two-row identity header. Row 1 carries [src] → [tgt] identity; row 2
// carries [● status · confidence] right-aligned. Source and target
// field names are click-to-edit inline affordances (single-source
// mapped rows + every mapped/VA target) that open the existing
// portal-anchored pickers used by the flat view. Multi-source mapped
// rows show a non-editable dominant source + "+N" chip; VA rows show
// the literal "Value assignment" label; unmapped rows show
// "No source mapped" with the target rendered display-only.
//
// Per-variant render matrix:
//
//   mapped, sources.length === 1
//     [SRC] src_fld ✏  →  [TGT] tgt_fld ✏     ✕
//                                       ● Status · NN%
//
//   mapped, sources.length > 1
//     [SRC] dominant_fld  +N  →  [TGT] tgt_fld ✏     ✕
//                                       ● Status · NN%
//
//   value_assignment
//     Value assignment  →  [TGT] tgt_fld ✏     ✕
//                                       ● Status · —
//
//   unmapped (rare in drawer — list-view route doesn't open drawer for
//   unmapped-source rows; the only drawer-reachable unmapped variant
//   is unmapped-target, which has a target field but no TFM)
//     No source mapped  →  [TGT] tgt_fld     ✕
//                                       ● Status · —
//
// Edit affordances are gated by both (a) the parent threading
// `onSwapTarget` / `onSwapSource` props AND (b) variant rules above.
// Tests that mount `MappingDrawer` standalone (no parent commit
// handlers) get a static header — pencils don't render, no picker
// dependencies leak into test fixtures.
//
// Unmapped + target pencil: deliberately omitted in PR 1. Calling
// `updateMappingTargetField` on an unmapped row would fail UUID
// validation (no TFM uuid exists). PR 2 will route unmapped target
// clicks through `createFromUnmapped` once the body affordances land.
//
// Source pencil + multi-source: deliberately omitted per spec Q2.
// Editing a single source on a multi-source row is a per-card
// affordance (PR 2) — the header's dominant-source display would be
// misleading as an edit surface for one of N sources.
//
// Light-mode-only invariant: no `dark:` prefixes anywhere in this
// file. Enforced by tests/lib/no-shim-in-redesign-path.test.ts.

export interface DrawerHeaderProps {
  row: MappingRow
  /** Owner of the dialog's aria-labelledby relationship. */
  titleId: string
  /** Esc/X/click-outside close intercept handed in from `MappingDrawer`. */
  onClose: () => void
  /**
   * Commit handler for target-field swaps. Receives the bare TFM uuid
   * and the new target field id; returns success/failure so the picker
   * knows whether to close. Undefined when the drawer is mounted
   * standalone in tests — the pencil simply doesn't render.
   */
  onSwapTarget?: (
    tfmId: string,
    newTargetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Commit handler for single-source mapped row source swaps. Receives
   * the row id (TFM uuid; the action's `decodeShimmedRowId` resolves
   * the ordinal-0 mapping_sources row) and the new source field id.
   */
  onSwapSource?: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Universe of target fields for the target picker. Caller derives
   * once from `data.rows` (one entry per target field).
   */
  availableTargetFields?: readonly TargetFieldRef[]
  /** Universe of source fields for the source picker. */
  availableSourceFields?: readonly SourceFieldWithState[]
}

type DrawerStatus = MappingRow['status']

const STATUS_CONFIG: Record<
  DrawerStatus,
  {
    label: string
    dotClassName: string
    ringClassName: string
    wordClassName: string
  }
> = {
  approved: {
    label: 'Approved',
    dotClassName: 'bg-green-500',
    ringClassName: 'ring-green-500/25',
    wordClassName: 'text-green-700',
  },
  needs_review: {
    label: 'Needs review',
    dotClassName: 'bg-amber-400',
    ringClassName: 'ring-amber-400/25',
    wordClassName: 'text-amber-700',
  },
  rejected: {
    label: 'Rejected',
    dotClassName: 'bg-red-500',
    ringClassName: 'ring-red-500/25',
    wordClassName: 'text-red-700',
  },
  unmapped: {
    label: 'Unmapped',
    dotClassName: 'bg-slate-300',
    ringClassName: 'ring-slate-300/25',
    wordClassName: 'text-slate-500',
  },
}

export function DrawerHeader({
  row,
  titleId,
  onClose,
  onSwapTarget,
  onSwapSource,
  availableTargetFields,
  availableSourceFields,
}: DrawerHeaderProps) {
  const sourcePencilRef = useRef<HTMLButtonElement | null>(null)
  const targetPencilRef = useRef<HTMLButtonElement | null>(null)
  // Pickers are mutually exclusive — one state slot is enough.
  const [openPicker, setOpenPicker] = useState<'source' | 'target' | null>(null)

  const handleTargetCommit = useCallback(
    async (newTargetFieldId: string) => {
      if (!onSwapTarget) return { success: false }
      // The flat-view contributor-id shim (`<tfmId>::<sourceId>`) is not
      // emitted into the drawer's row ids (drawer row identity is the
      // bare TFM uuid for mapped/VA, `unmapped::<targetFieldId>` for
      // unmapped). Strip a contributor suffix defensively anyway.
      const tfmId = row.id.split('::')[0] ?? row.id
      return onSwapTarget(tfmId, newTargetFieldId)
    },
    [onSwapTarget, row.id],
  )

  const handleSourceCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      const newId = newSourceFieldIds[0]
      if (!newId || !onSwapSource) return { success: false }
      // Single-source mapped rows only — the action's ordinal-0 branch
      // resolves the lone mapping_sources row without a shim suffix.
      return onSwapSource(row.id, newId)
    },
    [onSwapSource, row.id],
  )

  const targetEditEnabled =
    typeof onSwapTarget === 'function' &&
    availableTargetFields !== undefined &&
    (row.kind === 'mapped' || row.kind === 'value_assignment')

  const sourceEditEnabled =
    typeof onSwapSource === 'function' &&
    availableSourceFields !== undefined &&
    row.kind === 'mapped' &&
    row.sources.length === 1

  const initialSourceFieldIds: string[] =
    row.kind === 'mapped' && row.sources.length === 1
      ? [row.sources[0]!.sourceField.id]
      : []

  return (
    <header
      data-testid="mapping-drawer-header"
      className="border-b border-slate-200 bg-white px-5 py-3"
    >
      <div
        data-testid="mapping-drawer-header-row"
        className="flex items-center gap-2"
      >
        <HeaderIdentitySide
          row={row}
          which="source"
          titleId={null}
          editEnabled={sourceEditEnabled}
          pencilRef={sourcePencilRef}
          onPencilClick={() => setOpenPicker('source')}
        />
        <ArrowRight
          aria-hidden="true"
          data-testid="mapping-drawer-header-arrow"
          className="h-3.5 w-3.5 flex-shrink-0 text-slate-400"
        />
        <HeaderIdentitySide
          row={row}
          which="target"
          titleId={titleId}
          editEnabled={targetEditEnabled}
          pencilRef={targetPencilRef}
          onPencilClick={() => setOpenPicker('target')}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drawer"
          data-testid="mapping-drawer-close"
          className={cn(
            'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md',
            'text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        data-testid="mapping-drawer-header-meta"
        className="mt-1.5 flex justify-end"
      >
        <HeaderStatusBadge row={row} />
      </div>

      {openPicker === 'target' && targetEditEnabled ? (
        <TargetFieldCellPicker
          anchorRef={targetPencilRef}
          initialTargetFieldId={
            row.kind === 'mapped' || row.kind === 'value_assignment'
              ? row.targetField.id
              : null
          }
          availableTargetFields={availableTargetFields ?? []}
          onCommit={handleTargetCommit}
          onClose={() => setOpenPicker(null)}
        />
      ) : null}

      {openPicker === 'source' && sourceEditEnabled ? (
        <InlineSourcePicker
          anchorRef={sourcePencilRef}
          initialSourceFieldIds={initialSourceFieldIds}
          availableSourceFields={[...(availableSourceFields ?? [])]}
          onCommit={handleSourceCommit}
          onClose={() => setOpenPicker(null)}
          mode="single"
          autoCommit
        />
      ) : null}
    </header>
  )
}

interface HeaderIdentitySideProps {
  row: MappingRow
  which: 'source' | 'target'
  /** Set on the target side so aria-labelledby resolves; null on source. */
  titleId: string | null
  editEnabled: boolean
  pencilRef: React.MutableRefObject<HTMLButtonElement | null>
  onPencilClick: () => void
}

function HeaderIdentitySide({
  row,
  which,
  titleId,
  editEnabled,
  pencilRef,
  onPencilClick,
}: HeaderIdentitySideProps) {
  if (which === 'target') {
    return (
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5"
        data-testid="mapping-drawer-header-target"
      >
        <TableBadge tableName={row.targetField.targetTable.name} size="sm" />
        <span
          id={titleId ?? undefined}
          data-testid="mapping-drawer-title"
          className="min-w-0 truncate font-mono text-base font-normal text-slate-900"
          title={row.targetField.name}
        >
          {row.targetField.name}
        </span>
        {editEnabled ? (
          <HeaderPencilButton
            label="Edit target field"
            testId="mapping-drawer-header-target-pencil"
            innerRef={pencilRef}
            onClick={onPencilClick}
          />
        ) : null}
      </div>
    )
  }
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1.5"
      data-testid="mapping-drawer-header-source"
    >
      <HeaderSourceContent
        row={row}
        editEnabled={editEnabled}
        pencilRef={pencilRef}
        onPencilClick={onPencilClick}
      />
    </div>
  )
}

function HeaderSourceContent({
  row,
  editEnabled,
  pencilRef,
  onPencilClick,
}: {
  row: MappingRow
  editEnabled: boolean
  pencilRef: React.MutableRefObject<HTMLButtonElement | null>
  onPencilClick: () => void
}) {
  if (row.kind === 'value_assignment') {
    return (
      <span
        data-testid="mapping-drawer-header-source-label"
        data-variant="value-assignment"
        className="truncate text-sm italic text-slate-500"
      >
        Value assignment
      </span>
    )
  }
  if (row.kind === 'unmapped') {
    return (
      <span
        data-testid="mapping-drawer-header-source-label"
        data-variant="unmapped"
        className="truncate text-sm italic text-slate-400"
      >
        No source mapped
      </span>
    )
  }
  const dominant: MappingSourceRef | undefined = row.sources[0]
  if (!dominant) {
    return (
      <span
        data-testid="mapping-drawer-header-source-label"
        data-variant="empty"
        className="truncate text-sm italic text-slate-400"
      >
        No source
      </span>
    )
  }
  const extraCount = row.sources.length - 1
  return (
    <>
      <TableBadge tableName={dominant.sourceTable.name} size="sm" />
      <span
        data-testid="mapping-drawer-header-source-field"
        className="min-w-0 truncate font-mono text-base font-normal text-slate-900"
        title={dominant.sourceField.name}
      >
        {dominant.sourceField.name}
      </span>
      {extraCount > 0 ? (
        <span
          data-testid="mapping-drawer-header-sources-chip"
          className="inline-flex flex-shrink-0 items-center rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600"
          title={`${row.sources.length} sources`}
        >
          +{extraCount}
        </span>
      ) : null}
      {editEnabled ? (
        <HeaderPencilButton
          label="Edit source field"
          testId="mapping-drawer-header-source-pencil"
          innerRef={pencilRef}
          onClick={onPencilClick}
        />
      ) : null}
    </>
  )
}

function HeaderPencilButton({
  label,
  testId,
  innerRef,
  onClick,
}: {
  label: string
  testId: string
  innerRef: React.MutableRefObject<HTMLButtonElement | null>
  onClick: () => void
}) {
  return (
    <button
      type="button"
      ref={(node) => {
        innerRef.current = node
      }}
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className={cn(
        'inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded',
        'text-slate-400 opacity-55 transition-opacity',
        'hover:bg-slate-100 hover:text-slate-700 hover:opacity-100',
        'focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-slate-300',
      )}
    >
      <Pencil aria-hidden="true" className="h-3 w-3" />
    </button>
  )
}

function HeaderStatusBadge({ row }: { row: MappingRow }) {
  const variant = row.status
  const cfg = STATUS_CONFIG[variant]
  const confidencePercent = formatConfidencePercent(row.confidence)
  return (
    <span
      data-testid="mapping-drawer-header-status-badge"
      className="inline-flex items-center gap-1.5 text-sm font-medium"
    >
      <span
        data-testid={`mapping-drawer-header-status-${variant}`}
        aria-label={cfg.label}
        title={cfg.label}
        className="inline-flex flex-shrink-0 items-center"
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-2 w-2 flex-shrink-0 rounded-full ring-2',
            cfg.dotClassName,
            cfg.ringClassName,
          )}
        />
      </span>
      <span
        className={cfg.wordClassName}
        data-testid="mapping-drawer-header-status-word"
      >
        {cfg.label}
      </span>
      <span aria-hidden="true" className="text-slate-400">
        ·
      </span>
      <span
        className="tabular-nums text-slate-600"
        data-testid="mapping-drawer-header-confidence"
      >
        {row.confidence !== null ? confidencePercent : '—'}
      </span>
    </span>
  )
}
