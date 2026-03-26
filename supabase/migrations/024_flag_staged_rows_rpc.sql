-- ============================================================
-- Migration 024: issue_kind column + flag_staged_rows_for_issue RPC
-- ============================================================
-- Adds a machine-readable issue_kind to quality_issues so the flagging
-- RPC can determine which SQL condition to apply without parsing description text.
-- The flag_staged_rows_for_issue function updates row_issues on staged_data_rows
-- for every source-data quality issue that exists for a given table mapping.
-- ============================================================

-- Add issue_kind to quality_issues
ALTER TABLE quality_issues
  ADD COLUMN IF NOT EXISTS issue_kind TEXT;

-- ── RPC: flag_staged_rows_for_issue ───────────────────────────────────────────
-- Appends an issue JSONB object to the row_issues array of every staged row
-- whose source_row_data satisfies the condition implied by p_issue_kind.
--
-- Parameters:
--   p_table_mapping_id  — the staged table mapping to update
--   p_source_field_name — the source CSV field name to inspect in source_row_data
--   p_issue_kind        — machine-readable issue type (see CASE branches below)
--   p_issue             — JSONB object describing the issue (appended to row_issues)
--   p_source_table_id   — required for duplicate_pk (looks up data_rows)
--   p_ref_table_id      — required for orphaned_fk (parent table id)
--   p_ref_field_name    — required for orphaned_fk (parent field name)
--
-- Returns: number of staged rows flagged (may overlap across issue calls).

CREATE OR REPLACE FUNCTION flag_staged_rows_for_issue(
  p_table_mapping_id  UUID,
  p_source_field_name TEXT,
  p_issue_kind        TEXT,
  p_issue             JSONB,
  p_source_table_id   UUID DEFAULT NULL,
  p_ref_table_id      UUID DEFAULT NULL,
  p_ref_field_name    TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_affected INTEGER := 0;
BEGIN
  -- Basic sanity check — field names in this system follow identifier rules
  IF p_source_field_name IS NULL OR length(trim(p_source_field_name)) = 0 THEN
    RAISE EXCEPTION 'p_source_field_name cannot be empty';
  END IF;

  CASE p_issue_kind

    -- ── Null values in PK / required / heavily-null nullable fields ───────────
    WHEN 'null_pk', 'null_required', 'high_null_rate' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND (
             source_row_data->>%L IS NULL
             OR TRIM(COALESCE(source_row_data->>%L, '''')) = ''''
           )',
        p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Duplicate values in a PK field ────────────────────────────────────────
    WHEN 'duplicate_pk' THEN
      IF p_source_table_id IS NULL THEN RETURN 0; END IF;
      EXECUTE format(
        'UPDATE staged_data_rows s
         SET row_issues = COALESCE(s.row_issues, ''[]''::jsonb) || $1
         WHERE s.table_mapping_id = $2
           AND s.source_row_data->>%L IS NOT NULL
           AND s.source_row_data->>%L IN (
             SELECT dr.row_data->>%L
             FROM data_rows dr
             WHERE dr.table_id = $3
             GROUP BY dr.row_data->>%L
             HAVING COUNT(*) > 1
           )',
        p_source_field_name, p_source_field_name,
        p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id, p_source_table_id;

    -- ── Invalid date strings (unrecognisable format, blocking) ────────────────
    WHEN 'invalid_date_string' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L !~ ''^\d{4}-\d{2}-\d{2}''
           AND source_row_data->>%L !~ ''^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$''',
        p_source_field_name, p_source_field_name,
        p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Non-ISO date strings (parseable but wrong format, warning) ────────────
    WHEN 'non_iso_date' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L !~ ''^\d{4}-\d{2}-\d{2}''
           AND (
             source_row_data->>%L ~ ''^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$''
             OR source_row_data->>%L ~ ''^\d{1,2}\s+\w+\s+\d{2,4}$''
           )',
        p_source_field_name, p_source_field_name, p_source_field_name,
        p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Currency-formatted strings ($ signs, commas) ──────────────────────────
    WHEN 'currency_format' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L ~ ''[$,]''',
        p_source_field_name, p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Negative values in revenue/amount fields ──────────────────────────────
    WHEN 'negative_value' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND (
             CASE
               WHEN REPLACE(REPLACE(REPLACE(source_row_data->>%L, ''$'', ''''), '','', ''''), '' '', '''')
                    ~ ''^-?[0-9]+\.?[0-9]*$''
               THEN REPLACE(REPLACE(REPLACE(source_row_data->>%L, ''$'', ''''), '','', ''''), '' '', '''')::NUMERIC < 0
               ELSE false
             END
           )',
        p_source_field_name, p_source_field_name,
        p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Invalid email format ───────────────────────────────────────────────────
    WHEN 'email_format' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L !~ ''^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$''',
        p_source_field_name, p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Invalid phone format ───────────────────────────────────────────────────
    WHEN 'phone_format' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L !~ ''^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$''',
        p_source_field_name, p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Type mismatches: integer ───────────────────────────────────────────────
    WHEN 'type_mismatch_integer' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L !~ ''^-?[0-9]+$''',
        p_source_field_name, p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Type mismatches: numeric/decimal ──────────────────────────────────────
    WHEN 'type_mismatch_numeric' THEN
      EXECUTE format(
        'UPDATE staged_data_rows
         SET row_issues = COALESCE(row_issues, ''[]''::jsonb) || $1
         WHERE table_mapping_id = $2
           AND source_row_data->>%L IS NOT NULL
           AND TRIM(source_row_data->>%L) <> ''''
           AND source_row_data->>%L !~ ''^-?[0-9]+\.?[0-9]*$''',
        p_source_field_name, p_source_field_name, p_source_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id;

    -- ── Orphaned foreign key (value absent in parent table) ───────────────────
    WHEN 'orphaned_fk' THEN
      IF p_ref_table_id IS NULL OR p_ref_field_name IS NULL THEN RETURN 0; END IF;
      EXECUTE format(
        'UPDATE staged_data_rows s
         SET row_issues = COALESCE(s.row_issues, ''[]''::jsonb) || $1
         WHERE s.table_mapping_id = $2
           AND s.source_row_data->>%L IS NOT NULL
           AND TRIM(s.source_row_data->>%L) <> ''''
           AND s.source_row_data->>%L NOT IN (
             SELECT dr.row_data->>%L
             FROM data_rows dr
             WHERE dr.table_id = $3
               AND dr.row_data->>%L IS NOT NULL
           )',
        p_source_field_name, p_source_field_name, p_source_field_name,
        p_ref_field_name, p_ref_field_name
      ) USING jsonb_build_array(p_issue), p_table_mapping_id, p_ref_table_id;

    ELSE
      -- Unknown issue kind — skip silently
      RETURN 0;

  END CASE;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;

GRANT EXECUTE ON FUNCTION flag_staged_rows_for_issue(UUID, TEXT, TEXT, JSONB, UUID, UUID, TEXT)
  TO authenticated, service_role;

-- ── Back-fill issue_kind for any existing quality_issues ─────────────────────
-- Uses description keyword matching to infer the kind for pre-existing rows.
UPDATE quality_issues SET issue_kind = CASE
  WHEN description ILIKE '%null%' AND description ILIKE '%primary key%' AND description NOT ILIKE '%duplicate%'
    THEN 'null_pk'
  WHEN description ILIKE '%null%' AND description ILIKE '%non-nullable%'
    THEN 'null_required'
  WHEN description ILIKE '%duplicate%' AND description ILIKE '%primary key%'
    THEN 'duplicate_pk'
  WHEN description ILIKE '%invalid date strings%' OR description ILIKE '%not recognisable as any date%'
    THEN 'invalid_date_string'
  WHEN description ILIKE '%non-iso date%'
    THEN 'non_iso_date'
  WHEN description ILIKE '%currency formatting%'
    THEN 'currency_format'
  WHEN description ILIKE '%negative values%'
    THEN 'negative_value'
  WHEN description ILIKE '%invalid email%'
    THEN 'email_format'
  WHEN description ILIKE '%invalid phone%'
    THEN 'phone_format'
  WHEN description ILIKE '%not valid integers%'
    THEN 'type_mismatch_integer'
  WHEN description ILIKE '%not valid numbers%'
    THEN 'type_mismatch_numeric'
  WHEN description ILIKE '%referential integrity%' OR description ILIKE '%orphaned%'
    THEN 'orphaned_fk'
  WHEN description ILIKE '%high null rate%'
    THEN 'high_null_rate'
  ELSE NULL
END
WHERE issue_kind IS NULL AND stage = 'source';
