-- ============================================================================
-- Migration 109 — PR Ω.1 ROLLBACK (forward-revert of migration 107)
-- ============================================================================
--
-- Renumbered from 108 → 109 in PR Ω.2.0 to clear a slot collision with
-- 108_schema_documents_by_project_policies.sql (PR #186, applied to prod).
-- This rollback file has never been applied; the rename has no prod impact.
--
--
-- WHAT THIS MIGRATION DOES
--   Reverses migration 107 in full:
--     1. Drops the partition-aware UNIQUE constraint and restores the
--        original UNIQUE (project_id, target_field_id).
--     2. Drops the new index on target_field_mappings.table_mapping_id.
--     3. Drops the columns added by 107:
--          - target_field_mappings.table_mapping_id
--          - table_mappings.filter_sql
--          - projects.partitions_enabled
--     4. Reverts dq_create_target_field_mapping to its migration 092
--        signature (5 params, no p_table_mapping_id).
--
-- ────────────────────────────────────────────────────────────────────────────
-- HARD GATE — DO NOT APPLY THIS MIGRATION IF THE QUERY BELOW RETURNS ROWS.
-- ────────────────────────────────────────────────────────────────────────────
--
--   SELECT project_id, target_field_id, COUNT(*) AS n
--   FROM target_field_mappings
--   GROUP BY project_id, target_field_id
--   HAVING COUNT(*) > 1;
--
-- Expected output for safe rollback: zero rows.
--
-- Non-zero output means at least one project has >1 TFM per (project_id,
-- target_field_id) — i.e. partitions are in use. Re-adding the original
-- UNIQUE (project_id, target_field_id) constraint will fail, and there is
-- no automatic way to collapse N partition-TFMs down to 1 without losing
-- partition-specific mappings. In that case:
--
--   DO NOT APPLY 109. Fix forward with a new targeted migration.
--
-- ROLLBACK SEQUENCING
--   1. Revert the application-code PR first (mapping-engine.ts to NOT pass
--      p_table_mapping_id; types; audit annotations).
--   2. Wait for CI green and deploy.
--   3. Then apply this migration via Supabase Dashboard.
--
-- If 109 is applied before the code revert, the next call to
-- dq_create_target_field_mapping will pass 6 args to a function that now
-- accepts 5 → Postgres function-not-found error → mapping_generate fails.
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 1 — Final hard-gate enforcement (defense in depth)
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_partition_user_count INT;
BEGIN
  SELECT COUNT(*) INTO v_partition_user_count
  FROM (
    SELECT 1
    FROM public.target_field_mappings
    GROUP BY project_id, target_field_id
    HAVING COUNT(*) > 1
  ) multi;
  IF v_partition_user_count > 0 THEN
    RAISE EXCEPTION
      'Rollback aborted: % (project_id, target_field_id) group(s) have multiple '
      'TFM rows — partitions are in use. Re-adding the original UNIQUE '
      'constraint would fail. Fix forward with a new migration instead.',
      v_partition_user_count;
  END IF;
END$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 2 — Reverse the constraint swap
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.target_field_mappings
  DROP CONSTRAINT target_field_mappings_partition_unique;

ALTER TABLE public.target_field_mappings
  ADD CONSTRAINT target_field_mappings_project_id_target_field_id_key
  UNIQUE (project_id, target_field_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Step 3 — Drop the new index
-- ──────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.idx_target_field_mappings_table_mapping_id;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 4 — Relax NOT NULL, then drop the columns
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.target_field_mappings
  ALTER COLUMN table_mapping_id DROP NOT NULL;

ALTER TABLE public.target_field_mappings DROP COLUMN table_mapping_id;
ALTER TABLE public.table_mappings        DROP COLUMN filter_sql;
ALTER TABLE public.projects              DROP COLUMN partitions_enabled;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 5 — Revert dq_create_target_field_mapping to its 092 signature
-- ──────────────────────────────────────────────────────────────────────────
-- Drop the 6-param form introduced by 107, recreate the 5-param form from
-- migration 092 verbatim.

DROP FUNCTION IF EXISTS public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID, UUID);

CREATE OR REPLACE FUNCTION public.dq_create_target_field_mapping(
  p_project_id        UUID,
  p_target_field_id   UUID,
  p_sources           JSONB,
  p_combination       JSONB,
  p_experiment_run_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tfm_id            UUID;
  v_combination_type  TEXT;
  v_combination_sql   TEXT;
  v_confidence        NUMERIC(5,2);
  v_ai_reasoning      TEXT;
BEGIN
  IF NOT public.user_has_project_role(p_project_id, 'editor') THEN
    RAISE EXCEPTION 'dq_create_target_field_mapping: permission denied for project %', p_project_id;
  END IF;

  v_combination_type := p_combination->>'type';
  v_combination_sql  := p_combination->>'sql';
  v_ai_reasoning     := p_combination->>'ai_reasoning';

  IF v_combination_type NOT IN ('single', 'concat_space', 'concat_comma', 'custom_sql') THEN
    RAISE EXCEPTION 'dq_create_target_field_mapping: invalid combination_type %', v_combination_type;
  END IF;

  IF v_combination_type = 'custom_sql' THEN
    v_confidence := NULLIF(p_combination->>'confidence', '')::NUMERIC(5,2);
  ELSE
    v_confidence := NULL;
  END IF;

  INSERT INTO public.target_field_mappings (
    project_id, target_field_id, confidence, status, ai_reasoning,
    is_acknowledged, combination_type, combination_sql, experiment_run_id
  ) VALUES (
    p_project_id, p_target_field_id, v_confidence, 'needs_review', v_ai_reasoning,
    FALSE, v_combination_type, v_combination_sql, p_experiment_run_id
  )
  RETURNING id INTO v_tfm_id;

  IF jsonb_typeof(p_sources) = 'array' AND jsonb_array_length(p_sources) > 0 THEN
    INSERT INTO public.mapping_sources (
      target_field_mapping_id, source_field_id, source_table_id,
      confidence, ai_reasoning, similar_fields_considered, type_compatibility,
      join_spec, ordinal
    )
    SELECT
      v_tfm_id,
      NULLIF(s->>'source_field_id', '')::UUID,
      NULLIF(s->>'source_table_id', '')::UUID,
      NULLIF(s->>'confidence', '')::NUMERIC(5,2),
      s->>'ai_reasoning',
      s->'similar_fields_considered',
      s->>'type_compatibility',
      CASE WHEN s ? 'join_spec' AND jsonb_typeof(s->'join_spec') <> 'null'
           THEN s->'join_spec' ELSE NULL END,
      COALESCE(NULLIF(s->>'ordinal', '')::INT, 0)
    FROM jsonb_array_elements(p_sources) AS s;
  END IF;

  RETURN v_tfm_id;
END;
$$;

COMMENT ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID) IS
  'Atomically creates a target_field_mapping with its mapping_sources children. '
  'Used by the redesigned mapping server actions (Phase 3+). The optional '
  'p_experiment_run_id parameter (default NULL) tags the TFM with the '
  'INF-22 experiment run; manual / suggest flows omit it and write NULL.';

GRANT EXECUTE ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID)
  TO authenticated, service_role;

COMMIT;
