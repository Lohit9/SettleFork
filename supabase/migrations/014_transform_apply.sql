-- ============================================================
-- Transform Apply + Distinct Preview RPCs
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- ── 1. Widen transformations.status to include 'applied' and 'stale' ────────

ALTER TABLE transformations DROP CONSTRAINT IF EXISTS transformations_status_check;
ALTER TABLE transformations
  ADD CONSTRAINT transformations_status_check
  CHECK (status IN ('draft', 'tested', 'saved', 'applied', 'stale'));

-- ── 2. Per-field apply RPC ────────────────────────────────────────────────────
-- Applies a single field transform to staged_data_rows.
-- If p_has_existing_staged = true: UPDATEs the target field column in place.
-- If p_has_existing_staged = false: INSERTs fresh staged rows with just this field.

CREATE OR REPLACE FUNCTION dq_apply_field_transform(
  p_table_mapping_id    UUID,
  p_source_table_id     UUID,
  p_target_table_id     UUID,
  p_target_field_name   TEXT,
  p_transform_sql       TEXT,
  p_has_existing_staged BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
SET work_mem = '64MB'
AS $$
DECLARE
  v_count BIGINT;
  v_clean TEXT;
BEGIN
  -- Safety: field name must be alphanumeric + underscores only
  IF p_target_field_name !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid target field name: %', p_target_field_name;
  END IF;

  -- Safety: block DML/DDL in the transform expression
  v_clean := lower(trim(p_transform_sql));
  IF v_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
    RAISE EXCEPTION 'Transform SQL cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform SQL cannot access system tables';
  END IF;
  IF p_transform_sql ~ ';' THEN
    RAISE EXCEPTION 'Transform SQL cannot contain semicolons';
  END IF;

  IF p_has_existing_staged THEN
    -- Update the single target field on all existing staged rows
    EXECUTE format(
      'UPDATE staged_data_rows s
       SET transformed_row_data = jsonb_set(
         s.transformed_row_data,
         ''{%s}'',
         to_jsonb((%s)::text)
       )
       FROM data_rows d
       WHERE s.source_table_id = d.table_id
         AND s.row_number = d.row_number
         AND s.table_mapping_id = $1',
      p_target_field_name,
      p_transform_sql
    ) USING p_table_mapping_id;
  ELSE
    -- First apply: create staged rows with just this one field
    EXECUTE format(
      'INSERT INTO staged_data_rows
         (table_mapping_id, source_table_id, target_table_id,
          row_number, source_row_data, transformed_row_data)
       SELECT $1, $2, $3,
              d.row_number,
              d.row_data,
              jsonb_build_object(''%s'', (%s)::text)
       FROM data_rows d
       WHERE d.table_id = $2
       ORDER BY d.row_number',
      p_target_field_name,
      p_transform_sql
    ) USING p_table_mapping_id, p_source_table_id, p_target_table_id;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN)
  TO authenticated, service_role;

-- ── 3. Distinct-value preview RPC ────────────────────────────────────────────
-- Returns all distinct (before, after, count) triples for a transform expression,
-- ordered by frequency descending. Critical for catching ELSE/default fallthrough.

CREATE OR REPLACE FUNCTION execute_transform_test_distinct(
  p_expression  TEXT,
  p_table_id    UUID,
  p_source_field TEXT,
  p_limit       INT DEFAULT 200
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '10s'
AS $$
DECLARE
  v_result JSONB;
  v_clean  TEXT;
BEGIN
  v_clean := lower(trim(p_expression));

  -- Same security gates as execute_transform_test
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

  EXECUTE format(
    'SELECT jsonb_agg(t)
     FROM (
       SELECT
         row_data->>%L  AS before_value,
         (%s)           AS after_value,
         COUNT(*)::int  AS row_count
       FROM data_rows
       WHERE table_id = %L
       GROUP BY row_data->>%L, (%s)
       ORDER BY row_count DESC
       LIMIT %s
     ) t',
    p_source_field,
    p_expression,
    p_table_id::TEXT,
    p_source_field,
    p_expression,
    LEAST(COALESCE(p_limit, 200), 500)
  ) INTO v_result;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION execute_transform_test_distinct(TEXT, UUID, TEXT, INT)
  TO authenticated, service_role;
