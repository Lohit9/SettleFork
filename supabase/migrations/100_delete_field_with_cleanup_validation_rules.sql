-- ============================================================
-- Migration 100 — delete_field_with_cleanup adds validation_rules count
-- ============================================================
-- Fast-follow micro-PR on top of migration 099. Same function name,
-- same signature, same body — plus one additional count
-- (validation_rules where field_id = p_field_id) in the cascade summary.
--
-- Why this exists:
--   B caught during signature verification of PR #125 (FR-3 server-side
--   merge, 2026-05-10) that the FR-3 preview wireframe lists "validation
--   rules" as an impact category but neither previewFieldDeletion nor
--   migration 099 counts them. The FK CASCADE on
--   validation_rules.field_id (migration 006:10) silently removes rows
--   when the parent field is deleted; the UI then renders "0 affected"
--   while the DB removed N. Honest-cascade-disclosure is the whole point
--   of preview-then-confirm, so this gap must close before B can ship
--   the FR-3 delete-confirmation UI.
--
-- Strategy:
--   - CREATE OR REPLACE FUNCTION (no DROP, no signature change). Callers
--     keep working; the additive `validation_rules` JSONB key simply
--     appears in return values from the moment this migration applies.
--   - Body is 099's body verbatim with two additive sites:
--       (1) `v_validation_rules_count INT;` declared alongside the other
--           count vars
--       (2) one COUNT(*) into v_validation_rules_count run BEFORE the
--           field DELETE (alongside the other pre-delete counts)
--       (3) `'validation_rules', v_validation_rules_count` appended to
--           the jsonb_build_object('cascade_counts', …) return shape
--   - No refactor of 099's existing logic. Comments are added but no
--     existing comment / step / variable is modified.
--
-- Column verification:
--   validation_rules.field_id (migration 006:10) is UUID, NULLABLE,
--   ON DELETE CASCADE → fields(id). Rules can be field-scoped,
--   table-scoped, or project-scoped — only field-scoped rows have a
--   non-NULL field_id and are affected by field deletion. The
--   `WHERE field_id = p_field_id` clause correctly excludes the
--   table/project-scoped variants (which the FK CASCADE itself also
--   leaves alone).
--
-- See notes/fr-3-validation-rules-investigation.md for the full Stop 0
-- write-up and notes/fr-3-investigation.md §2 for the full FK inventory.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_field_with_cleanup(
  p_field_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_user_id                 UUID;
  v_field_name              TEXT;
  v_table_id                UUID;
  v_table_name              TEXT;
  v_project_id              UUID;
  v_tfm_count               INT;
  v_ms_count                INT;
  v_txn_count               INT;
  v_staged_scrubbed         INT := 0;
  v_ack_legacy              INT;
  v_ack_new                 INT;
  v_coverage_count          INT;
  v_validation_rules_count  INT;
  v_had_authored_sql        BOOLEAN;
  v_tm                      RECORD;
  v_scrubbed_one            INT;
BEGIN
  -- 1. Authentication
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Resolve field + parent table + project
  SELECT f.name, f.table_id, t.name, d.project_id
    INTO v_field_name, v_table_id, v_table_name, v_project_id
  FROM public.fields f
  JOIN public.tables   t ON t.id = f.table_id
  JOIN public.datasets d ON d.id = t.dataset_id
  WHERE f.id = p_field_id;

  IF v_field_name IS NULL THEN
    RAISE EXCEPTION 'Field not found' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Permission re-assertion (RPC must not trust client guard)
  IF NOT public.user_has_project_role(v_project_id, 'editor') THEN
    RAISE EXCEPTION 'Insufficient permissions for project' USING ERRCODE = '42501';
  END IF;

  -- 4. Compute cascade counts BEFORE the delete (rows vanish after)
  SELECT count(*) INTO v_tfm_count
    FROM public.target_field_mappings WHERE target_field_id = p_field_id;

  SELECT count(*) INTO v_ms_count
    FROM public.mapping_sources WHERE source_field_id = p_field_id;

  SELECT count(*) INTO v_txn_count
    FROM public.transformations tx
    JOIN public.target_field_mappings tfm ON tx.target_field_mapping_id = tfm.id
    WHERE tfm.target_field_id = p_field_id;

  -- "Authored" = at least one transformation row whose is_ai_generated = false
  -- (per lib/actions/transformations.ts:1514 — the flag flips to false on
  -- human edit). This signal goes into the activity-log payload so audit
  -- trails capture when a delete destroyed user-authored SQL.
  SELECT EXISTS (
    SELECT 1
    FROM public.transformations tx
    JOIN public.target_field_mappings tfm ON tx.target_field_mapping_id = tfm.id
    WHERE tfm.target_field_id = p_field_id
      AND tx.is_ai_generated = FALSE
  ) INTO v_had_authored_sql;

  SELECT count(*) INTO v_ack_legacy
    FROM public.field_acknowledgments WHERE field_id = p_field_id;

  SELECT count(*) INTO v_ack_new
    FROM public.source_field_acknowledgments WHERE source_field_id = p_field_id;

  SELECT count(*) INTO v_coverage_count
    FROM public.target_field_coverage WHERE target_field_id = p_field_id;

  -- Added in migration 100: field-scoped validation_rules count.
  -- Nullable FK on validation_rules.field_id (006:10) means table- /
  -- project-scoped rules are correctly excluded by the WHERE clause.
  SELECT count(*) INTO v_validation_rules_count
    FROM public.validation_rules WHERE field_id = p_field_id;

  -- 5. Scrub orphaned JSONB keys in staged_data_rows.
  -- Must run BEFORE the field DELETE so we still know v_field_name and
  -- the table_mappings that target the field's parent table. The FK
  -- cascade through target_field_mappings does NOT touch staged rows
  -- (staged_data_rows references table_mappings, not fields).
  FOR v_tm IN
    SELECT id FROM public.table_mappings WHERE target_table_id = v_table_id
  LOOP
    UPDATE public.staged_data_rows
    SET transformed_row_data = transformed_row_data - v_field_name
    WHERE table_mapping_id = v_tm.id
      AND transformed_row_data ? v_field_name;
    GET DIAGNOSTICS v_scrubbed_one = ROW_COUNT;
    v_staged_scrubbed := v_staged_scrubbed + v_scrubbed_one;
  END LOOP;

  -- 6. Hard delete; FK CASCADEs handle TFMs, mapping_sources, transformations,
  -- field_profiles, quality_issues, validation_rules, field_acknowledgments,
  -- source_field_acknowledgments, target_field_coverage,
  -- project_data_quality_issues. See notes/fr-3-investigation.md §2.
  DELETE FROM public.fields WHERE id = p_field_id;

  -- 7. Return the audit summary
  RETURN jsonb_build_object(
    'project_id',                   v_project_id,
    'table_id',                     v_table_id,
    'table_name',                   v_table_name,
    'field_name',                   v_field_name,
    'cascade_counts', jsonb_build_object(
      'target_field_mappings',      v_tfm_count,
      'mapping_sources',            v_ms_count,
      'transformations',            v_txn_count,
      'staged_rows_scrubbed',       v_staged_scrubbed,
      'acknowledgments',            v_ack_legacy + v_ack_new,
      'coverage_rows',              v_coverage_count,
      'validation_rules',           v_validation_rules_count
    ),
    'had_authored_transform_sql',   v_had_authored_sql
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_field_with_cleanup(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_field_with_cleanup(UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_field_with_cleanup(UUID) IS
  'Atomic schema field deletion. Re-asserts auth + editor role, scrubs orphaned JSONB keys from staged_data_rows.transformed_row_data, then DELETEs the field (FK CASCADEs handle the rest). Returns a JSONB summary with project_id, cascade counts (incl. validation_rules — migration 100), and had_authored_transform_sql for the caller to revalidatePath and emit a single field_deleted activity_log entry. See notes/fr-3-investigation.md + notes/fr-3-validation-rules-investigation.md.';
