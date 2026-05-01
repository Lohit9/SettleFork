import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { welcomeEmail } from '@/lib/email/templates'
import { emitSsoAuditEvent } from '@/lib/actions/sso-audit'
import { hashEmail } from '@/lib/sso/email-hash'
import {
  readAttemptOrgCookie,
  deleteAttemptOrgCookie,
} from '@/lib/sso/attempt-cookie'
import type { SupabaseClient, User } from '@supabase/supabase-js'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const next = requestUrl.searchParams.get('next') || '/app/projects'
  const type = requestUrl.searchParams.get('type') // 'recovery' | 'signup' | 'sso'

  if (code) {
    const supabase = await createClient()
    const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // Handle SSO/SAML round-trip — six security checks before the
      // user is allowed to land on /app/*. See handleSsoCallback for
      // the full ordering and audit semantics.
      if (type === 'sso' && sessionData?.user) {
        return handleSsoCallback({
          request,
          requestUrl,
          next,
          supabase,
          user: sessionData.user,
        })
      }

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
          from: 'Settle <info@usesettle.ai>',
          to: user.email!,
          replyTo: 'info@usesettle.ai',
          subject,
          html,
        }).catch((err) => console.error('[auth callback] Welcome email failed:', err))

        return NextResponse.redirect(new URL('/app/projects', requestUrl.origin))
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

// ============================================================================
// SSO callback branch — B-2-a-ii
// ============================================================================
//
// Performs six ordered security checks on a freshly-exchanged SAML
// session before allowing the user to land on /app/*:
//
//   A. Attempted-org cookie present + signature valid
//   B. Session has an sso:<uuid> identity (provider_not_resolved)
//   C. supabase_provider_id resolves to a sso_providers row
//   D. Cross-tenant: provider's org_id == attempted_org_id
//   E. Domain-provider sanity: email domain → org == provider org
//   F. Duplicate account: no other identity providers on this user
//   G. JIT provisioning succeeds
//   H. Identity linking (NON-BLOCKING — failure logged, login proceeds)
//   I. Audit success
//   J. Redirect to next
//
// Fail-closed: every uncertain branch signs the user out and emits a
// sso.login.failure audit event with bounded metadata (email_hash,
// no raw PII). The attempt-org cookie is consumed (set to maxAge=0)
// on every exit path so a stale cookie cannot bleed across attempts.
//
// All RPCs that mutate or read auth.identities go through
// supabaseAdmin (service_role) per the grants in migration 070.

async function handleSsoCallback(args: {
  request: Request
  requestUrl: URL
  next: string
  supabase: SupabaseClient
  user: User
}): Promise<NextResponse> {
  const { request, requestUrl, next, supabase, user } = args
  const userId = user.id
  const userEmail = user.email

  // Helper: build a redirect response with the attempt-org cookie
  // consumed. Use this on every exit path (success and failure).
  const redirectAndConsume = (target: URL): NextResponse => {
    const res = NextResponse.redirect(target, 302)
    deleteAttemptOrgCookie(res)
    return res
  }

  // Helper: emit failure audit + signOut + redirect with consume.
  // Centralizes the "abort SSO with reason X" pattern so we can't
  // accidentally skip a step (e.g., forget to signOut after a hard
  // failure).
  const failAndAbort = async (
    reason: string,
    metadata: Record<string, unknown>,
    redirectReason: string,
    orgIdForAudit: string | null
  ): Promise<NextResponse> => {
    await supabase.auth.signOut()
    await emitSsoAuditEvent('sso.login.failure', {
      actorUserId: userId,
      orgId: orgIdForAudit,
      metadata: { reason, ...metadata },
    })
    return redirectAndConsume(
      new URL(`/login?reason=${redirectReason}`, requestUrl.origin)
    )
  }

  // Defensive: SAML users always have an email (Name ID = EmailAddress
  // is configured in our Okta wizard). If GoTrue gave us a session
  // without an email, treat as provider_not_resolved.
  if (!userEmail) {
    return failAndAbort(
      'provider_not_resolved',
      { detail: 'no_email_in_session' },
      'sso_callback_error',
      null
    )
  }

  // ── STEP A: Read + verify the attempted-org cookie ──────────────
  const cookieResult = readAttemptOrgCookie(request)
  if (!cookieResult.orgId) {
    return failAndAbort(
      'attempted_org_missing',
      {
        cookie_reason: cookieResult.reason ?? 'unknown',
        email_hash: hashEmail(userEmail),
      },
      'sso_attempted_org_missing',
      null
    )
  }
  const attemptedOrgId = cookieResult.orgId

  // ── STEP B: Resolve session's SSO provider from auth.identities ─
  // get_auth_identity_providers is service_role only and returns
  // SETOF TEXT (one row per provider). PostgREST surfaces this as
  // an array of strings or {get_auth_identity_providers: '...'}
  // objects depending on shape; normalize defensively.
  const { data: providersRaw, error: providersErr } = await supabaseAdmin.rpc(
    'get_auth_identity_providers',
    { p_user_id: userId }
  )

  if (providersErr) {
    return failAndAbort(
      'provider_not_resolved',
      {
        detail: 'rpc_error',
        rpc_error: providersErr.message,
        email_hash: hashEmail(userEmail),
      },
      'sso_callback_error',
      attemptedOrgId
    )
  }

  const providerStrings: string[] = normalizeProviderRpcResult(providersRaw)
  const ssoProviderStrings = providerStrings.filter((p) => p.startsWith('sso:'))

  if (ssoProviderStrings.length === 0) {
    return failAndAbort(
      'provider_not_resolved',
      {
        detail: 'no_sso_identity',
        email_hash: hashEmail(userEmail),
      },
      'sso_callback_error',
      attemptedOrgId
    )
  }

  // For B-2-a-ii: a clean test path has exactly one sso:* identity.
  // If a user accumulates multiple sso:* identities (e.g., the SSO
  // provider was re-registered between logins), pick the first
  // returned. The cross-tenant check below will catch the case
  // where the chosen identity is for a different org than was
  // attempted, so picking-the-first is safe — at worst it surfaces
  // as a cross_tenant failure, never an erroneous success.
  // TODO: when cross-org SSO ships, replace with last_sign_in_at
  // ordering against auth.identities.
  const sessionProviderString = ssoProviderStrings[0]
  const supabaseProviderId = sessionProviderString.slice('sso:'.length)

  // ── STEP C: Resolve provider's home org via sso_providers ───────
  const { data: providerRow, error: providerLookupErr } = await supabaseAdmin
    .from('sso_providers')
    .select('id, org_id, supabase_provider_id')
    .eq('supabase_provider_id', supabaseProviderId)
    .maybeSingle()

  if (providerLookupErr || !providerRow) {
    return failAndAbort(
      'provider_not_resolved',
      {
        detail: 'sso_providers_lookup_failed',
        supabase_provider_id: supabaseProviderId,
        lookup_error: providerLookupErr?.message ?? 'no_row',
        email_hash: hashEmail(userEmail),
      },
      'sso_callback_error',
      attemptedOrgId
    )
  }
  const providerOrgId: string = providerRow.org_id
  const ssoProviderPk: string = providerRow.id

  // ── STEP D: Cross-tenant check ──────────────────────────────────
  // The org the user attempted to enter (from the signed cookie set
  // at /sso/start) MUST equal the org that owns the SAML provider
  // GoTrue authenticated against. A mismatch means either:
  //   (a) the user landed on a callback for a different tenant
  //       (cookie tampering, racing tabs across orgs), or
  //   (b) the IdP returned an assertion bound to a different
  //       provider than the one we asked for.
  // Either way: hard fail, signOut, audit.
  if (providerOrgId !== attemptedOrgId) {
    return failAndAbort(
      'cross_tenant',
      {
        attempted_org_id: attemptedOrgId,
        actual_provider_org_id: providerOrgId,
        supabase_provider_id: supabaseProviderId,
        email_hash: hashEmail(userEmail),
      },
      'sso_cross_tenant',
      attemptedOrgId
    )
  }

  // ── STEP E: Domain-provider sanity check ────────────────────────
  // Authoritative org for the email's domain (per sso_domains)
  // MUST equal the provider's org_id. This catches the case where
  // an IdP issues a valid assertion for an email whose domain is
  // mapped to a different org — a real risk if multi-org IdPs are
  // ever federated incorrectly.
  //
  // Per migration 072: lookup_sso_provider_for_domain returns
  //   TABLE(org_id UUID, sso_provider_id UUID,
  //         enforcement_mode TEXT, org_slug TEXT)
  // and only returns rows where organizations.sso_enabled=TRUE.
  const { data: domainLookupRows, error: domainLookupErr } =
    await supabaseAdmin.rpc('lookup_sso_provider_for_domain', {
      p_email: userEmail,
    })

  const domainLookupArr: Array<{ org_id: string }> = Array.isArray(
    domainLookupRows
  )
    ? domainLookupRows
    : domainLookupRows
    ? [domainLookupRows]
    : []
  const domainOrgId: string | null =
    domainLookupArr.length > 0 ? domainLookupArr[0].org_id : null

  if (domainLookupErr || domainOrgId !== providerOrgId) {
    return failAndAbort(
      'domain_provider_mismatch',
      {
        attempted_org_id: attemptedOrgId,
        provider_org_id: providerOrgId,
        domain_org_id: domainOrgId,
        domain_lookup_error: domainLookupErr?.message ?? null,
        email_hash: hashEmail(userEmail),
      },
      'sso_domain_mismatch',
      providerOrgId
    )
  }

  // ── STEP F: Duplicate account detection (same-user) ─────────────
  // Decision 30 + D7: if the user has any provider OTHER than the
  // sso:<this-uuid> we just authenticated with (e.g., 'email',
  // another sso:* from a different org, 'google'), it's a duplicate
  // account collision. Block, signOut, audit.
  const otherProviders = providerStrings.filter(
    (p) => p !== sessionProviderString
  )
  if (otherProviders.length > 0) {
    return failAndAbort(
      'duplicate_account',
      {
        other_providers: otherProviders,
        email_hash: hashEmail(userEmail),
      },
      'sso_duplicate_account',
      providerOrgId
    )
  }

  // ── STEP G: JIT provisioning ────────────────────────────────────
  // provision_user_via_jit is idempotent: if a membership already
  // exists for (user_id, org_id), it returns was_new=FALSE without
  // mutating. Otherwise it inserts a viewer membership (or invite-
  // role membership when a pending invite matches).
  const { data: jitRaw, error: jitErr } = await supabaseAdmin.rpc(
    'provision_user_via_jit',
    {
      p_user_id: userId,
      p_org_id: providerOrgId,
      p_email: userEmail,
    }
  )

  if (jitErr) {
    return failAndAbort(
      'jit_failed',
      {
        rpc_error: jitErr.message,
        email_hash: hashEmail(userEmail),
      },
      'sso_jit_failed',
      providerOrgId
    )
  }

  const jitRow = Array.isArray(jitRaw) ? jitRaw[0] : jitRaw
  const isNewMembership: boolean = jitRow?.was_new === true
  const assignedRole: string = jitRow?.assigned_role ?? 'viewer'

  // ── STEP H: Identity linking — NON-BLOCKING ─────────────────────
  // mark_identity_sso_linked param order: (user_id, sso_provider_id,
  // org_id). The middle arg is the Settle PK from sso_providers.id,
  // NOT the GoTrue supabase_provider_id.
  //
  // Per Decision 31 / D4.2: failure here does not abort login.
  // Middleware-side repair (out of scope) will catch unlinked SSO
  // sessions on subsequent requests.
  const { error: linkErr } = await supabaseAdmin.rpc(
    'mark_identity_sso_linked',
    {
      p_user_id: userId,
      p_sso_provider_id: ssoProviderPk,
      p_org_id: providerOrgId,
    }
  )

  if (linkErr) {
    console.error('[auth/callback sso] mark_identity_sso_linked failed:', {
      userId,
      orgId: providerOrgId,
      error: linkErr.message,
    })
    await emitSsoAuditEvent('sso.login.failure', {
      actorUserId: userId,
      orgId: providerOrgId,
      metadata: {
        reason: 'identity_link_failed',
        rpc_error: linkErr.message,
        email_hash: hashEmail(userEmail),
        non_blocking: true,
      },
    })
    // Intentional fall-through: continue to success.
  }

  // ── STEP I: Audit success ───────────────────────────────────────
  // is_new_user is hard to compute reliably from the session alone
  // (auth.users.created_at vs. now() racing within the same request
  // is < 1s). We omit it here; downstream consumers can join the
  // audit row to auth.users on actor_user_id if they need it.
  await emitSsoAuditEvent('sso.login.success', {
    actorUserId: userId,
    orgId: providerOrgId,
    metadata: {
      provider_id: supabaseProviderId,
      sso_provider_pk: ssoProviderPk,
      email_hash: hashEmail(userEmail),
      is_new_membership: isNewMembership,
      assigned_role: assignedRole,
      identity_link_failed: !!linkErr,
    },
  })

  // ── STEP J: Redirect to next ────────────────────────────────────
  // `next` is already validated for open-redirect / CRLF in
  // /sso/start before being passed via query param, but we re-check
  // here defensively because the callback URL is exposed to the IdP.
  const safeNext =
    next.startsWith('/') && !next.startsWith('//') && !/[\r\n]/.test(next)
      ? next
      : '/app/projects'

  return redirectAndConsume(new URL(safeNext, requestUrl.origin))
}

/**
 * get_auth_identity_providers returns SETOF TEXT. PostgREST renders
 * this as either:
 *   - string[]                                          (newer)
 *   - Array<{ get_auth_identity_providers: string }>    (older)
 *   - null / undefined when zero rows
 * Normalize to string[] without surprises.
 */
function normalizeProviderRpcResult(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item)
    } else if (item && typeof item === 'object') {
      const v = (item as Record<string, unknown>).get_auth_identity_providers
      if (typeof v === 'string') out.push(v)
    }
  }
  return out
}
