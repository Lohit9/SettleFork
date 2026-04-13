/**
 * SQL Rewriter — MVP abstraction layer
 *
 * Translates user-friendly SQL (e.g., SELECT * FROM softpak.prices)
 * into JSONB queries against the data_rows table.
 *
 * Post-MVP: replace internals with direct query routing to a data cluster.
 * The interface (rewriteQuery) stays the same.
 *
 * Handles:
 *  - SELECT * / SELECT columns from a single table
 *  - WHERE, GROUP BY, HAVING, ORDER BY, LIMIT
 *  - Two-table JOINs with aliases
 *  - Aggregates: COUNT(*), SUM("col"), AVG("col")
 *
 * Does NOT handle (fails gracefully):
 *  - CTEs (WITH clauses)
 *  - Subqueries in FROM clause
 *  - UNION / INTERSECT / EXCEPT
 */

export interface TableMappingField {
  name: string
  dataType: string
  sampleValues?: string[]
  nullPercentage?: number
  formatIssues?: number
  cardinality?: number
  valueDistribution?: Array<{ value: string; count: number }>
  minValue?: string
  maxValue?: string
}

export interface TableMapping {
  friendlyName: string           // "softpak.prices"
  tableId: string                // UUID of the source/target table
  datasetRole: 'source' | 'target'
  /** Only set for target tables — the table_mappings.id for staged_data_rows lookups */
  tableMappingId?: string | null
  fields: TableMappingField[]
}

export interface RewriteResult {
  rewrittenSQL: string
  error?: string
}

// ─── Data source helpers ──────────────────────────────────────────────────────

/** Physical table name to query: staged_data_rows for target, data_rows for source */
function rowDataSource(m: TableMapping): 'data_rows' | 'staged_data_rows' {
  return m.datasetRole === 'target' && m.tableMappingId ? 'staged_data_rows' : 'data_rows'
}

/** WHERE condition to scope a query to one logical table's rows */
function rowIdCondition(m: TableMapping, tableRef: string | null): string {
  const prefix = tableRef ? `${tableRef}.` : ''
  if (m.datasetRole === 'target' && m.tableMappingId) {
    return `${prefix}table_mapping_id = '${m.tableMappingId}'`
  }
  return `${prefix}table_id = '${m.tableId}'`
}

/**
 * Column extraction expression.
 * - Source tables: TRIM(tableRef.row_data->>'field')
 * - Target tables: COALESCE(TRIM(tableRef.transformed_row_data->>'field'), TRIM(tableRef.source_row_data->>'field'))
 *   The COALESCE gives precedence to the explicitly transformed value, falling back to the
 *   original source value for passthrough fields that haven't been transformed yet.
 */
function colExtractExpr(fieldName: string, tableRef: string | null, m: TableMapping): string {
  const prefix = tableRef ? `${tableRef}.` : ''
  if (m.datasetRole === 'target' && m.tableMappingId) {
    return `COALESCE(TRIM(${prefix}transformed_row_data->>'${fieldName}'), TRIM(${prefix}source_row_data->>'${fieldName}'))`
  }
  return `TRIM(${prefix}row_data->>'${fieldName}')`
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function rewriteQuery(sql: string, tableMappings: TableMapping[]): RewriteResult {
  const trimmed = sql.trim().replace(/;\s*$/, '')

  // Reject unsupported patterns
  if (/^\s*WITH\s+/i.test(trimmed)) {
    return err('CTEs (WITH clauses) are not supported. Try a simpler SELECT, or use Natural Language mode.')
  }
  if (/\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/i.test(trimmed)) {
    return err('UNION / INTERSECT / EXCEPT are not supported. Break the query into separate queries.')
  }
  if (/FROM\s*\(/i.test(trimmed)) {
    return err('Subqueries in FROM are not supported. Try using Natural Language mode for complex questions.')
  }

  // Auto-qualify unqualified table names (e.g., "employees" → "techflow.employees")
  const resolvedSQL = resolveUnqualifiedTableNames(trimmed, tableMappings)

  // Extract the primary FROM table
  const fromMatch = /\bFROM\s+([\w]+\.[\w]+)(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|GROUP|ORDER|HAVING|LIMIT|ON)\b)([\w]+))?/i.exec(resolvedSQL)
  if (!fromMatch) {
    return err('Could not parse FROM clause. Use schema.table format, e.g., SELECT * FROM softpak.prices')
  }

  const fromFriendly = fromMatch[1].toLowerCase()
  const fromAlias = fromMatch[2]?.toLowerCase() ?? null

  const fromMapping = tableMappings.find((m) => m.friendlyName.toLowerCase() === fromFriendly)
  if (!fromMapping) {
    // Block system table access attempts
    if (/^(auth|pg_catalog|information_schema|public)\./i.test(fromFriendly)) {
      return err(`Access to "${fromMatch[1]}" is not allowed.`)
    }
    const available = tableMappings.map((m) => m.friendlyName).join(', ') || 'none uploaded yet'
    return err(`Table "${fromMatch[1]}" not found. Available: ${available}`)
  }

  const fromRefKey = fromAlias ?? fromFriendly.split('.')[1]
  const aliasMap = new Map<string, { mapping: TableMapping; alias: string | null }>()
  aliasMap.set(fromRefKey, { mapping: fromMapping, alias: fromAlias })

  // Extract JOIN clauses
  const joinRe = /\b((?:(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)\s+(?:OUTER\s+)?)?JOIN)\s+([\w]+\.[\w]+)(?:\s+(?:AS\s+)?([\w]+))?\s+ON\s+/gi
  const joinParts: Array<{
    type: string
    mapping: TableMapping
    alias: string | null
    refKey: string
    onClause: string
  }> = []

  let joinMatch: RegExpExecArray | null
  while ((joinMatch = joinRe.exec(resolvedSQL)) !== null) {
    const joinType = joinMatch[1]
    const joinFriendly = joinMatch[2].toLowerCase()
    const joinAlias = joinMatch[3]?.toLowerCase() ?? null

    const joinMapping = tableMappings.find((m) => m.friendlyName.toLowerCase() === joinFriendly)
    if (!joinMapping) {
      if (/^(auth|pg_catalog|information_schema|public)\./i.test(joinFriendly)) {
        return err(`Access to "${joinMatch[2]}" is not allowed.`)
      }
      return err(`Table "${joinMatch[2]}" not found.`)
    }

    const joinRefKey = joinAlias ?? joinFriendly.split('.')[1]
    aliasMap.set(joinRefKey, { mapping: joinMapping, alias: joinAlias })

    // Extract ON clause — everything between ON and the next clause keyword or end
    const afterOn = resolvedSQL.slice(joinMatch.index + joinMatch[0].length)
    const onEnd = /\b(?:JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b/i.exec(afterOn)
    const onClause = onEnd ? afterOn.slice(0, onEnd.index).trim() : afterOn.trim()

    joinParts.push({ type: joinType, mapping: joinMapping, alias: joinAlias, refKey: joinRefKey, onClause })
  }

  // Extract SELECT list
  const selectMatch = /^SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(resolvedSQL)
  if (!selectMatch) return err('Could not parse SELECT clause.')
  const selectList = selectMatch[1].trim()

  // Rewrite SELECT columns — pass primary context for unqualified column refs
  const rewrittenSelect = rewriteSelectList(selectList, fromRefKey, fromMapping, aliasMap)
  if (rewrittenSelect.startsWith('ERROR:')) return err(rewrittenSelect.slice(6).trim())

  // Extract remaining clauses
  const whereMatch = /\bWHERE\s+([\s\S]+?)(?=\s*\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b|$)/i.exec(resolvedSQL)
  const groupByMatch = /\bGROUP\s+BY\s+([\s\S]+?)(?=\s*\b(?:ORDER\s+BY|HAVING|LIMIT)\b|$)/i.exec(resolvedSQL)
  const havingMatch = /\bHAVING\s+([\s\S]+?)(?=\s*\b(?:ORDER\s+BY|LIMIT)\b|$)/i.exec(resolvedSQL)
  const orderByMatch = /\bORDER\s+BY\s+([\s\S]+?)(?=\s*\bLIMIT\b|$)/i.exec(resolvedSQL)
  const limitMatch = /\bLIMIT\s+\d+/i.exec(resolvedSQL)

  // Build FROM clause — data_rows for source tables, staged_data_rows for target tables
  const fromAliasPart = fromAlias ? ` ${fromAlias}` : ''
  const fromClause = `FROM ${rowDataSource(fromMapping)}${fromAliasPart}`

  // Build JOIN clauses — each join table routes to its own data source
  const joinClauses: string[] = joinParts.map((jp) => {
    const aliasPart = jp.alias ? ` ${jp.alias}` : ''
    const tableIdCond = rowIdCondition(jp.mapping, jp.alias ?? jp.refKey)
    const rewrittenOn = jp.onClause ? transformColRefs(jp.onClause, aliasMap, fromRefKey) : ''
    const onFull = rewrittenOn ? `${tableIdCond} AND ${rewrittenOn}` : tableIdCond
    return `${jp.type} ${rowDataSource(jp.mapping)}${aliasPart} ON ${onFull}`
  })

  // Build WHERE clause — must always include primary table scope condition
  const primaryTableIdCond = rowIdCondition(fromMapping, fromAlias)
  let whereClause: string
  if (whereMatch) {
    const rewrittenWhere = transformColRefs(whereMatch[1].trim(), aliasMap, fromRefKey)
    whereClause = `WHERE ${primaryTableIdCond} AND ${rewrittenWhere}`
  } else {
    whereClause = `WHERE ${primaryTableIdCond}`
  }

  // Rewrite GROUP BY, HAVING, ORDER BY
  const groupByClause = groupByMatch
    ? `GROUP BY ${transformColRefs(groupByMatch[1].trim(), aliasMap, fromRefKey)}`
    : ''
  const havingClause = havingMatch
    ? `HAVING ${transformColRefs(havingMatch[1].trim(), aliasMap, fromRefKey)}`
    : ''
  const orderByClause = orderByMatch
    ? `ORDER BY ${transformColRefs(orderByMatch[1].trim(), aliasMap, fromRefKey)}`
    : ''

  const parts = [
    `SELECT ${rewrittenSelect}`,
    fromClause,
    ...joinClauses,
    whereClause,
    groupByClause,
    havingClause,
    orderByClause,
    limitMatch ? limitMatch[0] : 'LIMIT 1000',
  ].filter(Boolean)

  return { rewrittenSQL: parts.join('\n') }
}

// ─── SELECT list rewriting ────────────────────────────────────────────────────

function rewriteSelectList(
  selectList: string,
  primaryRefKey: string,
  primaryMapping: TableMapping,
  aliasMap: Map<string, { mapping: TableMapping; alias: string | null }>
): string {
  // SELECT * → expand primary table columns
  if (selectList === '*') {
    if (aliasMap.size > 1) {
      return `ERROR: Use explicit columns with JOINs (e.g., SELECT p."Price", c."Name")`
    }
    return primaryMapping.fields
      .map((f) => `${colExtractExpr(f.name, null, primaryMapping)} AS "${f.name}"`)
      .join(', ')
  }

  // SELECT alias.* → expand that alias's columns
  const aliasStar = /^([\w]+)\.\*$/.exec(selectList)
  if (aliasStar) {
    const refKey = aliasStar[1].toLowerCase()
    const entry = aliasMap.get(refKey)
    if (entry) {
      return entry.mapping.fields
        .map((f) => `${colExtractExpr(f.name, refKey, entry.mapping)} AS "${f.name}"`)
        .join(', ')
    }
  }

  // Transform column list
  const cols = splitByComma(selectList)
  return cols.map((col) => rewriteSelectColumn(col.trim(), aliasMap, primaryRefKey, primaryMapping)).join(', ')
}

function rewriteSelectColumn(
  col: string,
  aliasMap: Map<string, { mapping: TableMapping; alias: string | null }>,
  primaryRefKey: string,
  primaryMapping: TableMapping
): string {
  // col AS alias → rewrite col, keep alias
  const asMatch = /^([\s\S]+?)\s+AS\s+([\w"]+)$/i.exec(col)
  if (asMatch) {
    return `${transformColRefs(asMatch[1].trim(), aliasMap, primaryRefKey)} AS ${asMatch[2]}`
  }

  // Simple quoted column: "FieldName" or alias."FieldName"
  const simpleQuoted = /^(?:([\w]+)\.)?"([^"]+)"$/.exec(col)
  if (simpleQuoted) {
    const tableRef = simpleQuoted[1] ?? null
    const fieldName = simpleQuoted[2]
    if (tableRef) {
      const entry = aliasMap.get(tableRef.toLowerCase())
      const mapping = entry?.mapping ?? primaryMapping
      return `${colExtractExpr(fieldName, tableRef, mapping)} AS "${fieldName}"`
    }
    return `${colExtractExpr(fieldName, null, primaryMapping)} AS "${fieldName}"`
  }

  // Otherwise transform as expression (aggregate, cast, etc.)
  return transformColRefs(col, aliasMap, primaryRefKey)
}

// ─── Column reference transformation ─────────────────────────────────────────
//
// Applied in order (most specific first to avoid double-replacement):
//  1. alias."col"::type  → (colExtractExpr)::type
//  2. "col"::type        → (colExtractExpr)::type  (uses primary mapping)
//  3. alias."col"        → colExtractExpr
//  4. "col"              → colExtractExpr           (uses primary mapping)
//
// For source tables: colExtractExpr = TRIM(ref.row_data->>'col')
// For target tables: colExtractExpr = COALESCE(TRIM(ref.transformed_row_data->>'col'), TRIM(ref.source_row_data->>'col'))
//
// TRIM() is applied to every field extraction to handle leading/trailing
// whitespace in stored values, which would otherwise break numeric casts.

function transformColRefs(
  text: string,
  aliasMap: Map<string, { mapping: TableMapping; alias: string | null }>,
  primaryRefKey: string
): string {
  let result = text

  // Helper: resolve mapping for a table reference (alias or table name)
  const resolve = (tableRef: string) =>
    aliasMap.get(tableRef.toLowerCase())?.mapping ??
    aliasMap.get(primaryRefKey)?.mapping

  // 1. alias."col"::type
  result = result.replace(
    /\b([\w]+)\."([^"]+)"::([\w()]+)/g,
    (_, tableRef, fieldName, cast) => {
      const m = resolve(tableRef)
      const expr = m ? colExtractExpr(fieldName, tableRef, m) : `TRIM(${tableRef}.row_data->>'${fieldName}')`
      return `(${expr})::${cast}`
    }
  )

  // 2. "col"::type (no alias)
  result = result.replace(/"([^"]+)"::([\w()]+)/g, (_, fieldName, cast) => {
    const m = aliasMap.get(primaryRefKey)?.mapping
    const expr = m ? colExtractExpr(fieldName, null, m) : `TRIM(row_data->>'${fieldName}')`
    return `(${expr})::${cast}`
  })

  // 3. alias."col" (no cast)
  result = result.replace(/\b([\w]+)\."([^"]+)"/g, (_, tableRef, fieldName) => {
    const m = resolve(tableRef)
    return m ? colExtractExpr(fieldName, tableRef, m) : `TRIM(${tableRef}.row_data->>'${fieldName}')`
  })

  // 4. "col" (no alias, no cast) — must come last
  result = result.replace(/"([^"]+)"/g, (_, fieldName) => {
    const m = aliasMap.get(primaryRefKey)?.mapping
    return m ? colExtractExpr(fieldName, null, m) : `TRIM(row_data->>'${fieldName}')`
  })

  return result
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitByComma(str: string): string[] {
  const result: string[] = []
  let depth = 0
  let current = ''
  for (const ch of str) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      result.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) result.push(current.trim())
  return result
}

/**
 * Resolves unqualified table names in SQL to their schema-qualified friendly names.
 *
 * If a bare table name (e.g., "employees") appears after FROM or JOIN and matches
 * exactly one table across all datasets, it's auto-qualified (e.g., "techflow.employees").
 * If ambiguous (same bare name in multiple datasets), the name is left as-is and the
 * existing error handling will surface the problem.
 */
function resolveUnqualifiedTableNames(
  sql: string,
  tableMappings: { friendlyName: string }[]
): string {
  // Build a lookup: bare table name → list of matching friendly names
  const bareNameMap = new Map<string, string[]>()
  for (const m of tableMappings) {
    const dotIndex = m.friendlyName.indexOf('.')
    if (dotIndex === -1) continue
    const bareName = m.friendlyName.substring(dotIndex + 1).toLowerCase()
    const existing = bareNameMap.get(bareName) ?? []
    existing.push(m.friendlyName)
    bareNameMap.set(bareName, existing)
  }

  // Replace unqualified table names after FROM and JOIN keywords.
  // Captures word.word (already qualified) or bare word, then only replaces bare ones.
  return sql.replace(
    /\b(FROM|JOIN)\s+([\w]+(?:\.[\w]+)?)/gi,
    (fullMatch, keyword, tableName) => {
      if (tableName.includes('.')) return fullMatch
      const matches = bareNameMap.get(tableName.toLowerCase())
      if (matches && matches.length === 1) {
        return `${keyword} ${matches[0]}`
      }
      return fullMatch
    }
  )
}

function err(message: string): RewriteResult {
  return { rewrittenSQL: '', error: message }
}

// ─── Friendly name computation (shared with CSV upload) ───────────────────────

export function toFriendlySegment(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'table'
}

export function computeFriendlyName(datasetName: string, tableName: string): string {
  return `${toFriendlySegment(datasetName)}.${toFriendlySegment(tableName)}`
}
