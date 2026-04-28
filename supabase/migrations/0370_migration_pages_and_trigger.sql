-- Migration 037a: Recover migration_pages table and update_updated_at trigger function.
--
-- These objects were originally created via Supabase Studio (hand-on-keyboard against
-- prod) and never committed as migrations. This migration backfills the missing history
-- so fresh local setups can run all migrations cleanly.
--
-- Idempotent: uses CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and DROP
-- TRIGGER IF EXISTS guards. Safe to apply to prod (no-op there since objects exist)
-- and required for fresh local installs.
--
-- IMPORTANT: This migration uses the historical column name `how_mine_helps`. Migration
-- 060 (later in sequence) renames it to `how_settle_helps`. End state matches prod.

-- Function: update_updated_at()
-- Generic trigger function that sets NEW.updated_at = NOW() before UPDATE.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Table: migration_pages
-- Stores programmatic SEO pages for source/target system migration content.
CREATE TABLE IF NOT EXISTS migration_pages (
  id                  UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  source_system       TEXT NOT NULL,
  target_system       TEXT NOT NULL,
  source_slug         TEXT NOT NULL,
  target_slug         TEXT NOT NULL,
  source_category     TEXT NOT NULL,
  target_category     TEXT NOT NULL,
  meta_title          TEXT NOT NULL,
  meta_description    TEXT NOT NULL,
  hero_headline       TEXT NOT NULL,
  hero_subheadline    TEXT NOT NULL,
  overview_paragraphs JSONB NOT NULL DEFAULT '[]'::jsonb,
  challenges          JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_objects        JSONB NOT NULL DEFAULT '[]'::jsonb,
  how_mine_helps      JSONB NOT NULL DEFAULT '[]'::jsonb,
  migration_stats     JSONB NOT NULL DEFAULT '{}'::jsonb,
  faqs                JSONB NOT NULL DEFAULT '[]'::jsonb,
  keywords            JSONB NOT NULL DEFAULT '{}'::jsonb,
  related_slugs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_published        BOOLEAN DEFAULT FALSE,
  display_order       INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_migration_pages_slug ON migration_pages USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_migration_pages_published ON migration_pages USING btree (is_published);
CREATE INDEX IF NOT EXISTS idx_migration_pages_source ON migration_pages USING btree (source_slug);
CREATE INDEX IF NOT EXISTS idx_migration_pages_target ON migration_pages USING btree (target_slug);

-- Trigger: auto-update updated_at on UPDATE
DROP TRIGGER IF EXISTS migration_pages_updated_at ON migration_pages;
CREATE TRIGGER migration_pages_updated_at
  BEFORE UPDATE ON migration_pages
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS
-- RLS
ALTER TABLE migration_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Migration pages are publicly readable" ON migration_pages;
CREATE POLICY "Migration pages are publicly readable"
  ON migration_pages FOR SELECT
  USING (is_published = true);

DROP POLICY IF EXISTS "Service role can manage migration pages" ON migration_pages;
CREATE POLICY "Service role can manage migration pages"
  ON migration_pages FOR ALL
  USING (auth.role() = 'service_role');