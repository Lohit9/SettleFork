'use server'

/**
 * Server actions for the org-admin SSO settings page write surface
 * (B-2-c-ii). NOT to be confused with `lib/actions/sso.ts`, whose
 * mutations are gated to PLATFORM admins (Settle staff) and have a
 * different return shape (`{ success, error, errorCode }`).
 *
 * What this file owns
 * -------------------
 *   - addOrgSsoDomain        — org admin adds a domain to their org
 *   - removeOrgSsoDomain     — org admin removes a domain from their org
 *   - setOrgEnforcementMode  — org admin changes enforcement mode
 *   - previewEnforcementChange — preflight count helper for the *→strict
 *                                lockout-risk modal
 *
 * Why a separate file from `sso-admin.ts`
 * ---------------------------------------
 * `sso-admin.ts` is the read-only surface from B-2-c-i. Splitting
 * read vs write into separate modules keeps the source-level
 * invariant test (`tests/actions/sso-admin-mutations-source.test.ts`)
 * focused on the gate-runs-before-DB / audit-runs-after-DB / no-id-
 * leakage shapes that ONLY apply to writes. Mixing them would muddy
 * the test boundary.
 *
 * Each of the four exported actions begins with `requireOrgAdmin(orgId)`
 * BEFORE any database access. Source-level invariant tests pin this
 * — the gate is the single boundary preventing cross-tenant writes
 * (e.g. org A's admin successfully calling addOrgSsoDomain with org
 * B's id). Runtime end-to-end isolation tests in
 * `tests/integration/sso-admin-isolation.test.ts` exercise the gate
 * against a real second tenant.
 *
 * Security tightening over the platform-admin path
 * -------------------------------------------------
 * `addOrgSsoDomain`'s cross-org "domain hijack attempt" error does
 * NOT include the conflicting org_id (Mini-D2 from session
 * 2026-04-28). The platform-admin equivalent at `lib/actions/sso.ts:
 * 909-924` does include it. Org-admin → org-admin is a cross-tenant
 * disclosure surface, so we surface only a generic message. The
 * conflicting org_id is logged server-side via `console.warn` for
 * ops debugging.
 *
 * Identity sourcing — same rules as `sso-admin.ts`
 * -------------------------------------------------
 * `actorUserId` for the audit emits is sourced from the
 * `requireOrgAdmin` result, never from a function parameter. Any
 * future caller passing an `as_user` argument would be a security
 * regression — and the source-level test pins this with a literal
 * string check on the function signatures.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireOrgAdmin } from '@/lib/auth/require-org-role'
import { emitSsoAuditEvent } from './sso-audit'
import {
  validateDomain,
  VALID_ENFORCEMENT_MODES,
  type EnforcementMode,
} from '@/lib/sso/domain-validation'

// ─────────────────────────────────────────────────────────────────────
// addOrgSsoDomain
// ─────────────────────────────────────────────────────────────────────

export type AddOrgSsoDomainResult =
  | {
      ok: false
      error: string
      errorCode?:
        | 'NOT_AUTHORIZED'
        | 'VALIDATION'
        | 'DOMAIN_ALREADY_MAPPED'
        | 'ALREADY_ADDED'
        | 'DB_ERROR'
    }
  | { ok: true; domain: { id: string; domain: string } }

/**
 * Add a domain to the calling user's org SSO allowlist.
 *
 * Validates the domain (regex + length), then checks for in-org
 * duplicate (friendly "already added" error) and cross-org duplicate
 * (generic "already in use" error WITHOUT leaking the conflicting
 * org_id). On success, inserts and emits a `sso.domain.added` audit
 * event.
 */
export async function addOrgSsoDomain(
  orgId: string,
  domain: string,
): Promise<AddOrgSsoDomainResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error, errorCode: 'NOT_AUTHORIZED' }

  const validation = validateDomain(domain)
  if (!validation.ok) {
    return { ok: false, error: validation.error, errorCode: 'VALIDATION' }
  }

  const normalized = validation.domain

  // Pre-check: same domain already on THIS org → friendly "already
  // added" message. Same domain on ANOTHER org → generic message that
  // does NOT leak the conflicting org_id (security tightening over
  // the platform-admin path). The conflicting org_id is logged
  // server-side via console.warn for ops visibility.
  //
  // Race-safety: a concurrent insert between this read and our own
  // write would still be caught by the UNIQUE(domain) constraint
  // (Postgres unique_violation 23505) at insert time; the pre-check
  // is purely a UX optimization to surface the "already added" /
  // "in use" distinction without relying on insert-error-code
  // parsing.
  const { data: existing } = await supabaseAdmin
    .from('sso_domains')
    .select('id, org_id')
    .eq('domain', normalized)
    .maybeSingle()

  if (existing) {
    if (existing.org_id === orgId) {
      return {
        ok: false,
        error: `${normalized} is already added to this organization`,
        errorCode: 'ALREADY_ADDED',
      }
    }
    // Cross-org hijack attempt. Do NOT leak conflicting org id to
    // the client. Server-side log keeps the conflict_org_id reachable
    // for ops triage.
    console.warn('[sso-admin-mutations] domain hijack attempt', {
      attempting_org: orgId,
      attempting_user: auth.userId,
      domain: normalized,
      conflicting_org: existing.org_id,
    })
    return {
      ok: false,
      error:
        'This domain is already in use. Contact support if you believe this is your domain.',
      errorCode: 'DOMAIN_ALREADY_MAPPED',
    }
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('sso_domains')
    .insert({
      org_id: orgId,
      domain: normalized,
      added_by: auth.userId,
    })
    .select('id, domain')
    .single()

  if (insErr || !inserted) {
    // Edge case: the pre-check didn't see a conflict but the unique
    // constraint fired (concurrent insert by another admin). Map
    // this to the same generic message + log for ops.
    if ((insErr as { code?: string } | null)?.code === '23505') {
      console.warn('[sso-admin-mutations] domain hijack via race', {
        attempting_org: orgId,
        attempting_user: auth.userId,
        domain: normalized,
      })
      return {
        ok: false,
        error:
          'This domain is already in use. Contact support if you believe this is your domain.',
        errorCode: 'DOMAIN_ALREADY_MAPPED',
      }
    }
    console.error('[sso-admin-mutations] addOrgSsoDomain insert failed', {
      orgId,
      error: insErr?.message,
    })
    return { ok: false, error: 'Failed to add domain', errorCode: 'DB_ERROR' }
  }

  await emitSsoAuditEvent('sso.domain.added', {
    actorUserId: auth.userId,
    orgId,
    metadata: { domain: normalized },
  })

  return { ok: true, domain: { id: inserted.id, domain: inserted.domain } }
}

// ─────────────────────────────────────────────────────────────────────
// removeOrgSsoDomain
// ─────────────────────────────────────────────────────────────────────

export type RemoveOrgSsoDomainResult =
  | { ok: false; error: string; errorCode?: 'NOT_AUTHORIZED' | 'DB_ERROR' }
  | { ok: true; was_last_domain: boolean }

/**
 * Remove a domain from the calling user's org SSO allowlist.
 *
 * Idempotent: returns ok:true whether or not the row existed (matches
 * the platform-admin path at `lib/actions/sso.ts:957-1004`). The
 * audit event is emitted unconditionally on successful delete
 * (including 0-row deletes) so the activity log always shows that
 * an admin attempted the change.
 *
 * `was_last_domain` is computed BEFORE the delete by counting
 * `sso_domains` rows for the org. The result is returned to the
 * client (so a caller can display "you removed your last domain"
 * UX) and stamped on the audit event metadata.
 */
export async function removeOrgSsoDomain(
  orgId: string,
  domain: string,
): Promise<RemoveOrgSsoDomainResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error, errorCode: 'NOT_AUTHORIZED' }

  const normalized = domain.trim().toLowerCase()

  // Pre-flight count BEFORE the delete. If the queried row is in
  // fact the only domain on the org, was_last_domain=true; the
  // metadata field on the audit event lets ops/security distinguish
  // "admin trimmed one of N domains" from "admin removed the only
  // remaining mapping (login auto-discovery now broken)".
  const { count: domainCount } = await supabaseAdmin
    .from('sso_domains')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)

  const wasLastDomain = (domainCount ?? 0) === 1

  // Defensive: BOTH `.eq('org_id', orgId)` AND `.eq('domain', normalized)`.
  // Never delete by domain alone. (Source-level invariant pins this.)
  const { error: delErr } = await supabaseAdmin
    .from('sso_domains')
    .delete()
    .eq('org_id', orgId)
    .eq('domain', normalized)

  if (delErr) {
    console.error('[sso-admin-mutations] removeOrgSsoDomain delete failed', {
      orgId,
      error: delErr.message,
    })
    return { ok: false, error: 'Failed to remove domain', errorCode: 'DB_ERROR' }
  }

  await emitSsoAuditEvent('sso.domain.removed', {
    actorUserId: auth.userId,
    orgId,
    metadata: { domain: normalized, was_last_domain: wasLastDomain },
  })

  return { ok: true, was_last_domain: wasLastDomain }
}

// ─────────────────────────────────────────────────────────────────────
// setOrgEnforcementMode
// ─────────────────────────────────────────────────────────────────────

export type SetOrgEnforcementModeResult =
  | {
      ok: false
      error: string
      errorCode?: 'NOT_AUTHORIZED' | 'VALIDATION' | 'DB_ERROR' | 'NOT_FOUND'
    }
  | {
      ok: true
      previous_mode: EnforcementMode
      new_mode: EnforcementMode
      was_no_op: boolean
    }

/**
 * Update the org's SSO enforcement mode (`strict` | `hybrid` |
 * `optional`).
 *
 * Re-validates the new mode server-side (don't trust the client's
 * dropdown). Pre-fetches the current mode so the audit event can
 * record `previous_mode` AND so we can skip the audit emit when the
 * mode hasn't actually changed (matches the platform-admin path at
 * `lib/actions/sso.ts:837-846`).
 */
export async function setOrgEnforcementMode(
  orgId: string,
  mode: EnforcementMode,
): Promise<SetOrgEnforcementModeResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error, errorCode: 'NOT_AUTHORIZED' }

  if (!VALID_ENFORCEMENT_MODES.includes(mode)) {
    return {
      ok: false,
      error: 'Invalid enforcement mode',
      errorCode: 'VALIDATION',
    }
  }

  const { data: org, error: fetchErr } = await supabaseAdmin
    .from('organizations')
    .select('enforcement_mode')
    .eq('id', orgId)
    .maybeSingle()

  if (fetchErr || !org) {
    console.error('[sso-admin-mutations] setOrgEnforcementMode fetch failed', {
      orgId,
      error: fetchErr?.message ?? 'org not found',
    })
    return { ok: false, error: 'Organization not found', errorCode: 'NOT_FOUND' }
  }

  const previousMode = org.enforcement_mode as EnforcementMode

  const { error: updErr } = await supabaseAdmin
    .from('organizations')
    .update({ enforcement_mode: mode })
    .eq('id', orgId)

  if (updErr) {
    console.error('[sso-admin-mutations] setOrgEnforcementMode update failed', {
      orgId,
      error: updErr.message,
    })
    return {
      ok: false,
      error: 'Failed to update enforcement mode',
      errorCode: 'DB_ERROR',
    }
  }

  const wasNoOp = previousMode === mode

  // Skip audit emit on no-op (matches platform-admin behavior). The
  // success path still returns ok:true with was_no_op:true so the
  // client can distinguish "we changed it" from "the dropdown was
  // already set to this value, no-op succeeded."
  if (!wasNoOp) {
    await emitSsoAuditEvent('sso.enforcement.changed', {
      actorUserId: auth.userId,
      orgId,
      metadata: { previous_mode: previousMode, new_mode: mode },
    })
  }

  return {
    ok: true,
    previous_mode: previousMode,
    new_mode: mode,
    was_no_op: wasNoOp,
  }
}

// ─────────────────────────────────────────────────────────────────────
// previewEnforcementChange (preflight helper)
// ─────────────────────────────────────────────────────────────────────

export type PreviewEnforcementChangeResult =
  | { ok: false; error: string }
  | {
      ok: true
      total_members: number
      users_without_sso: number
      is_lockout_risk: boolean
    }

/**
 * Preflight count for the EnforcementChangeDialog's high-risk
 * modal (any-mode → `strict`).
 *
 * Returns the number of members in the org and the subset of those
 * members who do NOT have an SSO identity link in this org. When
 * `is_lockout_risk` is true, switching to strict will prevent those
 * members from signing in (no password fallback, no SSO link to
 * fall back to).
 *
 * Implementation note: PostgREST has no clean NOT EXISTS shorthand,
 * so we fetch both sides as flat user_id sets and compute the
 * difference in JS. The numbers are small (org membership counts,
 * not user-content tables) so the in-memory difference is cheap.
 */
export async function previewEnforcementChange(
  orgId: string,
  newMode: EnforcementMode,
): Promise<PreviewEnforcementChangeResult> {
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) return { ok: false, error: auth.error }

  if (!VALID_ENFORCEMENT_MODES.includes(newMode)) {
    return { ok: false, error: 'Invalid enforcement mode' }
  }

  const { data: members, error: membersErr } = await supabaseAdmin
    .from('org_memberships')
    .select('user_id')
    .eq('org_id', orgId)
  if (membersErr) {
    console.error('[sso-admin-mutations] previewEnforcementChange members failed', {
      orgId,
      error: membersErr.message,
    })
    return { ok: false, error: 'Failed to count members' }
  }

  const { data: links, error: linksErr } = await supabaseAdmin
    .from('sso_identity_links')
    .select('user_id')
    .eq('org_id', orgId)
  if (linksErr) {
    console.error('[sso-admin-mutations] previewEnforcementChange links failed', {
      orgId,
      error: linksErr.message,
    })
    return { ok: false, error: 'Failed to count SSO identities' }
  }

  const memberIds = new Set((members ?? []).map((m) => m.user_id))
  const linkedIds = new Set((links ?? []).map((l) => l.user_id))

  const usersWithoutSso = [...memberIds].filter((id) => !linkedIds.has(id)).length
  const totalMembers = memberIds.size

  return {
    ok: true,
    total_members: totalMembers,
    users_without_sso: usersWithoutSso,
    is_lockout_risk: usersWithoutSso > 0 && newMode === 'strict',
  }
}
