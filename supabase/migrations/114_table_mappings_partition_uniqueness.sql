-- ============================================================================
-- 114_table_mappings_partition_uniqueness.sql — PR Ω.3.6.1
-- ============================================================================
--
-- HOTFIX for PR Ω.3.6 (#200). The Rootstock loader's Phase 6.5 emits
-- table_mappings with an UPSERT using
--   ON CONFLICT (project_id, target_table_id, partition_label)
-- but no matching unique constraint exists. Postgres returns:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Migration 111 added partition columns but explicitly left uniqueness
-- to the application layer (lib/actions/partitions.ts:171-187 — manual
-- SELECT-then-INSERT check inside createPartition). That works for the
-- UI flow but not for the loader's bulk-upsert pattern.
--
-- THIS MIGRATION adds a DB-level unique index on
-- (project_id, target_table_id, partition_label) that:
--   • enforces the contract the application layer already polices
--     (defense-in-depth — any future direct INSERT also gets caught)
--   • supports the loader's UPSERT inference
--   • permits heritage rows with NULL partition_label to coexist
--     (Postgres NULL semantics: NULL != NULL in unique constraints,
--     so the index does NOT collapse heritage TMs that share
--     (project_id, target_table_id))
--
-- WHY FULL INDEX (NOT PARTIAL `WHERE partition_label IS NOT NULL`):
-- PostgREST (supabase-js's request layer) does NOT emit the
-- INDEX_PREDICATE in ON CONFLICT clauses. Postgres requires the WHERE
-- predicate to infer a partial unique index. With a partial index,
-- the loader's `.upsert({ onConflict: 'a,b,c' })` would still fail
-- with the same "no unique or exclusion constraint matching" error.
-- A FULL index works because NULL != NULL — heritage rows naturally
-- coexist without the constraint firing.
--
-- HERITAGE BYTE-IDENTITY:
-- 100% of prod projects today have at most 1 TM per (project,
-- target_table) and all have partition_label=NULL. The new index is
-- inert for them — NULL!=NULL means no row is considered a duplicate.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.table_mappings_partition_uniqueness;

BEGIN;

DO $$
DECLARE
  v_dup_count INT;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT 1
    FROM public.table_mappings
    WHERE partition_label IS NOT NULL
    GROUP BY project_id, target_table_id, partition_label
    HAVING COUNT(*) > 1
  ) dups;
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Pre-flight failed: % duplicate (project, target_table, partition_label) group(s) exist. Resolve duplicates before applying migration 114.',
      v_dup_count;
  END IF;
END$$;

CREATE UNIQUE INDEX table_mappings_partition_uniqueness
  ON public.table_mappings (project_id, target_table_id, partition_label);

COMMENT ON INDEX public.table_mappings_partition_uniqueness IS 'PR Ω.3.6.1 — Enforces partition uniqueness per (project, target_table). NULL partition_label rows (heritage projects) are NOT subject to uniqueness because NULL != NULL in Postgres unique constraints. Required for the Rootstock loader (scripts/load-rootstock-spec.ts) Phase 6.5 UPSERT and as defense-in-depth for the application-layer check in lib/actions/partitions.ts:171-187.';

COMMIT;