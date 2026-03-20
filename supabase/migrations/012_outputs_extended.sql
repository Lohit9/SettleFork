-- ============================================================
-- Phase 7: Outputs — extended output types + gold standard RPC
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Extend outputs.type CHECK to include gold standard & new deliverable types
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'outputs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%type%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outputs DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

ALTER TABLE outputs ADD CONSTRAINT outputs_type_check
  CHECK (type IN (
    'mapping_file',
    'transformation_specs',
    'readiness_report',
    'gold_standard_csv',
    'gold_standard_sql',
    'fix_log',
    'data_dictionary'
  ));

-- 2. Gold Standard query execution RPC
--    SECURITY DEFINER so it can read data_rows regardless of the caller's JWT.
--    Ownership is enforced in the calling Server Action (project ownership check).
CREATE OR REPLACE FUNCTION execute_gold_standard_query(p_sql TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
SET work_mem = '32MB'
AS $$
DECLARE
  result JSONB;
BEGIN
  -- Only SELECT allowed
  IF NOT (lower(trim(p_sql)) LIKE 'select%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Block dangerous DML/DDL keywords
  IF lower(p_sql) ~ '\m(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\M' THEN
    RAISE EXCEPTION 'Query contains forbidden keywords';
  END IF;

  -- Block system catalog access
  IF lower(p_sql) ~ '\m(pg_catalog|information_schema|pg_roles|pg_shadow|pg_authid|auth\.users)\M' THEN
    RAISE EXCEPTION 'System catalog access is not allowed';
  END IF;

  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || p_sql || ') t' INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION execute_gold_standard_query(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_gold_standard_query(TEXT) TO service_role;

-- 3. Index for fetching outputs by project + type (used heavily in version tracking)
CREATE INDEX IF NOT EXISTS idx_outputs_project_type ON outputs(project_id, type, generated_at DESC);
