-- ============================================================
-- Migration 030: Safe numeric comparison RPCs
--
-- Replaces dq_below_min_count and dq_above_max_count with
-- versions that strip common currency/formatting characters
-- ($, commas, spaces) and validate the regex before casting.
--
-- Previously, a single non-numeric value like "$50,000" or "N/A"
-- in any row caused (row_data->>p_field)::numeric to throw an
-- exception, which bubbled up through executeCustomRules and
-- caused runFullScan to silently skip all custom rules for that
-- table. Non-castable values are now excluded from the count
-- (they are a different kind of issue — format violations) so
-- the numeric comparison rule can still evaluate the valid rows.
-- ============================================================

CREATE OR REPLACE FUNCTION dq_below_min_count(p_table_id UUID, p_field TEXT, p_min NUMERIC)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    -- Strip common numeric formatting before checking/casting
    AND REPLACE(REPLACE(REPLACE(trim(row_data->>p_field), '$', ''), ',', ''), ' ', '')
        ~ '^-?[0-9]+\.?[0-9]*$'
    AND REPLACE(REPLACE(REPLACE(trim(row_data->>p_field), '$', ''), ',', ''), ' ', '')::numeric
        < p_min
$$;

CREATE OR REPLACE FUNCTION dq_above_max_count(p_table_id UUID, p_field TEXT, p_max NUMERIC)
RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM data_rows
  WHERE table_id = p_table_id
    AND row_data->>p_field IS NOT NULL
    AND trim(row_data->>p_field) != ''
    -- Strip common numeric formatting before checking/casting
    AND REPLACE(REPLACE(REPLACE(trim(row_data->>p_field), '$', ''), ',', ''), ' ', '')
        ~ '^-?[0-9]+\.?[0-9]*$'
    AND REPLACE(REPLACE(REPLACE(trim(row_data->>p_field), '$', ''), ',', ''), ' ', '')::numeric
        > p_max
$$;
