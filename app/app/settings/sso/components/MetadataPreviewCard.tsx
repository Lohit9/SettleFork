'use client'

import { AlertCircle, AlertTriangle, Calendar, CheckCircle2, Copy } from '@/components/icons'
import { useState } from 'react'
import type { IdPType } from '@/lib/types/organizations'

const IDP_LABEL: Record<IdPType, string> = {
  okta: 'Okta',
  entra: 'Microsoft Entra',
  google: 'Google Workspace',
  generic: 'Generic SAML',
}

export interface MetadataPreviewCardProps {
  idpType: IdPType | null
  entityId: string | null
  certFingerprintSha256: string | null
  certSubject: string | null
  certNotBefore: string | null
  certNotAfter: string | null
  certSignatureAlgorithm: string | null
}

export function MetadataPreviewCard(props: MetadataPreviewCardProps) {
  const expiryTier = computeExpiryTier(props.certNotAfter)

  return (
    <section
      className="bg-white border border-gray-200 rounded-xl"
      data-testid="metadata-preview-card"
    >
      <header className="px-5 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900">Provider details</h2>
      </header>
      <div className="px-5 py-4 space-y-4">
        {expiryTier.severity !== 'ok' && (
          <ExpiryBanner tier={expiryTier} />
        )}

        <dl className="grid grid-cols-1 gap-3 text-sm">
          <DetailRow
            label="Identity provider"
            value={
              props.idpType ? IDP_LABEL[props.idpType] : 'Not set'
            }
          />
          <DetailRow
            label="Entity ID"
            value={props.entityId ?? '—'}
            mono
          />
          {props.certSubject ? (
            <DetailRow label="Certificate subject" value={props.certSubject} mono />
          ) : null}
          {props.certFingerprintSha256 ? (
            <DetailRow
              label="Certificate fingerprint"
              value={props.certFingerprintSha256}
              mono
              copyable
            />
          ) : null}
          <DetailRow
            label="Signature algorithm"
            value={props.certSignatureAlgorithm ?? '—'}
          />
          {props.certNotBefore ? (
            <DetailRow label="Valid from" value={formatDate(props.certNotBefore)} />
          ) : null}
          {props.certNotAfter ? (
            <DetailRow label="Valid until" value={formatDate(props.certNotAfter)} />
          ) : null}
        </dl>
      </div>
    </section>
  )
}

interface DetailRowProps {
  label: string
  value: string | null
  mono?: boolean
  copyable?: boolean
}

function DetailRow({ label, value, mono, copyable }: DetailRowProps) {
  const [copied, setCopied] = useState(false)

  if (value === null || value === '') return null

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const testSlug = label.toLowerCase().replace(/\s+/g, '-')

  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-gray-600 shrink-0 w-44">{label}</dt>
      <dd
        className={`text-gray-900 flex-1 break-all ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
        {copyable ? (
          <button
            type="button"
            onClick={handleCopy}
            className="ml-2 inline-flex items-center text-gray-400 hover:text-gray-600"
            aria-label="Copy to clipboard"
            data-testid={`metadata-preview-copy-${testSlug}`}
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? <span className="ml-1 text-xs text-green-600">Copied</span> : null}
          </button>
        ) : null}
      </dd>
    </div>
  )
}

// ─── Cert expiry tier system (Mini-D17) ───────────────────────────────

type ExpirySeverity = 'expired' | 'critical' | 'warning' | 'notice' | 'ok'

interface ExpiryTier {
  severity: ExpirySeverity
  daysUntil: number
  message: string
}

function computeExpiryTier(notAfter: string | null): ExpiryTier {
  if (!notAfter) {
    return { severity: 'ok', daysUntil: Infinity, message: '' }
  }

  const now = Date.now()
  const expiry = new Date(notAfter).getTime()
  if (Number.isNaN(expiry)) {
    return { severity: 'ok', daysUntil: Infinity, message: '' }
  }

  const daysUntil = Math.floor((expiry - now) / (1000 * 60 * 60 * 24))

  if (daysUntil < 0) {
    const daysAgo = Math.abs(daysUntil)
    return {
      severity: 'expired',
      daysUntil,
      message: `Certificate expired ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago. SSO will fail until rotated.`,
    }
  }
  if (daysUntil <= 7) {
    return {
      severity: 'critical',
      daysUntil,
      message: `Certificate expires in ${daysUntil} day${daysUntil === 1 ? '' : 's'}. Rotate now.`,
    }
  }
  if (daysUntil <= 30) {
    return {
      severity: 'warning',
      daysUntil,
      message: `Certificate expires in ${daysUntil} days. Coordinate rotation with your IdP team.`,
    }
  }
  if (daysUntil <= 90) {
    return {
      severity: 'notice',
      daysUntil,
      message: `Certificate expires in ${daysUntil} days.`,
    }
  }
  return { severity: 'ok', daysUntil, message: '' }
}

function ExpiryBanner({ tier }: { tier: ExpiryTier }) {
  const styles = {
    expired: 'border-red-200 bg-red-50 text-red-700',
    critical: 'border-red-200 bg-red-50 text-red-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    notice: 'border-blue-200 bg-blue-50 text-blue-700',
    ok: '',
  }[tier.severity]

  const Icon = {
    expired: AlertCircle,
    critical: AlertTriangle,
    warning: AlertTriangle,
    notice: Calendar,
    ok: CheckCircle2,
  }[tier.severity]

  return (
    <div
      className={`rounded-md border px-3 py-2.5 text-sm flex items-start gap-2 ${styles}`}
      role={
        tier.severity === 'expired' || tier.severity === 'critical'
          ? 'alert'
          : undefined
      }
      data-testid={`metadata-preview-expiry-${tier.severity}`}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{tier.message}</span>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}
