-- ============================================================
-- Migration 022: Additional Quality Check RPCs + detection_type
-- ============================================================

-- Add detection_type column to quality_issues
ALTER TABLE quality_issues ADD COLUMN IF NOT EXISTS detection_type TEXT DEFAULT 'auto'
  CHECK (detection_type IN ('auto', 'custom_rule', 'ai_augmented', 'manual'));

-- Migrate existing rows: detection_source = 'custom_rule' → detection_type = 'custom_rule'
UPDATE quality_issues SET detection_type = 'custom_rule' WHERE detection_source = 'custom_rule';

-- ── New RPC helpers ────────────────────────────────────────────────────────────

-- Count values that are not a recognisable date pattern at all
CREATE OR REPLACE FUNCTION dq_invalid_date_string_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    AND row_data->>p_field_name !~ '^\d{4}-\d{2}-\d{2}'
    AND row_data->>p_field_name !~ '^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$'
$$;

-- Count values that contain $ or comma (currency-formatted strings)
CREATE OR REPLACE FUNCTION dq_currency_format_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    AND row_data->>p_field_name ~ '[$,]'
$$;

-- Count values that are valid numerics but negative (after stripping $, commas, spaces)
CREATE OR REPLACE FUNCTION dq_negative_numeric_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    AND (
      CASE
        WHEN REPLACE(REPLACE(REPLACE(row_data->>p_field_name, '$', ''), ',', ''), ' ', '')
             ~ '^-?[0-9]+\.?[0-9]*$'
        THEN REPLACE(REPLACE(REPLACE(row_data->>p_field_name, '$', ''), ',', ''), ' ', '')::NUMERIC < 0
        ELSE false
      END
    )
$$;

-- Count values that are fully lowercase or fully uppercase (inconsistent capitalisation)
-- Excludes single-character values to avoid flagging codes like "Y" / "N"
CREATE OR REPLACE FUNCTION dq_inconsistent_caps_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    AND LENGTH(TRIM(row_data->>p_field_name)) > 1
    AND (
      row_data->>p_field_name = LOWER(row_data->>p_field_name)
      OR row_data->>p_field_name = UPPER(row_data->>p_field_name)
    )
$$;

-- Count values not equal to the canonical TRUE/FALSE strings
CREATE OR REPLACE FUNCTION dq_non_standard_boolean_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    AND LOWER(TRIM(row_data->>p_field_name)) NOT IN ('true', 'false')
$$;
