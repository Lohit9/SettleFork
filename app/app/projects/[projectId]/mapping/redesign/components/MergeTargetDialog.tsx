'use client'

import { useState } from 'react'
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
import type { PendingTargetMerge } from '../hooks/useMappingListMutations'

export interface MergeTargetDialogProps {
  /** The parked merge, or `null` when no merge is pending (dialog closed). */
  pendingMerge: PendingTargetMerge | null
  /** True while the confirmed merge is executing server-side. */
  isPending: boolean
  /** Execute the merge. */
  onConfirm: () => Promise<unknown>
  /** Dismiss without merging. */
  onCancel: () => void
}

/** Render a source-name list as readable prose: "A", "A and B", "A, B and C". */
function formatNames(names: string[]): string {
  const cleaned = names.filter((n) => n && n.trim().length > 0)
  if (cleaned.length === 0) return ''
  if (cleaned.length === 1) return cleaned[0]
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`
  return `${cleaned.slice(0, -1).join(', ')} and ${cleaned[cleaned.length - 1]}`
}

/**
 * Confirmation dialog for a target-field-swap MERGE.
 *
 * The flat-view / drawer target-swap is a MERGE on conflict, never a
 * Replace: when the picked target already carries a mapping, the swap
 * folds the swapping mapping's sources into the existing one. This
 * dialog surfaces exactly what will change and requires an explicit
 * Proceed — the server never merges without `confirmMerge: true`.
 */
export function MergeTargetDialog({
  pendingMerge,
  isPending,
  onConfirm,
  onCancel,
}: MergeTargetDialogProps) {
  // Local guard so a double-click cannot fire two confirms before the
  // parent's `isPending` round-trips through state.
  const [confirming, setConfirming] = useState(false)
  const busy = isPending || confirming

  function handleOpenChange(open: boolean) {
    if (open) return
    if (busy) return
    onCancel()
  }

  async function handleConfirm() {
    if (busy) return
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  const preview = pendingMerge?.preview ?? null
  const existing = preview ? formatNames(preview.existingSourceNames) : ''
  const incoming = preview ? formatNames(preview.incomingSourceNames) : ''

  return (
    <AlertDialog open={pendingMerge !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent data-testid="merge-target-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Merge into the existing mapping?</AlertDialogTitle>
          <AlertDialogDescription>
            {preview ? (
              <>
                <span className="font-medium text-slate-900">{preview.targetFieldName}</span> is
                already mapped
                {existing ? (
                  <>
                    {' '}
                    from <span className="font-medium text-slate-900">{existing}</span>
                  </>
                ) : null}
                .{' '}
                {incoming ? (
                  <>
                    This adds <span className="font-medium text-slate-900">{incoming}</span> as{' '}
                    {preview.incomingSourceNames.length > 1
                      ? 'additional sources'
                      : 'an additional source'}
                    , creating a multi-source mapping.
                  </>
                ) : (
                  <>This moves the mapping onto the existing target.</>
                )}
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="px-6 pb-1 text-sm text-slate-600">
          The merged mapping returns to <strong>Needs review</strong> and its transformation SQL is
          cleared for re-authoring. The original mapping&apos;s old target reverts to unmapped. This
          is a merge, not a replace — to discard the existing mapping instead, reject it first, then
          swap.
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={busy}
            onClick={onCancel}
            data-testid="merge-target-dialog-cancel"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Keep the dialog mounted while the merge runs; close on
              // the parent clearing `pendingMerge` after success.
              e.preventDefault()
              void handleConfirm()
            }}
            disabled={busy}
            data-testid="merge-target-dialog-confirm"
          >
            {busy ? 'Merging…' : 'Merge mappings'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
