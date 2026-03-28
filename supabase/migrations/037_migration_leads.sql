-- Migration 037: Create migration_leads table for /migrate page lead capture

CREATE TABLE IF NOT EXISTS migration_leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  email        TEXT NOT NULL,
  source_system TEXT,
  target_system TEXT,
  timeline     TEXT,
  volume       TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- RLS: public insert (anon key), no reads from client
ALTER TABLE migration_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert a migration lead"
  ON migration_leads FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
