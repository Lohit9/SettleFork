'use client'

import { useState, useEffect, useTransition } from 'react'
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
import { getOrgMembers, updateMemberRole, removeMember } from '@/lib/actions/organizations'
import { createOrgInvite, getPendingInvites, revokeInvite } from '@/lib/actions/org-invites'
import type { OrgMembership, OrgInvite, OrgRole } from '@/lib/types/organizations'

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'editor', 'viewer']

const ROLE_BADGE: Record<OrgRole, string> = {
  owner: 'bg-purple-100 text-purple-700',
  admin: 'bg-blue-100 text-blue-700',
  editor: 'bg-green-100 text-green-700',
  viewer: 'bg-gray-100 text-gray-600',
}

interface Props {
  orgId: string
  currentUserId: string
  currentUserRole: OrgRole
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function MembersContent({ orgId, currentUserId, currentUserRole }: Props) {
  const [members, setMembers] = useState<OrgMembership[]>([])
  const [invites, setInvites] = useState<OrgInvite[]>([])
  const [isPending, startTransition] = useTransition()

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrgRole>('viewer')
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Remove confirmation
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const isAdmin = currentUserRole === 'owner' || currentUserRole === 'admin'
  const ownerCount = members.filter((m) => m.role === 'owner').length

  useEffect(() => {
    loadData()
  }, [orgId])

  function loadData() {
    getOrgMembers(orgId).then(({ members: m }) => setMembers(m))
    if (isAdmin) {
      getPendingInvites(orgId).then(({ invites: inv }) => setInvites(inv))
    }
  }

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setInviteError(null)
    setInviteSuccess(null)
    startTransition(async () => {
      const result = await createOrgInvite(orgId, inviteEmail.trim(), inviteRole)
      if (result.error) {
        setInviteError(result.error)
        return
      }
      setInviteSuccess(`Invite sent to ${inviteEmail.trim()}`)
      setInviteEmail('')
      setInviteRole('viewer')
      loadData()
      setTimeout(() => setInviteSuccess(null), 5000)
    })
  }

  const handleRoleChange = (userId: string, newRole: OrgRole) => {
    setActionError(null)
    startTransition(async () => {
      const result = await updateMemberRole(orgId, userId, newRole)
      if (result.error) {
        setActionError(result.error)
        setTimeout(() => setActionError(null), 5000)
        return
      }
      loadData()
    })
  }

  const handleRemove = (userId: string) => {
    setActionError(null)
    startTransition(async () => {
      const result = await removeMember(orgId, userId)
      if (result.error) {
        setActionError(result.error)
        setTimeout(() => setActionError(null), 5000)
        return
      }
      setConfirmRemove(null)
      loadData()
    })
  }

  const handleRevoke = (inviteId: string) => {
    startTransition(async () => {
      await revokeInvite(inviteId)
      loadData()
    })
  }

  if (!isAdmin) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-900 mb-1">Permission Required</p>
        <p className="text-sm text-gray-500">You don&apos;t have permission to manage members. Contact your organization owner or admin.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Invite form */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Invite a team member</h3>
        <form onSubmit={handleInvite} className="flex gap-3 items-end">
          <div className="flex-1">
            <Label htmlFor="inviteEmail" className="text-xs text-gray-500">Email address</Label>
            <Input
              id="inviteEmail"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              required
              className="mt-1"
            />
          </div>
          <div className="w-36">
            <Label className="text-xs text-gray-500">Role</Label>
            <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    <span className="capitalize">{r}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            disabled={isPending || !inviteEmail.trim()}
            className="bg-primary hover:bg-primary/90 text-white whitespace-nowrap"
          >
            {isPending ? 'Sending...' : 'Send Invite'}
          </Button>
        </form>
        {inviteSuccess && (
          <div className="mt-3 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700">
            {inviteSuccess}
          </div>
        )}
        {inviteError && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {inviteError}
          </div>
        )}
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Members table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">
            Members <span className="text-gray-400 font-normal">({members.length})</span>
          </h3>
        </div>
        <div className="divide-y divide-gray-100">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId
            const isLastOwner = member.role === 'owner' && ownerCount <= 1
            return (
              <div key={member.id} className="flex items-center gap-4 px-5 py-3">
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-semibold text-white">
                    {(member.user_name || member.user_email || '??').slice(0, 2).toUpperCase()}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {member.user_name || 'Unnamed'}
                    </span>
                    {isSelf && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-medium">You</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500 truncate block">{member.user_email}</span>
                </div>

                {/* Joined */}
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Joined {timeAgo(member.joined_at)}
                </span>

                {/* Role */}
                <div className="w-28 flex-shrink-0">
                  {isSelf ? (
                    <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium capitalize ${ROLE_BADGE[member.role]}`}>
                      {member.role}
                    </span>
                  ) : (
                    <div className="relative group/role">
                      <Select
                        value={member.role}
                        onValueChange={(v) => handleRoleChange(member.user_id, v as OrgRole)}
                        disabled={isLastOwner}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((r) => (
                            <SelectItem key={r} value={r}>
                              <span className="capitalize">{r}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isLastOwner && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/role:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                          At least one owner is required
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Remove */}
                <div className="w-20 flex-shrink-0 text-right">
                  {!isSelf && (
                    <div className="relative group/remove">
                      {confirmRemove === member.user_id ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleRemove(member.user_id)}
                            disabled={isPending}
                            className="text-xs text-red-600 hover:text-red-700 font-medium"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmRemove(null)}
                            className="text-xs text-gray-400 hover:text-gray-500"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmRemove(member.user_id)}
                          disabled={isLastOwner}
                          className={`text-xs font-medium ${
                            isLastOwner
                              ? 'text-gray-300 cursor-not-allowed'
                              : 'text-gray-400 hover:text-red-600'
                          }`}
                        >
                          Remove
                        </button>
                      )}
                      {isLastOwner && (
                        <div className="absolute bottom-full right-0 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/remove:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                          At least one owner is required
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {members.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-gray-400">No members yet</div>
          )}
        </div>
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">
              Pending invites <span className="text-gray-400 font-normal">({invites.length})</span>
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-4 px-5 py-3 transition-all">
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-gray-900 truncate block">{inv.email}</span>
                </div>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium capitalize ${ROLE_BADGE[inv.role]}`}>
                  {inv.role}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Sent {timeAgo(inv.created_at)}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Expires {new Date(inv.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <button
                  onClick={() => handleRevoke(inv.id)}
                  disabled={isPending}
                  className="text-xs text-gray-400 hover:text-red-600 font-medium flex-shrink-0"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
