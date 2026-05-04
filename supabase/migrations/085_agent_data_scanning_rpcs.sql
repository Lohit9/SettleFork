-- 085_agent_data_scanning_rpcs.sql
-- Phase 3.3 (PR 3.3) — 3 data-scanning RPCs for agent-loop dispatch.
--
-- Spec: docs/investigations/pr-phase3.1-agent-design.md §B
--
-- Common posture (all 3 functions):
--   * LANGUAGE plpgsql SECURITY INVOKER (NOT DEFINER) — RLS applies.
--   * First executable statement: user_has_project_role(p_project_id, 'viewer')
--     gate. Function declared in 050_organizations.sql, current version
--     in 079_project_rbac_strict_membership.sql.
--   * statement_timeout enforced; work_mem capped.
--   * data_rows joined to tables → datasets to verify the supplied
--     p_table_id genuinely belongs to p_project_id (cross-project
--     blocking is structural, not advisory).
--   * Server-side limit clamping (LEAST(p_limit, MAX)) — model can
--     request larger limits but the server caps them.
--   * Returns JSONB; exceptions raise SQL errors caught by tool handler.
--
-- Existing alternatives considered + rejected (Phase A DIVERGENCE
-- callouts):
--   * execute_readonly_query (migration 004) — UNSAFE. p_table_ids arg
--     is not used to scope the query; SECURITY DEFINER bypasses RLS.
--     A model-emitted query could SELECT FROM data_rows WHERE
--     table_id = '<any-uuid>'. Do NOT wrap.
--   * dq_field_issue_samples (migration 055) — purpose-built for
--     known DQ issue conditions only (null/non_iso_date/etc.). Not
--     generalizable as the agent's query_field_data tool.

-- ─── B1: agent_query_field_data ──────────────────────────────────────────────
-- Sample N row values for one field, optionally filtered by a single
-- WHERE condition. Used by the model when aggregate stats aren't
-- enough and individual values are needed. The where_filter is
-- restricted via a strict regex allowlist (single-condition only).
CREATE OR REPLACE FUNCTION public.agent_query_field_data(
  p_project_id   UUID,
  p_table_id     UUID,
  p_field_name   TEXT,
  p_where_filter TEXT DEFAULT NULL,
  p_limit        INT  DEFAULT 20
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET statement_timeout = '10s'
SET work_mem = '8MB'
AS $func$
DECLARE
  v_clamped_limit INT;
  v_belongs       BOOLEAN;
  v_total_estimate BIGINT;
  v_filter        TEXT;
  v_query         TEXT;
  v_values        JSONB;
  v_count         INT;
BEGIN
  -- Project-role gate (NON-NEGOTIABLE)
  IF NOT public.user_has_project_role(p_project_id, 'viewer') THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Verify table belongs to project (structural cross-project block)
  SELECT EXISTS(
    SELECT 1
    FROM public.tables t
    JOIN public.datasets ds ON t.dataset_id = ds.id
    WHERE t.id = p_table_id AND ds.project_id = p_project_id
  ) INTO v_belongs;
  IF NOT v_belongs THEN
    RAISE EXCEPTION 'Table not in project';
  END IF;

  -- Validate field_name (alphanumeric + underscore, no JSONB operators)
  IF p_field_name IS NULL OR p_field_name !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid field_name: must be a bare identifier';
  END IF;

  -- Clamp limit
  v_clamped_limit := LEAST(GREATEST(p_limit, 1), 50);

  -- Validate where_filter via strict regex allowlist (per design §B1).
  -- NULL or empty → no filter; otherwise must match a single column
  -- condition (one comparison or one IS [NOT] NULL).
  v_filter := COALESCE(NULLIF(TRIM(p_where_filter), ''), '');
  IF v_filter <> '' THEN
    IF v_filter !~ ('^row_data\s*->>\s*''[a-zA-Z_][a-zA-Z0-9_]*''\s*' ||
                    '(IS NULL|IS NOT NULL|=|!=|<>|>|<|>=|<=)' ||
                    '(\s*(''[^'';]*''|[0-9]+(\.[0-9]+)?))?\s*$') THEN
      RAISE EXCEPTION 'Unsafe where_filter';
    END IF;
  END IF;

  -- Cheap row-count estimate from pg_class.reltuples (avoids full COUNT)
  SELECT COALESCE(reltuples::bigint, 0) INTO v_total_estimate
  FROM pg_class WHERE oid = 'public.data_rows'::regclass;

  -- Build + execute the query
  v_query := format(
    'SELECT COALESCE(jsonb_agg(sub.value), ''[]''::jsonb) FROM ( ' ||
    'SELECT d.row_data->>%L AS value FROM public.data_rows d ' ||
    'WHERE d.table_id = %L %s LIMIT %s) sub',
    p_field_name,
    p_table_id,
    CASE WHEN v_filter = '' THEN '' ELSE 'AND ' || v_filter END,
    v_clamped_limit
  );
  EXECUTE v_query INTO v_values;

  v_count := jsonb_array_length(v_values);

  RETURN jsonb_build_object(
    'values', v_values,
    'total_returned', v_count,
    'total_in_table_estimate', v_total_estimate
  );
END;
$func$;

-- ─── B2: agent_count_distinct_patterns ───────────────────────────────────────
-- Group-by-distinct frequency on one field. Used to decide enum-rule
-- vs regex/freeform.
CREATE OR REPLACE FUNCTION public.agent_count_distinct_patterns(
  p_project_id UUID,
  p_table_id   UUID,
  p_field_name TEXT,
  p_limit      INT DEFAULT 15
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET statement_timeout = '10s'
SET work_mem = '8MB'
AS $func$
DECLARE
  v_clamped_limit INT;
  v_belongs       BOOLEAN;
  v_total_rows    BIGINT;
  v_total_distinct BIGINT;
  v_patterns      JSONB;
BEGIN
  IF NOT public.user_has_project_role(p_project_id, 'viewer') THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.tables t
    JOIN public.datasets ds ON t.dataset_id = ds.id
    WHERE t.id = p_table_id AND ds.project_id = p_project_id
  ) INTO v_belongs;
  IF NOT v_belongs THEN
    RAISE EXCEPTION 'Table not in project';
  END IF;

  IF p_field_name IS NULL OR p_field_name !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid field_name: must be a bare identifier';
  END IF;

  v_clamped_limit := LEAST(GREATEST(p_limit, 1), 30);

  -- Total rows for percent computation
  SELECT COUNT(*) INTO v_total_rows
  FROM public.data_rows WHERE table_id = p_table_id;

  -- Distinct value count + top-N patterns
  EXECUTE format(
    'SELECT COUNT(*) FROM (SELECT DISTINCT row_data->>%L FROM public.data_rows WHERE table_id = %L) d',
    p_field_name, p_table_id
  ) INTO v_total_distinct;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(p ORDER BY (p->>''count'')::bigint DESC), ''[]''::jsonb) FROM ( ' ||
    'SELECT jsonb_build_object( ' ||
    '''value'', sub.value, ' ||
    '''count'', sub.cnt, ' ||
    '''percent'', CASE WHEN %L = 0 THEN 0 ELSE ROUND(sub.cnt::numeric / %L, 4) END' ||
    ') AS p FROM ( ' ||
    'SELECT row_data->>%L AS value, COUNT(*) AS cnt ' ||
    'FROM public.data_rows WHERE table_id = %L ' ||
    'GROUP BY 1 ORDER BY 2 DESC LIMIT %s) sub) wrapper',
    v_total_rows, v_total_rows,
    p_field_name, p_table_id, v_clamped_limit
  ) INTO v_patterns;

  RETURN jsonb_build_object(
    'patterns', v_patterns,
    'total_distinct', v_total_distinct,
    'truncated', v_total_distinct > v_clamped_limit
  );
END;
$func$;

-- ─── B3: agent_cross_field_correlation ──────────────────────────────────────
-- Joint frequency stats for two fields on the same table + per-A
-- conditional null rates of B.
CREATE OR REPLACE FUNCTION public.agent_cross_field_correlation(
  p_project_id    UUID,
  p_table_id      UUID,
  p_field_a_name  TEXT,
  p_field_b_name  TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET statement_timeout = '15s'
SET work_mem = '16MB'
AS $func$
DECLARE
  v_belongs    BOOLEAN;
  v_joint_top  JSONB;
  v_null_rates JSONB;
BEGIN
  IF NOT public.user_has_project_role(p_project_id, 'viewer') THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.tables t
    JOIN public.datasets ds ON t.dataset_id = ds.id
    WHERE t.id = p_table_id AND ds.project_id = p_project_id
  ) INTO v_belongs;
  IF NOT v_belongs THEN
    RAISE EXCEPTION 'Table not in project';
  END IF;

  IF p_field_a_name IS NULL OR p_field_a_name !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid field_a_name: must be a bare identifier';
  END IF;
  IF p_field_b_name IS NULL OR p_field_b_name !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid field_b_name: must be a bare identifier';
  END IF;

  -- Joint top-25 (A, B) pairs by frequency
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(p ORDER BY (p->>''count'')::bigint DESC), ''[]''::jsonb) FROM ( ' ||
    'SELECT jsonb_build_object(''a'', sub.a, ''b'', sub.b, ''count'', sub.cnt) AS p FROM ( ' ||
    'SELECT row_data->>%L AS a, row_data->>%L AS b, COUNT(*) AS cnt ' ||
    'FROM public.data_rows WHERE table_id = %L ' ||
    'GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25) sub) wrapper',
    p_field_a_name, p_field_b_name, p_table_id
  ) INTO v_joint_top;

  -- Conditional null rates of B given each top-10 A value
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(p ORDER BY (p->>''a_count'')::bigint DESC), ''[]''::jsonb) FROM ( ' ||
    'SELECT jsonb_build_object( ' ||
    '''a_value'', sub.a, ' ||
    '''a_count'', sub.a_total, ' ||
    '''b_null_count'', sub.b_nulls, ' ||
    '''b_null_rate'', CASE WHEN sub.a_total = 0 THEN 0 ELSE ROUND(sub.b_nulls::numeric / sub.a_total, 4) END' ||
    ') AS p FROM ( ' ||
    'SELECT row_data->>%L AS a, ' ||
    'COUNT(*) AS a_total, ' ||
    'COUNT(*) FILTER (WHERE row_data->>%L IS NULL OR row_data->>%L = '''') AS b_nulls ' ||
    'FROM public.data_rows WHERE table_id = %L ' ||
    'GROUP BY 1 ORDER BY 2 DESC LIMIT 10) sub) wrapper',
    p_field_a_name, p_field_b_name, p_field_b_name, p_table_id
  ) INTO v_null_rates;

  RETURN jsonb_build_object(
    'joint_top', v_joint_top,
    'conditional_null_rates', v_null_rates
  );
END;
$func$;

-- ─── Grants (allow authenticated users to invoke) ───────────────────────────
-- The functions are SECURITY INVOKER; the user_has_project_role gate
-- enforces project membership. Grant EXECUTE to the authenticated role
-- so callers can invoke via Supabase RPC.
GRANT EXECUTE ON FUNCTION public.agent_query_field_data(UUID, UUID, TEXT, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_count_distinct_patterns(UUID, UUID, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_cross_field_correlation(UUID, UUID, TEXT, TEXT) TO authenticated;
