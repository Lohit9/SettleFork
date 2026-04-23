-- ============================================================
-- 070: SSO foundation
--
-- Adds the SAML 2.0 SSO primitives for Settle: per-org provider
-- configuration, domain allowlisting, identity-link tracking, a
-- placeholder audit-event store, enforcement-mode / provisioning-
-- source / expected-auth-method columns on existing org tables, and
-- six SECURITY DEFINER RPCs that back the login, callback, and
-- admin-preflight paths. Strictly additive: no DROP, no data
-- backfill, no application-code changes.
--
-- Dependencies (must be applied first):
--   050  organizations / org_memberships / org_invites /
--        project_members + user_can_access_project /
--        user_has_project_role / get_user_project_role
--   051  get_user_org_ids() / get_user_admin_org_ids() helpers
--   052  role enum tightened to owner/admin/editor/viewer; CHECK
--        on project_members.role updated
--   067  org_invites RLS leak fix (anyone_can_read_invite_by_token
--        dropped)
--   068  public.platform_admins + is_platform_admin(UUID)
--   069  find_auth_user_by_email / get_auth_emails_by_ids pattern
--        (this migration mirrors their style: LANGUAGE sql +
--        STABLE + SET search_path = public + REVOKE ALL /
--        GRANT EXECUTE)
--
-- Locked design decisions encoded in this migration:
--    1 SAML 2.0 only at launch (no OIDC); idp_type CHECK is
--      restricted to okta/entra/google/generic.
--    2 Enforcement modes 'strict' | 'hybrid' | 'optional', default
--      'hybrid' (column on organizations).
--    3 JIT provisioning: role from pending invite if present, else
--      'viewer' (provision_user_via_jit RPC).
--    4 Platform-admin white-glove config — this migration only
--      exposes SELECT RLS to authenticated. All writes go through
--      supabaseAdmin (Prompt A2).
--    5 Standard Supabase session — no schema concessions required.
--    6 IdPs at launch enforced by the idp_type CHECK.
--    7 SSO-first provisioning: count_password_only_users_in_org
--      narrow semantic backs the UI pre-flight guardrail (Prompt A2).
--    8 SSO users exempt from Settle MFA — is_sso_user() is the
--      middleware hot-path check (Prompt B).
--    9 /sso/start bookmark app endpoint — built in Prompt A2; this
--      migration exposes no route.
--   10 One-org-per-domain enforced by UNIQUE(domain) on sso_domains.
--   11 count_password_only_users_in_org: narrow semantic — counts
--      only users whose SOLE auth.identities provider is 'email'.
--   12 lookup_sso_provider_for_domain: service_role grant only
--      (prevents unauthenticated domain enumeration via PostgREST).
--   13 signInWithSSO via SDK — Prompt A2 concern, nothing here.
--   14 enforce_sso_on_login DEFERRED to Prompt B — NOT in this
--      migration.
--   15 Mixed-enforcement policy is most-restrictive-wins; resolution
--      happens in middleware (Prompt B). Documented on the column
--      comment for organizations.enforcement_mode.
--   16 sso_audit_events placeholder included here; migrates to the
--      full audit_log table when item 1.B ships.
--   17 We accept documented Supabase behavior that auth.users.email
--      is 1:1 per email across identity providers.
--   18 sso_identity_links uses composite PK (user_id, org_id) —
--      forward-compatible with cross-org guest access.
--   19 provision_user_via_jit is purely additive — it appends one
--      org_memberships row, never replaces the user's memberships
--      in other orgs.
--
-- Additive-only guarantee:
--   * No DROP TABLE / DROP COLUMN / DROP FUNCTION / DROP POLICY.
--   * No UPDATE / INSERT / DELETE on existing rows.
--   * All ALTER TABLE ... ADD COLUMN uses IF NOT EXISTS so the
--     migration is idempotent under replay.
--
-- Rollback strategy:
--   A future migration 071 would issue DROP TABLE on the four new
--   tables (CASCADE), ALTER TABLE ... DROP COLUMN on the six new
--   columns, and DROP FUNCTION on the six new RPCs. Because no
--   customer has exercised SSO when this migration first lands,
--   rollback requires no data migration. Once the first customer
--   has configured SSO, rollback becomes a customer-communication
--   event, not a mechanical one.
-- ============================================================


-- ============================================================
-- 1. ALTER public.organizations — SSO config columns
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS enforcement_mode TEXT NOT NULL DEFAULT 'hybrid'
    CHECK (enforcement_mode IN ('strict', 'hybrid', 'optional'));

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS sso_configured_at TIMESTAMPTZ;

COMMENT ON COLUMN public.organizations.sso_enabled IS
  'Fast-lookup flag. Flipped TRUE by the server action once an sso_providers row is configured successfully. Read on every login to decide whether to route the user through the SSO flow.';

COMMENT ON COLUMN public.organizations.enforcement_mode IS
  'One of strict/hybrid/optional. Mixed-enforcement policy is most-restrictive-wins: a user who belongs to a strict org plus a hybrid org is treated as strict globally. Resolution happens in middleware (Prompt B). Default hybrid gives new orgs a non-breaking posture.';

COMMENT ON COLUMN public.organizations.sso_configured_at IS
  'Set by the server action when the sso_providers row is first created. NULL while SSO is unconfigured.';


-- ============================================================
-- 2. CREATE TABLE public.sso_providers
-- ============================================================
-- One row per org that has SAML configured. UNIQUE(org_id)
-- enforces "one provider per org" at launch. The CHECK on
-- metadata_url/metadata_xml ensures we always have IdP metadata
-- in at least one form — required to register the provider with
-- GoTrue.

CREATE TABLE IF NOT EXISTS public.sso_providers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supabase_provider_id  UUID,
  idp_type              TEXT NOT NULL CHECK (idp_type IN ('okta', 'entra', 'google', 'generic')),
  entity_id             TEXT NOT NULL,
  metadata_url          TEXT,
  metadata_xml          TEXT,
  acs_url               TEXT NOT NULL,
  sp_entity_id          TEXT NOT NULL,
  attribute_mapping     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sso_providers_org_unique UNIQUE (org_id),
  CONSTRAINT sso_providers_metadata_present
    CHECK ((metadata_url IS NOT NULL) OR (metadata_xml IS NOT NULL))
);

COMMENT ON TABLE public.sso_providers IS
  'Per-org SAML 2.0 identity-provider configuration. supabase_provider_id is populated after a successful GoTrue Admin API registration (Prompt A2). metadata_xml is stored alongside metadata_url for audit/diagnostic purposes even when the URL form is authoritative.';


-- ============================================================
-- 3. CREATE TABLE public.sso_domains
-- ============================================================
-- Domain → org mapping that drives email-based SSO detection.
-- domain is stored lowercased and restricted to DNS-legal syntax
-- (no '@', no spaces, 1..253 chars). verified_at is reserved for a
-- future TXT-record domain-ownership verification flow; nullable
-- in the current white-glove model because platform admins verify
-- ownership out of band.

CREATE TABLE IF NOT EXISTS public.sso_domains (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain       TEXT NOT NULL
    CHECK (
      domain = lower(domain)
      AND domain !~ '[@ ]'
      AND char_length(domain) > 0
      AND char_length(domain) <= 253
    ),
  verified_at  TIMESTAMPTZ,
  added_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.sso_domains IS
  'Email-domain allowlist per org. Domain must be lowercase, contain no @-sign or whitespace, and fit within the 253-char DNS limit. One-org-per-domain is enforced by the UNIQUE index created below. verified_at is NULL in the current white-glove model; a future self-service flow will set it via a TXT-record check.';


-- ============================================================
-- 4. CREATE TABLE public.sso_identity_links
-- ============================================================
-- Materialization of auth.identities SAML rows for hot-path reads
-- from middleware (is_sso_user). The composite primary key
-- (user_id, org_id) is deliberate: it is forward-compatible with
-- cross-org guest access (a user can be an SSO identity in
-- multiple orgs simultaneously). Writes happen in
-- provision_user_via_jit / mark_identity_sso_linked; reads happen
-- in is_sso_user and in the Prompt B MFA-bypass check.

CREATE TABLE IF NOT EXISTS public.sso_identity_links (
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sso_provider_id  UUID NOT NULL REFERENCES public.sso_providers(id) ON DELETE CASCADE,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at    TIMESTAMPTZ,
  CONSTRAINT sso_identity_links_pkey PRIMARY KEY (user_id, org_id)
);

COMMENT ON TABLE public.sso_identity_links IS
  'Cache / materialization of SSO identity linkage. Composite PK (user_id, org_id) allows a single user to hold SSO identities in multiple orgs (forward-compatible with cross-org guest access — see migration 050 project_members for the analogous pattern). Written by provision_user_via_jit and mark_identity_sso_linked; read on every authenticated request by the middleware MFA-bypass check (Prompt B).';


-- ============================================================
-- 5. CREATE TABLE public.sso_audit_events
-- ============================================================
-- Placeholder audit store for SSO events. Exists only until the
-- full audit_log table (outstanding-items 1.B) ships. When that
-- lands, rows from this table are migrated into audit_log and this
-- table is dropped.

CREATE TABLE IF NOT EXISTS public.sso_audit_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     TEXT NOT NULL CHECK (event_type IN (
                   'sso.provider.configured',
                   'sso.provider.updated',
                   'sso.provider.removed',
                   'sso.enforcement.changed',
                   'sso.domain.added',
                   'sso.domain.removed',
                   'sso.login.success',
                   'sso.login.failure',
                   'sso.jit.provisioned',
                   'sso.identity.linked',
                   'sso.identity.unlinked'
                 )),
  actor_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id         UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.sso_audit_events IS
  'Placeholder audit event store scoped to SSO events. Will be superseded by the unified audit_log table (outstanding-items 1.B). Migration path when audit_log lands: copy rows over preserving created_at, then DROP TABLE here.';


-- ============================================================
-- 6. ALTER public.org_memberships — provisioning_source
-- ============================================================

ALTER TABLE public.org_memberships
  ADD COLUMN IF NOT EXISTS provisioning_source TEXT
    CHECK (
      provisioning_source IS NULL
      OR provisioning_source IN ('invite', 'jit', 'admin', 'signup')
    );

COMMENT ON COLUMN public.org_memberships.provisioning_source IS
  'How this membership was created. NULL for pre-SSO rows (we do not backfill). Populated going forward: jit and invite by provision_user_via_jit (Prompt A1); admin by adminAddMember server actions (Prompt D); signup by password-signup flow (if/when that path adopts the column).';


-- ============================================================
-- 7. ALTER public.org_invites — expected_auth_method
-- ============================================================

ALTER TABLE public.org_invites
  ADD COLUMN IF NOT EXISTS expected_auth_method TEXT
    CHECK (
      expected_auth_method IS NULL
      OR expected_auth_method IN ('password', 'sso')
    );

COMMENT ON COLUMN public.org_invites.expected_auth_method IS
  'Set to sso when invite is created against an SSO-enforced org; drives invite-page routing in Prompt C (password signup form vs. SSO-only prompt). NULL for legacy invites — treat NULL as password for backward compatibility.';


-- ============================================================
-- 8. INDEXES
-- ============================================================

-- One-org-per-domain (Decision 10). Also the covering index for
-- lookup_sso_provider_for_domain(), which is the login hot path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_domains_domain
  ON public.sso_domains(domain);

-- List-domains-for-org query shape (admin UI, Prompt D).
CREATE INDEX IF NOT EXISTS idx_sso_domains_org
  ON public.sso_domains(org_id);

-- Partial index for reverse lookup (GoTrue provider id → our row)
-- used by the callback handler in Prompt B. Partial because the
-- column is nullable and we never need to look up NULL.
CREATE INDEX IF NOT EXISTS idx_sso_providers_supabase_id
  ON public.sso_providers(supabase_provider_id)
  WHERE supabase_provider_id IS NOT NULL;

-- is_sso_user() middleware hot path: "does this user_id have any
-- SSO link at all?"
CREATE INDEX IF NOT EXISTS idx_sso_identity_links_user
  ON public.sso_identity_links(user_id);

-- Admin UI: "list all SSO users in this org" (Prompt D).
CREATE INDEX IF NOT EXISTS idx_sso_identity_links_org
  ON public.sso_identity_links(org_id);

-- Chronological audit browse per org. DESC because all meaningful
-- reads are "most recent first".
CREATE INDEX IF NOT EXISTS idx_sso_audit_events_org_time
  ON public.sso_audit_events(org_id, created_at DESC);

-- Note: sso_providers does NOT need a separate unique index on
-- org_id — UNIQUE (org_id) on the CREATE TABLE creates one
-- automatically (sso_providers_org_unique).


-- ============================================================
-- 9. updated_at trigger on sso_providers
-- ============================================================
-- Reuses public.handle_updated_at(), defined in migration 001
-- (001_create_profiles.sql:50-56). Verified present before reuse.

CREATE OR REPLACE TRIGGER sso_providers_updated_at
  BEFORE UPDATE ON public.sso_providers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================
-- 10. SECURITY DEFINER RPCs
-- ============================================================
-- Mirrors the style set by migration 069: LANGUAGE sql where
-- possible, STABLE for reads, SET search_path = public, explicit
-- REVOKE ALL FROM PUBLIC / authenticated / anon before GRANT
-- EXECUTE to the minimum role required.

-- ── 10.1 lookup_sso_provider_for_domain ──────────────────────
-- Login-path detection. Given an email, return the org + provider
-- + enforcement mode for that email's domain if — and only if —
-- the org has a fully-configured SSO provider. INNER JOIN on
-- sso_providers is deliberate: if the domain is mapped but no
-- provider row yet exists, we want 0 rows (the caller should NOT
-- attempt to initiate a SAML flow in that half-configured state).
-- Grant: service_role only (Decision 12). Granting to anon would
-- enable unauthenticated domain enumeration via PostgREST; this
-- RPC is invoked exclusively from server actions via supabaseAdmin.

CREATE OR REPLACE FUNCTION public.lookup_sso_provider_for_domain(p_email TEXT)
RETURNS TABLE(org_id UUID, sso_provider_id UUID, enforcement_mode TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    o.id         AS org_id,
    sp.id        AS sso_provider_id,
    o.enforcement_mode::TEXT
  FROM public.sso_domains sd
  JOIN public.organizations o ON o.id = sd.org_id
  JOIN public.sso_providers sp ON sp.org_id = sd.org_id
  WHERE sd.domain = split_part(lower(p_email), '@', 2)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) TO service_role;

COMMENT ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) IS
  'Called only by server actions via supabaseAdmin. Do NOT grant to anon or authenticated — doing so enables unauthenticated domain enumeration across the tenant.';


-- ── 10.2 provision_user_via_jit ──────────────────────────────
-- First-login provisioning. Idempotent in the "membership already
-- exists" case (returns the existing row, was_new=FALSE, no
-- mutation). Additive: adds ONE org_memberships row for this org;
-- never touches this user's memberships in other orgs. Grant:
-- service_role only — this function is invoked from the callback
-- route (Prompt B) via supabaseAdmin.

CREATE OR REPLACE FUNCTION public.provision_user_via_jit(
  p_user_id UUID,
  p_org_id  UUID,
  p_email   TEXT
)
RETURNS TABLE(membership_id UUID, assigned_role TEXT, was_new BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing       public.org_memberships%ROWTYPE;
  v_invite         public.org_invites%ROWTYPE;
  v_new_membership public.org_memberships%ROWTYPE;
BEGIN
  -- (a) Idempotence: if a membership already exists, return it unchanged.
  SELECT * INTO v_existing
  FROM public.org_memberships
  WHERE org_id = p_org_id AND user_id = p_user_id
  LIMIT 1;

  IF FOUND THEN
    membership_id := v_existing.id;
    assigned_role := v_existing.role::TEXT;
    was_new       := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- (b) Is there a pending invite matching this (email, org)?
  --     Email match is case-insensitive — auth.users.email is stored
  --     lowercase but org_invites.email is stored as-entered.
  SELECT * INTO v_invite
  FROM public.org_invites
  WHERE org_id = p_org_id
    AND LOWER(email) = LOWER(p_email)
    AND accepted_at IS NULL
    AND expires_at > NOW()
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- (c) Invite path: role from invite, source='invite', mark invite accepted.
    INSERT INTO public.org_memberships (org_id, user_id, role, provisioning_source, joined_at)
    VALUES (p_org_id, p_user_id, v_invite.role, 'invite', NOW())
    RETURNING * INTO v_new_membership;

    UPDATE public.org_invites
       SET accepted_at = NOW()
     WHERE id = v_invite.id;
  ELSE
    -- (d) JIT path: default role 'viewer', source='jit'.
    INSERT INTO public.org_memberships (org_id, user_id, role, provisioning_source, joined_at)
    VALUES (p_org_id, p_user_id, 'viewer', 'jit', NOW())
    RETURNING * INTO v_new_membership;
  END IF;

  membership_id := v_new_membership.id;
  assigned_role := v_new_membership.role::TEXT;
  was_new       := TRUE;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_user_via_jit(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_user_via_jit(UUID, UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.provision_user_via_jit(UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.provision_user_via_jit(UUID, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.provision_user_via_jit(UUID, UUID, TEXT) IS
  'Additive: adds one org_memberships row for the specified org. Does NOT replace or modify the user''s memberships in other orgs. Idempotent: if membership already exists, returns existing row with was_new=FALSE and no mutation.';


-- ── 10.3 mark_identity_sso_linked ────────────────────────────
-- Called from the callback route (Prompt B) after a successful
-- SAML response to record the linkage and refresh last_login_at.
-- UPSERT on the composite PK (user_id, org_id) so a user with SSO
-- in multiple orgs is handled naturally.

CREATE OR REPLACE FUNCTION public.mark_identity_sso_linked(
  p_user_id         UUID,
  p_sso_provider_id UUID,
  p_org_id          UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.sso_identity_links (user_id, org_id, sso_provider_id, linked_at, last_login_at)
  VALUES (p_user_id, p_org_id, p_sso_provider_id, NOW(), NOW())
  ON CONFLICT (user_id, org_id) DO UPDATE
     SET last_login_at   = NOW(),
         sso_provider_id = EXCLUDED.sso_provider_id;
$$;

REVOKE ALL ON FUNCTION public.mark_identity_sso_linked(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_identity_sso_linked(UUID, UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.mark_identity_sso_linked(UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_identity_sso_linked(UUID, UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.mark_identity_sso_linked(UUID, UUID, UUID) IS
  'Called from the callback route after successful SSO login. Uses the composite PK (user_id, org_id) — a user can have SSO identities in multiple orgs, and each row is refreshed independently. The ON CONFLICT clause also refreshes sso_provider_id to tolerate future provider-id changes for the same user/org.';


-- ── 10.4 is_sso_user ─────────────────────────────────────────
-- Middleware hot-path gate for the "SSO users are exempt from
-- Settle MFA" rule (Decision 8). Granted to authenticated because
-- the middleware executes as the user's session role.

CREATE OR REPLACE FUNCTION public.is_sso_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sso_identity_links WHERE user_id = p_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_sso_user(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_sso_user(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_sso_user(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_sso_user(UUID) IS
  'Middleware hot path — called on every authenticated request to determine MFA bypass (Prompt B). Granted to authenticated because middleware executes as the authenticated role. SECURITY DEFINER keeps the RLS on sso_identity_links from short-circuiting the lookup to "rows the caller can read" (which for cross-org guests would be a superset issue).';


-- ── 10.5 get_auth_identity_providers ─────────────────────────
-- Dedicated narrow RPC for enumerating the providers linked to a
-- user in auth.identities. Used by Prompt B callback dedupe logic
-- to distinguish password-first users (needs linkIdentity flow)
-- from SSO-first users (straight provision). SOC 2 story: all
-- application reads of auth.identities go through this named
-- function — no ad-hoc supabaseAdmin.from('auth.identities') reads.

CREATE OR REPLACE FUNCTION public.get_auth_identity_providers(p_user_id UUID)
RETURNS SETOF TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT i.provider::TEXT
  FROM auth.identities i
  WHERE i.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.get_auth_identity_providers(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_auth_identity_providers(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_auth_identity_providers(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_auth_identity_providers(UUID) TO service_role;

COMMENT ON FUNCTION public.get_auth_identity_providers(UUID) IS
  'Dedicated narrow function for reading auth.identities. Used in Prompt B callback dedupe logic to distinguish password-first users from SSO-first users. SOC 2 audit story: application code reads auth.identities only via this named function.';


-- ── 10.6 count_password_only_users_in_org ────────────────────
-- SSO-first provisioning guardrail (Decision 7, Decision 11). The
-- pre-flight for configureSSOProvider asks: "how many users in
-- this org would be locked out if we turned on SSO right now?"
-- The narrow semantic — "users whose ONLY auth identity is
-- email-password" — is deliberate. A user who already has SSO
-- linked or a social identity linked will authenticate fine after
-- SSO goes live; they are not a migration concern.

CREATE OR REPLACE FUNCTION public.count_password_only_users_in_org(p_org_id UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT om.user_id)::INTEGER
  FROM public.org_memberships om
  WHERE om.org_id = p_org_id
    AND NOT EXISTS (
      SELECT 1 FROM auth.identities i
      WHERE i.user_id = om.user_id
        AND i.provider <> 'email'
    );
$$;

REVOKE ALL ON FUNCTION public.count_password_only_users_in_org(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_password_only_users_in_org(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.count_password_only_users_in_org(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.count_password_only_users_in_org(UUID) TO service_role;

COMMENT ON FUNCTION public.count_password_only_users_in_org(UUID) IS
  'Used by configureSSOProvider pre-flight guardrail (Prompt A2). Narrow semantic: counts only users whose sole auth.identities provider is email. Users who already have SSO or other providers linked are NOT counted — they can coexist with SSO enablement.';


-- ============================================================
-- 11. ENABLE RLS on new tables
-- ============================================================

ALTER TABLE public.sso_providers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sso_domains         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sso_identity_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sso_audit_events    ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- 12. RLS POLICIES (SELECT only — all writes via supabaseAdmin)
-- ============================================================
-- Deliberately no INSERT / UPDATE / DELETE policies. Writes to
-- these tables happen exclusively through server actions using
-- supabaseAdmin (service_role bypasses RLS). Authenticated-role
-- callers can read their own SSO surface but cannot mutate it.

-- sso_providers: org admins read their own org's config (for the
-- customer-facing settings tab in Prompt D). Viewers / editors do
-- NOT see SSO config.
CREATE POLICY org_admins_can_view_sso_providers
  ON public.sso_providers
  FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- sso_domains: same visibility rule as sso_providers.
CREATE POLICY org_admins_can_view_sso_domains
  ON public.sso_domains
  FOR SELECT
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- sso_identity_links: users see their own linkage; platform admins
-- see all (operational debugging, support, security review).
CREATE POLICY self_or_admin_can_view_sso_links
  ON public.sso_identity_links
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_platform_admin(auth.uid())
  );

-- sso_audit_events: platform-admin visibility only at this stage.
-- Org-admin read access will come with the full audit_log table
-- (outstanding-items 1.B).
CREATE POLICY platform_admins_can_view_sso_audit
  ON public.sso_audit_events
  FOR SELECT
  USING (public.is_platform_admin(auth.uid()));


-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- Run each query in the Supabase SQL editor after applying this
-- migration. Every query lists its expected output. V9 and V10
-- require substituting real UUIDs before running.

-- V1: Confirm all 4 new tables exist
-- SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public' AND tablename LIKE 'sso_%'
--   ORDER BY tablename;
-- Expected: 4 rows
--   sso_audit_events
--   sso_domains
--   sso_identity_links
--   sso_providers

-- V2: Confirm new columns on organizations
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='organizations'
--     AND column_name IN ('sso_enabled','enforcement_mode','sso_configured_at')
--   ORDER BY column_name;
-- Expected: 3 rows
--   enforcement_mode   | text                      | 'hybrid'::text | NO
--   sso_configured_at  | timestamp with time zone  | (null)         | YES
--   sso_enabled        | boolean                   | false          | NO

-- V3: Confirm new columns on org_memberships and org_invites
-- SELECT table_name, column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public'
--     AND ((table_name='org_memberships' AND column_name='provisioning_source')
--       OR (table_name='org_invites'     AND column_name='expected_auth_method'))
--   ORDER BY table_name, column_name;
-- Expected: 2 rows
--   org_invites     | expected_auth_method | text | YES
--   org_memberships | provisioning_source  | text | YES

-- V4: Confirm UNIQUE constraint on sso_domains.domain
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename='sso_domains' AND indexname='idx_sso_domains_domain';
-- Expected: 1 row with 'UNIQUE' and '(domain)' in indexdef.

-- V5: Confirm all 6 RPCs exist with correct signatures
-- SELECT proname,
--        pg_get_function_arguments(oid) AS args,
--        pg_get_function_result(oid)    AS returns
-- FROM pg_proc
--   WHERE proname IN (
--     'lookup_sso_provider_for_domain',
--     'provision_user_via_jit',
--     'mark_identity_sso_linked',
--     'is_sso_user',
--     'get_auth_identity_providers',
--     'count_password_only_users_in_org'
--   ) AND pronamespace = 'public'::regnamespace
--   ORDER BY proname;
-- Expected: 6 rows with signatures matching the CREATE statements.

-- V6: Confirm grants — service_role has EXECUTE on all 6;
--     authenticated has EXECUTE only on is_sso_user;
--     anon has EXECUTE on ZERO of these functions.
-- SELECT grantee, privilege_type, routine_name
--   FROM information_schema.role_routine_grants
--   WHERE routine_schema='public'
--     AND routine_name IN (
--       'lookup_sso_provider_for_domain',
--       'provision_user_via_jit',
--       'mark_identity_sso_linked',
--       'is_sso_user',
--       'get_auth_identity_providers',
--       'count_password_only_users_in_org'
--     )
--   ORDER BY routine_name, grantee;
-- Expected rows (postgres owner grant is benign and may also appear):
--   count_password_only_users_in_org | service_role  | EXECUTE
--   get_auth_identity_providers      | service_role  | EXECUTE
--   is_sso_user                      | authenticated | EXECUTE
--   is_sso_user                      | service_role  | EXECUTE
--   lookup_sso_provider_for_domain   | service_role  | EXECUTE
--   mark_identity_sso_linked         | service_role  | EXECUTE
--   provision_user_via_jit           | service_role  | EXECUTE
-- CRITICAL: anon must not appear on ANY row. If it does, this
-- migration has a grant bug and must not go live.

-- V7: Confirm RLS enabled on new tables
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename LIKE 'sso_%'
--   ORDER BY tablename;
-- Expected: 4 rows, all rowsecurity=true.

-- V8: Confirm RLS policies exist on new tables
-- SELECT tablename, policyname, cmd
--   FROM pg_policies
--   WHERE schemaname='public' AND tablename LIKE 'sso_%'
--   ORDER BY tablename, policyname;
-- Expected: 4 rows, all cmd='SELECT':
--   sso_audit_events    | platform_admins_can_view_sso_audit    | SELECT
--   sso_domains         | org_admins_can_view_sso_domains       | SELECT
--   sso_identity_links  | self_or_admin_can_view_sso_links      | SELECT
--   sso_providers       | org_admins_can_view_sso_providers     | SELECT

-- V9: Smoke test — count_password_only_users_in_org for a real org.
-- Substitute an actual org_id from public.organizations.
-- SELECT public.count_password_only_users_in_org(
--   '<real-org-uuid>'::uuid);
-- Expected: integer count (likely > 0 for an active pre-SSO org).

-- V10: Smoke test — is_sso_user for the founder's user_id.
-- SELECT public.is_sso_user(
--   'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'::uuid);
-- Expected: false (no SSO users yet). Substitute the real founder
-- user_id if that UUID has changed.
