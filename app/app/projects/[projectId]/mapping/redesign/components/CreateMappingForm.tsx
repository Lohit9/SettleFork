'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2/4a-3 — W1 manual mapping creation form.
// ─────────────────────────────────────────────────────────────────────────────
//
// In-drawer inline form that lets a user create a `target_field_mapping`
// for a Rule 6 unmapped target field (founder decision 1: in-drawer
// inline, no modal). Composed of:
//
//   1. SourceFieldPicker         — chip strip + search + grouped list
//   2. JoinDisambiguation        — cross-table FK picker (4a-3)
//   3. CombinationStrategyRadios — visible only when 2+ sources picked
//   4. SamplePreview             — real-time client-side preview
//
// The drawer parent renders the visible [Cancel] [Save] buttons in the
// drawer footer; the form exposes its imperative save trigger via a
// `forwardRef` handle so the parent can fire it without owning the
// form's internal state shape.
//
// SAVE FLOW
//
//   `useTransition` wraps the call to `createFieldMapping`. On success
//   we yield `tfmId` to the parent via `onSaveSuccess` so it can flip
//   the drawer URL param and trigger `router.refresh()`. On failure we
//   surface a curated error string above the picker; the form stays
//   mounted so the user can correct + retry.
//
// EXISTING_TFM AFFORDANCE
//
//   Per founder decision §3-OQ-1, the wrapper's existing-TFM collision
//   error renders an inline [Refresh] button. Clicking it triggers a
//   `router.refresh()` and dismisses the form via `onCancel` so the
//   user lands on the freshly-rendered server state.
//
// CROSS-TABLE DISAMBIGUATION (Phase 4a-3)
//
//   When the user picks sources from 2+ source tables, the wrapper
//   performs an FK precheck. Three branches:
//     • zero FK candidates → CROSS_TABLE_AMBIGUOUS with empty
//       `candidateFkFields`. The form renders a banner row pointing at
//       schema admin / legacy mapping page. No re-save until the
//       offending chip is removed.
//     • single FK candidate → wrapper succeeds silently, form moves on.
//     • 2+ FK candidates → CROSS_TABLE_AMBIGUOUS with the candidate
//       list. The form renders a native <select> dropdown asking the
//       user to disambiguate. After a pick the user can resave.
//
//   Resolved picks render as read-only summary rows with a [Change]
//   link that flips them back to active dropdowns (§4-OQ-2).
//
//   `ambiguousCandidates` accumulates server feedback across resaves;
//   `joinAnnotations` is the user's per-joined-table pick. Both clean
//   up silently when the corresponding chip is removed (§4-OQ-3).

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/components/ui/utils'
import {
  createFieldMapping,
  type CreateFieldMappingErrorCode,
  type CreateFieldMappingCombinationType,
} from '@/lib/actions/mappings-for-redesign'
import {
  computeSamplePreview,
  type SamplePreviewCombinationType,
} from '@/lib/utils/mapping-preview'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { SourceFieldPicker } from './SourceFieldPicker'

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Phase 4a-4a — minimal serializable snapshot of the form's USER-INPUT
 * fields. Used by:
 *
 *   • The drawer's `onFormDirtyChange` lift — published whenever the
 *     form is dirty so `MappingContent` can offer Undo on row-switch.
 *   • The drawer's `restoreFormState` re-hydrate path — the `Undo`
 *     toast action passes a previously-captured snapshot back down so
 *     the form re-mounts with the user's prior selections.
 *
 * Scope (founder decision §11-OQ-1): fields ONLY. Errors, dialog state,
 * and ephemeral disambiguation cleanup are deliberately excluded — they
 * are recovery surfaces, not draft content. `targetFieldId` is included
 * so a stale snapshot for a different row can be detected and ignored
 * cheaply.
 */
export interface CreateMappingFormSnapshot {
  targetFieldId: string
  selectedIds: string[]
  combinationType: CreateFieldMappingCombinationType
  joinAnnotations: Record<string, string>
}

/**
 * Imperative handle exposed by `CreateMappingForm` to its parent
 * (`MappingDrawer`). The parent owns the visible footer buttons; the
 * handle lets it dispatch into the form without lifting the form's
 * internal state shape.
 */
export interface CreateMappingFormHandle {
  /**
   * Trigger the save flow as if the user clicked the (parent-rendered)
   * Save button. No-op when already saving or when nothing is selected.
   */
  triggerSave: () => void
  /**
   * Tell the form the user wants to close (Esc / X / click-outside /
   * Cancel). When dirty the form opens its own discard dialog and
   * resolves to `onCancel()` only after the user confirms. When clean
   * the form invokes `onCancel()` immediately.
   */
  requestClose: () => void
}

export interface CreateMappingFormProps {
  projectId: string
  /**
   * The Rule 6 unmapped target field this form will create a TFM for.
   * Only `id` is required for the wrapper call; `name` is rendered in
   * the discard-dialog body for context.
   */
  targetField: { id: string; name: string }
  /**
   * Page-level source fields in canonical server order. Picker filters
   * and same-table-constrains in-line.
   */
  availableSourceFields: SourceFieldWithState[]
  /**
   * Called with the new TFM id once `createFieldMapping` succeeds.
   * Parent is expected to update the drawer URL param and call
   * `router.refresh()` so the row morphs from Rule 6 to Rule 1/2.
   */
  onSaveSuccess: (newTfmId: string) => void
  /**
   * Called when the user cancels (clean form OR after confirming
   * discard). Parent typically clears `isFormActive` so the drawer
   * body returns to the Rule 6 empty state.
   */
  onCancel: () => void
  /**
   * Notifies the parent (drawer) whenever the dirty flag flips so the
   * drawer's close-with-confirm intercept and the footer's Save-button
   * disabled state can read a single source of truth.
   *
   * Phase 4a-4a: also carries `snapshot` — the dirty-time snapshot of
   * user-input fields, or `null` when the form is clean. The drawer
   * lifts this further to `MappingContent` so a row-switch-while-dirty
   * can offer an Undo affordance.
   */
  onStateChange?: (state: {
    isDirty: boolean
    canSave: boolean
    isSavePending: boolean
    snapshot: CreateMappingFormSnapshot | null
  }) => void
  /**
   * Phase 4a-4a — when a user undoes a row-switch-discard, the toast
   * action passes a previously-captured snapshot back down here. The
   * form applies the snapshot on mount, then immediately invokes
   * `onRestoreConsumed` so the parent can clear the prop and avoid
   * re-applying on subsequent renders. Stale snapshots whose
   * `targetFieldId` doesn't match the current `targetField.id` are
   * silently ignored (defense-in-depth — `MappingContent` already
   * gates by row identity).
   */
  restoreFormState?: CreateMappingFormSnapshot | null
  /** See `restoreFormState`. */
  onRestoreConsumed?: () => void
}

// ── Internal types ───────────────────────────────────────────────────────────

/**
 * A joined-table entry in the form's `ambiguousCandidates` map. Mirrors
 * the wrapper's CROSS_TABLE_AMBIGUOUS result shape, scoped to a single
 * joined table.
 *
 *   • `candidates` empty   → zero-FK case: render banner row, block save.
 *   • `candidates` non-empty → multi-FK case: render dropdown until the
 *     user picks a value present in `candidates`.
 */
interface AmbiguousEntry {
  candidates: string[]
  joinedTableName: string
  dominantTableName: string
}

// ── Defaults / mappings ──────────────────────────────────────────────────────

const DEFAULT_COMBINATION_TYPE: CreateFieldMappingCombinationType = 'concat_space'

const ERROR_CODE_COPY: Record<CreateFieldMappingErrorCode, string> = {
  PERMISSION_DENIED:
    "You don't have permission to create mappings on this project.",
  NOT_FOUND: "Couldn't create the mapping. Please refresh and try again.",
  VALIDATION:
    "Couldn't create the mapping. Please check your selections and try again.",
  MAINTENANCE_MODE:
    'Mapping changes are temporarily disabled. Please try again in a moment.',
  INTERNAL: "Couldn't create the mapping. Please try again.",
  // Retained on the union for client compatibility but no longer
  // emitted post-4a-3 (cross-table input is fully supported).
  CROSS_TABLE_NOT_YET_SUPPORTED:
    'Cross-table mappings are not available in this build. Please pick sources from a single source table.',
  // Surfaced as fallback when CROSS_TABLE_AMBIGUOUS arrives without
  // a populated `ambiguousJoinedTableName`. The form's primary
  // surfaces (zero-FK banner, dropdown) cover the structured case.
  CROSS_TABLE_AMBIGUOUS:
    "We couldn't determine the join between the selected source tables. Pick the join field below.",
}

const EXISTING_TFM_COPY =
  'This target field was mapped while you were editing. Refresh to see the current state.'

// ── Component ────────────────────────────────────────────────────────────────

export const CreateMappingForm = forwardRef<
  CreateMappingFormHandle,
  CreateMappingFormProps
>(function CreateMappingForm(
  {
    projectId,
    targetField,
    availableSourceFields,
    onSaveSuccess,
    onCancel,
    onStateChange,
    restoreFormState,
    onRestoreConsumed,
  },
  ref,
) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [combinationType, setCombinationType] =
    useState<CreateFieldMappingCombinationType>(DEFAULT_COMBINATION_TYPE)
  const [isSavePending, startSaveTransition] = useTransition()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<CreateFieldMappingErrorCode | null>(
    null,
  )
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)

  // ── Cross-table disambiguation state (Phase 4a-3) ─────────────
  // `ambiguousCandidates`: server-supplied feedback keyed by joined
  // source table id. Empty array = zero-FK case (unresolvable in
  // form — render a banner and block save until chip removed).
  // Non-empty array = multi-FK case — render a <select> dropdown.
  // `joinAnnotations`: user's pick per joined table id; values are
  // FK field names in the dominant table. Sent to the wrapper on
  // resave; persisted in the JOIN_SPEC JSONB (multi-candidate only).
  const [ambiguousCandidates, setAmbiguousCandidates] = useState<
    Map<string, AmbiguousEntry>
  >(() => new Map())
  const [joinAnnotations, setJoinAnnotations] = useState<
    Record<string, string>
  >({})
  // Some joined tables may be in `ambiguousCandidates` AND have a
  // resolved `joinAnnotations` entry — by default we render those as
  // read-only summary rows. The user can flip an individual entry
  // back to "edit" mode via the Change link; this state tracks that.
  const [editingResolvedTableIds, setEditingResolvedTableIds] = useState<
    Set<string>
  >(() => new Set())

  // ── Derived: selected fields, dominant table, joined-table set ──
  const selectedFields = useMemo<SourceFieldWithState[]>(() => {
    const map = new Map<string, SourceFieldWithState>()
    for (const f of availableSourceFields) map.set(f.id, f)
    const out: SourceFieldWithState[] = []
    for (const id of selectedIds) {
      const f = map.get(id)
      if (f) out.push(f)
    }
    return out
  }, [selectedIds, availableSourceFields])

  const dominantTableId =
    selectedFields.length > 0 ? selectedFields[0].sourceTable.id : null
  const presentJoinedTableIds = useMemo<Set<string>>(() => {
    if (dominantTableId === null) return new Set()
    const out = new Set<string>()
    for (const f of selectedFields) {
      if (f.sourceTable.id !== dominantTableId) out.add(f.sourceTable.id)
    }
    return out
  }, [selectedFields, dominantTableId])

  // ── Cleanup effect (§4-OQ-3) ─────────────────────────────────
  // When chips for a joined table are all removed, silently drop
  // that table's entries from `ambiguousCandidates`, `joinAnnotations`,
  // and `editingResolvedTableIds`. The user never sees a stale
  // dropdown for a chip they removed.
  useEffect(() => {
    setAmbiguousCandidates((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const k of [...next.keys()]) {
        if (!presentJoinedTableIds.has(k)) {
          next.delete(k)
          changed = true
        }
      }
      return changed ? next : prev
    })
    setJoinAnnotations((prev) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const k of Object.keys(prev)) {
        if (presentJoinedTableIds.has(k)) {
          next[k] = prev[k]
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
    setEditingResolvedTableIds((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const k of prev) {
        if (presentJoinedTableIds.has(k)) {
          next.add(k)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [presentJoinedTableIds])

  // ── Phase 4a-4a — restoreFormState mount-time hydration ─────────
  //
  // When a user undoes a row-switch-discard, `MappingContent` passes
  // the previously-captured snapshot back down through the drawer.
  // We apply it on mount (or on the first render where it becomes
  // non-null), then call `onRestoreConsumed` so the parent clears the
  // prop. The targetFieldId check is defense-in-depth — the drawer is
  // keyed by row identity so a mismatched snapshot is unreachable in
  // production paths, but defensive code beats a crash if a future
  // bug threads the wrong shape through.
  //
  // We track "applied" via a ref instead of state so re-renders during
  // the apply pass don't double-fire. The dependency on the snapshot
  // identity covers the case where the user invokes Undo a second
  // time within the same form mount (rare, but possible if they
  // somehow row-switch + undo in rapid succession before unmount).
  const restoreAppliedRef = useRef<CreateMappingFormSnapshot | null>(null)
  useEffect(() => {
    if (
      restoreFormState !== null &&
      restoreFormState !== undefined &&
      restoreFormState !== restoreAppliedRef.current &&
      restoreFormState.targetFieldId === targetField.id
    ) {
      restoreAppliedRef.current = restoreFormState
      setSelectedIds(restoreFormState.selectedIds)
      setCombinationType(restoreFormState.combinationType)
      setJoinAnnotations({ ...restoreFormState.joinAnnotations })
      // Resolved disambiguation entries from a previous attempt are
      // intentionally NOT carried — `ambiguousCandidates` is server
      // feedback that we'd need to re-derive on next save anyway.
      setAmbiguousCandidates(new Map())
      setEditingResolvedTableIds(new Set())
      onRestoreConsumed?.()
    }
  }, [restoreFormState, targetField.id, onRestoreConsumed])

  // ── Derived flags ───────────────────────────────────────────────
  const isDirty = selectedIds.length > 0

  // Unresolved ambiguity blocks save: any zero-FK entry, or any
  // multi-FK entry without a matching annotation.
  const hasUnresolvedAmbiguity = useMemo(() => {
    for (const [tableId, info] of ambiguousCandidates) {
      if (info.candidates.length === 0) return true
      const picked = joinAnnotations[tableId]
      if (!picked || !info.candidates.includes(picked)) return true
    }
    return false
  }, [ambiguousCandidates, joinAnnotations])

  const canSave =
    selectedIds.length > 0 && !isSavePending && !hasUnresolvedAmbiguity

  // Phase 4a-4a — publish a snapshot whenever the form is dirty so
  // the drawer can lift it to `MappingContent` for row-switch undo.
  // `null` when clean.
  useEffect(() => {
    const snapshot: CreateMappingFormSnapshot | null = isDirty
      ? {
          targetFieldId: targetField.id,
          selectedIds: [...selectedIds],
          combinationType,
          joinAnnotations: { ...joinAnnotations },
        }
      : null
    onStateChange?.({ isDirty, canSave, isSavePending, snapshot })
  }, [
    isDirty,
    canSave,
    isSavePending,
    selectedIds,
    combinationType,
    joinAnnotations,
    targetField.id,
    onStateChange,
  ])

  // ── Effective combination — collapses to 'single' for 1 source ───
  // The wrapper expects `'single'` when there is exactly one source;
  // the user's stored concat selection only matters once a second
  // source is added. The radio group is hidden for <2 sources, so the
  // user never observes this flip directly.
  const effectiveCombinationType: CreateFieldMappingCombinationType =
    selectedIds.length <= 1 ? 'single' : combinationType

  // ── Sample preview ──────────────────────────────────────────────
  const previewCombination: SamplePreviewCombinationType =
    effectiveCombinationType
  const samplePreview = useMemo(
    () => computeSamplePreview(selectedFields, previewCombination),
    [selectedFields, previewCombination],
  )

  // ── Selection / combination handlers ─────────────────────────────
  const handleSelectedChange = (next: string[]) => {
    setSelectedIds(next)
    if (errorMessage !== null) {
      setErrorMessage(null)
      setErrorCode(null)
    }
  }

  const handleAnnotationChange = (joinedTableId: string, fkName: string) => {
    setJoinAnnotations((prev) => ({ ...prev, [joinedTableId]: fkName }))
    setEditingResolvedTableIds((prev) => {
      if (!prev.has(joinedTableId)) return prev
      const next = new Set(prev)
      next.delete(joinedTableId)
      return next
    })
  }

  const handleAnnotationChangeRequest = (joinedTableId: string) => {
    setEditingResolvedTableIds((prev) => {
      if (prev.has(joinedTableId)) return prev
      const next = new Set(prev)
      next.add(joinedTableId)
      return next
    })
  }

  // ── Save flow ───────────────────────────────────────────────────
  const handleSave = () => {
    if (selectedIds.length === 0 || isSavePending) return
    if (hasUnresolvedAmbiguity) return
    setErrorMessage(null)
    setErrorCode(null)
    startSaveTransition(async () => {
      try {
        const result = await createFieldMapping({
          projectId,
          targetFieldId: targetField.id,
          sourceFieldIds: selectedIds,
          combinationType: effectiveCombinationType,
          joinAnnotations,
        })
        if (!result.success) {
          // CROSS_TABLE_AMBIGUOUS is the structured cross-table
          // disambiguation channel. The wrapper returns the joined
          // table id + name + candidate list — surface them as a
          // dedicated UI section below the picker rather than as a
          // generic error banner.
          if (
            result.errorCode === 'CROSS_TABLE_AMBIGUOUS' &&
            result.ambiguousJoinedTableId &&
            result.ambiguousJoinedTableName &&
            result.dominantTableName !== undefined
          ) {
            const tableId = result.ambiguousJoinedTableId
            const candidates = result.candidateFkFields ?? []
            setAmbiguousCandidates((prev) => {
              const next = new Map(prev)
              next.set(tableId, {
                candidates,
                joinedTableName: result.ambiguousJoinedTableName!,
                dominantTableName: result.dominantTableName!,
              })
              return next
            })
            // Reflect the ambiguity into errorCode for tests/banner
            // gating but skip the generic error banner — the inline
            // section conveys the resolution path.
            setErrorCode(result.errorCode)
            setErrorMessage(null)
            if (typeof console !== 'undefined') {
              console.error(
                '[CreateMappingForm] cross-table ambiguity:',
                result,
              )
            }
            return
          }

          // EXISTING_TFM is a special VALIDATION case — the wrapper
          // returns errorCode='VALIDATION' with a stable phrase baked
          // into `error`. Sniff for the canonical phrase to surface
          // the inline [Refresh] affordance.
          const isExistingTfm =
            result.errorCode === 'VALIDATION' &&
            typeof result.error === 'string' &&
            result.error.toLowerCase().includes('mapped while you were editing')
          setErrorCode(result.errorCode)
          setErrorMessage(
            isExistingTfm
              ? EXISTING_TFM_COPY
              : ERROR_CODE_COPY[result.errorCode] ?? ERROR_CODE_COPY.INTERNAL,
          )
          if (typeof console !== 'undefined') {
            console.error(
              '[CreateMappingForm] createFieldMapping failed:',
              result,
            )
          }
          return
        }
        onSaveSuccess(result.tfmId)
      } catch (err) {
        setErrorCode('INTERNAL')
        setErrorMessage(ERROR_CODE_COPY.INTERNAL)
        if (typeof console !== 'undefined') {
          console.error('[CreateMappingForm] createFieldMapping threw:', err)
        }
      }
    })
  }

  const handleRefreshOnExistingTfm = () => {
    router.refresh()
    onCancel()
  }

  // ── Close routing — dirty → confirm dialog; clean → immediate ───
  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscardOpen(true)
    } else {
      onCancel()
    }
  }

  const handleDialogKeepEditing = () => {
    setConfirmDiscardOpen(false)
  }

  const handleDialogDiscard = () => {
    setConfirmDiscardOpen(false)
    onCancel()
  }

  useImperativeHandle(
    ref,
    () => ({
      triggerSave: handleSave,
      requestClose,
    }),
    // intentionally re-create the handle on each render — closures
    // over `selectedIds`/`isSavePending`/`isDirty` need to be fresh.
  )

  // ── Derived UI flags ────────────────────────────────────────────
  const fieldsDisabled = isSavePending || confirmDiscardOpen
  const showCombinationRadios = selectedIds.length >= 2
  const isExistingTfmError =
    errorMessage === EXISTING_TFM_COPY && errorCode === 'VALIDATION'

  return (
    <div data-testid="create-mapping-form" className="flex flex-col gap-3">
      {errorMessage ? (
        <ErrorBanner
          message={errorMessage}
          showRefreshButton={isExistingTfmError}
          onRefresh={handleRefreshOnExistingTfm}
        />
      ) : null}

      <SourceFieldPicker
        availableSourceFields={availableSourceFields}
        selectedIds={selectedIds}
        onSelectedChange={handleSelectedChange}
        disabled={fieldsDisabled}
      />

      {ambiguousCandidates.size > 0 ? (
        <JoinDisambiguation
          entries={ambiguousCandidates}
          joinAnnotations={joinAnnotations}
          editingTableIds={editingResolvedTableIds}
          onChangeAnnotation={handleAnnotationChange}
          onChangeRequest={handleAnnotationChangeRequest}
          disabled={fieldsDisabled}
        />
      ) : null}

      {showCombinationRadios ? (
        <CombinationRadios
          value={combinationType}
          onChange={setCombinationType}
          disabled={fieldsDisabled}
          selectedFields={selectedFields}
        />
      ) : null}

      <SamplePreview preview={samplePreview} />

      <DiscardChangesDialog
        targetFieldName={targetField.name}
        open={confirmDiscardOpen}
        onKeepEditing={handleDialogKeepEditing}
        onDiscard={handleDialogDiscard}
      />
    </div>
  )
})

// ── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({
  message,
  showRefreshButton,
  onRefresh,
}: {
  message: string
  showRefreshButton: boolean
  onRefresh: () => void
}) {
  return (
    <div
      role="alert"
      data-testid="create-mapping-form-error"
      className={cn(
        'flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800',
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500"
      />
      <div className="flex flex-1 items-center justify-between gap-2">
        <span className="leading-snug">{message}</span>
        {showRefreshButton ? (
          <button
            type="button"
            onClick={onRefresh}
            data-testid="create-mapping-form-refresh"
            className={cn(
              'inline-flex h-6 items-center justify-center rounded border px-2 text-[11px] font-medium',
              'border-red-300 bg-white text-red-800 hover:bg-red-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40',
            )}
          >
            Refresh
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── Join disambiguation (Phase 4a-3) ────────────────────────────────────────
//
// Renders one row per joined table that came back as
// CROSS_TABLE_AMBIGUOUS from the wrapper. Three row variants:
//
//   1. Zero-FK error  — `candidates` empty. Shows a static red-bordered
//      banner with copy directing the user to the schema or legacy
//      mapping page. No way to resolve in form; user must remove the
//      offending chip. No refresh affordance per §8-OQ-2.
//
//   2. Multi-FK active dropdown — user has not yet picked a candidate
//      OR they've explicitly clicked Change. Native <select> with the
//      candidate list (§4-OQ-1).
//
//   3. Multi-FK resolved — the user has picked a candidate AND has
//      not opted into Change mode. Read-only summary line with a
//      muted [Change] link (§4-OQ-2).

function JoinDisambiguation({
  entries,
  joinAnnotations,
  editingTableIds,
  onChangeAnnotation,
  onChangeRequest,
  disabled,
}: {
  entries: Map<string, AmbiguousEntry>
  joinAnnotations: Record<string, string>
  editingTableIds: Set<string>
  onChangeAnnotation: (joinedTableId: string, fkName: string) => void
  onChangeRequest: (joinedTableId: string) => void
  disabled: boolean
}) {
  // Map iteration preserves insertion order (= save attempt order)
  // so users see the table they most recently picked first.
  const list = Array.from(entries.entries())
  return (
    <section
      data-testid="create-mapping-form-disambiguation"
      className="flex flex-col gap-1.5 rounded border border-amber-200 bg-amber-50 px-3 py-2"
    >
      <header className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
        Join field
      </header>
      {list.map(([joinedTableId, info]) => {
        const picked = joinAnnotations[joinedTableId]
        const isResolved =
          picked !== undefined &&
          info.candidates.includes(picked) &&
          !editingTableIds.has(joinedTableId)
        if (info.candidates.length === 0) {
          return (
            <ZeroFkBanner
              key={joinedTableId}
              joinedTableName={info.joinedTableName}
              dominantTableName={info.dominantTableName}
            />
          )
        }
        if (isResolved) {
          return (
            <ResolvedRow
              key={joinedTableId}
              joinedTableId={joinedTableId}
              joinedTableName={info.joinedTableName}
              dominantTableName={info.dominantTableName}
              picked={picked}
              onChangeRequest={onChangeRequest}
              disabled={disabled}
            />
          )
        }
        return (
          <ActiveDropdown
            key={joinedTableId}
            joinedTableId={joinedTableId}
            entry={info}
            picked={picked}
            onChangeAnnotation={onChangeAnnotation}
            disabled={disabled}
          />
        )
      })}
    </section>
  )
}

function ZeroFkBanner({
  joinedTableName,
  dominantTableName,
}: {
  joinedTableName: string
  dominantTableName: string
}) {
  return (
    <div
      role="alert"
      data-testid="create-mapping-form-disambiguation-zero-fk"
      data-joined-table-name={joinedTableName}
      className={cn(
        'flex items-start gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-800',
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500"
      />
      <span className="leading-snug">
        No foreign key in{' '}
        <span className="font-mono font-semibold">{dominantTableName}</span>{' '}
        references{' '}
        <span className="font-mono font-semibold">{joinedTableName}</span>. Add
        an FK in the source schema or use the legacy Mapping page for ad-hoc
        joins.
      </span>
    </div>
  )
}

function ActiveDropdown({
  joinedTableId,
  entry,
  picked,
  onChangeAnnotation,
  disabled,
}: {
  joinedTableId: string
  entry: AmbiguousEntry
  picked: string | undefined
  onChangeAnnotation: (joinedTableId: string, fkName: string) => void
  disabled: boolean
}) {
  return (
    <div
      data-testid="create-mapping-form-disambiguation-active"
      data-joined-table-id={joinedTableId}
      data-joined-table-name={entry.joinedTableName}
      className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-900"
    >
      <span>
        Join{' '}
        <span className="font-mono font-semibold">{entry.dominantTableName}</span>{' '}
        to{' '}
        <span className="font-mono font-semibold">{entry.joinedTableName}</span>{' '}
        via
      </span>
      <select
        data-testid="create-mapping-form-disambiguation-select"
        value={picked ?? ''}
        onChange={(e) => onChangeAnnotation(joinedTableId, e.target.value)}
        disabled={disabled}
        aria-label={`Choose join field for ${entry.joinedTableName}`}
        className={cn(
          'rounded border border-amber-300 bg-white px-2 py-0.5 font-mono text-[11px]',
          'focus:outline-none focus:ring-1 focus:ring-amber-500',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
        )}
      >
        <option value="" disabled>
          Pick FK…
        </option>
        {entry.candidates.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  )
}

function ResolvedRow({
  joinedTableId,
  joinedTableName,
  dominantTableName,
  picked,
  onChangeRequest,
  disabled,
}: {
  joinedTableId: string
  joinedTableName: string
  dominantTableName: string
  picked: string
  onChangeRequest: (joinedTableId: string) => void
  disabled: boolean
}) {
  return (
    <div
      data-testid="create-mapping-form-disambiguation-resolved"
      data-joined-table-id={joinedTableId}
      data-joined-table-name={joinedTableName}
      className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-900"
    >
      <span>
        Joining{' '}
        <span className="font-mono font-semibold">{dominantTableName}</span> to{' '}
        <span className="font-mono font-semibold">{joinedTableName}</span> via{' '}
        <span className="font-mono font-semibold">{picked}</span>
      </span>
      <button
        type="button"
        onClick={() => onChangeRequest(joinedTableId)}
        disabled={disabled}
        data-testid="create-mapping-form-disambiguation-change"
        className={cn(
          'inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide',
          'text-amber-700 hover:bg-amber-100 hover:text-amber-900',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        Change
      </button>
    </div>
  )
}

// ── Combination radios ───────────────────────────────────────────────────────

const COMBINATION_LABELS: Record<
  CreateFieldMappingCombinationType,
  string
> = {
  single: 'Use single source',
  concat_space: 'Concatenate with space',
  concat_comma: 'Concatenate with comma',
}

const CUSTOM_SQL_TOOLTIP =
  'Custom SQL combinations are managed in the Transform tab.'

function CombinationRadios({
  value,
  onChange,
  disabled,
  selectedFields,
}: {
  value: CreateFieldMappingCombinationType
  onChange: (next: CreateFieldMappingCombinationType) => void
  disabled: boolean
  selectedFields: SourceFieldWithState[]
}) {
  // Compute one-row example per combination from the actual selected
  // sources' first sample values. Falls back to canned literals when
  // any source has no samples.
  const example = (combination: 'concat_space' | 'concat_comma'): string => {
    const allHaveSamples = selectedFields.every((f) => f.sampleValues.length > 0)
    if (!allHaveSamples) {
      return combination === 'concat_space' ? 'Smith John' : 'Smith, John'
    }
    const firsts = selectedFields.map((f) => f.sampleValues[0]!)
    return firsts.join(combination === 'concat_space' ? ' ' : ', ')
  }

  return (
    <fieldset
      data-testid="create-mapping-form-combination"
      className="flex flex-col gap-1.5 rounded border border-slate-200 px-3 py-2"
      disabled={disabled}
    >
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        Combination
      </legend>
      <RadioRow
        name="combination"
        value="concat_space"
        checked={value === 'concat_space'}
        onChange={() => onChange('concat_space')}
        label={COMBINATION_LABELS.concat_space}
        example={`"${example('concat_space')}"`}
        disabled={disabled}
      />
      <RadioRow
        name="combination"
        value="concat_comma"
        checked={value === 'concat_comma'}
        onChange={() => onChange('concat_comma')}
        label={COMBINATION_LABELS.concat_comma}
        example={`"${example('concat_comma')}"`}
        disabled={disabled}
      />
      <RadioRow
        name="combination"
        value="custom_sql"
        checked={false}
        onChange={() => {}}
        label="Custom SQL"
        example="Managed in the Transform tab"
        disabled
        explicitlyBlocked
      />
    </fieldset>
  )
}

function RadioRow({
  name,
  value,
  checked,
  onChange,
  label,
  example,
  disabled,
  explicitlyBlocked = false,
}: {
  name: string
  value: string
  checked: boolean
  onChange: () => void
  label: string
  example: string
  disabled: boolean
  explicitlyBlocked?: boolean
}) {
  return (
    <label
      data-testid={`create-mapping-form-combination-${value}`}
      data-disabled={explicitlyBlocked ? 'true' : undefined}
      title={explicitlyBlocked ? CUSTOM_SQL_TOOLTIP : undefined}
      className={cn(
        'flex items-center gap-2 text-xs',
        explicitlyBlocked
          ? 'cursor-not-allowed text-slate-400'
          : 'cursor-pointer text-slate-700',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled || explicitlyBlocked}
        className="h-3.5 w-3.5 accent-blue-600"
      />
      <span className="font-medium">{label}</span>
      <span className="text-slate-400">—</span>
      <span className="font-mono">{example}</span>
    </label>
  )
}

// ── Sample preview ───────────────────────────────────────────────────────────

function SamplePreview({
  preview,
}: {
  preview: { preview: string[]; overflow: number }
}) {
  return (
    <div
      data-testid="create-mapping-form-preview"
      className="rounded border border-slate-200 px-3 py-2"
    >
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        Sample preview
      </div>
      {preview.preview.length === 0 ? (
        <p
          data-testid="create-mapping-form-preview-empty"
          className="text-[11px] italic text-slate-400"
        >
          No sample values available
        </p>
      ) : (
        <ul
          data-testid="create-mapping-form-preview-list"
          className="space-y-0.5"
        >
          {preview.preview.map((row, idx) => (
            <li
              key={idx}
              data-testid="create-mapping-form-preview-row"
              className="truncate font-mono text-[11px] text-slate-700"
              title={row}
            >
              {row}
            </li>
          ))}
          {preview.overflow > 0 ? (
            <li
              data-testid="create-mapping-form-preview-overflow"
              className="text-[11px] italic text-slate-400"
            >
              + {preview.overflow} more
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

// ── Discard dialog ───────────────────────────────────────────────────────────

function DiscardChangesDialog({
  targetFieldName,
  open,
  onKeepEditing,
  onDiscard,
}: {
  targetFieldName: string
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Esc / overlay-click both surface as "user wants to bail" —
        // collapse to the same path as the explicit Keep editing.
        // Per founder decision §1-OQ-1 this dismisses the dialog
        // ONLY (the parent does not bubble it to drawer-close).
        if (!next) onKeepEditing()
      }}
    >
      <AlertDialogContent data-testid="create-mapping-form-discard-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your selected sources for{' '}
            <span className="font-mono text-gray-700">{targetFieldName}</span>{' '}
            will be lost. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="create-mapping-form-discard-cancel"
            onClick={onKeepEditing}
          >
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onDiscard()
            }}
            data-testid="create-mapping-form-discard-confirm"
            className="bg-red-600 hover:bg-red-700 focus:ring-red-500/40"
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
