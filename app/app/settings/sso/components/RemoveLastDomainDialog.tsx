'use client'

// RemoveLastDomainDialog — heavy modal warning when the operator is
// about to remove the final SSO domain from their org.
//
// Mini-D6 (warn-not-block on last-domain removal)
// -----------------------------------------------
// We do NOT block the deletion. The operator may have a legitimate
// reason (decommissioning SSO, switching providers, testing). The
// modal's job is to make the consequences explicit so the click is
// informed.
//
// Copy varies by current enforcement mode because the consequences
// differ:
//   - strict   : login auto-discovery breaks AND members will be
//                forced down a direct-link path (no password fallback,
//                no email-based routing). High-friction "are you sure?"
//   - hybrid   : login auto-discovery breaks, but members can still
//                sign in with passwords. Lower friction.
//   - optional : same as hybrid for practical purposes; we use the
//                hybrid copy.
//
// The action is destructive (red confirm button) regardless of mode.

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
import type { EnforcementMode } from '@/lib/sso/domain-validation'

export interface RemoveLastDomainDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  domain: string
  enforcementMode: EnforcementMode
  /**
   * Invoked on confirm. The parent calls `removeOrgSsoDomain` and
   * router.refresh()es. This dialog only awaits the promise so the
   * confirm button can be disabled mid-flight.
   */
  onConfirm: () => Promise<void>
  errorMessage?: string | null
}

interface CopyBundle {
  title: string
  body: string
}

function buildCopy(domain: string, enforcementMode: EnforcementMode): CopyBundle {
  if (enforcementMode === 'strict') {
    return {
      title: `Remove last SSO domain (strict enforcement)`,
      body:
        `${domain} is the last SSO domain on your organization, and strict ` +
        `enforcement is on. After this change:\n\n` +
        `• The login page will not auto-discover SSO from email addresses\n` +
        `• SSO will still be required (no password fallback)\n` +
        `• Members will need a direct SSO link (/sso/start?org=<slug>) to sign in\n\n` +
        `Consider switching enforcement to hybrid first if you intend to allow ` +
        `password sign-in.`,
    }
  }
  return {
    title: `Remove last SSO domain`,
    body:
      `${domain} is the last SSO domain on your organization. Removing it will ` +
      `prevent members from being routed to SSO based on their email address. ` +
      `Members can still sign in using a direct SSO link, but most users will ` +
      `not have one.`,
  }
}

export function RemoveLastDomainDialog({
  open,
  onOpenChange,
  domain,
  enforcementMode,
  onConfirm,
  errorMessage,
}: RemoveLastDomainDialogProps) {
  const [confirming, setConfirming] = React.useState(false)
  const { title, body } = buildCopy(domain, enforcementMode)

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
        if (!next && confirming) return
        onOpenChange(next)
      }}
    >
      <AlertDialogContent
        data-testid="remove-last-domain-dialog"
        data-enforcement-mode={enforcementMode}
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
            data-testid="remove-last-domain-dialog-error"
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
            data-testid="remove-last-domain-dialog-confirm"
          >
            {confirming ? 'Removing…' : 'Remove domain'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
