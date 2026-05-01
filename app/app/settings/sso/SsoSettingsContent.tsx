'use client'

import * as React from 'react'
import type {
  GetOrgSsoOverviewResult,
  ListOrgSsoDomainsResult,
  ListOrgSsoLinkedUsersResult,
  ListOrgSsoAuditEventsResult,
} from '@/lib/actions/sso-admin'
import { SsoOverviewCard } from './components/SsoOverviewCard'
import { DomainsList } from './components/DomainsList'
import { LinkedUsersList } from './components/LinkedUsersList'
import { AuditEventsList } from './components/AuditEventsList'
import { SsoEmptyState } from './components/SsoEmptyState'

// Client orchestrator for the org-admin SSO settings page (B-2-c-i).
//
// Receives all four pre-fetched payloads from the parent RSC and
// chooses between two top-level layouts:
//
//   1. The org has `sso_enabled = true` → render the four sections
//      stacked vertically.
//   2. The overview action returned `ok: true` AND
//      `sso_enabled = false` → render the empty state CTA instead.
//      (We don't render the four "no data" sections; that would just
//      be visual noise.)
//
// If the OVERVIEW action itself failed (ok: false), we still render
// the four sections so the user can see whatever did succeed plus
// individual error rows on whichever sections failed. That fail-soft
// posture matches B-2-b's general principle: surface partial data
// rather than blanking the page on a single transient error.

interface Props {
  orgId: string
  overview: GetOrgSsoOverviewResult
  domains: ListOrgSsoDomainsResult
  linkedUsers: ListOrgSsoLinkedUsersResult
  auditEvents: ListOrgSsoAuditEventsResult
  /**
   * True when the calling user is an org owner or admin and may
   * mutate SSO state. False (default) renders the page in
   * read-only mode — no add-domain form, no remove buttons, no
   * editable enforcement dropdown. Defaults to false so the page
   * is read-only-by-default if a parent ever forgets to wire the
   * prop (defense in depth — the actions also enforce this gate
   * server-side).
   */
  canEdit?: boolean
}

export function SsoSettingsContent({
  orgId,
  overview,
  domains,
  linkedUsers,
  auditEvents,
  canEdit = false,
}: Props) {
  // Empty-state branch — only when we definitively know SSO is OFF.
  if (overview.ok && !overview.sso_enabled) {
    return <SsoEmptyState />
  }

  // Pluck the current enforcement mode (when overview succeeded) so
  // children that need it for confirmation copy don't have to
  // reach into the discriminated union themselves.
  const enforcementMode =
    overview.ok ? overview.enforcement_mode : undefined

  return (
    <div className="px-8 py-6 max-w-3xl space-y-4">
      <SsoOverviewCard overview={overview} canEdit={canEdit} orgId={orgId} />
      <DomainsList
        domains={domains}
        canEdit={canEdit}
        orgId={orgId}
        enforcementMode={enforcementMode}
      />
      <LinkedUsersList users={linkedUsers} />
      <AuditEventsList events={auditEvents} />
    </div>
  )
}
