-- ============================================================
-- Migration 066: Staged-data sample RPC for quality issue affected rows
-- Adds dq_staged_field_issue_samples — the staged_data_rows
-- counterpart to dq_field_issue_samples (migration 055).
--
-- Background: in-flight quality issues (stage='in_flight') are
-- detected against transformed staged values. Their stored
-- table_id points at the TARGET table, whose data_rows is empty
-- (target tables are schema-only). Looking up affected rows via
-- dq_field_issue_samples (which queries data_rows) therefore
-- returns zero. This RPC mirrors that function but queries
-- staged_data_rows keyed by table_mapping_id, using
-- transformed_row_data (the post-transform payload indexed by
-- target field name — matching the stored issue.field_id).
--
-- The condition keys (p_condition) match dq_field_issue_samples
-- and are produced by mapIssueKindToCondition() in the TS layer.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dq_staged_field_issue_samples(
  p_table_mapping_id UUID,
  p_field_name       TEXT,
  p_condition        TEXT,
  p_limit            INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '30s'
AS $func$
DECLARE
  v_result JSONB;
BEGIN
  CASE p_condition

    WHEN 'null' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND (s.transformed_row_data->>%L IS NULL
                  OR TRIM(COALESCE(s.transformed_row_data->>%L, '''')) = '''')
           LIMIT $2
         ) sub',
        p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'type_integer' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L !~ ''^-?[0-9]+$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'type_numeric' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L !~ ''^-?[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'format_email' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L !~ ''^[^@\s]+@[^@\s]+\.[^@\s]+$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'format_phone' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L ~ ''[^0-9+()\- .]''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'format_currency' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L ~ ''[$,]''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'negative_value' THEN
      -- Mirror dq_negative_numeric_count: strip $, commas, spaces, then check < 0
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND (
               CASE
                 WHEN REPLACE(REPLACE(REPLACE(s.transformed_row_data->>%L, ''$'', ''''), '','', ''''), '' '', '''')
                      ~ ''^-?[0-9]+\.?[0-9]*$''
                 THEN REPLACE(REPLACE(REPLACE(s.transformed_row_data->>%L, ''$'', ''''), '','', ''''), '' '', '''')::NUMERIC < 0
                 ELSE false
               END
             )
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'non_iso_date' THEN
      -- Mirrors dq_non_iso_date_count: not ISO but matches a parseable format
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L !~ ''^\d{4}-\d{2}-\d{2}''
             AND (
               s.transformed_row_data->>%L ~ ''^\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}''
               OR s.transformed_row_data->>%L ~ ''^\d{4}[/\.]\d{1,2}[/\.]\d{1,2}''
               OR s.transformed_row_data->>%L ~* ''\y(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\y''
               OR s.transformed_row_data->>%L ~* ''\y(january|february|march|april|june|july|august|september|october|november|december)\y''
             )
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name,
        p_field_name, p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    WHEN 'invalid_date' THEN
      -- Mirrors dq_invalid_date_string_count: not ISO and not parseable
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
             AND s.transformed_row_data->>%L !~ ''^\d{4}-\d{2}-\d{2}''
             AND s.transformed_row_data->>%L !~ ''^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

    ELSE
      -- Fallback: return any non-null, non-empty rows for the field
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.transformed_row_data), ''[]''::jsonb)
         FROM (
           SELECT s.transformed_row_data FROM staged_data_rows s
           WHERE s.table_mapping_id = $1
             AND s.transformed_row_data->>%L IS NOT NULL
             AND TRIM(s.transformed_row_data->>%L) <> ''''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name
      ) INTO v_result USING p_table_mapping_id, p_limit;

  END CASE;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$func$;

GRANT EXECUTE ON FUNCTION public.dq_staged_field_issue_samples(UUID, TEXT, TEXT, INT)
  TO authenticated, service_role;
