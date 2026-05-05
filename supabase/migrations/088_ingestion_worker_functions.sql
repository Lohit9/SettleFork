-- 088_ingestion_worker_functions.sql
-- Worker-only functions for the background-job ingestion pipeline.
--
-- Both functions are SECURITY DEFINER and granted ONLY to
-- service_role. The cron worker (app/api/cron/process-ingestion-job)
-- authenticates as service_role; no authenticated end-user should
-- ever call these. This deviates from PR 3.3's agent_data_scanning_*
-- pattern (those use SECURITY INVOKER + user_has_project_role gate
-- because they're called by user actions); these worker functions
-- have no auth.uid() to gate against, so we use DEFINER + explicit
-- structural scope check + the GRANT-to-service_role-only barrier.
--
-- Functions:
--   bulk_insert_data_rows  — idempotent chunk insert via ON CONFLICT
--                            DO NOTHING. Worker calls this in a loop
--                            for each 1K-row chunk.
--   claim_next_ingestion_job — atomic job pickup via
--                              FOR UPDATE SKIP LOCKED. Combines
--                              "pick oldest pending OR stale-
--                              processing" + "mark processing" into
--                              one transaction so two cron instances
--                              can't double-claim the same job.

CREATE OR REPLACE FUNCTION public.bulk_insert_data_rows(
  p_table_id UUID,
  p_dataset_id UUID,
  p_project_id UUID,
  p_rows JSONB,    -- Array of { row_number, row_data }
  p_offset INTEGER -- Starting row_number (logging only — for tracing)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '30s'
SET work_mem = '16MB'
AS $func$
DECLARE
  v_inserted_count INT;
  v_table_belongs BOOLEAN;
BEGIN
  -- Structural scope check: confirm tuple coherence. The worker
  -- claims jobs across all users (service_role bypasses RLS), so
  -- defense-in-depth requires an explicit ownership chain check
  -- inside the function. A buggy or malicious caller could in
  -- principle pass mismatched (table_id, dataset_id, project_id)
  -- triples; this gate rejects them before INSERT corrupts data.
  SELECT EXISTS(
    SELECT 1 FROM public.tables t
    JOIN public.datasets d ON t.dataset_id = d.id
    WHERE t.id = p_table_id
      AND d.id = p_dataset_id
      AND d.project_id = p_project_id
  ) INTO v_table_belongs;

  IF NOT v_table_belongs THEN
    RAISE EXCEPTION 'Table does not belong to the specified project';
  END IF;

  -- Idempotent insert. The UNIQUE (table_id, row_number) constraint
  -- (migration 087) makes ON CONFLICT DO NOTHING the worker's
  -- retry-safety net: if a chunk was partially inserted before a
  -- timeout, replaying it on resume re-inserts only the missing
  -- rows. ROW_COUNT therefore reports actually-inserted rows
  -- (excludes the conflicts), which the worker logs but doesn't
  -- treat as an error.
  INSERT INTO public.data_rows (table_id, row_number, row_data)
  SELECT
    p_table_id,
    (elem->>'row_number')::INT,
    (elem->'row_data')::JSONB
  FROM jsonb_array_elements(p_rows) AS elem
  ON CONFLICT (table_id, row_number) DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'inserted_count', v_inserted_count,
    'offset', p_offset,
    'status', 'success'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'status', 'failed',
    'offset', p_offset
  );
END;
$func$;

-- Atomic job claim. FOR UPDATE SKIP LOCKED handles the case where
-- two cron instances run simultaneously (Vercel's behavior under
-- load): each calls claim_next_ingestion_job, the row-level lock
-- on the chosen row blocks the second caller, the second caller
-- skips the locked row and picks the next one. Without SKIP
-- LOCKED, the second caller would block until the first commits;
-- with it, the second caller proceeds to a different job (or
-- returns NULL if there are no other pending jobs).
--
-- Stale detection: status='processing' AND updated_at older than
-- 5 minutes is treated as a zombie (worker crashed/timed out
-- mid-processing). The worker's resume logic uses completed_rows
-- to skip already-inserted chunks (idempotent via UNIQUE +
-- ON CONFLICT, but skipping is faster).
CREATE OR REPLACE FUNCTION public.claim_next_ingestion_job()
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $func$
DECLARE
  v_job public.ingestion_jobs;
BEGIN
  UPDATE public.ingestion_jobs
  SET status = 'processing',
      updated_at = NOW()
  WHERE id = (
    SELECT id
    FROM public.ingestion_jobs
    WHERE status = 'pending'
       OR (status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes')
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_job;

  -- v_job is null if the SELECT inside the UPDATE returned no rows
  -- (no eligible jobs OR all eligible jobs were locked by other
  -- workers). Caller should treat null return as "no work to do".
  RETURN v_job;
END;
$func$;

-- REVOKE the implicit PUBLIC grant Postgres adds on CREATE FUNCTION.
-- Without this, any role (PUBLIC, anon, authenticated) inherits
-- EXECUTE permission and the explicit GRANT to service_role becomes
-- a no-op for security purposes. Standard hardening pattern for
-- SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION public.bulk_insert_data_rows(
  UUID, UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_next_ingestion_job()
  FROM PUBLIC, anon, authenticated;
  
-- Grant only to service_role. End-users (authenticated role) can't
-- bypass the queue — they go through queueIngestionJob which
-- validates permissions and inserts a 'pending' row. The worker is
-- the only legitimate caller of these RPCs.
GRANT EXECUTE ON FUNCTION public.bulk_insert_data_rows(
  UUID, UUID, UUID, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_ingestion_job()
  TO service_role;
