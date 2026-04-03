'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import type { OrgInvite, OrgRole } from '@/lib/types/organizations'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://trymine.ai'

export async function createOrgInvite(
  orgId: string,
  email: string,
  role: OrgRole
): Promise<{ invite: OrgInvite | null; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { invite: null, error: 'Not authenticated' }

  const { data: callerMem } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .single()

  if (!callerMem || !['owner', 'admin'].includes(callerMem.role)) {
    return { invite: null, error: 'Only owners and admins can invite members' }
  }

  const { data: existingMember } = await supabaseAdmin
    .from('org_memberships')
    .select('id')
    .eq('org_id', orgId)
    .eq('user_id', (
      await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    ).data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? 'none')
    .maybeSingle()

  if (existingMember) {
    return { invite: null, error: 'This user is already a member of the organization' }
  }

  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 32)

  const { data: invite, error } = await supabase
    .from('org_invites')
    .insert({
      org_id: orgId,
      email: email.trim().toLowerCase(),
      role,
      token: token.slice(0, 64),
      invited_by: user.id,
    })
    .select()
    .single()

  if (error || !invite) return { invite: null, error: error?.message ?? 'Failed to create invite' }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()

  const inviterName = user.user_metadata?.full_name || user.email || 'A team member'

  try {
    const res = await fetch(`${APP_URL}/api/notify-access-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'org-invite',
        email: email.trim().toLowerCase(),
        orgName: org?.name ?? 'your team',
        role,
        inviterName,
        token: invite.token,
      }),
    })
    if (!res.ok) {
      const errBody = await res.text()
      console.error('[createOrgInvite] Email send failed:', res.status, errBody)
    }
  } catch (err) {
    console.error('[createOrgInvite] Email fetch failed:', err)
  }

  revalidatePath('/app/settings')
  return { invite: invite as OrgInvite }
}

export async function getPendingInvites(
  orgId: string
): Promise<{ invites: OrgInvite[]; error?: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('org_invites')
    .select('*')
    .eq('org_id', orgId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })

  if (error) return { invites: [], error: error.message }
  return { invites: (data ?? []) as OrgInvite[] }
}

export async function revokeInvite(
  inviteId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('org_invites')
    .delete()
    .eq('id', inviteId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/app/settings')
  return { success: true }
}

export async function getInviteByToken(
  token: string
): Promise<{ invite: OrgInvite | null; error?: string }> {
  const { data, error } = await supabaseAdmin
    .from('org_invites')
    .select('*, organizations(name)')
    .eq('token', token)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (error || !data) return { invite: null, error: 'Invite not found or expired' }

  const { data: inviterProfile } = await supabaseAdmin
    .from('profiles')
    .select('full_name')
    .eq('id', data.invited_by)
    .maybeSingle()

  const invite: OrgInvite = {
    ...(data as any),
    org_name: (data as any).organizations?.name ?? undefined,
    inviter_name: inviterProfile?.full_name ?? undefined,
  }

  return { invite }
}

export async function acceptInvite(
  token: string,
  userId: string
): Promise<{ orgId: string; orgName: string; error?: string }> {
  const { data: invite, error: fetchErr } = await supabaseAdmin
    .from('org_invites')
    .select('*, organizations(name)')
    .eq('token', token)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (fetchErr || !invite) {
    return { orgId: '', orgName: '', error: 'Invite not found, expired, or already accepted' }
  }

  const { data: existingMem } = await supabaseAdmin
    .from('org_memberships')
    .select('id')
    .eq('org_id', invite.org_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!existingMem) {
    const { error: memErr } = await supabaseAdmin
      .from('org_memberships')
      .insert({
        org_id: invite.org_id,
        user_id: userId,
        role: invite.role,
        invited_by: invite.invited_by,
        invited_at: invite.created_at,
      })

    if (memErr) return { orgId: '', orgName: '', error: memErr.message }
  }

  await supabaseAdmin
    .from('org_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)

  const orgName = (invite as any).organizations?.name ?? ''
  return { orgId: invite.org_id, orgName }
}
