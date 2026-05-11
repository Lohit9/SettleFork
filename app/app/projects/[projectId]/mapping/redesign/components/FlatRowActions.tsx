'use client'

import { Check, X } from 'lucide-react'
import { cn } from '@/components/ui/utils'

// ─────────────────────────────────────────────────────────────────────────────
// FlatRowActions — per-row action buttons for the Mapping list view.
// ─────────────────────────────────────────────────────────────────────────────
//
// Two actions, always visible (NOT hover-revealed — divergence from
// the target-led FieldMappingRow per founder review, justified by the
// Big-4 audit workflow expecting visible affordances):
//
//   ✓ Approve   green   approve a mapping (TFM-level for mapped rows;
//                       not rendered for already-approved or rows that
//                       are not approvable)
//   ✗ Reject    red     reject the row (delete a source attribution,
//                       reject the whole TFM, or flag an unmapped row)
//
// Edit (✏) was dropped at the second polish pass — every edit flow has
// a direct cell-click affordance (source/target cells open inline
// pickers; row body click opens the drawer). The Edit button was
// redundant chrome.
//
// Each handler is optional: when undefined the corresponding button is
// NOT rendered (the prior "render-disabled" pattern was traded for
// a tighter visual that matches the founder's reference shot — empty
// gutter when no action is applicable, never a greyed-out icon).

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
}

export function FlatRowActions({
  rowId,
  isBusy,
  onApprove,
  approveTooltip,
  onReject,
  rejectTooltip,
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
    </div>
  )
}

interface ActionIconButtonProps {
  testId: string
  ariaLabel: string
  tooltip: string
  variant: 'approve' | 'reject'
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
      )}
    >
      {children}
    </button>
  )
}
