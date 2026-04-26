'use client'

// ─────────────────────────────────────────────────────────────────────────────
// DiscardChangesDialog — extracted from CreateMappingForm in Phase 4b-1.
// ─────────────────────────────────────────────────────────────────────────────
//
// Shared confirmation dialog used by the create-mapping form (4a-2 / 4a-4b)
// AND the edit-mapping flow (4b-1). Three variants share the same primitive:
//
//   • 'discard'    — pops on Cancel / Esc / X / click-outside when the
//                    create form is dirty. Confirm action button reads
//                    "Discard" with red-destructive styling. Reused for
//                    edit-cancel-while-dirty: founder decision §3 confirms
//                    the create-time copy fits the edit case verbatim
//                    (selected sources for X will be lost).
//
//   • 'replace-ai' — Phase 4a-4b. Pops on `Re-suggest` / pill click when
//                    the user has manual edits on top of an AI-loaded
//                    suggestion. Confirm action button reads "Replace"
//                    with the same red-destructive styling.
//
// `data-testid="create-mapping-form-discard-dialog"` stays stable across
// all three variants (existing 4a-2/4a-4b tests don't break) but a new
// `data-variant` attribute carries the discriminant for new tests.

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

export type DiscardChangesDialogVariant = 'discard' | 'replace-ai'

export interface DiscardChangesDialogProps {
  variant: DiscardChangesDialogVariant
  /** Target field name interpolated into the body copy. */
  targetFieldName: string
  open: boolean
  onKeepEditing: () => void
  onConfirm: () => void
}

/**
 * Render copy by variant. Pure function so tests can target the strings
 * without mounting the component (and so the component itself stays
 * declarative).
 */
function describeVariant(
  variant: DiscardChangesDialogVariant,
  targetFieldName: string,
): {
  title: string
  confirmLabel: string
  description: React.ReactNode
} {
  switch (variant) {
    case 'discard':
      return {
        title: 'Discard changes?',
        confirmLabel: 'Discard',
        description: (
          <>
            Your selected sources for{' '}
            <span className="font-mono text-gray-700">{targetFieldName}</span>{' '}
            will be lost. This cannot be undone.
          </>
        ),
      }
    case 'replace-ai':
      return {
        title: 'Replace with AI suggestion?',
        confirmLabel: 'Replace',
        description: (
          <>
            Your manual edits to{' '}
            <span className="font-mono text-gray-700">{targetFieldName}</span>{' '}
            will be replaced by the new AI suggestion. This cannot be undone.
          </>
        ),
      }
  }
}

export function DiscardChangesDialog({
  variant,
  targetFieldName,
  open,
  onKeepEditing,
  onConfirm,
}: DiscardChangesDialogProps) {
  const { title, confirmLabel, description } = describeVariant(
    variant,
    targetFieldName,
  )
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing()
      }}
    >
      <AlertDialogContent
        data-testid="create-mapping-form-discard-dialog"
        data-variant={variant}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
              onConfirm()
            }}
            data-testid="create-mapping-form-discard-confirm"
            className="bg-red-600 hover:bg-red-700 focus:ring-red-500/40"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
