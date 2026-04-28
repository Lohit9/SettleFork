'use client'

import * as React from 'react'
import type { SSOAuditEventType } from '@/lib/actions/sso-audit'

// Per-event renderer for the SSO audit log on
// `/app/settings/sso`. Mini-D6 of the B-2-c-i design.
//
// The renderer is a hybrid switch: five common/critical event types
// get hand-crafted, human-readable summaries; the remaining six fall
// back to a flat key-value rendering of `metadata`. Both shapes
// share the same expandable `<details>` wrapper, so admins can click
// any row to see the raw metadata.
//
// Privacy posture
// ---------------
// The schema stores hashed identifiers (`*_hash` keys) for
// pre-authentication failure paths where we don't have a verified
// user. We render those truncated to 8 characters with a "(hashed)"
// label so admins know the value is intentionally opaque, not a bug.
//
// Rendering NULL `actor_user_id` as "Unauthenticated attempt"
// (rather than "Anonymous user") keeps the meaning unambiguous: a
// row with no actor is from a request that failed before identity
// was established (rate limit, unknown org, etc.), not a deliberate
// pseudonymous user.

export interface AuditEvent {
  id: string
  event_type: SSOAuditEventType
  actor_user_id: string | null
  actor_email: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// Translation table for `metadata.reason` on `sso.login.failure` —
// the schema's reason vocabulary is deliberately terse and
// machine-friendly (used as RPC arg in `record_sso_audit_event`).
// This map renders human copy without changing the underlying value.
//
// Sourced from the canonical reason vocabulary documented in
// migration 070 and reused by `lib/actions/sso-audit.ts`.
const REASON_HUMAN: Record<string, string> = {
  cross_tenant: 'wrong organization',
  domain_provider_mismatch: 'domain mismatch',
  duplicate_account: 'duplicate account',
  attempted_org_missing: 'session expired',
  provider_not_resolved: 'provider not resolved',
  jit_failed: 'account creation failed',
  identity_link_failed: 'identity linking failed',
  rate_limited: 'rate limit exceeded',
  unknown_org: 'unknown organization',
  sdk_error: 'provider SDK error',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function actorLabel(event: AuditEvent): string {
  if (event.actor_user_id === null) return 'Unauthenticated attempt'
  // Prefer email; fall back to a short user-id tail when email
  // resolution failed (e.g. user was hard-deleted between event and
  // page render).
  if (event.actor_email) return event.actor_email
  return `User ${event.actor_user_id.slice(0, 8)}…`
}

function truncateHash(value: unknown, label: string): string {
  if (typeof value !== 'string') return ''
  return `${value.slice(0, 8)}… (hashed ${label})`
}

function formatRelativeTime(iso: string): string {
  // Match the file-local `timeAgo` pattern used elsewhere in the
  // codebase (`OrganizationSettingsContent.tsx:48-57`,
  // `MembersContent.tsx:33-42`). Same buckets, same wording.
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  const diffMs = Date.now() - then
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr = Math.floor(diffMs / 3_600_000)
  const diffDay = Math.floor(diffMs / 86_400_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString()
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// ─── Per-event-type summary text ─────────────────────────────────────

function renderSummary(event: AuditEvent): string {
  const actor = actorLabel(event)
  const m = event.metadata

  switch (event.event_type) {
    case 'sso.login.success': {
      const isNew = m.is_new_membership === true
      return `${actor} signed in via SSO${isNew ? ' (new member)' : ''}`
    }
    case 'sso.login.failure': {
      const reasonRaw = asStr(m.reason) ?? 'unknown'
      const human = REASON_HUMAN[reasonRaw] ?? reasonRaw
      return `${actor} sign-in failed: ${human}`
    }
    case 'sso.provider.configured': {
      const idp = asStr(m.idp_type) ?? 'SSO'
      return `${actor} set up ${idp} SSO`
    }
    case 'sso.enforcement.changed': {
      const prev = asStr(m.previous_mode) ?? '?'
      const next = asStr(m.new_mode) ?? '?'
      return `${actor} changed enforcement: ${prev} → ${next}`
    }
    case 'sso.domain.added':
    case 'sso.domain.removed': {
      const verb = event.event_type === 'sso.domain.added' ? 'added' : 'removed'
      const domain = asStr(m.domain) ?? '(unknown)'
      return `${actor} ${verb} domain ${domain}`
    }
    default:
      // Generic fallback for the remaining types
      // (sso.provider.updated, sso.provider.removed,
      // sso.jit.provisioned, sso.identity.linked,
      // sso.identity.unlinked, plus any future additions).
      return `${actor} — ${event.event_type}`
  }
}

// ─── Metadata details (expanded view) ────────────────────────────────

function renderMetadataValue(key: string, value: unknown): string {
  if (key.endsWith('_hash')) {
    return truncateHash(value, key.replace(/_hash$/, ''))
  }
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Array / object — pretty-print compact JSON. break-all CSS handles
  // long lines.
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function renderDetails(event: AuditEvent): React.ReactNode {
  const entries = Object.entries(event.metadata)
  if (entries.length === 0) {
    return (
      <em className="text-gray-500" data-testid="audit-row-no-details">
        No additional details
      </em>
    )
  }

  return (
    <dl
      className="grid gap-x-4 gap-y-1"
      style={{ gridTemplateColumns: 'auto 1fr' }}
      data-testid="audit-row-details"
    >
      {entries.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt className="text-gray-500 font-mono">{key}</dt>
          <dd className="text-gray-900 font-mono break-all">
            {renderMetadataValue(key, value)}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

// ─── Component ───────────────────────────────────────────────────────

export function AuditEventRow({ event }: { event: AuditEvent }) {
  const summary = renderSummary(event)

  return (
    <details
      className="px-5 py-3 hover:bg-gray-50 group"
      data-testid="audit-event-row"
      data-event-type={event.event_type}
    >
      <summary className="cursor-pointer flex items-center justify-between list-none gap-4">
        <span className="text-sm text-gray-900 truncate" data-testid="audit-row-summary">
          {summary}
        </span>
        <span
          className="text-xs text-gray-500 flex-shrink-0"
          title={new Date(event.created_at).toLocaleString()}
        >
          {formatRelativeTime(event.created_at)}
        </span>
      </summary>
      <div className="mt-3 pl-1 text-xs text-gray-600">{renderDetails(event)}</div>
    </details>
  )
}
