import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { emitSsoAuditEvent } from '@/lib/actions/sso-audit'
import { hashEmail } from '@/lib/sso/email-hash'
import { setAttemptOrgCookie } from '@/lib/sso/attempt-cookie'
import { getClientIp, hashIp } from '@/lib/auth/get-client-ip'
import { checkRateLimit } from '@/lib/rate-limit/upstash'
import { getSafeNext } from '@/lib/auth/safe-next'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://usesettle.ai'

/**
 * SSO start endpoint for IdP-initiated flows.
 *
 * Accepts: ?org=<slug>&email=<optional-hint>&next=<optional-path>
 *
 * Flow:
 *   1. Validate query params
 *   2. Look up org by slug (via supabaseAdmin; RLS would block
 *      anon)
 *   3. Verify org has SSO enabled and a registered provider
 *   4. Call supabase.auth.signInWithSSO via SSR server client
 *      (writes PKCE verifier cookie on the response)
 *   5. Redirect browser to the URL returned by GoTrue (which then
 *      302s to the IdP's SSO endpoint)
 *
 * All failures redirect to /login?reason=... — never return JSON.
 */
export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url)
    const orgSlug = requestUrl.searchParams.get('org')?.trim() ?? ''
    const email =
      requestUrl.searchParams.get('email')?.trim().toLowerCase() ?? ''

    // Validate org slug: 1-67 chars, lowercase alphanumeric + hyphens
    // (matches slug format produced by organizations.ts slugify)
    if (!/^[a-z0-9](?:[a-z0-9-]{0,66})?$/.test(orgSlug)) {
      return NextResponse.redirect(
        new URL('/login?reason=sso_bad_request', requestUrl.origin),
        302
      )
    }

    // Validate ?next= via the canonical helper (open-redirect + CRLF
    // guards). Single source of truth shared with the login page —
    // any rule change applies to both call sites at once.
    const safeNext = getSafeNext(requestUrl.searchParams, { keys: ['next'] })

    // Rate limit: per-IP per-org-slug, 10/min, sliding window.
    // Prevents enumeration of org slugs and unauthenticated audit-row
    // writes (sso_audit_events on the unknown_org branch below).
    // Composite key (ip, orgSlug): a single IP can probe many orgs but
    // not infinitely; one attacker behind shared NAT cannot exhaust the
    // limit for legitimate users targeting different orgs.
    //
    // Placed AFTER slug regex validation (so we don't waste Redis ops on
    // already-rejected input) and BEFORE the org DB lookup (so the
    // limiter shields the DB and the audit-write path).
    const ip = await getClientIp()
    if (!ip) {
      // Fail-closed: cannot identify the client, refuse the request.
      // No audit emit — we don't know which org was attempted (we have
      // the slug but no IP attribution, and emitting an unattributed
      // audit row reintroduces the very abuse we are blocking).
      console.warn('[sso/start] no client IP available, rejecting')
      return NextResponse.redirect(
        new URL('/login?reason=sso_rate_limited', requestUrl.origin),
        302
      )
    }

    const rlResult = await checkRateLimit(`${ip}:${orgSlug}`, {
      kind: 'sso-start',
      limit: 10,
      window: '60 s',
    })

    if (!rlResult.allowed) {
      await emitSsoAuditEvent('sso.login.failure', {
        actorUserId: null,
        orgId: null,
        metadata: {
          reason: 'rate_limited',
          key_kind: 'sso-start',
          ip_hash: hashIp(ip),
          target_hash: orgSlug,
          limit: rlResult.limit,
          window_seconds: 60,
          reset_at: rlResult.resetAt,
          ...(email ? { email_hash: hashEmail(email) } : {}),
        },
      })
      return NextResponse.redirect(
        new URL('/login?reason=sso_rate_limited', requestUrl.origin),
        302
      )
    }

    // Look up org
    const { data: org, error: orgErr } = await supabaseAdmin
      .from('organizations')
      .select('id, sso_enabled')
      .eq('slug', orgSlug)
      .maybeSingle()

    if (orgErr) {
      console.error('[sso/start] org lookup failed:', {
        orgSlug,
        error: orgErr.message,
      })
      return NextResponse.redirect(
        new URL('/login?reason=sso_unavailable', requestUrl.origin),
        302
      )
    }

    if (!org) {
      await emitSsoAuditEvent('sso.login.failure', {
        actorUserId: null,
        orgId: null,
        metadata: {
          reason: 'unknown_org',
          org_slug: orgSlug,
          ...(email ? { email_hash: hashEmail(email) } : {}),
        },
      })
      return NextResponse.redirect(
        new URL('/login?reason=sso_unknown_org', requestUrl.origin),
        302
      )
    }

    if (!org.sso_enabled) {
      return NextResponse.redirect(
        new URL('/login?reason=sso_not_configured', requestUrl.origin),
        302
      )
    }

    // Look up provider
    const { data: provider, error: provErr } = await supabaseAdmin
      .from('sso_providers')
      .select('supabase_provider_id')
      .eq('org_id', org.id)
      .maybeSingle()

    if (provErr || !provider?.supabase_provider_id) {
      return NextResponse.redirect(
        new URL('/login?reason=sso_not_configured', requestUrl.origin),
        302
      )
    }

    // Initiate SSO via SSR server client (writes PKCE cookie)
    const supabase = await createClient()
    const callbackUrl = new URL('/api/auth/callback', APP_URL)
    callbackUrl.searchParams.set('type', 'sso')
    callbackUrl.searchParams.set('next', safeNext)

    const { data, error } = await supabase.auth.signInWithSSO({
      providerId: provider.supabase_provider_id,
      options: { redirectTo: callbackUrl.toString() },
    })

    if (error || !data?.url) {
      console.error('[sso/start] signInWithSSO failed:', {
        orgSlug,
        error: error?.message ?? 'no url returned',
      })
      await emitSsoAuditEvent('sso.login.failure', {
        actorUserId: null,
        orgId: org.id,
        metadata: {
          reason: 'sdk_error',
          sdk_error: error?.message ?? 'no_url_returned',
          ...(email ? { email_hash: hashEmail(email) } : {}),
        },
      })
      return NextResponse.redirect(
        new URL('/login?reason=sso_unavailable', requestUrl.origin),
        302
      )
    }

    // Redirect to GoTrue (which then 302s to the IdP). Sign the
    // attempted org_id into a short-lived HttpOnly cookie so the
    // callback can verify cross-tenant invariants after the SAML
    // round-trip. Cookie is consumed (deleted) by the callback on
    // every exit path.
    const redirectResponse = NextResponse.redirect(data.url, 302)
    setAttemptOrgCookie(redirectResponse, org.id)
    return redirectResponse
  } catch (err) {
    console.error('[sso/start] unexpected error:', { err: String(err) })
    const requestUrl = new URL(request.url)
    return NextResponse.redirect(
      new URL('/login?reason=sso_unavailable', requestUrl.origin),
      302
    )
  }
}
