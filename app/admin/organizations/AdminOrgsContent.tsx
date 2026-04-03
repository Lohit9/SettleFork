'use client'

import React, { useState, useTransition, useEffect } from 'react'
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
import { createOrganization, getOrgMembers } from '@/lib/actions/organizations'
import { createOrgInvite, getPendingInvites, revokeInvite } from '@/lib/actions/org-invites'
import type { OrgMembership, OrgInvite, OrgRole } from '@/lib/types/organizations'

interface OrgRow {
  id: string
  name: string
  slug: string
  created_at: string
  member_count: number
  project_count: number
}

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer']

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

function OrgDetail({ org }: { org: OrgRow }) {
  const [members, setMembers] = useState<OrgMembership[]>([])
  const [invites, setInvites] = useState<OrgInvite[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrgRole>('editor')
  const [isPending, startTransition] = useTransition()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    getOrgMembers(org.id).then(({ members: m }) => setMembers(m))
    getPendingInvites(org.id).then(({ invites: inv }) => setInvites(inv))
  }, [org.id])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    startTransition(async () => {
      const result = await createOrgInvite(org.id, inviteEmail.trim(), inviteRole)
      if (result.error) {
        showToast(`Error: ${result.error}`)
        return
      }
      showToast(`Invite sent to ${inviteEmail.trim()}`)
      setInviteEmail('')
      setInviteRole('editor')
      getPendingInvites(org.id).then(({ invites: inv }) => setInvites(inv))
    })
  }

  const handleRevoke = (inviteId: string) => {
    startTransition(async () => {
      await revokeInvite(inviteId)
      setInvites((prev) => prev.filter((i) => i.id !== inviteId))
    })
  }

  return (
    <div className="mt-3 space-y-4 pl-4 border-l-2 border-blue-200">
      {/* Invite form */}
      <form onSubmit={handleInvite} className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-xs text-gray-500">Email</Label>
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@company.com"
            required
            className="mt-1 h-8 text-sm"
          />
        </div>
        <div className="w-32">
          <Label className="text-xs text-gray-500">Role</Label>
          <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
            <SelectTrigger className="mt-1 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r} value={r}><span className="capitalize">{r}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={isPending} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white h-8 text-xs">
          {isPending ? 'Sending…' : 'Invite'}
        </Button>
      </form>

      {/* Members */}
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

      {/* Pending invites */}
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
                <button onClick={() => handleRevoke(inv.id)} disabled={isPending} className="text-red-500 hover:text-red-700 text-xs font-medium">
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

export default function AdminOrgsContent({ initialOrgs }: { initialOrgs: OrgRow[] }) {
  const [orgs, setOrgs] = useState(initialOrgs)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newOrgName, setNewOrgName] = useState('')
  const [isPending, startTransition] = useTransition()
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newOrgName.trim()) return
    startTransition(async () => {
      const result = await createOrganization(newOrgName.trim())
      if (result.error) {
        showToast(`Error: ${result.error}`)
        return
      }
      if (result.org) {
        setOrgs((prev) => [{ ...result.org!, member_count: 1, project_count: 0 }, ...prev])
        showToast(`Created "${result.org.name}" (${result.org.slug})`)
        setNewOrgName('')
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Create org form */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Create Organization</h2>
        <form onSubmit={handleCreate} className="flex gap-3 items-end">
          <div className="flex-1">
            <Label className="text-xs text-gray-500">Organization Name</Label>
            <Input
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              placeholder="Acme Corp"
              required
              className="mt-1"
            />
          </div>
          <Button type="submit" disabled={isPending || !newOrgName.trim()} className="bg-blue-600 hover:bg-blue-700 text-white">
            {isPending ? 'Creating…' : 'Create Organization'}
          </Button>
        </form>
      </div>

      {/* Org list */}
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
    </div>
  )
}
