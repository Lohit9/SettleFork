-- ============================================================
-- Migration 055: Sample RPCs for quality issue affected rows
-- Adds dq_orphaned_fk_samples and dq_field_issue_samples RPCs
-- to support "View affected rows" in the Validate tab.
-- ============================================================

-- ── dq_orphaned_fk_samples ───────────────────────────────────────────────────
-- Returns up to p_limit rows from p_table_id where the value in p_field_name
-- has no matching value in p_ref_table_id.p_ref_field_name (orphaned FK rows).
CREATE OR REPLACE FUNCTION public.dq_orphaned_fk_samples(
  p_table_id      UUID,
  p_field_name    TEXT,
  p_ref_table_id  UUID,
  p_ref_field_name TEXT,
  p_limit         INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET statement_timeout = '30s'
AS $$
  SELECT COALESCE(
    jsonb_agg(sub.row_data),
    '[]'::jsonb
  )
  FROM (
    SELECT d.row_data
    FROM data_rows d
    WHERE d.table_id = p_table_id
      AND d.row_data->>p_field_name IS NOT NULL
      AND TRIM(d.row_data->>p_field_name) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM data_rows ref
        WHERE ref.table_id = p_ref_table_id
          AND ref.row_data->>p_ref_field_name = d.row_data->>p_field_name
      )
    LIMIT p_limit
  ) sub
$$;

-- ── dq_field_issue_samples ────────────────────────────────────────────────────
-- Generic sample fetcher for field-level data quality issues.
-- p_condition controls which rows are returned — must match exactly the
-- conditions used by the corresponding dq_*_count RPC.
--
-- Supported conditions:
--   'null'           — null or empty values
--   'type_integer'   — values that are not valid integers
--   'type_numeric'   — values that are not valid decimals/floats
--   'format_email'   — values that do not match a basic email pattern
--   'format_phone'   — values containing non-phone characters
--   'format_currency'— values containing $ or , (currency-formatted)
--   'negative_value' — numeric values that are negative
--   'non_iso_date'   — non-ISO but parseable date values
--   'invalid_date'   — values that are not recognisable as any date
CREATE OR REPLACE FUNCTION public.dq_field_issue_samples(
  p_table_id  UUID,
  p_field_name TEXT,
  p_condition  TEXT,
  p_limit      INT DEFAULT 5
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
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND (d.row_data->>%L IS NULL OR TRIM(COALESCE(d.row_data->>%L, '''')) = '''')
           LIMIT $2
         ) sub',
        p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'type_integer' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L !~ ''^-?[0-9]+$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'type_numeric' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L !~ ''^-?[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'format_email' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L !~ ''^[^@\s]+@[^@\s]+\.[^@\s]+$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'format_phone' THEN
      -- Invalid phone = has characters other than digits, +, -, (, ), space, dot
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L ~ ''[^0-9+()\- .]''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'format_currency' THEN
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L ~ ''[$,]''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'negative_value' THEN
      -- Mirror dq_negative_numeric_count: strip $, commas, spaces, then check < 0
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND (
               CASE
                 WHEN REPLACE(REPLACE(REPLACE(d.row_data->>%L, ''$'', ''''), '','', ''''), '' '', '''')
                      ~ ''^-?[0-9]+\.?[0-9]*$''
                 THEN REPLACE(REPLACE(REPLACE(d.row_data->>%L, ''$'', ''''), '','', ''''), '' '', '''')::NUMERIC < 0
                 ELSE false
               END
             )
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'non_iso_date' THEN
      -- Mirrors dq_non_iso_date_count: not ISO but matches a parseable format
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L !~ ''^\d{4}-\d{2}-\d{2}''
             AND (
               d.row_data->>%L ~ ''^\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}''
               OR d.row_data->>%L ~ ''^\d{4}[/\.]\d{1,2}[/\.]\d{1,2}''
               OR d.row_data->>%L ~* ''\y(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\y''
               OR d.row_data->>%L ~* ''\y(january|february|march|april|june|july|august|september|october|november|december)\y''
             )
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name,
        p_field_name, p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    WHEN 'invalid_date' THEN
      -- Mirrors dq_invalid_date_string_count: not ISO and not parseable
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
             AND d.row_data->>%L !~ ''^\d{4}-\d{2}-\d{2}''
             AND d.row_data->>%L !~ ''^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name, p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

    ELSE
      -- Fallback: return any non-null, non-empty rows for the field
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(sub.row_data), ''[]''::jsonb)
         FROM (
           SELECT d.row_data FROM data_rows d
           WHERE d.table_id = $1
             AND d.row_data->>%L IS NOT NULL
             AND TRIM(d.row_data->>%L) <> ''''
           LIMIT $2
         ) sub',
        p_field_name, p_field_name
      ) INTO v_result USING p_table_id, p_limit;

  END CASE;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$func$;
