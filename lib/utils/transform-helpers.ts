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
//
// Two overloads:
//
//   wrapFieldRefsInJsonb(sql, fieldNames: string[])
//     Same-table path. Handles three forms:
//       "Table.Field"  →  (row_data->>'Field')   (table-prefixed quoted ident)
//       "Field"        →  (row_data->>'Field')   (plain quoted identifier)
//       Field          →  (row_data->>'Field')   (bare unquoted identifier)
//     Phase 4a-6 keeps this signature byte-for-byte so existing call
//     sites (single-source mapped TFMs and value assignments) are
//     zero-change.
//
//   wrapFieldRefsInJsonb(sql, fieldsByTableName: Map<string, { alias, fieldNames }>)
//     Cross-table path (Phase 4a-6). Each map entry carries an alias
//     ('d' for the dominant table, 'j0' / 'j1' / … for joined tables)
//     that lines up with the LATERAL clauses generated by
//     `dq_apply_field_transform_joined` in migration 076. Field
//     references must be qualified — bare or singly-quoted refs throw
//     `Cross-table transforms must use table-qualified field references.`
//     because two same-named columns in different tables would otherwise
//     resolve to whichever happens to win.
//
// Preserves single-quoted SQL string literals unchanged in both modes so
// that value strings like 'Prospect' or 'UNKNOWN' are never rewritten.
//
// Strategy: tokenize the SQL into three kinds of tokens before processing:
//   1. Single-quoted literals  → pass through untouched
//   2. Double-quoted identifiers → resolve via map (cross-table) or strip
//                                  prefix and lookup (same-table)
//   3. Bare word identifiers   → resolve via map / set; cross-table mode
//                                also detects the 2-token "Table.Field"
//                                pattern across adjacent tokens

export interface CrossTableFieldEntry {
  alias: string
  fieldNames: Set<string>
}

const QUALIFIED_REQUIRED_MESSAGE =
  'Cross-table transforms must use table-qualified field references.'

const TOKEN_RE = /'(?:[^']|'')*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*/g

export function wrapFieldRefsInJsonb(sql: string, fieldNames: string[]): string
export function wrapFieldRefsInJsonb(
  sql: string,
  fieldsByTableName: Map<string, CrossTableFieldEntry>,
): string
export function wrapFieldRefsInJsonb(
  sql: string,
  fieldsArg: string[] | Map<string, CrossTableFieldEntry>,
): string {
  // ── Same-table overload — preserve byte-for-byte semantics ──────────────
  if (Array.isArray(fieldsArg)) {
    if (!fieldsArg.length) return sql
    const fieldSet = new Set(fieldsArg)
    return sql.replace(TOKEN_RE, (token) => {
      if (token.startsWith("'")) return token
      if (token.startsWith('"')) {
        const inner = token.slice(1, -1)
        const dotIdx = inner.indexOf('.')
        const fieldPart = dotIdx !== -1 ? inner.slice(dotIdx + 1) : inner
        if (fieldSet.has(fieldPart)) return `(row_data->>'${fieldPart}')`
        return token
      }
      if (fieldSet.has(token)) return `(row_data->>'${token}')`
      return token
    })
  }

  // ── Cross-table overload ───────────────────────────────────────────────
  const fieldsByTableName = fieldsArg
  if (fieldsByTableName.size === 0) return sql

  const allFieldNames = new Set<string>()
  for (const entry of fieldsByTableName.values()) {
    for (const name of entry.fieldNames) allFieldNames.add(name)
  }

  // Two-pass strategy:
  //   1. Collect tokens with their start/end indices.
  //   2. Walk the token list left-to-right, joining "Table" "." "Field"
  //      triples (or "Table.Field" inside a quoted identifier) into a
  //      single qualified reference. Bare unqualified refs that happen
  //      to be field names raise.
  type Token = { kind: 'literal' | 'ident'; raw: string; start: number; end: number; inner?: string }
  const tokens: Token[] = []
  for (const m of sql.matchAll(TOKEN_RE)) {
    const raw = m[0]
    const start = m.index ?? 0
    const end = start + raw.length
    if (raw.startsWith("'")) {
      tokens.push({ kind: 'literal', raw, start, end })
    } else if (raw.startsWith('"')) {
      tokens.push({ kind: 'ident', raw, start, end, inner: raw.slice(1, -1) })
    } else {
      tokens.push({ kind: 'ident', raw, start, end, inner: raw })
    }
  }

  const replacements: Array<{ start: number; end: number; text: string }> = []

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.kind === 'literal') continue
    const inner = t.inner!

    // Quoted "Table.Field" — single token form.
    if (t.raw.startsWith('"') && inner.includes('.')) {
      const dotIdx = inner.indexOf('.')
      const tableName = inner.slice(0, dotIdx)
      const fieldName = inner.slice(dotIdx + 1)
      const entry = fieldsByTableName.get(tableName)
      if (entry && entry.fieldNames.has(fieldName)) {
        replacements.push({
          start: t.start,
          end: t.end,
          text: `(${entry.alias}.row_data->>'${fieldName}')`,
        })
        continue
      }
      // Unknown qualifier — leave alone (might be an unrelated identifier).
      continue
    }

    // Look ahead for `<ident> "." <ident>` pair in the original text.
    // The `.` between the two identifier tokens is whitespace-tolerant,
    // matching SQL convention. Works at end-of-input too (no third
    // token required).
    const next = tokens[i + 1]
    if (next && next.kind === 'ident') {
      const between = sql.slice(t.end, next.start)
      // The middle token is a literal or ident that starts with a `.`?
      // Our tokenizer doesn't emit `.` as a separate token, so we detect
      // by checking the gap text contains a single `.`.
      if (/^\s*\.\s*$/.test(between)) {
        const tableName = inner
        const fieldName = next.inner!
        const entry = fieldsByTableName.get(tableName)
        if (entry && entry.fieldNames.has(fieldName)) {
          replacements.push({
            start: t.start,
            end: next.end,
            text: `(${entry.alias}.row_data->>'${fieldName}')`,
          })
          i += 1
          continue
        }
        // Tokens look like `<unknown>.<ident>` — leave the dotted
        // expression alone; it's not a reference into our schema map.
        // (Skip the next token so we don't double-process the field.)
        i += 1
        continue
      }
    }

    // Bare or quoted unqualified identifier. If it matches ANY known
    // field name across all tables in the map, the user wrote a
    // cross-table TFM with an unqualified ref — error.
    if (allFieldNames.has(inner)) {
      throw new Error(QUALIFIED_REQUIRED_MESSAGE)
    }
    // Unknown identifier (SQL keyword, function, etc.) — leave alone.
  }

  if (replacements.length === 0) return sql

  // Apply replacements right-to-left so indices don't shift.
  let out = sql
  for (let r = replacements.length - 1; r >= 0; r -= 1) {
    const { start, end, text } = replacements[r]
    out = out.slice(0, start) + text + out.slice(end)
  }
  return out
}
