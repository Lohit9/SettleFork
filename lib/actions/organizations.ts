'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { getAuthEmailsByIds } from '@/lib/auth/users'
import type { Organization, OrgMembership, OrgRole } from '@/lib/types/organizations'

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${base}-${suffix}`
}

export async function adminCreateOrganization(
  name: string
): Promise<{ org: Organization | null; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { org: null, error: 'Not authenticated' }

  const trimmed = name.trim()
  if (!trimmed) return { org: null, error: 'Organization name is required' }

  const slug = slugify(trimmed)

  const { data: org, error: orgErr } = await supabaseAdmin
    .from('organizations')
    .insert({ name: trimmed, slug, created_by: user.id })
    .select()
    .single()

  if (orgErr || !org) return { org: null, error: orgErr?.message ?? 'Failed to create organization' }

  return { org: org as Organization }
}

export async function getOrganizationsForUser(): Promise<{
  orgs: Array<Organization & { role: OrgRole }>
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { orgs: [], error: 'Not authenticated' }

  const { data, error } = await supabase
    .from('org_memberships')
    .select('role, organizations(id, name, slug, created_at, created_by)')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true })

  if (error) return { orgs: [], error: error.message }

  const orgs = (data ?? [])
    .filter((m: any) => m.organizations)
    .map((m: any) => ({ ...m.organizations, role: m.role as OrgRole }))

  return { orgs }
}

export async function getOrgMembers(
  orgId: string
): Promise<{ members: OrgMembership[]; error?: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('org_memberships')
    .select('id, org_id, user_id, role, joined_at, provisioning_source')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true })

  if (error) return { members: [], error: error.message }

  const userIds = (data ?? []).map((m) => m.user_id)
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name')
    .in('id', userIds.length > 0 ? userIds : ['none'])

  const emailMap = await getAuthEmailsByIds(userIds)

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p.full_name]))

  const members: OrgMembership[] = (data ?? []).map((m) => ({
    ...m,
    role: m.role as OrgRole,
    user_name: profileMap.get(m.user_id) ?? undefined,
    user_email: emailMap.get(m.user_id) ?? undefined,
  }))

  return { members }
}

export async function updateMemberRole(
  orgId: string,
  userId: string,
  newRole: OrgRole
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: callerMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .single()

  if (!callerMem || !['owner', 'admin'].includes(callerMem.role)) {
    return { success: false, error: 'Only owners and admins can change roles' }
  }

  if (newRole !== 'owner') {
    const { count } = await supabase
      .from('org_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('role', 'owner')

    const { data: targetMem } = await supabase
      .from('org_memberships')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single()

    if (targetMem?.role === 'owner' && (count ?? 0) <= 1) {
      return { success: false, error: 'Cannot demote the last owner' }
    }
  }

  const { error } = await supabase
    .from('org_memberships')
    .update({ role: newRole })
    .eq('org_id', orgId)
    .eq('user_id', userId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/app/settings')
  return { success: true }
}

export async function removeMember(
  orgId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: callerMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .single()

  if (!callerMem || !['owner', 'admin'].includes(callerMem.role)) {
    return { success: false, error: 'Only owners and admins can remove members' }
  }

  const { data: targetMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .single()

  if (targetMem?.role === 'owner') {
    const { count } = await supabase
      .from('org_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('role', 'owner')

    if ((count ?? 0) <= 1) {
      return { success: false, error: 'Cannot remove the last owner' }
    }
  }

  const { data: orgProjects } = await supabase
    .from('projects')
    .select('id')
    .eq('org_id', orgId)

  if (orgProjects && orgProjects.length > 0) {
    const projectIds = orgProjects.map((p) => p.id)
    await supabaseAdmin
      .from('project_members')
      .delete()
      .eq('user_id', userId)
      .in('project_id', projectIds)
  }

  const { error } = await supabase
    .from('org_memberships')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', userId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/app/settings')
  return { success: true }
}

export async function adminGetOrgMembers(orgId: string): Promise<{
  success: boolean
  error?: string
  members: Array<{ id: string; user_id: string; role: OrgRole; joined_at: string; user_name: string; user_email: string }>
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return { success: false, error: admin.error, members: [] }
  }

  // Step 1: Get memberships — no join (profiles has no direct FK from org_memberships)
  const { data, error } = await supabaseAdmin
    .from('org_memberships')
    .select('id, role, joined_at, user_id')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true })

  if (error) return { success: false, error: error.message, members: [] }
  if (!data || data.length === 0) return { success: true, members: [] }

  // Step 2: Fetch profile names via direct PK lookup
  const userIds = data.map((m) => m.user_id)
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name')
    .in('id', userIds)

  const nameMap = new Map((profiles ?? []).map((p) => [p.id, p.full_name]))

  // Step 3: Fetch emails from auth.users via SECURITY DEFINER RPC
  const emailMap = await getAuthEmailsByIds(userIds)

  // Step 4: Assemble
  const members = data.map((m) => ({
    id: m.id,
    user_id: m.user_id,
    role: m.role as OrgRole,
    joined_at: m.joined_at,
    user_name: nameMap.get(m.user_id) ?? 'Unknown',
    user_email: emailMap.get(m.user_id) ?? 'Unknown',
  }))

  return { success: true, members }
}

export async function updateOrganization(
  orgId: string,
  name: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const trimmed = name.trim()
  if (!trimmed) return { success: false, error: 'Organization name is required' }

  const { error } = await supabase
    .from('organizations')
    .update({ name: trimmed, slug: slugify(trimmed) })
    .eq('id', orgId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/app/settings')
  revalidatePath('/app/settings/organization')
  return { success: true }
}

export async function leaveOrganization(
  orgId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Check if user is the last owner — block leaving if so
  const { data: owners } = await supabase
    .from('org_memberships')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('role', 'owner')

  const isLastOwner =
    (owners ?? []).length === 1 && owners![0].user_id === user.id

  if (isLastOwner) {
    return {
      success: false,
      error: 'You are the only owner. Transfer ownership to another member before leaving.',
    }
  }

  const { error } = await supabase
    .from('org_memberships')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', user.id)

  if (error) return { success: false, error: error.message }

  revalidatePath('/app/settings/organization')
  revalidatePath('/app/projects')
  return { success: true }
}
