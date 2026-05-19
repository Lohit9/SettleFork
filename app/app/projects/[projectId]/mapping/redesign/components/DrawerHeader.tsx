'use client'

import { useCallback, useRef, useState } from 'react'
import { cn } from '@/components/ui/utils'
import { Pencil, Plus, X } from '@/components/icons'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  SourceFieldWithState,
  TargetFieldRef,
} from '@/lib/types/mappings-for-redesign'
import { formatConfidencePercent } from '@/lib/utils/confidence-format'
import { TableBadge } from './TableBadge'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'
import { InlineSourcePicker } from './InlineSourcePicker'
import { RejectConfirmPopover } from './RejectConfirmPopover'

// ─────────────────────────────────────────────────────────────────────────────
// DrawerHeader — PR 1 of drawer redesign (feat/drawer-header-rewrite).
// ─────────────────────────────────────────────────────────────────────────────
//
// Vertical FROM/TO stack header. Long field names get the full 440px
// drawer-content width on their own row — the prior horizontal
// `[src] → [tgt]` layout truncated aggressively at 480px on real
// fields (e.g. `Create_Multi_Revision_Product` 28 chars + a TableBadge
// + a pencil + an arrow + a target side).
//
//   ┌─────────────────────────────────────────────────┐
//   │ FROM                                         ✕  │   ← row 1: label + close
//   │ [src_tbl] src_field ✏  (or "+N more" multi)     │   ← row 2: source identity
//   │                                                 │
//   │ TO                                              │   ← row 3: label
//   │ [tgt_tbl] tgt_field ✏                           │   ← row 4: target identity
//   │                       ● Status · confidence     │   ← row 5: meta, right-aligned
//   └─────────────────────────────────────────────────┘
//
// Per-variant render matrix:
//
//   mapped, sources.length === 1
//     FROM  [SRC] src_fld ✏
//     TO    [TGT] tgt_fld ✏
//
//   mapped, sources.length > 1 — all N sources stacked vertically;
//   each row gets ✏ (per-source swap) + ✕ (per-source remove)
//     FROM  [SRC_A] field_a ✏ ✕
//           [SRC_B] field_b ✏ ✕
//           [SRC_C] field_c ✏ ✕
//     TO    [TGT] tgt_fld ✏
//
//   value_assignment
//     FROM  Value assignment        (italic, no pencil)
//     TO    [TGT] tgt_fld ✏
//
//   unmapped (rare in drawer — only target-side unmapped reaches here)
//     FROM  No source mapped        (italic, no pencil)
//     TO    [TGT] tgt_fld           (no pencil — PR 2 routes through
//                                    createFromUnmapped once the body
//                                    affordances land)
//
// Edit affordances are gated by both (a) the parent threading
// `onSwapTarget` / `onSwapSource` props AND (b) the variant rules
// above. Tests that mount `MappingDrawer` standalone (no parent
// commit handlers) get a static header — pencils don't render, no
// picker dependencies leak into test fixtures.
//
// Unmapped + target pencil: deliberately omitted in PR 1. Calling
// `updateMappingTargetField` on an unmapped row would fail UUID
// validation (no TFM uuid exists). PR 2 will route unmapped target
// clicks through `createFromUnmapped` once the body affordances land.
//
// Drawer redesign PR 2 — per-source ✏ / ✕ affordances on every
// source row in the multi-source case. The ✏ pencil opens the
// `InlineSourcePicker` anchored on the pencil button and dispatches
// `updateMappingSourceField` with a shimmed contributor row id
// (`<tfmId>::<mappingSourceId>` — `encodeContributorRowId`); the ✕
// remove opens a `RejectConfirmPopover` (copy: "Remove this source
// from the mapping?") and on confirm dispatches `editMappingSources`
// with the source filtered out. The ✕ is HIDDEN when
// `sources.length === 1` — removing the last source would leave the
// TFM empty and `editMappingSources` rejects empty source lists.
//
// Drawer redesign PR 2 TASK 2+3 — completes the editing surface:
//
//   • Source ✏ on every variant (not just mapped):
//     - VA → `editMappingSources({tfmId, [picked], 'single'})`,
//       converts VA to mapped (status flips to needs_review).
//     - Unmapped / rejected → `createMappingFromUnmapped(projectId,
//       picked, targetFieldId)`, creates a new TFM AND clears any
//       coverage rejection (auto-approves).
//   • Target row gets its own ✏ + ✕ slots (TargetRow component):
//     - Mapped / VA → ✏ swaps target via `updateMappingTargetField`;
//       ✕ unmaps via the shared `onUnmapMapping` handler.
//     - Unmapped / rejected → ✏ navigates the drawer to the picked
//       target field's row (client-only — there's no TFM to swap);
//       ✕ slot is invisible (no TFM to unmap) but reserved for
//       visual alignment with the source-side ✕ slot.
//   • ⊕ Add source button below the FROM stack on mapped variants
//     (single + multi). Adds a source via `editMappingSources`
//     with the new combination_type derived: single → multi promotes
//     to 'concat_space'; multi preserves the existing combination
//     strategy (narrowed off 'custom_sql' which the action rejects).
//
// Visual alignment: SourceRow + EmptySourceRow + TargetRow all use
// the same trailing-icon-slot layout (a fixed-width flex container
// holding both pencil and remove slots). Slots not in use (e.g. VA
// source ✕, unmapped target ✕) render an `invisible` placeholder
// so the icon column stays vertically aligned across rows.
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
   * Commit handler for mapped-row source swaps. Receives the row id
   * (TFM uuid for single-source ordinal-0 branch; shimmed
   * `<tfmId>::<mappingSourceId>` contributor id for multi-source
   * per-source edits) and the new source field id. The action's
   * `decodeShimmedRowId` resolves both shapes.
   */
  onSwapSource?: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 — commit handler for source-set changes on
   * an existing TFM. Used by the per-source ✕ remove (and by TASK 2
   * ⊕ Add source / TASK 3 VA conversion). Parent wraps
   * `mutations.editMappingSources`. The combinationType is derived
   * UI-side: removing one of N sources → if remaining count is 1
   * pass `'single'`, else pass the row's existing combinationType
   * narrowed to 'concat_space'/'concat_comma' (never 'custom_sql' —
   * the action rejects that incoming value).
   */
  onEditSources?: (args: {
    tfmId: string
    sourceFieldIds: string[]
    combinationType: 'single' | 'concat_space' | 'concat_comma'
  }) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 TASK 1.6 — handler for the single-source ✕
   * "Remove mapping" flow. Distinct from `onEditSources` because
   * removing the LAST source can't go through `editMappingSources`
   * (which rejects empty source lists). The parent deletes the TFM
   * via `rejectFieldMapping` AND keeps the drawer open by
   * transitioning the URL drawerRowId to
   * `unmapped::<targetFieldId>` — see `MappingContent` for the
   * sentinel + override plumbing.
   */
  onUnmapMapping?: (
    tfmId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 TASK 2+3 — source ✏ handler for the
   * empty-source variants (unmapped, rejected). Creates a new TFM
   * via `createMappingFromUnmapped`; the same wrapper handles the
   * rejected → mapped path (server clears coverage rejection
   * AND auto-approves).
   */
  onCreateMapping?: (
    sourceFieldId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 TASK 2+3 — target ✏ handler for the
   * empty-target variants (unmapped, rejected). Client-only:
   * navigates the drawer to the picked target field's row id. The
   * parent looks up the row in `data.rows` and updates the
   * `drawerRowId` URL state.
   */
  onNavigateTarget?: (
    newTargetFieldId: string,
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
    dotClassName: 'bg-slate-400',
    ringClassName: 'ring-slate-400/25',
    wordClassName: 'text-slate-700',
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

// FROM/TO label typography: matches the existing small-caps section
// heading style used by `DrawerSection` in the body
// (`text-xs font-medium uppercase tracking-wide text-slate-500`).
// Keeps the drawer's two label types — header FROM/TO and body
// section titles — visually unified.
const STACK_LABEL_CLASSNAME =
  'text-[11px] font-medium uppercase tracking-wide text-slate-500'

export function DrawerHeader({
  row,
  titleId,
  onClose,
  onSwapTarget,
  onSwapSource,
  onEditSources,
  onUnmapMapping,
  onCreateMapping,
  onNavigateTarget,
  availableTargetFields,
  availableSourceFields,
}: DrawerHeaderProps) {
  return (
    <header
      data-testid="mapping-drawer-header"
      className="border-b border-slate-200 bg-white px-5 py-3"
    >
      {/*
        Row 1 — FROM label + close button. The `mapping-drawer-header-row`
        testid is preserved from the prior horizontal layout so existing
        tests resolving the close-cluster anchor keep working; its
        contents collapsed from `[source, arrow, target, close]` to
        just `[FROM-label, close]`.
      */}
      <div
        data-testid="mapping-drawer-header-row"
        className="flex items-center justify-between"
      >
        <span
          data-testid="mapping-drawer-header-from-label"
          className={STACK_LABEL_CLASSNAME}
        >
          FROM
        </span>
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

      {/*
        Source identity block — full row width, no truncation pressure.
        Wrapper is `flex-col` so multi-source rows stack vertically with
        a tight 4px gap (`gap-1`). VA / unmapped / single-source render
        a single child; multi-source renders N children + an ⊕ Add
        source button.
      */}
      <div
        data-testid="mapping-drawer-header-source"
        className="mt-1 flex min-w-0 flex-col gap-1"
      >
        <HeaderSourceContent
          row={row}
          availableSourceFields={availableSourceFields}
          onSwapSource={onSwapSource}
          onEditSources={onEditSources}
          onUnmapMapping={onUnmapMapping}
          onCreateMapping={onCreateMapping}
        />
      </div>

      {/*
        TO label — 12px above the target identity (the FROM/TO vertical
        gap). `mt-3` matches Tailwind's 12px spacing token, which is
        the upper bound from the spec's "8–12px vertical gap between
        FROM block and TO block".
      */}
      <div
        data-testid="mapping-drawer-header-to-label"
        className={cn('mt-3', STACK_LABEL_CLASSNAME)}
      >
        TO
      </div>

      <TargetRow
        row={row}
        titleId={titleId}
        availableTargetFields={availableTargetFields}
        onSwapTarget={onSwapTarget}
        onNavigateTarget={onNavigateTarget}
        onUnmapMapping={onUnmapMapping}
      />

      {/* Status + confidence meta row — own line, right-aligned. */}
      <div
        data-testid="mapping-drawer-header-meta"
        className="mt-2 flex justify-end"
      >
        <HeaderStatusBadge row={row} />
      </div>
    </header>
  )
}

function HeaderSourceContent({
  row,
  availableSourceFields,
  onSwapSource,
  onEditSources,
  onUnmapMapping,
  onCreateMapping,
}: {
  row: MappingRow
  availableSourceFields: readonly SourceFieldWithState[] | undefined
  onSwapSource:
    | ((rowId: string, newSourceFieldId: string) => Promise<{ success: boolean }>)
    | undefined
  onEditSources:
    | ((args: {
        tfmId: string
        sourceFieldIds: string[]
        combinationType: 'single' | 'concat_space' | 'concat_comma'
      }) => Promise<{ success: boolean }>)
    | undefined
  onUnmapMapping:
    | ((tfmId: string, targetFieldId: string) => Promise<{ success: boolean }>)
    | undefined
  onCreateMapping:
    | ((
        sourceFieldId: string,
        targetFieldId: string,
      ) => Promise<{ success: boolean }>)
    | undefined
}) {
  if (row.kind === 'value_assignment') {
    // PR 2 TASK 2+3 — VA's source ✏ converts the VA into a mapped
    // row via `editMappingSources` with combinationType='single'.
    // Per STOP 1, the server action does NOT guard against existing
    // `combination_type='custom_sql'` — only the incoming value.
    return (
      <EmptySourceRow
        variant="value-assignment"
        targetFieldId={row.targetField.id}
        availableSourceFields={availableSourceFields}
        onPick={async (sourceFieldId: string) => {
          if (!onEditSources) return { success: false }
          return onEditSources({
            tfmId: row.id,
            sourceFieldIds: [sourceFieldId],
            combinationType: 'single',
          })
        }}
        pickEnabled={
          typeof onEditSources === 'function' &&
          availableSourceFields !== undefined
        }
      />
    )
  }
  if (row.kind === 'unmapped') {
    // PR 2 TASK 2+3 — unmapped / rejected source ✏ creates a new
    // TFM via `createMappingFromUnmapped`. The same server action
    // handles BOTH unmapped (no TFM) AND rejected (TFM previously
    // deleted, coverage status='rejected') paths — the server clears
    // coverage rejection AND auto-approves the new TFM.
    return (
      <EmptySourceRow
        variant="unmapped"
        targetFieldId={row.targetField.id}
        availableSourceFields={availableSourceFields}
        onPick={async (sourceFieldId: string) => {
          if (!onCreateMapping) return { success: false }
          return onCreateMapping(sourceFieldId, row.targetField.id)
        }}
        pickEnabled={
          typeof onCreateMapping === 'function' &&
          availableSourceFields !== undefined
        }
      />
    )
  }
  if (row.sources.length === 0) {
    // Defensive: a mapped row with zero sources is semantically
    // invalid per the read translator (it would surface as unmapped),
    // but we render a degraded label in case a malformed row slips
    // through.
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
  // Mapped row: render one SourceRow per contributor + an ⊕ Add
  // source button. SourceRow owns its own ✏ + ✕ state + refs.
  // Single-source rows also flow through SourceRow so the
  // single-source ✕ "Remove mapping" path (TASK 1.6) lives next to
  // the multi-source ✕ "Remove this source" path — copy + handler
  // differ but the picker/popover plumbing is shared. Server
  // ordinal-asc ordering is preserved — DO NOT re-sort client-side.
  return (
    <>
      {row.sources.map((s) => (
        <SourceRow
          key={s.id}
          row={row}
          source={s}
          availableSourceFields={availableSourceFields}
          onSwapSource={onSwapSource}
          onEditSources={onEditSources}
          onUnmapMapping={onUnmapMapping}
        />
      ))}
      <AddSourceButton
        row={row}
        availableSourceFields={availableSourceFields}
        onEditSources={onEditSources}
      />
    </>
  )
}

/**
 * Per-source row in the FROM stack. Used for both single-source and
 * multi-source mapped rows so the ✏ + ✕ affordance plumbing lives in
 * one place. Owns its own pencil + remove state + refs.
 *
 * Affordance gating:
 *   • ✏ pencil — renders when `onSwapSource` AND
 *     `availableSourceFields` are threaded. Single-source uses bare
 *     TFM uuid (ordinal-0 branch); multi-source uses
 *     `<tfmId>::<mappingSourceId>` contributor encoding.
 *   • ✕ remove — splits by remaining count:
 *     - Multi-source (sources.length > 1): renders when
 *       `onEditSources` is threaded. Copy: "Remove this source from
 *       the mapping?" / "Remove". Confirm fires `onEditSources` with
 *       the source filtered out (server flips status to
 *       needs_review).
 *     - Single-source (sources.length === 1): renders when
 *       `onUnmapMapping` is threaded. Copy: "Remove this
 *       mapping? The target field will be unmapped." / "Remove
 *       mapping". Confirm fires `onUnmapMapping(tfmId,
 *       targetFieldId)` — parent deletes the TFM via
 *       `rejectFieldMapping` AND keeps the drawer open at the new
 *       `unmapped::<targetFieldId>` row identity (sentinel +
 *       optimistic override).
 */
function SourceRow({
  row,
  source,
  availableSourceFields,
  onSwapSource,
  onEditSources,
  onUnmapMapping,
}: {
  row: MappedRow
  source: MappingSourceRef
  availableSourceFields: readonly SourceFieldWithState[] | undefined
  onSwapSource:
    | ((rowId: string, newSourceFieldId: string) => Promise<{ success: boolean }>)
    | undefined
  onEditSources:
    | ((args: {
        tfmId: string
        sourceFieldIds: string[]
        combinationType: 'single' | 'concat_space' | 'concat_comma'
      }) => Promise<{ success: boolean }>)
    | undefined
  onUnmapMapping:
    | ((tfmId: string, targetFieldId: string) => Promise<{ success: boolean }>)
    | undefined
}) {
  const pencilRef = useRef<HTMLButtonElement | null>(null)
  const removeRef = useRef<HTMLButtonElement | null>(null)
  const [openAffordance, setOpenAffordance] = useState<
    'edit' | 'remove' | null
  >(null)

  const isSingleSource = row.sources.length === 1
  const editEnabled =
    typeof onSwapSource === 'function' && availableSourceFields !== undefined
  // Multi-source ✕ uses `onEditSources`; single-source ✕ uses
  // `onUnmapMapping`. We gate the affordance render on whichever
  // handler is appropriate so a parent that only threads one of them
  // still gets a functional surface.
  const removeEnabled = isSingleSource
    ? typeof onUnmapMapping === 'function'
    : typeof onEditSources === 'function'

  const handleEditCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      const newId = newSourceFieldIds[0]
      if (!newId || !onSwapSource) return { success: false }
      // Single-source: bare TFM uuid hits the action's ordinal-0
      // branch. Multi-source: shimmed contributor id targets the
      // specific `mapping_sources` row. Format mirrors
      // `lib/compat/mapping-shim.ts:encodeContributorRowId` —
      // duplicated here (one line) rather than imported because the
      // redesign-path guard at
      // `tests/lib/no-shim-in-redesign-path.test.ts` forbids
      // importing from `@/lib/compat/mapping-shim`. The server-side
      // `decodeShimmedRowId` reads the same `::` separator.
      const editRowId = isSingleSource ? row.id : `${row.id}::${source.id}`
      return onSwapSource(editRowId, newId)
    },
    [isSingleSource, onSwapSource, row.id, source.id],
  )

  const handleRemoveConfirm = useCallback(() => {
    if (isSingleSource) {
      if (!onUnmapMapping) {
        setOpenAffordance(null)
        return
      }
      setOpenAffordance(null)
      void onUnmapMapping(row.id, row.targetField.id)
      return
    }
    // Multi-source: filter out the removed source + call editMappingSources.
    if (!onEditSources) {
      setOpenAffordance(null)
      return
    }
    const remaining = row.sources.filter((s) => s.id !== source.id)
    const remainingIds = remaining.map((s) => s.sourceField.id)
    // Collapse to 'single' when the remove leaves exactly one source;
    // otherwise preserve the row's existing combination strategy.
    // `MappedRow.combinationType` is 'single' | 'concat_space' |
    // 'concat_comma' | 'custom_sql' — narrow off 'custom_sql' (the
    // action rejects it; mapped rows with custom_sql are an edge
    // case that already lives only on the Transform page).
    const nextCombinationType: 'single' | 'concat_space' | 'concat_comma' =
      remainingIds.length === 1
        ? 'single'
        : row.combinationType === 'custom_sql'
          ? 'concat_space'
          : row.combinationType
    setOpenAffordance(null)
    void onEditSources({
      tfmId: row.id,
      sourceFieldIds: remainingIds,
      combinationType: nextCombinationType,
    })
  }, [
    isSingleSource,
    onEditSources,
    onUnmapMapping,
    row.combinationType,
    row.id,
    row.sources,
    row.targetField.id,
    source.id,
  ])

  // Popover copy splits by remaining count (see SourceRow doc above).
  const removeTitle = isSingleSource
    ? 'Remove this mapping? The target field will be unmapped.'
    : 'Remove this source from the mapping?'
  const removeConfirmLabel = isSingleSource ? 'Remove mapping' : 'Remove'

  return (
    <div
      data-testid="mapping-drawer-header-source-row"
      data-ordinal={source.ordinal}
      data-mapping-source-id={source.id}
      className="flex min-w-0 items-center gap-1.5"
    >
      <TableBadge tableName={source.sourceTable.name} size="sm" />
      <span
        data-testid="mapping-drawer-header-source-field"
        className="min-w-0 flex-1 truncate font-mono text-base font-normal text-slate-900"
        title={source.sourceField.name}
      >
        {source.sourceField.name}
      </span>
      <RowIconSlots
        pencil={
          editEnabled ? (
            <HeaderPencilButton
              label={`Edit source field ${source.sourceField.name}`}
              testId="mapping-drawer-header-source-pencil"
              innerRef={pencilRef}
              onClick={() => setOpenAffordance('edit')}
            />
          ) : null
        }
        remove={
          removeEnabled ? (
            <HeaderRemoveButton
              testId="mapping-drawer-header-source-remove"
              label={
                isSingleSource
                  ? 'Remove mapping'
                  : `Remove source ${source.sourceField.name}`
              }
              innerRef={removeRef}
              onClick={() => setOpenAffordance('remove')}
            />
          ) : null
        }
      />

      {openAffordance === 'edit' && editEnabled ? (
        <InlineSourcePicker
          anchorRef={pencilRef}
          initialSourceFieldIds={[source.sourceField.id]}
          availableSourceFields={[...(availableSourceFields ?? [])]}
          onCommit={handleEditCommit}
          onClose={() => setOpenAffordance(null)}
          mode="single"
          autoCommit
        />
      ) : null}

      {openAffordance === 'remove' && removeEnabled ? (
        <RejectConfirmPopover
          anchorRef={removeRef}
          title={removeTitle}
          confirmLabel={removeConfirmLabel}
          onConfirm={handleRemoveConfirm}
          onCancel={() => setOpenAffordance(null)}
        />
      ) : null}
    </div>
  )
}

function HeaderRemoveButton({
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
        'hover:bg-red-50 hover:text-red-600 hover:opacity-100',
        'focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-300',
      )}
    >
      <X aria-hidden="true" className="h-3 w-3" />
    </button>
  )
}

/**
 * Drawer redesign PR 2 TASK 2+3 — shared trailing-icon-slot layout.
 *
 * SourceRow + EmptySourceRow + TargetRow all delegate their trailing
 * `[✏][✕]` cluster to this primitive so the icon column stays
 * vertically aligned across rows. A slot whose icon is `null`
 * renders an `invisible` 5-square placeholder that preserves the
 * column width — the FROM and TO rows otherwise drift horizontally
 * when one variant has fewer affordances than another (e.g. VA's
 * source row hides the ✕ but the target row shows it).
 *
 * Total slot width: 2 × 20px + 4px gap = 44px. Matches the
 * `HeaderPencilButton` / `HeaderRemoveButton` `h-5 w-5` boxes.
 */
function RowIconSlots({
  pencil,
  remove,
}: {
  pencil: React.ReactNode
  remove: React.ReactNode
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1">
      <div className="flex h-5 w-5 items-center justify-center">
        {pencil ?? <span aria-hidden="true" className="invisible h-5 w-5" />}
      </div>
      <div className="flex h-5 w-5 items-center justify-center">
        {remove ?? <span aria-hidden="true" className="invisible h-5 w-5" />}
      </div>
    </div>
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

/**
 * PR 2 TASK 2+3 — source-side row for VA / unmapped / rejected
 * variants. Renders an italic label in the field-name slot (no
 * TableBadge, no real source identity yet) + a ✏ pencil that opens
 * the `InlineSourcePicker` with NO initial selection. On commit the
 * parent-supplied `onPick(sourceFieldId)` handler does the
 * variant-specific work (`editMappingSources` for VA;
 * `createMappingFromUnmapped` for unmapped/rejected).
 *
 * ✕ slot is invisible (no TFM-to-source link to remove yet) but
 * reserved for column alignment with SourceRow + TargetRow.
 */
function EmptySourceRow({
  variant,
  targetFieldId,
  availableSourceFields,
  onPick,
  pickEnabled,
}: {
  variant: 'value-assignment' | 'unmapped'
  /** Threaded through for future scope-narrowing in the picker. */
  targetFieldId: string
  availableSourceFields: readonly SourceFieldWithState[] | undefined
  onPick: (sourceFieldId: string) => Promise<{ success: boolean }>
  pickEnabled: boolean
}) {
  const pencilRef = useRef<HTMLButtonElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const label =
    variant === 'value-assignment' ? 'Value assignment' : 'No source mapped'
  const labelTone =
    variant === 'value-assignment' ? 'text-slate-500' : 'text-slate-400'
  const pencilLabel =
    variant === 'value-assignment'
      ? 'Map a source field (converts value assignment to mapped)'
      : 'Pick a source field'

  const handleCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      const newId = newSourceFieldIds[0]
      if (!newId) return { success: false }
      return onPick(newId)
    },
    [onPick],
  )

  return (
    <div
      data-testid="mapping-drawer-header-source-row"
      data-variant={variant}
      data-target-field-id={targetFieldId}
      className="flex min-w-0 items-center gap-1.5"
    >
      <span
        data-testid="mapping-drawer-header-source-label"
        data-variant={variant}
        className={cn('min-w-0 flex-1 truncate text-sm italic', labelTone)}
      >
        {label}
      </span>
      <RowIconSlots
        pencil={
          pickEnabled ? (
            <HeaderPencilButton
              label={pencilLabel}
              testId="mapping-drawer-header-source-pencil"
              innerRef={pencilRef}
              onClick={() => setPickerOpen(true)}
            />
          ) : null
        }
        remove={null}
      />

      {pickerOpen && pickEnabled ? (
        <InlineSourcePicker
          anchorRef={pencilRef}
          initialSourceFieldIds={[]}
          availableSourceFields={[...(availableSourceFields ?? [])]}
          onCommit={handleCommit}
          onClose={() => setPickerOpen(false)}
          mode="single"
          autoCommit
        />
      ) : null}
    </div>
  )
}

/**
 * PR 2 TASK 2+3 — target-side row (target TableBadge + field name +
 * ✏ pencil + ✕ remove). Used by every variant. Affordance gating:
 *
 *   • ✏ pencil — visible across all variants:
 *     - Mapped / VA → swap target via `updateMappingTargetField`.
 *     - Unmapped / rejected → navigate drawer to picked target's row
 *       (no server action).
 *   • ✕ remove — visible only on mapped / VA. Calls the shared
 *     `onUnmapMapping` handler (same flow as the single-source ✕).
 *     Unmapped / rejected have no TFM to delete; the ✕ slot renders
 *     as an invisible placeholder to preserve the column alignment
 *     with source-side rows.
 */
function TargetRow({
  row,
  titleId,
  availableTargetFields,
  onSwapTarget,
  onNavigateTarget,
  onUnmapMapping,
}: {
  row: MappingRow
  titleId: string
  availableTargetFields: readonly TargetFieldRef[] | undefined
  onSwapTarget:
    | ((tfmId: string, newTargetFieldId: string) => Promise<{ success: boolean }>)
    | undefined
  onNavigateTarget:
    | ((newTargetFieldId: string) => Promise<{ success: boolean }>)
    | undefined
  onUnmapMapping:
    | ((tfmId: string, targetFieldId: string) => Promise<{ success: boolean }>)
    | undefined
}) {
  const pencilRef = useRef<HTMLButtonElement | null>(null)
  const removeRef = useRef<HTMLButtonElement | null>(null)
  const [openAffordance, setOpenAffordance] = useState<
    'edit' | 'remove' | null
  >(null)

  const hasTfm = row.kind === 'mapped' || row.kind === 'value_assignment'
  const editEnabled = availableTargetFields !== undefined && (
    hasTfm
      ? typeof onSwapTarget === 'function'
      : typeof onNavigateTarget === 'function'
  )
  const removeEnabled = hasTfm && typeof onUnmapMapping === 'function'

  const handleEditCommit = useCallback(
    async (newTargetFieldId: string) => {
      if (hasTfm) {
        if (!onSwapTarget) return { success: false }
        // Strip a contributor suffix defensively (drawer rowIds for
        // mapped/VA are bare TFM uuids).
        const tfmId = row.id.split('::')[0] ?? row.id
        return onSwapTarget(tfmId, newTargetFieldId)
      }
      if (!onNavigateTarget) return { success: false }
      return onNavigateTarget(newTargetFieldId)
    },
    [hasTfm, onNavigateTarget, onSwapTarget, row.id],
  )

  const handleRemoveConfirm = useCallback(() => {
    setOpenAffordance(null)
    if (!hasTfm || !onUnmapMapping) return
    void onUnmapMapping(row.id, row.targetField.id)
  }, [hasTfm, onUnmapMapping, row.id, row.targetField.id])

  return (
    <div
      data-testid="mapping-drawer-header-target"
      className="mt-1 flex min-w-0 items-center gap-1.5"
    >
      <TableBadge tableName={row.targetField.targetTable.name} size="sm" />
      <span
        id={titleId}
        data-testid="mapping-drawer-title"
        className="min-w-0 flex-1 truncate font-mono text-base font-normal text-slate-900"
        title={row.targetField.name}
      >
        {row.targetField.name}
      </span>
      <RowIconSlots
        pencil={
          editEnabled ? (
            <HeaderPencilButton
              label={hasTfm ? 'Edit target field' : 'Pick a target field'}
              testId="mapping-drawer-header-target-pencil"
              innerRef={pencilRef}
              onClick={() => setOpenAffordance('edit')}
            />
          ) : null
        }
        remove={
          removeEnabled ? (
            <HeaderRemoveButton
              testId="mapping-drawer-header-target-remove"
              label="Remove mapping"
              innerRef={removeRef}
              onClick={() => setOpenAffordance('remove')}
            />
          ) : null
        }
      />

      {openAffordance === 'edit' && editEnabled ? (
        <TargetFieldCellPicker
          anchorRef={pencilRef}
          initialTargetFieldId={hasTfm ? row.targetField.id : null}
          availableTargetFields={availableTargetFields ?? []}
          onCommit={handleEditCommit}
          onClose={() => setOpenAffordance(null)}
        />
      ) : null}

      {openAffordance === 'remove' && removeEnabled ? (
        <RejectConfirmPopover
          anchorRef={removeRef}
          title="Remove this mapping? The target field will be unmapped."
          confirmLabel="Remove mapping"
          onConfirm={handleRemoveConfirm}
          onCancel={() => setOpenAffordance(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * PR 2 TASK 2+3 — ⊕ Add source button rendered below the FROM
 * stack on mapped variants (single + multi). Hidden for VA /
 * unmapped / rejected (those use the source ✏ on the empty row).
 *
 * Combination-type derivation:
 *   • Promoting single → multi: pass `'concat_space'` (sensible
 *     default per spec Q4 of the PR 1 investigation).
 *   • Adding to an existing multi: preserve the row's existing
 *     `combinationType`, narrowed off `'custom_sql'` (the action
 *     rejects that incoming value; mapped rows with custom_sql are
 *     a Transform-page edge case).
 */
function AddSourceButton({
  row,
  availableSourceFields,
  onEditSources,
}: {
  row: MappedRow
  availableSourceFields: readonly SourceFieldWithState[] | undefined
  onEditSources:
    | ((args: {
        tfmId: string
        sourceFieldIds: string[]
        combinationType: 'single' | 'concat_space' | 'concat_comma'
      }) => Promise<{ success: boolean }>)
    | undefined
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const enabled =
    typeof onEditSources === 'function' && availableSourceFields !== undefined
  if (!enabled) return null

  const handleCommit = async (newSourceFieldIds: string[]) => {
    const newId = newSourceFieldIds[0]
    if (!newId || !onEditSources) return { success: false }
    if (row.sources.some((s) => s.sourceField.id === newId)) {
      // The server-side action would reject a duplicate; bail
      // silently so the picker closes without firing.
      return { success: false }
    }
    const nextSourceFieldIds = [
      ...row.sources.map((s) => s.sourceField.id),
      newId,
    ]
    const wasSingle = row.sources.length === 1
    const nextCombinationType: 'single' | 'concat_space' | 'concat_comma' =
      wasSingle
        ? 'concat_space'
        : row.combinationType === 'custom_sql'
          ? 'concat_space'
          : row.combinationType
    return onEditSources({
      tfmId: row.id,
      sourceFieldIds: nextSourceFieldIds,
      combinationType: nextCombinationType,
    })
  }

  return (
    <>
      <button
        type="button"
        ref={(node) => {
          anchorRef.current = node
        }}
        onClick={() => setPickerOpen(true)}
        aria-label="Add source"
        data-testid="mapping-drawer-header-add-source"
        className={cn(
          'mt-0.5 inline-flex h-6 items-center gap-1 self-start rounded px-1.5',
          'text-[11px] font-medium text-slate-500 transition-colors',
          'hover:bg-slate-100 hover:text-slate-700',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        )}
      >
        <Plus aria-hidden="true" className="h-3 w-3" />
        <span>Add source</span>
      </button>
      {pickerOpen ? (
        <InlineSourcePicker
          anchorRef={anchorRef}
          initialSourceFieldIds={[]}
          availableSourceFields={[...(availableSourceFields ?? [])]}
          onCommit={handleCommit}
          onClose={() => setPickerOpen(false)}
          mode="single"
          autoCommit
        />
      ) : null}
    </>
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
