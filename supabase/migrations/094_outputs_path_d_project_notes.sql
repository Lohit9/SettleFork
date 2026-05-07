-- ============================================================
-- Migration 094: Add 'path_d_project_notes' to outputs.type CHECK
-- ============================================================
--
-- Background
-- ----------
-- Sub-PR 4a's `path-d-persistence.ts:persistProjectNotes` writes the
-- model's project_notes markdown to `outputs` with type =
-- 'path_d_project_notes'. The CHECK constraint last touched in migration
-- 034 (`mapping_file`, `transformation_specs`, `readiness_report`,
-- `gold_standard_csv`, `gold_standard_sql`, `fix_log`, `data_dictionary`,
-- `execution_package`, `migration_runbook`) does not include the new
-- value, so the insert fails with a PostgREST schema/constraint error
-- and persistence reports the section as `errored`.
--
-- This migration extends the CHECK to include `path_d_project_notes`.
--
-- Pattern matches the prior incremental type-CHECK migrations (012, 032,
-- 034): drop-by-name-lookup + recreate with the full allowed-values set.
-- The `metadata` column needed by the persistence layer was added in
-- migration 049 — no further column work required here.
--
-- Idempotency: drop+recreate is safe to re-run (constraint name lookup
-- is by `pg_constraint` not by hardcoded name). Re-running adds no rows.

DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'outputs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%type%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outputs DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

ALTER TABLE outputs ADD CONSTRAINT outputs_type_check
  CHECK (type IN (
    'mapping_file',
    'transformation_specs',
    'readiness_report',
    'gold_standard_csv',
    'gold_standard_sql',
    'fix_log',
    'data_dictionary',
    'execution_package',
    'migration_runbook',
    'path_d_project_notes'
  ));
