'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

// ── constants ─────────────────────────────────────────────────────────────

const ADMIN_EMAILS = ['kaandincer1@gmail.com']

// Safe chars: exclude 0/O, 1/I/L to avoid confusion
const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://trymine.ai'

// ── helpers ───────────────────────────────────────────────────────────────

function generateCode(): string {
  let code = 'MINE-'
  for (let i = 0; i < 6; i++) {
    code += SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)]
  }
  return code
}

async function uniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode()
    const { data } = await supabaseAdmin
      .from('invites')
      .select('id')
      .eq('code', code)
      .maybeSingle()
    if (!data) return code
  }
  throw new Error('Could not generate a unique invite code. Please try again.')
}

async function assertAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !ADMIN_EMAILS.includes(user.email ?? '')) {
    throw new Error('Unauthorized')
  }
  return user
}

// ── public: invite validation (called from signup flow) ───────────────────

export async function validateInviteCode(code: string): Promise<{
  valid: boolean
  inviteId?: string
  error?: string
}> {
  if (!code?.trim()) {
    return { valid: false, error: 'An invite code is required to sign up.' }
  }

  const { data, error } = await supabaseAdmin
    .from('invites')
    .select('id, status, expires_at')
    .eq('code', code.trim().toUpperCase())
    .maybeSingle()

  if (error || !data) {
    return { valid: false, error: 'Invalid invite code. Need access? Request it at trymine.ai/request-access' }
  }
  if (data.status === 'used') {
    return { valid: false, error: 'This invite code has already been used.' }
  }
  if (data.status === 'expired' || new Date(data.expires_at) < new Date()) {
    return { valid: false, error: 'This invite code has expired. Request fresh access at trymine.ai/request-access' }
  }
  if (data.status !== 'pending') {
    return { valid: false, error: 'Invalid or expired invite code. Need access? Request it at trymine.ai/request-access' }
  }

  return { valid: true, inviteId: data.id }
}

export async function markInviteUsed(code: string, userId: string): Promise<void> {
  await supabaseAdmin
    .from('invites')
    .update({ status: 'used', used_by: userId, used_at: new Date().toISOString() })
    .eq('code', code.trim().toUpperCase())
    .eq('status', 'pending') // atomic guard: only update if still pending
}

// ── public: access request submission ────────────────────────────────────

export async function submitAccessRequest(data: {
  name: string
  email: string
  company: string
  role_type: string
  systems_involved?: string
  additional_notes?: string
  ref?: string
}): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabaseAdmin.from('access_requests').insert({
    name: data.name.trim(),
    email: data.email.trim().toLowerCase(),
    company: data.company.trim(),
    role_type: data.role_type,
    systems_involved: data.systems_involved?.trim() || null,
    additional_notes: data.additional_notes?.trim() || null,
  })

  if (error) {
    return { success: false, error: 'Something went wrong. Please try again or email us at kaan@trymine.ai' }
  }

  // Fire notification (non-blocking)
  try {
    await fetch(`${APP_URL}/api/notify-access-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  } catch {
    // Non-blocking: DB insert is the source of truth
  }

  return { success: true }
}

// ── admin: generate invite code ───────────────────────────────────────────

export async function generateInviteCode(
  email?: string,
  name?: string,
  company?: string
): Promise<{ code: string; signupUrl: string; error?: string }> {
  const user = await assertAdmin()

  const code = await uniqueCode()

  const { error } = await supabaseAdmin.from('invites').insert({
    code,
    email: email?.trim().toLowerCase() || null,
    name: name?.trim() || null,
    company: company?.trim() || null,
    created_by: user.id,
  })

  if (error) return { code: '', signupUrl: '', error: error.message }

  revalidatePath('/admin/invites')
  return { code, signupUrl: `${APP_URL}/signup?invite=${code}` }
}

// ── admin: update access request status ──────────────────────────────────

export async function updateAccessRequestStatus(
  requestId: string,
  status: 'contacted' | 'approved' | 'declined'
): Promise<{ success: boolean; error?: string }> {
  await assertAdmin()

  const { error } = await supabaseAdmin
    .from('access_requests')
    .update({ status })
    .eq('id', requestId)

  if (error) return { success: false, error: error.message }
  revalidatePath('/admin/invites')
  return { success: true }
}

// ── admin: approve request + generate invite in one action ────────────────

export async function approveAndGenerateInvite(
  requestId: string
): Promise<{ code: string; signupUrl: string; error?: string }> {
  const user = await assertAdmin()

  const { data: request, error: fetchError } = await supabaseAdmin
    .from('access_requests')
    .select('*')
    .eq('id', requestId)
    .single()

  if (fetchError || !request) {
    return { code: '', signupUrl: '', error: 'Access request not found.' }
  }

  const code = await uniqueCode()

  const { error: inviteError } = await supabaseAdmin.from('invites').insert({
    code,
    email: request.email,
    name: request.name,
    company: request.company,
    created_by: user.id,
  })

  if (inviteError) return { code: '', signupUrl: '', error: inviteError.message }

  await supabaseAdmin
    .from('access_requests')
    .update({ status: 'approved' })
    .eq('id', requestId)

  const signupUrl = `${APP_URL}/signup?invite=${code}`

  // Fire invite email (non-blocking — clipboard copy is the fallback)
  try {
    await fetch(`${APP_URL}/api/notify-access-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'invite',
        name: request.name,
        email: request.email,
        company: request.company,
        signup_url: signupUrl,
      }),
    })
  } catch (err) {
    console.error('Invite email failed (non-blocking):', err)
  }

  revalidatePath('/admin/invites')
  return { code, signupUrl }
}
