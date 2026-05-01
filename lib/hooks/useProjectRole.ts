'use client'

import { useEffect, useState } from 'react'
import { getUserProjectRole } from '@/lib/actions/role-resolution'
import type { ProjectRole } from '@/lib/types/organizations'
import { PROJECT_ROLE_HIERARCHY } from '@/lib/types/organizations'

/**
 * useProjectRole — read the current user's role for a given project
 *
 * Returns:
 * - role: 'admin' | 'editor' | 'viewer' | null. Null = no access (not a member).
 * - isLoading: true while the role fetch is in flight
 * - isReady: convenience inverse of isLoading
 * - isAdmin / isEditor / isViewer: exact-role match booleans (mutually exclusive)
 * - can(action): hierarchical role check. 'manage' >= admin, 'edit' >= editor, 'view' >= viewer
 *
 * Pattern recommendations:
 * - Use can('edit') / can('manage') for hierarchical permission checks (most common)
 * - Use isAdmin / isEditor / isViewer when behavior depends on EXACT role
 * - Use isReady to suppress paint flicker before role resolves
 *
 * Null role handling: returns false for can() and false for all isAdmin/isEditor/isViewer.
 * Fail-closed defaults make this safe to use without isReady gating in most cases.
 */
export function useProjectRole(projectId: string) {
  const [role, setRole] = useState<ProjectRole | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIsLoading(true)
    getUserProjectRole(projectId).then((r) => {
      setRole(r)
      setIsLoading(false)
    }).catch(() => setIsLoading(false))
  }, [projectId])

  const can = (action: 'view' | 'edit' | 'manage'): boolean => {
    if (!role) return false
    const minRole: Record<typeof action, ProjectRole> = {
      view: 'viewer',
      edit: 'editor',
      manage: 'admin',
    }
    return PROJECT_ROLE_HIERARCHY[role] >= PROJECT_ROLE_HIERARCHY[minRole[action]]
  }

  return {
    role,
    isLoading,
    isReady: !isLoading,
    isAdmin: role === 'admin',
    isEditor: role === 'editor',
    isViewer: role === 'viewer',
    can,
  }
}
