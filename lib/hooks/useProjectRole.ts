'use client'

import { useEffect, useState } from 'react'
import { getUserProjectRole } from '@/lib/actions/role-resolution'
import type { ProjectRole } from '@/lib/types/organizations'
import { PROJECT_ROLE_HIERARCHY } from '@/lib/types/organizations'

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

  return { role, isLoading, can }
}
