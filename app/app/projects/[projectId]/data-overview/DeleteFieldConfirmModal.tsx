'use client'

/**
 * DeleteFieldConfirmModal — Schema-Overview field-deletion confirm with
 * server-driven impact preview and (conditional) typed-confirmation gate.
 *
 * Shape mirrors RemoveTableDialog at app/app/projects/[projectId]/project/
 * RemoveTableDialog.tsx (Radix-style AlertDialog primitive, `confirming`
 * mid-flight state, inline error block, FR-3 wireframe at notes/
 * fr-3-investigation-b-backup.md §6.4-6.5).
 *
 * Type-to-confirm is a UI-only gate: the deleteField action takes only
 * `fieldId`; we never pass `confirmName` to the server. The gate is
 * friction UX, not security — the server already enforces editor role
 * and the SECURITY DEFINER RPC re-asserts permission as defense-in-depth.
 */

import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
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
import { previewFieldDeletion, deleteField } from '@/lib/actions/fields'
import type {
  AppliedCascade,
  DeleteFieldImpact,
  FieldErrorCode,
} from '@/lib/validation/fields'

interface DeleteFieldConfirmModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fieldId: string
  fieldName: string
  /** Called on successful delete with the post-action cascade counts.
   *  Parent uses these for the truthful toast (concurrent edits between
   *  preview and delete are rare but possible). */
  onDeleted: (appliedCascade: AppliedCascade) => void
}

export default function DeleteFieldConfirmModal({
  open,
  onOpenChange,
  fieldId,
  fieldName,
  onDeleted,
}: DeleteFieldConfirmModalProps) {
  const [impact, setImpact] = useState<DeleteFieldImpact | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // INF-79 (preemptive): synchronous mutex against double-fire on rapid
  // double-click. The `confirming` state controls the visual; the ref is
  // the gate that the second click hits before React commits the
  // disabled-attribute update.
  const confirmingRef = useRef(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [typedName, setTypedName] = useState('')

  // ── Load impact when the modal opens ────────────────────────────────────
  // Re-runs on every (open, fieldId) transition. Cancel via the standard
  // `cancelled` flag pattern so a fast close-then-reopen doesn't leak the
  // first response into the second mount.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    setImpact(null)
    setTypedName('')
    setDeleteError(null)
    previewFieldDeletion(fieldId)
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          setPreviewError(messageForErrorCode(result.errorCode, result.error))
        } else {
          setImpact(result.data)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setPreviewError(err instanceof Error ? err.message : 'Failed to load impact')
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, fieldId])

  const requiresTypedConfirm = impact?.requiresTypedConfirmation ?? false
  // Q7 locked: case-sensitive match (Postgres TEXT default).
  const typedNameMatches = typedName === fieldName
  const canDelete =
    !!impact && !confirming && (!requiresTypedConfirm || typedNameMatches)

  async function handleConfirm() {
    if (confirmingRef.current || !canDelete) return
    confirmingRef.current = true
    setDeleteError(null)
    setConfirming(true)
    try {
      const result = await deleteField(fieldId)
      if (!result.success) {
        setDeleteError(messageForErrorCode(result.errorCode, result.error))
        return
      }
      onDeleted(result.data.appliedCascade)
    } finally {
      setConfirming(false)
      confirmingRef.current = false
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Block close while the delete is in flight so the user can't
        // dismiss mid-action (matches RemoveTableDialog).
        if (!next && confirming) return
        onOpenChange(next)
      }}
    >
      <AlertDialogContent data-testid="delete-field-confirm-modal">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-red-600" aria-hidden />
            Delete field &ldquo;{fieldName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {previewLoading ? (
              <span data-testid="delete-field-impact-loading" className="text-gray-500">
                Loading impact…
              </span>
            ) : previewError ? (
              <span className="text-red-600">{previewError}</span>
            ) : impact ? (
              <ImpactSummary impact={impact} />
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Type-to-confirm gate — only when the server flags it. */}
        {impact && requiresTypedConfirm && (
          <div className="mx-6 mb-2">
            <label
              htmlFor="delete-field-typed-confirm"
              className="block text-xs font-medium text-gray-700 mb-1"
            >
              Type the field name to confirm:
            </label>
            <input
              id="delete-field-typed-confirm"
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              disabled={confirming}
              autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Type <span className="font-mono">{fieldName}</span> exactly to enable delete.
            </p>
          </div>
        )}

        {/* Authored-SQL warning — surfaces hand-written transform loss. */}
        {impact?.hasAuthoredTransformSQL && (
          <div
            className="mx-6 mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            role="note"
          >
            ⚠ A hand-authored transform on this field will be lost. This action cannot be undone.
          </div>
        )}

        {deleteError && (
          <div
            className="mx-6 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
            data-testid="delete-field-confirm-modal-error"
          >
            {deleteError}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming} onClick={() => onOpenChange(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!canDelete}
            className="bg-red-600 hover:bg-red-700 text-white focus-visible:ring-red-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="delete-field-confirm-modal-confirm"
          >
            {confirming ? 'Deleting…' : 'Delete field'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── Impact body ─────────────────────────────────────────────────────────────
// Renders the cascade-impact bullets + the "100+" rendering when the staged
// count was capped, plus the empty-impact wording when nothing depends on
// the field.

function ImpactSummary({ impact }: { impact: DeleteFieldImpact }) {
  const { counts } = impact
  const stagedRowsCopy = impact.stagedRowsCapped
    ? `${counts.stagedRows.toLocaleString()}+ staged rows`
    : `${counts.stagedRows.toLocaleString()} staged ${counts.stagedRows === 1 ? 'row' : 'rows'}`

  // Count entities the user actually recognises. acknowledgments + coverage
  // are internal book-keeping; we cascade them but don't surface a line
  // unless they're non-trivial (>0).
  const lines: string[] = []
  if (counts.tfms > 0) lines.push(plural(counts.tfms, 'mapping', 'mappings'))
  if (counts.transformations > 0)
    lines.push(plural(counts.transformations, 'transformation', 'transformations'))
  if (counts.validationRules > 0)
    lines.push(plural(counts.validationRules, 'validation rule', 'validation rules'))
  if (counts.stagedRows > 0) lines.push(stagedRowsCopy)

  if (lines.length === 0) {
    return (
      <span>
        Nothing else depends on this field. <strong>This action cannot be undone.</strong>
      </span>
    )
  }

  return (
    <span className="block">
      <span className="block mb-1">Deleting this field will affect:</span>
      <ul className="list-disc pl-5 space-y-0.5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <span className="block mt-2">
        <strong>This action cannot be undone.</strong>
      </span>
    </span>
  )
}

function plural(n: number, singular: string, pluralWord: string): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralWord}`
}

// ── Error-code → user-facing message ───────────────────────────────────────
// Closed-union switch over FieldErrorCode. `default` is exhaustive-narrowing
// safe and falls back to the raw error string — useful for unforeseen codes
// that get added to the union without a UI update.

function messageForErrorCode(code: FieldErrorCode, raw: string): string {
  switch (code) {
    case 'forbidden':
      return "You don't have permission to delete this field."
    case 'field_not_found':
      return 'This field no longer exists. Refresh the page.'
    case 'maintenance_mode':
      return 'Field deletes are paused for scheduled maintenance. Try again shortly.'
    case 'not_authenticated':
      return "You're signed out. Please refresh and sign in again."
    case 'table_not_found':
      return 'Parent table not found. Refresh the page.'
    case 'name_required':
    case 'name_collision':
    case 'invalid_data_type':
      // Create-side codes — should not surface from preview/delete, but the
      // closed union forces us to handle them. Fall through to raw string.
      return raw || 'Delete failed.'
    case 'db_error':
    default:
      return raw ? `Delete failed: ${raw}` : 'Delete failed.'
  }
}
