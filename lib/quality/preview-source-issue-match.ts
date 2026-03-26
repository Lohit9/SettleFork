/**
 * Client-side matching of a source preview cell value against open quality issues
 * for that field (Transform tab Sample view). Table-wide issues (duplicate PK,
 * orphaned FK) cannot be inferred from a single cell — those are skipped here.
 */

export type PreviewIssueStub = {
  issue_kind?: string | null
  description: string
}

function inferKindFromDescription(desc: string): string | null {
  const d = desc.toLowerCase()
  if (d.includes('null') && d.includes('primary key') && !d.includes('duplicate')) return 'null_pk'
  if (d.includes('null') && (d.includes('non-nullable') || d.includes('required'))) return 'null_required'
  if (d.includes('duplicate') && d.includes('primary')) return 'duplicate_pk'
  if (d.includes('invalid date') || d.includes('not recognisable as any date')) return 'invalid_date_string'
  if (d.includes('non-iso date')) return 'non_iso_date'
  if (d.includes('currency')) return 'currency_format'
  if (d.includes('negative')) return 'negative_value'
  if (d.includes('email')) return 'email_format'
  if (d.includes('phone')) return 'phone_format'
  if (d.includes('not valid integers')) return 'type_mismatch_integer'
  if (d.includes('not valid numbers')) return 'type_mismatch_numeric'
  if (d.includes('orphan') || d.includes('referential integrity')) return 'orphaned_fk'
  if (d.includes('high null rate')) return 'high_null_rate'
  return null
}

function isEmpty(v: string | null | undefined): boolean {
  if (v == null) return true
  return String(v).trim() === ''
}

/**
 * Returns true if this source preview cell value would be flagged given the
 * open quality issues on the field. Skips table-wide issues (duplicate PK,
 * orphaned FK) that can't be detected from a single value in isolation.
 */
export function sourcePreviewValueMatchesIssues(
  before: string | null | undefined,
  issues: PreviewIssueStub[]
): boolean {
  if (issues.length === 0) return false
  const raw = before == null ? null : String(before)
  const trimmed = raw == null ? '' : raw.trim()

  for (const issue of issues) {
    const kind = issue.issue_kind || inferKindFromDescription(issue.description)
    if (!kind) continue

    switch (kind) {
      case 'null_pk':
      case 'null_required':
      case 'high_null_rate':
        if (isEmpty(trimmed)) return true
        break
      case 'duplicate_pk':
      case 'orphaned_fk':
        // Cannot determine from a single cell value
        break
      case 'invalid_date_string':
      case 'non_iso_date':
        if (isEmpty(trimmed)) break
        if (
          !/^\d{4}-\d{2}-\d{2}/.test(trimmed) &&
          !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(trimmed)
        ) {
          return true
        }
        break
      case 'negative_value': {
        if (isEmpty(trimmed)) break
        const n = Number(String(trimmed).replace(/[$,]/g, ''))
        if (!Number.isNaN(n) && n < 0) return true
        break
      }
      case 'email_format':
        if (isEmpty(trimmed)) break
        if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmed)) return true
        break
      case 'phone_format':
        if (isEmpty(trimmed)) break
        if (trimmed.replace(/\D/g, '').length < 10) return true
        break
      case 'type_mismatch_integer':
        if (isEmpty(trimmed)) break
        if (!/^-?\d+$/.test(trimmed)) return true
        break
      case 'type_mismatch_numeric':
        if (isEmpty(trimmed)) break
        if (Number.isNaN(Number(String(trimmed).replace(/[$,]/g, '')))) return true
        break
      case 'currency_format':
        if (isEmpty(trimmed)) break
        if (
          /[$€£¥]/.test(trimmed) &&
          /,/.test(trimmed) &&
          !/^\$?-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(trimmed)
        ) {
          return true
        }
        break
      default:
        break
    }
  }
  return false
}

/** Returns the max affected_records among open issues on a field — used for header count. */
export function maxAffectedRecordsForField(issues: { affected_records?: number }[]): number {
  let m = 0
  for (const i of issues) {
    const n = Number(i.affected_records)
    if (!Number.isNaN(n)) m = Math.max(m, n)
  }
  return m
}
