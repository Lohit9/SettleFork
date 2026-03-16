export interface SQLSafetyResult {
  safe: boolean
  reason?: string
}

/**
 * Validates AI-generated or user-written SQL before execution.
 * Must be called before EVERY query execution — both NL-generated and SQL mode.
 */
export function validateGeneratedSQL(sql: string): SQLSafetyResult {
  const lower = sql.toLowerCase().trim()

  // Must start with SELECT
  if (!lower.startsWith('select')) {
    return { safe: false, reason: 'Not a SELECT query' }
  }

  // Block dangerous DML/DDL keywords
  const blocked =
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|exec|begin|commit|rollback)\b/i
  if (blocked.test(sql)) {
    return { safe: false, reason: 'Contains forbidden SQL keywords' }
  }

  // Block system catalog / auth table access
  if (
    /\b(pg_catalog|information_schema|pg_roles|pg_shadow|pg_authid|auth\.users)\b/i.test(sql)
  ) {
    return { safe: false, reason: 'Accesses system tables' }
  }

  // Block multiple statements (semicolons mid-query)
  const statements = sql.split(';').filter((s) => s.trim().length > 0)
  if (statements.length > 1) {
    return { safe: false, reason: 'Multiple statements not allowed' }
  }

  // Block SQL comments (could hide malicious SQL after a comment)
  if (/--/.test(sql) || /\/\*/.test(sql)) {
    return { safe: false, reason: 'SQL comments not allowed' }
  }

  return { safe: true }
}
