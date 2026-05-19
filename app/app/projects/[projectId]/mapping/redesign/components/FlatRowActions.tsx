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
//   ✓ Approve   green     approve the mapping (TFM-atomic — approving
//                         one row of a multi-source TFM approves all
//                         siblings)
//   ✗ Reject    red       reject the row (per-source: deletes this
//                         attribution; last-source reject cascades the
//                         target to unmapped)
//   ✏ Edit      neutral   opens the drawer with the matching source
//                         highlighted (mapped rows only)
//
// Each handler is optional: when undefined the corresponding button is
// NOT rendered (omitted, not disabled). Tighter visual — empty gutter
// when no action applies, never a greyed-out icon.

export interface FlatRowActionsProps {
  /**
   * Stable row id — surfaces in test ids so individual rows are
   * targetable. Not used for any action logic.
   */
  rowId: string

  /** True when any mutation is in-flight against this row. */
  isBusy: boolean

  /**
   * Approve handler. When undefined the Approve button is not
   * rendered. Tooltip drives the button's `title` attribute.
   */
  onApprove?: () => void
  approveTooltip?: string

  onReject?: () => void
  rejectTooltip?: string

  /**
   * Edit handler — opens the drawer (with matching source highlighted
   * for mapped multi-source rows). Optional; omitted on row kinds
   * where Edit isn't meaningful (e.g. unmapped rows whose primary
   * edit affordance is the cell-level "Pick a source…" / "Pick a
   * target…" button).
   */
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
      {onApprove ? (
        <ActionIconButton
          testId="flat-row-action-approve"
          ariaLabel="Approve mapping"
          tooltip={approveTooltip ?? 'Approve mapping'}
          variant="approve"
          disabled={isBusy}
          onClick={onApprove}
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
        </ActionIconButton>
      ) : null}
      {onReject ? (
        <ActionIconButton
          testId="flat-row-action-reject"
          ariaLabel="Reject mapping"
          tooltip={rejectTooltip ?? 'Reject mapping'}
          variant="reject"
          disabled={isBusy}
          onClick={onReject}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </ActionIconButton>
      ) : null}
      {onEdit ? (
        <ActionIconButton
          testId="flat-row-action-edit"
          ariaLabel="Edit mapping"
          tooltip={editTooltip ?? 'Open mapping in drawer'}
          variant="edit"
          disabled={isBusy}
          onClick={onEdit}
        >
          <Edit3 aria-hidden="true" className="h-3.5 w-3.5" />
        </ActionIconButton>
      ) : null}
    </div>
  )
}

export interface ActionIconButtonProps {
  testId: string
  ariaLabel: string
  tooltip: string
  variant: 'approve' | 'reject' | 'edit'
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}

export function ActionIconButton({
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
