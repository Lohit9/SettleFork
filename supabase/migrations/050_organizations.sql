-- ============================================================
-- 050: Organizations, memberships, project members, and org-based RLS
-- ============================================================

-- ============================================================
-- A. NEW TABLES
-- ============================================================

CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id)
);

CREATE TABLE public.org_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'editor', 'reviewer', 'viewer')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE TABLE public.org_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'editor', 'reviewer', 'viewer')),
  token VARCHAR(64) NOT NULL UNIQUE,
  invited_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE TABLE public.project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) CHECK (role IN ('owner', 'editor', 'reviewer', 'viewer')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID REFERENCES auth.users(id),
  UNIQUE(project_id, user_id)
);

-- ============================================================
-- B. MODIFY EXISTING PROJECTS TABLE
-- ============================================================

ALTER TABLE public.projects ADD COLUMN org_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.projects ADD COLUMN created_by UUID REFERENCES auth.users(id);
ALTER TABLE public.projects ADD COLUMN visibility VARCHAR(10) NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'private'));

-- ============================================================
-- C. INDEXES
-- ============================================================

CREATE INDEX idx_org_memberships_user ON public.org_memberships(user_id);
CREATE INDEX idx_org_memberships_org ON public.org_memberships(org_id);
CREATE INDEX idx_org_invites_token ON public.org_invites(token);
CREATE INDEX idx_org_invites_email ON public.org_invites(email);
CREATE INDEX idx_projects_org ON public.projects(org_id);
CREATE INDEX idx_project_members_user ON public.project_members(user_id);
CREATE INDEX idx_project_members_project ON public.project_members(project_id);

-- ============================================================
-- D. DATA MIGRATION
-- ============================================================

-- Create an org for each user who has projects
DO $$
DECLARE
  r RECORD;
  new_org_id UUID;
BEGIN
  FOR r IN (
    SELECT DISTINCT p.user_id,
           COALESCE(prof.full_name, split_part(au.email, '@', 1), 'My') AS display_name
    FROM public.projects p
    LEFT JOIN public.profiles prof ON prof.id = p.user_id
    LEFT JOIN auth.users au ON au.id = p.user_id
    WHERE p.user_id IS NOT NULL
  ) LOOP
    INSERT INTO public.organizations (name, slug, created_by)
    VALUES (r.display_name || '''s Workspace',
            'ws-' || LEFT(REPLACE(gen_random_uuid()::text, '-', ''), 12),
            r.user_id)
    RETURNING id INTO new_org_id;

    INSERT INTO public.org_memberships (org_id, user_id, role)
    VALUES (new_org_id, r.user_id, 'owner');

    UPDATE public.projects
    SET org_id = new_org_id, created_by = r.user_id
    WHERE user_id = r.user_id;
  END LOOP;
END $$;

-- Create an org for users who exist but have no projects
DO $$
DECLARE
  r RECORD;
  new_org_id UUID;
BEGIN
  FOR r IN (
    SELECT au.id AS user_id,
           COALESCE(prof.full_name, split_part(au.email, '@', 1), 'My') AS display_name
    FROM auth.users au
    LEFT JOIN public.profiles prof ON prof.id = au.id
    WHERE NOT EXISTS (SELECT 1 FROM public.org_memberships om WHERE om.user_id = au.id)
  ) LOOP
    INSERT INTO public.organizations (name, slug, created_by)
    VALUES (r.display_name || '''s Workspace',
            'ws-' || LEFT(REPLACE(gen_random_uuid()::text, '-', ''), 12),
            r.user_id)
    RETURNING id INTO new_org_id;

    INSERT INTO public.org_memberships (org_id, user_id, role)
    VALUES (new_org_id, r.user_id, 'owner');
  END LOOP;
END $$;

-- Now make org_id NOT NULL
ALTER TABLE public.projects ALTER COLUMN org_id SET NOT NULL;

-- ============================================================
-- E. HELPER FUNCTIONS FOR RLS
-- ============================================================

CREATE OR REPLACE FUNCTION public.user_can_access_project(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_memberships om
    JOIN public.projects p ON p.org_id = om.org_id
    WHERE p.id = p_project_id AND om.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_user_project_role(p_project_id UUID, p_user_id UUID)
RETURNS VARCHAR(20) AS $$
  SELECT COALESCE(
    (SELECT role FROM public.project_members WHERE project_id = p_project_id AND user_id = p_user_id),
    (SELECT om.role FROM public.org_memberships om
     JOIN public.projects p ON p.org_id = om.org_id
     WHERE p.id = p_project_id AND om.user_id = p_user_id)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.user_has_project_role(p_project_id UUID, p_min_role VARCHAR(20))
RETURNS BOOLEAN AS $$
DECLARE
  v_role VARCHAR(20);
  v_hierarchy JSONB := '{"owner":5,"admin":4,"editor":3,"reviewer":2,"viewer":1}'::JSONB;
BEGIN
  v_role := public.get_user_project_role(p_project_id, auth.uid());
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  RETURN (v_hierarchy->>v_role)::INT >= (v_hierarchy->>p_min_role)::INT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================
-- F. DROP ALL EXISTING RLS POLICIES
-- ============================================================

-- Projects
DROP POLICY IF EXISTS "projects_policy" ON public.projects;

-- One hop from projects
DROP POLICY IF EXISTS "datasets_policy" ON public.datasets;
DROP POLICY IF EXISTS "table_mappings_policy" ON public.table_mappings;
DROP POLICY IF EXISTS "quality_issues_policy" ON public.quality_issues;
DROP POLICY IF EXISTS "outputs_policy" ON public.outputs;
DROP POLICY IF EXISTS "validation_rules_policy" ON public.validation_rules;
DROP POLICY IF EXISTS "fix_history_policy" ON public.fix_history;
DROP POLICY IF EXISTS "activity_log_select_own" ON public.activity_log;
DROP POLICY IF EXISTS "Users manage own project acknowledgments" ON public.field_acknowledgments;
DROP POLICY IF EXISTS "Users manage own db connections" ON public.db_connections;

-- Two hops via datasets
DROP POLICY IF EXISTS "tables_policy" ON public.tables;
DROP POLICY IF EXISTS "schema_documents_policy" ON public.schema_documents;

-- Three hops via tables
DROP POLICY IF EXISTS "fields_policy" ON public.fields;
DROP POLICY IF EXISTS "data_rows_policy" ON public.data_rows;

-- Four hops via fields
DROP POLICY IF EXISTS "field_profiles_policy" ON public.field_profiles;

-- Via table_mappings
DROP POLICY IF EXISTS "field_mappings_policy" ON public.field_mappings;
DROP POLICY IF EXISTS "Users access own staged data" ON public.staged_data_rows;

-- Via field_mappings
DROP POLICY IF EXISTS "transformations_policy" ON public.transformations;

-- Via fix_history
DROP POLICY IF EXISTS "Users access own fix snapshots" ON public.fix_snapshots;

-- Migration intelligence (user_id-based)
DROP POLICY IF EXISTS "Users can read own intelligence" ON public.migration_intelligence;
DROP POLICY IF EXISTS "Users can insert own intelligence" ON public.migration_intelligence;
DROP POLICY IF EXISTS "Users can update own intelligence" ON public.migration_intelligence;
DROP POLICY IF EXISTS "Users can delete own intelligence" ON public.migration_intelligence;

-- ============================================================
-- G. NEW ORG-BASED RLS POLICIES
-- ============================================================

-- Enable RLS on new tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- ── Organizations ─────────────────────────────────────────────

CREATE POLICY "org_members_can_view" ON public.organizations FOR SELECT
  USING (id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid()));

CREATE POLICY "org_admins_can_update" ON public.organizations FOR UPDATE
  USING (id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid() AND role IN ('owner', 'admin')));

-- ── Org memberships ───────────────────────────────────────────

CREATE POLICY "members_can_view_fellow_members" ON public.org_memberships FOR SELECT
  USING (org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid()));

CREATE POLICY "admins_can_insert_members" ON public.org_memberships FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid() AND role IN ('owner', 'admin')));

CREATE POLICY "admins_can_update_members" ON public.org_memberships FOR UPDATE
  USING (org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid() AND role IN ('owner', 'admin')));

CREATE POLICY "admins_can_delete_members" ON public.org_memberships FOR DELETE
  USING (org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid() AND role IN ('owner', 'admin')));

-- ── Org invites ───────────────────────────────────────────────

CREATE POLICY "admins_can_manage_invites" ON public.org_invites FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid() AND role IN ('owner', 'admin')));

CREATE POLICY "anyone_can_read_invite_by_token" ON public.org_invites FOR SELECT
  USING (true);

-- ── Project members ───────────────────────────────────────────

CREATE POLICY "org_members_can_view_project_members" ON public.project_members FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "project_admins_can_manage_members" ON public.project_members FOR ALL
  USING (public.user_has_project_role(project_id, 'admin'));

-- ── Projects ──────────────────────────────────────────────────

CREATE POLICY "org_members_can_view_projects" ON public.projects FOR SELECT
  USING (
    org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
    OR id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid())
  );

CREATE POLICY "org_members_can_create_projects" ON public.projects FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid()));

CREATE POLICY "editors_can_update_projects" ON public.projects FOR UPDATE
  USING (public.user_has_project_role(id, 'editor'));

CREATE POLICY "admins_can_delete_projects" ON public.projects FOR DELETE
  USING (public.user_has_project_role(id, 'admin'));

-- ── Datasets (project_id) ─────────────────────────────────────

CREATE POLICY "org_access_datasets" ON public.datasets FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_datasets" ON public.datasets FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_datasets" ON public.datasets FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_datasets" ON public.datasets FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Table mappings (project_id) ───────────────────────────────

CREATE POLICY "org_access_table_mappings" ON public.table_mappings FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_table_mappings" ON public.table_mappings FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_table_mappings" ON public.table_mappings FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_table_mappings" ON public.table_mappings FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Quality issues (project_id) ──────────────────────────────

CREATE POLICY "org_access_quality_issues" ON public.quality_issues FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_quality_issues" ON public.quality_issues FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_quality_issues" ON public.quality_issues FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_quality_issues" ON public.quality_issues FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Outputs (project_id) ─────────────────────────────────────

CREATE POLICY "org_access_outputs" ON public.outputs FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_outputs" ON public.outputs FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_outputs" ON public.outputs FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_outputs" ON public.outputs FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Validation rules (project_id) ────────────────────────────

CREATE POLICY "org_access_validation_rules" ON public.validation_rules FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_validation_rules" ON public.validation_rules FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_validation_rules" ON public.validation_rules FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_validation_rules" ON public.validation_rules FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Fix history (project_id) ─────────────────────────────────

CREATE POLICY "org_access_fix_history" ON public.fix_history FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_fix_history" ON public.fix_history FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_fix_history" ON public.fix_history FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_fix_history" ON public.fix_history FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Activity log (project_id) — SELECT only ──────────────────

CREATE POLICY "org_access_activity_log" ON public.activity_log FOR SELECT
  USING (public.user_can_access_project(project_id));

-- ── Field acknowledgments (project_id) ───────────────────────

CREATE POLICY "org_access_field_acknowledgments" ON public.field_acknowledgments FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_field_acknowledgments" ON public.field_acknowledgments FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_field_acknowledgments" ON public.field_acknowledgments FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_field_acknowledgments" ON public.field_acknowledgments FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── DB connections (project_id) ──────────────────────────────

CREATE POLICY "org_access_db_connections" ON public.db_connections FOR SELECT
  USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_db_connections" ON public.db_connections FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_db_connections" ON public.db_connections FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_db_connections" ON public.db_connections FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── Tables (dataset_id → datasets.project_id) ────────────────

CREATE POLICY "org_access_tables" ON public.tables FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_can_access_project(d.project_id)));
CREATE POLICY "editors_insert_tables" ON public.tables FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_has_project_role(d.project_id, 'editor')));
CREATE POLICY "editors_update_tables" ON public.tables FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_has_project_role(d.project_id, 'editor')));
CREATE POLICY "editors_delete_tables" ON public.tables FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_has_project_role(d.project_id, 'editor')));

-- ── Schema documents (dataset_id → datasets.project_id) ──────

CREATE POLICY "org_access_schema_documents" ON public.schema_documents FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_can_access_project(d.project_id)));
CREATE POLICY "editors_insert_schema_documents" ON public.schema_documents FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_has_project_role(d.project_id, 'editor')));
CREATE POLICY "editors_update_schema_documents" ON public.schema_documents FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_has_project_role(d.project_id, 'editor')));
CREATE POLICY "editors_delete_schema_documents" ON public.schema_documents FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.datasets d WHERE d.id = dataset_id AND public.user_has_project_role(d.project_id, 'editor')));

-- ── Fields (table_id → tables → datasets) ────────────────────

CREATE POLICY "org_access_fields" ON public.fields FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_can_access_project(d.project_id)
  ));
CREATE POLICY "editors_insert_fields" ON public.fields FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_has_project_role(d.project_id, 'editor')
  ));
CREATE POLICY "editors_update_fields" ON public.fields FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_has_project_role(d.project_id, 'editor')
  ));
CREATE POLICY "editors_delete_fields" ON public.fields FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_has_project_role(d.project_id, 'editor')
  ));

-- ── Data rows (table_id → tables → datasets) ─────────────────

CREATE POLICY "org_access_data_rows" ON public.data_rows FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_can_access_project(d.project_id)
  ));
CREATE POLICY "editors_insert_data_rows" ON public.data_rows FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_has_project_role(d.project_id, 'editor')
  ));
CREATE POLICY "editors_update_data_rows" ON public.data_rows FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_has_project_role(d.project_id, 'editor')
  ));
CREATE POLICY "editors_delete_data_rows" ON public.data_rows FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.tables t JOIN public.datasets d ON d.id = t.dataset_id
    WHERE t.id = table_id AND public.user_has_project_role(d.project_id, 'editor')
  ));

-- ── Field profiles (field_id → fields → tables → datasets) ───

CREATE POLICY "org_access_field_profiles" ON public.field_profiles FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.fields f
    JOIN public.tables t ON t.id = f.table_id
    JOIN public.datasets d ON d.id = t.dataset_id
    WHERE f.id = field_id AND public.user_can_access_project(d.project_id)
  ));
CREATE POLICY "editors_insert_field_profiles" ON public.field_profiles FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.fields f
    JOIN public.tables t ON t.id = f.table_id
    JOIN public.datasets d ON d.id = t.dataset_id
    WHERE f.id = field_id AND public.user_has_project_role(d.project_id, 'editor')
  ));
CREATE POLICY "editors_update_field_profiles" ON public.field_profiles FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.fields f
    JOIN public.tables t ON t.id = f.table_id
    JOIN public.datasets d ON d.id = t.dataset_id
    WHERE f.id = field_id AND public.user_has_project_role(d.project_id, 'editor')
  ));
CREATE POLICY "editors_delete_field_profiles" ON public.field_profiles FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.fields f
    JOIN public.tables t ON t.id = f.table_id
    JOIN public.datasets d ON d.id = t.dataset_id
    WHERE f.id = field_id AND public.user_has_project_role(d.project_id, 'editor')
  ));

-- ── Field mappings (table_mapping_id → table_mappings) ────────

CREATE POLICY "org_access_field_mappings" ON public.field_mappings FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_can_access_project(tm.project_id)));
CREATE POLICY "editors_insert_field_mappings" ON public.field_mappings FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')));
CREATE POLICY "editors_update_field_mappings" ON public.field_mappings FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')));
CREATE POLICY "editors_delete_field_mappings" ON public.field_mappings FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')));

-- ── Staged data rows (table_mapping_id → table_mappings) ─────

CREATE POLICY "org_access_staged_data" ON public.staged_data_rows FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_can_access_project(tm.project_id)));
CREATE POLICY "editors_insert_staged_data" ON public.staged_data_rows FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')));
CREATE POLICY "editors_update_staged_data" ON public.staged_data_rows FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')));
CREATE POLICY "editors_delete_staged_data" ON public.staged_data_rows FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.table_mappings tm WHERE tm.id = table_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')));

-- ── Transformations (field_mapping_id → field_mappings → table_mappings) ──

CREATE POLICY "org_access_transformations" ON public.transformations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.field_mappings fm
    JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
    WHERE fm.id = field_mapping_id AND public.user_can_access_project(tm.project_id)
  ));
CREATE POLICY "editors_insert_transformations" ON public.transformations FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.field_mappings fm
    JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
    WHERE fm.id = field_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')
  ));
CREATE POLICY "editors_update_transformations" ON public.transformations FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.field_mappings fm
    JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
    WHERE fm.id = field_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')
  ));
CREATE POLICY "editors_delete_transformations" ON public.transformations FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.field_mappings fm
    JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
    WHERE fm.id = field_mapping_id AND public.user_has_project_role(tm.project_id, 'editor')
  ));

-- ── Fix snapshots (fix_history_id → fix_history.project_id) ──

CREATE POLICY "org_access_fix_snapshots" ON public.fix_snapshots FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.fix_history fh WHERE fh.id = fix_history_id AND public.user_can_access_project(fh.project_id)));
CREATE POLICY "editors_insert_fix_snapshots" ON public.fix_snapshots FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.fix_history fh WHERE fh.id = fix_history_id AND public.user_has_project_role(fh.project_id, 'editor')));
CREATE POLICY "editors_update_fix_snapshots" ON public.fix_snapshots FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.fix_history fh WHERE fh.id = fix_history_id AND public.user_has_project_role(fh.project_id, 'editor')));
CREATE POLICY "editors_delete_fix_snapshots" ON public.fix_snapshots FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.fix_history fh WHERE fh.id = fix_history_id AND public.user_has_project_role(fh.project_id, 'editor')));

-- ── Migration intelligence (user_id-based → org membership) ──
-- migration_intelligence has user_id, not project_id.
-- Replace with org membership check: user can access their own intelligence,
-- OR intelligence belonging to any member of their orgs.

CREATE POLICY "org_members_can_read_intelligence" ON public.migration_intelligence FOR SELECT
  USING (
    user_id = auth.uid()
    OR user_id IN (
      SELECT om2.user_id FROM public.org_memberships om1
      JOIN public.org_memberships om2 ON om1.org_id = om2.org_id
      WHERE om1.user_id = auth.uid()
    )
  );

CREATE POLICY "users_can_insert_own_intelligence" ON public.migration_intelligence FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "users_can_update_own_intelligence" ON public.migration_intelligence FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "users_can_delete_own_intelligence" ON public.migration_intelligence FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================
-- H. STORAGE POLICY — UNCHANGED
-- ============================================================
-- TODO: Storage bucket policy still uses user_id-based folder paths.
-- Storage access for org members is handled via server actions using supabaseAdmin.
-- A future migration should restructure storage paths to org_id/project_id/filename
-- and update the storage policy to use org membership checks.
-- For now, the existing policy remains unchanged.
