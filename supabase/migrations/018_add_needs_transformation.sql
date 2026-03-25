-- Add needs_transformation column to field_mappings.
-- Stores Claude's AI assessment of whether transformation is needed.
-- NULL means not yet assessed (e.g., manually created mappings or suggestRemainingMappings).
ALTER TABLE field_mappings
  ADD COLUMN IF NOT EXISTS needs_transformation BOOLEAN DEFAULT NULL;
