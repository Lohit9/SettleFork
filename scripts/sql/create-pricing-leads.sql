-- Run this SQL in the Supabase SQL Editor at:
-- https://supabase.com/dashboard/project/YOUR_PROJECT_ID/sql
-- This creates the pricing_leads table for the pricing estimator form.
--
-- RLS pattern mirrors migration_leads (037_migration_leads.sql):
--   - Public (anon) can INSERT — form submits from the public site without auth
--   - Only the service role can SELECT — protects PII from client-side reads
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pricing_leads (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
  name                TEXT        NOT NULL,
  email               TEXT        NOT NULL,
  company             TEXT        NOT NULL,
  role                TEXT,                           -- optional, may be NULL
  system_type         TEXT        NOT NULL,           -- erp | crm | legal | hris | other
  source_system_count TEXT        NOT NULL,           -- 1 | 2-3 | 4+
  table_count_range   TEXT        NOT NULL,           -- under-50 | 50-200 | 200-500 | 500+ | not-sure
  timeline            TEXT        NOT NULL,           -- under-4-weeks | 1-3-months | 3+-months | exploring
  computed_tier       TEXT        NOT NULL,           -- starter | growth | scale | enterprise
  price_range_shown   TEXT        NOT NULL            -- the exact string shown to the user
);

-- Enable Row Level Security
ALTER TABLE pricing_leads ENABLE ROW LEVEL SECURITY;

-- Public INSERT: the estimator form is on the public pricing page (no auth required)
-- Mirrors: "Anyone can insert leads" policy on migration_leads
CREATE POLICY "Anyone can insert pricing leads"
  ON pricing_leads
  FOR INSERT
  WITH CHECK (true);

-- Restricted SELECT: only service role (server-side admin client) can read leads
-- Mirrors: "Service role can read leads" policy on migration_leads
CREATE POLICY "Service role can read pricing leads"
  ON pricing_leads
  FOR SELECT
  USING (auth.role() = 'service_role');

-- Index on email — for deduplication checks and CRM sync queries
CREATE INDEX idx_pricing_leads_email ON pricing_leads (email);

-- Index on created_at DESC — for time-ordered admin queries / exports
CREATE INDEX idx_pricing_leads_created_at ON pricing_leads (created_at DESC);
