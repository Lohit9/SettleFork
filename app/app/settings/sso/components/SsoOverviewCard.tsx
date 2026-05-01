'use client'

import * as React from 'react'
import type { GetOrgSsoOverviewResult } from '@/lib/actions/sso-admin'

// D.1 — provider type, enforcement mode, status, configured-at.
//
// All values come from `getOrgSsoOverview`. The card renders a fixed
// 4-row key/value list; missing values show a muted "Not set" so the
// shape stays stable regardless of whether SSO is fully configured.

interface Props {
  overview: GetOrgSsoOverviewResult
}

const ENFORCEMENT_LABEL: Record<string, string> = {
  strict: 'Strict (SSO required)',
  hybrid: 'Hybrid (SSO + password)',
  optional: 'Optional (SSO available)',
}

const ENFORCEMENT_BADGE_CLS: Record<string, string> = {
  // Strict = highest signal that this is a security-sensitive
  // setting; red mirrors the sign-out CTA's color language. Hybrid
  // and optional are progressively softer.
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

export function SsoOverviewCard({ overview }: Props) {
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
            <span className="text-sm text-gray-900">{IDP_LABEL[overview.idp_type] ?? overview.idp_type}</span>
          ) : (
            <span className="text-sm text-gray-400">Not set</span>
          )}
        </Row>

        <Row label="Enforcement mode">
          <span
            className={
              'inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium ' +
              (ENFORCEMENT_BADGE_CLS[overview.enforcement_mode] ?? ENFORCEMENT_BADGE_CLS.optional)
            }
          >
            {ENFORCEMENT_LABEL[overview.enforcement_mode] ?? overview.enforcement_mode}
          </span>
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
