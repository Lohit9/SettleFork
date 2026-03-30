-- ============================================================
-- Migration 044: Staged FK Referential Integrity RPCs
-- Counts and samples rows in staged_data_rows whose FK value
-- is not present in the parent table's staged rows.
-- ============================================================

-- Count orphaned FK values in staged child rows vs staged parent rows
CREATE OR REPLACE FUNCTION dq_staged_orphaned_fk_count(
  p_child_mapping_id  UUID,
  p_child_field       TEXT,
  p_parent_mapping_id UUID,
  p_parent_field      TEXT
)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)
  FROM staged_data_rows child
  WHERE child.table_mapping_id = p_child_mapping_id
    AND child.transformed_row_data->>p_child_field IS NOT NULL
    AND TRIM(child.transformed_row_data->>p_child_field) != ''
    AND TRIM(child.transformed_row_data->>p_child_field) NOT IN (
      SELECT TRIM(parent.transformed_row_data->>p_parent_field)
      FROM staged_data_rows parent
      WHERE parent.table_mapping_id = p_parent_mapping_id
        AND parent.transformed_row_data->>p_parent_field IS NOT NULL
        AND TRIM(parent.transformed_row_data->>p_parent_field) != ''
    )
$$;

-- Return sample orphaned rows (full transformed_row_data) for fix suggestions
CREATE OR REPLACE FUNCTION dq_staged_orphaned_fk_samples(
  p_child_mapping_id  UUID,
  p_child_field       TEXT,
  p_parent_mapping_id UUID,
  p_parent_field      TEXT,
  p_limit             INT DEFAULT 5
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(jsonb_agg(child.transformed_row_data), '[]')
  FROM (
    SELECT child.transformed_row_data
    FROM staged_data_rows child
    WHERE child.table_mapping_id = p_child_mapping_id
      AND child.transformed_row_data->>p_child_field IS NOT NULL
      AND TRIM(child.transformed_row_data->>p_child_field) != ''
      AND TRIM(child.transformed_row_data->>p_child_field) NOT IN (
        SELECT TRIM(parent.transformed_row_data->>p_parent_field)
        FROM staged_data_rows parent
        WHERE parent.table_mapping_id = p_parent_mapping_id
          AND parent.transformed_row_data->>p_parent_field IS NOT NULL
          AND TRIM(parent.transformed_row_data->>p_parent_field) != ''
      )
    LIMIT p_limit
  ) child
$$;

GRANT EXECUTE ON FUNCTION dq_staged_orphaned_fk_count(UUID, TEXT, UUID, TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION dq_staged_orphaned_fk_samples(UUID, TEXT, UUID, TEXT, INT)
  TO authenticated, service_role;
