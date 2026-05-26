-- Migration 106: Layer 1 transform validators
--
-- Adds:
--   1. `validation_issues` JSONB column on `transformations` — stores per-field
--      validator output (nondeterminism, DML/DDL, statement guard, null safety,
--      syntax errors) as a soft annotation. Does not block saves; status stays
--      'draft'. NULL = not yet validated OR no issues found.
--
--   2. `dq_validate_transform_sql(p_sql TEXT)` RPC — wraps the expression in
--      EXPLAIN SELECT to test parse + plan without executing. Returns
--      { valid: boolean, error: text | null }. Called by the Layer 1 validator
--      in lib/validation/transform-validator.ts (check 5: syntax_error).

-- ── 1. validation_issues column ──────────────────────────────────────────────

ALTER TABLE transformations
  ADD COLUMN IF NOT EXISTS validation_issues JSONB;

COMMENT ON COLUMN transformations.validation_issues IS
  'Layer 1 validator output. Array of { check, severity, message, suggestion } '
  'objects. NULL means not yet validated or no issues. Does not block save.';

-- ── 2. dq_validate_transform_sql RPC ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION dq_validate_transform_sql(p_sql TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Defense-in-depth: reject obvious DDL/DML before EXPLAIN.
  -- Static TypeScript checks run first; this is a server-side guard.
  IF p_sql ~* '\m(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)\M' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'error', 'Expression must not contain DDL or DML keywords'
    );
  END IF;

  -- Wrap in EXPLAIN SELECT with a dummy row_data so expressions that
  -- reference row_data->>'FieldName' parse correctly. EXPLAIN without
  -- ANALYZE does not execute — safe for arbitrary input.
  EXECUTE format(
    'EXPLAIN SELECT (%s) FROM (SELECT %L::JSONB AS row_data) _dummy',
    p_sql,
    '{}'
  );

  RETURN jsonb_build_object('valid', true, 'error', null);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('valid', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION dq_validate_transform_sql(TEXT) TO authenticated;

COMMENT ON FUNCTION dq_validate_transform_sql IS
  'Layer 1 syntax check for transform SQL expressions. Wraps the expression '
  'in EXPLAIN SELECT to test parse/plan without execution. Returns '
  '{ valid: boolean, error: text | null }. Called from transform-validator.ts.';
