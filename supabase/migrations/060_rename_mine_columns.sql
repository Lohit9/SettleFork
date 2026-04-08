-- Migration 060: Rename Mine-branded columns to Settle in migration_pages
-- Renames how_mine_helps → how_settle_helps
--         migration_stats.mine_timeline → settle_timeline (inside JSONB)
--         migration_stats.mine_team → settle_team (inside JSONB)

-- Rename the how_mine_helps column if it still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'migration_pages' AND column_name = 'how_mine_helps'
  ) THEN
    ALTER TABLE migration_pages RENAME COLUMN how_mine_helps TO how_settle_helps;
  END IF;
END $$;

-- Rename JSONB keys inside migration_stats: mine_timeline → settle_timeline, mine_team → settle_team
UPDATE migration_pages
SET migration_stats = (
  migration_stats
  - 'mine_timeline'
  - 'mine_team'
  || jsonb_build_object(
       'settle_timeline', migration_stats -> 'mine_timeline',
       'settle_team',     migration_stats -> 'mine_team'
     )
)
WHERE migration_stats ? 'mine_timeline' OR migration_stats ? 'mine_team';
