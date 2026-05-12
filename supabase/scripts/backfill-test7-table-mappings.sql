-- ─── Backfill: table_mappings for Test #7 (Path D persistence retrofit) ─────
--
-- Project: 0f2a95bb-1e80-4a8b-8e59-ae5559277730
-- Date:    2026-05-12
-- PR:      feat/path-d-write-table-mappings
--
-- WHY
-- ───────────────────────────────────────────────────────────────────────────
-- Path D persistence (lib/ai/path-d-persistence.ts) wrote target_field_
-- mappings and mapping_sources for this project but skipped table_mappings
-- entirely. The Transform page (lib/actions/transformations.ts:551) gates
-- on `table_mappings.length > 0` and returns hasMappings=false when empty,
-- so Test #7 has been rendering the "No mappings found" empty state for
-- weeks despite having 83 TFMs (7 approved + 76 needs-review).
--
-- This script derives the same (source_table_id, target_table_id) pairs
-- that Pass 2.6 (added in this PR) would have written, and inserts them
-- with status='needs_review'. Once Pass 2.6 ships, future Path D runs on
-- this project (or any project) won't need this backfill.
--
-- SHAPE
-- ───────────────────────────────────────────────────────────────────────────
-- For Test #7, this script inserts exactly 3 rows (preview verified
-- 2026-05-12 via read-only REST query against settle-prod):
--
--   1. Prosys.Engineering BOM Masters → Rootstock.Engineering Item Master
--   2. Prosys.Products                → Rootstock.Inventory Commodity Code
--   3. Prosys.Products                → Rootstock.Engineering Item Master
--
-- All with status='needs_review', confidence=NULL, ai_reasoning=NULL —
-- matches the legacy table-pair writer's INSERT shape at
-- lib/ai/mapping-engine.ts:1986-1997 and Pass 2.6's behavior.
--
-- IDEMPOTENCY
-- ───────────────────────────────────────────────────────────────────────────
-- The schema has NO UNIQUE constraint on (project_id, source_table_id,
-- target_table_id) — dedupe is application-side. The WHERE NOT EXISTS
-- clause makes this script safe to rerun: if a pair was already written
-- (e.g. Pass 2.6 lands first), this script becomes a no-op for that pair.
--
-- VERIFICATION
-- ───────────────────────────────────────────────────────────────────────────
-- Before:  SELECT COUNT(*) FROM table_mappings
--          WHERE project_id = '0f2a95bb-...';  → 0
-- After:   SELECT COUNT(*) FROM table_mappings
--          WHERE project_id = '0f2a95bb-...';  → 3
-- Then:    Open /app/projects/0f2a95bb-.../transform
--          Expect: 2 target table groups (Engineering Item Master,
--                  Inventory Commodity Code), no empty state.
--
-- ───────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO public.table_mappings (
  project_id,
  source_table_id,
  target_table_id,
  status,
  confidence,
  ai_reasoning
)
SELECT DISTINCT
  tfm.project_id,
  ms.source_table_id,
  tgt_field.table_id AS target_table_id,
  'needs_review' AS status,
  NULL::numeric AS confidence,
  NULL::text AS ai_reasoning
FROM public.target_field_mappings tfm
JOIN public.mapping_sources ms
  ON ms.target_field_mapping_id = tfm.id
JOIN public.fields tgt_field
  ON tgt_field.id = tfm.target_field_id
WHERE tfm.project_id = '0f2a95bb-1e80-4a8b-8e59-ae5559277730'
  AND tfm.status <> 'rejected'
  AND ms.source_table_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.table_mappings existing
    WHERE existing.project_id = tfm.project_id
      AND existing.source_table_id = ms.source_table_id
      AND existing.target_table_id = tgt_field.table_id
  );

-- Inspect inserted rows before COMMIT.
SELECT
  tm.id,
  src.name  AS source_table,
  tgt.name  AS target_table,
  tm.status,
  tm.created_at
FROM public.table_mappings tm
JOIN public.tables src ON src.id = tm.source_table_id
JOIN public.tables tgt ON tgt.id = tm.target_table_id
WHERE tm.project_id = '0f2a95bb-1e80-4a8b-8e59-ae5559277730'
ORDER BY tm.created_at;

COMMIT;
