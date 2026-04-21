export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer'

export const ROLE_HIERARCHY: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  editor: 2,
  viewer: 1,
}

export interface Organization {
  id: string
  name: string
  slug: string
  created_at: string
  created_by: string
  sso_enabled: boolean
  enforcement_mode: EnforcementMode
  sso_configured_at: string | null
}

export interface OrgMembership {
  id: string
  org_id: string
  user_id: string
  role: OrgRole
  joined_at: string
  user_name?: string
  user_email?: string
  provisioning_source: ProvisioningSource | null
}

export interface OrgInvite {
  id: string
  org_id: string
  email: string
  role: OrgRole
  token: string
  invited_by: string
  created_at: string
  accepted_at: string | null
  expires_at: string
  org_name?: string
  inviter_name?: string
  expected_auth_method: ExpectedAuthMethod | null
}

export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  role: OrgRole | null
  assigned_at: string
  user_name?: string
  user_email?: string
}

// ── SSO (migration 070) ──────────────────────────────────────
// Mirrors the schema defined in supabase/migrations/070_sso.sql.
// Field names, nullability, and value sets match the database
// exactly. Update both files in lockstep when either changes.

export type EnforcementMode = 'strict' | 'hybrid' | 'optional'
export type IdPType = 'okta' | 'entra' | 'google' | 'generic'
export type ProvisioningSource = 'invite' | 'jit' | 'admin' | 'signup'
export type ExpectedAuthMethod = 'password' | 'sso'

/**
 * SAML attribute mapping shape matching Supabase GoTrue's
 * expected structure. Each key in `keys` is a claim name as it
 * will appear in the issued JWT; the value describes how to
 * extract it from the SAML assertion.
 *
 * Example:
 *   {
 *     keys: {
 *       email: { name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" },
 *       full_name: { name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name" }
 *     }
 *   }
 */
export interface SAMLAttributeMapping {
  keys: Record<string, {
    name: string
    array?: boolean
    default?: unknown
    names?: string[]
  }>
}

export interface SSOProvider {
  id: string
  org_id: string
  supabase_provider_id: string | null
  idp_type: IdPType
  entity_id: string
  metadata_url: string | null
  metadata_xml: string | null
  acs_url: string
  sp_entity_id: string
  attribute_mapping: SAMLAttributeMapping
  created_at: string
  created_by: string | null
  updated_at: string
}

export interface SSODomain {
  id: string
  org_id: string
  domain: string
  verified_at: string | null
  added_by: string | null
  created_at: string
}

export interface SSOIdentityLink {
  user_id: string
  org_id: string
  sso_provider_id: string
  linked_at: string
  last_login_at: string | null
}
