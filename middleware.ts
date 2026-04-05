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

    // MFA step-up: user has enrolled TOTP but hasn't verified this session
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalData && aalData.nextLevel === 'aal2' && aalData.currentLevel !== 'aal2') {
      const url = request.nextUrl.clone()
      url.pathname = '/auth/mfa-verify'
      url.searchParams.set('redirect', pathname)
      return NextResponse.redirect(url)
    }
  }

  // ── /auth/mfa-verify page ─────────────────────────────────────────────────
  if (pathname === '/auth/mfa-verify') {
    if (!user) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
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

  // ── mine-active-org cookie ──────────────────────────────────────────────────
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
