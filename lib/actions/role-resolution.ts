'use server'

import { createClient } from '@/lib/supabase/server'
import type { ProjectRole } from '@/lib/types/organizations'
import { PROJECT_ROLE_HIERARCHY } from '@/lib/types/organizations'

// Project access is determined ONLY by `project_members` membership after
// migration 079. Org membership is no longer a fallback. This file mirrors
// the server-side SQL helpers (`get_user_project_role` / `user_has_project_role`)
// for use in Server Actions where calling an RPC adds latency for no benefit.
//
// Auto-grant rules (writes to project_members) live in lib/actions/projects.ts,
// lib/actions/org-invites.ts, lib/actions/organizations.ts, and the SQL
// helpers in migration 079 §J. This file is read-only.

export async function getUserProjectRole(
  projectId: string
): Promise<ProjectRole | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: pmRow } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .maybeSingle()

  // No org-role fallback — strict project_members membership only.
  return (pmRow?.role as ProjectRole | null) ?? null
}

export async function checkProjectPermission(
  projectId: string,
  minRole: ProjectRole
): Promise<boolean> {
  const role = await getUserProjectRole(projectId)
  if (!role) return false
  return PROJECT_ROLE_HIERARCHY[role] >= PROJECT_ROLE_HIERARCHY[minRole]
}

export async function requireProjectPermission(
  projectId: string,
  minRole: ProjectRole
): Promise<{ allowed: boolean; error?: string }> {
  const allowed = await checkProjectPermission(projectId, minRole)
  if (!allowed) {
    return { allowed: false, error: `Insufficient permissions. Required role: ${minRole}` }
  }
  return { allowed: true }
}
