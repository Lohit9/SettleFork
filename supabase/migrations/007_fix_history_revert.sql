-- Migration 007: Add inverse SQL revert support to fix_history
-- Run this in the Supabase SQL Editor.

-- Add revert_sql: the exact SQL to undo the fix (NULL for legacy records)
ALTER TABLE fix_history ADD COLUMN IF NOT EXISTS revert_sql TEXT;

-- Add is_reversible: false when the fix type cannot be automatically undone
ALTER TABLE fix_history ADD COLUMN IF NOT EXISTS is_reversible BOOLEAN DEFAULT true;
