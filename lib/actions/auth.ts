'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { checkSignupRateLimit } from '@/lib/auth/signup-rate-limit'
import { validateInviteCode, markInviteUsed } from '@/lib/actions/invites'
import { acceptInvite } from '@/lib/actions/org-invites'
import { Resend } from 'resend'
import { adminSignupEmail, welcomeEmail } from '@/lib/email/templates'

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
  /** Legacy invite code — required for access when no org invite token. */
  inviteCode: string
  /** Org invite token — if present, user joins the inviting org instead of creating a personal one. */
  inviteToken?: string
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

  // 4. Validate invite code (skip if org invite token is present).
  const hasOrgInviteToken = !!payload.inviteToken?.trim()
  if (!hasOrgInviteToken) {
    const invite = await validateInviteCode(payload.inviteCode)
    if (!invite.valid) {
      return { success: false, error: invite.error }
    }
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

  // 6. Handle org membership + mark legacy invite as used.
  if (authData.user) {
    const displayName = payload.fullName?.trim() || payload.email.split('@')[0]
    let resolvedOrgName = `${displayName}'s Workspace`

    if (hasOrgInviteToken) {
      // Org invite: accept the invite (creates org_memberships row). No personal org needed.
      try {
        const acceptResult = await acceptInvite(payload.inviteToken!, authData.user.id)
        // Try to resolve org name for the welcome email
        if ((acceptResult as any)?.orgName) resolvedOrgName = (acceptResult as any).orgName
      } catch (err) {
        console.error('Failed to accept org invite during signup (non-blocking):', err)
      }
    } else {
      // Legacy invite code path: mark invite used + create a personal org for this user
      await markInviteUsed(payload.inviteCode, authData.user.id)

      try {
        // createOrganization uses the RLS-enforced client — since we just signed up,
        // the session may not be ready yet. Use supabaseAdmin to create the personal org.
        const slug = 'ws-' + Math.random().toString(36).slice(2, 14)
        const { data: newOrg } = await supabaseAdmin
          .from('organizations')
          .insert({ name: resolvedOrgName, slug, created_by: authData.user.id })
          .select()
          .single()

        if (newOrg) {
          await supabaseAdmin
            .from('org_memberships')
            .insert({ org_id: newOrg.id, user_id: authData.user.id, role: 'owner' })
        }
      } catch (orgErr) {
        console.error('Failed to create personal org during signup (non-blocking):', orgErr)
      }
    }

    // 7. Send admin notification email (non-blocking).
    const { data: invite } = await supabaseAdmin
      .from('invites')
      .select('name, company')
      .eq('code', (payload.inviteCode || '').trim().toUpperCase())
      .maybeSingle()

    const { subject: adminSubject, html: adminHtml } = adminSignupEmail({
      email: payload.email,
      name: invite?.name || payload.fullName || 'Not provided',
      company: invite?.company || payload.companyName || undefined,
      method: hasOrgInviteToken ? 'Org invite' : (payload.inviteCode || 'Unknown'),
    })

    resend.emails.send({
      from: 'Mine Notifications <info@trymine.ai>',
      to: 'info@trymine.ai',
      replyTo: 'info@trymine.ai',
      subject: adminSubject,
      html: adminHtml,
    }).catch((err) => console.error('Signup notification email failed (non-blocking):', err))

    // 8. Send welcome email — only if email verification is NOT required.
    // When verification is required, the welcome email is sent in the auth callback
    // after the user clicks the confirmation link.
    const requiresVerification = !!(authData.user && !authData.session)
    if (!requiresVerification) {
      const firstName = displayName.split(' ')[0]
      const { subject: welcomeSubject, html: welcomeHtml } = welcomeEmail(firstName, resolvedOrgName)

      resend.emails.send({
        from: 'Kaan from Mine <info@trymine.ai>',
        to: payload.email,
        replyTo: 'info@trymine.ai',
        subject: welcomeSubject,
        html: welcomeHtml,
      }).catch((err) => console.error('Welcome email failed (non-blocking):', err))
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
