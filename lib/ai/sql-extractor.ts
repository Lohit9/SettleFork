/**
 * Extracts SQL from Claude's response, handling common patterns:
 * 1. Clean SQL (no preamble, no fences) — returned as-is
 * 2. Markdown-fenced SQL with optional preamble text before the fence
 * 3. Natural language preamble followed by unfenced SQL
 * 4. Trailing explanation after the SQL
 *
 * SAFETY: If the input already looks like valid SQL, return it unchanged.
 * This function should never corrupt working SQL.
 */
export function extractSQL(raw: string): string {
  if (!raw || raw.trim().length === 0) return raw

  let cleaned = raw.trim()

  // Step 1: If the response contains a markdown code fence, extract its content.
  // This handles: "Here's the query:\n```sql\nSELECT ...\n```\nThis returns..."
  const fenceMatch = cleaned.match(/```(?:sql)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch && fenceMatch[1]?.trim()) {
    cleaned = fenceMatch[1].trim()
    cleaned = cleaned.replace(/;+\s*$/, '').trim()
    return cleaned
  }

  // Step 2: Strip leading/trailing fences without content match (partial fences)
  cleaned = cleaned
    .replace(/^```sql\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  // Step 3: If the result already starts with a SQL token, return it.
  // This is the fast path for well-behaved responses.
  if (startsWithSQLToken(cleaned)) {
    cleaned = cleaned.replace(/;+\s*$/, '').trim()
    return cleaned
  }

  // Step 4: Natural language preamble — find the first SQL token and strip everything before it.
  // Only do this for known SQL starting tokens to avoid false positives.
  const sqlTokens = [
    'SELECT ', 'CASE ', 'CASE\n', 'COALESCE(', 'NULLIF(', 'CAST(', 'TRIM(',
    'UPPER(', 'LOWER(', 'LEFT(', 'RIGHT(', 'SUBSTRING(', 'REPLACE(',
    'CONCAT(', 'REGEXP_REPLACE(', 'TO_DATE(', 'TO_CHAR(', 'TO_NUMBER(',
    'TRY_CONVERT(', 'CONVERT(', 'ISNULL(', 'IIF(', 'CHARINDEX(',
    'SPLIT_PART(', 'HASHBYTES(', 'LPAD(', 'RPAD(',
  ]

  const lowerCleaned = cleaned.toLowerCase()
  let earliestIdx = -1

  for (const token of sqlTokens) {
    const idx = lowerCleaned.indexOf(token.toLowerCase())
    if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx
    }
  }

  if (earliestIdx > 0) {
    cleaned = cleaned.slice(earliestIdx).trim()
    cleaned = cleaned.replace(/;+\s*$/, '').trim()
    return cleaned
  }

  // Step 5: No SQL token found at all — return the original trimmed string.
  // Let downstream validation handle it (validateGeneratedSQL will reject it for queries,
  // and the transform will fail on test/apply).
  cleaned = cleaned.replace(/;+\s*$/, '').trim()
  return cleaned
}

/**
 * Check if a string starts with a recognized SQL token.
 * Used to fast-path responses that are already clean SQL.
 */
function startsWithSQLToken(sql: string): boolean {
  const lower = sql.toLowerCase().trimStart()
  const tokens = [
    'select', 'case', 'coalesce(', 'nullif(', 'cast(', 'trim(',
    'upper(', 'lower(', 'left(', 'right(', 'substring(', 'replace(',
    'concat(', 'regexp_replace(', 'to_date(', 'to_char(', 'to_number(',
    'try_convert(', 'convert(', 'isnull(', 'iif(', 'charindex(',
    'split_part(', 'hashbytes(', 'lpad(', 'rpad(', '(',
  ]
  return tokens.some((t) => lower.startsWith(t))
}

/**
 * Extract SQL specifically for transform expressions.
 * Transforms don't start with SELECT — they're CASE, COALESCE, function calls, etc.
 * This is the same as extractSQL but exported separately for clarity.
 */
export function extractTransformSQL(raw: string): string {
  return extractSQL(raw)
}

/**
 * Extract SQL specifically for SELECT queries.
 * After extraction, verifies the result starts with SELECT.
 * Returns the original if extraction can't find a SELECT.
 */
export function extractSelectSQL(raw: string): string {
  const extracted = extractSQL(raw)

  // If we extracted something that starts with SELECT, use it
  if (extracted.toLowerCase().trimStart().startsWith('select')) {
    return extracted
  }

  // Last resort: scan for SELECT specifically (handles deeply buried queries)
  const selectIdx = raw.toLowerCase().indexOf('select ')
  if (selectIdx !== -1) {
    let result = raw.slice(selectIdx).trim()
    // Remove trailing non-SQL text after the query ends
    const trailingPatterns = [
      /\n\n(?:this |note:|explanation:|the above|i |here )/i,
      /\n\n(?:let me|please |feel free)/i,
    ]
    for (const pattern of trailingPatterns) {
      const match = result.match(pattern)
      if (match?.index) {
        result = result.slice(0, match.index).trim()
      }
    }
    result = result.replace(/;+\s*$/, '').trim()
    return result
  }

  // Nothing worked — return the raw extraction result
  return extracted
}

/*
 * Expected behavior:
 *
 * extractSQL('SELECT * FROM users') → 'SELECT * FROM users'
 * extractSQL('```sql\nSELECT * FROM users\n```') → 'SELECT * FROM users'
 * extractSQL('Here is the query:\n```sql\nSELECT * FROM users\n```') → 'SELECT * FROM users'
 * extractSQL('Here is the query:\nSELECT * FROM users') → 'SELECT * FROM users'
 * extractSQL('CASE WHEN x IS NULL THEN 0 ELSE x END') → 'CASE WHEN x IS NULL THEN 0 ELSE x END'
 * extractSQL('The transform expression is:\nCASE WHEN x IS NULL THEN 0 ELSE x END') → 'CASE WHEN x IS NULL THEN 0 ELSE x END'
 * extractSQL('Looking at the schema, I need to handle nulls.\n\nCASE WHEN ...') → 'CASE WHEN ...'
 * extractSQL('COALESCE(TRIM(x), 0)') → 'COALESCE(TRIM(x), 0)'
 * extractSelectSQL('Here is a query:\nSELECT * FROM users\n\nThis returns all users.') → 'SELECT * FROM users'
 */
