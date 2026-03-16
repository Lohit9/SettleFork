-- Read-only query execution RPC function
-- ⚠️  Run this in the Supabase SQL Editor manually.
-- This function validates and executes SELECT-only queries against data_rows.

CREATE OR REPLACE FUNCTION execute_readonly_query(
  p_query TEXT,
  p_table_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '10s'
SET work_mem = '8MB'
AS $$
DECLARE
  result JSONB;
  clean_query TEXT;
BEGIN
  clean_query := lower(trim(p_query));

  -- BLOCK: anything that isn't a SELECT
  IF NOT (clean_query LIKE 'select%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- BLOCK: DDL and DML keywords
  IF clean_query ~ '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\s' THEN
    RAISE EXCEPTION 'Query contains forbidden keywords';
  END IF;

  -- BLOCK: transaction control
  IF clean_query ~ '\b(begin|commit|rollback|savepoint)\s' THEN
    RAISE EXCEPTION 'Transaction control not allowed';
  END IF;

  -- BLOCK: system catalog access
  IF clean_query ~ '(pg_catalog|information_schema|pg_roles|pg_shadow|pg_authid|auth\.)' THEN
    RAISE EXCEPTION 'System catalog access not allowed';
  END IF;

  -- BLOCK: multiple statements
  IF (SELECT count(*) FROM regexp_matches(p_query, ';', 'g')) > 1 THEN
    RAISE EXCEPTION 'Multiple statements not allowed';
  END IF;

  -- Execute with row limit for safety
  EXECUTE format(
    'SELECT jsonb_agg(t) FROM (SELECT * FROM (%s) sub LIMIT 1000) t',
    rtrim(p_query, ';')
  ) INTO result;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;
