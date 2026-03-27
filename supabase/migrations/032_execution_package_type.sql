-- ============================================================
-- Migration 032: Add 'execution_package' to outputs.type CHECK
-- Run in Supabase SQL Editor
-- ============================================================

-- Drop the existing type check constraint (name may vary, so we look it up)
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

-- Recreate with all allowed values including the new 'execution_package' type
ALTER TABLE outputs ADD CONSTRAINT outputs_type_check
  CHECK (type IN (
    'mapping_file',
    'transformation_specs',
    'readiness_report',
    'gold_standard_csv',
    'gold_standard_sql',
    'fix_log',
    'data_dictionary',
    'execution_package'
  ));
