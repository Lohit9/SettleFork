/**
 * DDL Parser
 *
 * Deterministic parsing of standard CREATE TABLE statements plus an
 * AI-assisted fallback for non-standard dialects (Oracle, SAP HANA,
 * SQL Server bracket notation, etc.).
 */

import { callClaude } from '@/lib/ai/claude'

// ── Public types ──────────────────────────────────────────────────────────────

export interface ParsedField {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isForeignKey: boolean
  fkReference: string | null
  defaultValue: string | null
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

/** Parse one column definition line. Returns null for constraint lines. */
function parseColumnDef(def: string): ParsedField | null {
  const trimmed = def.trim()
  if (!trimmed) return null

  const upper = trimmed.toUpperCase()

  // Skip table-level constraints
  if (
    /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|INDEX|KEY\s+\w)/.test(upper)
  ) {
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

  const isNullable = !/\bNOT\s+NULL\b/.test(flags)
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/.test(flags)
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

  return {
    name,
    dataType,
    isNullable,
    isPrimaryKey,
    isForeignKey,
    fkReference,
    defaultValue,
  }
}

/**
 * Apply table-level PRIMARY KEY and FOREIGN KEY constraints
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

    // Apply table-level PRIMARY KEY / FOREIGN KEY constraints
    applyTableConstraints(parts, fields)

    if (fields.length > 0) {
      tables.push({ name: tableName, fields })
    }
  }

  return tables
}

// ── AI-assisted fallback ──────────────────────────────────────────────────────

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
          "defaultValue": null
        }
      ]
    }
  ]
}
Handle any SQL dialect: PostgreSQL, MySQL, Oracle, SQL Server, SAP HANA, DB2.
Extract the most accurate type information possible. Use the canonical type name with precision/scale where present.`

export async function parseDDLWithAI(sql: string): Promise<ParsedTable[]> {
  const raw = await callClaude(DDL_PARSE_SYSTEM, sql.slice(0, 12000), 4096)

  // Strip markdown fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  const parsed = JSON.parse(cleaned) as { tables: ParsedTable[] }

  if (!Array.isArray(parsed?.tables)) return []

  return parsed.tables.filter(
    (t) => t.name && Array.isArray(t.fields) && t.fields.length > 0
  )
}
