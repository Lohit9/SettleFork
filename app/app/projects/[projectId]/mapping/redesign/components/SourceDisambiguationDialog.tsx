'use client'

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/components/ui/utils'

// ─────────────────────────────────────────────────────────────────────────────
// SourceDisambiguationDialog — PR Ω.3.x.1
// ─────────────────────────────────────────────────────────────────────────────
//
// Fires when a manual gesture would add a source field whose source_table
// differs from the target field's existing mapping sources. Same-table
// additions never reach this dialog — the host short-circuits to silent
// combine (`editMappingSources` with `concat_space`). Cross-table additions
// MUST go through the popup so the user expresses intent explicitly; the
// server's `allowCrossTable` guard rejects any path that forgot to.
//
// Four options:
//
//   • Create separate mapping (default, highlighted)
//       → new TFM bound to the picked source's partition (`createFieldMapping`
//         with `combinationType: 'single'`, `allowCrossTable: true`,
//         `regenerateTrigger: 'create_disambiguated'`). The existing TFM is
//         untouched.
//
//   • Combine into one mapping (GREYED, tooltip)
//       → cross-table JOIN inference is not wired (Cycle 1 deliberately
//         removed the precheck and the join_spec write path). Reserved
//         for v2 when source-side FK metadata + a chosen JOIN inference
//         strategy land.
//
//   • Replace existing mapping
//       → hard delete + create. Matches `rejectFieldMapping` semantics
//         (reject == delete). The new TFM lands single-source on the
//         picked source's partition.
//
//   • Cancel
//       → close, no write.
//
// State shape: the host parks a `PendingSourceDisambiguation` slot
// alongside its other dialog pending-state slots (`pendingMerge`,
// `bulkAction`, etc.). The dialog is single-instance, hosted at the
// `MappingContentLoaded` level.
//
// Out of scope in v1 (deferred to v2): partition selector. When a project
// has `partitions_enabled=true` AND the target table has ≥ 2 partitions
// for the chosen (source_table, target_table) pair, the server defaults
// to the canonical partition (`partition_ordinal ASC NULLS LAST,
// created_at ASC, id ASC`). The dialog does not surface this choice in v1.

/**
 * Shape of a single existing source attribution surfaced to the dialog.
 * Mirrors the `MappingRow.sources[]` shape narrowly — only the fields the
 * dialog renders are required, so test fixtures and host wiring can stay
 * minimal.
 */
export interface DisambiguationExistingSource {
  /** `mapping_sources.id`. Only used as a stable React key. */
  id: string
  /** Source field name as shown in the picker. */
  sourceFieldName: string
  /** Source table name for the same-table / cross-table copy. */
  sourceTableName: string
}

/**
 * Shape of the incoming (picked) source surfaced to the dialog. Always a
 * single field — the popup only fires for the "add one source" gesture.
 */
export interface DisambiguationIncomingSource {
  sourceFieldId: string
  sourceFieldName: string
  sourceTableName: string
}

/**
 * The dialog's parked state. Hosts construct it when the cross-table
 * intercept fires; clear it via `onCancel` or after a confirmed action.
 */
export interface PendingSourceDisambiguation {
  /**
   * Mapping row id the user clicked. Used by the host to clear optimistic
   * state on cancel and to follow the row through any identity change on
   * Replace.
   */
  rowId: string
  /** Existing TFM id on the target field. Replace deletes this row. */
  existingTfmId: string
  /** Target field id — passed through to `createFieldMapping`. */
  targetFieldId: string
  /** Target field name — surfaced in the dialog copy. */
  targetFieldName: string
  existingSources: DisambiguationExistingSource[]
  incomingSource: DisambiguationIncomingSource
}

export interface SourceDisambiguationDialogProps {
  /** The parked state, or `null` when no disambiguation is pending. */
  pending: PendingSourceDisambiguation | null
  /** True while a confirmed action is executing server-side. */
  isPending: boolean
  /** Commit "Create separate" — new TFM bound to the picked source. */
  onCreateSeparate: () => Promise<unknown>
  /** Commit "Replace existing" — hard delete + create. */
  onReplace: () => Promise<unknown>
  /** Dismiss without writing. */
  onCancel: () => void
}

/**
 * Format a list of source-field names as readable prose:
 * "A", "A and B", "A, B and C".
 */
function formatSourceList(sources: DisambiguationExistingSource[]): string {
  const names = sources.map((s) => s.sourceFieldName).filter((n) => n.trim().length > 0)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Distinct source-table names present in `sources` (preserves first-seen
 * order). The dialog uses this to surface the existing-table phrasing —
 * e.g. "already mapped from CustomerMaster".
 */
function distinctTableNames(sources: DisambiguationExistingSource[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sources) {
    if (seen.has(s.sourceTableName)) continue
    seen.add(s.sourceTableName)
    out.push(s.sourceTableName)
  }
  return out
}

export function SourceDisambiguationDialog({
  pending,
  isPending,
  onCreateSeparate,
  onReplace,
  onCancel,
}: SourceDisambiguationDialogProps) {
  // Local guard so a double-click cannot dispatch two server actions
  // before the parent's `isPending` round-trips through state.
  const [confirming, setConfirming] = useState<null | 'create' | 'replace'>(
    null,
  )
  const busy = isPending || confirming !== null

  function handleOpenChange(open: boolean) {
    if (open) return
    if (busy) return
    onCancel()
  }

  async function handleCreate() {
    if (busy) return
    setConfirming('create')
    try {
      await onCreateSeparate()
    } finally {
      setConfirming(null)
    }
  }

  async function handleReplace() {
    if (busy) return
    setConfirming('replace')
    try {
      await onReplace()
    } finally {
      setConfirming(null)
    }
  }

  const existing = pending ? formatSourceList(pending.existingSources) : ''
  const existingTables = pending ? distinctTableNames(pending.existingSources) : []
  const incoming = pending?.incomingSource

  return (
    <AlertDialog open={pending !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        className="max-w-lg"
        data-testid="source-disambiguation-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Add a cross-table source?</AlertDialogTitle>
          <AlertDialogDescription>
            {pending ? (
              <>
                <span className="font-medium text-slate-900">
                  {pending.targetFieldName}
                </span>{' '}
                is already mapped
                {existing ? (
                  <>
                    {' '}
                    from{' '}
                    <span className="font-medium text-slate-900">{existing}</span>
                  </>
                ) : null}
                {existingTables.length > 0 ? (
                  <>
                    {' '}
                    (in{' '}
                    <span className="font-medium text-slate-900">
                      {existingTables.join(', ')}
                    </span>
                    )
                  </>
                ) : null}
                . You picked{' '}
                <span className="font-medium text-slate-900">
                  {incoming?.sourceFieldName}
                </span>{' '}
                from{' '}
                <span className="font-medium text-slate-900">
                  {incoming?.sourceTableName}
                </span>
                , which comes from a different source table.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          className="flex flex-col gap-2 px-6 pb-2"
          data-testid="source-disambiguation-options"
        >
          <DialogOption
            testId="source-disambiguation-create-separate"
            label="Create separate mapping"
            description="Keep the existing mapping and add a second mapping on this target field using the new source."
            primary
            disabled={busy}
            isLoading={confirming === 'create'}
            onClick={handleCreate}
          />
          <DialogOption
            testId="source-disambiguation-combine"
            label="Combine into one mapping"
            description="Cross-table JOIN not yet supported."
            disabled
            tooltip="Cross-table JOIN not yet supported"
          />
          <DialogOption
            testId="source-disambiguation-replace"
            label="Replace existing mapping"
            description="Discard the existing mapping and replace it with the new source. This deletes the existing mapping and its transformation."
            disabled={busy}
            isLoading={confirming === 'replace'}
            onClick={handleReplace}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={busy}
            onClick={onCancel}
            data-testid="source-disambiguation-cancel"
          >
            Cancel
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface DialogOptionProps {
  testId: string
  label: string
  description: string
  primary?: boolean
  disabled?: boolean
  isLoading?: boolean
  tooltip?: string
  onClick?: () => void
}

function DialogOption({
  testId,
  label,
  description,
  primary,
  disabled,
  isLoading,
  tooltip,
  onClick,
}: DialogOptionProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className={cn(
        'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors',
        primary
          ? 'border-blue-600 bg-blue-50 hover:bg-blue-100'
          : 'border-slate-200 bg-white hover:bg-slate-50',
        disabled && !isLoading
          ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-50'
          : 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
      )}
    >
      <span
        className={cn(
          'text-sm font-medium',
          primary && !disabled ? 'text-blue-900' : 'text-slate-900',
          disabled && !isLoading ? 'text-slate-400' : undefined,
        )}
      >
        {isLoading ? `${label}…` : label}
      </span>
      <span
        className={cn(
          'text-xs',
          disabled && !isLoading ? 'text-slate-400' : 'text-slate-600',
        )}
      >
        {description}
      </span>
    </button>
  )
}
