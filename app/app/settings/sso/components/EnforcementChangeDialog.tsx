'use client'

// EnforcementChangeDialog — confirmation modal for SSO enforcement
// transitions that need explicit operator acknowledgment.
//
// Risk classifier (Mini-D4 from session 2026-04-28)
// -------------------------------------------------
// 6 transitions × 3 buckets:
//   low    : optional ↔ hybrid           — dispatched by SsoOverviewCard
//                                          WITHOUT mounting this dialog
//   medium : strict → hybrid | optional  — yellow tone, "weakening
//                                          enforcement" copy
//   high   : * → strict (any source)     — red tone, preflight count of
//                                          members without SSO links
//
// This component therefore only handles the medium and high cases —
// SsoOverviewCard's onChange handler decides whether to mount it at
// all. If a low-risk transition somehow reaches this component anyway
// (e.g. a defensive fallback path), it renders as medium.
//
// Why a per-purpose dialog vs reusing BulkConfirmDialog
// -----------------------------------------------------
// BulkConfirmDialog at app/app/projects/.../BulkConfirmDialog.tsx is
// the canonical AlertDialog wrapper for project-mapping bulk
// approve/reject. Its copy + preview shape is bound to mapping
// semantics. Forcing SSO enforcement transitions through that shape
// would couple two unrelated UX surfaces. Instead, we follow the
// Mini-D3 pattern: per-transition wrapper components on top of the
// shared `components/ui/alert-dialog` primitive.

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
import { previewEnforcementChange } from '@/lib/actions/sso-admin-mutations'
import type { EnforcementMode } from '@/lib/sso/domain-validation'

// ─── Types ────────────────────────────────────────────────────────────

type Risk = 'medium' | 'high'

interface PreviewSnapshot {
  total_members: number
  users_without_sso: number
}

export interface EnforcementChangeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  fromMode: EnforcementMode
  toMode: EnforcementMode
  /**
   * Invoked when the operator confirms. The parent is responsible for
   * calling `setOrgEnforcementMode` server-side and refreshing the
   * route. The dialog awaits the promise so it can disable the
   * confirm button while the action is in-flight.
   */
  onConfirm: () => Promise<void>
  /**
   * Inline error banner. Set by the parent when `onConfirm` resolves
   * with an `ok: false` response. The dialog stays open so the
   * operator can read the error and either retry or cancel.
   */
  errorMessage?: string | null
}

// ─── Risk classifier ──────────────────────────────────────────────────
//
// Exported so the parent (SsoOverviewCard) can run the same logic to
// decide whether to mount this dialog vs dispatch immediately. Keeping
// one classifier avoids the parent's "should I open the modal?" and
// the dialog's "what tone do I render?" disagreeing.

export function classifyEnforcementRisk(
  from: EnforcementMode,
  to: EnforcementMode,
): 'low' | 'medium' | 'high' {
  if (from === to) return 'low'
  if (to === 'strict') return 'high'
  if (from === 'strict') return 'medium'
  return 'low'
}

function classifyForDialog(from: EnforcementMode, to: EnforcementMode): Risk {
  // The dialog never renders for low-risk transitions — but if a
  // caller mounts it anyway, fall through to medium so the operator
  // still sees a confirmation rather than no-op.
  const risk = classifyEnforcementRisk(from, to)
  return risk === 'high' ? 'high' : 'medium'
}

// ─── Copy builders ────────────────────────────────────────────────────

function buildTitle(risk: Risk, fromMode: EnforcementMode, toMode: EnforcementMode): string {
  if (risk === 'high') return `Switch enforcement to ${toMode}?`
  return `Weaken enforcement: ${fromMode} → ${toMode}?`
}

function buildHighRiskBody(
  preview: PreviewSnapshot | null,
  loading: boolean,
  error: string | null,
  toMode: EnforcementMode,
): string {
  if (loading) return 'Checking impact on existing members…'
  if (error) {
    return (
      `Preflight check failed: ${error}\n\n` +
      `This change MAY lock out members without SSO identities. Proceed with caution.`
    )
  }
  if (!preview) return 'Unable to preview impact.'

  const { users_without_sso, total_members } = preview

  if (users_without_sso === 0) {
    return (
      `All ${total_members} members are SSO-linked. Switching to ${toMode} ` +
      `enforcement will not lock anyone out. Members will need to sign in via SSO ` +
      `(no password fallback).`
    )
  }

  return (
    `${users_without_sso} of ${total_members} members do not yet have an SSO ` +
    `identity. They will be unable to sign in after this change until an admin ` +
    `re-invites them via the SSO flow.\n\n` +
    `This cannot be undone — switch back to hybrid to restore password sign-in, but ` +
    `already-linked SSO sessions remain unchanged.`
  )
}

function buildMediumRiskBody(_from: EnforcementMode, to: EnforcementMode): string {
  if (to === 'hybrid') {
    return (
      `This relaxes enforcement: members will be able to sign in with passwords ` +
      `again. SSO is still available for users who have already linked an ` +
      `identity.`
    )
  }
  // to === 'optional'
  return (
    `This significantly relaxes enforcement. The SSO option will no longer be ` +
    `promoted on the login page; password sign-in becomes the default. ` +
    `Already-linked SSO sessions remain unchanged.`
  )
}

// ─── Component ────────────────────────────────────────────────────────

export function EnforcementChangeDialog({
  open,
  onOpenChange,
  orgId,
  fromMode,
  toMode,
  onConfirm,
  errorMessage,
}: EnforcementChangeDialogProps) {
  const risk = classifyForDialog(fromMode, toMode)

  const [preview, setPreview] = React.useState<PreviewSnapshot | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)

  // Reset preview state on re-open. Keeps stale impact counts from a
  // previous open from leaking into the new one (e.g. operator
  // toggles strict→hybrid, cancels, then reopens optional→strict —
  // the prior preview was for a different transition).
  React.useEffect(() => {
    if (!open) return
    setPreview(null)
    setPreviewError(null)
    if (risk !== 'high') {
      setPreviewLoading(false)
      return
    }
    let cancelled = false
    setPreviewLoading(true)

    previewEnforcementChange(orgId, toMode)
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setPreview({
            total_members: result.total_members,
            users_without_sso: result.users_without_sso,
          })
        } else {
          setPreviewError(result.error)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPreviewError(err instanceof Error ? err.message : 'Preview failed')
      })
      .finally(() => {
        if (cancelled) return
        setPreviewLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, risk, orgId, toMode])

  const title = buildTitle(risk, fromMode, toMode)
  const body =
    risk === 'high'
      ? buildHighRiskBody(preview, previewLoading, previewError, toMode)
      : buildMediumRiskBody(fromMode, toMode)

  const confirmClass =
    risk === 'high'
      ? 'bg-red-600 hover:bg-red-700 text-white focus-visible:ring-red-500/40'
      : 'bg-amber-600 hover:bg-amber-700 text-white focus-visible:ring-amber-500/40'

  async function handleConfirm() {
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow closing while the action is in-flight; the
        // operator's next click could race with the response.
        if (!next && (confirming || previewLoading)) return
        onOpenChange(next)
      }}
    >
      <AlertDialogContent
        data-testid="enforcement-change-dialog"
        data-risk={risk}
        data-from-mode={fromMode}
        data-to-mode={toMode}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {body}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {errorMessage ? (
          <div
            className="mx-6 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
            data-testid="enforcement-change-dialog-error"
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
            disabled={confirming || previewLoading}
            className={confirmClass}
            data-testid="enforcement-change-dialog-confirm"
          >
            {confirming ? 'Changing…' : `Change to ${toMode}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
