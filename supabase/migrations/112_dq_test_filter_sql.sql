-- ============================================================================
-- Migration 112 — PR Ω.3.1 — dq_test_filter_sql RPC (RUN-LIMIT-0 parse check)
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Adds `dq_test_filter_sql(p_source_table_id UUID, p_filter_sql TEXT)`,
--   a SECURITY DEFINER RPC that:
--     1. Verifies the caller is an editor on the project owning the source table
--     2. Applies the same DML / system-table / semicolon blocklist as the
--        apply-path RPCs (110)
--     3. Executes `SELECT 1 FROM data_rows WHERE table_id = $1 AND (<filter>)
--        LIMIT 0` — no rows returned, but the filter is parsed and column
--        references are resolved by Postgres
--     4. Returns `{"ok": true}` on success or `{"ok": false, "error": <SQLERRM>}`
--        on failure
--
--   Powers the "Test filter" affordance in PR Ω.3.2's PartitionRulesModal.
--   Verbose error messages preserved for pilot per design doc Q7 (decided
--   in user's Ω.3.1 instruction).
--
-- WHAT THIS MIGRATION DOES NOT DO
--   • Does not enforce filter wrapping — caller must pre-wrap the filter via
--     wrapFieldRefsInJsonb so column refs become `(row_data->>'X')`. The RPC
--     trusts that wrapping has happened. (The action wrapper at
--     lib/actions/partitions.ts:testFilterSql does the wrap.)
--   • Does not write anything. Pure read with LIMIT 0.
--   • Does not run dedup or apply logic — this is parse-only validation.
--
-- DEPLOY ORDER (hot-apply pattern — same as 111)
--   Apply via Supabase Dashboard. Code PR (lib/actions/partitions.ts) is
--   the only caller and ships in the same PR. RPC must exist before the
--   first call from prod code.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.dq_test_filter_sql(
  p_source_table_id UUID,
  p_filter_sql      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_project_id UUID;
  v_clean      TEXT;
BEGIN
  -- ── Resolve source_table → dataset → project for permission gate ──────────
  SELECT d.project_id
    INTO v_project_id
  FROM public.tables t
  JOIN public.datasets d ON d.id = t.dataset_id
  WHERE t.id = p_source_table_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'dq_test_filter_sql: source_table % not found', p_source_table_id;
  END IF;

  IF NOT public.user_has_project_role(v_project_id, 'editor') THEN
    RAISE EXCEPTION 'dq_test_filter_sql: permission denied for project %', v_project_id;
  END IF;

  -- ── Filter SQL must be non-empty ──────────────────────────────────────────
  IF p_filter_sql IS NULL OR length(trim(p_filter_sql)) = 0 THEN
    RAISE EXCEPTION 'dq_test_filter_sql: p_filter_sql cannot be empty';
  END IF;

  -- ── Safety gates (mirror migration 110's filter_sql guard) ────────────────
  v_clean := lower(trim(p_filter_sql));
  IF v_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
    RAISE EXCEPTION 'Filter SQL cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Filter SQL cannot access system tables';
  END IF;
  IF p_filter_sql ~ ';' THEN
    RAISE EXCEPTION 'Filter SQL cannot contain semicolons';
  END IF;

  -- ── RUN-LIMIT-0 parse + column-resolution check ───────────────────────────
  -- Postgres parses the entire query before execution begins. With LIMIT 0
  -- no rows are scanned but column references are still resolved against
  -- data_rows.row_data (jsonb). A bad filter (syntax error, unknown column,
  -- type mismatch on operator) surfaces here as SQLERRM.
  --
  -- Verbose SQLERRM is returned per design doc Q7 decision: pilot users need
  -- the detail to debug filter errors. Tighten to a generic message in a
  -- post-pilot follow-up if information-disclosure becomes a concern.
  BEGIN
    EXECUTE format(
      'SELECT 1 FROM public.data_rows WHERE table_id = %L AND (%s) LIMIT 0',
      p_source_table_id,
      p_filter_sql
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', SQLERRM
    );
  END;

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.dq_test_filter_sql(UUID, TEXT) IS
  'RUN-LIMIT-0 parse check for a partition filter SQL fragment (PR Ω.3.1). '
  'Caller passes a pre-wrapped filter (row_data->>''X'' form). Returns '
  '{"ok": true} on parse success or {"ok": false, "error": <SQLERRM>} on '
  'failure. Verbose error messages preserved for pilot UX per design doc Q7.';

GRANT EXECUTE ON FUNCTION public.dq_test_filter_sql(UUID, TEXT)
  TO authenticated, service_role;

COMMIT;
