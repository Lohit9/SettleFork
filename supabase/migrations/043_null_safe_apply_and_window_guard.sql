-- Migration 043: NULL-safe jsonb_set in dq_apply_field_transform
--               + window function guard in execute_transform_full_test
--
-- Bug 1 (apply crash): When a transform expression evaluates to NULL for a row
--   (e.g. 'TC-' || row_data->>'matter_id' where matter_id IS NULL), the apply RPC did:
--     jsonb_set(transformed_row_data, '{field}', to_jsonb(NULL::text))
--   PostgreSQL throws "invalid input syntax for type json" because the third argument
--   to jsonb_set cannot be SQL NULL. Fix: wrap with a CASE so NULL-result rows are
--   skipped and the existing value (or JSON null) is preserved instead.
--
-- Bug 2 (test/apply mismatch): execute_transform_full_test ran the expression in a
--   SELECT, where PostgreSQL allows window functions (ROW_NUMBER() OVER()). The same
--   expression then fails in UPDATE SET with "window functions are not allowed in UPDATE".
--   Fix: add an explicit window-function check to the test RPC so it fails fast with a
--   clear message before the user clicks Apply.

-- ── 1. NULL-safe dq_apply_field_transform ────────────────────────────────────

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

  -- Safety: window functions cannot be used in UPDATE SET — reject early with a clear message
  IF v_clean ~ '\yover\s*\(' THEN
    RAISE EXCEPTION 'Window functions (e.g. ROW_NUMBER() OVER()) cannot be used in a transform expression because PostgreSQL does not allow them inside UPDATE SET. Rewrite using a hash or concatenation instead (e.g. LEFT(MD5(field::text), 8)).';
  END IF;

  IF p_has_existing_staged THEN
    -- Update the single target field on all existing staged rows.
    -- NULL-safe: if the expression evaluates to NULL for a row, keep the existing value
    -- rather than calling jsonb_set with a NULL third argument (which throws a JSON error).
    EXECUTE format(
      'UPDATE staged_data_rows s
       SET transformed_row_data = CASE
         WHEN (%s) IS NOT NULL
           THEN jsonb_set(
                  s.transformed_row_data,
                  ''{%s}'',
                  to_jsonb((%s)::text)
                )
         ELSE s.transformed_row_data
       END
       FROM data_rows d
       WHERE s.source_table_id = d.table_id
         AND s.row_number = d.row_number
         AND s.table_mapping_id = $1',
      p_transform_sql,
      p_target_field_name,
      p_transform_sql
    ) USING p_table_mapping_id;
  ELSE
    -- First apply: create staged rows with just this one field.
    -- NULL-safe: use JSON null (not SQL NULL) so the JSONB object is always valid.
    EXECUTE format(
      'INSERT INTO staged_data_rows
         (table_mapping_id, source_table_id, target_table_id,
          row_number, source_row_data, transformed_row_data)
       SELECT $1, $2, $3,
              d.row_number,
              d.row_data,
              jsonb_build_object(
                ''%s'',
                CASE WHEN (%s) IS NOT NULL THEN to_jsonb((%s)::text) ELSE ''null''::jsonb END
              )
       FROM data_rows d
       WHERE d.table_id = $2
       ORDER BY d.row_number',
      p_target_field_name,
      p_transform_sql,
      p_transform_sql
    ) USING p_table_mapping_id, p_source_table_id, p_target_table_id;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN)
  TO authenticated, service_role;

-- ── 2. Window function guard in execute_transform_full_test ──────────────────
-- The fast path runs the expression in a SELECT, where window functions are
-- allowed. This means ROW_NUMBER() OVER() passes the test but then fails on
-- Apply ("window functions are not allowed in UPDATE"). Adding an explicit check
-- here ensures the test fails with a clear message — consistent with Apply.

CREATE OR REPLACE FUNCTION execute_transform_full_test(
  p_expression   TEXT,
  p_table_id     UUID,
  p_source_field TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_clean     TEXT;
  v_total     INT;
  v_passed    INT := 0;
  v_failures  JSONB := '[]'::JSONB;
  v_max_fail  CONSTANT INT := 20;
  rec         RECORD;
  v_dummy     TEXT;
BEGIN
  v_clean := lower(trim(p_expression));

  -- ── Security checks ────────────────────────────────────────────────────────
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

  -- ── Window function guard ──────────────────────────────────────────────────
  -- Reject window functions even though SELECT allows them — Apply (UPDATE SET)
  -- does not, so we catch it here to keep test/apply behaviour consistent.
  IF v_clean ~ '\yover\s*\(' THEN
    RAISE EXCEPTION 'Window functions (e.g. ROW_NUMBER() OVER()) cannot be used in a transform expression because PostgreSQL does not allow them inside UPDATE SET. Rewrite using a hash or concatenation instead (e.g. LEFT(MD5(field::text), 8)).';
  END IF;

  -- ── Count total rows ───────────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_total FROM data_rows WHERE table_id = p_table_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'total_rows',  0,
      'passed_rows', 0,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  END IF;

  -- ── Fast path: one-shot SELECT across all rows ─────────────────────────────
  BEGIN
    EXECUTE format(
      'SELECT COUNT(*) FROM (SELECT (%s) FROM data_rows WHERE table_id = %L) _t',
      p_expression, p_table_id::TEXT
    ) INTO v_passed;

    RETURN jsonb_build_object(
      'total_rows',  v_total,
      'passed_rows', v_passed,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- ── Slow path: iterate rows, catch per-row exceptions ─────────────────────
  FOR rec IN
    SELECT id, row_number, row_data->>p_source_field AS src_val
    FROM data_rows
    WHERE table_id = p_table_id
    ORDER BY row_number
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT (%s)::TEXT FROM data_rows WHERE id = %L',
        p_expression, rec.id
      ) INTO v_dummy;
      v_passed := v_passed + 1;
    EXCEPTION WHEN OTHERS THEN
      IF jsonb_array_length(v_failures) < v_max_fail THEN
        v_failures := v_failures || jsonb_build_array(
          jsonb_build_object(
            'row_number',    rec.row_number,
            'source_value',  COALESCE(rec.src_val, ''),
            'error_message', SQLERRM
          )
        );
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'total_rows',  v_total,
    'passed_rows', v_passed,
    'failed_rows', v_total - v_passed,
    'failures',    v_failures
  );
END;
$$;
