'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { checkSignupRateLimit } from '@/lib/auth/signup-rate-limit'

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
}

// ── signUpWithBotProtection ───────────────────────────────────────────────────

export interface SignUpPayload {
  fullName: string
  companyName: string
  email: string
  password: string
  companySize: string
  role: string
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

  // 4. Actual Supabase signup.
  const supabase = await createClient()
  const { data: authData, error: signUpError } = await supabase.auth.signUp({
    email: payload.email,
    password: payload.password,
    options: {
      data: {
        full_name: payload.fullName,
        company_name: payload.companyName,
        company_size: payload.companySize,
        role: payload.role,
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
