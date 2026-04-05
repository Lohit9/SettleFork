import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { welcomeEmail } from '@/lib/email/templates'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const next = requestUrl.searchParams.get('next') || '/app/projects'
  const type = requestUrl.searchParams.get('type') // 'recovery' or 'signup'

  if (code) {
    const supabase = await createClient()
    const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // Handle email verification — send welcome email now that the address is confirmed
      if (type === 'signup' && sessionData?.user) {
        const user = sessionData.user
        const displayName = user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'there'
        const firstName = displayName.split(' ')[0]

        // Resolve org name from membership
        const { data: membership } = await supabaseAdmin
          .from('org_memberships')
          .select('organizations(name)')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle()

        const orgName = (membership?.organizations as any)?.name ?? 'your workspace'

        const { subject, html } = welcomeEmail(firstName, orgName)
        resend.emails.send({
          from: 'Kaan from Mine <info@trymine.ai>',
          to: user.email!,
          replyTo: 'info@trymine.ai',
          subject,
          html,
        }).catch((err) => console.error('[auth callback] Welcome email failed:', err))

        return NextResponse.redirect(new URL('/verify-email?verified=true', requestUrl.origin))
      }

      // Handle password reset
      if (type === 'recovery') {
        return NextResponse.redirect(new URL('/reset-password', requestUrl.origin))
      }

      // Default redirect
      return NextResponse.redirect(new URL(next, requestUrl.origin))
    }
  }

  // Error or no code, redirect to login
  return NextResponse.redirect(new URL('/login?error=auth_callback_error', requestUrl.origin))
}
