/**
 * Layer 1 transform SQL validator.
 *
 * Runs on every AI-generated or user-edited transform SQL expression BEFORE
 * it is persisted. Results are stored as `validation_issues` JSONB on the
 * `transformations` row — soft annotation only, never blocks saves.
 *
 * Check inventory:
 *   1. nondeterministic_function — static, error
 *   2. dml_ddl_keyword           — static, error
 *   3. statement_not_expression  — static, error
 *   4. null_safety_missing       — static, warning
 *   5. syntax_error              — async RPC (dq_validate_transform_sql), error
 *
 * Principle: AI proposes → THIS validates → Human approves.
 * These checks catch what deterministic analysis can prove; they do not replace
 * the human review of transform semantics.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ───────────────────────────────────────────────────────────────────

export type TransformValidationSeverity = 'error' | 'warning'

export type TransformValidationCheckId =
  | 'nondeterministic_function'
  | 'dml_ddl_keyword'
  | 'statement_not_expression'
  | 'null_safety_missing'
  | 'syntax_error'

export interface TransformValidationIssue {
  check: TransformValidationCheckId
  severity: TransformValidationSeverity
  message: string
  suggestion?: string
}

export interface TransformValidationResult {
  issues: TransformValidationIssue[]
  counts: { errors: number; warnings: number }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip single-quoted string literals to avoid false positives on data values. */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "''")
}

// ─── Static checks (pure, no network) ────────────────────────────────────────

const NONDETERMINISTIC_RE =
  /\b(NOW|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|CLOCK_TIMESTAMP|TIMEOFDAY|STATEMENT_TIMESTAMP|TRANSACTION_TIMESTAMP|RANDOM|GEN_RANDOM_UUID|UUID_GENERATE_V4)\s*\(/i

const DML_DDL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL)\b/i

const ROW_DATA_REF_RE = /row_data\s*->>/i
const NULL_GUARD_RE = /\b(COALESCE|NULLIF|IS\s+NOT\s+NULL|IS\s+NULL)\b/i

function checkNondeterministic(sql: string): TransformValidationIssue | null {
  if (!NONDETERMINISTIC_RE.test(stripStringLiterals(sql))) return null
  return {
    check: 'nondeterministic_function',
    severity: 'error',
    message: 'Expression uses a non-deterministic function (e.g. NOW(), RANDOM())',
    suggestion:
      'Replace with a deterministic equivalent or a literal value. ' +
      'Non-deterministic functions produce different results on each row ' +
      'and cannot be used in reproducible migrations.',
  }
}

function checkDmlDdl(sql: string): TransformValidationIssue | null {
  if (!DML_DDL_RE.test(stripStringLiterals(sql))) return null
  return {
    check: 'dml_ddl_keyword',
    severity: 'error',
    message: 'Expression contains a DDL or DML keyword',
    suggestion:
      'transform_sql must be a PostgreSQL expression, not a full statement. ' +
      'Remove INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE, EXECUTE, or CALL.',
  }
}

function checkStatementNotExpression(sql: string): TransformValidationIssue | null {
  // The most common mistake: pasting a SELECT statement instead of an expression.
  // Check after stripping literals to avoid matching 'SELECT' inside a string value.
  if (/^\s*SELECT\b/i.test(stripStringLiterals(sql).trim())) {
    return {
      check: 'statement_not_expression',
      severity: 'error',
      message: 'Expression is a full SELECT statement, not an expression',
      suggestion:
        "Remove the SELECT keyword. transform_sql should be an expression like " +
        "COALESCE(row_data->>'FieldName', '') not SELECT COALESCE(...).",
    }
  }
  return null
}

function checkNullSafety(sql: string): TransformValidationIssue | null {
  // Warn if expression reads row_data fields without any null handling.
  // wrapWithNullGuard in generateTransform already adds this for the LLM
  // path; this catches inline SQL from S1.1 persistClaudeFieldMappingsForTM.
  if (!ROW_DATA_REF_RE.test(sql)) return null
  if (NULL_GUARD_RE.test(sql)) return null
  return {
    check: 'null_safety_missing',
    severity: 'warning',
    message: 'Expression reads row_data fields without null handling',
    suggestion:
      "Wrap with COALESCE to handle NULL source values, " +
      "e.g. COALESCE(row_data->>'FieldName', '').",
  }
}

// ─── Async check: RPC dry-run ─────────────────────────────────────────────────

async function checkSyntax(
  sql: string,
  supabase: SupabaseClient,
): Promise<TransformValidationIssue | null> {
  const { data, error } = await supabase.rpc('dq_validate_transform_sql', { p_sql: sql })
  if (error) {
    // RPC failure (network, auth) — log and skip. Don't surface as a validation issue.
    console.warn('[transform-validator] dq_validate_transform_sql RPC error:', error.message)
    return null
  }
  const result = data as { valid: boolean; error: string | null }
  if (result.valid) return null
  return {
    check: 'syntax_error',
    severity: 'error',
    message: result.error ?? 'SQL syntax error',
    suggestion: 'Fix the PostgreSQL expression syntax before saving.',
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run all Layer 1 checks on a transform SQL expression.
 *
 * Checks 1–4 are static (pure, synchronous). Check 5 (syntax_error) requires
 * a Supabase client for the `dq_validate_transform_sql` RPC dry-run — omit
 * `supabase` to skip it (used in hot loops like persistClaudeFieldMappingsForTM).
 *
 * Returns a result suitable for storing as `transformations.validation_issues`.
 * Empty `issues` array means all checks passed.
 */
export async function validateTransformSQL(
  sql: string,
  supabase?: SupabaseClient,
): Promise<TransformValidationResult> {
  const issues: TransformValidationIssue[] = []

  const nd = checkNondeterministic(sql)
  if (nd) issues.push(nd)

  const dml = checkDmlDdl(sql)
  if (dml) issues.push(dml)

  const stmt = checkStatementNotExpression(sql)
  if (stmt) issues.push(stmt)

  const nullSafety = checkNullSafety(sql)
  if (nullSafety) issues.push(nullSafety)

  if (supabase) {
    const syntax = await checkSyntax(sql, supabase)
    if (syntax) issues.push(syntax)
  }

  return {
    issues,
    counts: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
    },
  }
}
