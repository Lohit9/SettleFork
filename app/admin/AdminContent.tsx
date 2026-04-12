'use client'

import React, { useState, useTransition, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  approveAndGenerateInvite,
  updateAccessRequestStatus,
} from '@/lib/actions/invites'
import { adminCreateOrganization, adminGetOrgMembers } from '@/lib/actions/organizations'
import { adminCreateOrgInvite, adminGetPendingInvites, adminRevokeInvite } from '@/lib/actions/org-invites'
import type { OrgInvite, OrgRole } from '@/lib/types/organizations'

// ── shared types ─────────────────────────────────────────────────────────────

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

export interface OrgRow {
  id: string
  name: string
  slug: string
  created_at: string
  member_count: number
  project_count: number
}

// ── shared helpers ────────────────────────────────────────────────────────────

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 max-w-sm">
      <span>{message}</span>
      <button onClick={onClose} className="text-gray-400 hover:text-white ml-auto">✕</button>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new:       'bg-blue-100 text-blue-700',
    contacted: 'bg-amber-100 text-amber-700',
    approved:  'bg-green-100 text-green-700',
    declined:  'bg-red-100 text-red-700',
  }
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full capitalize ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

// ── Approve popover ───────────────────────────────────────────────────────────

function ApprovePopover({
  req,
  onSuccess,
  onClose,
}: {
  req: AccessRequest
  onSuccess: (id: string, email: string, signupUrl: string) => void
  onClose: () => void
}) {
  const [orgName, setOrgName] = useState(req.company?.trim() || '')
  const [role, setRole] = useState<'owner' | 'admin' | 'editor' | 'viewer'>('owner')
  const [isPending, startTransition] = useTransition()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const result = await approveAndGenerateInvite(req.id, orgName, role)
      if (result.error) { alert(`Error: ${result.error}`); return }
      onSuccess(req.id, req.email, result.signupUrl)
    })
  }

  return (
    <div ref={ref} className="absolute z-20 top-full left-0 mt-2 w-80 bg-white border border-gray-200 rounded-xl shadow-lg p-4">
      <p className="text-xs font-semibold text-gray-700 mb-3">Create org &amp; send invite to {req.email}</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label className="text-xs text-gray-500">Organization Name</Label>
          <Input
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Company name"
            required
            className="mt-1 h-8 text-sm"
            autoFocus
          />
        </div>
        <div>
          <Label className="text-xs text-gray-500">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
            <SelectTrigger className="mt-1 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['owner', 'admin', 'editor', 'viewer'] as const).map((r) => (
                <SelectItem key={r} value={r}><span className="capitalize">{r}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2 pt-1">
          <Button type="submit" disabled={isPending || !orgName.trim()} size="sm"
            className="flex-1 bg-[#4F46E5] hover:bg-[#4338CA] text-white text-xs h-8">
            {isPending ? 'Sending…' : 'Create Org & Send Invite'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} className="text-xs h-8">
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

// ── Access Requests section ───────────────────────────────────────────────────

function RequestsSection({
  initialRequests,
  onApproved,
}: {
  initialRequests: AccessRequest[]
  onApproved: (email: string, signupUrl: string) => void
}) {
  const [requests, setRequests] = useState(initialRequests)
  const [filter, setFilter] = useState<'all' | 'new' | 'contacted' | 'approved' | 'declined'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [declineConfirm, setDeclineConfirm] = useState<string | null>(null)
  const [approvePopover, setApprovePopover] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 4000) }

  const updateLocal = (id: string, status: AccessRequest['status']) =>
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, status } : r))

  const handleApproveSuccess = (id: string, email: string, signupUrl: string) => {
    setApprovePopover(null)
    updateLocal(id, 'approved')
    navigator.clipboard.writeText(signupUrl).catch(() => {})
    onApproved(email, signupUrl)
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

  const SUB_TABS = ['all', 'new', 'contacted', 'approved', 'declined'] as const
  const filtered = filter === 'all' ? requests : requests.filter((r) => r.status === filter)
  const counts = SUB_TABS.reduce((acc, t) => {
    acc[t] = t === 'all' ? requests.length : requests.filter((r) => r.status === t).length
    return acc
  }, {} as Record<string, number>)

  return (
    <section>
      {/* Sub-filter tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {SUB_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-3 pb-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
              filter === t
                ? 'border-blue-600 text-blue-600'
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
                    <StatusBadge status={req.status} />
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
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100 relative">
                  {req.status !== 'approved' ? (
                    <>
                      <div className="relative">
                        <button
                          onClick={() => setApprovePopover(approvePopover === req.id ? null : req.id)}
                          disabled={isPending}
                          className="text-xs bg-[#4F46E5] hover:bg-[#4338CA] text-white px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
                        >
                          Approve ▾
                        </button>
                        {approvePopover === req.id && (
                          <ApprovePopover
                            req={req}
                            onSuccess={handleApproveSuccess}
                            onClose={() => setApprovePopover(null)}
                          />
                        )}
                      </div>
                      {req.status === 'new' && (
                        <button
                          onClick={() => handleContacted(req.id)}
                          disabled={isPending}
                          className="text-xs bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
                        >
                          Mark Contacted
                        </button>
                      )}
                      {declineConfirm === req.id ? (
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
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-green-600 font-medium">
                      ✓ Approved — invite sent
                    </span>
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

// ── Organizations section ─────────────────────────────────────────────────────

type AdminMember = { id: string; user_id: string; role: OrgRole; joined_at: string; user_name: string; user_email: string }
const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'editor', 'viewer']

function OrgDetail({ org }: { org: OrgRow }) {
  const [members, setMembers] = useState<AdminMember[]>([])
  const [invites, setInvites] = useState<OrgInvite[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrgRole>('owner')
  const [isPending, startTransition] = useTransition()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    adminGetOrgMembers(org.id).then(({ members: m }) => {
      setMembers(m)
      if (m.length > 0) setInviteRole('editor')
    })
    adminGetPendingInvites(org.id).then(({ invites: inv }) => setInvites(inv))
  }, [org.id])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 4000) }

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    startTransition(async () => {
      const result = await adminCreateOrgInvite(org.id, inviteEmail.trim(), inviteRole)
      if (result.error) { showToast(`Error: ${result.error}`); return }
      showToast(`Invite sent to ${inviteEmail.trim()}`)
      setInviteEmail('')
      setInviteRole('editor')
      adminGetPendingInvites(org.id).then(({ invites: inv }) => setInvites(inv))
    })
  }

  const handleRevoke = (inviteId: string) => {
    startTransition(async () => {
      await adminRevokeInvite(inviteId)
      setInvites((prev) => prev.filter((i) => i.id !== inviteId))
    })
  }

  const isEmpty = members.length === 0 && invites.length === 0

  return (
    <div className="mt-3 space-y-4 pl-4 border-l-2 border-blue-200">
      {isEmpty && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          No members yet. The first invite will default to <strong>Owner</strong>.
        </p>
      )}
      <form onSubmit={handleInvite} className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-xs text-gray-500">Email</Label>
          <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@company.com" required className="mt-1 h-8 text-sm" />
        </div>
        <div className="w-32">
          <Label className="text-xs text-gray-500">Role</Label>
          <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
            <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r} value={r}><span className="capitalize">{r}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={isPending} size="sm"
          className="bg-primary hover:bg-primary/90 text-white h-8 text-xs">
          {isPending ? 'Sending…' : 'Invite'}
        </Button>
      </form>

      {members.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1.5">Members ({members.length})</p>
          <div className="space-y-1">
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-1.5 px-2 bg-gray-50 rounded text-xs">
                <div>
                  <span className="font-medium text-gray-900">{m.user_name || 'Unnamed'}</span>
                  <span className="text-gray-400 ml-2">{m.user_email}</span>
                </div>
                <span className="capitalize text-gray-500 bg-gray-200 px-2 py-0.5 rounded text-[10px] font-medium">{m.role}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {invites.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1.5">Pending Invites ({invites.length})</p>
          <div className="space-y-1">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between py-1.5 px-2 bg-amber-50 rounded text-xs">
                <div>
                  <span className="text-gray-900">{inv.email}</span>
                  <span className="capitalize text-amber-600 ml-2">{inv.role}</span>
                </div>
                <button onClick={() => handleRevoke(inv.id)} disabled={isPending}
                  className="text-red-500 hover:text-red-700 text-xs font-medium">
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

function OrgsSection({ initialOrgs }: { initialOrgs: OrgRow[] }) {
  const [orgs, setOrgs] = useState(initialOrgs)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newOrgName, setNewOrgName] = useState('')
  const [isPending, startTransition] = useTransition()
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 4000) }

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newOrgName.trim()) return
    startTransition(async () => {
      const result = await adminCreateOrganization(newOrgName.trim())
      if (result.error) { showToast(`Error: ${result.error}`); return }
      if (result.org) {
        setOrgs((prev) => [{ ...result.org!, member_count: 0, project_count: 0 }, ...prev])
        showToast(`Created "${result.org.name}"`)
        setNewOrgName('')
      }
    })
  }

  return (
    <section>
      {/* Create org form */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <form onSubmit={handleCreate} className="flex gap-3 items-end">
          <div className="flex-1">
            <Label className="text-xs text-gray-500">New Organization Name</Label>
            <Input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)}
              placeholder="Acme Corp" required className="mt-1" />
          </div>
          <Button type="submit" disabled={isPending || !newOrgName.trim()}
            className="bg-primary hover:bg-primary/90 text-white">
            {isPending ? 'Creating…' : 'Create Organization'}
          </Button>
        </form>
      </div>

      {/* Org table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Name</th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Slug</th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Members</th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Projects</th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <React.Fragment key={org.id}>
                <tr
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(expandedId === org.id ? null : org.id)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{org.name}</td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-500">{org.slug}</td>
                  <td className="px-4 py-3 text-gray-700">{org.member_count}</td>
                  <td className="px-4 py-3 text-gray-700">{org.project_count}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmt(org.created_at)}</td>
                  <td className="px-4 py-3 text-xs text-blue-600">
                    {expandedId === org.id ? 'Collapse' : 'Expand'}
                  </td>
                </tr>
                {expandedId === org.id && (
                  <tr className="border-b border-gray-100">
                    <td colSpan={6} className="px-4 pb-4 pt-1">
                      <OrgDetail org={org} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {orgs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                  No organizations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </section>
  )
}

// ── main export ───────────────────────────────────────────────────────────────

export default function AdminContent({
  requests,
  orgs,
  adminEmail,
}: {
  requests: AccessRequest[]
  orgs: OrgRow[]
  adminEmail: string
}) {
  const [activeTab, setActiveTab] = useState<'requests' | 'organizations'>('requests')
  const [toast, setToast] = useState<string | null>(null)

  const newRequestCount = requests.filter((r) => r.status === 'new').length

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 5000) }

  const handleApproved = (email: string, signupUrl: string) => {
    navigator.clipboard.writeText(signupUrl).catch(() => {})
    showToast(`Org created and invite sent to ${email} — link copied to clipboard`)
    setActiveTab('organizations')
  }

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Settle Admin</h1>
          <p className="text-sm text-slate-500 mt-1">Manage access requests and organizations.</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">{adminEmail}</span>
          <a href="/app/projects" className="text-blue-600 hover:text-blue-800 font-medium">
            Go to app →
          </a>
        </div>
      </div>

      {/* Top-level tabs */}
      <div className="flex gap-1 border-b border-slate-200 mb-6">
        <button
          onClick={() => setActiveTab('requests')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'requests'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Requests
          {newRequestCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-semibold bg-blue-100 text-blue-700 rounded-full">
              {newRequestCount} new
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('organizations')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'organizations'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Organizations
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'requests' && (
        <RequestsSection initialRequests={requests} onApproved={handleApproved} />
      )}
      {activeTab === 'organizations' && (
        <OrgsSection initialOrgs={orgs} />
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  )
}
