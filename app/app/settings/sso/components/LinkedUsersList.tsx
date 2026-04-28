'use client'

import * as React from 'react'
import type { ListOrgSsoLinkedUsersResult } from '@/lib/actions/sso-admin'

// D.3 — users currently SSO-linked, joined to email.
//
// Sort: most-recently-active first (handled in
// `listOrgSsoLinkedUsers`).
//
// The email field can be `null` if the user was hard-deleted between
// link creation and this render. We show a fallback rather than
// dropping the row, because the link itself is still meaningful for
// auditing.

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
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

export function LinkedUsersList({
  users,
}: {
  users: ListOrgSsoLinkedUsersResult
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl">
      <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">SSO-linked users</h2>
        {users.ok ? (
          <span className="text-xs text-gray-500">
            {users.users.length}{' '}
            {users.users.length === 1 ? 'user' : 'users'}
          </span>
        ) : null}
      </div>
      {!users.ok ? (
        <div className="px-5 py-4">
          <p className="text-sm text-red-600" role="alert">
            {users.error}
          </p>
        </div>
      ) : users.users.length === 0 ? (
        <div className="px-5 py-4">
          <p className="text-sm text-gray-500">No SSO sign-ins yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100" data-testid="linked-users-list">
          {users.users.map((u) => (
            <li
              key={u.user_id}
              className="px-5 py-3 flex items-center justify-between gap-4"
              data-testid="linked-user-row"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {u.email ?? (
                    <span className="text-gray-400 font-mono text-xs">
                      User {u.user_id.slice(0, 8)}…
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Linked {formatRelative(u.linked_at)}
                </p>
              </div>
              <span
                className="text-xs text-gray-500 flex-shrink-0"
                title={
                  u.last_login_at
                    ? new Date(u.last_login_at).toLocaleString()
                    : 'No SSO login recorded'
                }
              >
                Last sign-in: {formatRelative(u.last_login_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
