'use client'

import { useState, useTransition } from 'react'
import {
  approveAndGenerateInvite,
  updateAccessRequestStatus,
  generateInviteCode,
} from '@/lib/actions/invites'

// ── types ──────────────────────────────────────────────────────────────────

export interface AccessRequest {
  id: string
  name: string
  email: string
  company: string
  role_type: string
  systems_involved: string | null
  additional_notes: string | null
  status: 'new' | 'contacted' | 'approved' | 'declined'
  created_at: string
}

export interface Invite {
  id: string
  code: string
  email: string | null
  name: string | null
  company: string | null
  status: 'pending' | 'used' | 'expired'
  created_at: string
  used_at: string | null
  expires_at: string
  used_by_email: string | null
}

// ── helpers ────────────────────────────────────────────────────────────────

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function Badge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new:       'bg-blue-100 text-blue-700',
    contacted: 'bg-amber-100 text-amber-700',
    approved:  'bg-green-100 text-green-700',
    declined:  'bg-red-100 text-red-700',
    pending:   'bg-gray-100 text-gray-600',
    used:      'bg-green-100 text-green-700',
    expired:   'bg-red-100 text-red-600',
  }
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full capitalize ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 max-w-sm">
      <span>{message}</span>
      <button onClick={onClose} className="text-gray-400 hover:text-white ml-auto">✕</button>
    </div>
  )
}

// ── Access Requests section ────────────────────────────────────────────────

function RequestsSection({ initialRequests }: { initialRequests: AccessRequest[] }) {
  const [requests, setRequests] = useState(initialRequests)
  const [filter, setFilter] = useState<'all' | 'new' | 'contacted' | 'approved' | 'declined'>('all')
  const [toast, setToast] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [declineConfirm, setDeclineConfirm] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  const updateLocal = (id: string, status: AccessRequest['status']) =>
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, status } : r))

  const handleApprove = (req: AccessRequest) => {
    startTransition(async () => {
      const result = await approveAndGenerateInvite(req.id)
      if (result.error) { showToast(`Error: ${result.error}`); return }
      updateLocal(req.id, 'approved')
      await navigator.clipboard.writeText(result.signupUrl).catch(() => {})
      showToast(`Invite link copied! Send to ${req.email} — ${result.code}`)
    })
  }

  const handleContacted = (id: string) => {
    startTransition(async () => {
      const result = await updateAccessRequestStatus(id, 'contacted')
      if (!result.success) { showToast(`Error: ${result.error}`); return }
      updateLocal(id, 'contacted')
      showToast('Marked as contacted.')
    })
  }

  const handleDecline = (id: string) => {
    setDeclineConfirm(null)
    startTransition(async () => {
      const result = await updateAccessRequestStatus(id, 'declined')
      if (!result.success) { showToast(`Error: ${result.error}`); return }
      updateLocal(id, 'declined')
      showToast('Request declined.')
    })
  }

  const TABS = ['all', 'new', 'contacted', 'approved', 'declined'] as const
  const filtered = filter === 'all' ? requests : requests.filter((r) => r.status === filter)
  const counts = TABS.reduce((acc, t) => {
    acc[t] = t === 'all' ? requests.length : requests.filter((r) => r.status === t).length
    return acc
  }, {} as Record<string, number>)

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          Access Requests
          <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-2 py-0.5 rounded-full">
            {requests.filter((r) => r.status === 'new').length} new
          </span>
        </h2>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-3 pb-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
              filter === t
                ? 'border-[#4F46E5] text-[#4F46E5]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t} ({counts[t]})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">No {filter === 'all' ? '' : filter} requests.</p>
      ) : (
        <div className="space-y-3">
          {filtered.map((req) => (
            <div key={req.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-gray-900">{req.name}</span>
                    <Badge status={req.status} />
                  </div>
                  <p className="text-xs text-gray-500">{req.email} · {req.company}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{req.role_type}</p>
                  {req.systems_involved && (
                    <p className={`text-xs text-gray-500 mt-1 ${expanded === req.id ? '' : 'truncate max-w-md'}`}>
                      <span className="font-medium">Systems: </span>{req.systems_involved}
                    </p>
                  )}
                  {req.additional_notes && expanded === req.id && (
                    <p className="text-xs text-gray-500 mt-1">
                      <span className="font-medium">Notes: </span>{req.additional_notes}
                    </p>
                  )}
                  {(req.systems_involved || req.additional_notes) && (
                    <button
                      onClick={() => setExpanded(expanded === req.id ? null : req.id)}
                      className="text-xs text-blue-600 hover:text-blue-700 mt-1"
                    >
                      {expanded === req.id ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
                <div className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">{fmt(req.created_at)}</div>
              </div>

              {/* Actions */}
              {req.status !== 'declined' && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
                  {req.status !== 'approved' && (
                    <button
                      onClick={() => handleApprove(req)}
                      disabled={isPending}
                      className="text-xs bg-[#4F46E5] hover:bg-[#4338CA] text-white px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
                    >
                      Approve & Send Invite
                    </button>
                  )}
                  {req.status === 'new' && (
                    <button
                      onClick={() => handleContacted(req.id)}
                      disabled={isPending}
                      className="text-xs bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
                    >
                      Mark Contacted
                    </button>
                  )}
                  {req.status !== 'approved' && (
                    declineConfirm === req.id ? (
                      <>
                        <span className="text-xs text-gray-500 self-center">Confirm?</span>
                        <button
                          onClick={() => handleDecline(req.id)}
                          className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
                        >Yes</button>
                        <button
                          onClick={() => setDeclineConfirm(null)}
                          className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1.5"
                        >Cancel</button>
                      </>
                    ) : (
                      <button
                        onClick={() => setDeclineConfirm(req.id)}
                        className="text-xs text-red-600 hover:text-red-700 px-2 py-1.5 font-medium transition-colors"
                      >
                        Decline
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </section>
  )
}

// ── Invites section ────────────────────────────────────────────────────────

function InvitesSection({ initialInvites }: { initialInvites: Invite[] }) {
  const [invites, setInvites] = useState(initialInvites)
  const [showForm, setShowForm] = useState(false)
  const [genEmail, setGenEmail] = useState('')
  const [genName, setGenName] = useState('')
  const [genCompany, setGenCompany] = useState('')
  const [generatedResult, setGeneratedResult] = useState<{ code: string; url: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  const handleGenerate = () => {
    startTransition(async () => {
      const result = await generateInviteCode(genEmail || undefined, genName || undefined, genCompany || undefined)
      if (result.error) { showToast(`Error: ${result.error}`); return }

      setGeneratedResult({ code: result.code, url: result.signupUrl })
      setInvites((prev) => [{
        id: result.code,
        code: result.code,
        email: genEmail || null,
        name: genName || null,
        company: genCompany || null,
        status: 'pending',
        created_at: new Date().toISOString(),
        used_at: null,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        used_by_email: null,
      }, ...prev])
      setGenEmail(''); setGenName(''); setGenCompany('')
    })
  }

  const copyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url).catch(() => {})
    showToast('Signup link copied to clipboard!')
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-900">Invite Codes</h2>
        <button
          onClick={() => { setShowForm((o) => !o); setGeneratedResult(null) }}
          className="text-sm bg-[#4F46E5] hover:bg-[#4338CA] text-white px-4 py-2 rounded-lg font-medium transition-colors"
        >
          {showForm ? 'Cancel' : 'Generate New Invite'}
        </button>
      </div>

      {/* Generate form */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-5 mb-5">
          {generatedResult ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-green-700">✓ Invite code generated!</p>
              <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 font-mono text-lg font-bold text-gray-900 text-center tracking-widest">
                {generatedResult.code}
              </div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={generatedResult.url}
                  className="flex-1 text-xs bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-600 focus:outline-none"
                />
                <button
                  onClick={() => copyUrl(generatedResult.url)}
                  className="text-sm bg-[#4F46E5] text-white px-3 py-2 rounded-lg font-medium whitespace-nowrap"
                >
                  Copy link
                </button>
              </div>
              <button
                onClick={() => { setGeneratedResult(null); setGenEmail(''); setGenName(''); setGenCompany('') }}
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                Generate another
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-blue-800 font-medium mb-3">New Invite (all fields optional)</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input placeholder="Email" type="email" value={genEmail} onChange={(e) => setGenEmail(e.target.value)}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <input placeholder="Name" value={genName} onChange={(e) => setGenName(e.target.value)}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <input placeholder="Company" value={genCompany} onChange={(e) => setGenCompany(e.target.value)}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <button
                onClick={handleGenerate}
                disabled={isPending}
                className="text-sm bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white px-5 py-2 rounded-lg font-medium transition-colors"
              >
                {isPending ? 'Generating…' : 'Generate'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Invites table */}
      {invites.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">No invite codes yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Code</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Email / Name</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Company</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Status</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Created</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Used / Expires</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Used by</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {invites.map((inv) => (
                <tr key={inv.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">{inv.code}</td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    <div>{inv.email ?? <span className="text-gray-400">—</span>}</div>
                    {inv.name && <div className="text-gray-400">{inv.name}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">{inv.company ?? <span className="text-gray-400">—</span>}</td>
                  <td className="px-4 py-3"><Badge status={inv.status} /></td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(inv.created_at)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {inv.used_at ? fmt(inv.used_at) : `Exp. ${fmt(inv.expires_at)}`}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{inv.used_by_email ?? <span className="text-gray-400">—</span>}</td>
                  <td className="px-4 py-3">
                    {inv.status === 'pending' && (
                      <button
                        onClick={() => copyUrl(`${window.location.origin}/signup?invite=${inv.code}`)}
                        className="text-xs text-blue-600 hover:text-blue-700 whitespace-nowrap"
                      >
                        Copy link
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </section>
  )
}

// ── main export ────────────────────────────────────────────────────────────

export default function AdminInvitesContent({
  requests,
  invites,
  adminEmail,
}: {
  requests: AccessRequest[]
  invites: Invite[]
  adminEmail: string
}) {
  return (
    <div className="space-y-10">
      <RequestsSection initialRequests={requests} />
      <InvitesSection initialInvites={invites} />
    </div>
  )
}
