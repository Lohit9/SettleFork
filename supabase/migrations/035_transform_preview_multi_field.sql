-- ============================================================
-- Migration 035: Update execute_transform_test_distinct to support
-- multiple source fields in the before-values preview (many-to-one transforms).
--
-- OLD signature: execute_transform_test_distinct(TEXT, UUID, TEXT, INT)
--   returns JSONB array with {before_value, after_value, row_count}
--
-- NEW primary signature: execute_transform_test_distinct(UUID, TEXT[], TEXT)
--   returns TABLE(before_values JSONB, after_value TEXT, occurrence_count BIGINT)
--   before_values is always a JSONB object keyed by source field name.
--
-- BACKWARD-COMPAT wrapper: execute_transform_test_distinct(UUID, TEXT, TEXT)
--   Accepts a single source field name, delegates to the array version.
-- ============================================================

-- 1. Drop the old function
DROP FUNCTION IF EXISTS execute_transform_test_distinct(TEXT, UUID, TEXT, INT);
DROP FUNCTION IF EXISTS execute_transform_test_distinct(TEXT, UUID, TEXT);

-- 2. Create the new multi-source-field primary version
CREATE OR REPLACE FUNCTION execute_transform_test_distinct(
  p_table_id        UUID,
  p_source_fields   TEXT[],
  p_transform_sql   TEXT,
  p_limit           INT DEFAULT 200
)
RETURNS TABLE(
  before_values     JSONB,
  after_value       TEXT,
  occurrence_count  BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_clean      TEXT;
  v_jsonb_expr TEXT;
  v_query      TEXT;
BEGIN
  v_clean := lower(trim(p_transform_sql));

  -- Security gates (same as old version)
  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute)\y' THEN
    RAISE EXCEPTION 'Transform expression cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform expression cannot access system tables';
  END IF;
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform expression can only reference field values from data_rows';
  END IF;
  IF p_transform_sql ~ ';' THEN
    RAISE EXCEPTION 'Transform expression cannot contain semicolons';
  END IF;

  -- Build jsonb_build_object expression:
  -- jsonb_build_object('field1', row_data->>'field1', 'field2', row_data->>'field2', ...)
  SELECT 'jsonb_build_object(' ||
    string_agg(
      '''' || field_name || ''', d.row_data->>''' || field_name || '''',
      ', '
      ORDER BY ord
    ) || ')'
  INTO v_jsonb_expr
  FROM unnest(p_source_fields) WITH ORDINALITY AS t(field_name, ord);

  v_query := format(
    'SELECT %s AS before_values,
            (%s)::TEXT AS after_value,
            COUNT(*)::BIGINT AS occurrence_count
     FROM data_rows d
     WHERE d.table_id = %L
     GROUP BY 1, 2
     ORDER BY occurrence_count DESC
     LIMIT %s',
    v_jsonb_expr,
    p_transform_sql,
    p_table_id,
    LEAST(COALESCE(p_limit, 200), 500)
  );

  RETURN QUERY EXECUTE v_query;

EXCEPTION WHEN OTHERS THEN
  -- Surface the DB error as a single row for the caller to show
  RETURN QUERY SELECT
    jsonb_build_object('_error', true)  AS before_values,
    SQLERRM                             AS after_value,
    0::BIGINT                           AS occurrence_count;
END;
$$;

GRANT EXECUTE ON FUNCTION execute_transform_test_distinct(UUID, TEXT[], TEXT, INT)
  TO authenticated, service_role;

-- 3. Backward-compatible single-field wrapper
--    Existing code that passes a single TEXT source field still works unchanged.
CREATE OR REPLACE FUNCTION execute_transform_test_distinct(
  p_table_id      UUID,
  p_source_field  TEXT,
  p_transform_sql TEXT,
  p_limit         INT DEFAULT 200
)
RETURNS TABLE(
  before_values     JSONB,
  after_value       TEXT,
  occurrence_count  BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT * FROM execute_transform_test_distinct(
      p_table_id,
      ARRAY[p_source_field],
      p_transform_sql,
      p_limit
    );
END;
$$;

GRANT EXECUTE ON FUNCTION execute_transform_test_distinct(UUID, TEXT, TEXT, INT)
  TO authenticated, service_role;
