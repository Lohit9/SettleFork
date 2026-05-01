'use server'

/**
 * Server actions for the org-admin SSO settings page (B-2-c-i).
 *
 * Audience: organization owners reading their OWN org's SSO
 * configuration (the legacy `'admin'` org-role was unified into
 * `'owner'` in migration 079 §B). NOT to be confused with
 * `lib/actions/sso.ts`, whose mutations are gated to PLATFORM admins
 * (Settle staff) and exposes a different return shape.
 *
 * Each of the four exported actions begins with `requireOrgAdmin(orgId)`
 * BEFORE any database access. This is the single security boundary
 * preventing cross-tenant leakage from B-2-c-i — see the file-level
 * docstring of `lib/auth/require-org-role.ts` for the rationale.
 *
 * Client selection — RLS-bound vs service-role
 * --------------------------------------------
 * Migration 070 grants org admins SELECT on `sso_providers` and
 * `sso_domains` via `get_user_admin_org_ids()`. Those reads use the
 * SSR (`createClient`) client, letting RLS act as a defense-in-depth
 * layer behind the app gate.
 *
 * The other two tables — `sso_identity_links` and `sso_audit_events`
 * — currently restrict SELECT to "self only" and "platform admin"
 * respectively. Migration 070 explicitly defers the wider RLS to the
 * audit_log epic (outstanding-items 1.B). For B-2-c-i we bypass via
 * `supabaseAdmin` (service role), with `requireOrgAdmin` as the only
 * boundary. Tests in `tests/actions/sso-admin-source.test.ts` pin
 * that the gate runs before any service-role read.
 *
 * Email join via `getAuthEmailsByIds`
 * ------------------------------------
 * `auth.users.email` is not joinable from PostgREST under
 * `authenticated` role. The codebase pattern (used by `getOrgMembers`)
 * is to fetch user_ids first, then resolve emails via the
 * `get_auth_emails_by_ids` SECURITY DEFINER RPC wrapped at
 * `lib/auth/users.ts:99-121`. We follow the same pattern here.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireOrgAdmin } from '@/lib/auth/require-org-role'
import { getAuthEmailsByIds } from '@/lib/auth/users'
import type { IdPType } from '@/lib/types/organizations'
import type { SSOAuditEventType } from './sso-audit'

// ─────────────────────────────────────────────────────────────────────
// D.1 — Org SSO state overview
// ─────────────────────────────────────────────────────────────────────

export type GetOrgSsoOverviewResult =
  | { ok: false; error: string }
  | {
      ok: true
      sso_enabled: boolean
      enforcement_mode: 'strict' | 'hybrid' | 'optional'
      sso_configured_at: string | null
      idp_type: 'okta' | 'entra' | 'google' | 'generic' | null
      entity_id: string | null
      cert_fingerprint_sha256: string | null
      cert_subject: string | null
      cert_not_before: string | null
      cert_not_after: string | null
      cert_signature_algorithm: string | null
    }

/**
 * Load the org-level SSO state for a single org.
 *
 * Returns the four fields needed by the overview card on
 * `/app/settings/sso`:
 *   - `sso_enabled`         — whether SSO is on at all
 *   - `enforcement_mode`    — strict | hybrid | optional
 *   - `sso_configured_at`   — when SSO was first configured
 *   - `idp_type`            — provider type, or null when no provider row
 *   - `entity_id` + five cert_* fields — SAML metadata surfaced for
 *     the admin preview card (Mini-D16); NULL when no row or legacy row
 *
 * The provider row (`sso_providers`) may not exist even when
 * `sso_enabled = false` — we always return both shapes uniformly.
 */
export async function getOrgSsoOverview(
  orgId: string,
): Promise<GetOrgSsoOverviewResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error }

  // RLS-bound (org admins are permitted by migration 070's
  // `org_admins_can_view_sso_providers` and the existing
  // `org_members_can_view` policy on `organizations`).
  const supabase = await createClient()

  const [orgRes, providerRes] = await Promise.all([
    supabase
      .from('organizations')
      .select('sso_enabled, enforcement_mode, sso_configured_at')
      .eq('id', orgId)
      .single(),
    supabase
      .from('sso_providers')
      .select(
        [
          'idp_type',
          'entity_id',
          'cert_fingerprint_sha256',
          'cert_subject',
          'cert_not_before',
          'cert_not_after',
          'cert_signature_algorithm',
        ].join(', '),
      )
      .eq('org_id', orgId)
      .maybeSingle(),
  ])

  if (orgRes.error || !orgRes.data) {
    console.error('[sso-admin] getOrgSsoOverview org fetch failed', {
      orgId,
      error: orgRes.error?.message,
    })
    return { ok: false, error: 'Failed to load organization' }
  }

  if (providerRes.error) {
    console.error('[sso-admin] getOrgSsoOverview sso_providers fetch failed', {
      orgId,
      error: providerRes.error.message,
    })
  }

  /** Cast: generated DB types may lag migration 081. */
  const prow =
    providerRes.error
      ? null
      : (providerRes.data as null | {
          idp_type: string | null
          entity_id: string | null
          cert_fingerprint_sha256: string | null
          cert_subject: string | null
          cert_not_before: string | null
          cert_not_after: string | null
          cert_signature_algorithm: string | null
        })

  const idpType: IdPType | null =
    prow &&
    (prow.idp_type === 'okta' ||
      prow.idp_type === 'entra' ||
      prow.idp_type === 'google' ||
      prow.idp_type === 'generic')
      ? prow.idp_type
      : null

  return {
    ok: true,
    sso_enabled: orgRes.data.sso_enabled,
    enforcement_mode: orgRes.data.enforcement_mode,
    sso_configured_at: orgRes.data.sso_configured_at,
    idp_type: idpType,
    entity_id: prow?.entity_id ?? null,
    cert_fingerprint_sha256:
      prow?.cert_fingerprint_sha256 ?? null,
    cert_subject: prow?.cert_subject ?? null,
    cert_not_before: prow?.cert_not_before ?? null,
    cert_not_after: prow?.cert_not_after ?? null,
    cert_signature_algorithm:
      prow?.cert_signature_algorithm ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────
// D.2 — Org SSO domains
// ─────────────────────────────────────────────────────────────────────

export interface SsoDomainRow {
  id: string
  domain: string
}

export type ListOrgSsoDomainsResult =
  | { ok: false; error: string }
  | { ok: true; domains: SsoDomainRow[] }

/**
 * List SSO domains attached to an org, alphabetized.
 *
 * Kept separate from `getOrgSsoOverview` so B-2-c-ii (the domain
 * editor) can refetch domains alone after add/remove without
 * re-loading the overview card.
 */
export async function listOrgSsoDomains(
  orgId: string,
): Promise<ListOrgSsoDomainsResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error }

  // RLS-bound — `org_admins_can_view_sso_domains`
  // (migration 070:580-583).
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('sso_domains')
    .select('id, domain')
    .eq('org_id', orgId)
    .order('domain')

  if (error) {
    console.error('[sso-admin] listOrgSsoDomains failed', {
      orgId,
      error: error.message,
    })
    return { ok: false, error: 'Failed to load domains' }
  }

  return { ok: true, domains: data ?? [] }
}

// ─────────────────────────────────────────────────────────────────────
// D.3 — SSO-linked users for the org
// ─────────────────────────────────────────────────────────────────────

export interface SsoLinkedUserRow {
  user_id: string
  email: string | null
  linked_at: string
  last_login_at: string | null
}

export type ListOrgSsoLinkedUsersResult =
  | { ok: false; error: string }
  | { ok: true; users: SsoLinkedUserRow[] }

/**
 * List users currently SSO-linked in an org, joined to email.
 *
 * RLS-BYPASS via `supabaseAdmin`: migration 070's
 * `self_or_admin_can_view_sso_links` (`585-593`) restricts SELECT to
 * `user_id = auth.uid() OR is_platform_admin(...)`. Org admins
 * cannot list other users' links via the SSR client. We bypass with
 * service role; `requireOrgAdmin(orgId)` above is the ONLY boundary.
 *
 * Sort: most-recently-active first (`last_login_at desc`, NULLs at
 * the end so unused links don't dominate the top of the page).
 *
 * Pagination deferred (Mini-D7 / outstanding work). Hard cap at 200
 * rows is a sane MVP limit; the largest expected pilot org is well
 * under this number.
 */
export async function listOrgSsoLinkedUsers(
  orgId: string,
): Promise<ListOrgSsoLinkedUsersResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error }

  const { data: links, error } = await supabaseAdmin
    .from('sso_identity_links')
    .select('user_id, linked_at, last_login_at')
    .eq('org_id', orgId)
    .order('last_login_at', { ascending: false, nullsFirst: false })
    .limit(200)

  if (error) {
    console.error('[sso-admin] listOrgSsoLinkedUsers failed', {
      orgId,
      error: error.message,
    })
    return { ok: false, error: 'Failed to load linked users' }
  }

  const userIds = (links ?? []).map((l) => l.user_id)
  const emailMap = await getAuthEmailsByIds(userIds)

  return {
    ok: true,
    users: (links ?? []).map((l) => ({
      user_id: l.user_id,
      email: emailMap.get(l.user_id) ?? null,
      linked_at: l.linked_at,
      last_login_at: l.last_login_at,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────
// D.4 — Recent SSO audit events for the org
// ─────────────────────────────────────────────────────────────────────

export interface SsoAuditEventRow {
  id: string
  event_type: SSOAuditEventType
  actor_user_id: string | null
  actor_email: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type ListOrgSsoAuditEventsResult =
  | { ok: false; error: string }
  | { ok: true; events: SsoAuditEventRow[] }

const AUDIT_LIMIT_DEFAULT = 50
const AUDIT_LIMIT_CEILING = 100

/**
 * List recent SSO audit events for an org, newest first.
 *
 * RLS-BYPASS via `supabaseAdmin`: migration 070's
 * `platform_admins_can_view_sso_audit` (`595-601`) restricts SELECT
 * to platform admins only — the comment in the migration explicitly
 * defers org-admin read to the broader audit_log epic. We bypass
 * with service role; `requireOrgAdmin(orgId)` above is the ONLY
 * boundary.
 *
 * Filter: `org_id = $orgId`. Audit rows with `org_id IS NULL` (e.g.
 * `/sso/start` rate-limit hits with no resolved org — see
 * `app/sso/start/route.ts:84-96`) are EXCLUDED by design. An org
 * admin should not see other orgs' rate-limit telemetry.
 *
 * Limit: caller-controlled with a hard ceiling at 100. The page
 * defaults to 50; passing `>100` is silently capped to keep payload
 * size bounded (each row carries variable-shape JSONB metadata).
 *
 * Index: `idx_sso_audit_events_org_time` (migration 070:286) covers
 * exactly this access pattern.
 */
export async function listOrgSsoAuditEvents(
  orgId: string,
  limit: number = AUDIT_LIMIT_DEFAULT,
): Promise<ListOrgSsoAuditEventsResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error }

  const cappedLimit = Math.max(1, Math.min(limit, AUDIT_LIMIT_CEILING))

  const { data: events, error } = await supabaseAdmin
    .from('sso_audit_events')
    .select('id, event_type, actor_user_id, metadata, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(cappedLimit)

  if (error) {
    console.error('[sso-admin] listOrgSsoAuditEvents failed', {
      orgId,
      error: error.message,
    })
    return { ok: false, error: 'Failed to load audit events' }
  }

  // Resolve actor emails for the subset of rows that have a non-null
  // `actor_user_id` (rate-limit / pre-auth failures emit null).
  const actorIds = (events ?? [])
    .map((e) => e.actor_user_id)
    .filter((id): id is string => id !== null)
  const emailMap = await getAuthEmailsByIds(actorIds)

  return {
    ok: true,
    events: (events ?? []).map((e) => ({
      id: e.id,
      event_type: e.event_type as SSOAuditEventType,
      actor_user_id: e.actor_user_id,
      actor_email: e.actor_user_id
        ? emailMap.get(e.actor_user_id) ?? null
        : null,
      metadata: (e.metadata as Record<string, unknown>) ?? {},
      created_at: e.created_at,
    })),
  }
}
