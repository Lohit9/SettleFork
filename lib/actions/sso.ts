'use server'

import { createHash } from 'crypto'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { gotrueAdminRequest, type GoTrueError } from '@/lib/sso/gotrue-admin'
import { emitSsoAuditEvent } from '@/lib/actions/sso-audit'
import { hashEmail } from '@/lib/sso/email-hash'
import { getClientIp, hashIp } from '@/lib/auth/get-client-ip'
import { checkRateLimit } from '@/lib/rate-limit/upstash'
import type {
  SSOProvider,
  SSODomain,
  IdPType,
  EnforcementMode,
  SAMLAttributeMapping,
} from '@/lib/types/organizations'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

/**
 * Derive project-scoped URLs from the Supabase project URL.
 * These are the SAME for every org — they identify Settle as the
 * Service Provider, not an org-specific IdP. Stored on each
 * sso_providers row for admin-UI display convenience.
 */
function getSPUrls() {
  return {
    acsUrl: `${SUPABASE_URL}/auth/v1/sso/saml/acs`,
    spEntityId: `${SUPABASE_URL}/auth/v1/sso/saml/metadata`,
  }
}

/**
 * GoTrue SSO provider response schema (POST / GET / PUT).
 * Defensive parse — only `id` is load-bearing for our flows.
 */
interface SSOProviderSchema {
  id: string
  saml?: {
    entity_id?: string
    metadata_url?: string
    metadata_xml?: string
    attribute_mapping?: SAMLAttributeMapping
  }
  sso_domains?: Array<{ domain: string }>
  created_at?: string
  updated_at?: string
}

const VALID_IDP_TYPES: readonly IdPType[] = [
  'okta',
  'entra',
  'google',
  'generic',
] as const

const VALID_ENFORCEMENT_MODES: readonly EnforcementMode[] = [
  'strict',
  'hybrid',
  'optional',
] as const

const DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ────────────────────────────────────────────────────────────────
// Action 1: configureSSOProvider
// ────────────────────────────────────────────────────────────────

/**
 * Create a new SAML SSO provider for an org.
 *
 * Flow:
 *   1. Require platform admin
 *   2. Validate input
 *   3. Check idempotence (reject if org already has provider)
 *   4. Run password-only guardrail unless forceOverride
 *   5. POST to GoTrue to register the provider
 *   6. Insert sso_providers row
 *   7. Flip organizations.sso_enabled = true
 *   8. Emit audit event
 *
 * On step 6 failure: attempt to DELETE the GoTrue provider
 * (rollback). Log loudly if rollback also fails.
 */
export async function configureSSOProvider(
  orgId: string,
  config: {
    idpType: IdPType
    metadataXml?: string
    metadataUrl?: string
    entityId: string
    attributeMapping?: SAMLAttributeMapping
  },
  options?: { forceOverride?: boolean }
): Promise<{
  provider: SSOProvider | null
  error?: string
  errorCode?:
    | 'NOT_AUTHORIZED'
    | 'VALIDATION'
    | 'PASSWORD_USERS_EXIST'
    | 'ALREADY_CONFIGURED'
    | 'GOTRUE_ERROR'
    | 'DB_ERROR'
  passwordUserCount?: number
}> {
  // Step 1: Auth gate
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      provider: null,
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  // Step 2: Validate input
  if (!VALID_IDP_TYPES.includes(config.idpType)) {
    return {
      provider: null,
      error: 'Invalid idpType',
      errorCode: 'VALIDATION',
    }
  }
  if (!config.entityId || config.entityId.trim().length === 0) {
    return {
      provider: null,
      error: 'entityId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!config.metadataXml && !config.metadataUrl) {
    return {
      provider: null,
      error: 'Either metadataXml or metadataUrl is required',
      errorCode: 'VALIDATION',
    }
  }
  if (config.metadataUrl) {
    try {
      const u = new URL(config.metadataUrl)
      if (u.protocol !== 'https:') {
        return {
          provider: null,
          error: 'metadataUrl must use https://',
          errorCode: 'VALIDATION',
        }
      }
    } catch {
      return {
        provider: null,
        error: 'metadataUrl is not a valid URL',
        errorCode: 'VALIDATION',
      }
    }
  }

  // Step 3: Idempotence — reject if provider already exists
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('sso_providers')
    .select('id')
    .eq('org_id', orgId)
    .maybeSingle()
  if (existingErr) {
    console.error('[sso] configureSSOProvider existence check failed:', {
      orgId,
      error: existingErr.message,
    })
    return {
      provider: null,
      error: 'Pre-flight check failed',
      errorCode: 'DB_ERROR',
    }
  }
  if (existing) {
    return {
      provider: null,
      error:
        'SSO provider already configured for this organization. Use updateSSOProvider to modify.',
      errorCode: 'ALREADY_CONFIGURED',
    }
  }

  // Step 4: Password-only guardrail
  if (!options?.forceOverride) {
    const { data: countData, error: countErr } = await supabaseAdmin.rpc(
      'count_password_only_users_in_org',
      { p_org_id: orgId }
    )
    if (countErr) {
      console.error('[sso] count_password_only_users_in_org failed:', {
        orgId,
        error: countErr.message,
      })
      return {
        provider: null,
        error: 'Pre-flight check failed',
        errorCode: 'DB_ERROR',
      }
    }
    const count = typeof countData === 'number' ? countData : 0
    if (count > 0) {
      return {
        provider: null,
        error: `${count} user(s) in this org have only email-password identities. Use the link-identity flow to convert them, or pass forceOverride: true to proceed (users will need to re-link on next login).`,
        errorCode: 'PASSWORD_USERS_EXIST',
        passwordUserCount: count,
      }
    }
  }

  // Step 5: GoTrue POST
  let supabaseProviderId: string
  try {
    const gotrueBody: Record<string, unknown> = { type: 'saml' }
    if (config.metadataUrl) gotrueBody.metadata_url = config.metadataUrl
    if (config.metadataXml) gotrueBody.metadata_xml = config.metadataXml
    if (config.attributeMapping) {
      gotrueBody.attribute_mapping = config.attributeMapping
    }

    const resp = await gotrueAdminRequest<SSOProviderSchema>(
      'POST',
      '/admin/sso/providers',
      gotrueBody
    )
    if (!resp?.id) {
      throw new Error('GoTrue response missing provider id')
    }
    supabaseProviderId = resp.id
  } catch (err) {
    const e = err as GoTrueError
    console.error('[sso] configureSSOProvider GoTrue POST failed:', {
      orgId,
      status: e.status,
      gotrueCode: e.gotrueCode,
    })
    return {
      provider: null,
      error: `GoTrue provisioning failed: ${e.message}`,
      errorCode: 'GOTRUE_ERROR',
    }
  }

  // Step 6: Insert sso_providers row (with rollback on failure)
  const { acsUrl, spEntityId } = getSPUrls()
  try {
    const { data: provider, error: insErr } = await supabaseAdmin
      .from('sso_providers')
      .insert({
        org_id: orgId,
        supabase_provider_id: supabaseProviderId,
        idp_type: config.idpType,
        entity_id: config.entityId,
        metadata_url: config.metadataUrl ?? null,
        metadata_xml: config.metadataXml ?? null,
        acs_url: acsUrl,
        sp_entity_id: spEntityId,
        attribute_mapping: config.attributeMapping ?? { keys: {} },
        created_by: admin.userId,
      })
      .select('*')
      .single()

    if (insErr) throw insErr

    // Step 7: Flip organizations.sso_enabled
    const { error: orgErr } = await supabaseAdmin
      .from('organizations')
      .update({
        sso_enabled: true,
        sso_configured_at: new Date().toISOString(),
      })
      .eq('id', orgId)

    if (orgErr) {
      // Not a full rollback — provider is configured, just the flag
      // isn't set. Surface as warning, not failure. Will be detected
      // next time getProviderConfigForOrg runs.
      console.error('[sso] Failed to flip organizations.sso_enabled', {
        orgId,
        error: orgErr.message,
      })
    }

    // Step 8: Audit event
    await emitSsoAuditEvent('sso.provider.configured', {
      actorUserId: admin.userId,
      orgId,
      metadata: {
        idp_type: config.idpType,
        entity_id: config.entityId,
        acs_url: acsUrl,
        supabase_provider_id: supabaseProviderId,
        has_metadata_url: !!config.metadataUrl,
        has_metadata_xml: !!config.metadataXml,
        attribute_mapping_keys: config.attributeMapping
          ? Object.keys(config.attributeMapping.keys)
          : [],
        force_override: !!options?.forceOverride,
      },
    })

    revalidatePath('/admin/sso')
    return { provider: provider as SSOProvider }
  } catch (insErr) {
    console.error('[sso] DB insert failed, attempting GoTrue rollback', {
      orgId,
      supabaseProviderId,
      insErr: String(insErr),
    })
    try {
      await gotrueAdminRequest(
        'DELETE',
        `/admin/sso/providers/${supabaseProviderId}`
      )
      console.error('[sso] GoTrue rollback successful')
    } catch (rollbackErr) {
      console.error(
        '[sso] DB insert AND GoTrue rollback failed — MANUAL CLEANUP REQUIRED',
        {
          orgId,
          supabaseProviderId,
          insErr: String(insErr),
          rollbackErr: String(rollbackErr),
        }
      )
      await emitSsoAuditEvent('sso.provider.configured', {
        actorUserId: admin.userId,
        orgId,
        metadata: {
          partial_failure: true,
          dangling_supabase_provider_id: supabaseProviderId,
          db_error: String(insErr),
          rollback_error: String(rollbackErr),
        },
      })
    }
    return {
      provider: null,
      error:
        'Failed to persist SSO configuration. Contact support if issue persists.',
      errorCode: 'DB_ERROR',
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Action 2: updateSSOProvider
// ────────────────────────────────────────────────────────────────

/**
 * Update an existing SSO provider's metadata or attribute mapping.
 *
 * Entity ID cannot be changed per Supabase GoTrue constraint.
 * Surfaces 'ENTITY_ID_CHANGED' errorCode if GoTrue rejects.
 */
export async function updateSSOProvider(
  orgId: string,
  update: Partial<{
    metadataXml: string
    metadataUrl: string
    attributeMapping: SAMLAttributeMapping
  }>
): Promise<{
  provider: SSOProvider | null
  error?: string
  errorCode?:
    | 'NOT_AUTHORIZED'
    | 'NOT_CONFIGURED'
    | 'VALIDATION'
    | 'ENTITY_ID_CHANGED'
    | 'GOTRUE_ERROR'
    | 'DB_ERROR'
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      provider: null,
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  if (update.metadataUrl) {
    try {
      const u = new URL(update.metadataUrl)
      if (u.protocol !== 'https:') {
        return {
          provider: null,
          error: 'metadataUrl must use https://',
          errorCode: 'VALIDATION',
        }
      }
    } catch {
      return {
        provider: null,
        error: 'metadataUrl is not a valid URL',
        errorCode: 'VALIDATION',
      }
    }
  }

  // Fetch current provider
  const { data: current, error: curErr } = await supabaseAdmin
    .from('sso_providers')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle()

  if (curErr) {
    console.error('[sso] updateSSOProvider fetch failed:', {
      orgId,
      error: curErr.message,
    })
    return {
      provider: null,
      error: 'Failed to load current provider',
      errorCode: 'DB_ERROR',
    }
  }

  if (!current || !current.supabase_provider_id) {
    return {
      provider: null,
      error: 'No SSO provider configured for this organization.',
      errorCode: 'NOT_CONFIGURED',
    }
  }

  const hasAnyUpdate =
    update.metadataXml !== undefined ||
    update.metadataUrl !== undefined ||
    update.attributeMapping !== undefined

  if (!hasAnyUpdate) {
    return {
      provider: null,
      error: 'No fields to update',
      errorCode: 'VALIDATION',
    }
  }

  // PUT to GoTrue
  const gotrueBody: Record<string, unknown> = {}
  if (update.metadataUrl !== undefined) {
    gotrueBody.metadata_url = update.metadataUrl
  }
  if (update.metadataXml !== undefined) {
    gotrueBody.metadata_xml = update.metadataXml
  }
  if (update.attributeMapping !== undefined) {
    gotrueBody.attribute_mapping = update.attributeMapping
  }

  try {
    await gotrueAdminRequest<SSOProviderSchema>(
      'PUT',
      `/admin/sso/providers/${current.supabase_provider_id}`,
      gotrueBody
    )
  } catch (err) {
    const e = err as GoTrueError
    console.error('[sso] updateSSOProvider GoTrue PUT failed:', {
      orgId,
      status: e.status,
      gotrueCode: e.gotrueCode,
    })
    const msg = e.message ?? ''
    // GoTrue surfaces entity_id change rejection in the error message
    if (
      e.status === 400 &&
      /entity[_ ]id/i.test(msg)
    ) {
      return {
        provider: null,
        error:
          'Entity ID cannot be changed after provider creation. Remove and re-configure the provider.',
        errorCode: 'ENTITY_ID_CHANGED',
      }
    }
    return {
      provider: null,
      error: `GoTrue update failed: ${e.message}`,
      errorCode: 'GOTRUE_ERROR',
    }
  }

  // Update sso_providers row
  const dbPatch: Record<string, unknown> = {}
  const changedFields: string[] = []
  if (update.metadataUrl !== undefined) {
    dbPatch.metadata_url = update.metadataUrl
    changedFields.push('metadata_url')
  }
  if (update.metadataXml !== undefined) {
    dbPatch.metadata_xml = update.metadataXml
    changedFields.push('metadata_xml')
  }
  if (update.attributeMapping !== undefined) {
    dbPatch.attribute_mapping = update.attributeMapping
    changedFields.push('attribute_mapping')
  }

  const { data: provider, error: updErr } = await supabaseAdmin
    .from('sso_providers')
    .update(dbPatch)
    .eq('id', current.id)
    .select('*')
    .single()

  if (updErr) {
    console.error('[sso] updateSSOProvider DB update failed:', {
      orgId,
      error: updErr.message,
    })
    return {
      provider: null,
      error: 'Failed to persist SSO configuration update.',
      errorCode: 'DB_ERROR',
    }
  }

  await emitSsoAuditEvent('sso.provider.updated', {
    actorUserId: admin.userId,
    orgId,
    metadata: {
      changed_fields: changedFields,
      supabase_provider_id: current.supabase_provider_id,
      // Intentionally omit metadata_xml / metadata_url values —
      // they may be large and/or contain sensitive details.
      attribute_mapping_keys: update.attributeMapping
        ? Object.keys(update.attributeMapping.keys)
        : undefined,
    },
  })

  revalidatePath('/admin/sso')
  return { provider: provider as SSOProvider }
}

// ────────────────────────────────────────────────────────────────
// Action 3: removeSSOProvider
// ────────────────────────────────────────────────────────────────

/**
 * Remove SSO provider and reset org to non-SSO state.
 *
 * Effects:
 *   - Deletes GoTrue provider (cascades all SAML sessions on the
 *     GoTrue side)
 *   - Deletes our sso_providers row (ON DELETE CASCADE removes
 *     sso_identity_links)
 *   - Deletes sso_domains for this org
 *   - Resets organizations: sso_enabled=false,
 *     enforcement_mode='hybrid', sso_configured_at=NULL
 *   - Emits sso.provider.removed AND (if mode was non-hybrid)
 *     sso.enforcement.changed audit events
 */
export async function removeSSOProvider(orgId: string): Promise<{
  success: boolean
  error?: string
  errorCode?:
    | 'NOT_AUTHORIZED'
    | 'NOT_CONFIGURED'
    | 'GOTRUE_ERROR'
    | 'DB_ERROR'
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      success: false,
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  // Fetch current provider
  const { data: current, error: curErr } = await supabaseAdmin
    .from('sso_providers')
    .select('id, supabase_provider_id, idp_type, entity_id')
    .eq('org_id', orgId)
    .maybeSingle()

  if (curErr) {
    console.error('[sso] removeSSOProvider fetch failed:', {
      orgId,
      error: curErr.message,
    })
    return {
      success: false,
      error: 'Failed to load current provider',
      errorCode: 'DB_ERROR',
    }
  }

  if (!current) {
    return {
      success: false,
      error: 'No SSO provider configured for this organization.',
      errorCode: 'NOT_CONFIGURED',
    }
  }

  // Fetch current org state for audit metadata
  const { data: org, error: orgFetchErr } = await supabaseAdmin
    .from('organizations')
    .select('enforcement_mode')
    .eq('id', orgId)
    .maybeSingle()

  if (orgFetchErr) {
    console.error('[sso] removeSSOProvider org fetch failed:', {
      orgId,
      error: orgFetchErr.message,
    })
    return {
      success: false,
      error: 'Failed to load organization state',
      errorCode: 'DB_ERROR',
    }
  }

  const previousEnforcementMode = (org?.enforcement_mode ??
    'hybrid') as EnforcementMode

  // Count rows to be removed (for audit metadata)
  const [{ count: domainCount }, { count: linkCount }] = await Promise.all([
    supabaseAdmin
      .from('sso_domains')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId),
    supabaseAdmin
      .from('sso_identity_links')
      .select('user_id', { count: 'exact', head: true })
      .eq('org_id', orgId),
  ])

  // Delete GoTrue provider — treat 404 as idempotent success
  if (current.supabase_provider_id) {
    try {
      await gotrueAdminRequest(
        'DELETE',
        `/admin/sso/providers/${current.supabase_provider_id}`
      )
    } catch (err) {
      const e = err as GoTrueError
      if (e.status === 404) {
        console.warn('[sso] removeSSOProvider: GoTrue provider already gone', {
          orgId,
          supabase_provider_id: current.supabase_provider_id,
        })
      } else {
        console.error('[sso] removeSSOProvider GoTrue DELETE failed:', {
          orgId,
          status: e.status,
          gotrueCode: e.gotrueCode,
        })
        return {
          success: false,
          error: `GoTrue deletion failed: ${e.message}`,
          errorCode: 'GOTRUE_ERROR',
        }
      }
    }
  }

  // Delete sso_providers (CASCADE handles sso_identity_links)
  const { error: delProvErr } = await supabaseAdmin
    .from('sso_providers')
    .delete()
    .eq('org_id', orgId)

  if (delProvErr) {
    console.error('[sso] removeSSOProvider delete provider failed:', {
      orgId,
      error: delProvErr.message,
    })
    return {
      success: false,
      error: 'Failed to delete provider row',
      errorCode: 'DB_ERROR',
    }
  }

  // Delete sso_domains
  const { error: delDomErr } = await supabaseAdmin
    .from('sso_domains')
    .delete()
    .eq('org_id', orgId)

  if (delDomErr) {
    console.error('[sso] removeSSOProvider delete domains failed:', {
      orgId,
      error: delDomErr.message,
    })
    return {
      success: false,
      error: 'Failed to delete domain rows',
      errorCode: 'DB_ERROR',
    }
  }

  // Reset org state
  const { error: orgUpdErr } = await supabaseAdmin
    .from('organizations')
    .update({
      sso_enabled: false,
      enforcement_mode: 'hybrid',
      sso_configured_at: null,
    })
    .eq('id', orgId)

  if (orgUpdErr) {
    console.error('[sso] removeSSOProvider org reset failed:', {
      orgId,
      error: orgUpdErr.message,
    })
    return {
      success: false,
      error: 'Failed to reset organization state',
      errorCode: 'DB_ERROR',
    }
  }

  await emitSsoAuditEvent('sso.provider.removed', {
    actorUserId: admin.userId,
    orgId,
    metadata: {
      supabase_provider_id: current.supabase_provider_id,
      previous_idp_type: current.idp_type,
      previous_entity_id: current.entity_id,
      domain_count_removed: domainCount ?? 0,
      identity_link_count_removed: linkCount ?? 0,
    },
  })

  if (previousEnforcementMode !== 'hybrid') {
    await emitSsoAuditEvent('sso.enforcement.changed', {
      actorUserId: admin.userId,
      orgId,
      metadata: {
        previous_mode: previousEnforcementMode,
        new_mode: 'hybrid',
        reason: 'provider_removed',
      },
    })
  }

  revalidatePath('/admin/sso')
  return { success: true }
}

// ────────────────────────────────────────────────────────────────
// Action 4: setEnforcementMode
// ────────────────────────────────────────────────────────────────

/**
 * Set the SSO enforcement mode for an org.
 *
 *   - strict:   SSO required for all non-platform-admin users
 *   - hybrid:   SSO OR password allowed
 *   - optional: SSO available but password preferred
 *
 * Platform admins are always exempt from enforcement.
 * Mixed enforcement across orgs is most-restrictive-wins
 * (enforcement logic in middleware, Prompt B).
 */
export async function setEnforcementMode(
  orgId: string,
  mode: EnforcementMode
): Promise<{
  success: boolean
  error?: string
  errorCode?: 'NOT_AUTHORIZED' | 'VALIDATION' | 'DB_ERROR'
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      success: false,
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  if (!VALID_ENFORCEMENT_MODES.includes(mode)) {
    return {
      success: false,
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
    console.error('[sso] setEnforcementMode fetch failed:', {
      orgId,
      error: fetchErr?.message ?? 'org not found',
    })
    return {
      success: false,
      error: 'Organization not found',
      errorCode: 'DB_ERROR',
    }
  }

  const previousMode = org.enforcement_mode as EnforcementMode

  const { error: updErr } = await supabaseAdmin
    .from('organizations')
    .update({ enforcement_mode: mode })
    .eq('id', orgId)

  if (updErr) {
    console.error('[sso] setEnforcementMode update failed:', {
      orgId,
      error: updErr.message,
    })
    return {
      success: false,
      error: 'Failed to update enforcement mode',
      errorCode: 'DB_ERROR',
    }
  }

  if (previousMode !== mode) {
    await emitSsoAuditEvent('sso.enforcement.changed', {
      actorUserId: admin.userId,
      orgId,
      metadata: {
        previous_mode: previousMode,
        new_mode: mode,
      },
    })
  }

  revalidatePath('/admin/sso')
  return { success: true }
}

// ────────────────────────────────────────────────────────────────
// Action 5: addDomainAllowlist
// ────────────────────────────────────────────────────────────────

/**
 * Add a domain to the org's SSO allowlist. Enforces the one-org-
 * per-domain constraint at the DB level; if another org owns this
 * domain, returns DOMAIN_ALREADY_MAPPED with the conflicting
 * orgId.
 */
export async function addDomainAllowlist(
  orgId: string,
  domain: string
): Promise<{
  domain: SSODomain | null
  error?: string
  errorCode?:
    | 'NOT_AUTHORIZED'
    | 'VALIDATION'
    | 'DOMAIN_ALREADY_MAPPED'
    | 'DB_ERROR'
  conflictingOrgId?: string
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      domain: null,
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  const normalized = domain.trim().toLowerCase()
  if (normalized.length === 0 || normalized.length > 253) {
    return {
      domain: null,
      error: 'Domain must be 1–253 characters',
      errorCode: 'VALIDATION',
    }
  }
  if (!DOMAIN_REGEX.test(normalized)) {
    return {
      domain: null,
      error: 'Domain format is invalid',
      errorCode: 'VALIDATION',
    }
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('sso_domains')
    .insert({
      org_id: orgId,
      domain: normalized,
      added_by: admin.userId,
    })
    .select('*')
    .single()

  if (insErr) {
    // Postgres unique_violation
    if ((insErr as { code?: string }).code === '23505') {
      const { data: conflict } = await supabaseAdmin
        .from('sso_domains')
        .select('org_id')
        .eq('domain', normalized)
        .maybeSingle()
      return {
        domain: null,
        error:
          'This domain is already mapped to another organization. One-org-per-domain is enforced.',
        errorCode: 'DOMAIN_ALREADY_MAPPED',
        conflictingOrgId: conflict?.org_id ?? undefined,
      }
    }
    console.error('[sso] addDomainAllowlist insert failed:', {
      orgId,
      error: insErr.message,
    })
    return {
      domain: null,
      error: 'Failed to add domain',
      errorCode: 'DB_ERROR',
    }
  }

  await emitSsoAuditEvent('sso.domain.added', {
    actorUserId: admin.userId,
    orgId,
    metadata: {
      domain: normalized,
    },
  })

  revalidatePath('/admin/sso')
  return { domain: inserted as SSODomain }
}

// ────────────────────────────────────────────────────────────────
// Action 6: removeDomainAllowlist
// ────────────────────────────────────────────────────────────────

/**
 * Remove a domain from the org's SSO allowlist. Idempotent —
 * returns success whether or not a row existed.
 */
export async function removeDomainAllowlist(
  orgId: string,
  domain: string
): Promise<{
  success: boolean
  error?: string
  errorCode?: 'NOT_AUTHORIZED' | 'DB_ERROR'
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      success: false,
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  const normalized = domain.trim().toLowerCase()

  const { error: delErr } = await supabaseAdmin
    .from('sso_domains')
    .delete()
    .eq('org_id', orgId)
    .eq('domain', normalized)

  if (delErr) {
    console.error('[sso] removeDomainAllowlist delete failed:', {
      orgId,
      error: delErr.message,
    })
    return {
      success: false,
      error: 'Failed to remove domain',
      errorCode: 'DB_ERROR',
    }
  }

  await emitSsoAuditEvent('sso.domain.removed', {
    actorUserId: admin.userId,
    orgId,
    metadata: {
      domain: normalized,
    },
  })

  revalidatePath('/admin/sso')
  return { success: true }
}

// ────────────────────────────────────────────────────────────────
// Action 7: checkSSOEnabledForEmail (PUBLIC)
// ────────────────────────────────────────────────────────────────

/**
 * Check whether an email's domain maps to an SSO-enabled org.
 *
 * PUBLIC — no authentication required. Called from the login
 * page during email entry (Prompt B) to determine whether to
 * show the "Continue with SSO" button or the password form.
 *
 * Calls the lookup_sso_provider_for_domain RPC via supabaseAdmin
 * (the RPC is service_role only to prevent direct-from-browser
 * enumeration). This server action is the only surface that
 * reaches it.
 *
 * Rate limited (B-2-a-i): per-IP per-email-domain, 10/min sliding
 * window via Upstash. Composite key prevents a single IP from
 * enumerating all customer domains; per-domain (not per-email)
 * because all emails in a domain map to the same answer, so an
 * attacker probing kaan@example.com and bob@example.com gets
 * counted once.
 *
 * Fail-closed semantics, in three layers:
 *   1. No client IP → return { required: false } (no audit emit).
 *   2. Rate limit hit → emit sso.login.failure with reason='rate_limited',
 *      return { required: false } (indistinguishable from "no SSO").
 *   3. Any RPC error → return { required: false }.
 *
 * The narrow return shape ({ required, orgSlug? } only) is a
 * defense-in-depth measure: the legacy shape leaked org_id, the
 * internal sso_providers.id, and enforcement_mode to unauthenticated
 * callers.
 *
 * Return-shape semantics (broadened in B-2-b for hybrid-mode UX):
 *
 *   { required: true,  orgSlug: '<slug>' }  — strict org. UI must
 *                                             redirect to /sso/start.
 *   { required: false, orgSlug: '<slug>' }  — hybrid OR optional org
 *                                             (SSO available, password
 *                                             also allowed). UI shows
 *                                             both sign-in options.
 *   { required: false }                     — no SSO mapping for the
 *                                             email's domain, OR any
 *                                             fail-closed branch
 *                                             (rate-limit hit, RPC
 *                                             error, missing IP, …).
 *                                             UI shows password only.
 *
 * Why the slug is OK to leak whenever a provider exists: it is already
 * public — it appears in the bookmarkable /sso/start?org=<slug> URL
 * that customers share with their employees. The narrowing in B-2-a-i
 * was about NOT leaking org_id, sso_providers.id, and enforcement_mode
 * (all internal); the slug was over-narrowed and is restored here for
 * the hybrid-mode "Continue with SSO" affordance.
 *
 * Fail-closed paths intentionally return { required: false } with NO
 * orgSlug so a rate-limit hit (or any other failure) is
 * indistinguishable from "no SSO for this domain" — preserves the
 * anti-enumeration property from B-2-a-i.
 *
 * Every call (allowed or denied) is logged with email_hash for
 * observability — never the raw email.
 */
export async function checkSSOEnabledForEmail(email: string): Promise<{
  required: boolean
  orgSlug?: string
}> {
  const emailHash = hashEmail(email ?? '')
  console.info('[sso] checkSSOEnabledForEmail invoked', {
    email_hash: emailHash,
  })

  // Layer 1: client IP required for the rate-limit bucket. No IP
  // means we cannot attribute the request, and a hardcoded fallback
  // would collide all anonymous traffic into one bucket — defeating
  // the limiter. Fail-closed: deny silently.
  const ip = await getClientIp()
  if (!ip) {
    console.warn('[sso] checkSSOEnabledForEmail: no client IP, rejecting')
    return { required: false }
  }

  if (!email || !EMAIL_REGEX.test(email)) {
    return { required: false }
  }

  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) {
    return { required: false }
  }
  const domainHash = createHash('sha256')
    .update(domain)
    .digest('hex')
    .slice(0, 16)

  const rlResult = await checkRateLimit(`${ip}:${domainHash}`, {
    kind: 'sso-check',
    limit: 10,
    window: '60 s',
  })

  if (!rlResult.allowed) {
    await emitSsoAuditEvent('sso.login.failure', {
      actorUserId: null,
      orgId: null,
      metadata: {
        reason: 'rate_limited',
        key_kind: 'sso-check',
        ip_hash: hashIp(ip),
        target_hash: domainHash,
        email_hash: emailHash,
        limit: rlResult.limit,
        window_seconds: 60,
        reset_at: rlResult.resetAt,
      },
    })
    // Indistinguishable from "no SSO required for this email". Do NOT
    // signal rate-limit state to the caller — the distinction itself
    // is what an attacker uses to confirm a domain is real.
    return { required: false }
  }

  const { data, error } = await supabaseAdmin.rpc(
    'lookup_sso_provider_for_domain',
    { p_email: email }
  )

  if (error) {
    console.error('[sso] lookup_sso_provider_for_domain failed:', {
      email_hash: emailHash,
      error: error.message,
    })
    return { required: false }
  }

  const rows = (data ?? []) as Array<{
    org_id: string
    sso_provider_id: string
    enforcement_mode: string
    org_slug: string
  }>

  if (rows.length === 0) {
    return { required: false }
  }

  const row = rows[0]
  // Defensive: the RPC's TABLE return type guarantees these columns
  // are non-null when a row matches (see migration 072), but a
  // missing-or-empty value here is treated as "no SSO" rather than
  // crashing the login page. orgSlug in particular MUST be a string
  // for the /sso/start redirect to be valid.
  if (!row.org_slug || !row.enforcement_mode) {
    return { required: false }
  }

  // Broadened return shape (B-2-b, Mini-D1):
  //   - `required` is TRUE only for strict orgs (the login page must
  //     redirect immediately; password is not allowed).
  //   - `orgSlug` is returned whenever a provider exists for the
  //     email's domain (strict / hybrid / optional). Hybrid + optional
  //     orgs surface a "Continue with SSO" button alongside the
  //     password form.
  //
  // org_id, sso_provider_id, and enforcement_mode are STILL NOT
  // returned — they are internal config and remain hidden from
  // unauthenticated callers per B-2-a-i's narrowing rationale.
  const required = row.enforcement_mode === 'strict'
  return {
    required,
    orgSlug: row.org_slug,
  }
}

// ────────────────────────────────────────────────────────────────
// Action 8: getProviderConfigForOrg
// ────────────────────────────────────────────────────────────────

/**
 * Get the current SSO provider configuration and domain list
 * for an org. For use by the admin UI (Prompt D).
 */
export async function getProviderConfigForOrg(orgId: string): Promise<{
  provider: SSOProvider | null
  domains: SSODomain[]
  error?: string
  errorCode?: 'NOT_AUTHORIZED' | 'DB_ERROR'
}> {
  const admin = await requirePlatformAdmin()
  if (!admin.ok) {
    return {
      provider: null,
      domains: [],
      error: admin.error,
      errorCode: 'NOT_AUTHORIZED',
    }
  }

  const [provResult, domResult] = await Promise.all([
    supabaseAdmin
      .from('sso_providers')
      .select('*')
      .eq('org_id', orgId)
      .maybeSingle(),
    supabaseAdmin
      .from('sso_domains')
      .select('*')
      .eq('org_id', orgId)
      .order('domain'),
  ])

  if (provResult.error) {
    console.error('[sso] getProviderConfigForOrg provider fetch failed:', {
      orgId,
      error: provResult.error.message,
    })
    return {
      provider: null,
      domains: [],
      error: 'Failed to load SSO configuration',
      errorCode: 'DB_ERROR',
    }
  }
  if (domResult.error) {
    console.error('[sso] getProviderConfigForOrg domains fetch failed:', {
      orgId,
      error: domResult.error.message,
    })
    return {
      provider: null,
      domains: [],
      error: 'Failed to load SSO domains',
      errorCode: 'DB_ERROR',
    }
  }

  return {
    provider: (provResult.data as SSOProvider | null) ?? null,
    domains: (domResult.data as SSODomain[] | null) ?? [],
  }
}
