-- ============================================================
-- 069: Targeted auth.users lookup RPCs
--      (find_auth_user_by_email, get_auth_emails_by_ids)
--
-- Purpose: Replace the codebase's use of
--   supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
-- across 5 call sites (lib/actions/org-invites.ts,
-- lib/actions/organizations.ts, app/invite/[token]/page.tsx) with
-- two narrow SECURITY DEFINER RPCs. The existing pattern is
-- O(all users) per call and carries a silent correctness ceiling
-- at 1000 users — once total user count exceeds that, the in-memory
-- .find() / .some() / id→email Map constructions start silently
-- missing users and producing wrong answers (failed email
-- existence checks, missing email columns in org-member listings,
-- dropped invite-collision detection).
--
-- Rationale: The obvious alternative — adding the `auth` schema to
-- PostgREST's exposed-schema list so clients can do
-- `supabase.from('auth.users')…` directly — would open a much
-- broader attack surface than we need (every column of auth.users,
-- every row, constrained only by whatever RLS we remember to add).
-- SECURITY DEFINER RPCs keep the auth schema hidden from
-- PostgREST, expose only the exact operations we need (email→user,
-- ids→emails), and give us a clean, audit-friendly story for SOC 2:
-- "application code accesses auth.users only via these two named,
-- reviewed functions, callable only by service_role." Each function
-- is pinned to LANGUAGE sql + STABLE + SET search_path = public,
-- which (a) lets Postgres cache results within a statement and
-- (b) forecloses the search_path-injection class of attacks
-- against SECURITY DEFINER functions.
--
-- What this migration does:
--   1. Create public.find_auth_user_by_email(p_email TEXT) returning
--      (id UUID, email TEXT) — case-insensitive, first-match, empty
--      result set when not found.
--   2. Create public.get_auth_emails_by_ids(p_user_ids UUID[])
--      returning (id UUID, email TEXT) for each matching id; empty
--      result set when the input array is empty or NULL, and
--      silently skips ids that do not exist in auth.users.
--   3. REVOKE ALL from PUBLIC / authenticated / anon, then GRANT
--      EXECUTE to service_role only on both functions.
--
-- What this migration does NOT do:
--   - It does NOT grant EXECUTE to authenticated or anon. These
--     RPCs are backend-only, reachable exclusively through
--     supabaseAdmin (service_role). A user-session JWT cannot
--     invoke them.
--   - It does NOT modify auth.users or any other object in the
--     auth schema. Read-only by construction.
--   - It does NOT change any application code. Refactoring the 5
--     listUsers call sites to call these RPCs happens in
--     subsequent commits.
-- ============================================================

-- ── 1. find_auth_user_by_email(email) ────────────────────────
-- Case-insensitive email → (id, email) lookup. Supabase stores
-- emails lowercased, so LOWER() on both sides is exact, not just
-- a normalization hack. LIMIT 1 is defensive: once SSO lands,
-- auth.users.email is no longer unique (multiple identity
-- providers can share an email), and callers today consistently
-- expect a single result ("does a user with this email exist?"
-- and "give me an id so I can check an org_memberships row").
-- Returns an empty result set (not an error) when no match; the
-- TypeScript caller treats empty as "not found" via .maybeSingle()
-- / length === 0.

CREATE OR REPLACE FUNCTION public.find_auth_user_by_email(p_email TEXT)
RETURNS TABLE(id UUID, email TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT u.id, u.email::TEXT
  FROM auth.users u
  WHERE LOWER(u.email) = LOWER(p_email)
  LIMIT 1;
$$;

-- ── 2. get_auth_emails_by_ids(user_ids) ──────────────────────
-- Batch id → email resolver, intended for org-member listings
-- (getOrgMembers, adminGetOrgMembers) where we already hold a
-- bounded set of user_ids from org_memberships and only need to
-- enrich them with emails. Replaces the O(all users) listUsers
-- scan with an O(|p_user_ids|) indexed lookup via = ANY().
-- Empty / NULL input yields an empty result set (ANY(NULL) is
-- never true, so the query returns zero rows without erroring);
-- ids that don't exist in auth.users are simply absent from the
-- result, and callers handle that by Map.get()? ?? 'Unknown'.

CREATE OR REPLACE FUNCTION public.get_auth_emails_by_ids(p_user_ids UUID[])
RETURNS TABLE(id UUID, email TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT u.id, u.email::TEXT
  FROM auth.users u
  WHERE u.id = ANY(p_user_ids);
$$;

-- ── 3. Grants: service_role only ─────────────────────────────
-- Defense in depth: Postgres default EXECUTE grants vary by
-- version and by whether the function already existed (CREATE OR
-- REPLACE preserves prior grants). REVOKE from PUBLIC /
-- authenticated / anon first guarantees we start from zero, then
-- GRANT EXECUTE exclusively to service_role. supabaseAdmin (the
-- only backend caller) authenticates as service_role; no user
-- session JWT can reach these functions.

REVOKE ALL ON FUNCTION public.find_auth_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_auth_user_by_email(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.find_auth_user_by_email(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.find_auth_user_by_email(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.get_auth_emails_by_ids(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_auth_emails_by_ids(UUID[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_auth_emails_by_ids(UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_auth_emails_by_ids(UUID[]) TO service_role;

-- Verification (run in Supabase SQL Editor post-deploy):
-- 1. Confirm functions exist with correct signatures:
--    SELECT proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
--    FROM pg_proc
--    WHERE proname IN ('find_auth_user_by_email', 'get_auth_emails_by_ids')
--      AND pronamespace = 'public'::regnamespace;
--    Expected: 2 rows, matching signatures above.
-- 2. Confirm grants are restricted to service_role only:
--    SELECT grantee, privilege_type
--    FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('find_auth_user_by_email', 'get_auth_emails_by_ids');
--    Expected: only service_role (no authenticated, no anon, no public).
-- 3. Smoke test find_auth_user_by_email (run as service_role in SQL Editor):
--    SELECT * FROM public.find_auth_user_by_email('kaan@usesettle.ai');
--    Expected: 1 row returning the founder's user_id and email.
-- 4. Smoke test get_auth_emails_by_ids:
--    SELECT * FROM public.get_auth_emails_by_ids(
--      ARRAY[(SELECT id FROM auth.users WHERE email = 'kaan@usesettle.ai')]::UUID[]
--    );
--    Expected: 1 row with founder's id and email.
