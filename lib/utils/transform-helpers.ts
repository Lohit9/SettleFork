// ── Heuristic: does a field mapping need transformation? ─────────────────────

export function fieldNeedsTransform(params: {
  typeCompatibility: string | null
  confidence: number | null
  sourceDataType: string
  targetDataType: string
  sourceFieldName: string
  targetFieldName: string
  hasTransformation: boolean
}): boolean {
  const {
    typeCompatibility,
    confidence,
    sourceDataType,
    targetDataType,
    sourceFieldName,
    targetFieldName,
    hasTransformation,
  } = params

  if (hasTransformation) return true
  if (confidence !== null && confidence < 75) return true

  const compat = (typeCompatibility ?? '').toLowerCase()
  if (/needs|truncat|convers|mapping|hash|transform|convert/.test(compat))
    return true

  if (sourceDataType !== targetDataType) return true

  const srcUp = sourceFieldName.toUpperCase()
  const tgtUp = targetFieldName.toUpperCase()
  if (
    (tgtUp.endsWith('_CODE') && !srcUp.endsWith('_CODE')) ||
    (tgtUp.endsWith('_TYPE') && !srcUp.endsWith('_TYPE'))
  )
    return true

  return false
}

// ── JSONB field reference rewriting ──────────────────────────────────────────
// Replaces bare field names and double-quoted identifiers with row_data->>'...'
// Single-quoted string literals (user-data values) are preserved unchanged.

export function wrapFieldRefsInJsonb(sql: string, fieldNames: string[]): string {
  if (!fieldNames.length) return sql

  // Sort longest first so longer names match before their shorter substrings
  const sorted = [...new Set(fieldNames)].sort((a, b) => b.length - a.length)
  const escapedNames = sorted.map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  const allNamesPattern = escapedNames.join('|')

  // Split on single-quoted string literals to protect their contents.
  // Pattern handles escaped quotes (\' and '' inside literals).
  const parts = sql.split(/(\'(?:[^\'\\]|\\.|\'\')*\')/g)

  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part // string literal — unchanged

      // Single-pass replacement: "FieldName" or bare FieldName (word boundary)
      return part.replace(
        new RegExp(
          `("(?:${allNamesPattern})")|\\b(${allNamesPattern})\\b`,
          'g'
        ),
        (_, quoted, bare) =>
          `row_data->>'${quoted ? quoted.slice(1, -1) : bare}'`
      )
    })
    .join('')
}
