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
    hasTransformation,
    needsTransformation,
  } = params

  // Normalize types into coarse families for the "skip flagging" heuristic.
  // Used ONLY by the direct-compatible passthrough check below — not by any
  // real data-type handling. The goal is: when Claude says "direct compatible"
  // at high confidence, source and target should agree on the broad family
  // (both strings, both numbers, etc.) regardless of length/precision or the
  // specific dialect spelling. Previously this asymmetrically stripped
  // varchar(n) → varchar but left char(n) → char(n), which caused every
  // CSV-sourced (VARCHAR(N)) column mapped to a CHAR(n) target to fall out of
  // the exception even when the AI had explicitly said no conversion was
  // needed.
  const normalizeType = (t: string): string => {
    const lower = t.toLowerCase().trim()

    // String family → 'string'
    // Covers: varchar(n), char(n), bpchar(n), nvarchar(n), nchar(n),
    // character varying(n), text, clob, string
    if (
      /^(varchar|character varying|char|bpchar|nvarchar|nchar)(\(\d+\))?$/.test(lower) ||
      lower === 'text' ||
      lower === 'clob' ||
      lower === 'string'
    ) {
      return 'string'
    }

    // Numeric family → 'number'
    // Covers: int, integer, bigint, smallint, tinyint, int2, int4, int8,
    // serial variants, decimal(n,m), numeric(n,m), float, double, real,
    // float4, float8, double precision, money
    if (
      /^(int|integer|bigint|smallint|tinyint|int[248]|serial|bigserial)$/.test(lower) ||
      /^(decimal|numeric|float|double|real|float[48]|double precision|money)(\(\d+,?\d*\))?$/.test(lower)
    ) {
      return 'number'
    }

    // Boolean family → 'boolean'
    if (/^(bool|boolean|bit)$/.test(lower)) {
      return 'boolean'
    }

    // Timestamp family → 'timestamp'
    if (/^(timestamp|timestamptz|timestamp with(out)? time zone|datetime|datetime2)$/.test(lower)) {
      return 'timestamp'
    }

    // Date family → 'date'
    if (lower === 'date') {
      return 'date'
    }

    return lower
  }

  const compat = (typeCompatibility ?? '').toLowerCase()

  // 1. If a transformation already exists, always show the badge
  if (hasTransformation) return true

  // 2. If Claude explicitly flagged this field as NOT needing transformation,
  //    trust that — unless the type_compatibility text contradicts it with a
  //    known transformation keyword (defensive: catches prompt drift where the
  //    AI writes "uppercase needed" but forgot to set the flag).
  if (needsTransformation === false) {
    if (
      /needs|truncat|convers|mapping|hash|transform|convert|strip|normalize|reformat|parse|standardize|cast|uppercase|lowercase|format|clean|splits|concat|combine|extract|pad|trim|decode/.test(
        compat,
      )
    ) {
      return true
    }
    return false
  }
  if (needsTransformation === true) return true

  // 3. NULL means Claude didn't explicitly assess (manual mappings or older
  //    mapping runs). Default to "needs transform" — it's safer to surface a
  //    false positive (the user can dismiss via "Mark as no transform needed")
  //    than to hide a false negative the user can't easily discover.
  //    Exception: high-confidence, same-type, explicitly "direct compatible"
  //    passthroughs are safe to skip.
  const typesMatch = normalizeType(sourceDataType) === normalizeType(targetDataType)
  const isDirectCompatible = /direct compatible|no conversion needed|compatible.?no/.test(compat)

  if (isDirectCompatible && typesMatch && confidence !== null && confidence >= 90) {
    return false
  }

  return true
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
