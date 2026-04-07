/**
 * Pure utility functions for building diagnostic SQL queries from quality issues.
 * No 'use server' — these are synchronous helpers safe to import anywhere.
 */

export function mapIssueKindToCondition(issueKind: string | null): string {
  const mapping: Record<string, string> = {
    null_pk: 'null',
    null_required: 'null',
    high_null_rate: 'null',
    currency_format: 'format_currency',
    email_format: 'format_email',
    phone_format: 'format_phone',
    type_mismatch_integer: 'type_integer',
    type_mismatch_numeric: 'type_numeric',
    negative_value: 'negative_value',
    non_iso_date: 'non_iso_date',
    invalid_date_string: 'invalid_date',
  }
  return mapping[issueKind ?? ''] ?? 'null'
}

/**
 * Builds a human-readable SQL string for a quality issue that can be
 * pre-populated in the Query Data tab so users can explore affected rows.
 * Uses table/field names (not JSONB syntax) — the query engine handles translation.
 * Returns null if insufficient context is available.
 */
export function buildDiagnosticQuery(issue: {
  table_id: string
  field_name: string
  issue_kind: string | null
  tableName?: string
}): string | null {
  const table = issue.tableName
  if (!table) return null

  const field = issue.field_name

  switch (issue.issue_kind) {
    case 'null_pk':
    case 'null_required':
    case 'high_null_rate':
      return `SELECT * FROM ${table} WHERE "${field}" IS NULL OR TRIM("${field}") = ''`

    case 'duplicate_pk':
      return `SELECT "${field}", COUNT(*) AS count FROM ${table} GROUP BY "${field}" HAVING COUNT(*) > 1 ORDER BY count DESC`

    case 'orphaned_fk':
      return `SELECT * FROM ${table} WHERE "${field}" IS NOT NULL AND TRIM("${field}") <> '' LIMIT 50`

    case 'currency_format':
      return `SELECT "${field}" FROM ${table} WHERE "${field}" LIKE '%$%' OR "${field}" LIKE '%,%' LIMIT 50`

    case 'email_format':
      return `SELECT "${field}" FROM ${table} WHERE "${field}" IS NOT NULL AND "${field}" NOT LIKE '%@%.%' LIMIT 50`

    case 'phone_format':
      return `SELECT "${field}" FROM ${table} WHERE "${field}" IS NOT NULL LIMIT 50`

    case 'type_mismatch_integer':
    case 'type_mismatch_numeric':
      return `SELECT "${field}" FROM ${table} WHERE "${field}" IS NOT NULL ORDER BY "${field}" LIMIT 50`

    case 'negative_value':
      return `SELECT "${field}" FROM ${table} WHERE "${field}" LIKE '-%' OR "${field}" LIKE '(%' LIMIT 50`

    case 'non_iso_date':
    case 'invalid_date_string':
      return `SELECT "${field}" FROM ${table} WHERE "${field}" IS NOT NULL LIMIT 50`

    default:
      return `SELECT * FROM ${table} WHERE "${field}" IS NOT NULL LIMIT 50`
  }
}
