// ── Heuristic: does a field mapping need transformation? ─────────────────────

export function fieldNeedsTransform(params: {
  typeCompatibility: string | null
  confidence: number | null
  sourceDataType: string
  targetDataType: string
  sourceFieldName: string
  targetFieldName: string
  hasTransformation: boolean
  /** From field_mappings.needs_transformation when set by mapping generation */
  needsTransformation?: boolean | null
}): boolean {
  const {
    typeCompatibility,
    confidence,
    sourceDataType,
    targetDataType,
    sourceFieldName,
    targetFieldName,
    hasTransformation,
    needsTransformation,
  } = params

  // 1. If a transformation already exists, always show the badge
  if (hasTransformation) return true

  // 2. If Claude explicitly assessed this field, trust its judgment
  if (needsTransformation === true) return true
  if (needsTransformation === false) return false

  // 3. Fallback heuristic (manually created mappings or suggestRemainingMappings where needs_transformation is null)

  if (confidence !== null && confidence < 75) return true

  const compat = (typeCompatibility ?? '').toLowerCase()
  // Check for explicit "no conversion needed" signal first
  if (/direct compatible|no conversion needed|compatible.?no/.test(compat)) return false
  // Check for transformation signals
  if (/needs|truncat|convers|mapping|hash|transform|convert|strip|normalize|reformat|parse/.test(compat))
    return true

  // Normalize types for comparison — don't flag text vs varchar mismatches
  const normalizeType = (t: string): string =>
    t
      .toLowerCase()
      .replace(/varchar\(\d+\)/g, 'varchar')
      .replace(/character varying(\(\d+\))?/g, 'varchar')
      .replace(/^text$/g, 'varchar')
      .replace(/decimal\(\d+,?\d*\)/g, 'decimal')
      .replace(/numeric\(\d+,?\d*\)/g, 'decimal')
      .trim()

  if (normalizeType(sourceDataType) !== normalizeType(targetDataType)) return true

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
//
// Converts field name references in a SQL expression to JSONB row_data access.
// Handles three forms:
//   "Table.Field"  →  row_data->>'Field'   (table-prefixed quoted identifier)
//   "Field"        →  row_data->>'Field'   (plain quoted identifier)
//   Field          →  row_data->>'Field'   (bare unquoted identifier)
//
// Preserves single-quoted SQL string literals unchanged so that value strings
// like 'Prospect' or 'UNKNOWN' are never rewritten.
//
// Strategy: tokenize the SQL into three kinds of tokens before processing:
//   1. Single-quoted literals  → pass through untouched
//   2. Double-quoted identifiers → strip optional table prefix, replace if known
//   3. Bare word identifiers   → replace if the name is a known field

export function wrapFieldRefsInJsonb(sql: string, fieldNames: string[]): string {
  if (!fieldNames.length) return sql

  const fieldSet = new Set(fieldNames)

  // Token regex (tried left-to-right, first match wins):
  //   1. Single-quoted SQL string literal with '' escaping: '...''...'
  //   2. Double-quoted SQL identifier:                      "..."
  //   3. Bare SQL identifier (letter/underscore start):     word
  const TOKEN_RE = /'(?:[^']|'')*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*/g

  return sql.replace(TOKEN_RE, (token) => {
    // ── Single-quoted string literal ──────────────────────────────────────
    if (token.startsWith("'")) {
      return token // never rewrite value strings
    }

    // ── Double-quoted identifier ──────────────────────────────────────────
    if (token.startsWith('"')) {
      const inner = token.slice(1, -1) // strip surrounding quotes
      const dotIdx = inner.indexOf('.')
      // "Table.Field" form — strip the table prefix, keep only the field part
      const fieldPart = dotIdx !== -1 ? inner.slice(dotIdx + 1) : inner
      if (fieldSet.has(fieldPart)) {
        return `(row_data->>'${fieldPart}')`
      }
      return token // unknown identifier — leave as-is
    }

    // ── Bare unquoted identifier ──────────────────────────────────────────
    if (fieldSet.has(token)) {
      return `(row_data->>'${token}')`
    }
    return token // SQL keyword or unknown name — leave as-is
  })
}
