// ── Heuristic: does a field mapping need transformation? ─────────────────────
//
// Evaluation order (intentional — do not reorder without reading migration 075):
//
//   1. `needsTransformation === false` → return false.
//      Per migration 075 semantics this value is authoritative:
//        FALSE = explicit user dismissal; this value is authoritative and
//                must not be overridden by heuristics.
//      User intent is the top-priority signal. It wins over stale
//      transformation rows, AI compatibility prose, and every fallback
//      heuristic below.
//
//   2. `hasTransformation` → return true.
//      A transformation row exists, so the field is in-scope regardless of
//      any AI signal. (Reached only when needs_transformation is NULL or
//      TRUE — a user dismissal short-circuits above.)
//
//   3. `needsTransformation === true` → return true.
//      AI / FK-cascade / user reinstatement explicitly flagged the field.
//
//   4. `needsTransformation === null` → type-family fallback.
//      Not yet assessed (manual mappings, older mapping runs, newly
//      created TFMs). Default to "needs transform" since a false positive
//      is recoverable via the dismiss toggle while a false negative is
//      invisible; the same-type direct-compatible passthrough carve-out
//      skips obvious no-op mappings.

export function fieldNeedsTransform(params: {
  typeCompatibility: string | null
  confidence: number | null
  sourceDataType: string
  targetDataType: string
  sourceFieldName: string
  targetFieldName: string
  hasTransformation: boolean
  /**
   * From `target_field_mappings.needs_transformation` (migration 075).
   *   NULL  = not yet assessed
   *   TRUE  = AI / FK-cascade / user-reinstated flag
   *   FALSE = explicit user dismissal; this value is authoritative and
   *           must not be overridden by heuristics.
   */
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

  // Step 1 — Explicit user dismissal wins over every other signal. See
  // migration 075 header for the documented semantic. This check MUST come
  // before the `hasTransformation` short-circuit so that a user who
  // dismisses after a transformation was ever applied still gets their
  // intent honored across refreshes and readiness-score recomputes.
  if (needsTransformation === false) return false

  // Step 2 — A transformation row exists; the field is in-scope.
  if (hasTransformation) return true

  // Step 3 — Explicit positive flag (AI, FK cascade, user reinstatement).
  if (needsTransformation === true) return true

  // Step 4 — Not yet assessed. Default to "needs transform" unless this is
  // a high-confidence same-type explicit-direct-compatible passthrough.
  const compat = (typeCompatibility ?? '').toLowerCase()
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
