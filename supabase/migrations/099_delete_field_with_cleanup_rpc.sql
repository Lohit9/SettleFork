-- ============================================================
-- Migration 099 — delete_field_with_cleanup RPC
-- ============================================================
-- Atomic SECURITY DEFINER RPC for hard-deleting a schema field from the
-- Schema Overview tab. Wraps the JSONB scrub + field DELETE in a single
-- transaction so the orphaned-key window is closed (see notes/fr-3-investigation.md §3).
--
-- Steps inside the transaction:
--   1. auth.uid() — reject unauthenticated callers (28000)
--   2. Resolve field, parent table, project; reject if missing (P0001)
--   3. Re-assert caller has 'editor' role on the project (42501) —
--      do not trust the client guard alone
--   4. Compute cascade counts and had_authored_transform_sql BEFORE
--      the field DELETE (the FK CASCADE removes the rows after)
--   5. For every table_mapping whose target_table_id = field.table_id,
--      strip the field's name from staged_data_rows.transformed_row_data
--      using the JSONB minus operator. The DB FK CASCADE through
--      target_field_mappings DOES NOT do this — staged_data_rows has
--      no FK to fields, only an FK on table_mapping_id, and the JSONB
--      is keyed by field name (not id). See migration 054 for the
--      single-TFM precedent (revert_field_transform).
--   6. DELETE FROM fields — cascades cleanly through every dependent
--      table per FK inventory (notes/fr-3-investigation.md §2)
--   7. RETURN a JSONB summary so the caller can:
--        (a) revalidatePath using project_id
--        (b) emit a single 'field_deleted' activity_log entry with
--            cascade counts in metadata
--
-- Why an RPC and not sequenced TS Supabase calls:
--   The scrub-then-delete sequence has 2..N steps. A failure between
--   scrub and delete leaves staged rows missing keys but the field
--   alive — inconsistent. CLAUDE.md §4.4 mandates SECURITY DEFINER
--   RPCs for multi-statement writes; updateField predates that
--   convention but a multi-table cascade should not propagate the
--   deviation.
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
  v_user_id            UUID;
  v_field_name         TEXT;
  v_table_id           UUID;
  v_table_name         TEXT;
  v_project_id         UUID;
  v_tfm_count          INT;
  v_ms_count           INT;
  v_txn_count          INT;
  v_staged_scrubbed    INT := 0;
  v_ack_legacy         INT;
  v_ack_new            INT;
  v_coverage_count     INT;
  v_had_authored_sql   BOOLEAN;
  v_tm                 RECORD;
  v_scrubbed_one       INT;
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
      'coverage_rows',              v_coverage_count
    ),
    'had_authored_transform_sql',   v_had_authored_sql
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_field_with_cleanup(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_field_with_cleanup(UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_field_with_cleanup(UUID) IS
  'Atomic schema field deletion. Re-asserts auth + editor role, scrubs orphaned JSONB keys from staged_data_rows.transformed_row_data, then DELETEs the field (FK CASCADEs handle the rest). Returns a JSONB summary with project_id, cascade counts, and had_authored_transform_sql for the caller to revalidatePath and emit a single field_deleted activity_log entry. See notes/fr-3-investigation.md.';
