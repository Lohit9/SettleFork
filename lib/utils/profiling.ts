/**
 * Pure utility functions for field profiling.
 * No 'use server' — these are synchronous helpers imported by server actions
 * (csv.ts, quality-fixes.ts, manual-fix.ts) and must NOT be async.
 */

// ─── Value distribution ───────────────────────────────────────────────────────

export function computeValueDistribution(values: string[]): { value: string; count: number }[] {
  const frequency = new Map<string, number>()
  for (const val of values) {
    const trimmed = val.trim()
    if (trimmed === '') continue
    frequency.set(trimmed, (frequency.get(trimmed) ?? 0) + 1)
  }
  return Array.from(frequency.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)
}

// ─── Numeric-aware min/max ────────────────────────────────────────────────────

export function computeMinMax(
  values: string[],
  inferredType: string | null
): { min: string | null; max: string | null } {
  const nonEmpty = values.filter((v) => v.trim() !== '')
  if (nonEmpty.length === 0) return { min: null, max: null }

  if (inferredType === 'currency' || inferredType === 'integer' || inferredType === 'decimal') {
    const numeric = nonEmpty
      .map((v) => {
        const cleaned = v.replace(/[$,\s]/g, '')
        const n = Number(cleaned)
        return isNaN(n) ? null : { original: v, n }
      })
      .filter(Boolean) as { original: string; n: number }[]

    if (numeric.length > 0) {
      numeric.sort((a, b) => a.n - b.n)
      return { min: numeric[0].original, max: numeric[numeric.length - 1].original }
    }
  }

  // Lexicographic fallback for text fields
  const sorted = [...nonEmpty].sort()
  return { min: sorted[0], max: sorted[sorted.length - 1] }
}

// ─── Format issue detection ───────────────────────────────────────────────────

export function countFormatIssues(
  values: string[],
  dataType: string,
  inferredType: string | null,
  fieldName: string
): number {
  // ── 1. Semantic type checks (inferred_type wins over SQL type) ──────────────

  if (inferredType === 'email') {
    return values.filter((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())).length
  }

  if (inferredType === 'phone') {
    return values.filter((v) => {
      const digits = v.replace(/\D/g, '')
      return digits.length < 7 || digits.length > 15
    }).length
  }

  if (inferredType === 'currency') {
    return values.filter((v) => {
      const cleaned = v.replace(/[$,\s]/g, '')
      return cleaned !== '' && isNaN(Number(cleaned))
    }).length
  }

  // ── 2. SQL type checks ──────────────────────────────────────────────────────

  if (dataType === 'INT') {
    return values.filter((v) => !/^-?\d+$/.test(v)).length
  }

  if (dataType === 'DECIMAL(18,2)') {
    return values.filter((v) => !/^-?\d+\.?\d*$/.test(v)).length
  }

  if (dataType === 'BOOLEAN') {
    const strictBoolSet = new Set(['true', 'false', '1', '0'])
    return values.filter((v) => !strictBoolSet.has(v.toLowerCase())).length
  }

  if (dataType === 'DATE') {
    return values.filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v)).length
  }

  if (dataType === 'TIMESTAMP') {
    return values.filter((v) => !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)).length
  }

  // ── 3. Heuristic checks for VARCHAR fields based on field name ──────────────

  const lowerName = fieldName.toLowerCase()

  const currencyKeywords = ['revenue', 'amount', 'price', 'cost', 'total', 'salary', 'income', 'budget', 'fee', 'rate', 'pay', 'charge', 'balance']
  if (currencyKeywords.some((k) => lowerName.includes(k))) {
    return values.filter((v) => /[$,]/.test(v)).length
  }

  const dateKeywords = ['date', 'created', 'updated', 'modified', 'dob', 'birth', 'start', 'end', 'expir']
  if (dateKeywords.some((k) => lowerName.includes(k))) {
    return values.filter((v) => {
      const trimmed = v.trim()
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false  // already ISO — no issue
      // Numeric slash/dash/dot (MM/DD/YYYY, DD-MM-YYYY, etc.)
      if (/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(trimmed)) return true
      // YYYY/MM/DD or YYYY.MM.DD
      if (/^\d{4}[\/\.]\d{1,2}[\/\.]\d{1,2}/.test(trimmed)) return true
      // Month name abbreviations or full names (Mar 15, 2024 / 15 March 2024 / etc.)
      if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(trimmed)) return true
      return false
    }).length
  }

  if (lowerName.includes('email') || lowerName.includes('e_mail')) {
    return values.filter((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())).length
  }

  if (lowerName.includes('phone') || lowerName.includes('mobile') || lowerName.includes('fax')) {
    return values.filter((v) => {
      const digits = v.replace(/\D/g, '')
      return digits.length < 7 || digits.length > 15
    }).length
  }

  return 0
}
