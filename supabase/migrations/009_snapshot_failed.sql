-- Migration 009: Track whether a fix was applied without a snapshot
-- Fixes applied without a snapshot (CTE-based complex SQL confirmed by user)
-- cannot be reverted. This flag drives the "Cannot revert" UI.

ALTER TABLE fix_history ADD COLUMN IF NOT EXISTS snapshot_failed BOOLEAN DEFAULT false;
