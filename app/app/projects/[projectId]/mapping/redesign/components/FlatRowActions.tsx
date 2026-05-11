'use client'

import { Check, Edit3, X } from 'lucide-react'
import { cn } from '@/components/ui/utils'

// ─────────────────────────────────────────────────────────────────────────────
// FlatRowActions — per-row action buttons for the Mapping list view.
// ─────────────────────────────────────────────────────────────────────────────
//
// Three actions, always visible (NOT hover-revealed — divergence from
// the target-led FieldMappingRow per founder review, justified by the
// Big-4 audit workflow expecting visible affordances):
//
//   ✓ Approve   green   approve a mapping (TFM-level for mapped rows;
//                       disabled for unmapped/already-approved)
//   ✗ Reject    red     reject the row (delete a source attribution,
//                       reject the whole TFM, or flag an unmapped row)
//   ✏ Edit     neutral  context-sensitive — for mapped rows opens the
//                       drawer; for unmapped rows opens the cell picker
//                       for the missing axis
//
// Each handler is optional: when undefined the button renders disabled
// with a tooltip explaining why (passed via `*Tooltip` props). The
// parent (MappingListView) decides per-row-kind which actions are
// available and which are no-ops.
//
// Visual lineage: the icon + size matches the target-led's
// `ActionIconButton` (FieldMappingRow.tsx). We do NOT reuse that
// component directly because (a) it lives inside FieldMappingRow.tsx
// rather than in components/ui/, (b) it has the hover-reveal coupling
// that doesn't match the flat view's always-visible UX, and (c)
// adding an `Edit` variant + extracting the shared button is more
// scope than this PR earns. Two clear local implementations beats one
// over-coupled shared one.

export interface FlatRowActionsProps {
  /**
   * Stable row id — surfaces in test ids so individual rows are
   * targetable. Not used for any action logic.
   */
  rowId: string

  /** True when any mutation is in-flight against this row. */
  isBusy: boolean

  /**
   * Optional handler for Approve. When undefined the button renders
   * disabled. The tooltip prop documents the disabled reason.
   */
  onApprove?: () => void
  approveTooltip?: string

  onReject?: () => void
  rejectTooltip?: string

  onEdit?: () => void
  editTooltip?: string
}

export function FlatRowActions({
  rowId,
  isBusy,
  onApprove,
  approveTooltip,
  onReject,
  rejectTooltip,
  onEdit,
  editTooltip,
}: FlatRowActionsProps) {
  return (
    <div
      data-testid="flat-row-actions"
      data-row-id={rowId}
      className="flex items-center justify-end gap-1"
    >
      <ActionIconButton
        testId="flat-row-action-approve"
        ariaLabel="Approve mapping"
        tooltip={approveTooltip ?? 'Approve mapping'}
        variant="approve"
        disabled={!onApprove || isBusy}
        onClick={onApprove}
      >
        <Check aria-hidden="true" className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        testId="flat-row-action-reject"
        ariaLabel="Reject mapping"
        tooltip={rejectTooltip ?? 'Reject mapping'}
        variant="reject"
        disabled={!onReject || isBusy}
        onClick={onReject}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </ActionIconButton>
      <ActionIconButton
        testId="flat-row-action-edit"
        ariaLabel="Edit mapping"
        tooltip={editTooltip ?? 'Edit mapping'}
        variant="edit"
        disabled={!onEdit || isBusy}
        onClick={onEdit}
      >
        <Edit3 aria-hidden="true" className="h-3.5 w-3.5" />
      </ActionIconButton>
    </div>
  )
}

interface ActionIconButtonProps {
  testId: string
  ariaLabel: string
  tooltip: string
  variant: 'approve' | 'reject' | 'edit'
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}

function ActionIconButton({
  testId,
  ariaLabel,
  tooltip,
  variant,
  disabled = false,
  onClick,
  children,
}: ActionIconButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-variant={variant}
      aria-label={ariaLabel}
      title={tooltip}
      onClick={(e) => {
        // Cell + button click both bubble to the row's onClick handler
        // (drawer open). Stop propagation so the action button doesn't
        // double-fire its parent's body-click navigation.
        e.stopPropagation()
        onClick?.()
      }}
      disabled={disabled}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded text-slate-500',
        'transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-500',
        variant === 'approve' && 'hover:bg-green-100 hover:text-green-700',
        variant === 'reject' && 'hover:bg-red-100 hover:text-red-700',
        variant === 'edit' && 'hover:bg-slate-100 hover:text-slate-700',
      )}
    >
      {children}
    </button>
  )
}
