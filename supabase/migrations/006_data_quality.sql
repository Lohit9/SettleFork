-- ============================================================
-- Phase 5: Data Quality — new tables, columns, RPC helpers
-- Run in Supabase SQL Editor
-- ============================================================

-- Custom validation rules defined by users
CREATE TABLE IF NOT EXISTS validation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE,
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'not_null', 'unique', 'min_value', 'max_value', 'min_length',
    'max_length', 'regex', 'allowed_values', 'custom_sql', 'range',
    'date_after', 'date_before', 'no_duplicates', 'referential', 'ai_generated'
  )),
  rule_config JSONB NOT NULL DEFAULT '{}',
  severity TEXT DEFAULT 'warning' CHECK (severity IN ('blocking', 'warning')),
  is_ai_generated BOOLEAN DEFAULT false,
  ai_original_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fix history / audit log
CREATE TABLE IF NOT EXISTS fix_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_issue_id UUID REFERENCES quality_issues(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE NOT NULL,
  fix_description TEXT NOT NULL,
  fix_sql TEXT NOT NULL,
  fix_option_chosen TEXT,
  affected_row_count INT NOT NULL DEFAULT 0,
  old_values_sample JSONB,
  status TEXT DEFAULT 'applied' CHECK (status IN ('applied', 'reverted')),
  applied_by UUID REFERENCES auth.users(id),
  applied_at TIMESTAMPTZ DEFAULT now(),
  reverted_at TIMESTAMPTZ
);

-- Extend quality_issues with new columns
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS ai_fix_options JSONB;
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS downstream_impact TEXT;
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS affected_rows_sample JSONB;
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS detection_source TEXT DEFAULT 'auto'
  CHECK (detection_source IN ('auto', 'manual_scan', 'custom_rule'));
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS validation_rule_id UUID
  REFERENCES validation_rules(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE validation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "validation_rules_policy"
  ON validation_rules FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()))
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

ALTER TABLE fix_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fix_history_policy"
  ON fix_history FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()))
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- Additional indexes
CREATE INDEX IF NOT EXISTS idx_quality_issues_stage ON quality_issues(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_quality_issues_status ON quality_issues(project_id, status);
CREATE INDEX IF NOT EXISTS idx_validation_rules_project ON validation_rules(project_id);
CREATE INDEX IF NOT EXISTS idx_fix_history_project ON fix_history(project_id);
CREATE INDEX IF NOT EXISTS idx_fix_history_issue ON fix_history(quality_issue_id);

-- ============================================================
-- DETECTION ENGINE RPC HELPERS
-- ============================================================

-- Count null/empty values for a JSONB field
CREATE OR REPLACE FUNCTION dq_null_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND (row_data->>p_field IS NULL OR trim(coalesce(row_data->>p_field, '')) = '')
$$;

-- Sample rows where field is null/empty
CREATE OR REPLACE FUNCTION dq_null_samples(p_table_id UUID, p_field TEXT, p_limit INT DEFAULT 5)
RETURNS JSONB LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
  FROM (
    SELECT row_data FROM data_rows
    WHERE table_id = p_table_id
      AND (row_data->>p_field IS NULL OR trim(coalesce(row_data->>p_field, '')) = '')
    LIMIT p_limit
  ) t
$$;

-- Count duplicate values in a JSONB field (extra rows beyond first occurrence)
CREATE OR REPLACE FUNCTION dq_duplicate_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COALESCE(SUM(cnt - 1), 0)
  FROM (
    SELECT COUNT(*) AS cnt
    FROM data_rows
    WHERE table_id = p_table_id
      AND row_data->>p_field IS NOT NULL
      AND trim(row_data->>p_field) != ''
    GROUP BY row_data->>p_field
    HAVING COUNT(*) > 1
  ) sub
$$;

-- Sample duplicate values
CREATE OR REPLACE FUNCTION dq_duplicate_samples(p_table_id UUID, p_field TEXT, p_limit INT DEFAULT 5)
RETURNS JSONB LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
  FROM (
    SELECT row_data FROM data_rows
    WHERE table_id = p_table_id
      AND row_data->>p_field IN (
        SELECT row_data->>p_field
        FROM data_rows
        WHERE table_id = p_table_id
          AND row_data->>p_field IS NOT NULL
        GROUP BY row_data->>p_field
        HAVING COUNT(*) > 1
        LIMIT p_limit
      )
    LIMIT p_limit
  ) t
$$;

-- Count values that are not valid integers
CREATE OR REPLACE FUNCTION dq_non_integer_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND NOT (row_data->>p_field ~ '^-?[0-9]+$')
$$;

-- Count values that are not valid numbers (decimal)
CREATE OR REPLACE FUNCTION dq_non_numeric_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND NOT (row_data->>p_field ~ '^-?[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?$')
$$;

-- Count values that are not valid email addresses
CREATE OR REPLACE FUNCTION dq_invalid_email_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND NOT (row_data->>p_field ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
$$;

-- Count values that contain letters (invalid phone)
CREATE OR REPLACE FUNCTION dq_invalid_phone_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND regexp_replace(row_data->>p_field, '[0-9+\-\(\)\s\.]', '', 'g') != ''
$$;

-- Count values exceeding a max string length
CREATE OR REPLACE FUNCTION dq_length_exceeded_count(p_table_id UUID, p_field TEXT, p_max INT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND length(row_data->>p_field) > p_max
$$;

-- Sample rows where field exceeds max length
CREATE OR REPLACE FUNCTION dq_length_exceeded_samples(p_table_id UUID, p_field TEXT, p_max INT, p_limit INT DEFAULT 5)
RETURNS JSONB LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
  FROM (
    SELECT row_data FROM data_rows
    WHERE table_id = p_table_id
      AND row_data->>p_field IS NOT NULL
      AND length(row_data->>p_field) > p_max
    LIMIT p_limit
  ) t
$$;

-- Count orphaned FK values (referential integrity)
CREATE OR REPLACE FUNCTION dq_orphaned_fk_count(
  p_source_table_id UUID,
  p_source_field TEXT,
  p_target_table_id UUID,
  p_target_field TEXT
)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows src
  WHERE src.table_id = p_source_table_id
    AND src.row_data->>p_source_field IS NOT NULL
    AND trim(src.row_data->>p_source_field) != ''
    AND NOT EXISTS (
      SELECT 1 FROM data_rows tgt
      WHERE tgt.table_id = p_target_table_id
        AND tgt.row_data->>p_target_field = src.row_data->>p_source_field
    )
$$;

-- Count rows where non-nullable target field will get a null from source
CREATE OR REPLACE FUNCTION dq_null_to_nonnullable_count(p_source_table_id UUID, p_source_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT dq_null_count(p_source_table_id, p_source_field)
$$;

-- Count values with mixed case (for case consistency check)
CREATE OR REPLACE FUNCTION dq_mixed_case_count(p_table_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND row_data->>p_field ~ '[a-z]'
$$;

-- Sample rows of any kind for a table
CREATE OR REPLACE FUNCTION dq_table_samples(p_table_id UUID, p_limit INT DEFAULT 10)
RETURNS JSONB LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb)
  FROM (
    SELECT row_data FROM data_rows
    WHERE table_id = p_table_id
    LIMIT p_limit
  ) t
$$;

-- Count rows where numeric value is BELOW a minimum (proper cast)
CREATE OR REPLACE FUNCTION dq_below_min_count(p_table_id UUID, p_field TEXT, p_min NUMERIC)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND (row_data->>p_field)::numeric < p_min
$$;

-- Count rows where numeric value is ABOVE a maximum (proper cast)
CREATE OR REPLACE FUNCTION dq_above_max_count(p_table_id UUID, p_field TEXT, p_max NUMERIC)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND (row_data->>p_field)::numeric > p_max
$$;

-- Count rows where string length is below minimum
CREATE OR REPLACE FUNCTION dq_below_min_length_count(p_table_id UUID, p_field TEXT, p_min_length INT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND length(row_data->>p_field) < p_min_length
$$;

-- Count rows where value is not in an allowed set
CREATE OR REPLACE FUNCTION dq_not_in_allowed_count(p_table_id UUID, p_field TEXT, p_values TEXT[])
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND NOT (row_data->>p_field = ANY(p_values))
$$;

-- Count rows where value does NOT match a regex pattern
CREATE OR REPLACE FUNCTION dq_regex_mismatch_count(p_table_id UUID, p_field TEXT, p_pattern TEXT)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    AND NOT (row_data->>p_field ~ p_pattern)
$$;

-- ============================================================
-- FIX EXECUTION RPC (restricted to data_rows only)
-- ============================================================

CREATE OR REPLACE FUNCTION execute_data_fix(p_sql TEXT, p_table_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_affected INT;
  v_upper TEXT;
BEGIN
  v_upper := upper(trim(p_sql));

  -- Must start with UPDATE or DELETE
  IF NOT (v_upper ~ '^(UPDATE|DELETE)') THEN
    RAISE EXCEPTION 'Fix SQL must start with UPDATE or DELETE, got: %', left(v_upper, 20);
  END IF;

  -- Must reference data_rows
  IF position('data_rows' IN lower(p_sql)) = 0 THEN
    RAISE EXCEPTION 'Fix SQL must operate on the data_rows table only';
  END IF;

  -- Must include the specific table_id as a safety anchor
  IF position(p_table_id::TEXT IN p_sql) = 0 THEN
    RAISE EXCEPTION 'Fix SQL must include the specific table_id = ''%''', p_table_id;
  END IF;

  -- Block DDL
  IF v_upper ~ '\y(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|COPY)\y' THEN
    RAISE EXCEPTION 'DDL/DCL statements are not allowed in fix SQL';
  END IF;

  -- Block system table access
  IF lower(p_sql) ~ '(pg_catalog|pg_class|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Fix SQL cannot access system or auth tables';
  END IF;

  -- Block references to other application tables
  IF lower(p_sql) ~ '\b(projects|datasets|tables|fields|field_profiles|schema_documents|table_mappings|field_mappings|quality_issues|validation_rules|fix_history)\b' THEN
    RAISE EXCEPTION 'Fix SQL can only reference data_rows';
  END IF;

  -- Execute
  EXECUTE p_sql;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;
