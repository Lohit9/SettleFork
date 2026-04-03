-- ============================================================
-- 051: Fix circular RLS on org_memberships
--
-- Problem: Migration 050 created RLS policies on org_memberships
-- that reference org_memberships itself (self-referencing). When
-- other tables' policies subquery org_memberships, the inner
-- query is also subject to RLS, creating a circular evaluation
-- that returns 0 rows — blocking all access.
--
-- Fix: Create SECURITY DEFINER helper functions that bypass RLS
-- to resolve the user's org memberships, then rewrite all
-- affected policies to call those functions instead.
-- ============================================================

-- ============================================================
-- A. SECURITY DEFINER HELPERS
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_user_admin_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM public.org_memberships
  WHERE user_id = auth.uid() AND role IN ('owner', 'admin');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- B. FIX: organizations policies
-- ============================================================

DROP POLICY IF EXISTS "org_members_can_view" ON public.organizations;
CREATE POLICY "org_members_can_view" ON public.organizations FOR SELECT
  USING (id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "org_admins_can_update" ON public.organizations;
CREATE POLICY "org_admins_can_update" ON public.organizations FOR UPDATE
  USING (id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- C. FIX: org_memberships policies (the self-referencing ones)
-- ============================================================

DROP POLICY IF EXISTS "members_can_view_fellow_members" ON public.org_memberships;
CREATE POLICY "members_can_view_fellow_members" ON public.org_memberships FOR SELECT
  USING (org_id IN (SELECT public.get_user_org_ids()));

DROP POLICY IF EXISTS "admins_can_insert_members" ON public.org_memberships;
CREATE POLICY "admins_can_insert_members" ON public.org_memberships FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "admins_can_update_members" ON public.org_memberships;
CREATE POLICY "admins_can_update_members" ON public.org_memberships FOR UPDATE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

DROP POLICY IF EXISTS "admins_can_delete_members" ON public.org_memberships;
CREATE POLICY "admins_can_delete_members" ON public.org_memberships FOR DELETE
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- ============================================================
-- D. FIX: org_invites policies
-- ============================================================

DROP POLICY IF EXISTS "admins_can_manage_invites" ON public.org_invites;
CREATE POLICY "admins_can_manage_invites" ON public.org_invites FOR ALL
  USING (org_id IN (SELECT public.get_user_admin_org_ids()));

-- "anyone_can_read_invite_by_token" is USING (true) — no change needed.

-- ============================================================
-- E. FIX: projects policies
-- ============================================================

DROP POLICY IF EXISTS "org_members_can_view_projects" ON public.projects;
CREATE POLICY "org_members_can_view_projects" ON public.projects FOR SELECT
  USING (
    org_id IN (SELECT public.get_user_org_ids())
    OR id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "org_members_can_create_projects" ON public.projects;
CREATE POLICY "org_members_can_create_projects" ON public.projects FOR INSERT
  WITH CHECK (org_id IN (SELECT public.get_user_org_ids()));

-- "editors_can_update_projects" and "admins_can_delete_projects" use
-- user_has_project_role() which is already SECURITY DEFINER — no change.

-- ============================================================
-- F. FIX: migration_intelligence SELECT policy
-- ============================================================

DROP POLICY IF EXISTS "org_members_can_read_intelligence" ON public.migration_intelligence;
CREATE POLICY "org_members_can_read_intelligence" ON public.migration_intelligence FOR SELECT
  USING (
    user_id = auth.uid()
    OR user_id IN (
      SELECT om.user_id FROM public.org_memberships om
      WHERE om.org_id IN (SELECT public.get_user_org_ids())
    )
  );

-- INSERT/UPDATE/DELETE on migration_intelligence use user_id = auth.uid() — no change.

-- ============================================================
-- G. NO CHANGES NEEDED for child table policies
--
-- All of these already use SECURITY DEFINER functions:
--   - datasets, table_mappings, quality_issues, outputs,
--     validation_rules, fix_history, activity_log,
--     field_acknowledgments, db_connections, tables,
--     schema_documents, fields, data_rows, field_profiles,
--     field_mappings, staged_data_rows, transformations,
--     fix_snapshots
--   → use user_can_access_project() or user_has_project_role()
--
-- project_members policies:
--   - SELECT uses user_can_access_project() — OK
--   - ALL uses user_has_project_role() — OK
-- ============================================================
