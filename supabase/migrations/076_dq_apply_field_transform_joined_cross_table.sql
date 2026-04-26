-- ============================================================================
-- Migration 076 — dq_apply_field_transform_joined: wire cross-table branch
-- ============================================================================
-- Phase 4a-6 — closes the cross-table apply gap left open by migration 074.
--
-- BEFORE
--   Migration 074 stubbed the `p_join_spec IS NOT NULL` branch with a
--   RAISE EXCEPTION. The action layer (`lib/actions/transformations.ts`)
--   short-circuited cross-table TFMs with a structured
--   `CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED` error before invoking the
--   RPC. A three-layer transparency stack (action error code + Transform-
--   tab disabled buttons + drawer Sources badge) prevented users from
--   triggering the dead branch.
--
-- AFTER
--   This migration replaces the stubbed branch with real LEFT JOIN
--   LATERAL logic, keyed on per-source FK relationships supplied via the
--   `p_join_spec` JSONB parameter. The action layer now constructs that
--   JSONB and passes it through. The transparency stack is retired.
--
-- INVARIANTS PRESERVED FROM 074
--   * Function signature: (uuid, text, text, jsonb) → bigint.
--   * Same-table branch is byte-for-byte unchanged. Existing transforms
--     continue to apply with identical semantics.
--   * Permission gate (`user_has_project_role(..., 'editor')`) and SQL
--     injection guards (DML/DDL/system-table/semicolon/window) fire
--     before any branch.
--   * NULL-safe write-back via `CASE WHEN (...) IS NOT NULL` — preserves
--     prior staged value or writes JSON null on first apply.
--
-- p_join_spec SHAPE (action-layer contract — pinned in
-- `lib/utils/transform-cross-table.ts`)
--
--   {
--     "dominant_table_id": "<uuid>",
--     "joins": [
--       {
--         "joined_table_id": "<uuid>",
--         "via_fk_field":    "<dominant column name>",
--         "to_fk_field":     "<joined column name>",
--         "alias":           "j0"
--       },
--       ...
--     ]
--   }
--
--   * `dominant_table_id` MUST equal the `mapping_sources.source_table_id`
--     resolved at `ordinal=0` (verified in PL/pgSQL).
--   * `joins[]` MUST be non-empty (the cross-table branch entry guard).
--   * Each `joined_table_id` MUST differ from `dominant_table_id`.
--   * `via_fk_field` / `to_fk_field` are field NAMES (extracted via
--     `row_data->>'name'`), matching `wrapFieldRefsInJsonb` output for
--     same-table refs and `<alias>.row_data->>'name'` for joined refs.
--   * `alias` is `j0` / `j1` / … — used verbatim in the generated SQL.
--     The action layer assigns these to match what the cross-table-aware
--     `wrapFieldRefsInJsonb` rewrote into the transform expression.
--
-- LATERAL CHOICE (founder lock §3-OQ-A, §3-OQ-B)
--   * LEFT JOIN LATERAL — preserves dominant-table cardinality. FK miss
--     yields NULL on the joined side, which the existing NULL-safe
--     CASE preserves prior value (or writes JSON null on first apply).
--   * ORDER BY row_number, LIMIT 1 inside the lateral — deterministic
--     tiebreaker for 1:N FK matches (joined table has multiple rows
--     with the same FK value). Picks the lowest-ingestion-order row.
--
-- INSTRUMENTATION (founder lock §9-OQ-B)
--   * RAISE NOTICE with `clock_timestamp()` deltas at: entry, after
--     join_spec validation, before UPDATE/INSERT, after final write.
--   * Visible via Supabase logs (`get_logs` MCP). Lets us measure
--     real-data scaling without committing to indexes today.
--
-- IDEMPOTENCY
--   Single CREATE OR REPLACE FUNCTION + GRANT + COMMENT. No DDL
--   changes to tables. Re-running this migration is a no-op.

CREATE OR REPLACE FUNCTION public.dq_apply_field_transform_joined(
  p_target_field_mapping_id UUID,
  p_target_field_name       TEXT,
  p_transform_sql           TEXT,
  p_join_spec               JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
SET work_mem = '64MB'
AS $$
DECLARE
  v_project_id            UUID;
  v_source_table_id       UUID;
  v_target_table_id       UUID;
  v_table_mapping_id      UUID;
  v_has_existing_staged   BOOLEAN;
  v_clean                 TEXT;
  v_count                 BIGINT;
  v_is_cross_table        BOOLEAN := false;
  v_dominant_id_text      TEXT;
  v_joins                 JSONB;
  v_join                  JSONB;
  v_join_idx              INT;
  v_joined_table_id_text  TEXT;
  v_via_fk_field          TEXT;
  v_to_fk_field           TEXT;
  v_alias                 TEXT;
  v_lateral_clauses       TEXT := '';
  v_t0                    TIMESTAMPTZ := clock_timestamp();
  v_t_validate            TIMESTAMPTZ;
  v_t_pre_write           TIMESTAMPTZ;
  v_t_post_write          TIMESTAMPTZ;
BEGIN
  -- ── Resolve TFM → project / source table / target table ───────────────────
  SELECT tfm.project_id, f.table_id
    INTO v_project_id, v_target_table_id
  FROM public.target_field_mappings tfm
  JOIN public.fields f ON f.id = tfm.target_field_id
  WHERE tfm.id = p_target_field_mapping_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'dq_apply_field_transform_joined: target_field_mapping % not found', p_target_field_mapping_id;
  END IF;

  IF NOT public.user_has_project_role(v_project_id, 'editor') THEN
    RAISE EXCEPTION 'dq_apply_field_transform_joined: permission denied for project %', v_project_id;
  END IF;

  -- Dominant source (ordinal=0) defines the source_table_id for apply.
  SELECT ms.source_table_id
    INTO v_source_table_id
  FROM public.mapping_sources ms
  WHERE ms.target_field_mapping_id = p_target_field_mapping_id
  ORDER BY ms.ordinal ASC
  LIMIT 1;

  IF v_source_table_id IS NULL THEN
    RAISE EXCEPTION 'dq_apply_field_transform_joined: no mapping_sources found for tfm %. Value assignments are applied via a different path.', p_target_field_mapping_id;
  END IF;

  -- Resolve the table_mapping_id linking this source table to this target
  -- table. Required by staged_data_rows' FK contract.
  SELECT tm.id
    INTO v_table_mapping_id
  FROM public.table_mappings tm
  WHERE tm.project_id      = v_project_id
    AND tm.source_table_id = v_source_table_id
    AND tm.target_table_id = v_target_table_id
  LIMIT 1;

  IF v_table_mapping_id IS NULL THEN
    RAISE EXCEPTION 'dq_apply_field_transform_joined: no table_mapping for (source=%, target=%) in project %',
      v_source_table_id, v_target_table_id, v_project_id;
  END IF;

  -- ── Safety gates (mirror migration 043 semantics) ─────────────────────────
  IF p_target_field_name !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid target field name: %', p_target_field_name;
  END IF;

  v_clean := lower(trim(p_transform_sql));
  IF v_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
    RAISE EXCEPTION 'Transform SQL cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform SQL cannot access system tables';
  END IF;
  IF p_transform_sql ~ ';' THEN
    RAISE EXCEPTION 'Transform SQL cannot contain semicolons';
  END IF;
  IF v_clean ~ '\yover\s*\(' THEN
    RAISE EXCEPTION 'Window functions cannot be used in a transform expression (not allowed inside UPDATE SET)';
  END IF;

  RAISE NOTICE '[dq_apply_field_transform_joined] entry tfm=% target=% elapsed=%',
    p_target_field_mapping_id, p_target_field_name,
    clock_timestamp() - v_t0;

  -- ── Cross-table branch detection + validation ─────────────────────────────
  -- Treat both SQL NULL and JSONB null as "same-table". A non-empty `joins`
  -- array is the cross-table trigger; everything else is rejected with a
  -- clear message so action-layer bugs surface immediately.

  IF p_join_spec IS NOT NULL AND jsonb_typeof(p_join_spec) <> 'null' THEN
    IF jsonb_typeof(p_join_spec) <> 'object' THEN
      RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec must be a JSON object, got %', jsonb_typeof(p_join_spec);
    END IF;

    v_dominant_id_text := p_join_spec->>'dominant_table_id';
    v_joins := p_join_spec->'joins';

    IF v_dominant_id_text IS NULL THEN
      RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec missing required key "dominant_table_id"';
    END IF;
    IF v_dominant_id_text::UUID <> v_source_table_id THEN
      RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec.dominant_table_id (%) does not match TFM dominant source table (%)',
        v_dominant_id_text, v_source_table_id;
    END IF;

    IF v_joins IS NULL OR jsonb_typeof(v_joins) <> 'array' THEN
      RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec.joins must be a JSON array';
    END IF;

    IF jsonb_array_length(v_joins) > 0 THEN
      v_is_cross_table := true;

      -- Validate each join entry and accumulate LATERAL clauses.
      FOR v_join_idx IN 0 .. jsonb_array_length(v_joins) - 1 LOOP
        v_join := v_joins -> v_join_idx;

        IF jsonb_typeof(v_join) <> 'object' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec.joins[%] must be an object', v_join_idx;
        END IF;

        v_joined_table_id_text := v_join->>'joined_table_id';
        v_via_fk_field         := v_join->>'via_fk_field';
        v_to_fk_field          := v_join->>'to_fk_field';
        v_alias                := v_join->>'alias';

        IF v_joined_table_id_text IS NULL OR v_via_fk_field IS NULL
           OR v_to_fk_field IS NULL OR v_alias IS NULL THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec.joins[%] missing required keys (joined_table_id, via_fk_field, to_fk_field, alias)', v_join_idx;
        END IF;

        IF v_alias !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: invalid alias % at joins[%]', v_alias, v_join_idx;
        END IF;
        IF v_via_fk_field !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: invalid via_fk_field % at joins[%]', v_via_fk_field, v_join_idx;
        END IF;
        IF v_to_fk_field !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: invalid to_fk_field % at joins[%]', v_to_fk_field, v_join_idx;
        END IF;
        IF v_joined_table_id_text::UUID = v_source_table_id THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: joins[%].joined_table_id (%) must differ from dominant_table_id', v_join_idx, v_joined_table_id_text;
        END IF;

        -- LEFT JOIN LATERAL preserves dominant-table cardinality. ORDER BY
        -- row_number gives deterministic tie-break on 1:N matches.
        v_lateral_clauses := v_lateral_clauses || format(
          E'\nLEFT JOIN LATERAL (\n'
          '  SELECT %I.row_data\n'
          '  FROM data_rows %I\n'
          '  WHERE %I.table_id = %L::uuid\n'
          '    AND %I.row_data->>%L = d.row_data->>%L\n'
          '  ORDER BY %I.row_number\n'
          '  LIMIT 1\n'
          ') %I ON true',
          v_alias,
          v_alias,
          v_alias, v_joined_table_id_text,
          v_alias, v_to_fk_field, v_via_fk_field,
          v_alias,
          v_alias
        );

        RAISE NOTICE '[dq_apply_field_transform_joined] lateral added alias=% joined_table=% via=% to=% elapsed=%',
          v_alias, v_joined_table_id_text, v_via_fk_field, v_to_fk_field,
          clock_timestamp() - v_t0;
      END LOOP;
    END IF;
  END IF;

  v_t_validate := clock_timestamp();

  -- ── Same-table branch — identical semantics to dq_apply_field_transform ───
  -- Byte-for-byte preservation of migration 074's body for the
  -- non-cross-table path.
  IF NOT v_is_cross_table THEN
    SELECT EXISTS (
      SELECT 1 FROM public.staged_data_rows s WHERE s.table_mapping_id = v_table_mapping_id
    ) INTO v_has_existing_staged;

    v_t_pre_write := clock_timestamp();

    IF v_has_existing_staged THEN
      EXECUTE format(
        'UPDATE staged_data_rows s
         SET transformed_row_data = CASE
           WHEN (%s) IS NOT NULL
             THEN jsonb_set(
                    s.transformed_row_data,
                    ''{%s}'',
                    to_jsonb((%s)::text)
                  )
           ELSE s.transformed_row_data
         END
         FROM data_rows d
         WHERE s.source_table_id = d.table_id
           AND s.row_number      = d.row_number
           AND s.table_mapping_id = $1',
        p_transform_sql,
        p_target_field_name,
        p_transform_sql
      ) USING v_table_mapping_id;
    ELSE
      EXECUTE format(
        'INSERT INTO staged_data_rows
           (table_mapping_id, source_table_id, target_table_id,
            row_number, source_row_data, transformed_row_data)
         SELECT $1, $2, $3,
                d.row_number,
                d.row_data,
                jsonb_build_object(
                  ''%s'',
                  CASE WHEN (%s) IS NOT NULL THEN to_jsonb((%s)::text) ELSE ''null''::jsonb END
                )
         FROM data_rows d
         WHERE d.table_id = $2
         ORDER BY d.row_number',
        p_target_field_name,
        p_transform_sql,
        p_transform_sql
      ) USING v_table_mapping_id, v_source_table_id, v_target_table_id;
    END IF;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_t_post_write := clock_timestamp();

    RAISE NOTICE '[dq_apply_field_transform_joined] same-table apply complete rows=% validate_ms=% write_ms=% total_ms=%',
      v_count,
      EXTRACT(MILLISECONDS FROM (v_t_validate - v_t0)),
      EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t_pre_write)),
      EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t0));

    RETURN v_count;
  END IF;

  -- ── Cross-table branch — LEFT JOIN LATERAL per joined source ──────────────
  -- The transform SQL was rewritten by the action layer to qualify field
  -- references: dominant fields use `d.row_data->>'X'`, joined fields use
  -- `<alias>.row_data->>'X'`. Aliases match `joins[].alias`.

  SELECT EXISTS (
    SELECT 1 FROM public.staged_data_rows s WHERE s.table_mapping_id = v_table_mapping_id
  ) INTO v_has_existing_staged;

  v_t_pre_write := clock_timestamp();

  IF v_has_existing_staged THEN
    EXECUTE format(
      'UPDATE staged_data_rows s
       SET transformed_row_data = CASE
         WHEN (%s) IS NOT NULL
           THEN jsonb_set(
                  s.transformed_row_data,
                  ''{%s}'',
                  to_jsonb((%s)::text)
                )
         ELSE s.transformed_row_data
       END
       FROM data_rows d%s
       WHERE s.source_table_id = d.table_id
         AND s.row_number      = d.row_number
         AND s.table_mapping_id = $1',
      p_transform_sql,
      p_target_field_name,
      p_transform_sql,
      v_lateral_clauses
    ) USING v_table_mapping_id;
  ELSE
    EXECUTE format(
      'INSERT INTO staged_data_rows
         (table_mapping_id, source_table_id, target_table_id,
          row_number, source_row_data, transformed_row_data)
       SELECT $1, $2, $3,
              d.row_number,
              d.row_data,
              jsonb_build_object(
                ''%s'',
                CASE WHEN (%s) IS NOT NULL THEN to_jsonb((%s)::text) ELSE ''null''::jsonb END
              )
       FROM data_rows d%s
       WHERE d.table_id = $2
       ORDER BY d.row_number',
      p_target_field_name,
      p_transform_sql,
      p_transform_sql,
      v_lateral_clauses
    ) USING v_table_mapping_id, v_source_table_id, v_target_table_id;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_t_post_write := clock_timestamp();

  RAISE NOTICE '[dq_apply_field_transform_joined] cross-table apply complete rows=% joins=% validate_ms=% write_ms=% total_ms=%',
    v_count,
    jsonb_array_length(v_joins),
    EXTRACT(MILLISECONDS FROM (v_t_validate - v_t0)),
    EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t_pre_write)),
    EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t0));

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB) IS
  'Per-field apply RPC for the redesigned mapping model. Same-table branch (NULL p_join_spec) preserves migration 074 semantics. Cross-table branch (non-empty p_join_spec.joins[]) appends LEFT JOIN LATERAL clauses against data_rows partitioned by joined_table_id, keyed by FK column names extracted via JSONB. Wired in migration 076 (Phase 4a-6).';

GRANT EXECUTE ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB)
  TO authenticated, service_role;
