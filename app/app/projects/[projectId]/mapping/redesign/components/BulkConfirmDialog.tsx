'use client'

// ─────────────────────────────────────────────────────────────────────────────
// BulkConfirmDialog — Phase 4c-1.
// ─────────────────────────────────────────────────────────────────────────────
//
// Shared confirmation primitive for bulk operations on the redesigned
// Mapping page. v1 ships approve only (per-target-table + project-wide
// high-confidence). The `mode` prop is parameterised for `'approve' |
// 'reject'` ahead of 4c-2 so the reject wiring lands without re-shaping
// this component — only adding a code path for destructive copy + a red
// confirm button.
//
// Locked decisions exercised here:
//   §3.2 Preview list = first 5 + "and N more". Deterministic order
//        from the server preview helper.
//   §5.2 Body copy includes the standard "This cannot be undone" line
//        for irreversibility regardless of mode (approve-then-reject
//        is also a destructive action sequence in the redesign).
//   §5.1 No type-to-confirm.
//   §3.4 Partial failure surfaces as an inline error banner (toast +
//        activity log are emitted by the parent wrapper).
//   §6.1 Title + count copy distinguishes scope (table vs. project)
//        but not user-filter-state — bulk wrappers ignore live
//        filters by contract.
//
// Distinct from `EditInvalidationDialog` (different copy, different
// confirm semantics). Both share the `AlertDialog` primitive.

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

export interface BulkPreviewRow {
  /** TFM uuid — used as a stable React key only. Not surfaced in copy. */
  tfmId: string
  /** Target field name, e.g. `last_name`. */
  targetField: string
  /**
   * Primary contributing source field name (ordinal=0). Null for
   * value-assignment / acknowledgment rows. The dialog renders an
   * em-dash placeholder in the absence of a primary source.
   */
  primarySource: string | null
  /**
   * Phase 4c-2 — true when this TFM owns a `transformations` row that
   * the bulk reject wrapper will reset before deletion. Surfaced as a
   * small "transform" indicator in the preview list so users see which
   * rows trigger transform-reset side effects. Only meaningful when
   * `mode === 'reject'`; ignored on approve. Optional (undefined for
   * preview rows that haven't been hydrated by the reject preview
   * helper, e.g. high-confidence approve which derives client-side).
   */
  hasTransform?: boolean
}

export interface BulkConfirmDialogProps {
  /**
   * Whether the dialog is mounted. When false, the component returns
   * `null` (the AlertDialog primitive itself unmounts on `open=false`).
   */
  open: boolean
  /**
   * Action mode. v1 only ships `'approve'`. `'reject'` is wired but
   * not surfaced from any caller in 4c-1; the parameterisation lands
   * now so 4c-2 only adds the click sites, not the dialog primitive.
   */
  mode: 'approve' | 'reject'
  /**
   * Scope discriminator. Drives the title + body copy. `'table'` is
   * the per-target-table kebab-menu path; `'high_confidence'` is the
   * project-wide FilterRow button path.
   */
  scope: 'table' | 'high_confidence'
  /**
   * Display name for the in-scope target table when `scope === 'table'`.
   * Surfaced verbatim in the dialog title — e.g. `"Approve all on customers"`.
   * Ignored when `scope === 'high_confidence'`.
   */
  targetTableName?: string
  /**
   * Threshold value (percent, 0-100) when `scope === 'high_confidence'`.
   * Surfaced in the title — e.g. `"Approve high-confidence (≥85%)"`.
   * Ignored when `scope === 'table'`.
   */
  threshold?: number
  /**
   * Authoritative count of TFMs that will be acted on. When `null`, the
   * dialog shows an inline loading state for the count (preview is in
   * flight). Mirrors the server preview's count exactly.
   */
  count: number | null
  /**
   * Server preview list, capped at 5 entries (the wrapper enforces the
   * cap; the dialog does NOT slice further). Empty array while preview
   * is loading or when count = 0.
   */
  preview: BulkPreviewRow[]
  /**
   * True while the underlying bulk wrapper is in flight. Both buttons
   * are disabled and the action button shows a spinner.
   */
  isSubmitting: boolean
  /**
   * Inline error message from the bulk wrapper. Rendered as a red
   * banner above the footer. `null` clears the banner.
   */
  errorMessage: string | null
  /** [Cancel] / Esc / click-outside handler. */
  onCancel: () => void
  /** [Action] click handler — fires the bulk wrapper. */
  onConfirm: () => void
}

// ─── Copy helpers ─────────────────────────────────────────────────────────────

function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

function buildTitle(props: BulkConfirmDialogProps): string {
  const { mode, scope, targetTableName, threshold } = props
  const verb = mode === 'approve' ? 'Approve' : 'Reject'
  if (scope === 'table') {
    return `${verb} all needs-review on ${targetTableName ?? '?'}`
  }
  // high_confidence — only meaningful for approve in v1; reject path
  // surfaced for future expansion.
  return `${verb} high-confidence mappings (\u2265${threshold ?? 85}%)`
}

function buildLeadCopy(props: BulkConfirmDialogProps): string {
  const { mode, scope, count } = props
  const n = count ?? 0
  const verb = mode === 'approve' ? 'approve' : 'reject'
  const noun = pluralise(n, 'mapping')
  if (scope === 'table') {
    return `You're about to ${verb} ${n} needs-review ${noun}.`
  }
  return `You're about to ${verb} ${n} high-confidence ${noun}.`
}

// §5.2 — irreversibility / consequence copy. Approve gets the generic
// "This cannot be undone" line; reject gets the explicit
// "deleted permanently … will appear as unmapped (Rule 6)" copy from
// the locked Phase 4c investigation §5.2 decision so users understand
// the destructive contract before confirming.
function buildConsequenceCopy(props: BulkConfirmDialogProps): string {
  if (props.mode === 'reject') {
    return 'Each rejected mapping is deleted permanently. The target fields will appear as unmapped (Rule 6). This cannot be undone.'
  }
  return 'This cannot be undone.'
}

function buildActionLabel(props: BulkConfirmDialogProps): string {
  const { mode, count, isSubmitting } = props
  const n = count ?? 0
  const verb = mode === 'approve' ? 'Approve' : 'Reject'
  if (isSubmitting) {
    return mode === 'approve' ? 'Approving…' : 'Rejecting…'
  }
  // §3 dialog copy uses the count verbatim — "Approve 7 mappings".
  return `${verb} ${n} ${pluralise(n, 'mapping')}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BulkConfirmDialog(props: BulkConfirmDialogProps) {
  const {
    open,
    mode,
    count,
    preview,
    isSubmitting,
    errorMessage,
    onCancel,
    onConfirm,
  } = props

  const title = buildTitle(props)
  const lead = buildLeadCopy(props)
  const actionLabel = buildActionLabel(props)
  // §5.2 — consequence / irreversibility line. Approve gets the
  // generic note; reject gets explicit "deleted permanently … Rule 6"
  // copy from the locked Phase 4c investigation §5.2 decision.
  const undoLine = buildConsequenceCopy(props)

  // The "and N more" clause renders only when count > preview.length.
  // Defensive: count can be null while the preview is loading.
  const remaining =
    count !== null && count > preview.length ? count - preview.length : 0

  // Action button color — destructive red for reject, default
  // (gray-900) for approve. Applied via className override on
  // AlertDialogAction.
  const confirmClassName =
    mode === 'reject'
      ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500/40'
      : ''

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isSubmitting) onCancel()
      }}
    >
      <AlertDialogContent
        data-testid="bulk-confirm-dialog"
        data-mode={mode}
        data-scope={props.scope}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">{lead}</span>
            <span className="mt-1 block text-xs text-gray-500">{undoLine}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* ── Preview list ────────────────────────────────────────── */}
        <div className="px-6 pb-2">
          {count === null ? (
            <div
              className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500"
              data-testid="bulk-confirm-dialog-loading"
            >
              Loading preview…
            </div>
          ) : count === 0 ? (
            <div
              className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500"
              data-testid="bulk-confirm-dialog-empty"
            >
              No mappings match the bulk-action scope.
            </div>
          ) : (
            <ul
              className="space-y-1 text-xs"
              data-testid="bulk-confirm-dialog-preview"
            >
              {preview.map((row) => (
                <li
                  key={row.tfmId}
                  className="flex items-center gap-2 text-gray-700"
                  data-testid="bulk-confirm-dialog-preview-row"
                  data-has-transform={
                    mode === 'reject' && row.hasTransform ? 'true' : undefined
                  }
                >
                  <span className="font-mono text-gray-900">
                    {row.targetField}
                  </span>
                  <span aria-hidden="true" className="text-gray-300">
                    {'\u2190'}
                  </span>
                  <span className="font-mono text-gray-500">
                    {row.primarySource ?? '\u2014'}
                  </span>
                  {/* Phase 4c-2 — transform-reset indicator. Only
                      surfaces in reject mode (approve doesn't reset
                      transforms). The badge is intentionally subdued
                      so it doesn't compete with the field names. */}
                  {mode === 'reject' && row.hasTransform ? (
                    <span
                      className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
                      data-testid="bulk-confirm-dialog-preview-row-transform"
                      title="Transformation will be reset"
                    >
                      transform
                    </span>
                  ) : null}
                </li>
              ))}
              {remaining > 0 ? (
                <li
                  className="text-gray-500"
                  data-testid="bulk-confirm-dialog-more"
                >
                  and {remaining} more…
                </li>
              ) : null}
            </ul>
          )}
        </div>

        {/* ── Error banner (partial failure / wrapper-level error) ── */}
        {errorMessage ? (
          <div
            role="alert"
            className="mx-6 mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            data-testid="bulk-confirm-dialog-error"
          >
            {errorMessage}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="bulk-confirm-dialog-cancel"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              onConfirm()
            }}
            data-testid="bulk-confirm-dialog-confirm"
            disabled={isSubmitting || count === 0 || count === null}
            className={confirmClassName}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
