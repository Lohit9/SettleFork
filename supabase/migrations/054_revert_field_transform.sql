-- Removes a single target field's key from transformed_row_data on all staged rows
-- for a given table mapping. Uses PostgreSQL's jsonb - text operator.
-- Returns the number of rows updated.

CREATE OR REPLACE FUNCTION public.revert_field_transform(
  p_table_mapping_id UUID,
  p_target_field_name TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Safety: field name must be a plain identifier (no injection vector)
  IF p_target_field_name !~ '^[A-Za-z_][A-Za-z0-9_ ]*$' THEN
    RAISE EXCEPTION 'Invalid target field name: %', p_target_field_name;
  END IF;

  UPDATE public.staged_data_rows
  SET transformed_row_data = transformed_row_data - p_target_field_name
  WHERE table_mapping_id = p_table_mapping_id
    AND transformed_row_data ? p_target_field_name;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revert_field_transform(UUID, TEXT)
  TO authenticated, service_role;
