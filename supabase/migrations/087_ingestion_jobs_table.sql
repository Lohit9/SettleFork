-- 087_ingestion_jobs_table.sql
-- Background-job ingestion: jobs table + UNIQUE constraint on data_rows
-- for idempotent worker retries.
--
-- Background:
--   PR #73 shipped a 1M-row CSV cap that hit Vercel's 300s function
--   timeout at ~704K rows, leaving silent partial-insert state. The
--   target architecture is async: server action queues a job
--   (returns immediately), Vercel cron worker picks up jobs once a
--   minute, processes in 1K-row chunks via Postgres RPC bulk-insert.
--
--   This migration creates the ingestion_jobs queue table + the
--   UNIQUE (table_id, row_number) constraint that makes worker retries
--   idempotent (worker re-inserting a chunk it already processed
--   becomes a no-op via ON CONFLICT DO NOTHING in the RPC).
--
-- Pre-flight defense:
--   The pre-flight DO block at the bottom defends against PR #73's
--   partial-insert state. Today there are no prod users (founder
--   confirmed; blast radius bounded), and PR #73's inserts were
--   sequential per table_id (no in-place duplicates expected). The
--   DO block surfaces a clear error if that assumption is wrong on
--   the dev DB, blocking the migration before the UNIQUE constraint
--   tries to add and fails with a less informative pg error.

CREATE TABLE public.ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  dataset_id UUID NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  -- table_id is null until the worker finishes schema inference + table
  -- creation on first-pickup. Set on resume so the worker knows to
  -- skip schema/tables/fields creation.
  table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  table_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  progress NUMERIC(3, 2) NOT NULL DEFAULT 0.00
    CHECK (progress >= 0 AND progress <= 1),
  total_rows INTEGER,
  completed_rows INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Partial index for cron worker pickup. Only pending + processing
-- rows matter; once status='completed' or 'failed' the row is an
-- audit-trail artifact. Partial index keeps the read tight.
CREATE INDEX idx_ingestion_jobs_status ON public.ingestion_jobs(status)
  WHERE status IN ('pending', 'processing');

-- For the user's job-history view (descending recent first).
CREATE INDEX idx_ingestion_jobs_user_id_created
  ON public.ingestion_jobs(user_id, created_at DESC);

-- RLS: users see / mutate only their own jobs. Cron worker uses
-- service_role key (bypasses RLS) to claim and update jobs across
-- all users.
ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingestion_jobs_select_own" ON public.ingestion_jobs
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "ingestion_jobs_insert_own" ON public.ingestion_jobs
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "ingestion_jobs_update_own" ON public.ingestion_jobs
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- No DELETE policy — jobs are kept as audit trail.

-- updated_at auto-bump on UPDATE. Worker leans on this for stale
-- detection (see migration 088's claim_next_ingestion_job).
CREATE OR REPLACE FUNCTION public.update_ingestion_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ingestion_jobs_updated_at
  BEFORE UPDATE ON public.ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_ingestion_jobs_updated_at();

-- Pre-flight: ensure no duplicate (table_id, row_number) before adding
-- UNIQUE constraint. PR #73's partial inserts were sequential per
-- table_id (worker inserts in-order from row 1; no duplicate row
-- numbers expected) but defend against this assumption being wrong on
-- the dev DB.
DO $$
DECLARE
  v_dup_count INT;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT table_id, row_number
    FROM public.data_rows
    GROUP BY table_id, row_number
    HAVING COUNT(*) > 1
    LIMIT 1
  ) sub;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add UNIQUE constraint on data_rows: duplicate (table_id, row_number) pairs exist. Manual cleanup required first. See migration 087 source for context.';
  END IF;
END $$;

-- The UNIQUE constraint that makes worker retries idempotent. The
-- bulk_insert_data_rows RPC (migration 088) uses ON CONFLICT
-- (table_id, row_number) DO NOTHING so re-inserting a chunk after
-- a worker timeout/crash is a no-op for already-inserted rows.
ALTER TABLE public.data_rows
  ADD CONSTRAINT data_rows_table_id_row_number_unique
  UNIQUE (table_id, row_number);
