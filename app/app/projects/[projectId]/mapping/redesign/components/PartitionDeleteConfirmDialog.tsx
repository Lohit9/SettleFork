'use client'

/**
 * PartitionDeleteConfirmDialog — destructive confirmation flow for
 * `deletePartition` (lib/actions/partitions.ts:448-506).
 *
 * Two-state UX driven by the server action's natural two-call shape:
 *
 *   1. SAFE state (stagedRowsBlocking === null)
 *      First-attempt confirmation. Body: destructive copy only.
 *      Footer: Cancel | Delete partition.
 *      Confirm → onConfirm({ force: false }).
 *
 *   2. HAS-STAGED-ROWS state (stagedRowsBlocking > 0)
 *      Surfaced when the server returns errorCode='HAS_STAGED_ROWS'.
 *      Body: SAFE copy + amber warning + required "Also clear N
 *      staged rows" checkbox. Confirm button is disabled until the
 *      checkbox is checked.
 *      Confirm → onConfirm({ force: true }).
 *
 * STATE OWNERSHIP — the parent (MappingContent) owns
 * `stagedRowsBlocking`, `errorMessage`, and `saving`. This component
 * is purely presentational + dispatches callbacks. The "force confirmed"
 * flag is local UI state that resets when the parent transitions out
 * of the has-staged-rows branch.
 *
 * Built on `components/ui/alert-dialog`; mirrors
 * `EnforcementChangeDialog`'s inline-error-banner + disabled-while-in-
 * flight pattern.
 */

import * as React from 'react'
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
import type { PartitionInfo } from '@/lib/types/mappings-for-redesign'

export interface PartitionDeleteConfirmDialogProps {
  open: boolean
  /** Drives both the backdrop click and the Esc key. Parent should set
   *  to false on cancel + on success. */
  onOpenChange: (open: boolean) => void
  /** Partition being deleted — used for display copy (label + source
   *  table name). */
  partition: PartitionInfo
  /** Number of staged_data_rows the server reported on the last
   *  attempt:
   *    - `null`     — not yet attempted or last attempt was safe;
   *                   render SAFE state
   *    - `> 0`      — server returned HAS_STAGED_ROWS; render the
   *                   warning + force-checkbox
   *  Values `<= 0` are treated as `null` for safety (the server only
   *  emits this error code when count > 0). */
  stagedRowsBlocking: number | null
  /** Inline error banner. Set by parent when `deletePartition`
   *  returned an error OTHER than HAS_STAGED_ROWS (e.g.
   *  PERMISSION_DENIED, INTERNAL). Parent clears it when the user
   *  cancels or retries. */
  errorMessage: string | null
  /** Mid-flight gate owned by the parent. Disables both Cancel and
   *  Confirm so a second click cannot race the in-flight request
   *  (mirrors the savingRef pattern from PartitionRulesModal). */
  saving: boolean
  /** Cancel handler. Parent resets stagedRowsBlocking + errorMessage
   *  + closes the dialog. */
  onCancel: () => void
  /** Confirm handler. Parent calls deletePartition with the force
   *  flag passed here, then either closes the dialog (success) or
   *  updates stagedRowsBlocking / errorMessage (failure). */
  onConfirm: (args: { force: boolean }) => void
}

function partitionDisplayLabel(p: PartitionInfo): string {
  if (p.label && p.label.trim().length > 0) return p.label
  if (p.sourceTableName && p.sourceTableName.trim().length > 0) return p.sourceTableName
  return 'this partition'
}

export function PartitionDeleteConfirmDialog({
  open,
  onOpenChange,
  partition,
  stagedRowsBlocking,
  errorMessage,
  saving,
  onCancel,
  onConfirm,
}: PartitionDeleteConfirmDialogProps) {
  const hasStagedRows =
    stagedRowsBlocking !== null && stagedRowsBlocking > 0

  // "I checked the box" is local UI state. Reset when the parent
  // transitions back to the SAFE branch (e.g. the user cancels and
  // re-opens, or the parent reset stagedRowsBlocking).
  const [forceConfirmChecked, setForceConfirmChecked] = React.useState(false)
  React.useEffect(() => {
    if (!hasStagedRows) setForceConfirmChecked(false)
  }, [hasStagedRows])

  const label = partitionDisplayLabel(partition)
  const sourceTable = partition.sourceTableName ?? ''

  const confirmDisabled = saving || (hasStagedRows && !forceConfirmChecked)
  const confirmLabel = saving
    ? 'Deleting…'
    : hasStagedRows
      ? `Delete partition + ${stagedRowsBlocking} row${stagedRowsBlocking === 1 ? '' : 's'}`
      : 'Delete partition'

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Block close while in-flight to avoid losing the action result.
        if (!next && saving) return
        onOpenChange(next)
      }}
    >
      <AlertDialogContent
        data-testid="partition-delete-confirm-dialog"
        data-staged-rows-blocking={stagedRowsBlocking ?? 0}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete partition?</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {`This will delete partition “${label}”${sourceTable ? ` (source: ${sourceTable})` : ''} and all of its target field mappings.\n\nThis cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {hasStagedRows ? (
          <div
            data-testid="partition-delete-confirm-staged-warning"
            className="mx-6 mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          >
            <p>
              This partition has{' '}
              <strong>
                {stagedRowsBlocking} staged row
                {stagedRowsBlocking === 1 ? '' : 's'}
              </strong>{' '}
              that will also be deleted.
            </p>
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="partition-delete-confirm-force-checkbox"
                checked={forceConfirmChecked}
                onChange={(e) => setForceConfirmChecked(e.target.checked)}
                disabled={saving}
                className="mt-0.5"
              />
              <span>
                Also clear {stagedRowsBlocking} staged row
                {stagedRowsBlocking === 1 ? '' : 's'}
              </span>
            </label>
          </div>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            data-testid="partition-delete-confirm-error"
            className="mx-6 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {errorMessage}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={saving}
            onClick={onCancel}
            data-testid="partition-delete-confirm-cancel"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm({ force: hasStagedRows })}
            disabled={confirmDisabled}
            data-testid="partition-delete-confirm-action"
            className={cn(
              'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500/40',
              confirmDisabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
