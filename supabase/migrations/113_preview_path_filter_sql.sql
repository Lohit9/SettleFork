-- ============================================================================
-- Migration 113 — PR Ω.3.3 — Preview path honors table_mappings.filter_sql
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Adds an optional `p_filter_sql TEXT DEFAULT NULL` parameter to the four
--   preview/test RPCs that the Transform tab uses for parse/test/preview
--   affordances. When non-null, the filter is AND'd into the WHERE clause of
--   the source-rows scan in each RPC. When NULL, behavior is byte-identical
--   to pre-Ω.3.3 (the appended clause is the empty string).
--
--   RPCs updated:
--     1. execute_transform_test(TEXT, UUID, TEXT,  INT) — 011 single-field
--     2. execute_transform_test(TEXT, UUID, TEXT[], INT) — 040 multi-field
--     3. execute_transform_full_test(TEXT, UUID, TEXT) — 043 (3 WHERE sites)
--     4. execute_transform_test_distinct(UUID, TEXT[], TEXT, INT) — 035
--        primary multi-field
--
--   Total: 6 WHERE-clause sites across 4 RPCs. Mirrors PR Ω.2's migration 110
--   exactly (which covered the apply-side RPCs).
--
-- DEPLOY ORDER (hot-apply pattern from PR Ω.2 + Ω.3.1)
--   1. Apply this migration via Supabase Dashboard.
--   2. Verify the 4 new signatures via pg_get_function_arguments probe.
--   3. Code PR (action edits in lib/actions/transformations.ts + tests) lands
--      second. Conditional-spread on `p_filter_sql` in the action layer means
--      heritage calls (no filter passed) work against both old and new RPC
--      signatures.
--
-- KNOWN LIMITATIONS
--   • RPC-side DML blocklist on p_filter_sql is the bare-keyword regex.
--     A filter like `status = '2_RCB-APPAREL-DROP'` triggers a false-positive
--     on \ydrop\y until PR ζ.2 ships literal-stripping. Same limitation as
--     PR Ω.2's migration 110 + PR Ω.3.1's migration 112.
--   • execute_transform_test_distinct's single-field wrapper at migration
--     035:100-127 is NOT updated — it has zero callers in lib/, app/, tests/,
--     scripts/. Postgres positional-dispatch keeps the wrapper's 4-arg call
--     to the new 5-arg primary working (p_filter_sql defaults to NULL).
--   • With a non-null filter, `runFullTransformTest`'s totalRows now reflects
--     filtered row count (COUNT(*) WHERE filter), not raw source row count.
--     This is the correct semantic — preview should reflect what apply will
--     see — and the existing UI message "All N rows transformed" naturally
--     reflects the filtered count.
-- ============================================================================

BEGIN;

-- ============================================================================
-- RPC 1 of 4 — execute_transform_test (single-field, migration 011)
-- ============================================================================

DROP FUNCTION IF EXISTS public.execute_transform_test(TEXT, UUID, TEXT, INT);

CREATE OR REPLACE FUNCTION public.execute_transform_test(
  p_expression   TEXT,
  p_table_id     UUID,
  p_source_field TEXT,
  p_limit        INT DEFAULT 20,
  p_filter_sql   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $$
DECLARE
  v_result        JSONB;
  v_clean         TEXT;
  v_filter_clean  TEXT;
  v_filter_clause TEXT := '';
  v_sql           TEXT;
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

  -- Safety gates on p_filter_sql (mirror migration 110)
  IF p_filter_sql IS NOT NULL THEN
    v_filter_clean := lower(trim(p_filter_sql));
    IF v_filter_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain data modification statements';
    END IF;
    IF v_filter_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot access system tables';
    END IF;
    IF p_filter_sql ~ ';' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain semicolons';
    END IF;
    v_filter_clause := ' AND (' || p_filter_sql || ')';
  END IF;

  v_sql := format(
    'SELECT row_data->>%L AS before_value, (%s) AS after_value'
    ' FROM data_rows WHERE table_id = %L%s ORDER BY row_number LIMIT %s',
    p_source_field,
    p_expression,
    p_table_id::TEXT,
    v_filter_clause,
    LEAST(COALESCE(p_limit, 20), 50)
  );

  BEGIN
    EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', v_sql) INTO v_result;
  EXCEPTION WHEN OTHERS THEN
    IF p_filter_sql IS NOT NULL THEN
      RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

COMMENT ON FUNCTION public.execute_transform_test(TEXT, UUID, TEXT, INT, TEXT) IS
  'Single-field transform-test sample preview (≤20 rows). p_filter_sql '
  '(PR Ω.3.3; default NULL) AND''d into WHERE when non-null, scoping the '
  'preview to a partition''s subset of source rows.';

GRANT EXECUTE ON FUNCTION public.execute_transform_test(TEXT, UUID, TEXT, INT, TEXT)
  TO authenticated, service_role;

-- ============================================================================
-- RPC 2 of 4 — execute_transform_test (multi-field, migration 040)
-- ============================================================================

DROP FUNCTION IF EXISTS public.execute_transform_test(TEXT, UUID, TEXT[], INT);

CREATE OR REPLACE FUNCTION public.execute_transform_test(
  p_expression    TEXT,
  p_table_id      UUID,
  p_source_fields TEXT[],
  p_limit         INT DEFAULT 20,
  p_filter_sql    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $$
DECLARE
  v_result        JSONB;
  v_clean         TEXT;
  v_filter_clean  TEXT;
  v_filter_clause TEXT := '';
  v_sql           TEXT;
  v_jsonb_expr    TEXT;
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

  IF p_filter_sql IS NOT NULL THEN
    v_filter_clean := lower(trim(p_filter_sql));
    IF v_filter_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain data modification statements';
    END IF;
    IF v_filter_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot access system tables';
    END IF;
    IF p_filter_sql ~ ';' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain semicolons';
    END IF;
    v_filter_clause := ' AND (' || p_filter_sql || ')';
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
    ' FROM data_rows WHERE table_id = %L%s ORDER BY row_number LIMIT %s',
    p_source_fields[1],
    v_jsonb_expr,
    p_expression,
    p_table_id::TEXT,
    v_filter_clause,
    LEAST(COALESCE(p_limit, 20), 50)
  );

  BEGIN
    EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', v_sql) INTO v_result;
  EXCEPTION WHEN OTHERS THEN
    IF p_filter_sql IS NOT NULL THEN
      RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

COMMENT ON FUNCTION public.execute_transform_test(TEXT, UUID, TEXT[], INT, TEXT) IS
  'Multi-field transform-test sample preview. p_filter_sql (PR Ω.3.3; '
  'default NULL) AND''d into WHERE when non-null.';

GRANT EXECUTE ON FUNCTION public.execute_transform_test(TEXT, UUID, TEXT[], INT, TEXT)
  TO authenticated, service_role;

-- ============================================================================
-- RPC 3 of 4 — execute_transform_full_test (migration 043, 3 WHERE sites)
-- ============================================================================
-- Pre-Ω.3.3 the RPC had 3 distinct WHERE sites:
--   • Line 162: SELECT COUNT(*) INTO v_total — static SQL
--   • Line 176: fast-path EXECUTE format(...) — dynamic SQL, swallows errors
--               for fallback to slow path
--   • Line 194: FOR rec IN SELECT ... — static SQL, with per-row exception
--               handling inside the loop
--
-- Ω.3.3 changes:
--   • Line 162 becomes EXECUTE format (so v_filter_clause can be interpolated)
--   • Line 176's existing swallow remains, but is now augmented to re-raise
--     when the error is filter-related (p_filter_sql IS NOT NULL); non-filter
--     errors still fall through to slow path
--   • Line 194's FOR IN becomes FOR IN EXECUTE format; outer BEGIN/EXCEPTION
--     wraps the FOR-init to re-attribute filter errors (per-row exception
--     handling inside the loop is unchanged)

DROP FUNCTION IF EXISTS public.execute_transform_full_test(TEXT, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.execute_transform_full_test(
  p_expression   TEXT,
  p_table_id     UUID,
  p_source_field TEXT,
  p_filter_sql   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_clean         TEXT;
  v_filter_clean  TEXT;
  v_filter_clause TEXT := '';
  v_total         INT;
  v_passed        INT := 0;
  v_failures      JSONB := '[]'::JSONB;
  v_max_fail      CONSTANT INT := 20;
  rec             RECORD;
  v_dummy         TEXT;
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
  IF v_clean ~ '\yover\s*\(' THEN
    RAISE EXCEPTION 'Window functions (e.g. ROW_NUMBER() OVER()) cannot be used in a transform expression because PostgreSQL does not allow them inside UPDATE SET. Rewrite using a hash or concatenation instead (e.g. LEFT(MD5(field::text), 8)).';
  END IF;

  IF p_filter_sql IS NOT NULL THEN
    v_filter_clean := lower(trim(p_filter_sql));
    IF v_filter_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain data modification statements';
    END IF;
    IF v_filter_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot access system tables';
    END IF;
    IF p_filter_sql ~ ';' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain semicolons';
    END IF;
    v_filter_clause := ' AND (' || p_filter_sql || ')';
  END IF;

  -- ── Count total rows (now dynamic to support filter interpolation) ────────
  -- Pre-Ω.3.3: SELECT COUNT(*) INTO v_total FROM data_rows WHERE table_id = p_table_id
  BEGIN
    EXECUTE format(
      'SELECT COUNT(*) FROM data_rows WHERE table_id = %L%s',
      p_table_id::TEXT, v_filter_clause
    ) INTO v_total;
  EXCEPTION WHEN OTHERS THEN
    IF p_filter_sql IS NOT NULL THEN
      RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'total_rows',  0,
      'passed_rows', 0,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  END IF;

  -- ── Fast path: one-shot SELECT across all rows ─────────────────────────────
  -- Existing swallow allows fallback to slow path when expression fails on
  -- some rows. With filter, we re-raise filter-specific errors (so the user
  -- sees "Partition filter SQL failed:" instead of silently slow-pathing).
  BEGIN
    EXECUTE format(
      'SELECT COUNT(*) FROM (SELECT (%s) FROM data_rows WHERE table_id = %L%s) _t',
      p_expression, p_table_id::TEXT, v_filter_clause
    ) INTO v_passed;

    RETURN jsonb_build_object(
      'total_rows',  v_total,
      'passed_rows', v_passed,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  EXCEPTION WHEN OTHERS THEN
    IF p_filter_sql IS NOT NULL THEN
      RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
    END IF;
    -- Heritage behavior: swallow + fall through to slow path
    NULL;
  END;

  -- ── Slow path: iterate rows, catch per-row exceptions ─────────────────────
  -- FOR rec IN SELECT becomes FOR rec IN EXECUTE format(...) so v_filter_clause
  -- can be interpolated. Outer BEGIN/EXCEPTION wraps the FOR-init to
  -- re-attribute filter errors. Per-row exception handling inside the loop
  -- (catching expression errors per-row) is unchanged.
  v_passed := 0;
  BEGIN
    FOR rec IN EXECUTE format(
      'SELECT id, row_number, row_data->>%L AS src_val'
      ' FROM data_rows WHERE table_id = %L%s ORDER BY row_number',
      p_source_field, p_table_id::TEXT, v_filter_clause
    )
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
  EXCEPTION WHEN OTHERS THEN
    IF p_filter_sql IS NOT NULL THEN
      RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  RETURN jsonb_build_object(
    'total_rows',  v_total,
    'passed_rows', v_passed,
    'failed_rows', v_total - v_passed,
    'failures',    v_failures
  );
END;
$$;

COMMENT ON FUNCTION public.execute_transform_full_test(TEXT, UUID, TEXT, TEXT) IS
  'Full-table transform pass/fail aggregation. p_filter_sql (PR Ω.3.3; '
  'default NULL) AND''d into all 3 WHERE-clause sites when non-null. With '
  'filter, totalRows reflects filtered row count, not raw source row count.';

GRANT EXECUTE ON FUNCTION public.execute_transform_full_test(TEXT, UUID, TEXT, TEXT)
  TO authenticated, service_role;

-- ============================================================================
-- RPC 4 of 4 — execute_transform_test_distinct (multi-field primary, mig 035)
-- ============================================================================
-- The single-field wrapper at migration 035:100-127 is NOT updated. It has
-- zero callers; Postgres positional dispatch keeps its 4-arg call working
-- against the new 5-arg primary (p_filter_sql defaults to NULL).

DROP FUNCTION IF EXISTS public.execute_transform_test_distinct(UUID, TEXT[], TEXT, INT);

CREATE OR REPLACE FUNCTION public.execute_transform_test_distinct(
  p_table_id        UUID,
  p_source_fields   TEXT[],
  p_transform_sql   TEXT,
  p_limit           INT DEFAULT 200,
  p_filter_sql      TEXT DEFAULT NULL
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
  v_clean         TEXT;
  v_filter_clean  TEXT;
  v_filter_clause TEXT := '';
  v_jsonb_expr    TEXT;
  v_query         TEXT;
BEGIN
  v_clean := lower(trim(p_transform_sql));

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

  IF p_filter_sql IS NOT NULL THEN
    v_filter_clean := lower(trim(p_filter_sql));
    IF v_filter_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain data modification statements';
    END IF;
    IF v_filter_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot access system tables';
    END IF;
    IF p_filter_sql ~ ';' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain semicolons';
    END IF;
    v_filter_clause := ' AND (' || p_filter_sql || ')';
  END IF;

  -- Build jsonb_build_object for all source fields
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
     WHERE d.table_id = %L%s
     GROUP BY 1, 2
     ORDER BY occurrence_count DESC
     LIMIT %s',
    v_jsonb_expr,
    p_transform_sql,
    p_table_id,
    v_filter_clause,
    LEAST(COALESCE(p_limit, 200), 500)
  );

  BEGIN
    RETURN QUERY EXECUTE v_query;
  EXCEPTION WHEN OTHERS THEN
    IF p_filter_sql IS NOT NULL THEN
      RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
    ELSE
      -- Heritage behavior: surface the DB error as a single row so the
      -- caller (previewTransformDistinct) can render it in the UI.
      RETURN QUERY SELECT
        jsonb_build_object('_error', true)  AS before_values,
        SQLERRM                             AS after_value,
        0::BIGINT                           AS occurrence_count;
    END IF;
  END;
END;
$$;

COMMENT ON FUNCTION public.execute_transform_test_distinct(UUID, TEXT[], TEXT, INT, TEXT) IS
  'Distinct (before, after, count) groups for the Transform tab "All Distinct '
  'Values" preview. p_filter_sql (PR Ω.3.3; default NULL) AND''d into WHERE '
  'when non-null. Heritage behavior preserved on non-filter errors (error '
  'surfaced as a single row with _error: true).';

GRANT EXECUTE ON FUNCTION public.execute_transform_test_distinct(UUID, TEXT[], TEXT, INT, TEXT)
  TO authenticated, service_role;

COMMIT;
