import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: any }>) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh session if expired — required for Server Components
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // ── SSO state (single RPC per request, reused below) ─────────────────────
  // Computed once per request for authenticated users. The /app/* branch
  // reads sso_required / is_sso_already for the enforcement gate and MFA
  // bypass; the /auth/mfa-verify branch reads is_sso_already for the
  // short-circuit. On RPC error we fail CLOSED for enforcement (treat as
  // no-strict-org so we do not lock out a user on a flaky DB hop) but
  // leave the existing MFA check in force (also fail-open for bypass,
  // so TOTP still protects the session).
  let ssoState: {
    sso_required: boolean
    effective_mode: string
    strict_org_ids: string[]
    is_sso_already: boolean
  } | null = null

  if (user) {
    const { data: enforceRow, error: enforceErr } = await supabase.rpc(
      'enforce_sso_on_login',
      { p_user_id: user.id }
    )
    if (enforceErr) {
      console.error('[middleware] enforce_sso_on_login failed:', {
        userId: user.id,
        error: enforceErr.message,
      })
      ssoState = null
    } else {
      ssoState = Array.isArray(enforceRow) ? enforceRow[0] : enforceRow
    }
  }

  // ── Protect /app/* routes ─────────────────────────────────────────────────
  if (pathname.startsWith('/app')) {
    if (!user) {
      // Not authenticated → login
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('redirect', pathname)
      return NextResponse.redirect(url)
    }

    // Authenticated but email not verified → verification pending page
    if (!user.email_confirmed_at) {
      const url = request.nextUrl.clone()
      url.pathname = '/verify-email'
      return NextResponse.redirect(url)
    }

    // SSO enforcement (decisions 2, 15, 33): if the user belongs to a
    // strict-SSO org but is not authenticated via SSO, force sign-out
    // and bounce to /login with a reason code.
    if (ssoState?.sso_required && !ssoState?.is_sso_already) {
      console.info('[middleware] SSO enforcement: signing out user', {
        userId: user.id,
        strictOrgIds: ssoState.strict_org_ids,
      })
      await supabase.auth.signOut()
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('reason', 'sso_required')
      url.searchParams.delete('redirect')
      return NextResponse.redirect(url)
    }

    // MFA step-up: user has enrolled TOTP but hasn't verified this session.
    // Bypassed for SSO users (locked decision 8, 34).
    if (!ssoState?.is_sso_already) {
      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aalData && aalData.nextLevel === 'aal2' && aalData.currentLevel !== 'aal2') {
        const url = request.nextUrl.clone()
        url.pathname = '/auth/mfa-verify'
        url.searchParams.set('redirect', pathname)
        return NextResponse.redirect(url)
      }
    }
  }

  // ── /auth/mfa-verify page ─────────────────────────────────────────────────
  if (pathname === '/auth/mfa-verify') {
    if (!user) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
    }

    // SSO users bypass the MFA challenge entirely (locked decision 34).
    // Handles the edge case where a user enrolled TOTP before their
    // account was linked as SSO — without this short-circuit they would
    // be stuck on a challenge page they cannot satisfy.
    if (ssoState?.is_sso_already) {
      const redirectTarget = request.nextUrl.searchParams.get('redirect') || '/app/projects'
      const safeTarget =
        redirectTarget.startsWith('/') && !redirectTarget.startsWith('//')
          ? redirectTarget
          : '/app/projects'
      const url = request.nextUrl.clone()
      url.pathname = safeTarget
      url.search = ''
      return NextResponse.redirect(url)
    }

    // Already at aal2 — no need for the challenge page
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalData && aalData.currentLevel === 'aal2') {
      const redirectTarget = request.nextUrl.searchParams.get('redirect') || '/app/projects'
      const url = request.nextUrl.clone()
      url.pathname = redirectTarget
      url.searchParams.delete('redirect')
      return NextResponse.redirect(url)
    }
  }

  // ── /verify-email page ────────────────────────────────────────────────────
  if (pathname === '/verify-email') {
    // Allow unauthenticated access — new users who just signed up with email
    // verification enabled have no session yet and must reach this page.
    if (user) {
      if (user.email_confirmed_at) {
        // Fully authenticated and verified — no need to be here
        const url = request.nextUrl.clone()
        url.pathname = '/app/projects'
        url.searchParams.delete('verified')
        return NextResponse.redirect(url)
      }
      // User exists but email not confirmed — let them through
    }
    // No user at all — let them through (just signed up, no session yet)
    return NextResponse.next()
  }

  // ── Redirect verified + authenticated users away from auth pages ──────────
  if (
    user &&
    user.email_confirmed_at &&
    (pathname === '/login' ||
      pathname === '/signup' ||
      pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/app/projects'
    return NextResponse.redirect(url)
  }

  // ── settle-active-org cookie ─────────────────────────────────────────────────
  // Read the active org cookie for UX context. If not set, the sidebar
  // component will default it on first render. No blocking or validation here.
  // RLS handles actual access control.

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
