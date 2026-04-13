-- ============================================================
-- Migration 061: Fix execute_transform_test_distinct to avoid
-- GROUP BY on a raw JSONB column.
--
-- Root cause: GROUP BY on a JSONB expression can trigger implicit
-- casts in certain PostgreSQL planner paths, producing
-- "invalid input syntax for type json" errors.
--
-- Fix: cast the JSONB before_values expression to TEXT inside
-- the inner GROUP BY query, then cast it back to JSONB in the
-- outer SELECT. TEXT comparison is always stable and requires
-- no special operator class.
--
-- Only the primary (TEXT[]) overload changes. The single-field
-- wrapper just delegates to it and requires no changes.
-- ============================================================

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

  -- Security gates (unchanged)
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

  -- Build jsonb_build_object expression (unchanged):
  -- jsonb_build_object('field1', row_data->>'field1', ...)
  SELECT 'jsonb_build_object(' ||
    string_agg(
      '''' || field_name || ''', d.row_data->>''' || field_name || '''',
      ', '
      ORDER BY ord
    ) || ')'
  INTO v_jsonb_expr
  FROM unnest(p_source_fields) WITH ORDINALITY AS t(field_name, ord);

  -- Cast the JSONB before_values expression to TEXT for GROUP BY to avoid
  -- implicit JSONB comparison operators that can fail with
  -- "invalid input syntax for type json".  The outer query casts it back
  -- to JSONB to satisfy the return type.
  v_query := format(
    'SELECT _sub.before_values_text::JSONB AS before_values,
            _sub.after_value,
            _sub.occurrence_count
     FROM (
       SELECT (%s)::TEXT          AS before_values_text,
              (%s)::TEXT          AS after_value,
              COUNT(*)::BIGINT    AS occurrence_count
       FROM data_rows d
       WHERE d.table_id = %L
       GROUP BY 1, 2
       ORDER BY occurrence_count DESC
       LIMIT %s
     ) _sub',
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
