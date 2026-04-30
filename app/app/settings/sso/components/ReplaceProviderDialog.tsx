'use client'

import { useEffect, useState } from 'react'
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

export interface ReplaceProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgSlug: string

  current: {
    idp_type: string
    entity_id: string
    cert_fingerprint_sha256: string | null
    cert_not_after: string | null
  }

  proposed: {
    idp_type: string
    entity_id: string
    cert_fingerprint_sha256: string
    cert_not_after: string
  }

  onConfirm: () => Promise<void>
  errorMessage?: string | null
}

export function ReplaceProviderDialog(props: ReplaceProviderDialogProps) {
  const [typedSlug, setTypedSlug] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (props.open) {
      setTypedSlug('')
      setConfirming(false)
    }
  }, [props.open])

  const canConfirm =
    typedSlug.trim() === props.orgSlug && !confirming

  function handleRootOpenChange(open: boolean) {
    if (!open && confirming) return
    props.onOpenChange(open)
  }

  async function handleConfirm() {
    if (!typedSlug.trim() || typedSlug.trim() !== props.orgSlug) return
    setConfirming(true)
    try {
      await props.onConfirm()
    } finally {
      setConfirming(false)
    }
  }

  return (
    <AlertDialog open={props.open} onOpenChange={handleRootOpenChange}>
      <AlertDialogContent data-testid="replace-provider-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Replace SSO provider</AlertDialogTitle>
          <AlertDialogDescription>
            The new metadata uses a different IdP entity ID, so we&apos;ll register
            a new authentication backend and switch your organization to it.
            All members will need to re-authenticate via the new provider on
            their next sign-in. Existing SSO sessions remain valid until they
            expire naturally.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="px-6 space-y-3">
          <ComparisonBox label="Current" {...props.current} />
          <ComparisonBox
            label="New"
            idp_type={props.proposed.idp_type}
            entity_id={props.proposed.entity_id}
            cert_fingerprint_sha256={props.proposed.cert_fingerprint_sha256}
            cert_not_after={props.proposed.cert_not_after}
          />
        </div>

        <div className="px-6 py-3 text-sm text-gray-600">
          This change will be recorded in your audit log.
        </div>

        <div className="px-6 pb-2 space-y-2">
          <label className="block text-sm text-gray-700">
            Type your organization slug{' '}
            <code className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-xs">
              {props.orgSlug}
            </code>{' '}
            to confirm:
          </label>
          <input
            type="text"
            value={typedSlug}
            onChange={(e) => setTypedSlug(e.target.value)}
            placeholder={props.orgSlug}
            autoComplete="off"
            spellCheck={false}
            disabled={confirming}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-50"
            data-testid="replace-provider-dialog-slug-input"
          />
        </div>

        {props.errorMessage ? (
          <div
            className="mx-6 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
            data-testid="replace-provider-dialog-error"
          >
            {props.errorMessage}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={confirming}
            onClick={() => props.onOpenChange(false)}
            data-testid="replace-provider-dialog-cancel"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void handleConfirm()
            }}
            disabled={typedSlug.trim() !== props.orgSlug || confirming}
            className="bg-red-600 hover:bg-red-700 text-white focus-visible:ring-red-500/40 disabled:bg-red-300"
            data-testid="replace-provider-dialog-confirm"
            data-can-confirm={
              typedSlug.trim() === props.orgSlug && !confirming
                ? 'true'
                : undefined
            }
          >
            {confirming ? 'Replacing…' : 'Replace provider'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface ComparisonBoxProps {
  label: string
  idp_type: string
  entity_id: string
  cert_fingerprint_sha256: string | null
  cert_not_after: string | null
}

function ComparisonBox(props: ComparisonBoxProps) {
  const fpDisplay = props.cert_fingerprint_sha256
    ? `${props.cert_fingerprint_sha256.slice(0, 16)}…`
    : '—'

  return (
    <div className="border border-gray-200 rounded-md p-3 space-y-1 text-sm">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {props.label}
      </div>
      <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5">
        <span className="text-gray-600">Type</span>
        <span className="text-gray-900">{props.idp_type}</span>
        <span className="text-gray-600">Entity</span>
        <span className="text-gray-900 font-mono text-xs break-all">
          {props.entity_id}
        </span>
        <span className="text-gray-600">Cert</span>
        <span className="text-gray-900 font-mono text-xs">{fpDisplay}</span>
      </div>
    </div>
  )
}
