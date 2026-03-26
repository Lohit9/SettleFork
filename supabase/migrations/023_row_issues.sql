-- ============================================================
-- Row Issues: per-row problem tracking in staged_data_rows
-- Graceful staging: never crash on bad source data, flag it instead.
-- ============================================================

-- Add row_issues column (array of issue objects per row)
ALTER TABLE staged_data_rows
  ADD COLUMN IF NOT EXISTS row_issues JSONB DEFAULT '[]'::jsonb;

-- ── RPC: populate row_issues for a mapping after staging ─────────────────────
-- After staging a table mapping, call this to populate row_issues for rows
-- that have null values in non-nullable or PK target fields.
--
-- p_field_constraints: JSON array of:
--   { "target_field_name": "Id", "is_pk": true, "is_nullable": false }
--
-- Each issue entry in row_issues looks like:
--   { "field": "Id", "issue": "null_primary_key", "description": "..." }

CREATE OR REPLACE FUNCTION populate_row_issues_for_mapping(
  p_table_mapping_id   UUID,
  p_field_constraints  JSONB
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_count      INT;
  v_row        RECORD;
  v_issue_type TEXT;
  v_issue_desc TEXT;
BEGIN
  -- Reset issues for a fresh compute on each re-stage
  UPDATE staged_data_rows
  SET row_issues = '[]'::jsonb
  WHERE table_mapping_id = p_table_mapping_id;

  -- Walk each constrained field and append issues for rows with null values
  FOR v_row IN
    SELECT
      val->>'target_field_name'                             AS field_name,
      COALESCE((val->>'is_pk')::boolean,       false)       AS is_pk,
      COALESCE((val->>'is_nullable')::boolean, true)        AS is_nullable
    FROM jsonb_array_elements(p_field_constraints) AS t(val)
  LOOP
    -- Skip fully-nullable non-PK fields — they are allowed to be null
    CONTINUE WHEN v_row.is_nullable AND NOT v_row.is_pk;

    v_issue_type := CASE WHEN v_row.is_pk
      THEN 'null_primary_key'
      ELSE 'null_required_field'
    END;

    v_issue_desc := CASE WHEN v_row.is_pk
      THEN 'Source primary key is null — row will fail on target load'
      ELSE 'Required field is null — row may be rejected on target load'
    END;

    UPDATE staged_data_rows
    SET row_issues = row_issues || jsonb_build_array(
      jsonb_build_object(
        'field',       v_row.field_name,
        'issue',       v_issue_type,
        'description', v_issue_desc
      )
    )
    WHERE table_mapping_id = p_table_mapping_id
      AND (
        transformed_row_data->>v_row.field_name IS NULL
        OR transformed_row_data->>v_row.field_name = ''
      );
  END LOOP;

  -- Return count of flagged rows (useful for logging)
  SELECT COUNT(*) INTO v_count
  FROM staged_data_rows
  WHERE table_mapping_id = p_table_mapping_id
    AND jsonb_array_length(COALESCE(row_issues, '[]'::jsonb)) > 0;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION populate_row_issues_for_mapping(UUID, JSONB)
  TO authenticated, service_role;
