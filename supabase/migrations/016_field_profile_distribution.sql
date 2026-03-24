-- Add value_distribution to field_profiles
-- Stores top-25 most frequent values with counts for AI context enrichment.
-- Format: [{"value": "Technology", "count": 85}, ...]

ALTER TABLE field_profiles
  ADD COLUMN IF NOT EXISTS value_distribution JSONB DEFAULT '[]'::jsonb;
