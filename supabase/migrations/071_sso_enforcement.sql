-- ============================================================
-- 071: SSO enforcement + lookup expansion
--
-- Adds the runtime enforcement RPC used by middleware (Prompt B-1)
-- and extends the 070-era domain lookup to also return the org
-- slug so the login page (Prompt B-2) can build a /sso/start URL
-- without a second round trip.
--
-- Dependencies (must be applied first):
--   050  organizations / org_memberships
--   068  public.platform_admins + is_platform_admin(UUID)
--   070  sso_providers / sso_domains / sso_identity_links /
--        sso_audit_events, organizations.sso_enabled,
--        organizations.enforcement_mode,
--        lookup_sso_provider_for_domain(TEXT),
--        is_sso_user(UUID),
--        count_password_only_users_in_org(UUID)
--
-- Locked design decisions referenced:
--    2 Enforcement modes strict / hybrid / optional per org;
--      default 'hybrid'. Column already present on organizations.
--   14 enforce_sso_on_login — created HERE (Prompt B-1).
--   15 Mixed-enforcement policy is most-restrictive-wins. The
--      severity rank strict > hybrid > optional > none is encoded
--      in the enforce_sso_on_login body.
--   28 'hybrid' is a UX distinction only; password login remains
--      universally allowed for hybrid/optional/none. Only 'strict'
--      sets sso_required=TRUE.
--   33 Mixed enforcement is GLOBAL across all of a user's orgs,
--      not per-tenant. enforce_sso_on_login iterates every
--      membership and applies the severity max across them.
--   34 MFA bypass applies at BOTH /app/* and /auth/mfa-verify.
--      The is_sso_already output is consumed by middleware at both
--      gates.
--   35 lookup_sso_provider_for_domain is extended (not replaced
--      semantically) to include org_slug. Existing callers that
--      only consume the first three columns continue to work
--      because PostgREST returns columns by name.
--   36 enforce_sso_on_login has a self-check guard: the caller may
--      only query their own state unless they are a platform
--      admin. service_role (auth.uid() IS NULL) bypasses the guard
--      because middleware may run in service_role context.
--   37 The RPC name is enforce_sso_on_login; the doc comment
--      documents its dual purpose (enforcement + MFA bypass hint).
--
-- Additive-only guarantee:
--   * No DROP TABLE / DROP COLUMN / DROP POLICY.
--   * No UPDATE / INSERT / DELETE on existing rows (no data
--     mutation anywhere in this migration).
--   * Section 1 issues DROP FUNCTION IF EXISTS before the CREATE
--     because PostgreSQL requires a DROP to change a function's
--     return type — CREATE OR REPLACE FUNCTION cannot alter the
--     return signature. This is not a data mutation; it is a
--     schema-level re-declaration. No rows in any table reference
--     the function definition. The GRANT block at the end of
--     section 1 restores the original service_role grant.
--
-- Rollback strategy:
--   * Section 2 (enforce_sso_on_login) rolls back via DROP
--     FUNCTION public.enforce_sso_on_login(UUID).
--   * Section 1 (lookup_sso_provider_for_domain) rolls back by
--     DROPping the 4-column version and re-creating the 070-era
--     3-column signature verbatim. Because no SSO-dependent
--     login flow has been exercised in production yet (no org
--     has sso_enabled=TRUE as of this migration's application
--     date), rollback carries zero user-visible impact.
-- ============================================================


-- ============================================================
-- 1. Extend lookup_sso_provider_for_domain → adds org_slug
-- ============================================================
-- The 070-era signature returns three columns
-- (org_id, sso_provider_id, enforcement_mode). B-2 needs the org
-- slug on the login page to build a /sso/start URL without a
-- second RPC round trip. Since PostgreSQL does not permit
-- CREATE OR REPLACE FUNCTION to alter the return type, we DROP
-- then CREATE. The function body is the 070-era logic plus
-- o.slug in the SELECT list and an additional
-- o.sso_enabled = TRUE predicate (a stale mapping to a disabled
-- org must not surface as required SSO).

DROP FUNCTION IF EXISTS public.lookup_sso_provider_for_domain(TEXT);

CREATE FUNCTION public.lookup_sso_provider_for_domain(p_email TEXT)
RETURNS TABLE(
  org_id           UUID,
  sso_provider_id  UUID,
  enforcement_mode TEXT,
  org_slug         TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_domain TEXT;
BEGIN
  -- Guard against malformed input. Return empty on any oddity.
  IF p_email IS NULL OR position('@' in p_email) = 0 THEN
    RETURN;
  END IF;

  v_domain := split_part(lower(p_email), '@', 2);

  IF v_domain IS NULL OR length(v_domain) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    o.id                  AS org_id,
    sp.id                 AS sso_provider_id,
    o.enforcement_mode::TEXT,
    o.slug                AS org_slug
  FROM public.sso_domains sd
  JOIN public.organizations o  ON o.id = sd.org_id
  JOIN public.sso_providers sp ON sp.org_id = sd.org_id
  WHERE sd.domain = v_domain
    AND o.sso_enabled = TRUE
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) TO service_role;

COMMENT ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) IS
  'Called only by server actions via supabaseAdmin. Do NOT grant to anon or authenticated — doing so enables unauthenticated domain enumeration across the tenant. Return shape (071): (org_id, sso_provider_id, enforcement_mode, org_slug). Only returns rows where organizations.sso_enabled=TRUE so half-configured / recently-disabled orgs do not surface to the login page.';


-- ============================================================
-- 2. New RPC: enforce_sso_on_login
-- ============================================================
-- Dual-purpose RPC:
--   1. SSO enforcement decision (sso_required, effective_mode,
--      strict_org_ids) for the middleware to block password
--      sessions when a strict SSO org exists among the user's
--      memberships.
--   2. MFA bypass hint (is_sso_already) for the middleware to
--      skip the TOTP step-up when the user is authenticated via
--      SSO (locked decision 8).
--
-- Called on every /app/* request and on /auth/mfa-verify. Caller
-- MUST be either the target user (auth.uid() = p_user_id) or a
-- platform admin. service_role bypasses the guard because
-- middleware may run in service_role context (auth.uid() IS NULL).
--
-- Always returns exactly one row (even for a user with zero
-- memberships — the 'none' case). Platform admins always get
-- sso_required=FALSE but still receive the accurate
-- is_sso_already so MFA bypass (decision 8) applies to a
-- platform admin who is ALSO an SSO user.
--
-- Severity ranking (decisions 15, 33): strict > hybrid > optional
-- > none. Any single strict org in the user's membership set
-- forces strict globally. This is the "most-restrictive-wins"
-- rule applied across every org the user belongs to.

CREATE OR REPLACE FUNCTION public.enforce_sso_on_login(p_user_id UUID)
RETURNS TABLE(
  sso_required    BOOLEAN,
  effective_mode  TEXT,
  strict_org_ids  UUID[],
  is_sso_already  BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_caller         UUID := auth.uid();
  v_is_sso_already BOOLEAN;
  v_strict_ids     UUID[];
  v_has_hybrid     BOOLEAN;
  v_has_optional   BOOLEAN;
BEGIN
  -- ── 1. Self-check guard (decision 36) ─────────────────────
  -- An authenticated caller may only query their own state
  -- unless they are a platform admin. service_role (auth.uid()
  -- IS NULL in that context) bypasses the guard.
  IF v_caller IS NOT NULL
     AND v_caller <> p_user_id
     AND NOT public.is_platform_admin(v_caller) THEN
    sso_required   := FALSE;
    effective_mode := 'none';
    strict_org_ids := ARRAY[]::UUID[];
    is_sso_already := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── is_sso_already is computed in every branch ───────────
  -- including the platform-admin short-circuit, so that MFA
  -- bypass (decision 8) still applies to a platform admin who
  -- is also an SSO user.
  SELECT EXISTS (
    SELECT 1 FROM public.sso_identity_links WHERE user_id = p_user_id
  ) INTO v_is_sso_already;

  -- ── 2. Platform admin short-circuit (decisions 2, 7) ─────
  IF public.is_platform_admin(p_user_id) THEN
    sso_required   := FALSE;
    effective_mode := 'none';
    strict_org_ids := ARRAY[]::UUID[];
    is_sso_already := v_is_sso_already;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── 3. Main evaluation: iterate memberships ───────────────
  -- strict: any org where sso_enabled AND mode='strict'
  SELECT COALESCE(array_agg(o.id), ARRAY[]::UUID[])
    INTO v_strict_ids
  FROM public.org_memberships m
  JOIN public.organizations   o ON o.id = m.org_id
  WHERE m.user_id = p_user_id
    AND o.sso_enabled = TRUE
    AND o.enforcement_mode = 'strict';

  IF array_length(v_strict_ids, 1) IS NOT NULL THEN
    sso_required   := TRUE;
    effective_mode := 'strict';
    strict_org_ids := v_strict_ids;
    is_sso_already := v_is_sso_already;
    RETURN NEXT;
    RETURN;
  END IF;

  -- hybrid: any org where sso_enabled AND mode='hybrid'
  SELECT EXISTS (
    SELECT 1
    FROM public.org_memberships m
    JOIN public.organizations   o ON o.id = m.org_id
    WHERE m.user_id = p_user_id
      AND o.sso_enabled = TRUE
      AND o.enforcement_mode = 'hybrid'
  ) INTO v_has_hybrid;

  IF v_has_hybrid THEN
    sso_required   := FALSE;
    effective_mode := 'hybrid';
    strict_org_ids := ARRAY[]::UUID[];
    is_sso_already := v_is_sso_already;
    RETURN NEXT;
    RETURN;
  END IF;

  -- optional: any org where sso_enabled AND mode='optional'
  SELECT EXISTS (
    SELECT 1
    FROM public.org_memberships m
    JOIN public.organizations   o ON o.id = m.org_id
    WHERE m.user_id = p_user_id
      AND o.sso_enabled = TRUE
      AND o.enforcement_mode = 'optional'
  ) INTO v_has_optional;

  IF v_has_optional THEN
    sso_required   := FALSE;
    effective_mode := 'optional';
    strict_org_ids := ARRAY[]::UUID[];
    is_sso_already := v_is_sso_already;
    RETURN NEXT;
    RETURN;
  END IF;

  -- none: no SSO-enabled orgs among the user's memberships
  sso_required   := FALSE;
  effective_mode := 'none';
  strict_org_ids := ARRAY[]::UUID[];
  is_sso_already := v_is_sso_already;
  RETURN NEXT;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_sso_on_login(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_sso_on_login(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.enforce_sso_on_login(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.enforce_sso_on_login(UUID) IS
  'Dual-purpose middleware RPC: (1) SSO enforcement decision (sso_required, effective_mode, strict_org_ids) and (2) MFA bypass hint (is_sso_already). Called on every /app/* request and on /auth/mfa-verify. Self-check guard: caller must be p_user_id or a platform admin; service_role (auth.uid() IS NULL) bypasses the guard. Always returns exactly one row. Severity ranking is strict > hybrid > optional > none (decisions 15, 33 — most-restrictive-wins across ALL of a user''s memberships).';


-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- Run each query in the Supabase SQL editor after applying this
-- migration. Every query lists its expected output. V4 and V5
-- require substituting real UUIDs before running.

-- V1. Confirm enforce_sso_on_login exists with the correct
--     signature:
-- SELECT proname,
--        pg_get_function_arguments(oid)    AS args,
--        pg_get_function_result(oid)       AS result
--   FROM pg_proc
--  WHERE proname = 'enforce_sso_on_login'
--    AND pronamespace = 'public'::regnamespace;
-- Expected: one row.
--   args   = 'p_user_id uuid'
--   result = 'TABLE(sso_required boolean, effective_mode text,
--                   strict_org_ids uuid[], is_sso_already boolean)'


-- V2. Confirm lookup_sso_provider_for_domain now returns four
--     columns including org_slug:
-- SELECT pg_get_function_result(oid)
--   FROM pg_proc
--  WHERE proname = 'lookup_sso_provider_for_domain'
--    AND pronamespace = 'public'::regnamespace;
-- Expected: 'TABLE(org_id uuid, sso_provider_id uuid,
--                  enforcement_mode text, org_slug text)'


-- V3. Confirm grants on enforce_sso_on_login (no anon):
-- SELECT grantee, privilege_type
--   FROM information_schema.role_routine_grants
--  WHERE routine_schema = 'public'
--    AND routine_name   = 'enforce_sso_on_login'
--  ORDER BY grantee;
-- Expected rows (postgres owner grant is benign and may appear):
--   authenticated  | EXECUTE
--   postgres       | EXECUTE
--   service_role   | EXECUTE
-- CRITICAL: anon must NOT appear on any row.


-- V4. Smoke test — founder (platform admin). Substitute the
--     founder's real auth.users.id before running:
-- SELECT * FROM public.enforce_sso_on_login(
--   'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'::UUID);
-- Expected on a fresh production DB (no SSO configured):
--   sso_required   = FALSE
--   effective_mode = 'none'
--   strict_org_ids = '{}'::uuid[]
--   is_sso_already = FALSE


-- V5. Smoke test — arbitrary non-admin user (substitute a real
--     auth.users.id of a non-platform-admin):
-- SELECT * FROM public.enforce_sso_on_login(
--   '<some-user-uuid>'::UUID);
-- Expected on a fresh production DB:
--   sso_required   = FALSE
--   effective_mode = 'none'
--   strict_org_ids = '{}'::uuid[]
--   is_sso_already = FALSE


-- V6. Confirm lookup_sso_provider_for_domain returns empty for
--     an unmapped email:
-- SELECT * FROM public.lookup_sso_provider_for_domain(
--   'nobody@nonexistent.test');
-- Expected: 0 rows.


-- V7. Confirm lookup_sso_provider_for_domain also returns empty
--     for a malformed email (defensive guard):
-- SELECT * FROM public.lookup_sso_provider_for_domain('not-an-email');
-- Expected: 0 rows.
-- SELECT * FROM public.lookup_sso_provider_for_domain('@no-local.test');
-- Expected: 0 rows (empty domain check — split_part returns '').
-- Note: '@' makes split_part return '' which length() = 0 → RETURN.
