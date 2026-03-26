-- Count staged rows that have at least one entry in row_issues (for preview banner).
CREATE OR REPLACE FUNCTION count_staged_rows_with_issues(p_table_mapping_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM staged_data_rows
  WHERE table_mapping_id = p_table_mapping_id
    AND jsonb_array_length(COALESCE(row_issues, '[]'::jsonb)) > 0;
$$;

GRANT EXECUTE ON FUNCTION count_staged_rows_with_issues(UUID) TO authenticated, service_role;
