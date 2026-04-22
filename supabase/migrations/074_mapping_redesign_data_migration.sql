-- ============================================================================
-- Migration 074 — Mapping redesign: data model migration
-- ============================================================================
--
-- Purpose
-- -------
-- Migrate production mapping data from the legacy two-table model
--   (field_mappings with is_contributing hierarchy + field_acknowledgments
--    with side = 'source' | 'target')
-- to the new three-table model
--   (target_field_mappings + mapping_sources + source_field_acknowledgments)
-- and re-point transformations.field_mapping_id → target_field_mapping_id.
--
-- Why
-- ---
-- The legacy model cannot express cross-table field mappings (a target field
-- sourced from fields across multiple source tables joined by FKs). The new
-- model collapses the primary/contributing hierarchy into a flat
-- (target → many sources) relation with per-source join_spec, while keeping
-- value assignments and target-side acknowledgments as distinct shapes.
--
-- Atomicity
-- ---------
-- This migration is wrapped in a single BEGIN … COMMIT block. Every step is
-- transactional DDL/DML. If any assertion fails or any statement errors, the
-- entire migration rolls back and production is unchanged.
--
-- The migration also takes raw backups of the old tables (STEP 1) before any
-- destructive action, so even a *successful* commit can be audited or
-- recovered from for 60+ days post-deploy.
--
-- Rollback procedure
-- ------------------
-- If the migration fails mid-transaction: Postgres rolls back automatically.
-- If the migration commits but downstream issues surface: restore from the
-- STEP 1 backup tables (field_mappings_backup_074,
-- field_acknowledgments_backup_074) via a follow-up migration, or restore
-- the project from Supabase PITR (point-in-time recovery) to the moment
-- immediately before this migration executed.
--
-- Expected hardcoded counts (verified in STEP 13)
-- -----------------------------------------------
-- target_field_mappings WHERE NOT is_acknowledged  → 765
-- target_field_mappings WHERE     is_acknowledged  →  47  (49 total target acks − 2 overridden by existing value-assignment mappings in "Homegrown Legacy → Oracle ERP"; see block comment at STEP 13)
-- mapping_sources                                  → 776
-- source_field_acknowledgments                     →  11
-- transformations (unchanged count, all backfilled)→  57
-- field_mappings_backup_074                        → 778
-- field_acknowledgments_backup_074                 →  60
--
-- Post-migration verification queries (run after commit)
-- ------------------------------------------------------
--   SELECT COUNT(*) FROM target_field_mappings WHERE NOT is_acknowledged;
--   SELECT COUNT(*) FROM target_field_mappings WHERE     is_acknowledged;
--   SELECT COUNT(*) FROM mapping_sources;
--   SELECT COUNT(*) FROM source_field_acknowledgments;
--   SELECT COUNT(*) FROM transformations WHERE target_field_mapping_id IS NULL;
--   SELECT COUNT(*) FROM field_mappings_backup_074;
--   SELECT COUNT(*) FROM field_acknowledgments_backup_074;
--
-- PG compatibility: written for PostgreSQL 13+ (production is on 17.6).
-- ============================================================================

BEGIN;


-- ============================================================================
-- PRE-MIGRATION GATE — re-run integrity assertions inside the transaction
-- ============================================================================
-- These are the same assertions the founder ran at Gate 1. We re-run them
-- inside the transaction so that any drift between Gate 1 verification and
-- deploy-time aborts the migration atomically rather than corrupting data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT target_field_id, table_mapping_id,
             COUNT(*) FILTER (WHERE NOT is_contributing) AS primaries
      FROM public.field_mappings
      WHERE status <> 'rejected'
      GROUP BY target_field_id, table_mapping_id
    ) x WHERE primaries > 1
  ) THEN
    RAISE EXCEPTION 'PRE-MIGRATION GATE: target fields with >1 non-rejected primary mapping detected in field_mappings; aborting';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_mappings fm
    WHERE fm.is_contributing = true
      AND NOT EXISTS (
        SELECT 1 FROM public.field_mappings fm2
        WHERE fm2.target_field_id  = fm.target_field_id
          AND fm2.table_mapping_id = fm.table_mapping_id
          AND fm2.is_contributing  = false
      )
  ) THEN
    RAISE EXCEPTION 'PRE-MIGRATION GATE: contributing rows without a primary sibling detected in field_mappings; aborting';
  END IF;
END $$;


-- ============================================================================
-- STEP 1 — Defense-in-depth backup tables
-- ============================================================================
-- CREATE TABLE AS SELECT makes a full data snapshot (no indexes, no FKs, no
-- triggers) of the legacy tables. These are the last-resort recovery artifact
-- if something subtle goes wrong post-commit. A follow-up cleanup migration
-- should drop these tables ~60 days after stable operation confirms success.

CREATE TABLE public.field_mappings_backup_074 AS
  SELECT * FROM public.field_mappings;

COMMENT ON TABLE public.field_mappings_backup_074 IS
  'Raw snapshot of field_mappings taken by migration 074 immediately before the new-model data migration. Dropped in a future cleanup migration (~60 days post-deploy).';

CREATE TABLE public.field_acknowledgments_backup_074 AS
  SELECT * FROM public.field_acknowledgments;

COMMENT ON TABLE public.field_acknowledgments_backup_074 IS
  'Raw snapshot of field_acknowledgments taken by migration 074 immediately before the new-model data migration. Dropped in a future cleanup migration (~60 days post-deploy).';


-- ============================================================================
-- STEP 2 — Create new tables + indexes
-- ============================================================================

-- ── 2a. target_field_mappings ────────────────────────────────────────────────
-- One row per (project_id, target_field_id). Replaces the "primary
-- field_mapping" concept. Also absorbs target-side acknowledgments via
-- is_acknowledged = true.

CREATE TABLE public.target_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  target_field_id UUID NOT NULL REFERENCES public.fields(id)   ON DELETE CASCADE,

  -- For mapped targets: derived as MIN(mapping_sources.confidence) via trigger.
  -- For value assignments (combination_type='custom_sql' with zero sources):
  --   stored directly as AI-produced confidence, trigger does NOT overwrite.
  -- For acknowledged targets: NULL.
  confidence NUMERIC(5,2),

  status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review', 'approved', 'rejected')),
  ai_reasoning TEXT,

  -- Acknowledged-no-source state (replaces field_acknowledgments.side='target').
  is_acknowledged        BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledgment_reason  TEXT,

  -- Combination strategy for multi-source mappings and value assignments.
  combination_type TEXT
    CHECK (combination_type IN ('single', 'concat_space', 'concat_comma', 'custom_sql')),
  combination_sql  TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, target_field_id)
);

COMMENT ON TABLE  public.target_field_mappings IS
  'Primary mapping entity introduced in migration 074. One row per (project, target field). Replaces field_mappings primaries and target-side field_acknowledgments.';
COMMENT ON COLUMN public.target_field_mappings.confidence IS
  'Overall mapping confidence. Derived as MIN(mapping_sources.confidence) for mapped targets; direct-stored for value assignments; NULL for acknowledged targets.';
COMMENT ON COLUMN public.target_field_mappings.is_acknowledged IS
  'True when this row represents a user acknowledgment that the target field will not be migrated. Implies combination_type IS NULL and zero mapping_sources children.';
COMMENT ON COLUMN public.target_field_mappings.combination_type IS
  'single: exactly one mapping_source. concat_*: multi-source concat. custom_sql: value assignment (zero sources) or user-provided combination SQL.';

CREATE INDEX idx_target_field_mappings_project_id
  ON public.target_field_mappings (project_id);
CREATE INDEX idx_target_field_mappings_target_field_id
  ON public.target_field_mappings (target_field_id);
CREATE INDEX idx_target_field_mappings_status
  ON public.target_field_mappings (status);

-- ── 2b. mapping_sources ──────────────────────────────────────────────────────
-- Child of target_field_mappings. Each row is one source field contributing
-- to a target field mapping. Value assignments have zero mapping_sources.

CREATE TABLE public.mapping_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_field_mapping_id UUID NOT NULL
    REFERENCES public.target_field_mappings(id) ON DELETE CASCADE,

  -- Nullable to accommodate legacy value-assignment semantics defensively.
  -- In the new model, value assignments live on target_field_mappings and
  -- have zero mapping_sources rows, so these columns should always be
  -- populated in practice. Keeping them nullable matches the spec.
  source_field_id  UUID REFERENCES public.fields(id) ON DELETE CASCADE,
  source_table_id  UUID REFERENCES public.tables(id) ON DELETE CASCADE,

  confidence                NUMERIC(5,2),
  ai_reasoning              TEXT,
  similar_fields_considered JSONB,
  type_compatibility        TEXT,

  -- Join specification when this source is from a table different from the
  -- dominant (ordinal=0) source's table. NULL when source is on the dominant
  -- table. Exact JSON shape is finalized in Phase 3; storage-only here.
  join_spec JSONB,

  -- Ordinal for predictable concatenation order (0 = dominant source).
  ordinal INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (target_field_mapping_id, source_field_id)
);

COMMENT ON TABLE  public.mapping_sources IS
  'Child rows of target_field_mappings. Each row is one source field contributing to one target field mapping.';
COMMENT ON COLUMN public.mapping_sources.ordinal IS
  'Stable ordering within a target mapping. 0 = dominant source (anchor table for cross-table joins). Used for concat_* combination types.';
COMMENT ON COLUMN public.mapping_sources.join_spec IS
  'JSONB describing the FK join when source_table_id differs from the dominant source''s table. NULL for same-table sources. Final shape defined in Phase 3.';

CREATE INDEX idx_mapping_sources_target_field_mapping_id
  ON public.mapping_sources (target_field_mapping_id);
CREATE INDEX idx_mapping_sources_source_field_id
  ON public.mapping_sources (source_field_id)
  WHERE source_field_id IS NOT NULL;
CREATE INDEX idx_mapping_sources_source_table_id
  ON public.mapping_sources (source_table_id)
  WHERE source_table_id IS NOT NULL;

-- ── 2c. source_field_acknowledgments ─────────────────────────────────────────
-- Source-side acknowledgments (user declares a source field will not be
-- migrated). Used by recomputeTableMappingStatus to determine table-mapping
-- auto-approval eligibility.

CREATE TABLE public.source_field_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_field_id  UUID NOT NULL REFERENCES public.fields(id)   ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  notes            TEXT,
  acknowledged_by  UUID REFERENCES auth.users(id),
  acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, source_field_id)
);

COMMENT ON TABLE public.source_field_acknowledgments IS
  'Source-side field acknowledgments (user declares a source field will not be migrated). Replaces field_acknowledgments.side=''source'' rows.';

CREATE INDEX idx_source_field_acknowledgments_project_id
  ON public.source_field_acknowledgments (project_id);
CREATE INDEX idx_source_field_acknowledgments_source_field_id
  ON public.source_field_acknowledgments (source_field_id);


-- ============================================================================
-- STEP 3 — RLS policies on the three new tables
-- ============================================================================
-- Uses the org-based access helpers from migration 050:
--   public.user_can_access_project(project_id) — read access
--   public.user_has_project_role(project_id, 'editor') — write access
-- Security parity with the tables these replace is preserved exactly.

-- ── 3a. target_field_mappings — direct project_id on row ─────────────────────
ALTER TABLE public.target_field_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_target_field_mappings"
  ON public.target_field_mappings FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_target_field_mappings"
  ON public.target_field_mappings FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_target_field_mappings"
  ON public.target_field_mappings FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_target_field_mappings"
  ON public.target_field_mappings FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));

-- ── 3b. mapping_sources — hop through target_field_mappings for project_id ───
ALTER TABLE public.mapping_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_mapping_sources"
  ON public.mapping_sources FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_can_access_project(tfm.project_id)
  ));

CREATE POLICY "editors_insert_mapping_sources"
  ON public.mapping_sources FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));

CREATE POLICY "editors_update_mapping_sources"
  ON public.mapping_sources FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));

CREATE POLICY "editors_delete_mapping_sources"
  ON public.mapping_sources FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));

-- ── 3c. source_field_acknowledgments — direct project_id on row ──────────────
ALTER TABLE public.source_field_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_source_field_acknowledgments"
  ON public.source_field_acknowledgments FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_source_field_acknowledgments"
  ON public.source_field_acknowledgments FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_source_field_acknowledgments"
  ON public.source_field_acknowledgments FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_source_field_acknowledgments"
  ON public.source_field_acknowledgments FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));


-- ============================================================================
-- STEP 4 — Confidence recomputation trigger
-- ============================================================================
-- Recomputes target_field_mappings.confidence = MIN(mapping_sources.confidence)
-- whenever mapping_sources rows are inserted, updated, or deleted.
--
-- Skip rule (per Flag 3):
--   Skip recompute when:
--     (combination_type = 'custom_sql' AND is_acknowledged = false)
--     OR is_acknowledged = true
--   Recompute only when:
--     combination_type <> 'custom_sql' AND is_acknowledged = false
--
-- This preserves the direct-stored confidence of value assignments
-- (custom_sql with no sources) and acknowledged targets (no sources).

CREATE OR REPLACE FUNCTION public.recompute_target_field_mapping_confidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tfm_id UUID;
BEGIN
  v_tfm_id := COALESCE(NEW.target_field_mapping_id, OLD.target_field_mapping_id);

  UPDATE public.target_field_mappings tfm
  SET confidence = (
        SELECT MIN(ms.confidence)
        FROM public.mapping_sources ms
        WHERE ms.target_field_mapping_id = tfm.id
      ),
      updated_at = now()
  WHERE tfm.id = v_tfm_id
    AND NOT tfm.is_acknowledged
    AND tfm.combination_type IS DISTINCT FROM 'custom_sql';

  RETURN NULL;  -- AFTER trigger: return value is ignored
END;
$$;

COMMENT ON FUNCTION public.recompute_target_field_mapping_confidence() IS
  'Trigger function: recomputes parent target_field_mappings.confidence as MIN(mapping_sources.confidence). Skips value assignments (combination_type=custom_sql) and acknowledged targets.';

CREATE TRIGGER mapping_sources_confidence_recompute
  AFTER INSERT OR UPDATE OR DELETE ON public.mapping_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_target_field_mapping_confidence();


-- ============================================================================
-- STEP 5 — Add nullable target_field_mapping_id to transformations
-- ============================================================================
-- Kept alongside field_mapping_id temporarily so we can backfill before
-- dropping the old column in STEP 14. Nullable now; SET NOT NULL in STEP 14
-- after verification.

ALTER TABLE public.transformations
  ADD COLUMN target_field_mapping_id UUID
    REFERENCES public.target_field_mappings(id) ON DELETE CASCADE;

CREATE INDEX idx_transformations_target_field_mapping_id
  ON public.transformations(target_field_mapping_id);

COMMENT ON COLUMN public.transformations.target_field_mapping_id IS
  'Target field mapping this transformation belongs to. Replaces field_mapping_id after migration 074. NOT NULL after backfill completes (STEP 14).';


-- ============================================================================
-- STEP 6 — Temp lookup table: old field_mapping_id → new target_field_mapping_id
-- ============================================================================
-- Used by STEP 11 to backfill transformations. ON COMMIT DROP removes it at
-- the end of the transaction even if a later step raises.
--
-- Scope: contains a row for every field_mapping (primary AND contributing)
-- so that any transformations tied to a contributing field_mapping also get
-- backfilled correctly.

CREATE TEMP TABLE fm_to_tfm_map (
  old_field_mapping_id        UUID PRIMARY KEY,
  new_target_field_mapping_id UUID NOT NULL
) ON COMMIT DROP;


-- ============================================================================
-- STEP 7 — Migrate primary field_mappings → target_field_mappings
-- ============================================================================
-- One target_field_mapping per (project_id, target_field_id). DISTINCT ON
-- ensures at most one TFM per pair even if historical data somehow contains
-- multiple non-contributing rows for the same (project, target_field) across
-- different table_mappings. In such a case, the earliest-created primary
-- wins (ORDER BY created_at ASC).
--
-- Combination type derivation:
--   source_field_id IS NULL  → 'custom_sql'  (value assignment)
--   has contributing siblings → 'concat_space' (preserved user intent; they
--                               can re-edit in the redesigned UI)
--   otherwise                → 'single'
--
-- combination_sql for value assignments is pulled from
-- transformations.generated_sql (if any transformation exists for that fm).

WITH primary_fms AS (
  SELECT DISTINCT ON (tm.project_id, fm.target_field_id)
    fm.id            AS first_fm_id,
    tm.project_id    AS project_id,
    fm.target_field_id,
    fm.confidence,
    fm.status,
    fm.ai_reasoning,
    fm.source_field_id,
    fm.created_at
  FROM public.field_mappings fm
  JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
  WHERE fm.is_contributing = false
  ORDER BY tm.project_id, fm.target_field_id, fm.created_at ASC
),
inserted AS (
  INSERT INTO public.target_field_mappings (
    project_id, target_field_id, confidence, status, ai_reasoning,
    is_acknowledged, combination_type, combination_sql,
    created_at, updated_at
  )
  SELECT
    pf.project_id,
    pf.target_field_id,
    pf.confidence,
    pf.status,
    pf.ai_reasoning,
    FALSE,
    CASE
      WHEN pf.source_field_id IS NULL THEN 'custom_sql'
      WHEN EXISTS (
        SELECT 1
        FROM public.field_mappings sib
        JOIN public.table_mappings tm2 ON tm2.id = sib.table_mapping_id
        WHERE sib.target_field_id = pf.target_field_id
          AND tm2.project_id      = pf.project_id
          AND sib.is_contributing = true
      ) THEN 'concat_space'
      ELSE 'single'
    END,
    CASE
      WHEN pf.source_field_id IS NULL THEN (
        SELECT t.generated_sql
        FROM public.transformations t
        WHERE t.field_mapping_id = pf.first_fm_id
        ORDER BY t.created_at DESC
        LIMIT 1
      )
      ELSE NULL
    END,
    pf.created_at,
    pf.created_at
  FROM primary_fms pf
  RETURNING id, project_id, target_field_id
)
INSERT INTO fm_to_tfm_map (old_field_mapping_id, new_target_field_mapping_id)
SELECT pf.first_fm_id, i.id
FROM primary_fms pf
JOIN inserted i
  ON i.project_id      = pf.project_id
 AND i.target_field_id = pf.target_field_id;


-- ── 7b. Extend fm_to_tfm_map with contributing field_mappings ────────────────
-- Each contributing row shares (project_id, target_field_id) with its primary,
-- so it maps to the same TFM. This ensures STEP 11 backfill covers
-- transformations tied to contributing field_mappings (defensive — should be
-- rare but not impossible).

INSERT INTO fm_to_tfm_map (old_field_mapping_id, new_target_field_mapping_id)
SELECT fm.id, tfm.id
FROM public.field_mappings fm
JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
JOIN public.target_field_mappings tfm
  ON tfm.project_id      = tm.project_id
 AND tfm.target_field_id = fm.target_field_id
WHERE fm.is_contributing = true
  AND NOT tfm.is_acknowledged
ON CONFLICT (old_field_mapping_id) DO NOTHING;


-- ── 7c. Assertion: every value-assignment TFM has non-NULL combination_sql ───
-- Value assignments (combination_type='custom_sql', zero mapping_sources)
-- require a computed SQL expression to be meaningful; otherwise downstream
-- SQL generation produces NULL values for the target field. STEP 7 derives
-- combination_sql from transformations.generated_sql when present — if no
-- transformation exists for a value-assignment fm, the derivation returns
-- NULL and we must abort rather than silently persist an unusable mapping.

DO $$
DECLARE
  v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing
  FROM public.target_field_mappings tfm
  WHERE tfm.combination_type = 'custom_sql'
    AND NOT tfm.is_acknowledged
    AND tfm.combination_sql IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'STEP 7c: % value-assignment target_field_mapping(s) have NULL combination_sql; aborting. Inspect the source field_mappings rows with source_field_id IS NULL that lack a transformations row to supply generated_sql.', v_missing;
  END IF;
END $$;


-- ============================================================================
-- STEP 8 — Create mapping_sources rows
-- ============================================================================
-- One mapping_sources row per legacy field_mappings row with
-- source_field_id IS NOT NULL. Value assignments (source_field_id IS NULL)
-- are intentionally excluded: they live on target_field_mappings as
-- combination_type='custom_sql' with zero children.
--
-- ordinal: 0 for the primary (is_contributing = false), 1..N for contributors
-- ordered by created_at.
--
-- Ordinal edge case (documented, not a bug with current data): because we
-- filter source_field_id IS NOT NULL, a value-assignment primary (source_field_id
-- IS NULL) is excluded from the ROW_NUMBER() window. If a target_field ever
-- had a VA primary WITH contributing siblings (source_field_id IS NOT NULL),
-- its first contributor would receive ordinal 0 — shifting contributor
-- ordinals down by one. Current production data contains only 2 VAs, both
-- without contributors (verified at Gate 1), so this cannot occur. Flagged
-- here so a future reader understands the invariant.
--
-- The confidence trigger from STEP 4 fires after each insert and recomputes
-- the parent TFM's confidence as MIN(mapping_sources.confidence). For
-- 'single' TFMs this converges to the same value written in STEP 7. For
-- 'concat_space' TFMs the MIN across primary + contributors is the correct
-- new-model value.

WITH ranked_fms AS (
  SELECT
    fm.id AS fm_id,
    fm.source_field_id,
    f.table_id AS source_table_id,
    fm.confidence,
    fm.ai_reasoning,
    fm.similar_fields_considered,
    fm.type_compatibility,
    tfm.id AS tfm_id,
    fm.is_contributing,
    fm.created_at,
    (ROW_NUMBER() OVER (
       PARTITION BY tfm.id
       ORDER BY fm.is_contributing ASC, fm.created_at ASC
     ) - 1) AS ordinal
  FROM public.field_mappings fm
  JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
  JOIN public.target_field_mappings tfm
    ON tfm.project_id      = tm.project_id
   AND tfm.target_field_id = fm.target_field_id
  JOIN public.fields f ON f.id = fm.source_field_id
  WHERE fm.source_field_id IS NOT NULL   -- exclude value assignments
    AND NOT tfm.is_acknowledged          -- acknowledged rows have no sources
)
INSERT INTO public.mapping_sources (
  target_field_mapping_id,
  source_field_id,
  source_table_id,
  confidence,
  ai_reasoning,
  similar_fields_considered,
  type_compatibility,
  join_spec,
  ordinal,
  created_at
)
SELECT
  tfm_id,
  source_field_id,
  source_table_id,
  confidence,
  ai_reasoning,
  similar_fields_considered,
  type_compatibility,
  NULL,           -- legacy data has no cross-table joins
  ordinal,
  created_at
FROM ranked_fms;


-- ============================================================================
-- STEP 9 — Migrate target-side acknowledgments → target_field_mappings
-- ============================================================================
-- Each field_acknowledgments row with side='target' becomes a TFM with
-- is_acknowledged=true and no mapping_sources children. ON CONFLICT DO
-- NOTHING handles the edge case where a target has BOTH a mapping (from
-- STEP 7) AND a legacy acknowledgment: the mapping wins.

INSERT INTO public.target_field_mappings (
  project_id, target_field_id, is_acknowledged,
  acknowledgment_reason, status, combination_type, combination_sql,
  confidence, ai_reasoning,
  created_at, updated_at
)
-- Note: the separator between reason and notes is a plain ASCII hyphen
-- (' - '), not an em-dash, to eliminate any encoding-drift risk at deploy
-- time (Supabase SQL editor paste, git autocrlf, terminal copy, etc.).
-- The underlying fa.reason and fa.notes keep whatever encoding the original
-- data has — this migration only controls the separator literal.
SELECT
  fa.project_id,
  fa.field_id,
  TRUE,
  fa.reason || COALESCE(' - ' || fa.notes, ''),
  'approved',
  NULL,
  NULL,
  NULL,
  NULL,
  fa.acknowledged_at,
  fa.acknowledged_at
FROM public.field_acknowledgments fa
WHERE fa.side = 'target'
ON CONFLICT (project_id, target_field_id) DO NOTHING;

-- ── 9b. Audit: count target-side acks skipped due to existing mapping ────────
-- Per Flag 4. Emits a NOTICE, does not fail. Lets us audit overlap post-
-- migration without changing behavior.

DO $$
DECLARE
  skipped_count INT;
BEGIN
  SELECT COUNT(*) INTO skipped_count
  FROM public.field_acknowledgments fa
  WHERE fa.side = 'target'
    AND EXISTS (
      SELECT 1 FROM public.target_field_mappings tfm
      WHERE tfm.project_id      = fa.project_id
        AND tfm.target_field_id = fa.field_id
        AND NOT tfm.is_acknowledged
    );
  RAISE NOTICE 'Target-side acks skipped (mapping exists): %', skipped_count;
END $$;


-- ============================================================================
-- STEP 10 — Migrate source-side acknowledgments → source_field_acknowledgments
-- ============================================================================
-- Direct 1:1 copy of field_acknowledgments.side='source' rows.

INSERT INTO public.source_field_acknowledgments (
  project_id, source_field_id, reason, notes,
  acknowledged_by, acknowledged_at
)
SELECT
  fa.project_id,
  fa.field_id,
  fa.reason,
  fa.notes,
  fa.acknowledged_by,
  fa.acknowledged_at
FROM public.field_acknowledgments fa
WHERE fa.side = 'source';


-- ============================================================================
-- STEP 11 — Backfill transformations.target_field_mapping_id
-- ============================================================================
-- Every transformations row references a field_mapping via
-- transformations.field_mapping_id. fm_to_tfm_map contains the
-- fm_id → tfm_id mapping for every legacy field_mapping, including
-- contributing ones (STEP 7b). After this UPDATE, every transformations row
-- should have a non-null target_field_mapping_id. STEP 11b asserts that.

UPDATE public.transformations t
SET target_field_mapping_id = m.new_target_field_mapping_id
FROM fm_to_tfm_map m
WHERE t.field_mapping_id = m.old_field_mapping_id;

-- ── 11b. Assertion: no transformations left without a TFM linkage ────────────
DO $$
DECLARE
  v_orphans INT;
BEGIN
  SELECT COUNT(*) INTO v_orphans
  FROM public.transformations
  WHERE target_field_mapping_id IS NULL;

  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'STEP 11b: % transformation row(s) have NULL target_field_mapping_id after backfill; aborting', v_orphans;
  END IF;
END $$;


-- ============================================================================
-- STEP 12 — New RPCs for the mapping redesign
-- ============================================================================
-- All RPCs: SECURITY DEFINER, explicit SET search_path = public (injection
-- hardening), permission check at top via user_has_project_role(…, 'editor'),
-- GRANT EXECUTE to authenticated and service_role.

-- ── 12a. dq_create_target_field_mapping ──────────────────────────────────────
-- Creates a new target_field_mapping with its mapping_sources children in
-- one atomic call. Caller supplies the sources and combination metadata
-- as JSONB.
--
-- p_sources shape (JSONB array):
--   [
--     {
--       "source_field_id":  "<uuid>",
--       "source_table_id":  "<uuid>",
--       "confidence":       0.85,
--       "ai_reasoning":     "…",
--       "type_compatibility": "exact",
--       "similar_fields_considered": { … },
--       "join_spec":        null | { … },
--       "ordinal":          0
--     },
--     …
--   ]
--
-- p_combination shape (JSONB object):
--   { "type": "single" | "concat_space" | "concat_comma" | "custom_sql",
--     "sql":  "<string>" | null,
--     "ai_reasoning": "<string>" | null,
--     "confidence": 0.85 | null    -- used for value assignments only
--   }

CREATE OR REPLACE FUNCTION public.dq_create_target_field_mapping(
  p_project_id       UUID,
  p_target_field_id  UUID,
  p_sources          JSONB,
  p_combination      JSONB
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

  -- For value assignments, the caller supplies confidence directly (trigger
  -- does not recompute for custom_sql). For mapped targets, leave NULL here;
  -- the STEP 4 trigger populates it when mapping_sources are inserted below.
  IF v_combination_type = 'custom_sql' THEN
    v_confidence := NULLIF(p_combination->>'confidence', '')::NUMERIC(5,2);
  ELSE
    v_confidence := NULL;
  END IF;

  INSERT INTO public.target_field_mappings (
    project_id, target_field_id, confidence, status, ai_reasoning,
    is_acknowledged, combination_type, combination_sql
  ) VALUES (
    p_project_id, p_target_field_id, v_confidence, 'needs_review', v_ai_reasoning,
    FALSE, v_combination_type, v_combination_sql
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

COMMENT ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB) IS
  'Atomically creates a target_field_mapping with its mapping_sources children. Used by the redesigned mapping server actions (Phase 3+).';

GRANT EXECUTE ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB)
  TO authenticated, service_role;

-- ── 12b. dq_replace_mapping_sources ──────────────────────────────────────────
-- Atomically replaces all mapping_sources for a target_field_mapping with a
-- new set. Returns the count of rows inserted.

CREATE OR REPLACE FUNCTION public.dq_replace_mapping_sources(
  p_tfm_id  UUID,
  p_sources JSONB
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id UUID;
  v_count      INT;
BEGIN
  SELECT project_id INTO v_project_id
  FROM public.target_field_mappings
  WHERE id = p_tfm_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'dq_replace_mapping_sources: target_field_mapping % not found', p_tfm_id;
  END IF;

  IF NOT public.user_has_project_role(v_project_id, 'editor') THEN
    RAISE EXCEPTION 'dq_replace_mapping_sources: permission denied for project %', v_project_id;
  END IF;

  DELETE FROM public.mapping_sources WHERE target_field_mapping_id = p_tfm_id;

  IF jsonb_typeof(p_sources) = 'array' AND jsonb_array_length(p_sources) > 0 THEN
    INSERT INTO public.mapping_sources (
      target_field_mapping_id, source_field_id, source_table_id,
      confidence, ai_reasoning, similar_fields_considered, type_compatibility,
      join_spec, ordinal
    )
    SELECT
      p_tfm_id,
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

    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    v_count := 0;
  END IF;

  UPDATE public.target_field_mappings
  SET updated_at = now()
  WHERE id = p_tfm_id;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.dq_replace_mapping_sources(UUID, JSONB) IS
  'Replaces all mapping_sources for a target_field_mapping with the provided set in a single transaction. Returns count inserted.';

GRANT EXECUTE ON FUNCTION public.dq_replace_mapping_sources(UUID, JSONB)
  TO authenticated, service_role;

-- ── 12c. dq_acknowledge_target ───────────────────────────────────────────────
-- Upserts a target_field_mapping representing an acknowledged (no-source)
-- target. If a non-acknowledged mapping already exists for the pair, it is
-- flipped to is_acknowledged=true and its children mapping_sources are
-- removed so the shape contract holds.

CREATE OR REPLACE FUNCTION public.dq_acknowledge_target(
  p_project_id      UUID,
  p_target_field_id UUID,
  p_reason          TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tfm_id UUID;
BEGIN
  IF NOT public.user_has_project_role(p_project_id, 'editor') THEN
    RAISE EXCEPTION 'dq_acknowledge_target: permission denied for project %', p_project_id;
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'dq_acknowledge_target: reason cannot be empty';
  END IF;

  INSERT INTO public.target_field_mappings (
    project_id, target_field_id, is_acknowledged,
    acknowledgment_reason, status, combination_type, combination_sql,
    confidence, ai_reasoning
  ) VALUES (
    p_project_id, p_target_field_id, TRUE,
    p_reason, 'approved', NULL, NULL,
    NULL, NULL
  )
  ON CONFLICT (project_id, target_field_id) DO UPDATE
    SET is_acknowledged       = TRUE,
        acknowledgment_reason = EXCLUDED.acknowledgment_reason,
        status                = 'approved',
        combination_type      = NULL,
        combination_sql       = NULL,
        confidence            = NULL,
        ai_reasoning          = NULL,
        updated_at            = now()
  RETURNING id INTO v_tfm_id;

  -- Clear any existing sources: acknowledged targets have zero children.
  DELETE FROM public.mapping_sources WHERE target_field_mapping_id = v_tfm_id;

  RETURN v_tfm_id;
END;
$$;

COMMENT ON FUNCTION public.dq_acknowledge_target(UUID, UUID, TEXT) IS
  'Upserts a target_field_mapping as acknowledged (no sources). Clears any existing mapping_sources.';

GRANT EXECUTE ON FUNCTION public.dq_acknowledge_target(UUID, UUID, TEXT)
  TO authenticated, service_role;

-- ── 12d. dq_apply_field_transform_joined ─────────────────────────────────────
-- Per-field apply RPC for the new model. Resolves target_table_id and
-- source_table_id from the TFM's mapping_sources. The single-table case
-- (p_join_spec IS NULL) behaves identically to migration 043's
-- dq_apply_field_transform, including NULL-safety and window-function guard.
-- Cross-table case (p_join_spec IS NOT NULL) is intentionally stubbed — it
-- will be wired in Phase 3 (Prompt 3+) once the join_spec JSONB shape is
-- finalized and server actions exist to drive it.
--
-- The RPC resolves project access via the TFM row and enforces editor role.

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
  v_project_id         UUID;
  v_source_table_id    UUID;
  v_target_table_id    UUID;
  v_table_mapping_id   UUID;
  v_has_existing_staged BOOLEAN;
  v_clean              TEXT;
  v_count              BIGINT;
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

  -- ── Cross-table branch — deferred to Phase 3 ──────────────────────────────
  -- Locks in the signature today so migration 074 commits and downstream
  -- prompts can build against a stable ABI. The actual join application is
  -- implemented once the join_spec JSONB shape is finalized (Prompts 3/5+).
  IF p_join_spec IS NOT NULL AND jsonb_typeof(p_join_spec) <> 'null' THEN
    RAISE EXCEPTION 'dq_apply_field_transform_joined: cross-table (join_spec) apply is not yet implemented; will be wired in Phase 3';
  END IF;

  -- ── Single-source branch — identical semantics to dq_apply_field_transform ─
  SELECT EXISTS (
    SELECT 1 FROM public.staged_data_rows s WHERE s.table_mapping_id = v_table_mapping_id
  ) INTO v_has_existing_staged;

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
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB) IS
  'Per-field apply RPC for the redesigned mapping model. Resolves tables from target_field_mapping_id. Single-source branch is live; cross-table join branch is stubbed until Phase 3 finalizes the join_spec shape.';

GRANT EXECUTE ON FUNCTION public.dq_apply_field_transform_joined(UUID, TEXT, TEXT, JSONB)
  TO authenticated, service_role;


-- ============================================================================
-- STEP 13 — Verification gate (hardcoded expected counts)
-- ============================================================================
-- Counts confirmed at Gate 1 by founder against production data on 2026-04-21.
-- If ANY count diverges, the migration ABORTS and rolls back.

-- Expected-count reconciliation (updated during execution on 2026-04-22):
-- Gate 1 counted 49 target-side field_acknowledgments rows in production.
-- The first execution of this migration aborted at STEP 13 with tfm_ack=47
-- rather than 49. Diagnostic query confirmed exactly 2 target-side acks
-- overlap with a primary field_mapping on the same (project, target_field):
--   • project "Homegrown Legacy System to Oracle ERP", field TC_MATTERS.matter_number
--   • project "Homegrown Legacy System to Oracle ERP", field TC_ORGANIZATIONS.org_type_cd
-- Both overlaps are value assignments (source_field_id IS NULL) with
-- status='approved'. Per Flag 4 (ON CONFLICT DO NOTHING, "mapping wins"),
-- these 2 acks are superseded by their value-assignment target_field_mappings
-- and the live ack count is 47 (= 49 − 2). The 2 dropped acks remain in
-- field_acknowledgments_backup_074 for post-commit audit or restoration.
-- STEP 9b's RAISE NOTICE surfaces the skipped count dynamically each run.
DO $$
DECLARE
  expected_tfm_non_ack      CONSTANT INT := 765;
  expected_tfm_ack          CONSTANT INT := 47;  -- 49 total target acks − 2 overridden by existing mappings (see block comment above)
  expected_sources          CONSTANT INT := 776;
  expected_source_acks      CONSTANT INT := 11;
  expected_transformations  CONSTANT INT := 57;
  expected_backup_fm        CONSTANT INT := 778;
  expected_backup_fa        CONSTANT INT := 60;
  actual_tfm_non_ack        INT;
  actual_tfm_ack            INT;
  actual_sources            INT;
  actual_source_acks        INT;
  actual_transformations    INT;
  actual_backup_fm          INT;
  actual_backup_fa          INT;
BEGIN
  SELECT COUNT(*) INTO actual_tfm_non_ack
    FROM public.target_field_mappings WHERE NOT is_acknowledged;
  SELECT COUNT(*) INTO actual_tfm_ack
    FROM public.target_field_mappings WHERE is_acknowledged;
  SELECT COUNT(*) INTO actual_sources
    FROM public.mapping_sources;
  SELECT COUNT(*) INTO actual_source_acks
    FROM public.source_field_acknowledgments;
  SELECT COUNT(*) INTO actual_transformations
    FROM public.transformations WHERE target_field_mapping_id IS NOT NULL;
  SELECT COUNT(*) INTO actual_backup_fm
    FROM public.field_mappings_backup_074;
  SELECT COUNT(*) INTO actual_backup_fa
    FROM public.field_acknowledgments_backup_074;

  IF actual_tfm_non_ack <> expected_tfm_non_ack THEN
    RAISE EXCEPTION 'STEP 13: target_field_mappings (non-ack) count mismatch — expected %, got %',
      expected_tfm_non_ack, actual_tfm_non_ack;
  END IF;
  IF actual_tfm_ack <> expected_tfm_ack THEN
    RAISE EXCEPTION 'STEP 13: target_field_mappings (ack) count mismatch — expected %, got %',
      expected_tfm_ack, actual_tfm_ack;
  END IF;
  IF actual_sources <> expected_sources THEN
    RAISE EXCEPTION 'STEP 13: mapping_sources count mismatch — expected %, got %',
      expected_sources, actual_sources;
  END IF;
  IF actual_source_acks <> expected_source_acks THEN
    RAISE EXCEPTION 'STEP 13: source_field_acknowledgments count mismatch — expected %, got %',
      expected_source_acks, actual_source_acks;
  END IF;
  IF actual_transformations <> expected_transformations THEN
    RAISE EXCEPTION 'STEP 13: transformations backfilled count mismatch — expected %, got %',
      expected_transformations, actual_transformations;
  END IF;
  IF actual_backup_fm <> expected_backup_fm THEN
    RAISE EXCEPTION 'STEP 13: field_mappings_backup_074 count mismatch — expected %, got %',
      expected_backup_fm, actual_backup_fm;
  END IF;
  IF actual_backup_fa <> expected_backup_fa THEN
    RAISE EXCEPTION 'STEP 13: field_acknowledgments_backup_074 count mismatch — expected %, got %',
      expected_backup_fa, actual_backup_fa;
  END IF;

  RAISE NOTICE 'STEP 13 OK: tfm_non_ack=%, tfm_ack=%, sources=%, source_acks=%, transformations=%, backup_fm=%, backup_fa=%',
    actual_tfm_non_ack, actual_tfm_ack, actual_sources, actual_source_acks,
    actual_transformations, actual_backup_fm, actual_backup_fa;
END $$;


-- ============================================================================
-- STEP 14 — Swap transformations' FK and drop legacy tables
-- ============================================================================
-- Order matters:
--   1. Drop old transformations RLS policies (they reference field_mappings).
--   2. Create new transformations RLS policies (target_field_mapping_id-based).
--   3. Drop field_mapping_id column from transformations (auto-drops its FK
--      constraint and its index).
--   4. SET NOT NULL on target_field_mapping_id (safe now — all rows backfilled).
--   5. DROP TABLE field_mappings (CASCADE auto-drops its policies and any
--      dependent objects not already dropped).
--   6. DROP TABLE field_acknowledgments (CASCADE auto-drops its policies).

-- ── 14a. Drop legacy transformations policies ────────────────────────────────
DROP POLICY IF EXISTS "org_access_transformations"     ON public.transformations;
DROP POLICY IF EXISTS "editors_insert_transformations" ON public.transformations;
DROP POLICY IF EXISTS "editors_update_transformations" ON public.transformations;
DROP POLICY IF EXISTS "editors_delete_transformations" ON public.transformations;

-- ── 14b. Create new transformations policies via target_field_mapping_id ─────
CREATE POLICY "org_access_transformations"
  ON public.transformations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_can_access_project(tfm.project_id)
  ));

CREATE POLICY "editors_insert_transformations"
  ON public.transformations FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));

CREATE POLICY "editors_update_transformations"
  ON public.transformations FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));

CREATE POLICY "editors_delete_transformations"
  ON public.transformations FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));

-- ── 14c. Drop legacy field_mapping_id column ────────────────────────────────
-- DROP COLUMN auto-drops the FK constraint (transformations_field_mapping_id_fkey
-- in current production) and the idx_transformations_field_mapping_id index.
ALTER TABLE public.transformations
  DROP COLUMN field_mapping_id;

-- ── 14d. Lock target_field_mapping_id NOT NULL now that backfill is verified ─
ALTER TABLE public.transformations
  ALTER COLUMN target_field_mapping_id SET NOT NULL;

-- ── 14e. FK dependency guard before CASCADE drops ────────────────────────────
-- Enumerates every foreign-key constraint that references field_mappings or
-- field_acknowledgments. After 14c (DROP COLUMN field_mapping_id) there
-- should be ZERO remaining FKs pointing at either table — if any exist,
-- something references these tables that we did not anticipate, and a
-- CASCADE drop would silently destroy that dependent object. Abort instead
-- and let a human inspect.
--
-- This intentionally does not enumerate views, rules, triggers, or policies
-- on OTHER tables that reference these — DROP TABLE CASCADE handles those
-- uniformly. The targeted concern here is foreign-key-linked DATA in other
-- tables, because FK removal via CASCADE converts a data-integrity
-- relationship into silent orphan rows.
--
-- Schema-only check (namespace='public') so we do not trip on any
-- system-schema shadows.

DO $$
DECLARE
  v_dependents INT;
  v_report     TEXT;
BEGIN
  SELECT COUNT(*),
         string_agg(
           format('%I.%I (constraint %I) → %I.%I',
             rn.nspname, rt.relname, c.conname,
             fn.nspname, ft.relname),
           E'\n  '
         )
    INTO v_dependents, v_report
  FROM pg_constraint c
  JOIN pg_class     ft ON ft.oid = c.confrelid          -- referenced table
  JOIN pg_namespace fn ON fn.oid = ft.relnamespace
  JOIN pg_class     rt ON rt.oid = c.conrelid           -- referencing table
  JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE c.contype = 'f'
    AND fn.nspname = 'public'
    AND ft.relname IN ('field_mappings', 'field_acknowledgments')
    -- Exclude FKs we already know about and accept:
    -- (none at this point — transformations.field_mapping_id was dropped in 14c;
    --  field_mappings_backup_074 / field_acknowledgments_backup_074 were
    --  created via CREATE TABLE AS SELECT which does not copy FK constraints)
    AND NOT (rn.nspname = 'public' AND rt.relname IN (
      'field_mappings_backup_074',
      'field_acknowledgments_backup_074'
    ));

  IF v_dependents > 0 THEN
    RAISE EXCEPTION E'STEP 14e: % unexpected FK dependent(s) still reference field_mappings or field_acknowledgments after column drop. CASCADE would silently destroy these. Inspect manually before proceeding:\n  %',
      v_dependents, v_report;
  END IF;
END $$;

-- ── 14f. Drop legacy field_mappings ──────────────────────────────────────────
-- Backups (STEP 1) remain intact on disk for post-commit recovery.
-- CASCADE removes the table's RLS policies, indexes, and any residual
-- non-FK dependents (views, rules). The 14e guard above verified no
-- FK-linked dependents remain.
DROP TABLE public.field_mappings          CASCADE;

-- ── 14g. Drop legacy field_acknowledgments ───────────────────────────────────
DROP TABLE public.field_acknowledgments   CASCADE;


-- ============================================================================
-- STEP 15 — Defensive blocklist updates on existing user-SQL RPCs
-- ============================================================================
-- Each of these RPCs validates user-supplied SQL against a static word-
-- boundary regex blocklist. The old blocklist listed `field_mappings` and
-- `table_mappings`; after STEP 14 those tables no longer exist, but the new
-- model introduces `target_field_mappings` and `mapping_sources` which must
-- also be blocked from user-SQL reference.
--
-- Per Flag 1: we CREATE OR REPLACE the five CURRENT (most-recent) function
-- definitions only. Earlier historical migrations that defined these
-- functions are left unchanged — CREATE OR REPLACE supersedes their
-- definitions at deploy time. This avoids editing history and still produces
-- the same runtime behavior.
--
-- Functions updated (latest source → override here):
--   execute_data_fix                        (last redefined in 026)
--   execute_transform_test(TEXT,UUID,TEXT[],INT) (last redefined in 040)
--   execute_transform_test_distinct(UUID,TEXT[],TEXT,INT) (last redefined in 061)
--   dq_apply_field_transform(UUID,UUID,UUID,TEXT,TEXT,BOOLEAN) (last redefined in 043)
--   execute_transform_full_test(TEXT,UUID,TEXT) (last redefined in 043)
--
-- search_path hardening note (deferred):
--   15a (execute_data_fix), 15b (execute_transform_test), 15d
--   (dq_apply_field_transform), and 15e (execute_transform_full_test)
--   preserve their legacy definitions byte-for-byte except for the
--   blocklist regex. That includes the ABSENCE of an explicit
--   `SET search_path = public`. 15c (execute_transform_test_distinct)
--   keeps its existing explicit search_path from migration 061.
--   Adding `SET search_path = public` to 15a/b/d/e is a security
--   hardening win (prevents search_path injection via user-set GUCs on
--   their session) but is a behavior change that can surface regressions
--   in callers relying on the current lookup order. That hardening is
--   DEFERRED to a future security-focused migration, not bundled with
--   this data migration — keeping blast radius minimal per Phase 1b intent.

-- ── 15a. execute_data_fix — blocklist on DML targets ─────────────────────────
-- Only the final `\b(...)\b` blocklist changes. Everything else is an
-- identity copy of the 026 definition.

CREATE OR REPLACE FUNCTION public.execute_data_fix(p_sql TEXT, p_table_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_affected INT;
  v_upper TEXT;
BEGIN
  v_upper := upper(trim(p_sql));

  IF v_upper ~ '^WITH' THEN
    IF NOT (p_sql ~* '\)\s+(UPDATE|DELETE)\s') THEN
      RAISE EXCEPTION 'CTE fix SQL must end with UPDATE or DELETE after the WITH clause';
    END IF;
  ELSIF NOT (v_upper ~ '^(UPDATE|DELETE)') THEN
    RAISE EXCEPTION 'Fix SQL must start with UPDATE or DELETE, got: %', left(v_upper, 20);
  END IF;

  IF position('data_rows' IN lower(p_sql)) = 0 THEN
    RAISE EXCEPTION 'Fix SQL must operate on the data_rows table only';
  END IF;

  IF position(p_table_id::TEXT IN p_sql) = 0 THEN
    RAISE EXCEPTION 'Fix SQL must include the specific table_id = ''%''', p_table_id;
  END IF;

  IF v_upper ~ '\y(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|COPY)\y' THEN
    RAISE EXCEPTION 'DDL/DCL statements are not allowed in fix SQL';
  END IF;

  IF lower(p_sql) ~ '(pg_catalog|pg_class|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Fix SQL cannot access system or auth tables';
  END IF;

  -- Blocklist updated in migration 074: added target_field_mappings and mapping_sources;
  -- kept field_mappings and table_mappings for defense-in-depth even though field_mappings
  -- is dropped (a future restored backup with that name should still be blocked).
  IF lower(p_sql) ~ '\b(projects|datasets|tables|fields|field_profiles|schema_documents|table_mappings|field_mappings|target_field_mappings|mapping_sources|source_field_acknowledgments|quality_issues|validation_rules|fix_history)\b' THEN
    RAISE EXCEPTION 'Fix SQL can only reference data_rows';
  END IF;

  EXECUTE p_sql;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;

-- ── 15b. execute_transform_test(TEXT, UUID, TEXT[], INT) — multi-field overload ─

CREATE OR REPLACE FUNCTION public.execute_transform_test(
  p_expression    TEXT,
  p_table_id      UUID,
  p_source_fields TEXT[],
  p_limit         INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $$
DECLARE
  v_result     JSONB;
  v_clean      TEXT;
  v_sql        TEXT;
  v_jsonb_expr TEXT;
BEGIN
  v_clean := lower(trim(p_expression));

  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute)\y' THEN
    RAISE EXCEPTION 'Transform expression cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform expression cannot access system tables';
  END IF;
  -- Blocklist updated in migration 074: added target_field_mappings, mapping_sources,
  -- source_field_acknowledgments.
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|target_field_mappings|mapping_sources|source_field_acknowledgments|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform expression can only reference field values from data_rows';
  END IF;
  IF p_expression ~ ';' THEN
    RAISE EXCEPTION 'Transform expression cannot contain semicolons';
  END IF;

  SELECT 'jsonb_build_object(' ||
    string_agg(
      '''' || field_name || ''', row_data->>''' || field_name || '''',
      ', '
      ORDER BY ord
    ) || ')'
  INTO v_jsonb_expr
  FROM unnest(p_source_fields) WITH ORDINALITY AS t(field_name, ord);

  v_sql := format(
    'SELECT row_data->>%L AS before_value, %s AS before_values, (%s)::TEXT AS after_value'
    ' FROM data_rows WHERE table_id = %L ORDER BY row_number LIMIT %s',
    p_source_fields[1],
    v_jsonb_expr,
    p_expression,
    p_table_id::TEXT,
    LEAST(COALESCE(p_limit, 20), 50)
  );

  EXECUTE format('SELECT jsonb_agg(t) FROM (%s) t', v_sql) INTO v_result;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ── 15c. execute_transform_test_distinct(UUID, TEXT[], TEXT, INT) ────────────

CREATE OR REPLACE FUNCTION public.execute_transform_test_distinct(
  p_table_id        UUID,
  p_source_fields   TEXT[],
  p_transform_sql   TEXT,
  p_limit           INT DEFAULT 200
)
RETURNS TABLE(
  before_values     JSONB,
  after_value       TEXT,
  occurrence_count  BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_clean      TEXT;
  v_jsonb_expr TEXT;
  v_query      TEXT;
BEGIN
  v_clean := lower(trim(p_transform_sql));

  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute)\y' THEN
    RAISE EXCEPTION 'Transform expression cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform expression cannot access system tables';
  END IF;
  -- Blocklist updated in migration 074.
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|target_field_mappings|mapping_sources|source_field_acknowledgments|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform expression can only reference field values from data_rows';
  END IF;
  IF p_transform_sql ~ ';' THEN
    RAISE EXCEPTION 'Transform expression cannot contain semicolons';
  END IF;

  SELECT 'jsonb_build_object(' ||
    string_agg(
      '''' || field_name || ''', d.row_data->>''' || field_name || '''',
      ', '
      ORDER BY ord
    ) || ')'
  INTO v_jsonb_expr
  FROM unnest(p_source_fields) WITH ORDINALITY AS t(field_name, ord);

  v_query := format(
    'SELECT _sub.before_values_text::JSONB AS before_values,
            _sub.after_value,
            _sub.occurrence_count
     FROM (
       SELECT (%s)::TEXT          AS before_values_text,
              (%s)::TEXT          AS after_value,
              COUNT(*)::BIGINT    AS occurrence_count
       FROM data_rows d
       WHERE d.table_id = %L
       GROUP BY 1, 2
       ORDER BY occurrence_count DESC
       LIMIT %s
     ) _sub',
    v_jsonb_expr,
    p_transform_sql,
    p_table_id,
    LEAST(COALESCE(p_limit, 200), 500)
  );

  RETURN QUERY EXECUTE v_query;

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT
    jsonb_build_object('_error', true)  AS before_values,
    SQLERRM                             AS after_value,
    0::BIGINT                           AS occurrence_count;
END;
$$;

-- ── 15d. dq_apply_field_transform (legacy per-field apply) ───────────────────

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

-- ── 15e. execute_transform_full_test(TEXT, UUID, TEXT) ───────────────────────

CREATE OR REPLACE FUNCTION public.execute_transform_full_test(
  p_expression   TEXT,
  p_table_id     UUID,
  p_source_field TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_clean     TEXT;
  v_total     INT;
  v_passed    INT := 0;
  v_failures  JSONB := '[]'::JSONB;
  v_max_fail  CONSTANT INT := 20;
  rec         RECORD;
  v_dummy     TEXT;
BEGIN
  v_clean := lower(trim(p_expression));

  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute)\y' THEN
    RAISE EXCEPTION 'Transform expression cannot contain data modification statements';
  END IF;
  IF v_clean ~ '(pg_catalog|information_schema|auth\.|storage\.)' THEN
    RAISE EXCEPTION 'Transform expression cannot access system tables';
  END IF;
  -- Blocklist updated in migration 074.
  IF v_clean ~ '\y(projects|datasets|field_mappings|table_mappings|target_field_mappings|mapping_sources|source_field_acknowledgments|quality_issues|fix_history|fix_snapshots|validation_rules)\y' THEN
    RAISE EXCEPTION 'Transform expression can only reference field values from data_rows';
  END IF;
  IF p_expression ~ ';' THEN
    RAISE EXCEPTION 'Transform expression cannot contain semicolons';
  END IF;

  IF v_clean ~ '\yover\s*\(' THEN
    RAISE EXCEPTION 'Window functions (e.g. ROW_NUMBER() OVER()) cannot be used in a transform expression because PostgreSQL does not allow them inside UPDATE SET. Rewrite using a hash or concatenation instead (e.g. LEFT(MD5(field::text), 8)).';
  END IF;

  SELECT COUNT(*) INTO v_total FROM data_rows WHERE table_id = p_table_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'total_rows',  0,
      'passed_rows', 0,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  END IF;

  BEGIN
    EXECUTE format(
      'SELECT COUNT(*) FROM (SELECT (%s) FROM data_rows WHERE table_id = %L) _t',
      p_expression, p_table_id::TEXT
    ) INTO v_passed;

    RETURN jsonb_build_object(
      'total_rows',  v_total,
      'passed_rows', v_passed,
      'failed_rows', 0,
      'failures',    '[]'::JSONB
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  FOR rec IN
    SELECT id, row_number, row_data->>p_source_field AS src_val
    FROM data_rows
    WHERE table_id = p_table_id
    ORDER BY row_number
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT (%s)::TEXT FROM data_rows WHERE id = %L',
        p_expression, rec.id
      ) INTO v_dummy;
      v_passed := v_passed + 1;
    EXCEPTION WHEN OTHERS THEN
      IF jsonb_array_length(v_failures) < v_max_fail THEN
        v_failures := v_failures || jsonb_build_array(
          jsonb_build_object(
            'row_number',    rec.row_number,
            'source_value',  COALESCE(rec.src_val, ''),
            'error_message', SQLERRM
          )
        );
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'total_rows',  v_total,
    'passed_rows', v_passed,
    'failed_rows', v_total - v_passed,
    'failures',    v_failures
  );
END;
$$;


COMMIT;

-- ============================================================================
-- END migration 074
-- ============================================================================
