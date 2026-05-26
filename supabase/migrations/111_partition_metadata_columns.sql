-- ============================================================================
-- Migration 111 — PR Ω.3.1 — Partition metadata columns on table_mappings
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Adds 4 nullable metadata columns to `table_mappings` to support the
--   partition-creation UX shipping in PR Ω.3.2:
--
--     1. partition_label   TEXT     — user-facing partition name
--     2. partition_ordinal INT      — stable tab order
--     3. identity_field_id UUID FK  — identity field for future dedup engine
--     4. dedup_priority    INT      — priority for future dedup engine
--
--   Plus one partial index on (target_table_id, partition_ordinal) for the
--   tab-strip ordering query (skips rows with NULL ordinal).
--
-- WHAT THIS MIGRATION DOES NOT DO
--   • No constraint changes. No backfill. All four columns are nullable;
--     heritage projects keep every value NULL with zero observable effect.
--   • No apply-path or AI changes — those land in subsequent PRs.
--   • No dedup engine. identity_field_id and dedup_priority are
--     forward-compatible storage; the apply-path dedup that uses them is
--     post-Ω.3 work. Per design doc §4.3, MVP assumes customers write
--     disjoint filter_sql by hand for partition overlap avoidance.
--
-- DEPLOY ORDER (hot-apply pattern from PR Ω.2)
--   Migration is purely additive with NULL defaults — safe to apply before
--   the code PR ships. Recommended sequence:
--     1. Apply this migration via Supabase Dashboard.
--     2. Verify columns exist via probe (see PR description).
--     3. Code PR (lib/actions/partitions.ts + tests) lands second.
--
-- ROLLBACK
--   Trivial — drop the 4 columns and the index. No data to preserve since
--   nothing is populated by this migration. A standalone revert migration
--   is not shipped; if needed, write a one-shot drop migration at apply
--   time. Pure rollback SQL:
--
--     ALTER TABLE table_mappings DROP COLUMN partition_label;
--     ALTER TABLE table_mappings DROP COLUMN partition_ordinal;
--     ALTER TABLE table_mappings DROP COLUMN identity_field_id;
--     ALTER TABLE table_mappings DROP COLUMN dedup_priority;
--     DROP INDEX IF EXISTS idx_table_mappings_partition_ordinal;
--
--   Safe as long as PR Ω.3.2 has NOT shipped (no UI reads these columns
--   pre-Ω.3.2). After Ω.3.2 lands, dropping columns would 500 the
--   mapping page.
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 1 — Additive columns
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.table_mappings
  ADD COLUMN partition_label TEXT;

ALTER TABLE public.table_mappings
  ADD COLUMN partition_ordinal INTEGER;

-- ON DELETE SET NULL on the FK: if the identity field itself is dropped,
-- the partition keeps existing but loses its identity binding. The dedup
-- engine (post-Ω.3) will treat NULL identity_field_id as "no dedup" and
-- surface a warning in the partition header card.
ALTER TABLE public.table_mappings
  ADD COLUMN identity_field_id UUID
  REFERENCES public.fields(id) ON DELETE SET NULL;

ALTER TABLE public.table_mappings
  ADD COLUMN dedup_priority INTEGER;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 2 — Partial index for partition-tab ordering
-- ──────────────────────────────────────────────────────────────────────────
-- The mapping page reads "all partitions for target_table_id X ordered by
-- (partition_ordinal NULLS LAST, created_at, id)". Partial index covers
-- the explicit-ordinal case; the NULL-ordinal fallback uses the existing
-- idx_table_mappings_target_table_id from migration 002.

CREATE INDEX idx_table_mappings_partition_ordinal
  ON public.table_mappings(target_table_id, partition_ordinal)
  WHERE partition_ordinal IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- Step 3 — Column documentation
-- ──────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.table_mappings.partition_label IS
  'User-facing partition name (PR Ω.3.1). NULL = UI falls back to source_table.name. '
  'Enforced unique-per-target_table at the application layer (lib/actions/partitions.ts).';

COMMENT ON COLUMN public.table_mappings.partition_ordinal IS
  'Stable tab order for the partition strip (PR Ω.3.1). NULL = order by '
  '(created_at ASC, id ASC). When some siblings have ordinal and others NULL, '
  'ordinal-set partitions render first.';

COMMENT ON COLUMN public.table_mappings.identity_field_id IS
  'Identity field for the future dedup engine (PR Ω.3.1 stores; apply-side dedup '
  'is post-Ω.3). FK to fields(id) with ON DELETE SET NULL — if the identity field '
  'is dropped, the partition keeps existing without dedup binding. Application '
  'layer enforces that sibling partitions share the same identity_field_id when '
  'set.';

COMMENT ON COLUMN public.table_mappings.dedup_priority IS
  'Priority for the future dedup engine (PR Ω.3.1 stores; apply-side dedup is '
  'post-Ω.3). Lower number = higher priority. NULL = excluded from dedup. '
  'Application layer does not enforce uniqueness across siblings; ties are '
  'broken by created_at.';

COMMIT;
