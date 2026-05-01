'use client'

import * as React from 'react'
import type { ListOrgSsoDomainsResult } from '@/lib/actions/sso-admin'

// D.2 — domains attached to the org. Read-only display in this
// commit; B-2-c-ii adds add/remove controls on top.

export function DomainsList({ domains }: { domains: ListOrgSsoDomainsResult }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl">
      <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Domains</h2>
        {domains.ok ? (
          <span className="text-xs text-gray-500">
            {domains.domains.length}{' '}
            {domains.domains.length === 1 ? 'domain' : 'domains'}
          </span>
        ) : null}
      </div>
      {!domains.ok ? (
        <div className="px-5 py-4">
          <p className="text-sm text-red-600" role="alert">
            {domains.error}
          </p>
        </div>
      ) : domains.domains.length === 0 ? (
        <div className="px-5 py-4">
          <p className="text-sm text-gray-500">No domains configured.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100" data-testid="domains-list">
          {domains.domains.map((d) => (
            <li
              key={d.id}
              className="px-5 py-3 text-sm text-gray-900 font-mono"
              data-testid="domain-row"
            >
              {d.domain}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
