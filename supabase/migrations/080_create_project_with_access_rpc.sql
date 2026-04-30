-- ============================================================
-- Migration 080 — create_project_with_access RPC
-- ============================================================
-- Adds atomic single-RPC project creation flow that performs:
--   1. Resolve user from auth.uid() (mandatory)
--   2. Resolve org_id (use param if given; else user's first
--      org_membership ordered by joined_at ASC for determinism)
--   3. Validate user is member of resolved org
--   4. INSERT into projects, capture new id
--   5. Fanout via grant_new_project_access (creator + org owners
--      as project-admin; org members as project-editor when
--      member_auto_grant_enabled is TRUE)
--   6. INSERT source + target datasets
--   7. Return the new project row
--
-- Why: Production debugging on 2026-04-30 confirmed that the
-- @supabase/ssr cookie-based SSR client loses JWT context on
-- write operations specifically (reads in the same request work
-- but writes hit Postgres with an unauthenticated context, causing
-- auth.uid() to return NULL during RLS evaluation).
--
-- Moving the entire flow into a single SECURITY DEFINER RPC
-- avoids per-statement JWT context dependency: the JWT is
-- resolved once at function entry, and all DDL inside runs with
-- the function definer's privileges. Atomic transaction semantics
-- replace the application-level supabaseAdmin.delete() rollback.
--
-- Compatibility: 079's grant_new_project_access RPC remains in
-- place and unchanged (still called from this RPC and referenced
-- by tests). Only createProject in lib/actions/projects.ts is
-- updated to call the new RPC.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_project_with_access(
  p_name TEXT,
  p_description TEXT,
  p_source_system_name TEXT,
  p_target_system_name TEXT,
  p_org_id UUID DEFAULT NULL,
  p_use_mapping_redesign BOOLEAN DEFAULT TRUE
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id          UUID;
  v_org_id           UUID;
  v_membership_role  TEXT;
  v_project          public.projects;
BEGIN
  -- 1. Resolve user from JWT
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Resolve org_id
  IF p_org_id IS NOT NULL THEN
    v_org_id := p_org_id;
  ELSE
    SELECT om.org_id INTO v_org_id
    FROM public.org_memberships om
    WHERE om.user_id = v_user_id
    ORDER BY om.joined_at ASC
    LIMIT 1;

    IF v_org_id IS NULL THEN
      RAISE EXCEPTION 'No organization found for user' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 3. Validate user is a member of the resolved org
  SELECT om.role INTO v_membership_role
  FROM public.org_memberships om
  WHERE om.org_id = v_org_id AND om.user_id = v_user_id;

  IF v_membership_role IS NULL THEN
    RAISE EXCEPTION 'User is not a member of this organization' USING ERRCODE = '42501';
  END IF;

  -- 4. Insert project
  INSERT INTO public.projects (
    name,
    description,
    user_id,
    org_id,
    created_by,
    use_mapping_redesign
  ) VALUES (
    p_name,
    NULLIF(p_description, ''),
    v_user_id,
    v_org_id,
    v_user_id,
    p_use_mapping_redesign
  )
  RETURNING * INTO v_project;

  -- 5. Fanout project_members rows via existing 079 RPC
  PERFORM public.grant_new_project_access(v_project.id, v_org_id, v_user_id);

  -- 6. Insert source + target datasets
  INSERT INTO public.datasets (project_id, role, name)
  VALUES
    (v_project.id, 'source', p_source_system_name),
    (v_project.id, 'target', p_target_system_name);

  -- 7. Return the new project row
  RETURN v_project;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project_with_access(
  TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_project_with_access(
  TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN
) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_project_with_access(
  TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN
) IS
  'Atomic project creation RPC. Validates auth.uid(), resolves or accepts org_id, inserts project, fans out project_members rows via grant_new_project_access, inserts source + target datasets. Returns the new projects row. Replaces the application-level multi-step flow that suffered from @supabase/ssr write-path JWT context loss.';
