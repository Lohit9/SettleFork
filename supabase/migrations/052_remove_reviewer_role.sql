-- ============================================================
-- 052: Remove 'reviewer' role — simplify to Owner, Admin, Editor, Viewer
-- ============================================================

-- Convert existing reviewer memberships/invites to viewer
UPDATE public.org_memberships SET role = 'viewer' WHERE role = 'reviewer';
UPDATE public.project_members SET role = 'viewer' WHERE role = 'reviewer';
UPDATE public.org_invites SET role = 'viewer' WHERE role = 'reviewer';

-- Update CHECK constraint on org_memberships
ALTER TABLE public.org_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_check;
ALTER TABLE public.org_memberships ADD CONSTRAINT org_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'editor', 'viewer'));

-- Update CHECK constraint on project_members
ALTER TABLE public.project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE public.project_members ADD CONSTRAINT project_members_role_check
  CHECK (role IN ('owner', 'admin', 'editor', 'viewer'));

-- Update CHECK constraint on org_invites
ALTER TABLE public.org_invites DROP CONSTRAINT IF EXISTS org_invites_role_check;
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_role_check
  CHECK (role IN ('owner', 'admin', 'editor', 'viewer'));

-- Update role hierarchy function (reviewer removed, hierarchy renumbered)
CREATE OR REPLACE FUNCTION public.user_has_project_role(p_project_id UUID, p_min_role VARCHAR(20))
RETURNS BOOLEAN AS $$
DECLARE
  v_role VARCHAR(20);
  v_hierarchy JSONB := '{"owner":4,"admin":3,"editor":2,"viewer":1}'::JSONB;
BEGIN
  v_role := public.get_user_project_role(p_project_id, auth.uid());
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  RETURN (v_hierarchy->>v_role)::INT >= (v_hierarchy->>p_min_role)::INT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
