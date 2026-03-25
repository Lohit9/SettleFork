-- ============================================================
-- Transform Full Test RPC
-- Runs a transform expression against ALL rows in a source
-- table and returns a pass/fail summary with up to 20 failure
-- details (row number, source value, error message).
--
-- Two-phase approach:
--   1. Fast path: single-query run; if it succeeds all rows pass.
--   2. Slow path (triggered on error): per-row PL/pgSQL loop with
--      per-exception handling to pinpoint individual failures.
-- ============================================================

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

  -- ── Security checks (mirror execute_transform_test) ────────────────────────
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

  -- ── Count total rows ────────────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_total FROM data_rows WHERE table_id = p_table_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'total_rows',  0,
      'passed_rows', 0,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  END IF;

  -- ── Fast path: one-shot SELECT across all rows ──────────────────────────────
  BEGIN
    EXECUTE format(
      'SELECT COUNT(*) FROM (SELECT (%s) FROM data_rows WHERE table_id = %L) _t',
      p_expression, p_table_id::TEXT
    ) INTO v_passed;

    -- Reached here → all rows succeeded
    RETURN jsonb_build_object(
      'total_rows',  v_total,
      'passed_rows', v_passed,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  EXCEPTION WHEN OTHERS THEN
    -- Fast path failed; fall through to per-row slow path
    NULL;
  END;

  -- ── Slow path: iterate rows, catch per-row exceptions ───────────────────────
  FOR rec IN
    SELECT id, row_number, row_data->>p_source_field AS src_val
    FROM data_rows
    WHERE table_id = p_table_id
    ORDER BY row_number
  LOOP
    BEGIN
      -- Run the expression in the context of this specific row
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
