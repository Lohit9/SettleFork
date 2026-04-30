// ── Role taxonomies (migration 079: project-level RBAC strict membership) ──
//
// Org and project roles are independent vocabularies after 079:
//   - OrgRole controls org administration (rename/invite/role-change/toggle).
//     Values: 'owner' (full control) | 'member' (regular org user).
//   - ProjectRole controls project access. Values: 'admin' | 'editor' | 'viewer'.
//     A user has access to a project iff a project_members row exists for them.
//     There is no implicit access from org membership.
//
// Auto-grant rules (event-driven, idempotent — see migration 079 §J):
//   - Org owners are auto-granted project-admin on every project in the org.
//   - Org members are auto-granted project-editor on every project in the org
//     IFF organizations.member_auto_grant_enabled = TRUE.
//   - Project creators are auto-granted project-admin on the project they create.
//   - Removal of a project_members row sticks (every fanout uses
//     ON CONFLICT DO NOTHING).
export type OrgRole = 'owner' | 'member'

export type ProjectRole = 'admin' | 'editor' | 'viewer'

// Numeric hierarchy for role-comparison checks (e.g. requireProjectPermission).
// Higher number = more privileges. The actual checks live in
// lib/actions/role-resolution.ts and lib/hooks/useProjectRole.ts; this map is
// the single source of truth they share.
export const PROJECT_ROLE_HIERARCHY: Record<ProjectRole, number> = {
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
  // Migration 079: per-org toggle for member project_members auto-grant.
  // Defaults TRUE for backward compatibility. Owners are auto-granted
  // regardless of this flag; only the member-fanout consults it.
  member_auto_grant_enabled: boolean
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
  // Nullable in the DB schema (legacy from migration 050). Migration 079
  // tightens the CHECK constraint to ('admin','editor','viewer') but does
  // not add NOT NULL — pre-existing NULL rows are still possible. Treat
  // null as "no role" (no access). NOT NULL is deferred to PR 2 cleanup.
  role: ProjectRole | null
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
  // Cert metadata columns added by migration 080. Populated by the
  // org-admin metadata upload flow (B-2-c-iii). NULL for providers
  // configured via the platform-admin path before B-2-c-iii landed.
  cert_fingerprint_sha256: string | null
  cert_subject: string | null
  cert_not_before: string | null
  cert_not_after: string | null
  cert_signature_algorithm: string | null
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
