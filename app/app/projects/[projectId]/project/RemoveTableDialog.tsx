'use client'

/**
 * Confirmation dialog for the "Remove table" affordance in Project Setup.
 *
 * Mirrors `app/app/settings/sso/components/RemoveLastDomainDialog.tsx` shape:
 * Radix AlertDialog from `components/ui/alert-dialog`, `confirming` state to
 * disable both buttons mid-flight, inline error block when `errorMessage` is
 * set so the user can retry without losing context.
 *
 * Cascade-preview copy is "vague-but-honest" per Stop 2 Decision 1: shows
 * the table's row + field counts (already loaded client-side from
 * DatasetWithTableStats), then a sentence covering downstream cleanup
 * without enumerating exact dependent counts. Adding precise counts would
 * require a `count_table_dependencies` RPC that's not in v1 scope (see
 * INF-32).
 */

import * as React from 'react'
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

export interface RemoveTableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tableName: string
  rowCount: number
  fieldCount: number
  /**
   * Invoked on confirm. Parent calls `removeTable(tableId)` and is
   * responsible for closing the dialog on success or surfacing
   * `errorMessage` on failure.
   */
  onConfirm: () => Promise<void>
  errorMessage?: string | null
}

export function RemoveTableDialog({
  open,
  onOpenChange,
  tableName,
  rowCount,
  fieldCount,
  onConfirm,
  errorMessage,
}: RemoveTableDialogProps) {
  const [confirming, setConfirming] = React.useState(false)

  async function handleConfirm() {
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  const description =
    `This will delete the table "${tableName}" (${rowCount.toLocaleString()} rows, ${fieldCount.toLocaleString()} fields). ` +
    `Any mappings, transformations, and validation rules on these fields will also be removed.\n\n` +
    `This action cannot be undone.`

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Block close while the server roundtrip is in flight so the user
        // can't dismiss mid-delete.
        if (!next && confirming) return
        onOpenChange(next)
      }}
    >
      <AlertDialogContent data-testid="remove-table-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-red-600" aria-hidden />
            Delete table &ldquo;{tableName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {errorMessage ? (
          <div
            className="mx-6 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
            data-testid="remove-table-dialog-error"
          >
            {errorMessage}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={confirming}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={confirming}
            className="bg-red-600 hover:bg-red-700 text-white focus-visible:ring-red-500/40"
            data-testid="remove-table-dialog-confirm"
          >
            {confirming ? 'Deleting…' : 'Delete table'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
