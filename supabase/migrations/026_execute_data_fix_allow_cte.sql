-- ============================================================
-- Migration 026: Allow WITH (CTE) in execute_data_fix
-- ============================================================
-- The TypeScript validator already allowed CTEs; the DB RPC still
-- required ^(UPDATE|DELETE), so fixes like
--   WITH max_id AS (SELECT ...) UPDATE data_rows SET ...
-- failed at execution. Allow WITH when the main DML is UPDATE/DELETE
-- on data_rows after the CTE block (heuristic: ") UPDATE " / ") DELETE ").
-- ============================================================

CREATE OR REPLACE FUNCTION execute_data_fix(p_sql TEXT, p_table_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_affected INT;
  v_upper TEXT;
BEGIN
  v_upper := upper(trim(p_sql));

  IF v_upper ~ '^WITH' THEN
    IF NOT (p_sql ~* '\)\s+(UPDATE|DELETE)\s') THEN
      RAISE EXCEPTION 'CTE fix SQL must end with UPDATE or DELETE after the WITH clause';
    END IF;
  ELSIF NOT (v_upper ~ '^(UPDATE|DELETE)') THEN
    RAISE EXCEPTION 'Fix SQL must start with UPDATE or DELETE, got: %', left(v_upper, 20);
  END IF;

  IF position('data_rows' IN lower(p_sql)) = 0 THEN
    RAISE EXCEPTION 'Fix SQL must operate on the data_rows table only';
  END IF;

  IF position(p_table_id::TEXT IN p_sql) = 0 THEN
    RAISE EXCEPTION 'Fix SQL must include the specific table_id = ''%''', p_table_id;
  END IF;

  IF v_upper ~ '\y(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|COPY)\y' THEN
    RAISE EXCEPTION 'DDL/DCL statements are not allowed in fix SQL';
  END IF;

  IF lower(p_sql) ~ '(pg_catalog|pg_class|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Fix SQL cannot access system or auth tables';
  END IF;

  IF lower(p_sql) ~ '\b(projects|datasets|tables|fields|field_profiles|schema_documents|table_mappings|field_mappings|quality_issues|validation_rules|fix_history)\b' THEN
    RAISE EXCEPTION 'Fix SQL can only reference data_rows';
  END IF;

  EXECUTE p_sql;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;
