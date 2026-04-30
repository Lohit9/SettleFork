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

  // Tightened in migration 079: only org owners can change roles. Pre-079
  // this accepted owners + admins, but the 'admin' org-role no longer exists
  // (admin → owner in the rename). The org RLS update policy on
  // org_memberships also enforces this, but we check here so the error
  // message is friendly and we avoid a wasted SELECT before the gated UPDATE.
  const { data: callerMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .single()

  if (!callerMem || callerMem.role !== 'owner') {
    return { success: false, error: 'Only owners can change roles' }
  }

  const { data: targetMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .single()

  const prevRole = (targetMem?.role ?? null) as OrgRole | null
  if (prevRole === null) return { success: false, error: 'Member not found' }

  if (prevRole === newRole) return { success: true }

  // Last-owner safeguard. Only relevant when demoting away from 'owner'.
  if (prevRole === 'owner' && newRole !== 'owner') {
    const { count } = await supabase
      .from('org_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('role', 'owner')

    if ((count ?? 0) <= 1) {
      return { success: false, error: 'Cannot demote the last owner' }
    }
  }

  const { error } = await supabase
    .from('org_memberships')
    .update({ role: newRole })
    .eq('org_id', orgId)
    .eq('user_id', userId)

  if (error) return { success: false, error: error.message }

  // Migration 079: when promoting member → owner, fan out project-admin
  // rows for every project in the org (ON CONFLICT DO NOTHING). Demotion
  // owner → member intentionally does NOT remove project_members rows —
  // stickiness rule keeps the user's existing access until an explicit
  // removal runs. See migration 079 §J.2.
  if (newRole === 'owner' && prevRole !== 'owner') {
    const { error: fanoutErr } = await supabase.rpc(
      'grant_new_org_member_project_access',
      { p_user_id: userId, p_org_id: orgId, p_role: 'owner' }
    )
    if (fanoutErr) {
      // Role update already committed. Surface the error for ops
      // triage but don't roll back the role change — re-running the
      // action is idempotent.
      console.error(
        '[updateMemberRole] owner-promotion fanout failed (role updated, project access incomplete):',
        fanoutErr
      )
    }
  }

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

  // Tightened in migration 079: only org owners can remove members.
  const { data: callerMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .single()

  if (!callerMem || callerMem.role !== 'owner') {
    return { success: false, error: 'Only owners can remove members' }
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

/**
 * Toggle the per-org `member_auto_grant_enabled` flag (migration 079).
 *
 * Pure column toggle: this action does NOT backfill, fan out, or remove
 * any project_members rows. It only updates `organizations.member_
 * auto_grant_enabled`. Backfilling existing members onto existing
 * projects is a separate, explicit step — see
 * `backfillOrgMemberProjectAccess`. The split (PR 2b) lets the UI ask
 * the owner whether to backfill on OFF→ON instead of doing it
 * automatically.
 *
 * Effect of the flag (consumed by 079 §J fanout RPCs):
 *   - Owners are auto-granted project-admin on every project regardless
 *     of this flag.
 *   - Members are auto-granted project-editor on every project IFF this
 *     flag is TRUE at the time the auto-grant fires (project creation,
 *     invite acceptance, JIT provisioning).
 *
 * Stickiness: turning the flag OFF does NOT remove any existing
 * project_members rows. The flag only gates future auto-grants.
 *
 * Authorization: org owner only. Caller-side check here is duplicated
 * by the organizations UPDATE RLS policy (which uses
 * get_user_admin_org_ids → role='owner' post-079).
 */
export async function setOrgMemberAutoGrant(
  orgId: string,
  enabled: boolean
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

  if (!callerMem || callerMem.role !== 'owner') {
    return { success: false, error: 'Only owners can change this setting' }
  }

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('member_auto_grant_enabled')
    .eq('id', orgId)
    .single()

  if (!orgRow) return { success: false, error: 'Organization not found' }
  const prev = orgRow.member_auto_grant_enabled as boolean
  if (prev === enabled) return { success: true }

  const { error } = await supabase
    .from('organizations')
    .update({ member_auto_grant_enabled: enabled })
    .eq('id', orgId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/app/settings')
  revalidatePath('/app/settings/organization')
  return { success: true }
}

/**
 * Backfill project-editor rows for every (member × project) pair in
 * the org. Idempotent and sticky: every insert uses ON CONFLICT
 * (project_id, user_id) DO NOTHING, so previously-removed members stay
 * removed.
 *
 * Calls migration 079 §J.3's `backfill_org_member_project_access` RPC,
 * which inserts editor rows only for `om.role = 'member'`. Owners are
 * out of scope here because they are auto-fanned-out as project-admin
 * via `grant_new_org_member_project_access('owner')` at promotion time.
 *
 * The RPC does NOT consult `organizations.member_auto_grant_enabled` —
 * the caller decides. PR 2b's UI offers this as the "Enable and
 * backfill" option in the OFF→ON modal, after `setOrgMemberAutoGrant`
 * has already flipped the column.
 *
 * Authorization: org owner only.
 *
 * Note: org-scoped activity_log audit deferred — `activity_log` is
 * currently project-scoped (NOT NULL `project_id`). Adding org-scoped
 * audit requires a schema change tracked in a separate PR.
 */
export async function backfillOrgMemberProjectAccess(
  orgId: string
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

  if (!callerMem || callerMem.role !== 'owner') {
    return { success: false, error: 'Only owners can backfill project access' }
  }

  const { error: rpcError } = await supabase.rpc(
    'backfill_org_member_project_access',
    { p_org_id: orgId }
  )

  if (rpcError) return { success: false, error: rpcError.message }

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
