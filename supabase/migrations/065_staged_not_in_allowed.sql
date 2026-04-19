-- Migration 065: Staged-data support for allowed_values / CHECK-list rules.
--
-- Background: DDL CHECK constraints like
--   CHECK (category IN ('DEPOSIT','LOAN','CERTIFICATE'))
-- are auto-seeded into validation_rules as rule_type='allowed_values' and
-- attached to the TARGET field (see lib/actions/ddl-upload.ts lines 264-278),
-- because the DDL defines the target schema.
--
-- Until now, executeCustomRules() (lib/actions/validation-rules.ts) only
-- evaluated allowed_values against source data via dq_not_in_allowed_count,
-- and was gated on datasetRole === 'source'. Target-attached rules therefore
-- silently never fired — case-sensitive violations like "Deposit" vs
-- "DEPOSIT" were never flagged because the code path was dead for targets.
--
-- This migration extends dq_custom_rule_staged (added in migration 056) with
-- a 'not_in_list' operator so the TS layer can evaluate allowed_values rules
-- against staged_data_rows (transformed_row_data, with source_row_data
-- fallback). The allowed set is passed as a JSON-array-text in p_value, e.g.
--   '["DEPOSIT","LOAN","CERTIFICATE"]'
-- This fits the existing (UUID, TEXT, TEXT, TEXT) signature used by the
-- stagedCount() helper — no RPC signature change, no new function.
--
-- Violation semantics match the source-side RPC dq_not_in_allowed_count
-- (migration 006, lines 280-288):
--   - NULL and empty/whitespace-only values are NOT violations
--   - comparison is case-sensitive (= ANY text[])

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

    WHEN 'not_in_list' THEN
      -- p_value is a JSON array of allowed values, e.g. '["DEPOSIT","LOAN"]'.
      -- Violation = effective value is non-null, non-empty, and not a member
      -- of the allowed set. Case-sensitive by design, matching source-side
      -- dq_not_in_allowed_count (migration 006, lines 280-288) — if the user
      -- wants case-insensitive matching they should add a normalization
      -- transform (UPPER/LOWER) or relax the rule_config values themselves.
      v_sql := v_sql || format(
        '(%1$s) IS NOT NULL AND (%1$s) <> '''' AND NOT ((%1$s) = ANY(ARRAY(SELECT jsonb_array_elements_text((%2$L)::jsonb))))',
        v_val, p_value
      );

    ELSE
      RETURN 0;
  END CASE;

  EXECUTE v_sql INTO v_count USING p_table_mapping_id;
  RETURN COALESCE(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.dq_custom_rule_staged(UUID, TEXT, TEXT, TEXT) TO authenticated;
