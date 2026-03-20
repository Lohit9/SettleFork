-- ============================================================
-- Transform Test RPC
-- Safely executes a SQL expression against a source table
-- and returns before/after pairs for the Transform page test.
-- Run this in the Supabase SQL Editor.
-- ============================================================

CREATE OR REPLACE FUNCTION execute_transform_test(
  p_expression  TEXT,
  p_table_id    UUID,
  p_source_field TEXT,
  p_limit       INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $$
DECLARE
  v_result JSONB;
  v_clean  TEXT;
  v_sql    TEXT;
BEGIN
  v_clean := lower(trim(p_expression));

  -- Block DML / DDL in the expression
  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute)\y' THEN
    RAISE EXCEPTION 'Transform expression cannot contain data modification statements';
  END IF;

  -- Block system table / schema access
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform expression cannot access system tables';
  END IF;

  -- Block references to application tables other than data field values
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform expression can only reference field values from data_rows';
  END IF;

  -- Block semicolons
  IF p_expression ~ ';' THEN
    RAISE EXCEPTION 'Transform expression cannot contain semicolons';
  END IF;

  -- Build and execute the test SELECT
  v_sql := format(
    'SELECT row_data->>%L AS before_value, (%s) AS after_value'
    ' FROM data_rows WHERE table_id = %L ORDER BY row_number LIMIT %s',
    p_source_field,
    p_expression,
    p_table_id::TEXT,
    LEAST(COALESCE(p_limit, 20), 50)
  );

  EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', v_sql) INTO v_result;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;
