'use client'

import * as React from 'react'
import type { ListOrgSsoAuditEventsResult } from '@/lib/actions/sso-admin'
import { AuditEventRow } from './AuditEventRow'

// D.4 — recent SSO audit events for the org. Newest first; click any
// row to expand its raw metadata. Polymorphic rendering happens
// inside `AuditEventRow`.

export function AuditEventsList({
  events,
}: {
  events: ListOrgSsoAuditEventsResult
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl">
      <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Recent activity</h2>
        {events.ok ? (
          <span className="text-xs text-gray-500">
            {events.events.length}{' '}
            {events.events.length === 1 ? 'event' : 'events'}
          </span>
        ) : null}
      </div>
      {!events.ok ? (
        <div className="px-5 py-4">
          <p className="text-sm text-red-600" role="alert">
            {events.error}
          </p>
        </div>
      ) : events.events.length === 0 ? (
        <div className="px-5 py-4">
          <p className="text-sm text-gray-500">No recent SSO activity.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100" data-testid="audit-events-list">
          {events.events.map((e) => (
            <AuditEventRow key={e.id} event={e} />
          ))}
        </div>
      )}
    </section>
  )
}
