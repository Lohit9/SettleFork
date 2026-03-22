'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { checkSignupRateLimit } from '@/lib/auth/signup-rate-limit'
import { validateInviteCode, markInviteUsed } from '@/lib/actions/invites'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://trymine.ai'

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
}

// ── signUpWithBotProtection ───────────────────────────────────────────────────

export interface SignUpPayload {
  fullName: string
  companyName?: string
  email: string
  password: string
  companySize?: string
  role?: string
  /** Invite code — required for access. */
  inviteCode: string
  /** Honeypot field — must be empty. Hidden from real users. */
  website: string
  /** Unix ms timestamp of when the signup page loaded, as a string. */
  loadedAt: string
}

export interface SignUpResult {
  success: boolean
  requiresEmailVerification?: boolean
  error?: string
}

export async function signUpWithBotProtection(payload: SignUpPayload): Promise<SignUpResult> {
  // 1. Honeypot check — bots auto-fill every field; real users never see this.
  //    Silently fake success so the bot doesn't learn our protection exists.
  if (payload.website !== '') {
    return { success: true, requiresEmailVerification: true }
  }

  // 2. Minimum time check — bots submit instantly; real users take > 2s.
  const loadedAt = parseInt(payload.loadedAt, 10)
  if (!isNaN(loadedAt) && Date.now() - loadedAt < 2000) {
    return { success: false, error: 'Form submitted too quickly. Please try again.' }
  }

  // 3. IP-based rate limit — max 3 attempts per IP per hour.
  const headersList = await headers()
  const ip =
    headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headersList.get('x-real-ip') ??
    '127.0.0.1'

  const rateLimit = checkSignupRateLimit(ip)
  if (!rateLimit.allowed) {
    return { success: false, error: rateLimit.error }
  }

  // 4. Validate invite code.
  const invite = await validateInviteCode(payload.inviteCode)
  if (!invite.valid) {
    return { success: false, error: invite.error }
  }

  // 5. Actual Supabase signup.
  const supabase = await createClient()
  const { data: authData, error: signUpError } = await supabase.auth.signUp({
    email: payload.email,
    password: payload.password,
    options: {
      data: {
        full_name: payload.fullName,
        company_name: payload.companyName ?? '',
        company_size: payload.companySize ?? '',
        role: payload.role ?? '',
      },
    },
  })

  if (signUpError) {
    if (signUpError.message.includes('already registered')) {
      return {
        success: false,
        error: 'An account with this email already exists. Please sign in instead.',
      }
    }
    if (signUpError.message.includes('password')) {
      return {
        success: false,
        error: 'Password does not meet requirements. Please use a stronger password.',
      }
    }
    return { success: false, error: 'Unable to create account. Please try again.' }
  }

  // 6. Mark invite as used (atomic guard prevents double-use).
  if (authData.user) {
    await markInviteUsed(payload.inviteCode, authData.user.id)

    // 7. Fetch invite details (name/company) for the notification email.
    //    Non-blocking — failure here must never affect the signup result.
    try {
      const { data: invite } = await supabaseAdmin
        .from('invites')
        .select('name, company')
        .eq('code', payload.inviteCode.trim().toUpperCase())
        .maybeSingle()

      await resend.emails.send({
        from: 'Mine Notifications <contact@trymine.ai>',
        to: 'contact@trymine.ai',
        replyTo: 'contact@trymine.ai',
        subject: `New Mine Signup: ${payload.email}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 24px;">
            <h2 style="font-size: 20px; font-weight: 700; color: #0F172A; margin: 0 0 16px 0;">New User Signed Up</h2>
            <table style="width: 100%; border-collapse: collapse; border: 1px solid #E2E8F0;">
              <tr><td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Email</td>
                  <td style="padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #E2E8F0;"><a href="mailto:${payload.email}" style="color:#2563EB;">${payload.email}</a></td></tr>
              <tr><td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Name</td>
                  <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${invite?.name || payload.fullName || 'Not provided'}</td></tr>
              <tr><td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Company</td>
                  <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${invite?.company || 'Not provided'}</td></tr>
              <tr><td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569;">Invite Code</td>
                  <td style="padding: 10px 14px; font-size: 13px; font-family: monospace; color: #0F172A;">${payload.inviteCode}</td></tr>
            </table>
            <p style="margin-top: 16px; font-size: 14px; color: #475569;">They can now log in. Reach out to schedule their onboarding session.</p>
            <div style="margin-top: 16px;">
              <a href="${APP_URL}/admin/invites"
                 style="display: inline-block; background: #4F46E5; color: white; padding: 11px 22px; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
                View Admin Dashboard →
              </a>
            </div>
          </div>
        `,
      })
    } catch (notifyErr) {
      console.error('Signup notification email failed (non-blocking):', notifyErr)
    }
  }

  // user present but no session → email confirmation required
  return {
    success: true,
    requiresEmailVerification: !!(authData.user && !authData.session),
  }
}

// ── resendVerificationEmail ───────────────────────────────────────────────────

export async function changePassword(
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  if (newPassword.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters.' }
  }
  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function deleteAccount(): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Not authenticated.' }

  // Delete all projects — cascade handles all related tables
  await supabase.from('projects').delete().eq('user_id', user.id)

  // Delete the Supabase Auth user via admin (bypasses RLS)
  const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)
  if (error) return { success: false, error: error.message }

  await supabase.auth.signOut()
  return { success: true }
}

export async function resendVerificationEmail(): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.email) {
    return { success: false, error: 'Not signed in.' }
  }

  const { error } = await supabase.auth.resend({ type: 'signup', email: user.email })
  if (error) {
    return { success: false, error: 'Unable to resend verification email. Please try again.' }
  }
  return { success: true }
}
