-- ============================================================================
-- Migration 110 — PR Ω.2 — Apply path honors table_mappings.filter_sql
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Adds an optional `p_filter_sql TEXT DEFAULT NULL` parameter to the two
--   apply-path RPCs:
--     1. dq_apply_field_transform_joined (cross-table + same-table apply,
--        from migration 076)
--     2. dq_apply_field_transform (value-assignment apply, from migration 074)
--
--   When p_filter_sql is non-null, it is AND'd into the WHERE clause of every
--   EXECUTE statement in each RPC — 6 sites total (4 in joined, 2 in VA).
--   When p_filter_sql is NULL, behavior is byte-identical to pre-Ω.2 — the
--   appended clause is the empty string.
--
-- DEPLOY ORDER (deliberately the opposite of PR Ω.1)
--   1. Code ships first via the PR's Vercel deploy. Code passes p_filter_sql
--      only when filter is non-null; with every table_mappings.filter_sql
--      currently NULL on prod, code never passes the new param. The old
--      4-arg / 6-arg RPCs continue to satisfy every call.
--   2. Migration applies via Supabase Dashboard. RPCs gain the new param
--      with DEFAULT NULL — backward-compat preserved either way. Once
--      partition-creation UI ships in Ω.3 and a user populates filter_sql,
--      the code starts passing it and the RPC honors it.
--   3. No outage window — both orderings work.
--
-- KNOWN LIMITATIONS
--   • RPC-side DML blocklist on p_filter_sql is the bare-keyword regex
--     pattern. A filter like `status = '2_RCB-APPAREL-DROP'` triggers a
--     false-positive on \ydrop\y until PR ζ.2 ships literal-stripping.
--     Client-side `assertNoDml` (transformations.ts) is already protected;
--     this RPC-side guard is the second defense layer.
--   • Filter SQL must be a pre-qualified SQL fragment (e.g.
--     `(d.row_data->>'X') = 'Y'` for same-table, or with `j0`/`j1`/... aliases
--     for cross-table). The action layer wraps user-authored bare-identifier
--     filters via wrapFieldRefsInJsonb before calling. The RPC trusts that
--     wrapping has happened.
--   • Filter edits without clearing staged_data_rows leave stale rows that
--     were INSERTed under the old filter. The UPDATE branch is filter-scoped
--     (won't update rows that no longer match), but rows previously inserted
--     and now failing the filter stay until staged_data_rows is wiped.
--     A "clear before re-apply" semantic is deferred to Ω.3 (partition-edit UX).
-- ============================================================================

BEGIN;

-- ============================================================================
-- RPC 1 of 2 — dq_apply_field_transform_joined (mapped TFM apply)
-- ============================================================================
-- Drop the 4-param signature from migration 076 so we can recreate with 5.
-- Postgres function overloading is by signature; CREATE OR REPLACE cannot
-- change parameter count.

DROP FUNCTION IF EXISTS public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION public.dq_apply_field_transform_joined(
  p_target_field_mapping_id UUID,
  p_target_field_name       TEXT,
  p_transform_sql           TEXT,
  p_join_spec               JSONB,
  p_filter_sql              TEXT DEFAULT NULL
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
  v_filter_clean          TEXT;
  v_filter_clause         TEXT := '';
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

  -- ── Safety gates on p_transform_sql (heritage; mirror migration 043) ──────
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

  -- ── Safety gates on p_filter_sql (new in PR Ω.2; mirror transform_sql) ────
  -- Bare-keyword DML blocklist. Same false-positive vulnerability on data
  -- literals containing keywords (e.g. SKU '2_RCB-APPAREL-DROP') until
  -- PR ζ.2 ships literal-stripping. Client-side assertNoDml is the
  -- first defense layer; this is defense-in-depth.
  IF p_filter_sql IS NOT NULL THEN
    v_filter_clean := lower(trim(p_filter_sql));
    IF v_filter_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain data modification statements';
    END IF;
    IF v_filter_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot access system tables';
    END IF;
    IF p_filter_sql ~ ';' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain semicolons';
    END IF;
    -- Build the WHERE-clause append once. The parentheses around p_filter_sql
    -- ensure operator-precedence safety (a filter like `a OR b` doesn't
    -- accidentally bind to other AND clauses).
    v_filter_clause := ' AND (' || p_filter_sql || ')';
  END IF;

  RAISE NOTICE '[dq_apply_field_transform_joined] entry tfm=% target=% filter=% elapsed=%',
    p_target_field_mapping_id, p_target_field_name,
    CASE WHEN p_filter_sql IS NULL THEN 'NONE' ELSE 'SET' END,
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
    IF v_dominant_id_text IS NULL THEN
      RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec.dominant_table_id is required';
    END IF;
    IF v_dominant_id_text::UUID <> v_source_table_id THEN
      RAISE EXCEPTION 'dq_apply_field_transform_joined: p_join_spec.dominant_table_id=% disagrees with mapping_sources ordinal=0 source_table=%',
        v_dominant_id_text, v_source_table_id;
    END IF;

    v_joins := p_join_spec->'joins';
    IF v_joins IS NOT NULL
       AND jsonb_typeof(v_joins) = 'array'
       AND jsonb_array_length(v_joins) > 0 THEN
      v_is_cross_table := true;

      FOR v_join_idx IN 0..jsonb_array_length(v_joins) - 1 LOOP
        v_join := v_joins->v_join_idx;
        IF jsonb_typeof(v_join) <> 'object' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: joins[%] must be an object', v_join_idx;
        END IF;

        v_joined_table_id_text := v_join->>'joined_table_id';
        v_via_fk_field         := v_join->>'via_fk_field';
        v_to_fk_field          := v_join->>'to_fk_field';
        v_alias                := v_join->>'alias';

        IF v_joined_table_id_text IS NULL
           OR v_via_fk_field IS NULL
           OR v_to_fk_field IS NULL
           OR v_alias IS NULL THEN
          RAISE EXCEPTION
            'dq_apply_field_transform_joined: joins[%] missing one of {joined_table_id, via_fk_field, to_fk_field, alias}',
            v_join_idx;
        END IF;

        -- Strict aliases: lowercase ASCII letters + digits only. Defends
        -- against quoting + injection on the alias string.
        IF v_alias !~ '^[a-z][a-z0-9_]*$' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: joins[%].alias % is not a safe identifier', v_join_idx, v_alias;
        END IF;
        IF v_via_fk_field !~ '^[A-Za-z_][A-Za-z0-9_ ]*$' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: joins[%].via_fk_field % is not a safe identifier', v_join_idx, v_via_fk_field;
        END IF;
        IF v_to_fk_field !~ '^[A-Za-z_][A-Za-z0-9_ ]*$' THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: joins[%].to_fk_field % is not a safe identifier', v_join_idx, v_to_fk_field;
        END IF;

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
      END LOOP;
    END IF;
  END IF;

  v_t_validate := clock_timestamp();

  -- ── Same-table branch — identical semantics to dq_apply_field_transform ───
  -- Byte-for-byte preservation of migration 074's body for the
  -- non-cross-table path, plus the new filter_sql AND.
  IF NOT v_is_cross_table THEN
    SELECT EXISTS (
      SELECT 1 FROM public.staged_data_rows s WHERE s.table_mapping_id = v_table_mapping_id
    ) INTO v_has_existing_staged;

    v_t_pre_write := clock_timestamp();

    IF v_has_existing_staged THEN
      -- SAME-TABLE UPDATE — filter appended to WHERE
      BEGIN
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
             AND s.table_mapping_id = $1%s',
          p_transform_sql,
          p_target_field_name,
          p_transform_sql,
          v_filter_clause
        ) USING v_table_mapping_id;
      EXCEPTION WHEN OTHERS THEN
        IF p_filter_sql IS NOT NULL THEN
          RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
        ELSE
          RAISE;
        END IF;
      END;
    ELSE
      -- SAME-TABLE INSERT — filter appended to WHERE
      BEGIN
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
           WHERE d.table_id = $2%s
           ORDER BY d.row_number',
          p_target_field_name,
          p_transform_sql,
          p_transform_sql,
          v_filter_clause
        ) USING v_table_mapping_id, v_source_table_id, v_target_table_id;
      EXCEPTION WHEN OTHERS THEN
        IF p_filter_sql IS NOT NULL THEN
          RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
        ELSE
          RAISE;
        END IF;
      END;
    END IF;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_t_post_write := clock_timestamp();

    RAISE NOTICE '[dq_apply_field_transform_joined] same-table apply complete rows=% filter=% validate_ms=% write_ms=% total_ms=%',
      v_count,
      CASE WHEN p_filter_sql IS NULL THEN 'NONE' ELSE 'SET' END,
      EXTRACT(MILLISECONDS FROM (v_t_validate - v_t0)),
      EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t_pre_write)),
      EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t0));

    RETURN v_count;
  END IF;

  -- ── Cross-table branch — LEFT JOIN LATERAL per joined source ──────────────
  -- The transform SQL was rewritten by the action layer to qualify field
  -- references: dominant fields use `d.row_data->>'X'`, joined fields use
  -- `<alias>.row_data->>'X'`. Aliases match `joins[].alias`. Filter SQL
  -- is wrapped the same way.

  SELECT EXISTS (
    SELECT 1 FROM public.staged_data_rows s WHERE s.table_mapping_id = v_table_mapping_id
  ) INTO v_has_existing_staged;

  v_t_pre_write := clock_timestamp();

  IF v_has_existing_staged THEN
    -- CROSS-TABLE UPDATE — filter appended to WHERE
    BEGIN
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
           AND s.table_mapping_id = $1%s',
        p_transform_sql,
        p_target_field_name,
        p_transform_sql,
        v_lateral_clauses,
        v_filter_clause
      ) USING v_table_mapping_id;
    EXCEPTION WHEN OTHERS THEN
      IF p_filter_sql IS NOT NULL THEN
        RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
      ELSE
        RAISE;
      END IF;
    END;
  ELSE
    -- CROSS-TABLE INSERT — filter appended to WHERE
    BEGIN
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
         WHERE d.table_id = $2%s
         ORDER BY d.row_number',
        p_target_field_name,
        p_transform_sql,
        p_transform_sql,
        v_lateral_clauses,
        v_filter_clause
      ) USING v_table_mapping_id, v_source_table_id, v_target_table_id;
    EXCEPTION WHEN OTHERS THEN
      IF p_filter_sql IS NOT NULL THEN
        RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
      ELSE
        RAISE;
      END IF;
    END;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_t_post_write := clock_timestamp();

  RAISE NOTICE '[dq_apply_field_transform_joined] cross-table apply complete rows=% joins=% filter=% validate_ms=% write_ms=% total_ms=%',
    v_count,
    jsonb_array_length(v_joins),
    CASE WHEN p_filter_sql IS NULL THEN 'NONE' ELSE 'SET' END,
    EXTRACT(MILLISECONDS FROM (v_t_validate - v_t0)),
    EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t_pre_write)),
    EXTRACT(MILLISECONDS FROM (v_t_post_write - v_t0));

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB, TEXT) IS
  'Apply a target_field_mapping''s transform to staged_data_rows. '
  'Routes to same-table or cross-table branch based on p_join_spec. '
  'p_filter_sql (PR Ω.2; default NULL) is AND''d into the WHERE clause '
  'when non-null, scoping the apply to a partition''s subset of source rows.';

GRANT EXECUTE ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB, TEXT)
  TO authenticated, service_role;

-- ============================================================================
-- RPC 2 of 2 — dq_apply_field_transform (value-assignment apply, 074)
-- ============================================================================
-- Drop the 6-param signature from migration 074 so we can recreate with 7.

DROP FUNCTION IF EXISTS public.dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.dq_apply_field_transform(
  p_table_mapping_id    UUID,
  p_source_table_id     UUID,
  p_target_table_id     UUID,
  p_target_field_name   TEXT,
  p_transform_sql       TEXT,
  p_has_existing_staged BOOLEAN,
  p_filter_sql          TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
SET work_mem = '64MB'
AS $$
DECLARE
  v_count          BIGINT;
  v_clean          TEXT;
  v_filter_clean   TEXT;
  v_filter_clause  TEXT := '';
BEGIN
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
    RAISE EXCEPTION 'Window functions (e.g. ROW_NUMBER() OVER()) cannot be used in a transform expression because PostgreSQL does not allow them inside UPDATE SET. Rewrite using a hash or concatenation instead (e.g. LEFT(MD5(field::text), 8)).';
  END IF;

  -- Blocklist added in migration 074 (new in this function). Historical
  -- definition in migration 043 relied on the sibling execute_* RPCs for
  -- expression blocking; we now block here too for defense-in-depth.
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|target_field_mappings|mapping_sources|source_field_acknowledgments|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform SQL can only reference field values from data_rows';
  END IF;

  -- ── Safety gates on p_filter_sql (new in PR Ω.2; mirror transform_sql) ────
  IF p_filter_sql IS NOT NULL THEN
    v_filter_clean := lower(trim(p_filter_sql));
    IF v_filter_clean ~ '\y(update|delete|insert|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\y' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain data modification statements';
    END IF;
    IF v_filter_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot access system tables';
    END IF;
    IF p_filter_sql ~ ';' THEN
      RAISE EXCEPTION 'Partition filter SQL cannot contain semicolons';
    END IF;
    v_filter_clause := ' AND (' || p_filter_sql || ')';
  END IF;

  IF p_has_existing_staged THEN
    -- VA UPDATE — filter appended to WHERE
    BEGIN
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
           AND s.table_mapping_id = $1%s',
        p_transform_sql,
        p_target_field_name,
        p_transform_sql,
        v_filter_clause
      ) USING p_table_mapping_id;
    EXCEPTION WHEN OTHERS THEN
      IF p_filter_sql IS NOT NULL THEN
        RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
      ELSE
        RAISE;
      END IF;
    END;
  ELSE
    -- VA INSERT — filter appended to WHERE
    BEGIN
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
         WHERE d.table_id = $2%s
         ORDER BY d.row_number',
        p_target_field_name,
        p_transform_sql,
        p_transform_sql,
        v_filter_clause
      ) USING p_table_mapping_id, p_source_table_id, p_target_table_id;
    EXCEPTION WHEN OTHERS THEN
      IF p_filter_sql IS NOT NULL THEN
        RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM;
      ELSE
        RAISE;
      END IF;
    END;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, TEXT) IS
  'Apply a value-assignment transform to staged_data_rows. Legacy RPC used '
  'by the VA loop in transformations.ts:applyTransform. p_filter_sql (PR Ω.2; '
  'default NULL) is AND''d into the WHERE clause when non-null, scoping the '
  'apply to a partition''s subset of source rows.';

GRANT EXECUTE ON FUNCTION public.dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, TEXT)
  TO authenticated, service_role;

COMMIT;
