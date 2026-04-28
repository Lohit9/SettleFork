'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { GetOrgSsoOverviewResult } from '@/lib/actions/sso-admin'
import { setOrgEnforcementMode } from '@/lib/actions/sso-admin-mutations'
import {
  VALID_ENFORCEMENT_MODES,
  type EnforcementMode,
} from '@/lib/sso/domain-validation'
import {
  EnforcementChangeDialog,
  classifyEnforcementRisk,
} from './EnforcementChangeDialog'

// D.1 — provider type, enforcement mode, status, configured-at.
//
// B-2-c-i shipped this read-only. B-2-c-ii makes the enforcement-mode
// row editable when `canEdit`:
//
//   - Low-risk transitions (optional ↔ hybrid) dispatch IMMEDIATELY
//     on dropdown change with no modal — the change has no end-user
//     impact, so a confirmation step is just friction.
//
//   - Medium- and high-risk transitions (anything involving strict)
//     open EnforcementChangeDialog. The high-risk path runs a
//     preflight count of members without SSO identities so the
//     operator sees the lockout impact before clicking confirm.
//
// Refresh strategy (Mini-D7): on success, router.refresh() so the
// audit-event row appears in "Recent activity" without a full
// reload. No optimistic updates — the action is fast.

interface Props {
  overview: GetOrgSsoOverviewResult
  canEdit: boolean
  orgId: string
}

const ENFORCEMENT_LABEL: Record<string, string> = {
  strict: 'Strict (SSO required)',
  hybrid: 'Hybrid (SSO + password)',
  optional: 'Optional (SSO available)',
}

const ENFORCEMENT_BADGE_CLS: Record<string, string> = {
  strict: 'bg-red-50 text-red-700 border-red-200',
  hybrid: 'bg-blue-50 text-blue-700 border-blue-200',
  optional: 'bg-gray-50 text-gray-700 border-gray-200',
}

const IDP_LABEL: Record<string, string> = {
  okta: 'Okta',
  entra: 'Microsoft Entra ID',
  google: 'Google Workspace',
  generic: 'Generic SAML',
}

function formatConfiguredAt(iso: string | null): string {
  if (!iso) return 'Not configured'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export function SsoOverviewCard({ overview, canEdit, orgId }: Props) {
  if (!overview.ok) {
    return (
      <Card title="Configuration">
        <ErrorRow message={overview.error} />
      </Card>
    )
  }

  return (
    <Card title="Configuration">
      <dl className="divide-y divide-gray-100">
        <Row label="Status">
          {overview.sso_enabled ? (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-green-200 bg-green-50 text-green-700 text-xs font-medium"
              data-testid="sso-status-enabled"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Enabled
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-gray-600 text-xs font-medium"
              data-testid="sso-status-disabled"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
              Disabled
            </span>
          )}
        </Row>

        <Row label="Provider">
          {overview.idp_type ? (
            <span className="text-sm text-gray-900">
              {IDP_LABEL[overview.idp_type] ?? overview.idp_type}
            </span>
          ) : (
            <span className="text-sm text-gray-400">Not set</span>
          )}
        </Row>

        <Row label="Enforcement mode">
          {canEdit ? (
            <EnforcementModeEditor
              orgId={orgId}
              currentMode={overview.enforcement_mode as EnforcementMode}
            />
          ) : (
            <span
              className={
                'inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium ' +
                (ENFORCEMENT_BADGE_CLS[overview.enforcement_mode] ??
                  ENFORCEMENT_BADGE_CLS.optional)
              }
            >
              {ENFORCEMENT_LABEL[overview.enforcement_mode] ??
                overview.enforcement_mode}
            </span>
          )}
        </Row>

        <Row label="Configured">
          <span className="text-sm text-gray-900">
            {formatConfiguredAt(overview.sso_configured_at)}
          </span>
        </Row>
      </dl>
    </Card>
  )
}

// ─── Editable enforcement-mode editor ─────────────────────────────────

interface EnforcementModeEditorProps {
  orgId: string
  currentMode: EnforcementMode
}

function EnforcementModeEditor({ orgId, currentMode }: EnforcementModeEditorProps) {
  const router = useRouter()
  const [pending, setPending] = React.useState<EnforcementMode | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function dispatch(target: EnforcementMode) {
    setError(null)
    setSubmitting(true)
    try {
      const result = await setOrgEnforcementMode(orgId, target)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change mode')
    } finally {
      setSubmitting(false)
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const target = e.target.value as EnforcementMode
    if (target === currentMode) return
    const risk = classifyEnforcementRisk(currentMode, target)
    if (risk === 'low') {
      // No modal — fire-and-refresh.
      void dispatch(target)
      return
    }
    // Open the dialog. Don't dispatch yet; waits for confirm.
    setPending(target)
  }

  async function handleConfirmDialog() {
    if (!pending) return
    setError(null)
    setSubmitting(true)
    try {
      const result = await setOrgEnforcementMode(orgId, pending)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // Success — close the dialog and refresh.
      setPending(null)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change mode')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <select
        value={currentMode}
        disabled={submitting}
        onChange={handleChange}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-900 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-50 disabled:text-gray-500"
        data-testid="enforcement-mode-select"
        aria-label="Enforcement mode"
      >
        {VALID_ENFORCEMENT_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {ENFORCEMENT_LABEL[mode] ?? mode}
          </option>
        ))}
      </select>

      {error && !pending ? (
        <p
          className="text-xs text-red-600"
          role="alert"
          data-testid="enforcement-mode-error"
        >
          {error}
        </p>
      ) : null}

      {pending ? (
        <EnforcementChangeDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) {
              setPending(null)
              setError(null)
            }
          }}
          orgId={orgId}
          fromMode={currentMode}
          toMode={pending}
          onConfirm={handleConfirmDialog}
          errorMessage={error}
        />
      ) : null}
    </div>
  )
}

// ─── Local building blocks ───────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl">
      <div className="px-5 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
      <dt className="text-sm text-gray-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function ErrorRow({ message }: { message: string }) {
  return (
    <p className="text-sm text-red-600" role="alert">
      {message}
    </p>
  )
}
