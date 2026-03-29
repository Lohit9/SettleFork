-- Migration 042: Fix date format severity — month-name dates are WARNING not BLOCKING
--
-- Problem: dq_invalid_date_string_count only excludes ISO and simple MM/DD/YYYY formats.
-- Dates like "Mar 15, 2024" or "15 March 2024" fall through and get flagged as
-- BLOCKING "invalid date strings", even though they're perfectly parseable.
--
-- Fix:
-- 1. Update dq_invalid_date_string_count to also exclude month-name formats.
--    Now only truly unparseable values (random text, "N/A", etc.) are BLOCKING.
-- 2. Add dq_non_iso_date_count to count ALL non-ISO but parseable date patterns.
--    This replaces the stale format_issues_count from field_profiles for the WARNING issue.

-- ── 1. Replace dq_invalid_date_string_count ──────────────────────────────────
-- Only flags values that contain NO recognisable date structure at all.
CREATE OR REPLACE FUNCTION dq_invalid_date_string_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    -- Exclude ISO 8601: YYYY-MM-DD (with optional time component)
    AND row_data->>p_field_name !~ '^\d{4}-\d{2}-\d{2}'
    -- Exclude numeric slash/dash/dot: MM/DD/YYYY, DD-MM-YYYY, MM/DD/YY, etc.
    AND row_data->>p_field_name !~ '^\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}'
    -- Exclude YYYY/MM/DD and YYYY.MM.DD
    AND row_data->>p_field_name !~ '^\d{4}[/\.]\d{1,2}[/\.]\d{1,2}'
    -- Exclude any value containing a month name abbreviation or full name
    -- (word-boundary match, case-insensitive via ~*)
    AND row_data->>p_field_name !~* '\y(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\y'
    AND row_data->>p_field_name !~* '\y(january|february|march|april|june|july|august|september|october|november|december)\y'
$$;

-- ── 2. Add dq_non_iso_date_count ─────────────────────────────────────────────
-- Counts ALL non-ISO but parseable date patterns (for WARNING severity).
-- This is the complement of the above: values that are recognisable dates but
-- not in ISO 8601 (YYYY-MM-DD) format.
CREATE OR REPLACE FUNCTION dq_non_iso_date_count(p_table_id UUID, p_field_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field_name IS NOT NULL
    AND TRIM(row_data->>p_field_name) != ''
    -- Not ISO 8601 (these are fine, no issue)
    AND row_data->>p_field_name !~ '^\d{4}-\d{2}-\d{2}'
    -- But IS one of the parseable non-standard formats:
    AND (
      -- Numeric slash/dash/dot: MM/DD/YYYY, DD-MM-YYYY, MM/DD/YY, etc.
      row_data->>p_field_name ~ '^\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}'
      -- YYYY/MM/DD or YYYY.MM.DD
      OR row_data->>p_field_name ~ '^\d{4}[/\.]\d{1,2}[/\.]\d{1,2}'
      -- Month name abbreviation (Jan, Feb, Mar, ...) — word boundary, case-insensitive
      OR row_data->>p_field_name ~* '\y(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\y'
      -- Full month names
      OR row_data->>p_field_name ~* '\y(january|february|march|april|june|july|august|september|october|november|december)\y'
    )
$$;
