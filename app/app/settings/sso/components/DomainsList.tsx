'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { ListOrgSsoDomainsResult } from '@/lib/actions/sso-admin'
import {
  addOrgSsoDomain,
  removeOrgSsoDomain,
} from '@/lib/actions/sso-admin-mutations'
import type { EnforcementMode } from '@/lib/sso/domain-validation'
import { RemoveLastDomainDialog } from './RemoveLastDomainDialog'

// D.2 — domains attached to the org.
//
// B-2-c-i shipped this as a pure-display component. B-2-c-ii adds:
//   - A controlled add-domain form at the top (when canEdit)
//   - An × remove control on each row (when canEdit)
//   - Inline confirm UI for non-last-domain removes
//   - RemoveLastDomainDialog mount for last-domain removes
//
// Refresh strategy (Mini-D7): on success, call router.refresh() so
// the entire RSC tree re-runs and the new audit-event row appears in
// "Recent activity" without a full page reload. No optimistic
// updates — the round-trip is fast enough that complexity isn't
// worth it, and the audit-row appearance is the strongest possible
// "this actually happened" signal for the operator.

interface Props {
  domains: ListOrgSsoDomainsResult
  canEdit: boolean
  orgId: string
  /**
   * Current enforcement mode. Drives the copy in
   * RemoveLastDomainDialog when the operator removes the final
   * domain. Required only when `canEdit` is true.
   */
  enforcementMode?: EnforcementMode
}

export function DomainsList({ domains, canEdit, orgId, enforcementMode }: Props) {
  const router = useRouter()

  // Add-form state.
  const [addInput, setAddInput] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  const [addError, setAddError] = React.useState<string | null>(null)

  // Inline-confirm state. `null` means no row is in confirm mode;
  // otherwise it's the domain string of the row being confirmed.
  const [confirmDomain, setConfirmDomain] = React.useState<string | null>(null)
  const [removingDomain, setRemovingDomain] = React.useState<string | null>(null)
  const [removeError, setRemoveError] = React.useState<string | null>(null)

  // Last-domain modal state (mounted lazily).
  const [lastDomainModalDomain, setLastDomainModalDomain] = React.useState<
    string | null
  >(null)

  const domainCount = domains.ok ? domains.domains.length : 0

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAddError(null)
    if (!addInput.trim()) return
    setAdding(true)
    try {
      const result = await addOrgSsoDomain(orgId, addInput)
      if (!result.ok) {
        setAddError(result.error)
        return
      }
      setAddInput('')
      router.refresh()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add domain')
    } finally {
      setAdding(false)
    }
  }

  function handleStartRemove(domain: string) {
    setRemoveError(null)
    if (domainCount === 1) {
      // Last-domain path: open the heavy modal.
      setLastDomainModalDomain(domain)
    } else {
      // Inline-confirm path.
      setConfirmDomain(domain)
    }
  }

  async function performRemove(domain: string) {
    setRemoveError(null)
    setRemovingDomain(domain)
    try {
      const result = await removeOrgSsoDomain(orgId, domain)
      if (!result.ok) {
        setRemoveError(result.error)
        return
      }
      // Clear UI state and refresh.
      setConfirmDomain(null)
      setLastDomainModalDomain(null)
      router.refresh()
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove domain')
    } finally {
      setRemovingDomain(null)
    }
  }

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

      {/* Add-domain form (admins only). Lives ABOVE the list so a
          newly-added domain shows up below the form on refresh. */}
      {canEdit && domains.ok ? (
        <form
          onSubmit={handleAdd}
          className="px-5 py-3 border-b border-gray-100 flex flex-col gap-2"
          data-testid="add-domain-form"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={addInput}
              onChange={(e) => {
                setAddInput(e.target.value)
                if (addError) setAddError(null)
              }}
              placeholder="acme.com"
              autoComplete="off"
              spellCheck={false}
              disabled={adding}
              className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:bg-gray-50 disabled:text-gray-500"
              data-testid="add-domain-input"
            />
            <button
              type="submit"
              disabled={adding || !addInput.trim()}
              className="inline-flex items-center justify-center rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed"
              data-testid="add-domain-submit"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          {addError ? (
            <p
              className="text-xs text-red-600"
              role="alert"
              data-testid="add-domain-error"
            >
              {addError}
            </p>
          ) : null}
        </form>
      ) : null}

      {/* List body */}
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
            <DomainRow
              key={d.id}
              domain={d.domain}
              canEdit={canEdit}
              isConfirming={confirmDomain === d.domain}
              isRemoving={removingDomain === d.domain}
              onStartRemove={() => handleStartRemove(d.domain)}
              onCancelConfirm={() => {
                setConfirmDomain(null)
                setRemoveError(null)
              }}
              onConfirmRemove={() => performRemove(d.domain)}
            />
          ))}
        </ul>
      )}

      {/* Inline remove error — appears below the list, applies to
          whichever row last attempted a remove. */}
      {removeError ? (
        <div className="px-5 py-2 border-t border-gray-100">
          <p
            className="text-xs text-red-600"
            role="alert"
            data-testid="remove-domain-error"
          >
            {removeError}
          </p>
        </div>
      ) : null}

      {/* Last-domain modal (lazy-mounted). enforcementMode is
          required when canEdit; if absent we fall back to 'optional'
          for the most lenient copy — but in practice the parent
          should always pass it. */}
      {lastDomainModalDomain && canEdit ? (
        <RemoveLastDomainDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) setLastDomainModalDomain(null)
          }}
          domain={lastDomainModalDomain}
          enforcementMode={enforcementMode ?? 'optional'}
          onConfirm={() => performRemove(lastDomainModalDomain)}
          errorMessage={removeError}
        />
      ) : null}
    </section>
  )
}

// ─── Row sub-component ────────────────────────────────────────────────

interface DomainRowProps {
  domain: string
  canEdit: boolean
  isConfirming: boolean
  isRemoving: boolean
  onStartRemove: () => void
  onCancelConfirm: () => void
  onConfirmRemove: () => void
}

function DomainRow({
  domain,
  canEdit,
  isConfirming,
  isRemoving,
  onStartRemove,
  onCancelConfirm,
  onConfirmRemove,
}: DomainRowProps) {
  return (
    <li
      className="px-5 py-3 flex items-center justify-between gap-3"
      data-testid="domain-row"
      data-domain={domain}
    >
      <span className="text-sm text-gray-900 font-mono">{domain}</span>
      {canEdit ? (
        isConfirming ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-600">Remove?</span>
            <button
              type="button"
              onClick={onConfirmRemove}
              disabled={isRemoving}
              className="rounded-md bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700 disabled:bg-red-400"
              data-testid="confirm-remove-domain"
            >
              {isRemoving ? 'Removing…' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              disabled={isRemoving}
              className="rounded-md border border-gray-300 px-2 py-0.5 font-medium text-gray-700 hover:bg-gray-50"
              data-testid="cancel-remove-domain"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onStartRemove}
            disabled={isRemoving}
            aria-label={`Remove ${domain}`}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            data-testid="start-remove-domain"
          >
            {/* Small × glyph using a stroked SVG to match the
                project's lucide-react idiom without pulling another
                icon import here. */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )
      ) : null}
    </li>
  )
}
