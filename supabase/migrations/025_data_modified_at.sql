-- ============================================================
-- Migration 025: data_modified_at on tables
-- ============================================================
-- Tracks when source data was last modified so the UI can
-- warn users that staged/transformed data may be stale.
--
-- Bumped by application code when source data_rows change:
--   • quality fix applied (lib/actions/quality-fixes.ts)
--   • manual fix applied  (lib/actions/manual-fix.ts)
--   • CSV re-upload       (creates a new table row → DEFAULT now())
--
-- Compared against staged_data_rows.staged_at in checkStagingFreshness /
-- checkProjectStaleness. If data_modified_at > max(staged_at), staging is stale.
--
-- IMPORTANT: Do NOT use ADD COLUMN ... DEFAULT now() in one step — PostgreSQL 11+
-- materializes that default into all existing rows, so a follow-up
-- UPDATE ... WHERE data_modified_at IS NULL matches nothing and never seeds
-- created_at (false staleness for every mapping).
--
-- If your database already ran an older broken 025, run once in SQL Editor:
--   UPDATE tables SET data_modified_at = created_at;
-- ============================================================

-- Step 1: Add column WITHOUT default so existing rows stay NULL until seeded
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS data_modified_at TIMESTAMPTZ;

-- Step 2: Seed existing rows with table creation time (≤ any realistic staged_at)
UPDATE tables
SET data_modified_at = created_at
WHERE data_modified_at IS NULL;

-- Step 3: Default for new table rows (after seed so INSERTs get now())
ALTER TABLE tables
  ALTER COLUMN data_modified_at SET DEFAULT now();
