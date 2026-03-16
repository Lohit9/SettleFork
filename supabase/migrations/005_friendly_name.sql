-- Add friendly_name column for natural SQL querying
-- ⚠️  Run this in the Supabase SQL Editor manually.
-- Format: lowercase(dataset_name) + '.' + lowercase(table_name)
-- Example: dataset "SOFTPAK", table "Prices" → "softpak.prices"

ALTER TABLE tables ADD COLUMN IF NOT EXISTS friendly_name TEXT;
