-- ============================================================================
-- Migration 075 — Restore needs_transformation on target_field_mappings
-- ============================================================================
-- Ships alongside Prompt 3b (transformations.ts + fk-cascade.ts rewrite).
--
-- Why
--   The field_mappings table was dropped in migration 074, which removed
--   the needs_transformation column with it. Without a successor column
--   the Transform tab loses the user-driven "dismiss transform" toggle,
--   FK cascade loses the flag path that surfaces dependent FK fields in
--   the sidebar after a PK transform is applied, and downstream readers
--   (outputs.ts, execution-package.ts, resolved-by-transform.ts) lose
--   their "transform is not needed, this field is resolved" signal.
--
--   This migration adds the column back on target_field_mappings and
--   backfills it from field_mappings_backup_074 via a (project_id,
--   target_field_id) join over the primary FMs (is_contributing = false).
--   Contributor FMs never carried an independent needs_transformation in
--   practice — primaries set the flag at the target-field level — so they
--   are excluded from the backfill by construction.
--
-- Semantics preserved exactly
--   NULL  = not yet assessed (no primary FM ever set a value)
--   TRUE  = AI assessment or FK cascade flagged this target as needing a
--           transform
--   FALSE = user explicitly dismissed the transform requirement
--
-- Scope restrictions (applied to both backfill and the STEP 5 assertion)
--
--   (1) Reject status filter on the backup source
--       `fm.status != 'rejected'` on field_mappings_backup_074.
--
--       Rejected primary FMs represent abandoned mapping proposals. Their
--       needs_transformation values — if any — should not carry forward to
--       the live TFM record because the user already said "no, don't use
--       this mapping." Including them in the aggregation would let a dead
--       proposal influence a live TFM's flag. If a particular
--       (project, target_field) group has ONLY rejected primaries in the
--       backup, the corresponding TFM will receive NULL (not assessed),
--       which is the correct signal for "nothing live to carry over."
--
--   (2) Acknowledged destination filter on the UPDATE target
--       `NOT tfm.is_acknowledged` on target_field_mappings.
--
--       Acknowledged TFMs represent "this target field will not be
--       migrated." needs_transformation has no meaning on such rows — the
--       Transform tab does not surface them, FK cascade does not touch
--       them, and downstream readers skip them. Writing a flag onto an
--       acknowledged TFM would be functionally inert but semantically
--       noisy, so we skip them entirely.
--
-- Conflict resolution
--   A single TFM in the new model can correspond to multiple primary
--   FMs in the backup (same (project, target_field) but different TMs
--   collapse into one TFM via the UNIQUE (project_id, target_field_id)
--   constraint from migration 074).
--
--   Backfill uses BOOL_OR with the WHERE clause filtering out NULLs AND
--   rejected rows BEFORE aggregation, which resolves conflicts as follows:
--     - If ANY surviving primary FM had TRUE → TFM = TRUE
--     - If all surviving primary FMs had FALSE → TFM = FALSE
--     - If no surviving primary FMs exist for the group → TFM stays NULL
--
-- Execution order
--   Maintenance mode STAYS TRUE throughout. DDL migrations run as DB
--   superuser (founder executing via Supabase SQL editor as project
--   owner); the maintenance_mode flag only gates application-layer
--   writes via assertMappingWritesEnabled() in lib/auth/mapping-writes.ts
--   and has no effect on direct SQL execution.
--
--   Sequence:
--     1. Run this migration in Supabase SQL editor.
--     2. Deploy Prompt 3b code against the updated schema.
--     3. Unlock maintenance mode only after the full Phase 2 rollout
--        (Prompts 3b + 3c + 3d) has shipped and been smoke-tested.
--
-- Rollback
--   Everything below runs inside a single BEGIN/COMMIT block. If any
--   assertion in STEP 1 or STEP 5 raises, the transaction aborts and
--   the schema is identical to its post-074 state. The founder may
--   then investigate the discrepancy and re-run.
--
-- Verification queries (after successful execution)
--   SELECT COUNT(*) FROM public.target_field_mappings
--     WHERE needs_transformation IS NOT NULL;
--   SELECT needs_transformation, COUNT(*)
--     FROM public.target_field_mappings
--     GROUP BY needs_transformation
--     ORDER BY needs_transformation NULLS LAST;
-- ============================================================================

BEGIN;

-- ── STEP 1 — Pre-migration assertions ────────────────────────────────────────
-- Confirm the 074 backup still exists and carries rows. If it has been
-- dropped or truncated we refuse to proceed — the backfill has nothing
-- authoritative to source from.

DO $$
DECLARE
  v_backup_exists BOOLEAN;
  v_backup_count  INT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'field_mappings_backup_074'
  ) INTO v_backup_exists;

  IF NOT v_backup_exists THEN
    RAISE EXCEPTION
      'STEP 1: field_mappings_backup_074 is missing; migration 074 must have completed before 075 runs';
  END IF;

  SELECT COUNT(*) INTO v_backup_count
  FROM public.field_mappings_backup_074;

  IF v_backup_count = 0 THEN
    RAISE EXCEPTION
      'STEP 1: field_mappings_backup_074 is empty; refusing to backfill from nothing';
  END IF;

  RAISE NOTICE 'STEP 1: backup table present with % rows', v_backup_count;
END $$;

-- ── STEP 2 — Pre-backfill distribution snapshot ──────────────────────────────
-- Emit a NOTICE with the primary-FM distribution so the founder can eyeball
-- it at execution time and cross-check against the post-backfill NOTICE in
-- STEP 5.
--
-- Scope caveat:
--   This snapshot shows ALL primary FMs in the backup (is_contributing=false).
--   The backfill (STEP 4) additionally filters out `status = 'rejected'` rows
--   and the UPDATE additionally skips acknowledged TFMs, so STEP 2 totals
--   should read as an UPPER BOUND on what can appear on TFMs after STEP 5.
--   A divergence between STEP 2 and STEP 5 is expected and should match the
--   volume of rejected primary FMs + primary FMs whose target TFM is
--   acknowledged (if any).

DO $$
DECLARE
  v_true_count  INT;
  v_false_count INT;
  v_null_count  INT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE fm.needs_transformation IS TRUE),
    COUNT(*) FILTER (WHERE fm.needs_transformation IS FALSE),
    COUNT(*) FILTER (WHERE fm.needs_transformation IS NULL)
  INTO v_true_count, v_false_count, v_null_count
  FROM public.field_mappings_backup_074 fm
  WHERE fm.is_contributing = false;

  RAISE NOTICE
    'STEP 2: pre-backfill distribution on field_mappings_backup_074 (primaries only, unfiltered) — true=%, false=%, null=%',
    v_true_count, v_false_count, v_null_count;
END $$;

-- ── STEP 3 — Add the column (default NULL preserves "not assessed") ──────────
-- Nullable, no default beyond NULL. Additive and idempotent-friendly:
-- IF NOT EXISTS keeps a manual re-run from failing if the column already
-- exists from a prior partial execution (in practice the BEGIN/COMMIT
-- block would have rolled back, but the guard is cheap insurance).

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS needs_transformation BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN public.target_field_mappings.needs_transformation IS
  'User/AI assessment of whether this target field needs a transformation. '
  'NULL = not assessed, TRUE = flagged (AI or FK cascade), FALSE = user dismissed. '
  'Restored in migration 075 from field_mappings_backup_074 via BOOL_OR over '
  'primary FMs keyed on (project_id, target_field_id).';

-- ── STEP 4 — Backfill from backup ────────────────────────────────────────────
-- BOOL_OR handles the (possible) case of multiple primary FMs across
-- different TMs collapsing into one TFM. The CTE's WHERE clause applies
-- three filters BEFORE aggregation:
--
--   (a) is_contributing = false
--       Only primaries carried needs_transformation in the legacy model.
--       Contributor rows are excluded by construction.
--
--   (b) needs_transformation IS NOT NULL
--       Rows with NULL input produce no contribution to the BOOL_OR. Groups
--       with zero non-null inputs yield zero aggregation rows, which means
--       the TFM's needs_transformation stays NULL (correct: "nothing to
--       carry over").
--
--   (c) status != 'rejected'        [REVISION — 2026-04-22]
--       Rejected primary FMs represent abandoned proposals. Their flag
--       should not influence live TFMs. See header for full rationale.
--
-- The UPDATE applies one additional filter:
--
--   (d) NOT tfm.is_acknowledged     [REVISION — 2026-04-22]
--       Acknowledged TFMs are out of scope for needs_transformation. Any
--       acknowledged TFM whose corresponding (project, target_field) group
--       in the backup had a non-null primary is silently skipped — it will
--       retain NULL, which is semantically correct for "this field will
--       not be migrated." See header for full rationale.

WITH agg AS (
  SELECT
    tm.project_id,
    fm.target_field_id,
    BOOL_OR(fm.needs_transformation) AS nt
  FROM public.field_mappings_backup_074 fm
  JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
  WHERE fm.is_contributing           = false
    AND fm.needs_transformation IS NOT NULL
    AND fm.status                   != 'rejected'
  GROUP BY tm.project_id, fm.target_field_id
)
UPDATE public.target_field_mappings tfm
SET needs_transformation = agg.nt
FROM agg
WHERE agg.project_id      = tfm.project_id
  AND agg.target_field_id = tfm.target_field_id
  AND NOT tfm.is_acknowledged;

-- ── STEP 5 — Post-backfill verification + distribution NOTICE ────────────────
-- Two checks in one DO block:
--   (a) count assertion — the number of TFMs carrying a non-null
--       needs_transformation after the UPDATE must match the number of
--       distinct (project_id, target_field_id) groups in the backup that
--       had at least one non-null primary FM AND correspond to a live,
--       non-acknowledged TFM. Mismatch aborts the transaction.
--
--       The expected-count query mirrors STEP 4's filters exactly:
--         - fm.is_contributing = false
--         - fm.needs_transformation IS NOT NULL
--         - fm.status != 'rejected'            [REVISION — 2026-04-22]
--         - NOT tfm.is_acknowledged            [REVISION — 2026-04-22]
--       The join against target_field_mappings also drops any backup group
--       that no longer has a corresponding live TFM (defensive — not
--       expected with the current 074 outcome, but cheap insurance).
--
--   (b) distribution NOTICE — true/false/null split on the new column,
--       printed alongside the STEP 2 pre-backfill snapshot for a quick
--       before/after eyeball. Expected to be strictly ≤ STEP 2 totals at
--       (project, target_field) granularity because STEP 4 filters
--       rejected primaries and acknowledged TFMs out.

DO $$
DECLARE
  v_expected_nonnull    INT;
  v_actual_nonnull      INT;
  v_true_count_post     INT;
  v_false_count_post    INT;
  v_null_count_post     INT;
BEGIN
  SELECT COUNT(DISTINCT (tm.project_id, fm.target_field_id))
    INTO v_expected_nonnull
  FROM public.field_mappings_backup_074 fm
  JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
  JOIN public.target_field_mappings tfm
    ON tfm.project_id      = tm.project_id
   AND tfm.target_field_id = fm.target_field_id
  WHERE fm.is_contributing           = false
    AND fm.needs_transformation IS NOT NULL
    AND fm.status                   != 'rejected'
    AND NOT tfm.is_acknowledged;

  SELECT COUNT(*) INTO v_actual_nonnull
  FROM public.target_field_mappings
  WHERE needs_transformation IS NOT NULL;

  IF v_actual_nonnull <> v_expected_nonnull THEN
    RAISE EXCEPTION
      'STEP 5: backfill count mismatch — expected % TFM rows with non-null needs_transformation, got %',
      v_expected_nonnull, v_actual_nonnull;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE needs_transformation IS TRUE),
    COUNT(*) FILTER (WHERE needs_transformation IS FALSE),
    COUNT(*) FILTER (WHERE needs_transformation IS NULL)
  INTO v_true_count_post, v_false_count_post, v_null_count_post
  FROM public.target_field_mappings;

  RAISE NOTICE
    'STEP 5: post-backfill distribution on target_field_mappings.needs_transformation — true=%, false=%, null=%',
    v_true_count_post, v_false_count_post, v_null_count_post;

  RAISE NOTICE
    'STEP 5: backfill verified — % TFMs carry a non-null needs_transformation',
    v_actual_nonnull;
END $$;

COMMIT;
