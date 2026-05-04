'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { enrichWithUserIdentity } from '@/lib/auth/users'
import { logActivity } from '@/lib/actions/activity-log'
import type {
  ProjectMember,
  ProjectRole,
  OrgMembership,
  OrgRole,
} from '@/lib/types/organizations'

// ─── Project-level member management (PR 2a) ────────────────────────────────
//
// Five actions back the project settings → Members tab UI. Permission model:
//
//   getProjectMembers / getOrgMembersAvailableForProject:
//     - List read; gated by `requireProjectPermission(projectId, 'viewer')`.
//       Anyone with project access can see who else is on the project.
//
//   addProjectMember / removeProjectMember / updateProjectMemberRole:
//     - Write/mutate; gated by `requireProjectPermission(projectId, 'admin')`.
//       Only project admins can change membership.
//
// Last-admin guard
//   `removeProjectMember` and demote-paths in `updateProjectMemberRole` both
//   COUNT current 'admin' rows before mutating; <= 1 means the operation is
//   refused. The check + mutation are NOT atomic — see the JSDoc on each
//   mutation function for the documented race-condition trade-off.
//
// Activity log
//   Three new event types fan out via `logActivity`:
//     - project_member_added         (target_user_id, role)
//     - project_member_removed       (target_user_id, previous_role)
//     - project_member_role_changed  (target_user_id, from_role, to_role)
//   Categorized under `'system'`; emit is best-effort (logActivity itself
//   wraps in try/catch so a logging failure never blocks the parent action).

// ─── 1. getProjectMembers ───────────────────────────────────────────────────

/**
 * List the members of a project, enriched with display name + email.
 *
 * Implementation mirrors `getOrgMembers` in `organizations.ts`:
 *   1. SSR client SELECT from `project_members` (RLS-active).
 *   2. `enrichWithUserIdentity` (lib/auth/users.ts) joins
 *      profiles.full_name + auth.users.email into the rows.
 *
 * Filters out rows with `role IS NULL` per the design note in
 * `lib/types/organizations.ts:80`. The DB allows NULL roles for legacy
 * back-compat; the UI renders only fully-typed rows.
 */
export async function getProjectMembers(
  projectId: string
): Promise<{ members: ProjectMember[]; error?: string }> {
  const gate = await requireProjectPermission(projectId, 'viewer')
  if (!gate.allowed) {
    return { members: [], error: gate.error }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_members')
    .select('id, project_id, user_id, role, assigned_at')
    .eq('project_id', projectId)
    .not('role', 'is', null)
    .order('assigned_at', { ascending: true })

  if (error) return { members: [], error: error.message }

  const baseRows = (data ?? []).map((m) => ({
    id: m.id,
    project_id: m.project_id,
    user_id: m.user_id,
    role: m.role as ProjectRole,
    assigned_at: m.assigned_at,
  }))

  const members = (await enrichWithUserIdentity(
    baseRows,
    'user_id',
  )) as ProjectMember[]

  return { members }
}

// ─── 2. addProjectMember ────────────────────────────────────────────────────

/**
 * Add an org member to a project.
 *
 * Validations (in order; first failure short-circuits):
 *   1. Caller must hold `requireProjectPermission(projectId, 'admin')`.
 *   2. Target user must already be a member of the project's org. We do
 *      NOT auto-invite; new users still flow through `org_invites` first.
 *   3. Target must NOT already be on the project. ON CONFLICT failure is
 *      surfaced as a friendly error — the picker UI hides existing
 *      members so this should rarely fire in practice.
 *
 * On success, fans out an `activity_log` row and revalidates the
 * settings page + the project layout (the role hook on every subpage
 * picks up the new role).
 *
 * Race-condition trade-off: validations are read-then-write without a
 * lock. A concurrent `removeProjectMember` could theoretically delete
 * the row between our existence check and the INSERT, in which case the
 * INSERT just lands. A concurrent `addProjectMember` for the same
 * (project, user) would let one win and the other receive a unique-key
 * violation; the friendly "User already has access" message ships
 * either way. Acceptable; see `removeProjectMember` JSDoc for the
 * deeper discussion.
 */
export async function addProjectMember(
  projectId: string,
  userId: string,
  role: ProjectRole
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireProjectPermission(projectId, 'admin')
  if (!gate.allowed) return { success: false, error: gate.error }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Validate target is in the project's org.
  const { data: project, error: projectErr } = await supabase
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .single()

  if (projectErr || !project) {
    return { success: false, error: 'Project not found' }
  }

  const { data: orgMembership } = await supabase
    .from('org_memberships')
    .select('id')
    .eq('org_id', project.org_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!orgMembership) {
    return {
      success: false,
      error: 'User must be a member of this organization',
    }
  }

  // Validate target not already on this project.
  const { data: existingMember } = await supabase
    .from('project_members')
    .select('id')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existingMember) {
    return { success: false, error: 'User already has access' }
  }

  const { error: insertErr } = await supabase
    .from('project_members')
    .insert({
      project_id: projectId,
      user_id: userId,
      role,
      assigned_by: user.id,
    })

  if (insertErr) {
    return { success: false, error: insertErr.message }
  }

  await logActivity(
    projectId,
    'project_member_added',
    `Project member added (role: ${role})`,
    'system',
    { target_user_id: userId, role }
  )

  revalidatePath(`/app/projects/${projectId}/settings`)
  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

// ─── 3. removeProjectMember ─────────────────────────────────────────────────

/**
 * Remove a member from a project.
 *
 * Last-admin guard: if the target is currently `'admin'`, refuses when
 * the COUNT of admins on this project is <= 1.
 *
 * RACE-CONDITION NOTE
 *   The COUNT check and the DELETE are NOT atomic. A concurrent
 *   `updateProjectMemberRole` demote (admin → editor) on the OTHER
 *   admin could theoretically pass its own count-check and complete
 *   between our SELECT and our DELETE, leaving the project with zero
 *   admins. The window is sub-millisecond and the failure is recoverable:
 *   any org owner is auto-granted project-admin via
 *   `grant_new_org_member_project_access` on the next event involving
 *   them, and the org's auto-grant toggle (PR 2b) can backfill on
 *   demand. Future hardening: convert this guard to a SECURITY DEFINER
 *   RPC that does `SELECT … FOR UPDATE` on the admin rows before the
 *   DELETE, eliminating the window. Not required for PR 2a's traffic
 *   profile.
 */
export async function removeProjectMember(
  projectId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireProjectPermission(projectId, 'admin')
  if (!gate.allowed) return { success: false, error: gate.error }

  const supabase = await createClient()

  // Read target's current role for the activity-log emit + last-admin guard.
  const { data: targetRow } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!targetRow) {
    return { success: false, error: 'Member not found on this project' }
  }

  const previousRole = targetRow.role as ProjectRole | null

  if (previousRole === 'admin') {
    const { count } = await supabase
      .from('project_members')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('role', 'admin')

    if ((count ?? 0) <= 1) {
      return {
        success: false,
        error: 'Cannot remove the last admin from this project',
      }
    }
  }

  const { error: deleteErr } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId)

  if (deleteErr) {
    return { success: false, error: deleteErr.message }
  }

  await logActivity(
    projectId,
    'project_member_removed',
    `Project member removed (was ${previousRole ?? 'unknown'})`,
    'system',
    { target_user_id: userId, previous_role: previousRole }
  )

  revalidatePath(`/app/projects/${projectId}/settings`)
  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

// ─── 4. updateProjectMemberRole ─────────────────────────────────────────────

/**
 * Change a member's project role.
 *
 * Idempotent: same role → returns `{ success: true }` without a write.
 *
 * Last-admin guard fires only on demote-from-admin paths
 * (`current === 'admin' && newRole !== 'admin'`). Same race-condition
 * trade-off as `removeProjectMember` — see that function's JSDoc.
 */
export async function updateProjectMemberRole(
  projectId: string,
  userId: string,
  newRole: ProjectRole
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireProjectPermission(projectId, 'admin')
  if (!gate.allowed) return { success: false, error: gate.error }

  const supabase = await createClient()

  const { data: targetRow } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!targetRow) {
    return { success: false, error: 'Member not found on this project' }
  }

  const currentRole = targetRow.role as ProjectRole | null

  if (currentRole === newRole) {
    // Idempotent no-op
    return { success: true }
  }

  if (currentRole === 'admin' && newRole !== 'admin') {
    const { count } = await supabase
      .from('project_members')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('role', 'admin')

    if ((count ?? 0) <= 1) {
      return {
        success: false,
        error: 'Cannot demote the last admin on this project',
      }
    }
  }

  const { error: updateErr } = await supabase
    .from('project_members')
    .update({ role: newRole })
    .eq('project_id', projectId)
    .eq('user_id', userId)

  if (updateErr) {
    return { success: false, error: updateErr.message }
  }

  await logActivity(
    projectId,
    'project_member_role_changed',
    `Project member role changed: ${currentRole ?? 'unknown'} → ${newRole}`,
    'system',
    { target_user_id: userId, from_role: currentRole, to_role: newRole }
  )

  revalidatePath(`/app/projects/${projectId}/settings`)
  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

// ─── 5. getOrgMembersAvailableForProject ────────────────────────────────────

/**
 * Picker source for the Add Member modal.
 *
 * Returns org_memberships for `orgId` MINUS user_ids already on
 * `project_members` for `projectId`. Filtering happens server-side
 * (SQL) so the picker only ever sees candidates — no client-side
 * de-duping needed. Authorization gate is `'admin'` (only admins open
 * the picker, so the read is acceptable to deny to viewers/editors).
 *
 * Enrichment (name/email) follows the same 3-step pattern as
 * `getProjectMembers`.
 */
export async function getOrgMembersAvailableForProject(
  projectId: string,
  orgId: string
): Promise<{ members: OrgMembership[]; error?: string }> {
  const gate = await requireProjectPermission(projectId, 'admin')
  if (!gate.allowed) return { members: [], error: gate.error }

  const supabase = await createClient()

  // Existing project members (just the user_ids — drives the NOT IN filter).
  const { data: existingMembers, error: existingErr } = await supabase
    .from('project_members')
    .select('user_id')
    .eq('project_id', projectId)

  if (existingErr) return { members: [], error: existingErr.message }

  const existingIds = (existingMembers ?? []).map((m) => m.user_id)

  // Build the org_memberships query, filtering out already-members.
  let query = supabase
    .from('org_memberships')
    .select('id, org_id, user_id, role, joined_at, provisioning_source')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true })

  if (existingIds.length > 0) {
    // Postgrest IN filter — wrap the value list in `(...)`.
    query = query.not('user_id', 'in', `(${existingIds.join(',')})`)
  }

  const { data, error } = await query
  if (error) return { members: [], error: error.message }

  const baseRows = (data ?? []).map((m) => ({
    id: m.id,
    org_id: m.org_id,
    user_id: m.user_id,
    role: m.role as OrgRole,
    joined_at: m.joined_at,
    provisioning_source: m.provisioning_source,
  }))

  const members = (await enrichWithUserIdentity(
    baseRows,
    'user_id',
  )) as OrgMembership[]

  return { members }
}
