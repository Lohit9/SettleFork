-- Migration 049: Add metadata column to outputs table
-- Stores per-table file manifests for compartmentalized execution packages.
ALTER TABLE outputs ADD COLUMN IF NOT EXISTS metadata JSONB;
