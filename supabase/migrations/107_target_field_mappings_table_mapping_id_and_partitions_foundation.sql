-- ============================================================================
-- Migration 107 — PR Ω.1 — Partition primitive foundation (data model only)
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   1. Adds target_field_mappings.table_mapping_id (FK → table_mappings.id)
--      so a target field's mapping is bound to a specific (source, target)
--      table-pair — i.e. a "partition."
--   2. Adds table_mappings.filter_sql (TEXT NULL) — the per-partition row
--      filter applied by the apply path in PR Ω.2. NULL in this PR.
--   3. Adds projects.partitions_enabled (BOOLEAN NOT NULL DEFAULT false) —
--      per-project feature gate read by UI/AI in PR Ω.3.
--   4. Backfills target_field_mappings.table_mapping_id deterministically.
--   5. Replaces UNIQUE (project_id, target_field_id) with
--      UNIQUE (project_id, target_field_id, table_mapping_id) so a single
--      target field can hold multiple TFMs across different partitions.
--   6. Updates dq_create_target_field_mapping to accept p_table_mapping_id.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - No RLS policy changes.
--   - No apply-path RPC (dq_apply_field_transform_joined) changes.
--   - No UI behavior changes.
--   - No mutation of mapping_sources, transformations, or
--     source_field_acknowledgments.
--
-- KNOWN BRIEF OUTAGE
--   Between when this migration applies and when the application-code change
--   (mapping-engine.ts passes p_table_mapping_id) deploys, any call to
--   dq_create_target_field_mapping that omits the new param will INSERT NULL
--   into target_field_mappings.table_mapping_id and fail the NOT NULL
--   constraint added in step 6. This is intentional — fail loud rather than
--   silently corrupt. Mapping_generate is user-triggered and low-traffic;
--   deploy the code change immediately after this migration applies.
--
-- ROLLBACK
--   See supabase/migrations/108_revert_omega_1.sql. Only valid before any
--   project has >1 TFM per (project_id, target_field_id) — i.e. before
--   PR Ω.3 ships and partitions become user-creatable.
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 1 — Additive columns
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.target_field_mappings
  ADD COLUMN table_mapping_id UUID
  REFERENCES public.table_mappings(id) ON DELETE CASCADE;

ALTER TABLE public.table_mappings
  ADD COLUMN filter_sql TEXT;

COMMENT ON COLUMN public.table_mappings.filter_sql IS
  'Per-partition WHERE clause appended to the apply-path INSERT. NULL = no '
  'filter (whole source). Populated by PR Ω.3 partition creation UI. '
  'Honored by the apply path starting in PR Ω.2.';

ALTER TABLE public.projects
  ADD COLUMN partitions_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.projects.partitions_enabled IS
  'Per-project feature gate for the partition primitive (PR Ω.1+). When '
  'false (default), UI and AI behave as single-partition. Flip to true '
  'for Rootstock pilot and other multi-partition projects.';

-- ──────────────────────────────────────────────────────────────────────────
-- Step 2 — Pre-flight invariants (raise to roll back the txn cleanly)
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_dup_tm_count          INT;
  v_orphan_tfm_count      INT;
  v_multi_ord_zero_count  INT;
BEGIN
  -- (a) No duplicate (project_id, source_table_id, target_table_id) TMs.
  SELECT COUNT(*) INTO v_dup_tm_count
  FROM (
    SELECT 1
    FROM public.table_mappings
    GROUP BY project_id, source_table_id, target_table_id
    HAVING COUNT(*) > 1
  ) dups;
  IF v_dup_tm_count > 0 THEN
    RAISE EXCEPTION
      'Pre-flight (a) failed: % duplicate (project, source, target) TM group(s) found. '
      'Resolve duplicates before re-running migration 107.', v_dup_tm_count;
  END IF;

  -- (b) Every TFM's target_field.tables.id has at least one TM in the same project.
  SELECT COUNT(*) INTO v_orphan_tfm_count
  FROM public.target_field_mappings tfm
  JOIN public.fields tgt ON tgt.id = tfm.target_field_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.table_mappings tm
    WHERE tm.project_id      = tfm.project_id
      AND tm.target_table_id = tgt.table_id
  );
  IF v_orphan_tfm_count > 0 THEN
    RAISE EXCEPTION
      'Pre-flight (b) failed: % TFM(s) reference a target table with no table_mapping '
      'row in the same project. Seed table_mappings first (see PR γ'' loader pattern), '
      'then re-run migration 107.', v_orphan_tfm_count;
  END IF;

  -- (c) No TFM has multiple mapping_sources rows with ordinal=0.
  --     Anomaly check — should not happen, but the backfill picks via LIMIT 1
  --     so failing loud here is preferable to a silent wrong-bind.
  SELECT COUNT(*) INTO v_multi_ord_zero_count
  FROM (
    SELECT 1
    FROM public.mapping_sources
    WHERE ordinal = 0
    GROUP BY target_field_mapping_id
    HAVING COUNT(*) > 1
  ) multi_ord;
  IF v_multi_ord_zero_count > 0 THEN
    RAISE EXCEPTION
      'Pre-flight (c) failed: % TFM(s) have multiple ordinal=0 mapping_sources rows. '
      'Investigate and collapse to a single primary source before re-running.',
      v_multi_ord_zero_count;
  END IF;
END$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 3 — Backfill #1: TFMs WITH mapping_sources (dominant path)
-- ──────────────────────────────────────────────────────────────────────────
-- Bind to the TM whose source_table_id matches the ordinal=0 mapping source's
-- source table AND whose target_table_id matches the TFM's target field's
-- table. Mirrors buildJoinSpec's dominant-selection algorithm at
-- lib/utils/transform-cross-table.ts:274.

UPDATE public.target_field_mappings tfm
   SET table_mapping_id = subq.tm_id
  FROM (
    SELECT
      tfm2.id AS tfm_id,
      tm.id   AS tm_id
    FROM public.target_field_mappings tfm2
    JOIN public.mapping_sources ms
         ON ms.target_field_mapping_id = tfm2.id
        AND ms.ordinal = 0
    JOIN public.fields tgt
         ON tgt.id = tfm2.target_field_id
    JOIN public.table_mappings tm
         ON tm.project_id      = tfm2.project_id
        AND tm.source_table_id = ms.source_table_id
        AND tm.target_table_id = tgt.table_id
  ) subq
 WHERE tfm.id = subq.tfm_id
   AND tfm.table_mapping_id IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 4 — Backfill #2: TFMs WITHOUT mapping_sources (VA / ack path)
-- ──────────────────────────────────────────────────────────────────────────
-- Bind to the deterministically-lowest TM for the target_field's table.
-- Tiebreaker: created_at ASC, then id ASC.
--
-- NOTE — VA semantics unchanged in Ω.1:
--   This bind is metadata-only. The apply path's value-assignment loop at
--   lib/actions/transformations.ts:2640-2670 iterates every TM matching the
--   target table regardless of table_mapping_id, so VA writes still fan out
--   across all partitions for N=1 projects. PR Ω.3 introduces a bulk-action
--   UX (per /tmp/pr-omega-design.md addendum) that lets a user opt to apply
--   a VA across all sibling partitions. The bind here is a structural
--   anchor, not a semantic claim that "this VA belongs only to partition X."

UPDATE public.target_field_mappings tfm
   SET table_mapping_id = subq.tm_id
  FROM (
    SELECT DISTINCT ON (tfm2.id)
      tfm2.id AS tfm_id,
      tm.id   AS tm_id
    FROM public.target_field_mappings tfm2
    JOIN public.fields tgt
         ON tgt.id = tfm2.target_field_id
    JOIN public.table_mappings tm
         ON tm.project_id      = tfm2.project_id
        AND tm.target_table_id = tgt.table_id
    WHERE tfm2.table_mapping_id IS NULL
    ORDER BY tfm2.id, tm.created_at ASC, tm.id ASC
  ) subq
 WHERE tfm.id = subq.tfm_id
   AND tfm.table_mapping_id IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 5 — Verify-no-NULL
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO v_orphan_count
  FROM public.target_field_mappings
  WHERE table_mapping_id IS NULL;
  IF v_orphan_count > 0 THEN
    RAISE EXCEPTION
      'Backfill incomplete: % TFM(s) have NULL table_mapping_id after both backfill '
      'passes. Investigate before re-running.', v_orphan_count;
  END IF;
END$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 6 — Tighten constraints
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.target_field_mappings
  ALTER COLUMN table_mapping_id SET NOT NULL;

ALTER TABLE public.target_field_mappings
  DROP CONSTRAINT target_field_mappings_project_id_target_field_id_key;

ALTER TABLE public.target_field_mappings
  ADD CONSTRAINT target_field_mappings_partition_unique
  UNIQUE (project_id, target_field_id, table_mapping_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Step 7 — Helpful index
-- ──────────────────────────────────────────────────────────────────────────

CREATE INDEX idx_target_field_mappings_table_mapping_id
  ON public.target_field_mappings(table_mapping_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Step 8 — Update dq_create_target_field_mapping to accept p_table_mapping_id
-- ──────────────────────────────────────────────────────────────────────────
-- Mirrors the pattern in migration 092: DROP the old (UUID, UUID, JSONB,
-- JSONB, UUID) signature, then CREATE the new (UUID, UUID, JSONB, JSONB,
-- UUID, UUID) form with p_table_mapping_id appended.
--
-- p_table_mapping_id defaults to NULL for Postgres signature compatibility,
-- but writing NULL is now rejected by the NOT NULL constraint added above.
-- Callers MUST pass it; failure surfaces as a clear constraint violation.

DROP FUNCTION IF EXISTS public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID);

CREATE OR REPLACE FUNCTION public.dq_create_target_field_mapping(
  p_project_id        UUID,
  p_target_field_id   UUID,
  p_sources           JSONB,
  p_combination       JSONB,
  p_experiment_run_id UUID DEFAULT NULL,
  p_table_mapping_id  UUID DEFAULT NULL
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
    project_id, target_field_id, table_mapping_id, confidence, status, ai_reasoning,
    is_acknowledged, combination_type, combination_sql, experiment_run_id
  ) VALUES (
    p_project_id, p_target_field_id, p_table_mapping_id, v_confidence, 'needs_review', v_ai_reasoning,
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

COMMENT ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID, UUID) IS
  'Atomically creates a target_field_mapping with its mapping_sources children. '
  'Used by the redesigned mapping server actions (Phase 3+). '
  'p_experiment_run_id (default NULL) tags the TFM with the INF-22 experiment run. '
  'p_table_mapping_id (default NULL) binds the TFM to a specific partition (PR Ω.1+). '
  'Callers MUST pass p_table_mapping_id — the NOT NULL constraint on '
  'target_field_mappings.table_mapping_id will reject NULL writes.';

GRANT EXECUTE ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID, UUID)
  TO authenticated, service_role;

COMMIT;
