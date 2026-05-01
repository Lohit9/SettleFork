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
}

export function SsoSettingsContent({
  orgId: _orgId,
  overview,
  domains,
  linkedUsers,
  auditEvents,
}: Props) {
  // Empty-state branch — only when we definitively know SSO is OFF.
  if (overview.ok && !overview.sso_enabled) {
    return <SsoEmptyState />
  }

  return (
    <div className="px-8 py-6 max-w-3xl space-y-4">
      <SsoOverviewCard overview={overview} />
      <DomainsList domains={domains} />
      <LinkedUsersList users={linkedUsers} />
      <AuditEventsList events={auditEvents} />
    </div>
  )
}
