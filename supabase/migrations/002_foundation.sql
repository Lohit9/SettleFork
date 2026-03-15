-- ============================================================
-- Mine Foundation Migration
-- All core tables, RLS policies, indexes, and storage bucket
-- ============================================================

-- ============================================================
-- CORE LAYER: Projects, Datasets, Tables, Fields, Data
-- ============================================================

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID REFERENCES datasets(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  row_count INT DEFAULT 0,
  csv_storage_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  inferred_type TEXT,
  is_nullable BOOLEAN DEFAULT true,
  is_primary_key BOOLEAN DEFAULT false,
  is_foreign_key BOOLEAN DEFAULT false,
  fk_reference TEXT,
  ordinal_position INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE data_rows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE NOT NULL,
  row_number INT NOT NULL,
  row_data JSONB NOT NULL
);

CREATE TABLE field_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE NOT NULL,
  total_rows INT NOT NULL,
  null_count INT DEFAULT 0,
  null_percentage NUMERIC(5,2) DEFAULT 0,
  cardinality INT DEFAULT 0,
  unique_percentage NUMERIC(5,2) DEFAULT 0,
  format_issues_count INT DEFAULT 0,
  min_value TEXT,
  max_value TEXT,
  sample_values JSONB,
  computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE schema_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID REFERENCES datasets(id) ON DELETE CASCADE NOT NULL,
  filename TEXT NOT NULL,
  file_size INT,
  file_storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- MAPPING LAYER
-- ============================================================

CREATE TABLE table_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  source_table_id UUID REFERENCES tables(id) ON DELETE CASCADE NOT NULL,
  target_table_id UUID REFERENCES tables(id) ON DELETE CASCADE NOT NULL,
  confidence NUMERIC(5,2),
  status TEXT DEFAULT 'needs_review'
    CHECK (status IN ('needs_review', 'approved', 'rejected')),
  ai_reasoning TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_mapping_id UUID REFERENCES table_mappings(id) ON DELETE CASCADE NOT NULL,
  source_field_id UUID REFERENCES fields(id) ON DELETE CASCADE NOT NULL,
  target_field_id UUID REFERENCES fields(id) ON DELETE CASCADE NOT NULL,
  confidence NUMERIC(5,2),
  status TEXT DEFAULT 'needs_review'
    CHECK (status IN ('needs_review', 'approved', 'rejected')),
  ai_reasoning TEXT,
  similar_fields_considered JSONB,
  type_compatibility TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- QUALITY LAYER
-- ============================================================

CREATE TABLE quality_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE,
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('source', 'in_flight', 'target')),
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'warning')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_records INT DEFAULT 0,
  ai_suggested_fix TEXT,
  generated_sql TEXT,
  status TEXT DEFAULT 'open'
    CHECK (status IN ('open', 'fixed', 'accepted_risk')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TRANSFORMATION + OUTPUT LAYER
-- ============================================================

CREATE TABLE transformations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_mapping_id UUID REFERENCES field_mappings(id) ON DELETE CASCADE NOT NULL,
  description TEXT,
  generated_sql TEXT NOT NULL,
  is_ai_generated BOOLEAN DEFAULT true,
  test_results JSONB,
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'tested', 'saved')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('mapping_file', 'transformation_specs', 'readiness_report')),
  format TEXT NOT NULL,
  version TEXT DEFAULT '1.0',
  file_storage_path TEXT,
  generated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- UPDATED_AT TRIGGER (projects table)
-- ============================================================

CREATE OR REPLACE FUNCTION update_projects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_projects_updated_at();

-- ============================================================
-- INDEXES (frequently queried foreign keys)
-- ============================================================

CREATE INDEX idx_datasets_project_id ON datasets(project_id);
CREATE INDEX idx_tables_dataset_id ON tables(dataset_id);
CREATE INDEX idx_fields_table_id ON fields(table_id);
CREATE INDEX idx_data_rows_table_id ON data_rows(table_id);
CREATE INDEX idx_field_profiles_field_id ON field_profiles(field_id);
CREATE INDEX idx_schema_documents_dataset_id ON schema_documents(dataset_id);
CREATE INDEX idx_table_mappings_project_id ON table_mappings(project_id);
CREATE INDEX idx_table_mappings_source_table_id ON table_mappings(source_table_id);
CREATE INDEX idx_table_mappings_target_table_id ON table_mappings(target_table_id);
CREATE INDEX idx_field_mappings_table_mapping_id ON field_mappings(table_mapping_id);
CREATE INDEX idx_field_mappings_source_field_id ON field_mappings(source_field_id);
CREATE INDEX idx_field_mappings_target_field_id ON field_mappings(target_field_id);
CREATE INDEX idx_quality_issues_project_id ON quality_issues(project_id);
CREATE INDEX idx_quality_issues_field_id ON quality_issues(field_id);
CREATE INDEX idx_quality_issues_table_id ON quality_issues(table_id);
CREATE INDEX idx_transformations_field_mapping_id ON transformations(field_mapping_id);
CREATE INDEX idx_outputs_project_id ON outputs(project_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- projects: direct user ownership
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "projects_policy"
  ON projects FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- datasets: one level through projects
ALTER TABLE datasets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "datasets_policy"
  ON datasets FOR ALL
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  )
  WITH CHECK (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- tables: two levels through datasets → projects
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tables_policy"
  ON tables FOR ALL
  USING (
    dataset_id IN (
      SELECT d.id FROM datasets d
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    dataset_id IN (
      SELECT d.id FROM datasets d
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- fields: three levels through tables → datasets → projects
ALTER TABLE fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fields_policy"
  ON fields FOR ALL
  USING (
    table_id IN (
      SELECT t.id FROM tables t
      JOIN datasets d ON t.dataset_id = d.id
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    table_id IN (
      SELECT t.id FROM tables t
      JOIN datasets d ON t.dataset_id = d.id
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- data_rows: three levels through tables → datasets → projects
ALTER TABLE data_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "data_rows_policy"
  ON data_rows FOR ALL
  USING (
    table_id IN (
      SELECT t.id FROM tables t
      JOIN datasets d ON t.dataset_id = d.id
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    table_id IN (
      SELECT t.id FROM tables t
      JOIN datasets d ON t.dataset_id = d.id
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- field_profiles: four levels through fields → tables → datasets → projects
ALTER TABLE field_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "field_profiles_policy"
  ON field_profiles FOR ALL
  USING (
    field_id IN (
      SELECT f.id FROM fields f
      JOIN tables t ON f.table_id = t.id
      JOIN datasets d ON t.dataset_id = d.id
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    field_id IN (
      SELECT f.id FROM fields f
      JOIN tables t ON f.table_id = t.id
      JOIN datasets d ON t.dataset_id = d.id
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- schema_documents: two levels through datasets → projects
ALTER TABLE schema_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "schema_documents_policy"
  ON schema_documents FOR ALL
  USING (
    dataset_id IN (
      SELECT d.id FROM datasets d
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    dataset_id IN (
      SELECT d.id FROM datasets d
      JOIN projects p ON d.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- table_mappings: direct through project_id
ALTER TABLE table_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "table_mappings_policy"
  ON table_mappings FOR ALL
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  )
  WITH CHECK (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- field_mappings: two levels through table_mappings → projects
ALTER TABLE field_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "field_mappings_policy"
  ON field_mappings FOR ALL
  USING (
    table_mapping_id IN (
      SELECT tm.id FROM table_mappings tm
      JOIN projects p ON tm.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    table_mapping_id IN (
      SELECT tm.id FROM table_mappings tm
      JOIN projects p ON tm.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- quality_issues: direct through project_id
ALTER TABLE quality_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quality_issues_policy"
  ON quality_issues FOR ALL
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  )
  WITH CHECK (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- transformations: three levels through field_mappings → table_mappings → projects
ALTER TABLE transformations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "transformations_policy"
  ON transformations FOR ALL
  USING (
    field_mapping_id IN (
      SELECT fm.id FROM field_mappings fm
      JOIN table_mappings tm ON fm.table_mapping_id = tm.id
      JOIN projects p ON tm.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    field_mapping_id IN (
      SELECT fm.id FROM field_mappings fm
      JOIN table_mappings tm ON fm.table_mapping_id = tm.id
      JOIN projects p ON tm.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- outputs: direct through project_id
ALTER TABLE outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "outputs_policy"
  ON outputs FOR ALL
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  )
  WITH CHECK (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- ============================================================
-- SUPABASE STORAGE BUCKET
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('project-files', 'project-files', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: users can only access files under their own user_id path prefix
-- Path structure: {user_id}/{project_id}/source|target|schemas|outputs/...
CREATE POLICY "storage_user_files_policy"
  ON storage.objects FOR ALL
  USING (
    bucket_id = 'project-files' AND
    (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'project-files' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );
