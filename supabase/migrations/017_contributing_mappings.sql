-- Add is_contributing flag to field_mappings.
-- A "contributing" mapping represents a secondary source field that feeds
-- into the same target field as a primary mapping (many-to-one pattern).
-- The primary mapping (is_contributing = false) carries the transformation SQL.
-- Contributing mappings exist for coverage tracking and as context for the transform AI.
ALTER TABLE field_mappings ADD COLUMN IF NOT EXISTS is_contributing BOOLEAN NOT NULL DEFAULT FALSE;
