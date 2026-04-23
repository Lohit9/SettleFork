-- ============================================================
-- 068: Platform admins table + is_platform_admin() helper
--
-- Purpose: Replace the hardcoded email-string platform-admin gate
-- (kaandincer1@gmail.com, scattered across migration 015 and six
-- application-code sites) with a dedicated public.platform_admins
-- table and a SECURITY DEFINER helper public.is_platform_admin(UUID).
-- Seed the founder as the initial admin and rewrite the two
-- email-hardcoded RLS policies on public.invites and
-- public.access_requests to call the helper instead.
--
-- Rationale: Hardcoded email gating (from migration 015 and throughout
-- the application code) is a security-review red flag and
-- operationally fragile. A dedicated platform_admins table provides
-- an audit trail (granted_at, granted_by, notes), allows revocation,
-- and eliminates email-string comparisons from security-sensitive
-- code paths.
--
-- What this migration does:
--   1. Create public.platform_admins table with RLS enabled.
--   2. Create public.is_platform_admin(UUID) SECURITY DEFINER helper.
--   3. Add the SELECT policy on platform_admins that uses the helper.
--   4. Seed kaandincer1@gmail.com as initial admin (resolved from
--      auth.users), with a fail-loud guard that RAISEs if no row
--      was inserted.
--   5. Drop the email-hardcoded RLS policy on public.invites and
--      recreate it using public.is_platform_admin(auth.uid()).
--   6. Drop the email-hardcoded RLS policy on public.access_requests
--      and recreate it using public.is_platform_admin(auth.uid()).
--
-- What this migration does NOT do:
--   - It does NOT modify 015_invites.sql (historical migrations are
--     immutable; the replacement policies live here).
--   - It does NOT change any application code. The six TypeScript
--     gate sites (app/admin/page.tsx, lib/actions/invites.ts,
--     lib/actions/org-invites.ts, lib/actions/organizations.ts) are
--     refactored in subsequent prompts.
--   - It does NOT grant admin to anyone beyond kaandincer1@gmail.com.
--     Adding or removing admins post-deploy is a manual INSERT /
--     DELETE operation on public.platform_admins performed via
--     supabaseAdmin (service_role bypasses RLS).
--
-- Ordering note: the helper function is created BEFORE any policy
-- that references it; the seed block runs AFTER the policy so the
-- table structure is fully established before INSERT.
-- ============================================================

-- ── 1. Table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes      TEXT
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- ── 2. Helper function (must exist before any policy that calls it) ─

CREATE OR REPLACE FUNCTION public.is_platform_admin(check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = check_user_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin(UUID)
  TO authenticated, service_role;

-- ── 3. RLS policy on platform_admins ─────────────────────────
-- Platform admins can read the roster. No INSERT/UPDATE/DELETE
-- policies are exposed to the authenticated role; mutations must
-- go through supabaseAdmin (service_role bypasses RLS).

DROP POLICY IF EXISTS "platform_admins_self_readable" ON public.platform_admins;
CREATE POLICY "platform_admins_self_readable"
  ON public.platform_admins
  FOR SELECT
  USING (public.is_platform_admin(auth.uid()));

-- ── 4. Seed: founder as initial admin (fail-loud) ────────────
-- Resolve the user_id from auth.users at migration time so no
-- UUID is hardcoded. If the email is not present (e.g. wrong
-- environment, deleted user) the migration RAISEs rather than
-- silently leaving the admin surface locked out.

DO $$
DECLARE
  admin_count INTEGER;
BEGIN
  INSERT INTO public.platform_admins (user_id, notes)
  SELECT id, 'Initial platform admin (founder) — seeded by migration 068'
  FROM auth.users
  WHERE email = 'kaandincer1@gmail.com'
  ON CONFLICT (user_id) DO NOTHING;

  SELECT COUNT(*) INTO admin_count FROM public.platform_admins;
  IF admin_count = 0 THEN
    RAISE EXCEPTION 'Migration 068: failed to seed any platform admin. Check that kaandincer1@gmail.com exists in auth.users before applying this migration.';
  END IF;
END $$;

-- ── 5. Replace email-hardcoded policy on public.invites ──────
-- Originally defined in 015_invites.sql:26-32 as:
--   auth.uid() IN (SELECT id FROM auth.users WHERE email = 'kaandincer1@gmail.com')

DROP POLICY IF EXISTS "Admin manages invites" ON public.invites;
CREATE POLICY "Admin manages invites" ON public.invites
  FOR ALL
  USING (public.is_platform_admin(auth.uid()));

-- ── 6. Replace email-hardcoded policy on public.access_requests ──
-- Originally defined in 015_invites.sql:54-60 with the same
-- email-subselect pattern.

DROP POLICY IF EXISTS "Admin reads access requests" ON public.access_requests;
CREATE POLICY "Admin reads access requests" ON public.access_requests
  FOR ALL
  USING (public.is_platform_admin(auth.uid()));

-- Verification (run in SQL editor post-deploy):
-- 1. Confirm table exists and has exactly one row (the founder):
--    SELECT user_id, granted_at, notes FROM public.platform_admins;
-- 2. Confirm function exists and returns TRUE for the founder's UUID:
--    SELECT public.is_platform_admin(
--      (SELECT id FROM auth.users WHERE email = 'kaandincer1@gmail.com')
--    );  -- expect: true
-- 3. Confirm replaced policies reference is_platform_admin:
--    SELECT policyname, qual FROM pg_policies
--    WHERE tablename IN ('invites', 'access_requests')
--    ORDER BY tablename, policyname;
--    expect: both policies show 'is_platform_admin(auth.uid())' in qual
