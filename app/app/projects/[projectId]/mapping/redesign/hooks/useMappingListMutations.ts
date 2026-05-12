'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/lib/contexts/ToastContext'
import {
  approveFieldMapping,
  createMappingFromUnmapped,
  editMappingSources,
  rejectFieldMapping,
  setUnmappedRowRejected,
  updateMappingSourceField,
  updateMappingTargetField,
  type CreateFieldMappingCombinationType,
} from '@/lib/actions/mappings-for-redesign'

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

type MutationResult = { success: boolean }

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
}

export function useMappingListMutations(
  args: UseMappingListMutationsArgs,
): MappingListMutations {
  const { projectId } = args
  const router = useRouter()
  const { pushToast } = useToast()
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())

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
      action: () => Promise<{ success: boolean; error?: string }>,
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
        return { success: true }
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

  const swapMappingTarget = useCallback(
    (tfmId: string, newTargetFieldId: string) =>
      run(
        tfmId,
        () => updateMappingTargetField({ tfmId, newTargetFieldId }),
        'Target field updated',
      ),
    [run],
  )

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
    editMappingSources: editMappingSourcesMut,
  }
}
