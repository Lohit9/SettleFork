'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/lib/contexts/ToastContext'
import {
  approveFieldMapping,
  createFieldMapping,
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
import type { PendingSourceDisambiguation } from '../components/SourceDisambiguationDialog'
import type {
  MappingRow,
  SourceFieldWithState,
} from '@/lib/types/mappings-for-redesign'
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

/**
 * PR Ω.3.x.1 — lookups the hook consults to detect the cross-table case
 * before reaching the server. Optional: hosts that don't supply lookups
 * skip the intercept (the server-side `allowCrossTable` guard still
 * catches cross-table writes, but the UX is a generic error toast
 * rather than the disambiguation popup).
 *
 * The host pre-builds Maps via `useMemo` against `data.rows` /
 * `data.sourceFields` — see `MappingContentLoaded`. Keying the row map
 * by `targetField.id` covers the `promoteUnmappedSource` flow (the
 * picked target's row is looked up by target field id). Keying by TFM id
 * covers the `editMappingSources` flow (the row being edited is
 * addressed by its TFM uuid, which equals `MappedRow.id`).
 */
export interface MappingMutationsLookups {
  rowsByTargetFieldId: ReadonlyMap<string, MappingRow>
  mappedRowsByTfmId: ReadonlyMap<string, MappingRow>
  sourceFieldsById: ReadonlyMap<string, SourceFieldWithState>
}

interface UseMappingListMutationsArgs {
  projectId: string
  /**
   * Pre-built lookups for the cross-table disambiguation intercept. When
   * omitted, `promoteUnmappedSource` and `editMappingSources` call the
   * server actions unchanged — the disambiguation popup never opens
   * from the hook, and the server-side `allowCrossTable` guard is the
   * only protection. Production callers (the redesign Mapping page)
   * always pass lookups; legacy tests that don't can leave this off
   * without compile-time breakage.
   */
  lookups?: MappingMutationsLookups
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

  // ── PR Ω.3.x.1 — manual multi-source disambiguation ──────────────────
  //
  // The host (`MappingContent.tsx`) intercepts the inline picker / drawer
  // add-source / `promoteUnmappedSource` gestures: same-source-table
  // additions short-circuit to silent combine; cross-source-table
  // additions park the disambiguation popup via `openPendingDisambiguation`.
  // The dialog reads `pendingDisambiguation`, dispatches one of the two
  // confirm methods on Save, and clears via `cancelPendingDisambiguation`
  // on dismiss.

  /**
   * Cross-table disambiguation parked awaiting user choice, or `null`.
   * When non-null, the host renders `SourceDisambiguationDialog`.
   */
  pendingDisambiguation: PendingSourceDisambiguation | null

  /** True while either confirm method is in flight. */
  isDisambiguationPending: boolean

  /**
   * Park a disambiguation popup. Called from the host's cross-table
   * intercept. Replaces any previously parked disambiguation.
   */
  openPendingDisambiguation: (next: PendingSourceDisambiguation) => void

  /**
   * Commit "Create separate" — invokes `createFieldMapping` with
   * `allowCrossTable: true`, `combinationType: 'single'`, and
   * `regenerateTrigger: 'create_disambiguated'`. Existing TFM untouched.
   * Clears `pendingDisambiguation` on success.
   */
  confirmDisambiguatedCreate: () => Promise<MutationResult>

  /**
   * Commit "Replace existing" — first `rejectFieldMapping(existingTfmId)`
   * (hard delete, matches `rejectFieldMapping` semantics), then
   * `createFieldMapping` with the same parameters as
   * `confirmDisambiguatedCreate`. Clears `pendingDisambiguation` on
   * success. If the create step fails after the reject succeeded, the
   * existing TFM is gone and the user gets the create error — same
   * risk surface as any reject-then-create flow on this codebase.
   */
  confirmDisambiguatedReplace: () => Promise<MutationResult>

  /** Dismiss the parked disambiguation without writing. */
  cancelPendingDisambiguation: () => void
}

export function useMappingListMutations(
  args: UseMappingListMutationsArgs,
): MappingListMutations {
  const { projectId, lookups } = args
  const router = useRouter()
  const { pushToast } = useToast()
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [pendingMerge, setPendingMerge] = useState<PendingTargetMerge | null>(
    null,
  )
  const [isMergePending, setIsMergePending] = useState(false)
  // PR Ω.3.x.1 — disambiguation popup parked state.
  const [
    pendingDisambiguation,
    setPendingDisambiguation,
  ] = useState<PendingSourceDisambiguation | null>(null)
  const [isDisambiguationPending, setIsDisambiguationPending] = useState(false)

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

  // ── PR Ω.3.x.1 — cross-table intercept (canonical site) ────────────
  //
  // Lives in the hook so EVERY entry point that routes through it is
  // protected: the flat view's target picker
  // (`MappingListView.handleTargetPickerCommit` →
  // `mutations.promoteUnmappedSource`), the drawer's "Add source"
  // affordance (`mutations.editMappingSources`), and the drawer's "Pick
  // a target" stub (`MappingContent.handlePromoteSource` →
  // `mutations.promoteUnmappedSource`). The target-led view's inline
  // picker is the one exception — it calls the bare server action
  // (`editMappingSources` from `@/lib/actions/mappings-for-redesign`),
  // bypassing the hook; that path keeps its host-level intercept in
  // `MappingContent.handleInlineSourceCommit`.
  //
  // When `lookups` is undefined (legacy callers, test fixtures), the
  // intercept short-circuits and the server-side `allowCrossTable`
  // guard becomes the only protection — surfaces a generic error toast
  // instead of the popup.

  const promoteUnmappedSourceMut = useCallback(
    (input: {
      sourceFieldId: string
      targetFieldId: string
      pendingKey: string
    }) => {
      if (lookups) {
        const targetRow = lookups.rowsByTargetFieldId.get(input.targetFieldId)
        if (targetRow && targetRow.kind === 'mapped') {
          const existingTableIds = new Set(
            targetRow.sources.map((s) => s.sourceTable.id),
          )
          const pickedSource = lookups.sourceFieldsById.get(input.sourceFieldId)
          if (
            pickedSource !== undefined &&
            existingTableIds.size > 0 &&
            !existingTableIds.has(pickedSource.sourceTable.id)
          ) {
            setPendingDisambiguation({
              rowId: targetRow.id,
              existingTfmId: targetRow.id,
              targetFieldId: targetRow.targetField.id,
              targetFieldName: targetRow.targetField.name,
              existingSources: targetRow.sources.map((s) => ({
                id: s.id,
                sourceFieldName: s.sourceField.name,
                sourceTableName: s.sourceTable.name,
              })),
              incomingSource: {
                sourceFieldId: pickedSource.id,
                sourceFieldName: pickedSource.name,
                sourceTableName: pickedSource.sourceTable.name,
              },
            })
            return Promise.resolve<MutationResult>({ success: true })
          }
        }
      }
      return run(
        input.pendingKey,
        () =>
          promoteUnmappedSource({
            projectId,
            sourceFieldId: input.sourceFieldId,
            targetFieldId: input.targetFieldId,
          }),
        'Mapping created',
      )
    },
    [projectId, run, lookups],
  )

  const editMappingSourcesMut = useCallback(
    (input: {
      tfmId: string
      sourceFieldIds: string[]
      combinationType: CreateFieldMappingCombinationType
    }) => {
      if (lookups) {
        const row = lookups.mappedRowsByTfmId.get(input.tfmId)
        if (row && row.kind === 'mapped') {
          const existingSourceFieldIds = new Set(
            row.sources.map((s) => s.sourceField.id),
          )
          const existingTableIds = new Set(
            row.sources.map((s) => s.sourceTable.id),
          )
          // Find the first newly-added source whose table is not already
          // contributing — mirrors `MappingContent.handleInlineSourceCommit`.
          const newCrossTableSourceFieldId = input.sourceFieldIds.find((id) => {
            if (existingSourceFieldIds.has(id)) return false
            const sf = lookups.sourceFieldsById.get(id)
            return sf !== undefined && !existingTableIds.has(sf.sourceTable.id)
          })
          if (newCrossTableSourceFieldId !== undefined) {
            const pickedSource =
              lookups.sourceFieldsById.get(newCrossTableSourceFieldId)!
            setPendingDisambiguation({
              rowId: row.id,
              existingTfmId: row.id,
              targetFieldId: row.targetField.id,
              targetFieldName: row.targetField.name,
              existingSources: row.sources.map((s) => ({
                id: s.id,
                sourceFieldName: s.sourceField.name,
                sourceTableName: s.sourceTable.name,
              })),
              incomingSource: {
                sourceFieldId: pickedSource.id,
                sourceFieldName: pickedSource.name,
                sourceTableName: pickedSource.sourceTable.name,
              },
            })
            return Promise.resolve<MutationResult>({ success: true })
          }
        }
      }
      return run(
        input.tfmId,
        () =>
          editMappingSources({
            tfmId: input.tfmId,
            sourceFieldIds: input.sourceFieldIds,
            combinationType: input.combinationType,
          }),
        'Mapping updated',
      )
    },
    [run, lookups],
  )

  // ── PR Ω.3.x.1 — disambiguation orchestration ──────────────────────
  //
  // Both confirm methods route through the bare `createFieldMapping`
  // wrapper (NOT `createMappingFromUnmapped`) so that:
  //   • `allowCrossTable: true` is forwarded — the server guard's only
  //     authorised bypass.
  //   • `regenerateTrigger: 'create_disambiguated'` distinguishes
  //     popup-confirmed creates from heritage `create_from_unmapped`
  //     entries in the `ai_edit_history` audit trail.
  //   • The auto-approve side effect attached to
  //     `createMappingFromUnmapped` (status flip + coverage clear) is
  //     skipped — the new TFM lands `needs_review` so the user
  //     explicitly approves it before the override_logs writer fires
  //     (per §8 of the investigation).
  //
  // The host always parks `pendingDisambiguation` before the user
  // clicks Create/Replace, so both methods can assume non-null here.

  const openPendingDisambiguation = useCallback(
    (next: PendingSourceDisambiguation) => {
      setPendingDisambiguation(next)
    },
    [],
  )

  const cancelPendingDisambiguation = useCallback(() => {
    setPendingDisambiguation(null)
  }, [])

  const confirmDisambiguatedCreate = useCallback(async (): Promise<MutationResult> => {
    if (!pendingDisambiguation) return { success: false }
    const { rowId, targetFieldId, incomingSource } = pendingDisambiguation
    setIsDisambiguationPending(true)
    markPending(rowId)
    try {
      const result = await createFieldMapping({
        projectId,
        targetFieldId,
        sourceFieldIds: [incomingSource.sourceFieldId],
        combinationType: 'single',
        allowCrossTable: true,
        regenerateTrigger: 'create_disambiguated',
      })
      if (!result.success) {
        pushToast({
          variant: 'error',
          message: result.error ?? 'Could not create mapping. Please retry.',
        })
        return { success: false }
      }
      pushToast({ variant: 'success', message: 'Mapping created' })
      setPendingDisambiguation(null)
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
      setIsDisambiguationPending(false)
      clearPending(rowId)
    }
  }, [pendingDisambiguation, projectId, markPending, clearPending, pushToast, router])

  const confirmDisambiguatedReplace = useCallback(async (): Promise<MutationResult> => {
    if (!pendingDisambiguation) return { success: false }
    const { rowId, existingTfmId, targetFieldId, incomingSource } =
      pendingDisambiguation
    setIsDisambiguationPending(true)
    markPending(rowId)
    try {
      // Step 1: hard-delete the existing TFM. `rejectFieldMapping` is
      // the canonical reject = delete entry point; matches the
      // "Replace existing" semantic locked in the spec.
      const rejectResult = await rejectFieldMapping(existingTfmId)
      if (!rejectResult.success) {
        pushToast({
          variant: 'error',
          message:
            rejectResult.error ?? 'Could not replace mapping. Please retry.',
        })
        return { success: false }
      }
      // Step 2: create the new single-source TFM on the picked source.
      // The existing TFM is gone — server-side collision check is now
      // a no-op for this target field. The new TFM lands with
      // `combinationType: 'single'` and the disambiguated regenerate
      // trigger so the audit trail tags the gesture distinctly.
      const createResult = await createFieldMapping({
        projectId,
        targetFieldId,
        sourceFieldIds: [incomingSource.sourceFieldId],
        combinationType: 'single',
        allowCrossTable: true,
        regenerateTrigger: 'create_disambiguated',
      })
      if (!createResult.success) {
        // The reject already committed. Surface the create error;
        // the row visually becomes unmapped on next refresh.
        pushToast({
          variant: 'error',
          message:
            createResult.error ??
            'Existing mapping was removed but the replacement could not be created.',
        })
        return { success: false }
      }
      pushToast({ variant: 'success', message: 'Mapping replaced' })
      setPendingDisambiguation(null)
      router.refresh()
      return { success: true, tfmId: createResult.tfmId }
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
      setIsDisambiguationPending(false)
      clearPending(rowId)
    }
  }, [pendingDisambiguation, projectId, markPending, clearPending, pushToast, router])

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
    pendingDisambiguation,
    isDisambiguationPending,
    openPendingDisambiguation,
    confirmDisambiguatedCreate,
    confirmDisambiguatedReplace,
    cancelPendingDisambiguation,
  }
}
