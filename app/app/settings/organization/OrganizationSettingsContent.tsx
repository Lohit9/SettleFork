'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
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
  getOrgMembers,
  updateMemberRole,
  removeMember,
  updateOrganization,
  leaveOrganization,
  setOrgMemberAutoGrant,
  backfillOrgMemberProjectAccess,
} from '@/lib/actions/organizations'
import { createOrgInvite, getPendingInvites, revokeInvite } from '@/lib/actions/org-invites'
import type { OrgMembership, OrgInvite, OrgRole } from '@/lib/types/organizations'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/modal'

const ROLE_OPTIONS: OrgRole[] = ['owner', 'member']

const ROLE_BADGE: Record<OrgRole, string> = {
  owner: 'bg-purple-100 text-purple-700',
  member: 'bg-blue-100 text-blue-700',
}

const ROLE_LABEL: Record<OrgRole, string> = {
  owner: 'Owner',
  member: 'Member',
}

interface Props {
  org: {
    id: string
    name: string
    slug: string
    created_at: string
    member_auto_grant_enabled: boolean
  }
  orgRole: OrgRole
  currentUserId: string
  multiOrg: boolean
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
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function OrganizationSettingsContent({
  org,
  orgRole,
  currentUserId,
  multiOrg,
}: Props) {
  const router = useRouter()
  // Post-079: only owners have admin-level org powers (invite/manage/rename).
  // The variable is still named `isAdmin` for UI semantics.
  const isAdmin = orgRole === 'owner'

  const [members, setMembers] = useState<OrgMembership[]>([])
  const [invites, setInvites] = useState<OrgInvite[]>([])
  const [isPending, startTransition] = useTransition()

  // Org name editing
  const [orgName, setOrgName] = useState(org.name)
  const [orgNameSaving, setOrgNameSaving] = useState(false)
  const [orgNameError, setOrgNameError] = useState<string | null>(null)
  const [orgNameSuccess, setOrgNameSuccess] = useState(false)

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrgRole>('member')
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Member actions
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Leave org
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [isLeaving, setIsLeaving] = useState(false)

  // Auto-grant toggle (PR 2b)
  const [autoGrantEnabled, setAutoGrantEnabled] = useState(org.member_auto_grant_enabled)
  const [showEnableModal, setShowEnableModal] = useState(false)
  const [autoGrantBusy, setAutoGrantBusy] = useState<
    'idle' | 'enable-only' | 'enable-backfill' | 'disable'
  >('idle')
  const [autoGrantError, setAutoGrantError] = useState<string | null>(null)

  const ownerCount = members.filter((m) => m.role === 'owner').length
  const isLastOwner =
    orgRole === 'owner' && ownerCount <= 1

  useEffect(() => {
    loadData()
  }, [org.id])

  function loadData() {
    getOrgMembers(org.id).then(({ members: m }) => setMembers(m))
    if (isAdmin) {
      getPendingInvites(org.id).then(({ invites: inv }) => setInvites(inv))
    }
  }

  const handleSaveOrgName = () => {
    if (!orgName.trim() || orgName.trim() === org.name) return
    setOrgNameError(null)
    setOrgNameSuccess(false)
    setOrgNameSaving(true)
    startTransition(async () => {
      const result = await updateOrganization(org.id, orgName.trim())
      setOrgNameSaving(false)
      if (!result.success) {
        setOrgNameError(result.error ?? 'Failed to save')
      } else {
        setOrgNameSuccess(true)
        setTimeout(() => setOrgNameSuccess(false), 3000)
      }
    })
  }

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setInviteError(null)
    setInviteSuccess(null)
    startTransition(async () => {
      const result = await createOrgInvite(org.id, inviteEmail.trim(), inviteRole)
      if (result.error) {
        setInviteError(result.error)
        return
      }
      setInviteSuccess(`Invite sent to ${inviteEmail.trim()}`)
      setInviteEmail('')
      setInviteRole('member')
      loadData()
      setTimeout(() => setInviteSuccess(null), 5000)
    })
  }

  const handleRoleChange = (userId: string, newRole: OrgRole) => {
    setActionError(null)
    startTransition(async () => {
      const result = await updateMemberRole(org.id, userId, newRole)
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
      const result = await removeMember(org.id, userId)
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

  const handleLeave = async () => {
    setLeaveError(null)
    setIsLeaving(true)
    const result = await leaveOrganization(org.id)
    setIsLeaving(false)
    if (!result.success) {
      setLeaveError(result.error ?? 'Failed to leave organization')
      return
    }
    // Clear the active org cookie and go to projects (will auto-pick a new org)
    document.cookie = 'settle-active-org=; path=/; max-age=0'
    document.cookie = 'mine-active-org=; path=/; max-age=0'
    router.push('/app/projects')
    router.refresh()
  }

  // ── Auto-grant toggle handlers (PR 2b) ────────────────────────────────────
  // OFF→ON: open the 3-option modal so the owner can choose whether to
  // backfill existing members. ON→OFF: silent direct execution — turning
  // off has no destructive side effect (stickiness rule), so a confirm
  // would just add friction.
  const handleAutoGrantSwitchChange = (next: boolean) => {
    setAutoGrantError(null)
    if (next && !autoGrantEnabled) {
      setShowEnableModal(true)
    } else if (!next && autoGrantEnabled) {
      handleDisableAutoGrant()
    }
  }

  const handleDisableAutoGrant = async () => {
    setAutoGrantBusy('disable')
    setAutoGrantError(null)
    const result = await setOrgMemberAutoGrant(org.id, false)
    if (result.success) {
      setAutoGrantEnabled(false)
    } else {
      setAutoGrantError(result.error ?? 'Failed to update setting')
    }
    setAutoGrantBusy('idle')
  }

  const handleEnableOnly = async () => {
    setAutoGrantBusy('enable-only')
    setAutoGrantError(null)
    const result = await setOrgMemberAutoGrant(org.id, true)
    if (result.success) {
      setAutoGrantEnabled(true)
      setShowEnableModal(false)
    } else {
      setAutoGrantError(result.error ?? 'Failed to update setting')
    }
    setAutoGrantBusy('idle')
  }

  const handleEnableAndBackfill = async () => {
    setAutoGrantBusy('enable-backfill')
    setAutoGrantError(null)
    const toggleResult = await setOrgMemberAutoGrant(org.id, true)
    if (!toggleResult.success) {
      setAutoGrantError(toggleResult.error ?? 'Failed to update setting')
      setAutoGrantBusy('idle')
      return
    }
    // Toggle landed; mirror it locally so the Switch reflects ON even if
    // the backfill fails downstream.
    setAutoGrantEnabled(true)
    const backfillResult = await backfillOrgMemberProjectAccess(org.id)
    if (!backfillResult.success) {
      setAutoGrantError(
        `Setting saved, but backfill failed: ${backfillResult.error ?? 'unknown error'}. Retry to complete.`,
      )
      setAutoGrantBusy('idle')
      return
    }
    setShowEnableModal(false)
    setAutoGrantBusy('idle')
  }

  return (
    <div className="space-y-4">
      {/* Org header */}
      <div>
        <h2 className="text-base font-semibold text-gray-900">
          Organization: <span className="text-blue-600">{org.name}</span>
        </h2>
        {multiOrg && (
          <p className="text-xs text-gray-400 mt-0.5">
            Showing settings for your active organization. Switch organizations from the sidebar.
          </p>
        )}
      </div>

      {/* Organization Details */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Organization details</h3>
        <div className="space-y-4">
          {/* Name */}
          <div>
            <Label className="text-xs text-gray-500 mb-1 block">Organization name</Label>
            {isAdmin ? (
              <div className="flex gap-2">
                <Input
                  value={orgName}
                  onChange={(e) => {
                    setOrgName(e.target.value)
                    setOrgNameSuccess(false)
                    setOrgNameError(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveOrgName()}
                  className="max-w-xs"
                  placeholder="Organization name"
                />
                <Button
                  size="sm"
                  onClick={handleSaveOrgName}
                  disabled={
                    isPending ||
                    orgNameSaving ||
                    !orgName.trim() ||
                    orgName.trim() === org.name
                  }
                  className="bg-primary hover:bg-primary/90 text-white"
                >
                  {orgNameSaving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-gray-900">{org.name}</p>
            )}
            {orgNameError && (
              <p className="text-xs text-red-600 mt-1">{orgNameError}</p>
            )}
            {orgNameSuccess && (
              <p className="text-xs text-green-600 mt-1">Name updated successfully</p>
            )}
          </div>

          {/* Slug + Created */}
          <div className="grid grid-cols-2 gap-x-8">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Slug</p>
              <p className="text-sm text-gray-700 font-mono">{org.slug}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Created</p>
              <p className="text-sm text-gray-700">{formatDate(org.created_at)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Invite Member — admins only */}
      {isAdmin && (
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Invite a team member</h3>
          <form onSubmit={handleInvite} className="flex gap-3 items-end">
            <div className="flex-1">
              <Label htmlFor="inviteEmail" className="text-xs text-gray-500">
                Email address
              </Label>
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
                      {ROLE_LABEL[r]}
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
              {isPending ? 'Sending…' : 'Send Invite'}
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
      )}

      {/* Action error */}
      {actionError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Members */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">
            Members{' '}
            <span className="text-gray-400 font-normal">({members.length})</span>
          </h3>
        </div>
        <div className="divide-y divide-gray-100">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId
            const memberIsLastOwner = member.role === 'owner' && ownerCount <= 1
            return (
              <div key={member.id} className="flex items-center gap-4 px-5 py-3">
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-semibold text-white">
                    {(member.user_name || member.user_email || '??')
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {member.user_name || 'Unnamed'}
                    </span>
                    {isSelf && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-medium">
                        You
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500 truncate block">
                    {member.user_email}
                  </span>
                </div>

                {/* Joined */}
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Joined {timeAgo(member.joined_at)}
                </span>

                {/* Role */}
                <div className="w-32 flex-shrink-0">
                  {isAdmin && !isSelf ? (
                    <div className="relative group/role">
                      <Select
                        value={member.role}
                        onValueChange={(v) => handleRoleChange(member.user_id, v as OrgRole)}
                        disabled={memberIsLastOwner || isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((r) => (
                            <SelectItem key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {memberIsLastOwner && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/role:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                          At least one owner is required
                        </div>
                      )}
                    </div>
                  ) : (
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium ${ROLE_BADGE[member.role]}`}
                    >
                      {ROLE_LABEL[member.role]}
                    </span>
                  )}
                </div>

                {/* Remove — admins only, not self */}
                {isAdmin && (
                  <div className="w-20 flex-shrink-0 text-right">
                    {!isSelf && (
                      <div className="relative group/remove">
                        {confirmRemove === member.user_id ? (
                          <div className="flex gap-1 justify-end">
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
                            disabled={memberIsLastOwner || isPending}
                            className={`text-xs font-medium ${
                              memberIsLastOwner
                                ? 'text-gray-300 cursor-not-allowed'
                                : 'text-gray-400 hover:text-red-600'
                            }`}
                          >
                            Remove
                          </button>
                        )}
                        {memberIsLastOwner && (
                          <div className="absolute bottom-full right-0 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/remove:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                            At least one owner is required
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {members.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-gray-400">
              No members yet
            </div>
          )}
        </div>
      </div>

      {/* Pending Invites — admins only */}
      {isAdmin && invites.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">
              Pending invites{' '}
              <span className="text-gray-400 font-normal">({invites.length})</span>
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-4 px-5 py-3">
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-gray-900 truncate block">{inv.email}</span>
                </div>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${ROLE_BADGE[inv.role]}`}
                >
                  {ROLE_LABEL[inv.role]}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Sent {timeAgo(inv.created_at)}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Expires{' '}
                  {new Date(inv.expires_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
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

      {/* Permissions — owners only (PR 2b) */}
      {isAdmin && (
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Permissions</h3>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="auto-grant-toggle"
                className="text-sm font-medium text-gray-900 cursor-pointer"
              >
                Auto-grant new members project access
              </label>
              <p
                id="auto-grant-toggle-description"
                className="text-xs text-gray-500 mt-1"
              >
                When on, new org members are automatically given editor access
                on every project. Existing access is sticky — turning this off
                won&apos;t remove anyone&apos;s current access.
              </p>
              {autoGrantBusy === 'disable' && (
                <p className="text-xs text-gray-500 mt-1">Saving…</p>
              )}
              {autoGrantError && autoGrantBusy === 'idle' && !showEnableModal && (
                <p className="text-xs text-red-600 mt-1">{autoGrantError}</p>
              )}
            </div>
            <Switch
              id="auto-grant-toggle"
              checked={autoGrantEnabled}
              onCheckedChange={handleAutoGrantSwitchChange}
              disabled={autoGrantBusy !== 'idle'}
              aria-label="Auto-grant new members project access"
              aria-describedby="auto-grant-toggle-description"
            />
          </div>
        </div>
      )}

      {/* Danger Zone */}
      <div className="bg-white border border-red-200 rounded-xl p-5">
        <p className="text-base font-medium text-red-600 mb-3">Danger zone</p>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-900">Leave organization</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {isLastOwner
                ? 'Transfer ownership to another member before leaving.'
                : 'Remove yourself from this organization. You will lose access to all projects.'}
            </p>
          </div>
          <div className="relative group/leave flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => !isLastOwner && setShowLeaveConfirm(true)}
              disabled={isLastOwner}
              className={`border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400 text-xs ${
                isLastOwner ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Leave organization
            </Button>
            {isLastOwner && (
              <div className="absolute bottom-full right-0 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/leave:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                Transfer ownership before leaving
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Leave confirmation modal */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">
              Leave {org.name}?
            </h2>
            <p className="text-sm text-gray-600 mb-5">
              You will lose access to all projects in this organization. This cannot be undone
              unless an admin re-invites you.
            </p>
            {leaveError && (
              <div className="mb-4 p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                {leaveError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowLeaveConfirm(false)
                  setLeaveError(null)
                }}
                disabled={isLeaving}
                className="text-gray-600"
              >
                Cancel
              </Button>
              <Button
                onClick={handleLeave}
                disabled={isLeaving}
                className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {isLeaving ? 'Leaving…' : 'Leave organization'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-grant enable modal — 3-option flow on OFF→ON (PR 2b) */}
      {showEnableModal && (
        <Modal
          title="Enable auto-grant for new members?"
          onClose={() => {
            if (autoGrantBusy === 'idle') {
              setShowEnableModal(false)
              setAutoGrantError(null)
            }
          }}
        >
          <div className="space-y-3 text-sm text-gray-700">
            <p>
              When auto-grant is on, new members joining this organization
              automatically get editor access on every project. You can also
              backfill existing members now so they get editor access on
              every project they don&apos;t already have.
            </p>
            <p>
              <span className="font-semibold">Backfill is sticky:</span>{' '}
              previously-removed members stay removed. Anyone you&apos;ve
              explicitly removed from a project will not regain access through
              backfill.
            </p>
            <p>
              Turning auto-grant off later won&apos;t revoke any existing
              access — only future fanouts pause.
            </p>
          </div>
          {autoGrantError && (
            <p className="text-xs text-red-600 mt-3">{autoGrantError}</p>
          )}
          <div className="flex flex-col gap-2 mt-6">
            <Button
              onClick={handleEnableAndBackfill}
              disabled={autoGrantBusy !== 'idle'}
              className="bg-primary hover:bg-primary/90 text-white disabled:opacity-50"
            >
              {autoGrantBusy === 'enable-backfill'
                ? 'Enabling…'
                : 'Enable and backfill existing members'}
            </Button>
            <Button
              variant="outline"
              onClick={handleEnableOnly}
              disabled={autoGrantBusy !== 'idle'}
              className="disabled:opacity-50"
            >
              {autoGrantBusy === 'enable-only'
                ? 'Enabling…'
                : "Just enable, don't backfill"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowEnableModal(false)
                setAutoGrantError(null)
              }}
              disabled={autoGrantBusy !== 'idle'}
              className="text-gray-600 disabled:opacity-50"
            >
              Cancel
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
