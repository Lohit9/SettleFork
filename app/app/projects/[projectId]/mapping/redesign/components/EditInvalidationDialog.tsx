'use client'

// ─────────────────────────────────────────────────────────────────────────────
// EditInvalidationDialog — Phase 4b-1.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pops between the user's [Save changes] click and the actual
// `editMappingSources` call when the drawer's preview detected that
// (a) a transformation row exists for this TFM AND (b) at least one
// staged_data_row carries a value for this target field key. Saving in
// that state will run `resetFieldTransform` server-side — deleting the
// transform row and stripping the field's value from staged data — so
// the user must explicitly confirm.
//
// Copy follows founder decision §2.1 — exact row count surfaced when
// the preview is uncapped (≤ 100), qualitative "Staged data" wording
// otherwise. The cap lives in `lib/actions/mappings-for-redesign.ts`
// (PREVIEW_INVALIDATION_COUNT_CAP) so this component only needs the
// already-resolved `(stagedRowCount, capped)` pair from the preview
// result.
//
// Distinct from `DiscardChangesDialog` (which gates Cancel-while-dirty)
// because the copy and the destructive consequence are different —
// editing sources mid-save runs a server-side cascade, not a
// client-side state revert. Sharing a primitive would force one of
// them to read awkwardly. Both still wrap the same `AlertDialog`
// component.

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

export interface EditInvalidationPreview {
  hasTransform: boolean
  stagedRowCount: number
  capped: boolean
}

export interface EditInvalidationDialogProps {
  /**
   * The preview payload that triggered this dialog. `null` keeps the
   * dialog closed (the parent unmounts it via this prop rather than
   * gating on `open` directly so the close-animation stays consistent
   * with `AlertDialog` semantics).
   */
  preview: EditInvalidationPreview | null
  /** Target field name interpolated into the body copy. */
  targetFieldName: string
  /**
   * True while the actual save is in flight after the user confirmed
   * the dialog. The Save button shows a spinner; both buttons are
   * disabled to prevent double-fire while `editMappingSources` runs.
   */
  isSaving: boolean
  /** [Save and reset transform] click handler. */
  onConfirm: () => void
  /** [Cancel] / Esc / click-outside handler. Keeps the user in edit mode. */
  onCancel: () => void
}

/**
 * Render the row-count phrase for the dialog body. Mirrors §2.1 —
 * exact count when uncapped, "Staged data" qualitative otherwise. The
 * single-row case ("1 staged row") is grammatically distinct.
 */
function describeStagedRows(stagedRowCount: number, capped: boolean): string {
  if (capped) return 'Staged data will be invalidated.'
  if (stagedRowCount === 1) return '1 staged row will be invalidated.'
  return `${stagedRowCount} staged rows will be invalidated.`
}

export function EditInvalidationDialog({
  preview,
  targetFieldName,
  isSaving,
  onConfirm,
  onCancel,
}: EditInvalidationDialogProps) {
  const open = preview !== null && preview.hasTransform
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isSaving) onCancel()
      }}
    >
      <AlertDialogContent
        data-testid="mapping-drawer-edit-invalidation-dialog"
        data-capped={preview?.capped ? 'true' : 'false'}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Reset transform for this field?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">
              Editing sources will reset the transform for{' '}
              <span className="font-mono text-gray-700">{targetFieldName}</span>
              . You&apos;ll need to re-author the transform SQL after saving
              (the current SQL references fields you may have removed).
            </span>
            <span
              className="mt-2 block"
              data-testid="mapping-drawer-edit-invalidation-count"
            >
              {preview
                ? describeStagedRows(preview.stagedRowCount, preview.capped)
                : null}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="mapping-drawer-edit-invalidation-cancel"
            onClick={onCancel}
            disabled={isSaving}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
            data-testid="mapping-drawer-edit-invalidation-confirm"
            disabled={isSaving}
            className="bg-red-600 hover:bg-red-700 focus:ring-red-500/40"
          >
            {isSaving ? 'Saving…' : 'Save and reset transform'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
