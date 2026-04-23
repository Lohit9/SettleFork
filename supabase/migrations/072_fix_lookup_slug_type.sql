-- ============================================================
-- 072: Fix lookup_sso_provider_for_domain type mismatch
--
-- Migration 071 extended the return shape of
-- lookup_sso_provider_for_domain to include org_slug TEXT, but
-- organizations.slug is VARCHAR(100). PostgreSQL rejects the
-- query when it tries to materialize a row because VARCHAR(100)
-- does not auto-coerce to TEXT in function return contexts.
--
-- Symptom: any real query (non-malformed email, where the domain
-- extraction succeeds and the main JOIN runs) would fail with:
--   ERROR: 42804: structure of query does not match function
--   result type
--   DETAIL: Returned type character varying(100) does not match
--   expected type text in column 4
--
-- Fix: cast slug to TEXT in the SELECT list.
--
-- Production state at time of this migration:
-- - No sso_domains rows exist yet, so the broken query path has
--   not yet been reached by any real caller. The guard branches
--   (null email, missing @, empty domain) bypass the query and
--   return empty, so checkSSOEnabledForEmail correctly returned
--   { required: false } for all real invocations.
-- - enforce_sso_on_login (also added in 071) is unaffected.
--
-- This migration is strictly additive. No data mutation.
-- Follows the same DROP-and-CREATE pattern as 071 because
-- CREATE OR REPLACE FUNCTION cannot alter function bodies
-- without changing the signature in the presence of a bug
-- ... actually, CREATE OR REPLACE could work here since the
-- signature is unchanged. But using DROP + CREATE keeps the
-- pattern consistent with 071 and is equally safe.
-- ============================================================

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
AS $FUNCTION$
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
    o.id                    AS org_id,
    sp.id                   AS sso_provider_id,
    o.enforcement_mode::TEXT,
    o.slug::TEXT            AS org_slug
  FROM public.sso_domains sd
  JOIN public.organizations o  ON o.id = sd.org_id
  JOIN public.sso_providers sp ON sp.org_id = sd.org_id
  WHERE sd.domain = v_domain
    AND o.sso_enabled = TRUE
  LIMIT 1;
END;
$FUNCTION$;

REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) TO service_role;

COMMENT ON FUNCTION public.lookup_sso_provider_for_domain(TEXT) IS
  'Called only by server actions via supabaseAdmin. Do NOT grant to anon or authenticated. Return shape: (org_id UUID, sso_provider_id UUID, enforcement_mode TEXT, org_slug TEXT). Only returns rows where organizations.sso_enabled=TRUE. Migration 072 added explicit ::TEXT cast on slug because organizations.slug is VARCHAR(100) and does not auto-coerce to TEXT in function return contexts.';

-- ============================================================
-- VERIFICATION
-- ============================================================

-- V1. Function still has the 4-column signature:
-- SELECT pg_get_function_result(oid) FROM pg_proc
--   WHERE proname = 'lookup_sso_provider_for_domain'
--     AND pronamespace = 'public'::regnamespace;
-- Expected: 'TABLE(org_id uuid, sso_provider_id uuid,
--                  enforcement_mode text, org_slug text)'

-- V2. Grants unchanged (no anon, no authenticated):
-- SELECT grantee, privilege_type
--   FROM information_schema.role_routine_grants
--  WHERE routine_schema = 'public'
--    AND routine_name = 'lookup_sso_provider_for_domain'
--  ORDER BY grantee;
-- Expected: postgres EXECUTE, service_role EXECUTE only.

-- V3. Unmapped email returns empty (no change):
-- SELECT * FROM public.lookup_sso_provider_for_domain('nobody@nonexistent.test');
-- Expected: 0 rows.

-- V4. Malformed email returns empty (no change):
-- SELECT * FROM public.lookup_sso_provider_for_domain('not-an-email');
-- Expected: 0 rows.

-- V5. Founder's email (currently no sso_domains rows, so 0 rows
-- expected; this verifies the query path no longer errors):
-- SELECT * FROM public.lookup_sso_provider_for_domain('kaan@usesettle.ai');
-- Expected: 0 rows. Previously this threw 42804; now returns empty.
