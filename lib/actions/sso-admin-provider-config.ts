'use server'

/**
 * Org-admin self-serve SAML SSO provider configuration (B-2-c-iii commit 2).
 *
 * Two public actions orchestrate the security primitives shipped in
 * commit 1 (parse-saml-metadata, cert-validation, safe-fetch,
 * private-ip, idp-type-heuristic) into a complete CREATE / UPDATE /
 * REPLACE flow for org admins:
 *
 *   - configureOrgSsoProviderFromXml(orgId, metadataXml, options)
 *   - configureOrgSsoProviderFromUrl(orgId, metadataUrl, options)
 *
 * Decision tree (Mini-D7, session 2026-04-29):
 *   - No existing provider                          → CREATE (POST to GoTrue)
 *   - Existing + same entity_id + same fingerprint  → no-op
 *   - Existing + same entity_id + new fingerprint   → UPDATE in-place (PUT)
 *   - Existing + new entity_id, no confirm flag     → reject ENTITY_ID_CHANGED
 *   - Existing + new entity_id, confirm flag set    → REPLACE (DELETE+POST,
 *                                                     CAS-guarded DB swap)
 *
 * Security boundary
 * -----------------
 * Three gates are applied IN ORDER, before any external I/O:
 *
 *   1. Feature flag (Mini-D11, Mini-D14): synchronous
 *      `isMetadataUploadEnabledForOrg(orgId)` short-circuits with
 *      `NOT_AVAILABLE` BEFORE any auth roundtrip. This makes forged
 *      POSTs cheap to reject and prevents flag-off requests from
 *      leaking input-shape validation. Mini-D11 explicitly requires
 *      that even forged POSTs return NOT_AVAILABLE when off.
 *
 *   2. Auth gate: `requireOrgAdmin(orgId)` is the FIRST `await`. The
 *      source-level invariant test pins this — a regression that moves
 *      a `.from(...)` call before the gate fails CI before the runtime
 *      tests even load.
 *
 *   3. Rate limit (URL path only): 5 fetches per 60s per (orgId,
 *      userId) tuple via the existing `checkRateLimit` helper. Bounds
 *      the cost of an SSRF probe attempt by a malicious admin (the
 *      auth gate stops external attackers; rate limit stops
 *      compromised legitimate accounts).
 *
 * Audit emit shape (Mini-D9, Mini-D13)
 * ------------------------------------
 * Single `sso.provider.updated` event with `action:
 * 'updated_in_place' | 'replaced'` discriminator. NO raw URL value
 * is persisted to audit metadata — only `has_metadata_url: boolean`
 * and `source: 'metadata_xml' | 'metadata_url'`. Mirrors the
 * platform-admin posture at `lib/actions/sso.ts:534-541` ("URLs may
 * carry tenant tokens or pre-signed query params").
 *
 * Replacement flow uses a CAS-guarded DB swap
 * (`.eq('supabase_provider_id', existing.supabase_provider_id)`) to
 * prevent a TOCTOU race when two admin tabs concurrently replace.
 * CAS failure triggers rollback DELETE of the new GoTrue provider
 * with a `partial_failure: true` audit emit so ops can grep.
 *
 * Identity sourcing
 * -----------------
 * `actorUserId` for audit emits is sourced from the
 * `requireOrgAdmin` result, never from a function parameter. The
 * source-level test pins that no `actor_user_id` / `userId` /
 * `actorUserId` / `as_user_id` parameter appears in either action's
 * signature — any future caller passing an `as_user` argument would
 * be a security regression.
 *
 * NO `revalidatePath` calls
 * -------------------------
 * B-2-c-ii's pattern is to skip `revalidatePath` and let the client
 * call `router.refresh()` after action success (see e.g.
 * `app/app/settings/sso/components/SsoOverviewCard.tsx:162, 195`).
 * Commit 3's UI follows the same pattern. Adding `revalidatePath`
 * here would couple the action to a specific page path, which other
 * call sites (e.g. test scripts) don't have.
 */

import { requireOrgAdmin } from '@/lib/auth/require-org-role'
import { isMetadataUploadEnabledForOrg } from '@/lib/sso/admin-metadata-upload-allowlist'
import { gotrueAdminRequest, type GoTrueError } from '@/lib/sso/gotrue-admin'
import { parseSamlMetadata } from '@/lib/sso/parse-saml-metadata'
import { safeFetchMetadata } from '@/lib/security/safe-fetch'
import { checkRateLimit } from '@/lib/rate-limit/upstash'
import { emitSsoAuditEvent } from '@/lib/actions/sso-audit'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getSPUrls } from '@/lib/actions/sso'
import type { SSOProvider, IdPType } from '@/lib/types/organizations'

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type ConfigureProviderAction =
  | 'created'
  | 'updated_in_place'
  | 'replaced'
  | 'no_op'

export type ConfigureOrgSsoProviderResult =
  | {
      ok: true
      provider: SSOProvider
      cert_fingerprint_sha256: string
      cert_not_after: string
      cert_signature_algorithm: string
      idp_type: IdPType
      entity_id: string
      action: ConfigureProviderAction
    }
  | {
      ok: false
      error: string
      errorCode:
        // Feature flag
        | 'NOT_AVAILABLE'
        // Auth
        | 'NOT_AUTHORIZED'
        // Input validation
        | 'INVALID_INPUT'
        // XML parse / cert validation (forwarded from parseSamlMetadata)
        | 'OVERSIZED'
        | 'DOCTYPE_FORBIDDEN'
        | 'ENTITY_FORBIDDEN'
        | 'PROCESSING_INSTRUCTION_FORBIDDEN'
        | 'INVALID_XML'
        | 'XML_TOO_DEEP'
        | 'NOT_SAML_METADATA'
        | 'NO_IDP_DESCRIPTOR'
        | 'NO_SIGNING_CERT'
        | 'CERT_DECODE_FAILED'
        | 'CERT_PARSE_FAILED'
        | 'CERT_EXPIRED'
        | 'CERT_NOT_YET_VALID'
        | 'CERT_WEAK_SIGNATURE_ALG'
        | 'CERT_WEAK_KEY'
        // URL fetch (forwarded from safeFetchMetadata)
        | 'INVALID_URL'
        | 'NON_HTTPS'
        | 'PRIVATE_IP'
        | 'DNS_FAILED'
        | 'TIMEOUT'
        | 'TOO_LARGE'
        | 'BAD_STATUS'
        | 'TOO_MANY_REDIRECTS'
        // Rate limiting
        | 'RATE_LIMITED'
        // Replacement flow
        | 'ENTITY_ID_CHANGED'
        // GoTrue / DB
        | 'PASSWORD_USERS_EXIST'
        | 'GOTRUE_ERROR'
        | 'DB_ERROR'
      passwordUserCount?: number
      details?: {
        conflicting_entity_id?: string
        expected_entity_id?: string
        rate_limit_reset_at?: number
        /** Populated only for ENTITY_ID_CHANGED — echoes parsed metadata for the replace modal */
        proposed_idp_type?: IdPType
        proposed_cert_fingerprint_sha256?: string
        proposed_cert_not_after?: string
      }
    }

export interface ConfigureOptions {
  /**
   * If true, allows replacing the existing provider when the new
   * metadata's entityID differs from the stored entity_id. This is
   * destructive (creates a new GoTrue provider, invalidates ongoing
   * SAML sessions on next refresh). The UI (commit 3) gates this
   * behind a slug-typing modal. The action defaults to false; if the
   * entity_id differs and `confirmReplaceEntityId` is not true, the
   * action returns `ENTITY_ID_CHANGED`.
   */
  confirmReplaceEntityId?: boolean

  /**
   * If true, bypasses the password-only-users guardrail. Reserved for
   * cases where the admin has confirmed they want to enable SSO
   * despite some users having only password identities (those users
   * will be locked out until they're given an SSO identity link).
   * The UI (commit 3) gates this behind a separate modal.
   */
  forceOverride?: boolean
}

// ─────────────────────────────────────────────────────────────────────
// Public action: configureOrgSsoProviderFromXml
// ─────────────────────────────────────────────────────────────────────

/**
 * Configure (create / update / replace / no-op) an SSO provider for an
 * organization using SAML metadata XML uploaded by an org admin.
 *
 * Authorization: org-admin only (`requireOrgAdmin`).
 * Feature flag: `NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED` +
 * per-org allowlist must permit this org.
 */
export async function configureOrgSsoProviderFromXml(
  orgId: string,
  metadataXml: string,
  options: ConfigureOptions = {},
): Promise<ConfigureOrgSsoProviderResult> {
  // Step 1: Feature flag — synchronous, FIRST textual statement. Pinned
  // by source-level invariant. Mini-D11: forged POSTs return
  // NOT_AVAILABLE when off, before any auth roundtrip.
  if (!isMetadataUploadEnabledForOrg(orgId)) {
    return {
      ok: false,
      error:
        'SSO provider self-serve configuration is not enabled for this organization.',
      errorCode: 'NOT_AVAILABLE',
    }
  }

  // Step 2: Minimal sanity check before passing to the auth gate. Avoids
  // running the gate on garbage input (cheap CPU savings, also keeps
  // error messages predictable).
  if (typeof orgId !== 'string' || orgId.length === 0) {
    return { ok: false, error: 'orgId is required.', errorCode: 'INVALID_INPUT' }
  }
  if (typeof metadataXml !== 'string' || metadataXml.length === 0) {
    return {
      ok: false,
      error: 'metadataXml is required.',
      errorCode: 'INVALID_INPUT',
    }
  }

  // Step 3: Auth gate — FIRST `await`, pinned by source-level invariant.
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) {
    return { ok: false, error: auth.error, errorCode: 'NOT_AUTHORIZED' }
  }

  // Step 4: Delegate to internal orchestrator (parse → decision tree).
  return configureProviderInternal({
    orgId,
    actorUserId: auth.userId,
    source: 'metadata_xml',
    metadataXml,
    metadataUrl: null,
    options,
  })
}

// ─────────────────────────────────────────────────────────────────────
// Public action: configureOrgSsoProviderFromUrl
// ─────────────────────────────────────────────────────────────────────

/**
 * Configure an SSO provider via a metadata URL. The server fetches the
 * URL with comprehensive SSRF defenses (`safeFetchMetadata`) and then
 * converges with the XML path.
 *
 * Rate limited per (orgId, userId) at 5 fetches per 60 seconds via the
 * existing `checkRateLimit` helper. The narrow window bounds the
 * blast radius of a compromised-admin SSRF probe attempt.
 */
export async function configureOrgSsoProviderFromUrl(
  orgId: string,
  metadataUrl: string,
  options: ConfigureOptions = {},
): Promise<ConfigureOrgSsoProviderResult> {
  // Step 1: Feature flag — synchronous, FIRST textual statement.
  if (!isMetadataUploadEnabledForOrg(orgId)) {
    return {
      ok: false,
      error:
        'SSO provider self-serve configuration is not enabled for this organization.',
      errorCode: 'NOT_AVAILABLE',
    }
  }

  // Step 2: Minimal sanity check.
  if (typeof orgId !== 'string' || orgId.length === 0) {
    return { ok: false, error: 'orgId is required.', errorCode: 'INVALID_INPUT' }
  }
  if (typeof metadataUrl !== 'string' || metadataUrl.length === 0) {
    return {
      ok: false,
      error: 'metadataUrl is required.',
      errorCode: 'INVALID_INPUT',
    }
  }

  // Step 3: Auth gate — FIRST `await`.
  const auth = await requireOrgAdmin(orgId)
  if (!auth.ok) {
    return { ok: false, error: auth.error, errorCode: 'NOT_AUTHORIZED' }
  }

  // Step 4: Rate limit. Composite key (orgId, userId) so a single
  // compromised admin in one org cannot exhaust the limit for
  // legitimate admins in other orgs. Placed AFTER the auth gate so we
  // never increment the limiter on cross-tenant probe attempts (those
  // are rejected at the gate without any side effects).
  const rateLimit = await checkRateLimit(`${orgId}:${auth.userId}`, {
    kind: 'sso-config-fetch',
    limit: 5,
    window: '60 s',
  })
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error:
        'Too many metadata fetch attempts in the last minute. Please try again shortly.',
      errorCode: 'RATE_LIMITED',
      details: { rate_limit_reset_at: rateLimit.resetAt },
    }
  }

  // Step 5: SSRF-defended fetch. Errors map 1:1 to our errorCode union.
  const fetched = await safeFetchMetadata(metadataUrl)
  if (!fetched.ok) {
    return { ok: false, error: fetched.error, errorCode: fetched.errorCode }
  }

  // Step 6: Convert response bytes to UTF-8 string. Strip BOM if
  // present (Microsoft tools sometimes emit UTF-8 BOMs even though the
  // XML declaration says UTF-8).
  let xml: string
  try {
    xml = fetched.bytes.toString('utf-8')
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  } catch {
    return {
      ok: false,
      error: 'Failed to decode response body as UTF-8.',
      errorCode: 'INVALID_XML',
    }
  }

  // Step 7: Delegate to internal orchestrator. We pass `fetched.finalUrl`
  // (post-redirect) so DB persistence reflects the URL we actually
  // fetched, not what the admin originally pasted.
  return configureProviderInternal({
    orgId,
    actorUserId: auth.userId,
    source: 'metadata_url',
    metadataXml: xml,
    metadataUrl: fetched.finalUrl,
    options,
  })
}

// ─────────────────────────────────────────────────────────────────────
// Internal orchestrator
// ─────────────────────────────────────────────────────────────────────

interface ConfigureInternalParams {
  orgId: string
  actorUserId: string
  source: 'metadata_xml' | 'metadata_url'
  metadataXml: string
  metadataUrl: string | null
  options: ConfigureOptions
}

/**
 * Parse + validate metadata, then dispatch to create/update/replace/no-op
 * based on Mini-D7's decision tree. Both public actions converge here
 * after their respective input acquisition (paste vs fetch) succeeds.
 */
async function configureProviderInternal(
  params: ConfigureInternalParams,
): Promise<ConfigureOrgSsoProviderResult> {
  const { orgId, actorUserId, source, metadataXml, metadataUrl, options } =
    params

  // Parse + cert-validate the metadata. parseSamlMetadata's errorCodes
  // are a strict subset of our errorCode union, so we forward as-is.
  const parsed = parseSamlMetadata(metadataXml)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, errorCode: parsed.errorCode }
  }

  // Detect existing provider for this org.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('sso_providers')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle()
  if (existingErr) {
    console.error(
      '[sso-admin-provider-config] Failed to query existing provider',
      { orgId, err: existingErr.message },
    )
    return {
      ok: false,
      error: 'Failed to check for existing SSO provider.',
      errorCode: 'DB_ERROR',
    }
  }

  // Decision tree (Mini-D7).
  if (!existing) {
    return createProvider({
      orgId,
      actorUserId,
      source,
      metadataXml,
      metadataUrl,
      parsed,
      options,
    })
  }

  const existingProvider = existing as SSOProvider
  const sameEntityId = existingProvider.entity_id === parsed.entity_id
  const sameFingerprint =
    existingProvider.cert_fingerprint_sha256 === parsed.cert.fingerprint_sha256

  if (sameEntityId && sameFingerprint) {
    // No-op: caller re-uploaded the same metadata. We deliberately do
    // NOT emit an audit event here — there's no state change worth
    // recording, and "admin re-uploaded same XML" is noise that would
    // dilute the audit log. Returning ok:true with action:'no_op'
    // gives the UI enough signal to show a friendly "already
    // configured" message.
    return {
      ok: true,
      provider: existingProvider,
      cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
      cert_not_after: parsed.cert.not_after,
      cert_signature_algorithm: parsed.cert.signature_algorithm,
      idp_type: parsed.idp_type,
      entity_id: parsed.entity_id,
      action: 'no_op',
    }
  }

  if (sameEntityId && !sameFingerprint) {
    return updateProviderInPlace({
      orgId,
      actorUserId,
      source,
      metadataXml,
      metadataUrl,
      parsed,
      existing: existingProvider,
      options,
    })
  }

  // Different entity_id. Refuse unless caller has explicitly confirmed
  // the replacement (UI gates this with a slug-typing modal in commit 3).
  if (!options.confirmReplaceEntityId) {
    return {
      ok: false,
      error: `The new metadata uses a different entity ID (${parsed.entity_id}) than the existing provider (${existingProvider.entity_id}). Confirm the replacement to proceed.`,
      errorCode: 'ENTITY_ID_CHANGED',
      details: {
        conflicting_entity_id: parsed.entity_id,
        expected_entity_id: existingProvider.entity_id,
        proposed_idp_type: parsed.idp_type,
        proposed_cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
        proposed_cert_not_after: parsed.cert.not_after,
      },
    }
  }

  return replaceProvider({
    orgId,
    actorUserId,
    source,
    metadataXml,
    metadataUrl,
    parsed,
    existing: existingProvider,
    options,
  })
}

// ─────────────────────────────────────────────────────────────────────
// Helper: createProvider
// ─────────────────────────────────────────────────────────────────────

interface CreateProviderParams {
  orgId: string
  actorUserId: string
  source: 'metadata_xml' | 'metadata_url'
  metadataXml: string
  metadataUrl: string | null
  parsed: Extract<ReturnType<typeof parseSamlMetadata>, { ok: true }>
  options: ConfigureOptions
}

/**
 * Create a brand-new SSO provider for an org that has none yet. Mirrors
 * the platform-admin path at `lib/actions/sso.ts:218-308` with these
 * adaptations:
 *   - `actorUserId` comes from the org-admin gate, not platform-admin
 *   - cert metadata fields populated from `parsed.cert`
 *   - audit event uses the `source` discriminator (Mini-D13)
 *   - rollback shape and partial_failure audit emit are unchanged
 */
async function createProvider(
  params: CreateProviderParams,
): Promise<ConfigureOrgSsoProviderResult> {
  const { orgId, actorUserId, source, metadataXml, metadataUrl, parsed, options } =
    params

  // Password-only guardrail — same RPC as platform-admin path. Skip
  // when the admin has explicitly opted into the override.
  if (!options.forceOverride) {
    const { data: countData, error: countErr } = await supabaseAdmin.rpc(
      'count_password_only_users_in_org',
      { p_org_id: orgId },
    )
    if (countErr) {
      // Fail closed — we'd rather block on RPC error than silently
      // override the guardrail.
      console.error(
        '[sso-admin-provider-config] count_password_only_users_in_org failed',
        { orgId, err: countErr.message },
      )
      return {
        ok: false,
        error: 'Could not verify user identity state. Try again.',
        errorCode: 'DB_ERROR',
      }
    }
    const count = typeof countData === 'number' ? countData : 0
    if (count > 0) {
      return {
        ok: false,
        error: `${count} user(s) in this org have only email-password identities. Configuring SSO will lock them out until they're given an SSO identity link. Use the override flag if intentional.`,
        errorCode: 'PASSWORD_USERS_EXIST',
        passwordUserCount: count,
      }
    }
  }

  // GoTrue POST first. We always send `metadata_xml` to GoTrue, even
  // when the admin originally provided a URL — we already fetched and
  // validated, and sending XML avoids GoTrue re-fetching (which would
  // double the public-IdP load and fail under our SSRF egress
  // controls if we ever harden the network policy).
  let supabaseProviderId: string
  try {
    const resp = await gotrueAdminRequest<{ id: string }>(
      'POST',
      '/admin/sso/providers',
      { type: 'saml', metadata_xml: metadataXml },
    )
    if (!resp?.id) throw new Error('GoTrue response missing provider id')
    supabaseProviderId = resp.id
  } catch (err) {
    const e = err as GoTrueError
    console.error('[sso-admin-provider-config] GoTrue POST failed', {
      orgId,
      status: e.status,
      gotrueCode: e.gotrueCode,
    })
    return {
      ok: false,
      error: 'Failed to register provider with authentication backend.',
      errorCode: 'GOTRUE_ERROR',
    }
  }

  // DB insert with rollback on failure. Same posture as platform-admin
  // path: GoTrue first, DB second; on DB failure we DELETE the GoTrue
  // provider to avoid orphans.
  const { acsUrl, spEntityId } = await getSPUrls()
  try {
    const { data: provider, error: insErr } = await supabaseAdmin
      .from('sso_providers')
      .insert({
        org_id: orgId,
        supabase_provider_id: supabaseProviderId,
        idp_type: parsed.idp_type,
        entity_id: parsed.entity_id,
        metadata_url: metadataUrl,
        metadata_xml: metadataXml,
        acs_url: acsUrl,
        sp_entity_id: spEntityId,
        attribute_mapping: { keys: {} },
        cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
        cert_subject: parsed.cert.subject,
        cert_not_before: parsed.cert.not_before,
        cert_not_after: parsed.cert.not_after,
        cert_signature_algorithm: parsed.cert.signature_algorithm,
        created_by: actorUserId,
      })
      .select('*')
      .single()

    if (insErr) throw insErr
    if (!provider) throw new Error('DB insert returned no row')

    // Flip organizations.sso_enabled. Best-effort — if it fails, the
    // provider IS configured, just the flag isn't set. Same posture as
    // the platform-admin path; the next read of getProviderConfigForOrg
    // would surface the inconsistency.
    const { error: orgErr } = await supabaseAdmin
      .from('organizations')
      .update({
        sso_enabled: true,
        sso_configured_at: new Date().toISOString(),
      })
      .eq('id', orgId)
    if (orgErr) {
      console.error(
        '[sso-admin-provider-config] Failed to flip organizations.sso_enabled',
        { orgId, err: orgErr.message },
      )
    }

    // Audit emit (Mini-D13: source discriminator + has_metadata_url
    // boolean, NO raw URL).
    await emitSsoAuditEvent('sso.provider.configured', {
      actorUserId,
      orgId,
      metadata: {
        idp_type: parsed.idp_type,
        entity_id: parsed.entity_id,
        acs_url: acsUrl,
        supabase_provider_id: supabaseProviderId,
        source,
        has_metadata_url: source === 'metadata_url',
        cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
        cert_not_after: parsed.cert.not_after,
        cert_signature_algorithm: parsed.cert.signature_algorithm,
        extra_signing_certs_present: parsed.extra_signing_certs_present,
        force_override: !!options.forceOverride,
      },
    })

    return {
      ok: true,
      provider: provider as SSOProvider,
      cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
      cert_not_after: parsed.cert.not_after,
      cert_signature_algorithm: parsed.cert.signature_algorithm,
      idp_type: parsed.idp_type,
      entity_id: parsed.entity_id,
      action: 'created',
    }
  } catch (insErr) {
    // Rollback path. Try to DELETE the GoTrue provider we created so
    // we don't leak an orphan. If that ALSO fails, emit a
    // partial_failure audit event so ops can grep and clean up by hand.
    console.error(
      '[sso-admin-provider-config] DB insert failed, attempting GoTrue rollback',
      { orgId, supabaseProviderId, insErr: String(insErr) },
    )
    try {
      await gotrueAdminRequest(
        'DELETE',
        `/admin/sso/providers/${supabaseProviderId}`,
      )
    } catch (rollbackErr) {
      console.error(
        '[sso-admin-provider-config] DB insert AND GoTrue rollback failed — MANUAL CLEANUP REQUIRED',
        {
          orgId,
          supabaseProviderId,
          insErr: String(insErr),
          rollbackErr: String(rollbackErr),
        },
      )
      await emitSsoAuditEvent('sso.provider.configured', {
        actorUserId,
        orgId,
        metadata: {
          partial_failure: true,
          dangling_supabase_provider_id: supabaseProviderId,
          db_error: String(insErr),
          rollback_error: String(rollbackErr),
          source,
          has_metadata_url: source === 'metadata_url',
        },
      })
    }
    return {
      ok: false,
      error:
        'Failed to persist SSO configuration. Contact support if the issue persists.',
      errorCode: 'DB_ERROR',
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helper: updateProviderInPlace (cert rotation, same entity_id)
// ─────────────────────────────────────────────────────────────────────

interface UpdateProviderParams {
  orgId: string
  actorUserId: string
  source: 'metadata_xml' | 'metadata_url'
  metadataXml: string
  metadataUrl: string | null
  parsed: Extract<ReturnType<typeof parseSamlMetadata>, { ok: true }>
  existing: SSOProvider
  options: ConfigureOptions
}

/**
 * Cert rotation path: same entity_id, new fingerprint. We PUT the new
 * metadata_xml to GoTrue, then UPDATE the sso_providers row with the
 * new cert metadata. Single audit emit with `action: 'updated_in_place'`.
 *
 * The defensive ENTITY_ID_CHANGED check on the GoTrue PUT response
 * exists in case our pre-flight (parsed.entity_id ===
 * existing.entity_id) somehow disagrees with GoTrue's view of the
 * request body. If GoTrue rejects with an entity_id error here it
 * means our two views diverged, and the safe response is to surface
 * the same ENTITY_ID_CHANGED code the public action would have
 * returned for an actual mismatch.
 */
async function updateProviderInPlace(
  params: UpdateProviderParams,
): Promise<ConfigureOrgSsoProviderResult> {
  const { orgId, actorUserId, source, metadataXml, metadataUrl, parsed, existing } =
    params

  if (!existing.supabase_provider_id) {
    // Defensive: we can't PUT to GoTrue without an id. This shouldn't
    // happen for a row that successfully went through our create path,
    // but legacy rows from the platform-admin path that failed step 7
    // (org flag flip) but succeeded step 6 (DB insert) could have a
    // null supabase_provider_id. Caller should remove and re-configure.
    return {
      ok: false,
      error:
        'Existing provider row is missing its authentication-backend id. Remove and re-configure the provider.',
      errorCode: 'DB_ERROR',
    }
  }

  // GoTrue PUT.
  try {
    await gotrueAdminRequest('PUT', `/admin/sso/providers/${existing.supabase_provider_id}`, {
      metadata_xml: metadataXml,
    })
  } catch (err) {
    const e = err as GoTrueError
    if (e.status === 400 && /entity[_ ]id/i.test(e.message ?? '')) {
      console.error(
        '[sso-admin-provider-config] GoTrue PUT rejected entity_id change unexpectedly',
        { orgId, supabaseProviderId: existing.supabase_provider_id },
      )
      return {
        ok: false,
        error:
          'Identity provider entity ID conflict. Use the replacement flow to proceed.',
        errorCode: 'ENTITY_ID_CHANGED',
        details: {
          conflicting_entity_id: parsed.entity_id,
          expected_entity_id: existing.entity_id,
          proposed_idp_type: parsed.idp_type,
          proposed_cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
          proposed_cert_not_after: parsed.cert.not_after,
        },
      }
    }
    console.error('[sso-admin-provider-config] GoTrue PUT failed', {
      orgId,
      status: e.status,
      gotrueCode: e.gotrueCode,
    })
    return {
      ok: false,
      error: 'Failed to update provider in authentication backend.',
      errorCode: 'GOTRUE_ERROR',
    }
  }

  // DB update with new cert metadata. We list `metadata_xml` and the
  // five cert columns as always-changed (since same-fingerprint would
  // have hit the no-op branch upstream); other fields may or may not
  // have changed.
  const changedFields: string[] = [
    'metadata_xml',
    'cert_fingerprint_sha256',
    'cert_subject',
    'cert_not_before',
    'cert_not_after',
    'cert_signature_algorithm',
  ]
  if (metadataUrl !== existing.metadata_url) changedFields.push('metadata_url')
  if (parsed.idp_type !== existing.idp_type) changedFields.push('idp_type')

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('sso_providers')
    .update({
      idp_type: parsed.idp_type,
      metadata_xml: metadataXml,
      metadata_url: metadataUrl,
      cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
      cert_subject: parsed.cert.subject,
      cert_not_before: parsed.cert.not_before,
      cert_not_after: parsed.cert.not_after,
      cert_signature_algorithm: parsed.cert.signature_algorithm,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select('*')
    .single()

  if (updErr || !updated) {
    // GoTrue PUT succeeded but our DB row didn't update. Worst-case
    // outcome — silent inconsistency. Emit partial_failure audit so
    // ops can detect and reconcile.
    console.error(
      '[sso-admin-provider-config] DB update failed after GoTrue PUT succeeded',
      { orgId, providerId: existing.id, err: updErr?.message },
    )
    await emitSsoAuditEvent('sso.provider.updated', {
      actorUserId,
      orgId,
      metadata: {
        partial_failure: true,
        action: 'updated_in_place',
        supabase_provider_id: existing.supabase_provider_id,
        db_error: String(updErr?.message ?? 'no row returned'),
        source,
        has_metadata_url: source === 'metadata_url',
      },
    })
    return {
      ok: false,
      error: 'Failed to persist updated SSO configuration. Contact support.',
      errorCode: 'DB_ERROR',
    }
  }

  // Audit emit — Mini-D9 single sso.provider.updated event with
  // action discriminator. NO raw URL value (Mini-D13).
  await emitSsoAuditEvent('sso.provider.updated', {
    actorUserId,
    orgId,
    metadata: {
      action: 'updated_in_place',
      idp_type: parsed.idp_type,
      entity_id: parsed.entity_id,
      changed_fields: changedFields,
      supabase_provider_id: existing.supabase_provider_id,
      source,
      has_metadata_url: source === 'metadata_url',
      cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
      previous_cert_fingerprint_sha256: existing.cert_fingerprint_sha256,
      cert_not_after: parsed.cert.not_after,
      cert_signature_algorithm: parsed.cert.signature_algorithm,
      extra_signing_certs_present: parsed.extra_signing_certs_present,
    },
  })

  return {
    ok: true,
    provider: updated as SSOProvider,
    cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
    cert_not_after: parsed.cert.not_after,
    cert_signature_algorithm: parsed.cert.signature_algorithm,
    idp_type: parsed.idp_type,
    entity_id: parsed.entity_id,
    action: 'updated_in_place',
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helper: replaceProvider (entity_id change, CAS-guarded swap)
// ─────────────────────────────────────────────────────────────────────

/**
 * Replace an existing provider with a new one whose entity_id differs.
 * This is the destructive path:
 *
 *   1. POST a NEW GoTrue provider for the new entity_id.
 *   2. CAS-guarded UPDATE on sso_providers (`.eq('supabase_provider_id',
 *      existing.supabase_provider_id)`) — atomic swap with the OLD
 *      provider's pointer. If two admin tabs concurrently replace, one
 *      wins the CAS and the other sees zero rows updated.
 *   3. Best-effort DELETE on the OLD GoTrue provider (404 = already gone).
 *
 * Failure modes:
 *   - Step 1 fails → return GOTRUE_ERROR; existing state intact.
 *   - Step 2 fails → rollback the new GoTrue provider; existing intact.
 *     If rollback also fails, emit partial_failure audit so ops can
 *     reconcile manually.
 *   - Step 3 fails (non-404) → swap succeeded; old GoTrue provider is
 *     now an orphan but the org's auth flow uses the new id. Logged
 *     for ops cleanup; we do NOT fail the action.
 */
async function replaceProvider(
  params: UpdateProviderParams,
): Promise<ConfigureOrgSsoProviderResult> {
  const { orgId, actorUserId, source, metadataXml, metadataUrl, parsed, existing } =
    params

  if (!existing.supabase_provider_id) {
    return {
      ok: false,
      error:
        'Existing provider row is missing its authentication-backend id. Remove and re-configure the provider.',
      errorCode: 'DB_ERROR',
    }
  }

  // Step 1: Create the NEW GoTrue provider FIRST. If this fails, the
  // existing provider remains intact — no rollback needed because
  // we haven't mutated anything yet.
  let newSupabaseProviderId: string
  try {
    const resp = await gotrueAdminRequest<{ id: string }>(
      'POST',
      '/admin/sso/providers',
      { type: 'saml', metadata_xml: metadataXml },
    )
    if (!resp?.id) throw new Error('GoTrue response missing provider id')
    newSupabaseProviderId = resp.id
  } catch (err) {
    const e = err as GoTrueError
    console.error(
      '[sso-admin-provider-config] Replacement: GoTrue POST failed',
      { orgId, status: e.status, gotrueCode: e.gotrueCode },
    )
    return {
      ok: false,
      error: 'Failed to register replacement provider.',
      errorCode: 'GOTRUE_ERROR',
    }
  }

  // Step 2: CAS-guarded DB swap. The
  // `.eq('supabase_provider_id', existing.supabase_provider_id)`
  // clause prevents a TOCTOU race where two admin tabs both try to
  // replace and the second one's swap silently overwrites the first's
  // result. If the CAS check fails (zero rows updated), it means
  // another writer already changed `supabase_provider_id` — we abort
  // and let the second admin re-fetch and decide.
  const { acsUrl, spEntityId } = await getSPUrls()
  const { data: swapped, error: swapErr } = await supabaseAdmin
    .from('sso_providers')
    .update({
      supabase_provider_id: newSupabaseProviderId,
      idp_type: parsed.idp_type,
      entity_id: parsed.entity_id,
      metadata_url: metadataUrl,
      metadata_xml: metadataXml,
      acs_url: acsUrl,
      sp_entity_id: spEntityId,
      cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
      cert_subject: parsed.cert.subject,
      cert_not_before: parsed.cert.not_before,
      cert_not_after: parsed.cert.not_after,
      cert_signature_algorithm: parsed.cert.signature_algorithm,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('supabase_provider_id', existing.supabase_provider_id)
    .select('*')
    .maybeSingle()

  if (swapErr || !swapped) {
    // CAS failed (concurrent writer won) or DB error. Either way,
    // roll back the new GoTrue provider we created in step 1.
    console.error(
      '[sso-admin-provider-config] Replacement: CAS swap failed',
      {
        orgId,
        expectedSupabaseProviderId: existing.supabase_provider_id,
        newSupabaseProviderId,
        err: swapErr?.message ?? 'no row updated (CAS lost)',
      },
    )
    try {
      await gotrueAdminRequest(
        'DELETE',
        `/admin/sso/providers/${newSupabaseProviderId}`,
      )
    } catch (rollbackErr) {
      console.error(
        '[sso-admin-provider-config] Replacement: rollback DELETE failed — MANUAL CLEANUP REQUIRED',
        {
          orgId,
          danglingSupabaseProviderId: newSupabaseProviderId,
          rollbackErr: String(rollbackErr),
        },
      )
      await emitSsoAuditEvent('sso.provider.updated', {
        actorUserId,
        orgId,
        metadata: {
          partial_failure: true,
          action: 'replaced',
          dangling_supabase_provider_id: newSupabaseProviderId,
          rollback_error: String(rollbackErr),
          source,
          has_metadata_url: source === 'metadata_url',
        },
      })
    }
    return {
      ok: false,
      error:
        'Failed to swap provider configuration. Refresh and try again.',
      errorCode: 'DB_ERROR',
    }
  }

  // Step 3: Best-effort DELETE the OLD GoTrue provider. 404 is fine —
  // means it was already gone (e.g. manual cleanup). Any other error
  // we log but do NOT fail on, because the swap succeeded and the
  // org's auth now uses the new id; the old provider is just an
  // orphan that ops can clean up.
  try {
    await gotrueAdminRequest(
      'DELETE',
      `/admin/sso/providers/${existing.supabase_provider_id}`,
    )
  } catch (err) {
    const e = err as GoTrueError
    if (e.status !== 404) {
      console.error(
        '[sso-admin-provider-config] Replacement: old GoTrue provider cleanup failed (non-404)',
        {
          orgId,
          oldSupabaseProviderId: existing.supabase_provider_id,
          status: e.status,
          gotrueCode: e.gotrueCode,
        },
      )
    }
  }

  // Step 4: Audit emit — Mini-D9 single event with action='replaced'.
  // Includes previous_* fields so ops can correlate before/after.
  // NO raw URL (Mini-D13).
  const changedFields: string[] = [
    'idp_type',
    'entity_id',
    'metadata_xml',
    'cert_fingerprint_sha256',
    'cert_subject',
    'cert_not_before',
    'cert_not_after',
    'cert_signature_algorithm',
    'supabase_provider_id',
  ]
  if (metadataUrl !== existing.metadata_url) changedFields.push('metadata_url')

  await emitSsoAuditEvent('sso.provider.updated', {
    actorUserId,
    orgId,
    metadata: {
      action: 'replaced',
      idp_type: parsed.idp_type,
      entity_id: parsed.entity_id,
      changed_fields: changedFields,
      // Replacement-only correlation fields:
      previous_idp_type: existing.idp_type,
      previous_entity_id: existing.entity_id,
      previous_cert_fingerprint_sha256: existing.cert_fingerprint_sha256,
      previous_supabase_provider_id: existing.supabase_provider_id,
      new_supabase_provider_id: newSupabaseProviderId,
      // Source + cert:
      source,
      has_metadata_url: source === 'metadata_url',
      cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
      cert_not_after: parsed.cert.not_after,
      cert_signature_algorithm: parsed.cert.signature_algorithm,
      extra_signing_certs_present: parsed.extra_signing_certs_present,
    },
  })

  return {
    ok: true,
    provider: swapped as SSOProvider,
    cert_fingerprint_sha256: parsed.cert.fingerprint_sha256,
    cert_not_after: parsed.cert.not_after,
    cert_signature_algorithm: parsed.cert.signature_algorithm,
    idp_type: parsed.idp_type,
    entity_id: parsed.entity_id,
    action: 'replaced',
  }
}
