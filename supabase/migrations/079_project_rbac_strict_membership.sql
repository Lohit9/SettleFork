-- ============================================================
-- 079: Project-level RBAC — strict project_members membership model
--
-- Goal (PR 1 of 3 for project-level RBAC):
--   Make project access a property of `project_members` membership only.
--   Remove the org-role fallback in `get_user_project_role` /
--   `user_can_access_project`. Org membership no longer grants implicit
--   project access. Org owners and members are auto-granted explicit
--   project_members rows (admin and editor respectively) via event-
--   driven RPCs and a one-time migration backfill.
--
-- Role taxonomy change (this migration):
--   org_memberships.role:  ('owner','admin','editor','viewer') → ('owner','member')
--                          mapping: admin → owner, editor → member, viewer → member
--   org_invites.role:      same as above
--   project_members.role:  ('owner','admin','editor','viewer') → ('admin','editor','viewer')
--                          mapping: owner → admin (project creators)
--
-- Auto-grant rules (event-driven, idempotent, ON CONFLICT DO NOTHING):
--   1. New org_memberships row with role='owner'  → project-admin on every project
--   2. New org_memberships row with role='member' → project-editor on every project
--                                                   IFF organizations.member_auto_grant_enabled
--   3. org_memberships.role promoted member → owner → project-admin on every project
--      (sticky: existing rows kept, new rows added)
--   4. New project created → admin rows for all org owners + editor rows for all
--      org members (if toggle on) + admin row for creator
--   5. organizations.member_auto_grant_enabled flipped OFF→ON → backfill editor rows
--      for every (member × project) pair (sticky: never removes rows)
--
-- Removal stickiness:
--   Removal of a project_members row sticks. Future events do NOT re-add (every
--   fanout uses ON CONFLICT (project_id, user_id) DO NOTHING).
--
-- This migration:
--   §A. Add organizations.member_auto_grant_enabled (default TRUE)
--   §B. Update existing org_memberships / org_invites role values + CHECK + default
--   §C. Update existing project_members role values + CHECK
--   §D. Update get_user_admin_org_ids (drop legacy 'admin' from the membership filter)
--   §E. Backfill project_members from existing org_memberships
--   §F. Rewrite get_user_project_role (drop org fallback)
--   §G. Rewrite user_can_access_project (drop org branch)
--   §H. Update user_has_project_role hierarchy (drop owner, drop reviewer slot)
--   §I. Rewrite projects SELECT RLS to drop the org_id branch
--   §J. Create SECURITY DEFINER fanout helper RPCs
--   §K. Rewrite provision_user_via_jit (default 'member' + fanout call)
--   §L. Verification block (RAISE NOTICE row counts pre/post backfill)
--
-- This migration does NOT:
--   - Touch project_members SELECT RLS (deferred to PR 2 alongside guest access work)
--   - Drop projects.visibility column (dormant, deferred to PR 2)
--   - Add NOT NULL on project_members.role (deferred — would need NULL row audit)
--   - Add new tables or storage policy changes
-- ============================================================

-- ============================================================
-- §A. organizations.member_auto_grant_enabled
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS member_auto_grant_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.organizations.member_auto_grant_enabled IS
  'Per-org toggle controlling whether org members (non-owners) are auto-granted project-editor on every project. Defaults TRUE for backward compatibility with the pre-079 access pattern. When flipped OFF→ON, setOrgMemberAutoGrant() RPC backfills editor rows for every (member × project) pair. When flipped ON→OFF, existing project_members rows are NOT removed (stickiness). Owners are always auto-granted project-admin regardless of this flag.';

-- ============================================================
-- §B. org_memberships + org_invites role taxonomy rename
--     admin → owner ; editor/viewer → member
-- ============================================================

-- Update existing rows BEFORE tightening the CHECK constraint
UPDATE public.org_memberships SET role = 'owner'  WHERE role = 'admin';
UPDATE public.org_memberships SET role = 'member' WHERE role IN ('editor', 'viewer');

UPDATE public.org_invites      SET role = 'owner'  WHERE role = 'admin';
UPDATE public.org_invites      SET role = 'member' WHERE role IN ('editor', 'viewer');

-- Drop and recreate the CHECK constraints with the new two-value set
ALTER TABLE public.org_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_check;
ALTER TABLE public.org_memberships
  ADD CONSTRAINT org_memberships_role_check CHECK (role IN ('owner', 'member'));

ALTER TABLE public.org_invites DROP CONSTRAINT IF EXISTS org_invites_role_check;
ALTER TABLE public.org_invites
  ADD CONSTRAINT org_invites_role_check CHECK (role IN ('owner', 'member'));

-- Update column defaults from the legacy 'viewer' to the new 'member'
ALTER TABLE public.org_memberships ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE public.org_invites      ALTER COLUMN role SET DEFAULT 'member';

-- ============================================================
-- §C. project_members role taxonomy: drop legacy 'owner'
--     project creators (currently stored as 'owner') become 'admin'
-- ============================================================

-- Update existing rows BEFORE tightening the CHECK constraint
UPDATE public.project_members SET role = 'admin' WHERE role = 'owner';

ALTER TABLE public.project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_role_check CHECK (role IN ('admin', 'editor', 'viewer'));

-- ============================================================
-- §D. get_user_admin_org_ids (drop legacy 'admin' from filter)
--     This SECURITY DEFINER function is referenced by the
--     organizations / org_memberships / org_invites RLS policies
--     rewritten in 051. After §B all org-admins are now 'owner', so the
--     filter collapses to `role = 'owner'`.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_admin_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM public.org_memberships
  WHERE user_id = auth.uid() AND role = 'owner';
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- §E. Backfill project_members from existing org_memberships
--
--   Owner backfill: every org owner gets project-admin on every project
--     in their org.
--   Member backfill: every org member gets project-editor on every
--     project in their org IFF the org's member_auto_grant_enabled is
--     TRUE (defaulted TRUE in §A, so all orgs at this point qualify).
--
--   Both are ON CONFLICT (project_id, user_id) DO NOTHING — preserves
--   any existing project_members row (e.g. the project creator's
--   pre-existing 'owner'-now-'admin' row from §C, or a manually-added
--   row).
--
--   `assigned_by` is set to the project's `created_by` when present,
--   otherwise NULL. This is informational only — assigned_by is FK to
--   auth.users with no DELETE cascade and accepts NULL.
-- ============================================================

INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
SELECT p.id, om.user_id, 'admin', p.created_by
FROM public.org_memberships om
JOIN public.projects p ON p.org_id = om.org_id
WHERE om.role = 'owner'
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
SELECT p.id, om.user_id, 'editor', p.created_by
FROM public.org_memberships om
JOIN public.projects p ON p.org_id = om.org_id
JOIN public.organizations o ON o.id = om.org_id
WHERE om.role = 'member' AND o.member_auto_grant_enabled = TRUE
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ============================================================
-- §F. get_user_project_role — strict, no fallback
--
--   Old (050:146-154): COALESCE(project_members.role, org_memberships.role)
--   New: project_members.role only. NULL when no row exists.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_project_role(p_project_id UUID, p_user_id UUID)
RETURNS VARCHAR(20) AS $$
  SELECT role FROM public.project_members
  WHERE project_id = p_project_id AND user_id = p_user_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- §G. user_can_access_project — strict, no org branch
--
--   Old (050:134-144): EXISTS in org_memberships ∪ project_members
--   New: EXISTS in project_members only.
--
--   This single-function rewrite covers every `org_access_*` SELECT
--   policy on every project-scoped child table (datasets,
--   table_mappings, quality_issues, outputs, validation_rules,
--   fix_history, activity_log, field_acknowledgments, db_connections,
--   tables, schema_documents, fields, data_rows, field_profiles,
--   field_mappings, staged_data_rows, transformations, fix_snapshots
--   — defined in 050:280-528). No per-table policy edits required.
-- ============================================================

CREATE OR REPLACE FUNCTION public.user_can_access_project(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- §H. user_has_project_role — three-role hierarchy
--
--   Old (052:26-36): {owner:4, admin:3, editor:2, viewer:1}
--   New: {admin:3, editor:2, viewer:1}. Project_members no longer has
--        an 'owner' role (project creators are 'admin'). 'reviewer'
--        was already removed in 052.
--
--   If `v_role` is not present in the hierarchy (e.g. a legacy NULL
--   role row, or an unexpected value), the function returns FALSE
--   (fail-closed). Same for `p_min_role` to guard against caller bugs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.user_has_project_role(p_project_id UUID, p_min_role VARCHAR(20))
RETURNS BOOLEAN AS $$
DECLARE
  v_role VARCHAR(20);
  v_hierarchy JSONB := '{"admin":3,"editor":2,"viewer":1}'::JSONB;
BEGIN
  v_role := public.get_user_project_role(p_project_id, auth.uid());
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF (v_hierarchy ? v_role) IS FALSE THEN RETURN FALSE; END IF;
  IF (v_hierarchy ? p_min_role) IS FALSE THEN RETURN FALSE; END IF;
  RETURN (v_hierarchy->>v_role)::INT >= (v_hierarchy->>p_min_role)::INT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================
-- §I. projects SELECT RLS — drop the org_id branch
--
--   Old (051:76-81): org_id IN get_user_org_ids() OR id IN project_members
--   New: id IN project_members only.
--
--   The INSERT policy ('org_members_can_create_projects', 051:84-85)
--   stays unchanged — anyone in an org can still CREATE projects;
--   visibility of existing projects is what's restricted.
-- ============================================================

DROP POLICY IF EXISTS "org_members_can_view_projects" ON public.projects;
CREATE POLICY "members_can_view_projects" ON public.projects FOR SELECT
  USING (id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid()));

-- ============================================================
-- §J. Auto-grant fanout RPCs (SECURITY DEFINER, idempotent)
--
--   These three RPCs are the single source of truth for the auto-
--   grant rules. They are called from:
--     - lib/actions/projects.ts (createProject)
--     - lib/actions/org-invites.ts (acceptInvite)
--     - lib/actions/organizations.ts (updateMemberRole, setOrgMemberAutoGrant)
--     - public.provision_user_via_jit (rewritten in §K)
--
--   All inserts use ON CONFLICT (project_id, user_id) DO NOTHING so
--   removed rows stay removed (stickiness rule) and re-runs are
--   no-ops.
-- ============================================================

-- ── J.1 grant_new_project_access ───────────────────────────────
-- Called when a new project is created. Inserts:
--   - creator as project-admin
--   - all org owners as project-admin
--   - all org members as project-editor (if member_auto_grant_enabled)
-- All ON CONFLICT DO NOTHING.

CREATE OR REPLACE FUNCTION public.grant_new_project_access(
  p_project_id UUID,
  p_org_id    UUID,
  p_creator_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Creator as project-admin
  INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
  VALUES (p_project_id, p_creator_id, 'admin', p_creator_id)
  ON CONFLICT (project_id, user_id) DO NOTHING;

  -- All org owners as project-admin (creator may already be one; ON CONFLICT covers it)
  INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
  SELECT p_project_id, om.user_id, 'admin', p_creator_id
  FROM public.org_memberships om
  WHERE om.org_id = p_org_id AND om.role = 'owner'
  ON CONFLICT (project_id, user_id) DO NOTHING;

  -- All org members as project-editor (only if toggle on)
  INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
  SELECT p_project_id, om.user_id, 'editor', p_creator_id
  FROM public.org_memberships om
  JOIN public.organizations o ON o.id = om.org_id
  WHERE om.org_id = p_org_id
    AND om.role = 'member'
    AND o.member_auto_grant_enabled = TRUE
  ON CONFLICT (project_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_new_project_access(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_new_project_access(UUID, UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.grant_new_project_access(UUID, UUID, UUID) IS
  'Called from createProject Server Action after a new public.projects row is inserted. Auto-grants project_members rows for: the creator (admin), all org owners (admin), and all org members (editor) — the last only when organizations.member_auto_grant_enabled is TRUE for the project''s org. Idempotent: every insert uses ON CONFLICT (project_id, user_id) DO NOTHING so re-runs are safe and removed rows stay removed.';

-- ── J.2 grant_new_org_member_project_access ──────────────────────
-- Called when a user becomes a new org owner or member, OR when an
-- existing member is promoted to owner. Behavior depends on p_role:
--   - 'owner':  insert project-admin row for every project in the org
--   - 'member': insert project-editor row for every project in the org
--               IFF member_auto_grant_enabled is TRUE
-- All ON CONFLICT DO NOTHING.

CREATE OR REPLACE FUNCTION public.grant_new_org_member_project_access(
  p_user_id UUID,
  p_org_id  UUID,
  p_role    VARCHAR(20)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_role = 'owner' THEN
    INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
    SELECT p.id, p_user_id, 'admin', NULL
    FROM public.projects p
    WHERE p.org_id = p_org_id
    ON CONFLICT (project_id, user_id) DO NOTHING;
  ELSIF p_role = 'member' THEN
    INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
    SELECT p.id, p_user_id, 'editor', NULL
    FROM public.projects p
    JOIN public.organizations o ON o.id = p.org_id
    WHERE p.org_id = p_org_id
      AND o.member_auto_grant_enabled = TRUE
    ON CONFLICT (project_id, user_id) DO NOTHING;
  END IF;
  -- Other p_role values are no-ops (fail-quiet, called from controlled sites).
END;
$$;

REVOKE ALL ON FUNCTION public.grant_new_org_member_project_access(UUID, UUID, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_new_org_member_project_access(UUID, UUID, VARCHAR) TO authenticated, service_role;

COMMENT ON FUNCTION public.grant_new_org_member_project_access(UUID, UUID, VARCHAR) IS
  'Called when a user gains a new org_memberships role (invite acceptance, JIT provisioning, owner promotion). Inserts project_members rows for every project in the org according to p_role: ''owner''→admin everywhere; ''member''→editor everywhere if member_auto_grant_enabled. Demotion (owner→member) does NOT call this function — stickiness rule keeps existing rows. Idempotent via ON CONFLICT.';

-- ── J.3 backfill_org_member_project_access ─────────────────────
-- Called by setOrgMemberAutoGrant Server Action when the toggle flips
-- from FALSE → TRUE. Inserts project-editor rows for every (member ×
-- project) pair in the org. Does NOT consult the toggle itself —
-- caller has already decided to backfill, and the toggle is updated
-- in the same transaction.

CREATE OR REPLACE FUNCTION public.backfill_org_member_project_access(
  p_org_id UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.project_members (project_id, user_id, role, assigned_by)
  SELECT p.id, om.user_id, 'editor', NULL
  FROM public.org_memberships om
  JOIN public.projects p ON p.org_id = om.org_id
  WHERE om.org_id = p_org_id AND om.role = 'member'
  ON CONFLICT (project_id, user_id) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.backfill_org_member_project_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backfill_org_member_project_access(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.backfill_org_member_project_access(UUID) IS
  'Called by setOrgMemberAutoGrant when member_auto_grant_enabled flips FALSE→TRUE. Inserts project-editor rows for every (member × project) pair in the org. Does NOT consult the toggle (caller decides). Stickiness preserved via ON CONFLICT — previously-removed rows stay removed.';

-- ============================================================
-- §K. Rewrite provision_user_via_jit
--
--   Two changes:
--     1. JIT default role flips from 'viewer' to 'member' (the legacy
--        'viewer' value no longer satisfies the org_memberships CHECK
--        after §B).
--     2. After org_memberships INSERT, call
--        grant_new_org_member_project_access so SSO-JIT users get
--        their auto-grant rows the same way invite/admin paths do.
--
--   The function signature, locking, idempotency contract, and grant
--   set (`service_role` only) are preserved. Only the body changes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_user_via_jit(
  p_user_id UUID,
  p_org_id  UUID,
  p_email   TEXT
)
RETURNS TABLE (
  membership_id UUID,
  assigned_role TEXT,
  was_new       BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_membership public.org_memberships;
  v_invite             public.org_invites;
  v_new_membership     public.org_memberships;
BEGIN
  -- (a) If membership already exists, return existing — no mutation.
  SELECT * INTO v_existing_membership
  FROM public.org_memberships
  WHERE org_id = p_org_id AND user_id = p_user_id
  LIMIT 1;

  IF FOUND THEN
    membership_id := v_existing_membership.id;
    assigned_role := v_existing_membership.role::TEXT;
    was_new       := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- (b) No existing membership — look up a pending invite by email.
  SELECT * INTO v_invite
  FROM public.org_invites
  WHERE org_id = p_org_id
    AND LOWER(email) = LOWER(p_email)
    AND accepted_at IS NULL
    AND expires_at > NOW()
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- (c) Invite path: role from invite (already 'owner' or 'member' post §B),
    --     source='invite', mark invite accepted.
    INSERT INTO public.org_memberships (org_id, user_id, role, provisioning_source, joined_at)
    VALUES (p_org_id, p_user_id, v_invite.role, 'invite', NOW())
    RETURNING * INTO v_new_membership;

    UPDATE public.org_invites
       SET accepted_at = NOW()
     WHERE id = v_invite.id;
  ELSE
    -- (d) JIT path: default role 'member' (was 'viewer' pre-079), source='jit'.
    INSERT INTO public.org_memberships (org_id, user_id, role, provisioning_source, joined_at)
    VALUES (p_org_id, p_user_id, 'member', 'jit', NOW())
    RETURNING * INTO v_new_membership;
  END IF;

  -- Auto-grant project_members rows for the new org membership.
  -- ON CONFLICT inside grant_new_org_member_project_access keeps this
  -- safe even if a stale project_members row exists.
  PERFORM public.grant_new_org_member_project_access(
    p_user_id,
    p_org_id,
    v_new_membership.role
  );

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
  'SSO-JIT first-login provisioning. Idempotent: if membership exists, returns existing row with was_new=FALSE and no mutation. Otherwise inserts org_memberships (role from pending invite if present, else ''member'' [was ''viewer'' pre-079]) and fans out project_members auto-grant via grant_new_org_member_project_access. Service-role only.';

-- ============================================================
-- §L. Verification block — log row counts before / after
--
--   Run as a NOTICE so the migration log shows the migration's
--   effect. NOT a hard assertion (RAISE EXCEPTION) — counts vary by
--   environment. Operators should sanity-check the values match
--   their expectations:
--     - org_owner_count: rows in org_memberships with role='owner'
--     - org_member_count: rows in org_memberships with role='member'
--     - project_count: rows in projects
--     - project_members_count: rows in project_members
--   Expected after backfill:
--     project_members_count >= org_owner_count * project_count_per_org
--                            + (org_member_count_in_toggle_on_orgs * project_count_per_org)
--   minus any pre-existing rows already counted.
-- ============================================================

DO $$
DECLARE
  v_org_owner_count       INTEGER;
  v_org_member_count      INTEGER;
  v_org_legacy_count      INTEGER;
  v_project_count         INTEGER;
  v_project_members_count INTEGER;
  v_legacy_pm_count       INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_org_owner_count   FROM public.org_memberships WHERE role = 'owner';
  SELECT COUNT(*) INTO v_org_member_count  FROM public.org_memberships WHERE role = 'member';
  SELECT COUNT(*) INTO v_org_legacy_count  FROM public.org_memberships WHERE role NOT IN ('owner', 'member');
  SELECT COUNT(*) INTO v_project_count     FROM public.projects;
  SELECT COUNT(*) INTO v_project_members_count FROM public.project_members;
  SELECT COUNT(*) INTO v_legacy_pm_count   FROM public.project_members WHERE role NOT IN ('admin', 'editor', 'viewer');

  RAISE NOTICE '079 verification:';
  RAISE NOTICE '  org_memberships: owner=%, member=%, legacy=%', v_org_owner_count, v_org_member_count, v_org_legacy_count;
  RAISE NOTICE '  projects: count=%', v_project_count;
  RAISE NOTICE '  project_members: count=%, legacy_role_rows=%', v_project_members_count, v_legacy_pm_count;

  -- Hard assertion: no row should still hold a legacy role value.
  IF v_org_legacy_count > 0 THEN
    RAISE EXCEPTION 'Migration 079: % org_memberships rows still hold legacy roles (admin/editor/viewer). Data was not fully remapped.', v_org_legacy_count;
  END IF;
  IF v_legacy_pm_count > 0 THEN
    RAISE EXCEPTION 'Migration 079: % project_members rows still hold legacy roles (owner/reviewer/etc). Data was not fully remapped.', v_legacy_pm_count;
  END IF;
END $$;

-- ============================================================
-- Post-deploy verification (run in SQL editor):
--
--   -- 1. CHECK constraints reflect new taxonomy
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid IN ('public.org_memberships'::regclass,
--                      'public.org_invites'::regclass,
--                      'public.project_members'::regclass)
--     AND conname LIKE '%role%';
--
--   -- 2. Function bodies match expected shape
--   SELECT proname, prosrc FROM pg_proc
--   WHERE proname IN ('get_user_project_role', 'user_can_access_project',
--                     'user_has_project_role', 'grant_new_project_access',
--                     'grant_new_org_member_project_access',
--                     'backfill_org_member_project_access',
--                     'provision_user_via_jit')
--     AND pronamespace = 'public'::regnamespace;
--
--   -- 3. RLS policy on projects only checks project_members
--   SELECT policyname, qual FROM pg_policies
--   WHERE tablename = 'projects' AND cmd = 'SELECT';
--
--   -- 4. Backfill spot-check: every (org_owner × org_project) pair has a row
--   SELECT COUNT(*) AS missing FROM public.org_memberships om
--   JOIN public.projects p ON p.org_id = om.org_id
--   LEFT JOIN public.project_members pm
--     ON pm.project_id = p.id AND pm.user_id = om.user_id
--   WHERE om.role = 'owner' AND pm.id IS NULL;
--   -- expect: 0
-- ============================================================
