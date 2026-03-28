-- Migration 037: Create migration_leads table for /migrate page lead capture

CREATE TABLE IF NOT EXISTS migration_leads (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name  TEXT,
  email         TEXT NOT NULL,
  source_system TEXT,
  target_system TEXT,
  timeline      TEXT,
  volume        TEXT,
  page_slug     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE migration_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert leads"
  ON migration_leads FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can read leads"
  ON migration_leads FOR SELECT
  USING (auth.role() = 'service_role');
