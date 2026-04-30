'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/ui/modal'
import {
  addProjectMember,
  removeProjectMember,
  updateProjectMemberRole,
} from '@/lib/actions/project-members'
import type {
  ProjectMember,
  ProjectRole,
  OrgMembership,
} from '@/lib/types/organizations'

const ROLE_OPTIONS: ProjectRole[] = ['admin', 'editor', 'viewer']

const ROLE_BADGE: Record<ProjectRole, string> = {
  admin: 'bg-purple-100 text-purple-700',
  editor: 'bg-blue-100 text-blue-700',
  viewer: 'bg-gray-100 text-gray-700',
}

interface Props {
  projectId: string
  initialMembers: ProjectMember[]
  initialAvailableOrgMembers: OrgMembership[]
  currentUserId: string
  isAdmin: boolean
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

export default function MembersTab({
  projectId,
  initialMembers,
  initialAvailableOrgMembers,
  currentUserId,
  isAdmin,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Local copy of the list for optimistic updates / refresh-without-reload.
  // After every mutation we call `router.refresh()` which re-runs the
  // server component and re-injects fresh `initialMembers` via prop change.
  // We don't reset state on prop change here; the optimistic mutations
  // already write to local state, so by the time the server data comes
  // back it matches.
  const [members, setMembers] =
    useState<ProjectMember[]>(initialMembers)

  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(
    null
  )

  // Add Member modal state
  const [showAddModal, setShowAddModal] = useState(false)
  const [addUserId, setAddUserId] = useState<string>('')
  const [addRole, setAddRole] = useState<ProjectRole>('editor')
  const [addError, setAddError] = useState<string | null>(null)

  const adminCount = members.filter((m) => m.role === 'admin').length

  const refresh = () => {
    router.refresh()
  }

  const showError = (msg: string | null) => {
    setActionError(msg)
    if (msg) setTimeout(() => setActionError(null), 5000)
  }

  // ── Add member ──────────────────────────────────────────────────────────
  const handleOpenAddModal = () => {
    setAddUserId(initialAvailableOrgMembers[0]?.user_id ?? '')
    setAddRole('editor')
    setAddError(null)
    setShowAddModal(true)
  }

  const handleAddMember = () => {
    if (!addUserId) {
      setAddError('Please select an org member')
      return
    }
    setAddError(null)
    startTransition(async () => {
      const result = await addProjectMember(projectId, addUserId, addRole)
      if (!result.success) {
        setAddError(result.error ?? 'Failed to add member')
        return
      }
      setShowAddModal(false)
      refresh()
    })
  }

  // ── Role change (inline Select, fires on change) ────────────────────────
  const handleRoleChange = (userId: string, newRole: ProjectRole) => {
    const prev = members.find((m) => m.user_id === userId)
    if (!prev || prev.role === newRole) return

    // Optimistic update
    setMembers((cur) =>
      cur.map((m) => (m.user_id === userId ? { ...m, role: newRole } : m))
    )

    startTransition(async () => {
      const result = await updateProjectMemberRole(projectId, userId, newRole)
      if (!result.success) {
        // Roll back optimistic update
        setMembers((cur) =>
          cur.map((m) =>
            m.user_id === userId ? { ...m, role: prev.role } : m
          )
        )
        showError(result.error ?? 'Failed to change role')
        return
      }
      refresh()
    })
  }

  // ── Remove member (inline confirm) ──────────────────────────────────────
  const handleRemove = (userId: string) => {
    startTransition(async () => {
      const result = await removeProjectMember(projectId, userId)
      if (!result.success) {
        showError(result.error ?? 'Failed to remove member')
        setConfirmRemoveUserId(null)
        return
      }
      setConfirmRemoveUserId(null)
      // Optimistic local removal — mirrors what router.refresh() will deliver.
      setMembers((cur) => cur.filter((m) => m.user_id !== userId))
      refresh()
    })
  }

  return (
    <div className="space-y-6">
      {/* Add member CTA (admin-only) */}
      {isAdmin && (
        <div className="flex justify-end">
          <Button
            onClick={handleOpenAddModal}
            disabled={isPending}
            className="bg-primary hover:bg-primary/90 text-white whitespace-nowrap"
          >
            + Add member
          </Button>
        </div>
      )}

      {actionError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Members table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">
            Members{' '}
            <span className="text-gray-400 font-normal">
              ({members.length})
            </span>
          </h3>
        </div>
        <div className="divide-y divide-gray-100">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId
            const isLastAdmin = member.role === 'admin' && adminCount <= 1
            const role = (member.role ?? 'viewer') as ProjectRole
            return (
              <div
                key={member.id}
                className="flex items-center gap-4 px-5 py-3"
              >
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
                    {member.user_email ?? '—'}
                  </span>
                </div>

                {/* Joined */}
                <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block">
                  Joined {timeAgo(member.assigned_at)}
                </span>

                {/* Role */}
                <div className="w-28 flex-shrink-0">
                  {!isAdmin || isSelf ? (
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium capitalize ${ROLE_BADGE[role]}`}
                      title={
                        !isAdmin && !isSelf
                          ? 'Project admins only'
                          : undefined
                      }
                    >
                      {role}
                    </span>
                  ) : (
                    <div className="relative group/role">
                      <Select
                        value={role}
                        onValueChange={(v) =>
                          handleRoleChange(member.user_id, v as ProjectRole)
                        }
                        disabled={isLastAdmin || isPending}
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
                      {isLastAdmin && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/role:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                          At least one admin is required
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Remove */}
                <div className="w-20 flex-shrink-0 text-right">
                  {isAdmin && !isSelf && (
                    <div className="relative group/remove">
                      {confirmRemoveUserId === member.user_id ? (
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => handleRemove(member.user_id)}
                            disabled={isPending}
                            className="text-xs text-red-600 hover:text-red-700 font-medium"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmRemoveUserId(null)}
                            className="text-xs text-gray-400 hover:text-gray-500"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() =>
                            setConfirmRemoveUserId(member.user_id)
                          }
                          disabled={isLastAdmin || isPending}
                          className={`text-xs font-medium ${
                            isLastAdmin
                              ? 'text-gray-300 cursor-not-allowed'
                              : 'text-gray-400 hover:text-red-600'
                          }`}
                        >
                          Remove
                        </button>
                      )}
                      {isLastAdmin && (
                        <div className="absolute bottom-full right-0 mb-1 px-2 py-1 bg-gray-900 text-white text-[10px] rounded opacity-0 group-hover/remove:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                          At least one admin is required
                        </div>
                      )}
                    </div>
                  )}
                </div>
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

      {/* Add Member modal */}
      {showAddModal && (
        <Modal
          title="Add member to project"
          onClose={isPending ? undefined : () => setShowAddModal(false)}
        >
          {addError && (
            <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {addError}
            </div>
          )}
          {initialAvailableOrgMembers.length === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                No org members are available to add. New users must first be
                invited to the organization.
              </p>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  onClick={() => setShowAddModal(false)}
                  className="text-gray-600"
                >
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-3 mb-4">
                <div>
                  <Label className="text-sm text-gray-700 mb-1.5 block">
                    Member
                  </Label>
                  <Select value={addUserId} onValueChange={setAddUserId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an org member" />
                    </SelectTrigger>
                    <SelectContent>
                      {initialAvailableOrgMembers.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          <span className="flex flex-col items-start text-left">
                            <span>{m.user_name || 'Unnamed'}</span>
                            <span className="text-xs text-gray-500">
                              {m.user_email ?? '—'}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-sm text-gray-700 mb-1.5 block">
                    Role
                  </Label>
                  <Select
                    value={addRole}
                    onValueChange={(v) => setAddRole(v as ProjectRole)}
                  >
                    <SelectTrigger>
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
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setShowAddModal(false)}
                  className="text-gray-600"
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAddMember}
                  disabled={!addUserId || isPending}
                  className="bg-primary hover:bg-primary/90 text-white disabled:opacity-50"
                >
                  {isPending ? 'Adding…' : 'Add member'}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

    </div>
  )
}
