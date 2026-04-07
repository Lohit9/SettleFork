-- ── Root cause columns on quality_issues ─────────────────────────────────────

ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS root_cause_breakdown JSONB;

COMMENT ON COLUMN quality_issues.root_cause IS
  'Human-readable root cause: source_data, transform_error, missing_transform, mapping_issue';

COMMENT ON COLUMN quality_issues.root_cause_breakdown IS
  'Breakdown: { source_data: N, transform_error: N, missing_transform: N }';

-- ── dq_custom_rule_staged ─────────────────────────────────────────────────────
-- Evaluates a simple validation rule against staged_data_rows, using
-- COALESCE(transformed_row_data, source_row_data) as the effective value.

CREATE OR REPLACE FUNCTION public.dq_custom_rule_staged(
  p_table_mapping_id UUID,
  p_field_name       TEXT,
  p_operator         TEXT,
  p_value            TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '30s'
AS $$
DECLARE
  v_count INTEGER;
  v_val   TEXT;
  v_sql   TEXT;
BEGIN
  -- Effective value expression: prefer transformed, fall back to source
  v_val := format(
    'COALESCE(NULLIF(TRIM(transformed_row_data->>%1$L),''''), TRIM(source_row_data->>%1$L))',
    p_field_name
  );

  v_sql := 'SELECT COUNT(*) FROM staged_data_rows WHERE table_mapping_id = $1 AND ';

  CASE p_operator
    WHEN 'is_null' THEN
      v_sql := v_sql || format(
        '(%s IS NULL OR TRIM(COALESCE(transformed_row_data->>%L, source_row_data->>%L, '''')) = '''')',
        v_val, p_field_name, p_field_name
      );

    WHEN 'is_not_null' THEN
      v_sql := v_sql || format(
        '(%s IS NOT NULL AND TRIM(%s) != '''')',
        v_val, v_val
      );

    WHEN 'equals' THEN
      v_sql := v_sql || format('%s = %L', v_val, p_value);

    WHEN 'not_equals' THEN
      v_sql := v_sql || format('%s != %L', v_val, p_value);

    WHEN 'contains' THEN
      v_sql := v_sql || format('%s ILIKE ''%%'' || %L || ''%%''', v_val, p_value);

    WHEN 'greater_than' THEN
      v_sql := v_sql || format('(%s)::numeric > (%L)::numeric', v_val, p_value);

    WHEN 'less_than' THEN
      v_sql := v_sql || format('(%s)::numeric < (%L)::numeric', v_val, p_value);

    WHEN 'matches_regex' THEN
      -- rows that DO match the pattern (for counting "compliant" rows — rarely needed)
      v_sql := v_sql || format('%s ~ %L', v_val, p_value);

    WHEN 'not_matches_regex' THEN
      -- rows that DON'T match the pattern (violation for "must match" rules)
      v_sql := v_sql || format('NOT (%s ~ %L)', v_val, p_value);

    WHEN 'below_min_length' THEN
      v_sql := v_sql || format('LENGTH(%s) < (%L)::integer', v_val, p_value);

    WHEN 'above_max_length' THEN
      v_sql := v_sql || format('LENGTH(%s) > (%L)::integer', v_val, p_value);

    ELSE
      RETURN 0;
  END CASE;

  EXECUTE v_sql INTO v_count USING p_table_mapping_id;
  RETURN COALESCE(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.dq_custom_rule_staged(UUID, TEXT, TEXT, TEXT) TO authenticated;
