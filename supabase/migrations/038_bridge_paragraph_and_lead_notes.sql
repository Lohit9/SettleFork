-- Migration 038: Add bridge_paragraph to migration_pages + notes to migration_leads

ALTER TABLE migration_pages ADD COLUMN IF NOT EXISTS bridge_paragraph TEXT DEFAULT '';

ALTER TABLE migration_leads ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
