/**
 * Validates AI-generated fix SQL before execution.
 * Fix SQL may only UPDATE or DELETE rows in data_rows for a specific table_id.
 * CTEs (WITH ... UPDATE/DELETE) are allowed so window functions can be used
 * inside the CTE subquery without violating PostgreSQL's restriction on
 * window functions inside UPDATE SET clauses.
 */

export interface FixSQLValidationResult {
  safe: boolean
  reason?: string
}

const DDL_PATTERN = /\b(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|COPY)\b/i
const SYSTEM_TABLE_PATTERN = /(pg_catalog|pg_class|information_schema|auth\.|storage\.)/i
const APP_TABLE_PATTERN =
  /\b(projects|datasets|tables|fields|field_profiles|schema_documents|table_mappings|field_mappings|quality_issues|validation_rules|fix_history)\b/i
const COMMENT_PATTERN = /(--|\/\*)/
// LIMIT/FETCH/OFFSET in fix SQL could silently cap rows updated to less than the full set.
// Fix operations must always apply to every matching row — no partial runs allowed.
const LIMIT_PATTERN = /\b(LIMIT|FETCH\s+FIRST|FETCH\s+NEXT|OFFSET)\b/i

export function validateFixSQL(sql: string, tableId: string): FixSQLValidationResult {
  if (!sql || typeof sql !== 'string') {
    return { safe: false, reason: 'SQL is empty or invalid' }
  }

  const trimmed = sql.trim()

  // Determine whether this is a CTE (WITH ... UPDATE/DELETE) or a plain statement
  const isCTE = /^WITH\b/i.test(trimmed)

  if (isCTE) {
    // Main DML must follow the WITH clause(s): ") UPDATE " or ") DELETE " (last match
    // wins when nested parens appear inside CTE bodies).
    const dmlMatches = [...trimmed.matchAll(/\)\s*(UPDATE|DELETE)\s+/gi)]
    if (dmlMatches.length === 0) {
      return {
        safe: false,
        reason:
          'CTE fix SQL must end with UPDATE or DELETE on data_rows (e.g. WITH ... AS (...) UPDATE data_rows ...)',
      }
    }
    const last = dmlMatches[dmlMatches.length - 1]
    const kw = last[1].toUpperCase()
    const afterDml = trimmed.slice((last.index ?? 0) + last[0].length)
    if (kw === 'UPDATE' && !/^\s*data_rows\b/i.test(afterDml)) {
      return {
        safe: false,
        reason: 'CTE must end with UPDATE data_rows — main statement must target data_rows',
      }
    }
    if (kw === 'DELETE' && !/^\s*FROM\s+data_rows\b/i.test(afterDml)) {
      return {
        safe: false,
        reason: 'CTE must end with DELETE FROM data_rows — main statement must target data_rows',
      }
    }
    // CTEs may use window functions in the subquery body — that is safe and intentional
  } else {
    // Plain statement must start with UPDATE or DELETE
    if (!/^(UPDATE|DELETE)\s/i.test(trimmed)) {
      return { safe: false, reason: 'Fix SQL must start with UPDATE or DELETE' }
    }
    // Block bare window functions in plain UPDATE/DELETE — PostgreSQL does not allow
    // OVER() in an UPDATE SET clause. Callers should use a CTE instead.
    if (/\bOVER\s*\(/i.test(trimmed)) {
      return {
        safe: false,
        reason:
          'Window functions (e.g. ROW_NUMBER() OVER()) cannot be used directly inside an UPDATE statement in PostgreSQL. Use a CTE (WITH ... AS (...) UPDATE ...) instead.',
      }
    }
  }

  // No comments allowed (potential injection vector)
  if (COMMENT_PATTERN.test(trimmed)) {
    return { safe: false, reason: 'SQL comments are not allowed in fix SQL' }
  }

  // No LIMIT/FETCH/OFFSET — fix SQL must apply to every matching row, never a partial subset
  if (LIMIT_PATTERN.test(trimmed)) {
    return {
      safe: false,
      reason:
        'Fix SQL must not contain LIMIT, FETCH, or OFFSET — fix operations must apply to all matching rows. ' +
        'Remove the LIMIT clause and use a plain WHERE condition instead.',
    }
  }

  // Must reference data_rows
  if (!/\bdata_rows\b/i.test(trimmed)) {
    return { safe: false, reason: 'Fix SQL must operate on the data_rows table' }
  }

  // Must include the specific table_id as a safety anchor
  if (!trimmed.includes(tableId)) {
    return {
      safe: false,
      reason: `Fix SQL must include table_id = '${tableId}' in the WHERE clause`,
    }
  }

  // Block DDL
  if (DDL_PATTERN.test(trimmed)) {
    return { safe: false, reason: 'DDL statements are not allowed in fix SQL' }
  }

  // Block system table access
  if (SYSTEM_TABLE_PATTERN.test(trimmed)) {
    return { safe: false, reason: 'Fix SQL cannot access system or auth tables' }
  }

  // Block other application tables
  if (APP_TABLE_PATTERN.test(trimmed)) {
    return {
      safe: false,
      reason:
        'Fix SQL can only reference data_rows — found reference to another application table',
    }
  }

  // Block multiple statements
  const withoutStrings = trimmed.replace(/'[^']*'/g, "''")
  const semicolonCount = (withoutStrings.match(/;/g) || []).length
  if (semicolonCount > 1 || (semicolonCount === 1 && !trimmed.endsWith(';'))) {
    return { safe: false, reason: 'Fix SQL must be a single statement' }
  }

  // Verify WHERE clause exists (UPDATE/DELETE without WHERE is too dangerous)
  if (!/\bWHERE\b/i.test(trimmed)) {
    return {
      safe: false,
      reason: 'Fix SQL must include a WHERE clause to limit affected rows',
    }
  }

  return { safe: true }
}
