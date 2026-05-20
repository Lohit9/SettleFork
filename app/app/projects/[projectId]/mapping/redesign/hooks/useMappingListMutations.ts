'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/lib/contexts/ToastContext'
import {
  approveFieldMapping,
  createMappingFromUnmapped,
  editMappingSources,
  promoteUnmappedSource,
  rejectFieldMapping,
  setUnmappedRowRejected,
  updateMappingSourceField,
  updateMappingTargetField,
  type CreateFieldMappingCombinationType,
  type TargetMergePreview,
} from '@/lib/actions/mappings-for-redesign'
import { acknowledgeField } from '@/lib/actions/field-acknowledgments'

// ─────────────────────────────────────────────────────────────────────────────
// useMappingListMutations — orchestration hook for the Mapping list view.
// ─────────────────────────────────────────────────────────────────────────────
//
// Wires the five mutation entry points used by the flat view to a
// uniform refresh + toast flow. Mirrors the target-led view's
// `handleInlineApprove` / `handleInlineReject` semantics
// (MappingContent.tsx:1306-1401):
//
//   • Call the server action (`revalidatePath` is server-side, already
//     wired by the action).
//   • On success: `router.refresh()` re-fetches the server-rendered
//     page data (which triggers `flattenRowsForListView` to re-derive
//     the row list — server-side unmapped synthesis handles last-source
//     reject + manual-create transitions atomically).
//   • On failure: pushToast({ variant: 'error', ... }), leave UI state
//     unchanged so the user can retry.
//
// Optimistic UI is DEFERRED to v2 — the target-led view's optimistic
// machinery is tied to its slide-fade reject animation and would
// double the prop surface here for minimal v1 value. The flat view
// accepts a brief flicker during refresh. Pending state on a per-row
// basis still drives button-disabled treatment so users can't double-
// click while a mutation is in flight.

interface UseMappingListMutationsArgs {
  projectId: string
}

// `tfmId` is populated for mutations that resolve to a known target
// field mapping — creates and promotions in particular. The drawer uses
// it to re-point at a row whose identity changed (e.g. an unmapped row
// promoted to a real TFM). Mutations that don't resolve a TFM leave it
// undefined.
type MutationResult = {
  success: boolean
  tfmId?: string
  /**
   * True when a target swap hit an already-mapped target and opened the
   * merge-confirmation dialog instead of completing. The picker callers
   * close their popover on this so the dialog has a clean surface.
   */
  mergeOpened?: boolean
}

/**
 * A target swap that the server reported as `MERGE_REQUIRED`, parked
 * pending the user's confirmation in `MergeTargetDialog`. `confirmMerge`
 * re-invokes `updateMappingTargetField` with the same identity.
 */
export interface PendingTargetMerge {
  swappingTfmId: string
  newTargetFieldId: string
  preview: TargetMergePreview
}

export interface MappingListMutations {
  /**
   * True while any mutation is in flight against this row id. The row
   * id key matches whatever the caller passes as `rowId` to the
   * action methods.
   */
  isRowBusy: (rowId: string) => boolean

  /** Approve a TFM (existing server action). Routes through the shimmed row id. */
  approveTfm: (rowId: string) => Promise<MutationResult>

  /**
   * Reject a TFM contributor (`<tfmId>::<mappingSourceId>`), full TFM
   * (`<tfmId>`), or unmapped target / VA row (`unmapped::<id>` /
   * direct TFM id) via the existing `rejectFieldMapping` action.
   *
   * The server-side reject deletes mapping_sources; the next refresh
   * either retains the TFM with N-1 sources or re-synthesises an
   * UnmappedRow when the last source is gone.
   */
  rejectTfm: (rowId: string) => Promise<MutationResult>

  /**
   * Swap a TFM source attribution's source field. Auto-approves the
   * whole TFM at confidence=1.0 (server-side policy).
   */
  swapMappingSource: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<MutationResult>

  /**
   * Swap a TFM's target field. Calls A's
   * `updateMappingTargetField`; auto-approves at confidence=1.0
   * (server-side policy).
   */
  swapMappingTarget: (
    tfmId: string,
    newTargetFieldId: string,
  ) => Promise<MutationResult>

  /**
   * Create a new TFM from an unmapped row + picker selection. Funnels
   * both axes (unmapped-target picking a source; unmapped-source
   * picking a target) through one server action. Auto-approves at
   * confidence=1.0.
   */
  createFromUnmapped: (args: {
    sourceFieldId: string
    targetFieldId: string
    /**
     * Pending-state key — the unmapped row id the user clicked Edit on.
     * The hook uses it for button-disable bookkeeping during the call.
     */
    pendingKey: string
  }) => Promise<MutationResult>

  /**
   * Mark an unmapped row (target-side or source-side) as rejected.
   * Status flips to 'rejected' (gray dot). Row stays visible.
   */
  rejectUnmappedRow: (args: {
    pendingKey: string
    target: { targetFieldId: string } | { sourceFieldId: string }
  }) => Promise<MutationResult>

  /**
   * feat/mapping-row-uniformity — approve (acknowledge) an
   * unmapped-source row. Mirrors `rejectUnmappedRow`'s shape and
   * optimistic-update treatment (`run` wrapper, pending-key
   * tracking, toast + router.refresh on success). Wraps the
   * `acknowledgeField(projectId, sourceFieldId, 'source', '')`
   * server action — UPSERTs into `source_field_acknowledgments`
   * defaulting `decision='acknowledged'` (status flips to 'approved'
   * → green dot). Row stays visible because explicit user decisions
   * are worth surfacing in the audit trail.
   *
   * Source-side approve is the mirror of source-side reject (which
   * already lived on `rejectUnmappedRow` via `setUnmappedRowRejected`).
   * Target-side approve continues to flow through `approveTfm` with
   * the `unmapped::<targetFieldId>` sentinel — no change.
   */
  approveUnmappedSource: (args: {
    pendingKey: string
    sourceFieldId: string
  }) => Promise<MutationResult>

  /**
   * feat/drawer-body-editing-surface — promote an unmapped-source row to
   * a mapped row by picking a target field. Wraps the case-detecting
   * `promoteUnmappedSource` server action:
   *   • Target unmapped → a new 1:1 TFM is created.
   *   • Target already mapped → the picked source is appended to the
   *     existing TFM (single/multi → multi).
   *
   * The resolved TFM id is surfaced on `MutationResult.tfmId` so the
   * drawer can follow the promoted row through its identity change.
   */
  promoteUnmappedSource: (args: {
    sourceFieldId: string
    targetFieldId: string
    /** Pending-state key — the unmapped-source row id the user acted on. */
    pendingKey: string
  }) => Promise<MutationResult>

  /**
   * Drawer redesign PR 2 — replace the mapping_sources set on an
   * existing TFM. Used by:
   *   • Per-source ✕ remove (multi-source) — pass the remaining
   *     source-field-id list. Server-side resets `transformReset`
   *     when the source set changes.
   *   • ⊕ Add source (PR 2 TASK 2) — pass existing + new.
   *   • VA → mapped conversion (PR 2 TASK 3) — pass `[newSourceId]`
   *     with `combinationType: 'single'`; the action overwrites the
   *     VA's `combination_type='custom_sql'` (orphan `combination_sql`
   *     remains in DB but is inert for non-custom_sql rows).
   *
   * The server action flips TFM status to 'needs_review' on any
   * source-set change — substantial structure change merits a
   * re-review, mirroring the existing edit-form semantic.
   */
  editMappingSources: (args: {
    tfmId: string
    sourceFieldIds: string[]
    combinationType: CreateFieldMappingCombinationType
  }) => Promise<MutationResult>

  /**
   * A target swap parked awaiting merge confirmation, or `null`. When
   * non-null, the host renders `MergeTargetDialog`. Set when
   * `swapMappingTarget` receives a `MERGE_REQUIRED` response.
   */
  pendingMerge: PendingTargetMerge | null

  /** True while `confirmPendingMerge` is in flight. */
  isMergePending: boolean

  /**
   * Execute the parked merge — re-invokes `updateMappingTargetField`
   * with `confirmMerge: true`. Clears `pendingMerge` when done.
   */
  confirmPendingMerge: () => Promise<MutationResult>

  /** Dismiss the parked merge without executing it. */
  cancelPendingMerge: () => void
}

export function useMappingListMutations(
  args: UseMappingListMutationsArgs,
): MappingListMutations {
  const { projectId } = args
  const router = useRouter()
  const { pushToast } = useToast()
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [pendingMerge, setPendingMerge] = useState<PendingTargetMerge | null>(
    null,
  )
  const [isMergePending, setIsMergePending] = useState(false)

  const markPending = useCallback((key: string) => {
    setPendingKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])

  const clearPending = useCallback((key: string) => {
    setPendingKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<{
        success: boolean
        error?: string
        tfmId?: string
      }>,
      successMessage: string,
    ): Promise<MutationResult> => {
      markPending(key)
      try {
        const result = await action()
        if (!result.success) {
          pushToast({
            variant: 'error',
            message: result.error ?? 'Action failed. Please retry.',
          })
          return { success: false }
        }
        pushToast({ variant: 'success', message: successMessage })
        router.refresh()
        return { success: true, tfmId: result.tfmId }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Unexpected error. Please retry.'
        pushToast({ variant: 'error', message })
        return { success: false }
      } finally {
        clearPending(key)
      }
    },
    [clearPending, markPending, pushToast, router],
  )

  const isRowBusy = useCallback(
    (rowId: string) => pendingKeys.has(rowId),
    [pendingKeys],
  )

  const approveTfm = useCallback(
    (rowId: string) =>
      run(rowId, () => approveFieldMapping(rowId), 'Mapping approved'),
    [run],
  )

  const rejectTfm = useCallback(
    (rowId: string) =>
      run(rowId, () => rejectFieldMapping(rowId), 'Mapping rejected'),
    [run],
  )

  const swapMappingSource = useCallback(
    (rowId: string, newSourceFieldId: string) =>
      run(
        rowId,
        // newConfidence is omitted → server defaults to
        // FLAT_VIEW_USER_CONFIDENCE (100) per founder's auto-approve
        // policy for manual edits.
        () => updateMappingSourceField({ rowId, newSourceFieldId }),
        'Source field updated',
      ),
    [run],
  )

  // Target swap is two-phase. A clean swap (target unmapped) completes
  // in one call. A swap onto an already-mapped target returns
  // `MERGE_REQUIRED`: instead of an error toast, park the merge in
  // `pendingMerge` so the host can open `MergeTargetDialog`.
  const swapMappingTarget = useCallback(
    async (
      tfmId: string,
      newTargetFieldId: string,
    ): Promise<MutationResult> => {
      markPending(tfmId)
      try {
        const result = await updateMappingTargetField({
          tfmId,
          newTargetFieldId,
        })
        if (!result.success && result.errorCode === 'MERGE_REQUIRED') {
          setPendingMerge({
            swappingTfmId: tfmId,
            newTargetFieldId,
            preview: result.merge,
          })
          return { success: false, mergeOpened: true }
        }
        if (!result.success) {
          pushToast({
            variant: 'error',
            message: result.error ?? 'Action failed. Please retry.',
          })
          return { success: false }
        }
        pushToast({ variant: 'success', message: 'Target field updated' })
        router.refresh()
        return { success: true, tfmId: result.tfmId }
      } catch (err) {
        pushToast({
          variant: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Unexpected error. Please retry.',
        })
        return { success: false }
      } finally {
        clearPending(tfmId)
      }
    },
    [markPending, clearPending, pushToast, router],
  )

  const confirmPendingMerge = useCallback(async (): Promise<MutationResult> => {
    if (!pendingMerge) return { success: false }
    const { swappingTfmId, newTargetFieldId } = pendingMerge
    setIsMergePending(true)
    markPending(swappingTfmId)
    try {
      const result = await updateMappingTargetField({
        tfmId: swappingTfmId,
        newTargetFieldId,
        confirmMerge: true,
      })
      if (!result.success) {
        pushToast({
          variant: 'error',
          message: result.error ?? 'Merge failed. Please retry.',
        })
        return { success: false }
      }
      pushToast({ variant: 'success', message: 'Mappings merged' })
      setPendingMerge(null)
      router.refresh()
      return { success: true, tfmId: result.tfmId }
    } catch (err) {
      pushToast({
        variant: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Unexpected error. Please retry.',
      })
      return { success: false }
    } finally {
      setIsMergePending(false)
      clearPending(swappingTfmId)
    }
  }, [pendingMerge, markPending, clearPending, pushToast, router])

  const cancelPendingMerge = useCallback(() => {
    setPendingMerge(null)
  }, [])

  const createFromUnmapped = useCallback(
    (input: {
      sourceFieldId: string
      targetFieldId: string
      pendingKey: string
    }) =>
      run(
        input.pendingKey,
        () =>
          createMappingFromUnmapped({
            projectId,
            sourceFieldId: input.sourceFieldId,
            targetFieldId: input.targetFieldId,
          }),
        'Mapping created',
      ),
    [projectId, run],
  )

  const rejectUnmappedRow = useCallback(
    (input: {
      pendingKey: string
      target: { targetFieldId: string } | { sourceFieldId: string }
    }) =>
      run(
        input.pendingKey,
        () => setUnmappedRowRejected({ projectId, ...input.target }),
        'Row rejected',
      ),
    [projectId, run],
  )

  // feat/mapping-row-uniformity — symmetric source-side approve.
  // `acknowledgeField` throws on error; the inline wrapper translates
  // to the `{success, error?}` shape the `run` helper expects so
  // toasts + pending-key bookkeeping behave the same as the reject
  // path.
  const approveUnmappedSource = useCallback(
    (input: { pendingKey: string; sourceFieldId: string }) =>
      run(
        input.pendingKey,
        async () => {
          try {
            await acknowledgeField(projectId, input.sourceFieldId, 'source', '')
            return { success: true }
          } catch (err) {
            return {
              success: false,
              error:
                err instanceof Error
                  ? err.message
                  : 'Acknowledge failed. Please retry.',
            }
          }
        },
        'Source acknowledged',
      ),
    [projectId, run],
  )

  const promoteUnmappedSourceMut = useCallback(
    (input: {
      sourceFieldId: string
      targetFieldId: string
      pendingKey: string
    }) =>
      run(
        input.pendingKey,
        () =>
          promoteUnmappedSource({
            projectId,
            sourceFieldId: input.sourceFieldId,
            targetFieldId: input.targetFieldId,
          }),
        'Mapping created',
      ),
    [projectId, run],
  )

  const editMappingSourcesMut = useCallback(
    (input: {
      tfmId: string
      sourceFieldIds: string[]
      combinationType: CreateFieldMappingCombinationType
    }) =>
      run(
        input.tfmId,
        () =>
          editMappingSources({
            tfmId: input.tfmId,
            sourceFieldIds: input.sourceFieldIds,
            combinationType: input.combinationType,
          }),
        'Mapping updated',
      ),
    [run],
  )

  return {
    isRowBusy,
    approveTfm,
    rejectTfm,
    swapMappingSource,
    swapMappingTarget,
    createFromUnmapped,
    rejectUnmappedRow,
    approveUnmappedSource,
    promoteUnmappedSource: promoteUnmappedSourceMut,
    editMappingSources: editMappingSourcesMut,
    pendingMerge,
    isMergePending,
    confirmPendingMerge,
    cancelPendingMerge,
  }
}
