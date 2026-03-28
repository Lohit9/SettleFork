-- ============================================================
-- Migration 040: Update execute_transform_test to support
-- multiple source fields in the before-values sample preview
-- (many-to-one transforms show null for contributing fields).
--
-- Adds a new overload: execute_transform_test(TEXT, UUID, TEXT[], INT)
--   Returns JSONB array with {before_value, before_values, after_value}
--   before_values is a JSONB object keyed by source field name.
--
-- The original (TEXT, UUID, TEXT, INT) signature remains unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION execute_transform_test(
  p_expression    TEXT,
  p_table_id      UUID,
  p_source_fields TEXT[],
  p_limit         INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $$
DECLARE
  v_result     JSONB;
  v_clean      TEXT;
  v_sql        TEXT;
  v_jsonb_expr TEXT;
BEGIN
  v_clean := lower(trim(p_expression));

  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute)\y' THEN
    RAISE EXCEPTION 'Transform expression cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform expression cannot access system tables';
  END IF;
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform expression can only reference field values from data_rows';
  END IF;
  IF p_expression ~ ';' THEN
    RAISE EXCEPTION 'Transform expression cannot contain semicolons';
  END IF;

  -- Build jsonb_build_object for all source fields
  SELECT 'jsonb_build_object(' ||
    string_agg(
      '''' || field_name || ''', row_data->>''' || field_name || '''',
      ', '
      ORDER BY ord
    ) || ')'
  INTO v_jsonb_expr
  FROM unnest(p_source_fields) WITH ORDINALITY AS t(field_name, ord);

  v_sql := format(
    'SELECT row_data->>%L AS before_value, %s AS before_values, (%s)::TEXT AS after_value'
    ' FROM data_rows WHERE table_id = %L ORDER BY row_number LIMIT %s',
    p_source_fields[1],
    v_jsonb_expr,
    p_expression,
    p_table_id::TEXT,
    LEAST(COALESCE(p_limit, 20), 50)
  );

  EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', v_sql) INTO v_result;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION execute_transform_test(TEXT, UUID, TEXT[], INT)
  TO authenticated, service_role;
