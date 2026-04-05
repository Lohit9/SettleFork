'use server'

import { createClient } from '@/lib/supabase/server'
import type { OrgRole } from '@/lib/types/organizations'
import { ROLE_HIERARCHY } from '@/lib/types/organizations'

export async function getUserProjectRole(
  projectId: string
): Promise<OrgRole | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: pmRow } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (pmRow?.role) return pmRow.role as OrgRole

  const { data: orgRole } = await supabase
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .single()

  if (!orgRole?.org_id) return null

  const { data: omRow } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgRole.org_id)
    .eq('user_id', user.id)
    .maybeSingle()

  return (omRow?.role as OrgRole) ?? null
}

export async function checkProjectPermission(
  projectId: string,
  minRole: OrgRole
): Promise<boolean> {
  const role = await getUserProjectRole(projectId)
  if (!role) return false
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minRole]
}

export async function requireProjectPermission(
  projectId: string,
  minRole: OrgRole
): Promise<{ allowed: boolean; error?: string }> {
  const allowed = await checkProjectPermission(projectId, minRole)
  if (!allowed) {
    return { allowed: false, error: `Insufficient permissions. Required role: ${minRole}` }
  }
  return { allowed: true }
}
