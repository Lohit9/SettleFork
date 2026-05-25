-- ============================================================================
-- Migration 104 — Relax target-field-name gate in Apply Transform RPCs
-- ============================================================================
-- PR γ''. Replaces the strict regex `^[A-Za-z_][A-Za-z0-9_]*$` on
-- `p_target_field_name` in both live Apply Transform RPCs with a semantic
-- field-existence check against `public.fields(table_id, name)`.
--
-- WHY
--   Migration 076 (`dq_apply_field_transform_joined`) and migration 074
--   (`dq_apply_field_transform`) both enforce a regex on the target field
--   name that rejects anything containing a space, hyphen, or other display-
--   name punctuation. Real customer schemas — including the Rootstock POC
--   target (`Inactive Status`, `Item Number`, `Lot Tracking`, etc.) — use
--   display names with spaces. The gate fires on every Apply attempt and
--   blocks ~60-80 of the 87 Rootstock TFMs.
--
--   Audit of every `p_target_field_name` reference in both RPCs confirms
--   the name is ONLY interpolated as a JSONB key/path text literal inside
--   `jsonb_set` / `jsonb_build_object` (e.g. `''{%s}''` → `'{Inactive
--   Status}'`, `''%s''` → `'Inactive Status'`). It is NEVER used as a SQL
--   identifier (no `%I`, no unquoted `%s`-as-identifier). The regex was
--   overly defensive for the JSONB-only usage pattern.
--
-- WHAT CHANGES
--   * `dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB)` — THREE
--     regex gates replaced with field-existence checks:
--       (1) `p_target_field_name` → exists in target table.
--       (2) `v_via_fk_field` (cross-table joins[].via_fk_field) → exists
--           in dominant source table. Used as %L inside `row_data->>%L`
--           (JSONB key string literal) in the LATERAL clause — never a
--           SQL identifier — so the regex was overly defensive for the
--           same reason as p_target_field_name. Without this relaxation,
--           Rootstock's join_spec ({"via_fk_field": "Assy Item", ...})
--           still fails on cross-table Apply post-target-relaxation.
--       (3) `v_to_fk_field` (cross-table joins[].to_fk_field) → exists
--           in joined table. Same `row_data->>%L` JSONB-key pattern.
--     The `v_alias` regex is KEPT — alias IS interpolated as `%I`
--     (SQL identifier) in the LATERAL clause, so the strict regex is
--     load-bearing there. Body otherwise byte-identical to the
--     migration-076 definition: same permission gate, same DML/DDL block-
--     list, same NULL-safe CASE write-back, same LEFT JOIN LATERAL logic,
--     same NOTICE instrumentation, same dominant_table_id UUID-equality
--     check, same alias strict-regex.
--   * `dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN)` —
--     single target-field-name swap (no via/to FK fields exist in this
--     RPC's signature). Body otherwise byte-identical to migration-074:1572.
--
-- WHAT IS PRESERVED
--   * Function signatures (both unchanged → no DROP needed).
--   * Permission gates (`user_has_project_role(..., 'editor')` for the
--     joined RPC; SECURITY DEFINER + GRANT EXECUTE for both).
--   * Transform-SQL safety gates (DML/DDL blocklist, pg_catalog block,
--     semicolon block, window-function block, internal-table blocklist).
--   * NULL-safe write semantics.
--   * Cross-table LATERAL logic, alias/FK validation, NOTICE timing.
--
-- RESIDUAL RISK (deferred to a future PR if it ever surfaces)
--   Field names containing `'`, `}`, `\`, or `,` would now flow through
--   the JSONB literal interpolation and break SQL parsing (fails loud, not
--   silently). The current defence boundary becomes "what we allow into
--   `public.fields.name` at ingestion time". Rootstock POC names are safe.
--   The proper structural fix — `format('%L', p_target_field_name)` or
--   `ARRAY[p_target_field_name]::text[]` passed via USING — is deferred
--   to PR γ''' if/when a customer schema surfaces such a name.
--
-- IDEMPOTENCY
--   Two `CREATE OR REPLACE FUNCTION` + two `GRANT EXECUTE` + one
--   `COMMENT ON FUNCTION`. No DDL, no data migration. Re-running this
--   migration against a DB that already has the relaxed functions is a
--   no-op.
-- ============================================================================


-- ─── Section A. dq_apply_field_transform_joined (mapped TFMs) ────────────────

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
  -- Migration 104 (PR γ''): the previous regex `^[A-Za-z_][A-Za-z0-9_]*$`
  -- rejected display-name target fields (anything with a space). All
  -- p_target_field_name usages below are JSONB-key contexts inside
  -- jsonb_set / jsonb_build_object — never SQL identifiers — so the regex
  -- was overly defensive. Semantic existence check catches typos and
  -- accepts any legitimately-named target column.
  IF NOT EXISTS (
    SELECT 1 FROM public.fields
     WHERE table_id = v_target_table_id
       AND name     = p_target_field_name
  ) THEN
    RAISE EXCEPTION 'Target field % not found in table %', p_target_field_name, v_target_table_id;
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
        -- Migration 104 (PR γ''): existence-check replaces regex.
        -- v_via_fk_field is used as %L (string literal) inside
        -- `row_data->>%L` in the LATERAL clause — JSONB key context,
        -- never a SQL identifier — so the regex was overly defensive.
        IF NOT EXISTS (
          SELECT 1 FROM public.fields
           WHERE table_id = v_source_table_id
             AND name     = v_via_fk_field
        ) THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: via_fk_field % at joins[%] not found in dominant source table %',
            v_via_fk_field, v_join_idx, v_source_table_id;
        END IF;
        -- Migration 104 (PR γ''): same swap for v_to_fk_field — also used
        -- as %L inside `row_data->>%L` (JSONB key) in the LATERAL clause.
        -- Existence is checked against the joined table.
        IF NOT EXISTS (
          SELECT 1 FROM public.fields
           WHERE table_id = v_joined_table_id_text::UUID
             AND name     = v_to_fk_field
        ) THEN
          RAISE EXCEPTION 'dq_apply_field_transform_joined: to_fk_field % at joins[%] not found in joined table %',
            v_to_fk_field, v_join_idx, v_joined_table_id_text;
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
  'Per-field apply RPC for the redesigned mapping model. Same-table branch (NULL p_join_spec) preserves migration 074 semantics. Cross-table branch (non-empty p_join_spec.joins[]) appends LEFT JOIN LATERAL clauses against data_rows partitioned by joined_table_id, keyed by FK column names extracted via JSONB. Wired in migration 076; migration 104 (PR γ'''') replaces three strict identifier regexes (p_target_field_name, joins[].via_fk_field, joins[].to_fk_field) with semantic field-existence checks against public.fields(table_id, name) so display-name fields with spaces apply correctly. The joins[].alias regex is preserved — alias IS used as a %I SQL identifier in the LATERAL clause.';

GRANT EXECUTE ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB)
  TO authenticated, service_role;


-- ─── Section B. dq_apply_field_transform (value-assignment TFMs) ─────────────

CREATE OR REPLACE FUNCTION public.dq_apply_field_transform(
  p_table_mapping_id    UUID,
  p_source_table_id     UUID,
  p_target_table_id     UUID,
  p_target_field_name   TEXT,
  p_transform_sql       TEXT,
  p_has_existing_staged BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
SET work_mem = '64MB'
AS $$
DECLARE
  v_count BIGINT;
  v_clean TEXT;
BEGIN
  -- Migration 104 (PR γ''): replaced the strict regex
  -- `^[A-Za-z_][A-Za-z0-9_]*$` with a semantic field-existence check.
  -- Rationale identical to dq_apply_field_transform_joined above —
  -- p_target_field_name is only ever used as a JSONB key/path text
  -- literal in the EXECUTE format calls below, never as a SQL identifier.
  IF NOT EXISTS (
    SELECT 1 FROM public.fields
     WHERE table_id = p_target_table_id
       AND name     = p_target_field_name
  ) THEN
    RAISE EXCEPTION 'Target field % not found in table %', p_target_field_name, p_target_table_id;
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

  IF p_has_existing_staged THEN
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
    ) USING p_table_mapping_id;
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
    ) USING p_table_mapping_id, p_source_table_id, p_target_table_id;
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dq_apply_field_transform(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN)
  TO authenticated, service_role;
