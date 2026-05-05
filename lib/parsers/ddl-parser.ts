/**
 * DDL Parser
 *
 * Deterministic parsing of standard CREATE TABLE statements plus an
 * AI-assisted fallback for non-standard dialects (Oracle, SAP HANA,
 * SQL Server bracket notation, etc.).
 */

import { callLLM } from '@/lib/ai/llm-client'
import { EMIT_PARSED_DDL_TOOL } from '@/lib/ai/tool-schemas'

// ── Public types ──────────────────────────────────────────────────────────────

export type CheckConstraint =
  | { type: 'in_list'; allowedValues: string[]; raw: string }
  | { type: 'regex'; pattern: string; raw: string }
  | { type: 'range'; min?: number; max?: number; raw: string }
  | { type: 'custom'; raw: string }

export interface ParsedField {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isForeignKey: boolean
  fkReference: string | null
  defaultValue: string | null
  checkConstraint: CheckConstraint | null
}

export interface ParsedTable {
  name: string
  fields: ParsedField[]
}

// ── Deterministic parser ──────────────────────────────────────────────────────

/** Remove SQL block comments and line comments. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

/**
 * Split a comma-separated list that may contain nested parentheses
 * (e.g. type definitions like DECIMAL(18,2)).
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
      continue
    }
    current += ch
  }
  const last = current.trim()
  if (last) parts.push(last)
  return parts
}

/**
 * Un-bracket SQL Server / MySQL quoted identifiers and strip schema prefixes.
 * "[dbo].[Customer]" → "Customer"
 * "dbo.Customer"     → "Customer"
 * "`customer`"       → "customer"
 */
function unquoteIdent(raw: string): string {
  // Remove surrounding brackets, backticks, double-quotes
  let s = raw.trim().replace(/^[\[`"]|[\]`"]$/g, '')
  // Remove schema prefix (last segment only)
  const dot = s.lastIndexOf('.')
  if (dot !== -1) s = s.slice(dot + 1).replace(/^[\[`"]|[\]`"]$/g, '')
  return s
}

/** Parse the data type token — may include size like VARCHAR(255). */
function parseDataType(rest: string): { dataType: string; remainder: string } {
  // Match an identifier optionally followed by (size) or (precision, scale)
  const m = rest.match(
    /^(\w+(?:\s*\(\s*[\d\s,]+\s*\))?(?:\s+(?:PRECISION|VARYING|UNSIGNED))?(?:\s+WITHOUT\s+TIME\s+ZONE|WITH\s+TIME\s+ZONE)?)/i
  )
  if (!m) return { dataType: '', remainder: rest }
  return {
    dataType: m[1].trim().toUpperCase(),
    remainder: rest.slice(m[0].length),
  }
}

/**
 * Parse the body of a CHECK(...) expression into a structured constraint.
 * Handles IN lists, regex patterns (~), and numeric range comparisons.
 * Falls back to { type: 'custom', raw } for anything unrecognized.
 */
export function parseCheckConstraint(constraintBody: string): CheckConstraint {
  const text = constraintBody.trim()

  // Pattern 1: IN list — field_name IN ('val1', 'val2', ...)
  // Also handles NOT IN (we ignore NOT and still record the value list)
  const inMatch = text.match(/\bIN\s*\(\s*((?:'[^']*'(?:\s*,\s*)?)+)\s*\)/i)
  if (inMatch) {
    const valuesStr = inMatch[1]
    const values = [...valuesStr.matchAll(/'([^']*)'/g)].map((m) => m[1])
    if (values.length > 0) {
      return { type: 'in_list', allowedValues: values, raw: text }
    }
  }

  // Pattern 2: Regex — field_name ~ 'pattern'  or  field_name ~* 'pattern'
  const regexMatch = text.match(/~\*?\s*'([^']+)'/)
  if (regexMatch) {
    return { type: 'regex', pattern: regexMatch[1], raw: text }
  }

  // Pattern 3: Range — field >= N [AND field <= N]  or  field BETWEEN N AND N
  const betweenMatch = text.match(/BETWEEN\s+(-?[\d.]+)\s+AND\s+(-?[\d.]+)/i)
  if (betweenMatch) {
    return {
      type: 'range',
      min: parseFloat(betweenMatch[1]),
      max: parseFloat(betweenMatch[2]),
      raw: text,
    }
  }

  const gteMatch = text.match(/>=\s*(-?[\d.]+)/)
  const lteMatch = text.match(/<=\s*(-?[\d.]+)/)
  const gtMatch  = text.match(/(?<![<>!])>\s*(-?[\d.]+)/)
  const ltMatch  = text.match(/(?<![<>!])<\s*(-?[\d.]+)/)

  if (gteMatch || lteMatch || gtMatch || ltMatch) {
    return {
      type: 'range',
      min: gteMatch ? parseFloat(gteMatch[1]) : (gtMatch ? parseFloat(gtMatch[1]) : undefined),
      max: lteMatch ? parseFloat(lteMatch[1]) : (ltMatch ? parseFloat(ltMatch[1]) : undefined),
      raw: text,
    }
  }

  // Fallback: store raw text
  return { type: 'custom', raw: text }
}

/**
 * Extract content inside the outermost CHECK(...) parentheses.
 * Handles nested parens correctly.
 */
function extractCheckBody(src: string, checkKeywordIndex: number): string | null {
  const openIdx = src.indexOf('(', checkKeywordIndex)
  if (openIdx === -1) return null
  let depth = 1
  let i = openIdx + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') depth--
    i++
  }
  if (depth !== 0) return null
  return src.slice(openIdx + 1, i - 1)
}

/** Parse one column definition line. Returns null for pure constraint lines. */
function parseColumnDef(def: string): ParsedField | null {
  const trimmed = def.trim()
  if (!trimmed) return null

  const upper = trimmed.toUpperCase()

  // Skip table-level-only constraint lines (those starting with keywords, not a column name)
  if (
    /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|KEY\s+\w)/.test(upper)
  ) {
    return null
  }

  // Standalone table-level CHECK (without CONSTRAINT keyword) — skip as column def
  if (/^CHECK\s*\(/.test(upper)) {
    return null
  }

  // Column name: first identifier (possibly bracket/backtick quoted)
  const nameMatch = trimmed.match(/^(\[[\w\s]+\]|`[\w\s]+`|"[\w\s]+"|\w+)\s+/)
  if (!nameMatch) return null
  const name = unquoteIdent(nameMatch[1])

  const afterName = trimmed.slice(nameMatch[0].length)
  const { dataType, remainder } = parseDataType(afterName)
  if (!dataType) return null

  const flags = remainder.toUpperCase()

  let isNullable = !/\bNOT\s+NULL\b/.test(flags)
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/.test(flags)
  // PRIMARY KEY implies NOT NULL per SQL standard
  if (isPrimaryKey) isNullable = false
  const isForeignKey = /\bREFERENCES\b/.test(flags)

  let fkReference: string | null = null
  if (isForeignKey) {
    const refMatch = remainder.match(
      /REFERENCES\s+(?:[\w[\]`"]+\.)*?[\[`"]?([\w]+)[\]`"]?\s*\(\s*[\[`"]?([\w]+)[\]`"]?\s*\)/i
    )
    if (refMatch) fkReference = `${refMatch[1]}.${refMatch[2]}`
  }

  let defaultValue: string | null = null
  const defMatch = remainder.match(/\bDEFAULT\s+('(?:[^']*(?:''[^']*)*)'|\S+)/i)
  if (defMatch) {
    defaultValue = defMatch[1].replace(/^'|'$/g, '') || defMatch[1]
  }

  // Extract inline CHECK constraint from this column definition
  let checkConstraint: CheckConstraint | null = null
  const checkIdx = flags.indexOf('CHECK')
  if (checkIdx !== -1) {
    // Find the actual 'CHECK' position in remainder (case-insensitive)
    const remUpper = remainder.toUpperCase()
    const remCheckIdx = remUpper.indexOf('CHECK')
    if (remCheckIdx !== -1) {
      const body = extractCheckBody(remainder, remCheckIdx)
      if (body) {
        checkConstraint = parseCheckConstraint(body)
      }
    }
  }

  return {
    name,
    dataType,
    isNullable,
    isPrimaryKey,
    isForeignKey,
    fkReference,
    defaultValue,
    checkConstraint,
  }
}

/**
 * Apply table-level PRIMARY KEY, FOREIGN KEY, and CHECK constraints
 * to the already-parsed field list.
 */
function applyTableConstraints(parts: string[], fields: ParsedField[]): void {
  const fieldByName = new Map(fields.map((f) => [f.name.toUpperCase(), f]))

  for (const part of parts) {
    const trimmed = part.trim()
    const upper = trimmed.toUpperCase()

    // PRIMARY KEY (col1, col2, ...)
    if (/(?:CONSTRAINT\s+\w+\s+)?PRIMARY\s+KEY\s*\(/.test(upper)) {
      const m = trimmed.match(
        /(?:CONSTRAINT\s+\w+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i
      )
      if (m) {
        for (const col of m[1].split(',')) {
          const f = fieldByName.get(unquoteIdent(col).toUpperCase())
          if (f) { f.isPrimaryKey = true; f.isNullable = false }
        }
      }
    }

    // FOREIGN KEY (col) REFERENCES table(col)
    if (/(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(/.test(upper)) {
      const m = trimmed.match(
        /(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:[\w[\]`".]+\.)*?[\[`"]?([\w]+)[\]`"]?\s*\(\s*[\[`"]?([\w]+)[\]`"]?\s*\)/i
      )
      if (m) {
        const refTable = m[2]
        const refCol = m[3]
        for (const col of m[1].split(',')) {
          const f = fieldByName.get(unquoteIdent(col).toUpperCase())
          if (f) { f.isForeignKey = true; f.fkReference = `${refTable}.${refCol}` }
        }
      }
    }

    // CHECK constraints (table-level and CONSTRAINT...CHECK)
    // Match: CONSTRAINT name CHECK (...) or CHECK (...)
    if (/(?:CONSTRAINT\s+\w+\s+)?CHECK\s*\(/.test(upper)) {
      const checkIdx = upper.indexOf('CHECK')
      const body = extractCheckBody(trimmed, checkIdx)
      if (!body) continue

      const parsed = parseCheckConstraint(body)

      // Identify which field this constraint targets by looking for a field name
      // at the start of the body. Common forms: "field_name IN (...)", "field_name >= N"
      const bodyUpper = body.toUpperCase().trim()
      // Try to match the first word in the body against known field names
      const firstWordMatch = body.trim().match(/^(\w+)/)
      if (firstWordMatch) {
        const candidateName = firstWordMatch[1].toUpperCase()
        const targetField = fieldByName.get(candidateName)
        if (targetField && !targetField.checkConstraint) {
          targetField.checkConstraint = parsed
        }
      }
    }
  }
}

/** Main deterministic DDL parser. */
export function parseDDL(sql: string): ParsedTable[] {
  const clean = stripComments(sql)
  const tables: ParsedTable[] = []

  // Regex to find CREATE TABLE statements with the opening paren
  // Handles: IF NOT EXISTS, schema.prefix, [brackets], `backticks`, "quotes"
  const createTableRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w[\]`".]+\s*\.\s*)?(?:\[|`|")?(\w+)(?:\]|`|")?\s*\(/gi

  let match: RegExpExecArray | null
  while ((match = createTableRe.exec(clean)) !== null) {
    const tableName = match[1]
    const bodyStart = match.index + match[0].length

    // Walk forward to find the matching closing paren
    let depth = 1
    let i = bodyStart
    while (i < clean.length && depth > 0) {
      if (clean[i] === '(') depth++
      else if (clean[i] === ')') depth--
      i++
    }

    const body = clean.slice(bodyStart, i - 1)
    const parts = splitTopLevel(body)

    const fields: ParsedField[] = []
    for (const part of parts) {
      const field = parseColumnDef(part)
      if (field) fields.push(field)
    }

    // Apply table-level PRIMARY KEY / FOREIGN KEY / CHECK constraints
    applyTableConstraints(parts, fields)

    if (fields.length > 0) {
      tables.push({ name: tableName, fields })
    }
  }

  return tables
}

// ── AI-assisted fallback ──────────────────────────────────────────────────────

// PR 13.1: Cached via Anthropic prompt caching (cacheControl: true).
// Editing this string invalidates the prompt cache; expect a 1-day cost
// spike after deploys that touch this prompt while the cache rewarms.
const DDL_PARSE_SYSTEM = `You are a SQL DDL parser. Given a DDL script, extract all CREATE TABLE definitions and return the structure as JSON.
Respond with ONLY valid JSON, no markdown, no explanation:
{
  "tables": [
    {
      "name": "TABLE_NAME",
      "fields": [
        {
          "name": "FIELD_NAME",
          "dataType": "VARCHAR(255)",
          "isNullable": true,
          "isPrimaryKey": false,
          "isForeignKey": false,
          "fkReference": null,
          "defaultValue": null,
          "checkConstraint": null
        }
      ]
    }
  ]
}
Handle any SQL dialect: PostgreSQL, MySQL, Oracle, SQL Server, SAP HANA, DB2.
Extract the most accurate type information possible. Use the canonical type name with precision/scale where present.
For CHECK constraints, populate checkConstraint with one of these shapes:
- IN list:  { "type": "in_list", "allowedValues": ["A","B","C"], "raw": "status IN ('A','B','C')" }
- Regex:    { "type": "regex", "pattern": "^[A-Z]{2}$", "raw": "code ~ '^[A-Z]{2}$'" }
- Range:    { "type": "range", "min": 0, "max": 24, "raw": "hours >= 0 AND hours <= 24" }
- Other:    { "type": "custom", "raw": "original constraint text" }
If no CHECK constraint exists for the field, set checkConstraint to null.`

export async function parseDDLWithAI(
  projectId: string,
  userId: string,
  sql: string,
): Promise<ParsedTable[]> {
  // PR 12 H1: tool use under flag ON; legacy text+JSON.parse under flag OFF.
  const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
  const result = await callLLM({
    feature: 'ddl_parsing',
    systemPrompt: DDL_PARSE_SYSTEM,
    userMessage: sql.slice(0, 12000),
    maxTokens: 4096,
    projectId,
    userId,
    promptVersion: 'ddl-parsing-v1',
    abuseUserId: userId,
    ...(phase2Enabled && { tool: EMIT_PARSED_DDL_TOOL }),
    // PR 13.1: prompt caching for DDL parsing. Onboarding bursts process
    // multiple DDL docs in sequence; tool definition (~3.5K tk) is the
    // bulk of cacheable surface. System prompt + tool both static.
    // PR-CACHE-HOTFIX: disabled to unblock 4-block limit. See INF-5 for
    // selective re-enable on top 4 blocks.
    cacheControl: false,
  })

  let parsed: { tables: ParsedTable[] }
  if (result.kind === 'toolUse') {
    parsed = result.toolUse.input as { tables: ParsedTable[] }
  } else {
    // Strip markdown fences if present
    const cleaned = result.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()

    parsed = JSON.parse(cleaned) as { tables: ParsedTable[] }
  }

  if (!Array.isArray(parsed?.tables)) return []

  return parsed.tables.filter(
    (t) => t.name && Array.isArray(t.fields) && t.fields.length > 0
  )
}
