/**
 * Query Engine — single entry point for ALL data queries.
 *
 * MVP: rewrites friendly schema.table names → JSONB queries against data_rows.
 * Post-MVP: route queries to a dedicated data cluster where friendly names
 * are real Postgres tables. The executeQuery() interface stays the same.
 *
 * Nothing should query data_rows directly — everything goes through here.
 */

import { createClient } from '@/lib/supabase/server'
import { validateGeneratedSQL } from '@/lib/ai/sql-safety'
import { rewriteQuery, type TableMapping } from '@/lib/db/sql-rewriter'

export interface QueryEngineResult {
  success: boolean
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  friendlySQL: string    // the SQL the user wrote / Claude generated (friendly names)
  executedSQL: string    // the rewritten JSONB query that was actually executed
  error?: string         // friendly user-facing message
  hint?: string          // actionable suggestion for the user
  rawError?: string      // original PostgreSQL error for technical details
  retried?: boolean      // true if this result came from an auto-retry
  originalError?: string // the error from the first attempt (when retried)
  originalSQL?: string   // the SQL that failed on the first attempt (when retried)
}

// ─── Column ordering helper ───────────────────────────────────────────────────

/**
 * Reorder query result columns to match the source field ordinal_position order.
 * Finds the mapping whose field names overlap most with the result columns,
 * then uses that mapping's field order as the canonical column order.
 * Columns that aren't in any mapping (e.g. computed/aliased columns) are
 * appended at the end in the order they appeared in the result.
 */
function sortColumnsByOrdinalPosition(
  rawColumns: string[],
  mappings: TableMapping[]
): string[] {
  if (rawColumns.length === 0 || mappings.length === 0) return rawColumns

  const rawSet = new Set(rawColumns)

  // Find the mapping whose fields have the most overlap with result columns
  let bestMapping: TableMapping | null = null
  let bestOverlap = 0
  for (const m of mappings) {
    const overlap = m.fields.filter((f) => rawSet.has(f.name)).length
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestMapping = m
    }
  }

  if (!bestMapping || bestOverlap === 0) return rawColumns

  // Ordered columns: fields in ordinal_position order (already ordered by the DB query),
  // filtered to only those present in results
  const ordered = bestMapping.fields
    .map((f) => f.name)
    .filter((name) => rawSet.has(name))

  // Append any result columns not covered by the mapping (aliased, computed, etc.)
  const orderedSet = new Set(ordered)
  const extras = rawColumns.filter((c) => !orderedSet.has(c))

  return [...ordered, ...extras]
}

// ─── Error parser ─────────────────────────────────────────────────────────────

function parseQueryError(rawError: string): { message: string; hint?: string } {
  // Type mismatch — e.g. "operator does not exist: text > integer"
  if (rawError.includes('operator does not exist')) {
    const match = rawError.match(/operator does not exist: (\w+) [<>=!]+ (\w+)/)
    if (match) {
      const castTarget = match[2] === 'integer' ? 'numeric' : match[2]
      return {
        message: `Can't compare ${match[1]} with ${match[2]} — these are different data types.`,
        hint: `Try casting the column: CAST(column_name AS ${castTarget})`,
      }
    }
    return {
      message: 'A type mismatch occurred — two columns with incompatible data types were compared.',
      hint: 'Check the data types of the columns involved and use CAST() if needed.',
    }
  }

  // Relation doesn't exist
  if (rawError.includes('relation') && rawError.includes('does not exist')) {
    const match = rawError.match(/relation "?([^"]+)"? does not exist/)
    return {
      message: `Table "${match?.[1] ?? 'unknown'}" was not found.`,
      hint: 'Check the Available Tables panel on the right for valid table names.',
    }
  }

  // Column doesn't exist
  if (rawError.includes('column') && rawError.includes('does not exist')) {
    const match = rawError.match(/column "?([^"]+)"? does not exist/)
    return {
      message: `Column "${match?.[1] ?? 'unknown'}" was not found in the specified table.`,
      hint: 'Click a table name in the sidebar to see available columns.',
    }
  }

  // Syntax error
  if (rawError.includes('syntax error')) {
    return {
      message: "There's a syntax error in the generated query.",
      hint: 'Try rephrasing your question, or switch to SQL mode for direct control.',
    }
  }

  // Permission denied / non-SELECT attempt
  if (rawError.includes('permission denied')) {
    return {
      message: 'This query type is not allowed for safety reasons.',
      hint: 'Only SELECT queries are permitted. Data modification is not allowed.',
    }
  }

  // Timeout
  if (rawError.includes('statement timeout') || rawError.includes('canceling statement')) {
    return {
      message: 'The query took too long and was cancelled.',
      hint: 'Try adding a LIMIT clause or narrowing your search criteria.',
    }
  }

  // Division by zero
  if (rawError.includes('division by zero')) {
    return {
      message: 'Division by zero encountered in the query.',
      hint: 'Wrap the divisor in a NULLIF check: NULLIF(divisor, 0)',
    }
  }

  // Invalid cast / cannot cast
  if (rawError.includes('invalid input syntax') || rawError.includes('cannot cast')) {
    const match = rawError.match(/invalid input syntax for (?:type )?(\w+): "([^"]+)"/)
    if (match) {
      return {
        message: `"${match[2]}" couldn't be converted to ${match[1]}.`,
        hint: 'Some values in this column may not match the expected format. Try using NULLIF(TRIM(...), \'\')::' + match[1],
      }
    }
    return {
      message: 'A value in the query could not be converted to the expected data type.',
      hint: 'Use defensive casting: NULLIF(TRIM(column_name), \'\')::numeric',
    }
  }

  // Ambiguous column
  if (rawError.includes('ambiguous')) {
    const match = rawError.match(/column reference "([^"]+)" is ambiguous/)
    return {
      message: `Column "${match?.[1] ?? 'unknown'}" is ambiguous — it exists in multiple tables.`,
      hint: 'Prefix the column with its table name: tablename."ColumnName"',
    }
  }

  // Fallback — frame it politely, preserve the raw message as a hint
  return {
    message: 'The query could not be executed.',
    hint: rawError,
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function executeQuery(
  projectId: string,
  sql: string,
  userId: string
): Promise<QueryEngineResult> {
  const friendlySQL = sql.trim()
  const empty: QueryEngineResult = {
    success: false,
    columns: [],
    rows: [],
    rowCount: 0,
    friendlySQL,
    executedSQL: '',
  }

  // 1. Safety check the user SQL (friendly-name version)
  const safety = validateGeneratedSQL(friendlySQL)
  if (!safety.safe) {
    return { ...empty, error: `Safety check failed: ${safety.reason}` }
  }

  try {
    // 2. Load table mappings for the project (RLS-enforced)
    const mappings = await getTableMappingsForProject(projectId, userId)
    if (mappings.length === 0) {
      return { ...empty, error: 'No tables found for this project. Upload CSV files first.' }
    }

    // 3. Rewrite friendly SQL → JSONB SQL
    const rewrite = rewriteQuery(friendlySQL, mappings)
    if (rewrite.error || !rewrite.rewrittenSQL) {
      return { ...empty, error: rewrite.error ?? 'Could not rewrite query.' }
    }
    const executedSQL = rewrite.rewrittenSQL

    // 4. Safety check the rewritten SQL (second pass — defence in depth)
    const rewrittenSafety = validateGeneratedSQL(executedSQL)
    if (!rewrittenSafety.safe) {
      return {
        ...empty,
        executedSQL,
        error: `Rewritten query failed safety check: ${rewrittenSafety.reason}`,
      }
    }

    // 5. Execute via Supabase RPC
    const tableIds = mappings.map((m) => m.tableId)
    const result = await executeViaRPC(executedSQL, tableIds)
    if (!result.success) {
      const rawErr = result.error ?? 'Query execution failed'
      const parsed = parseQueryError(rawErr)
      return { ...empty, executedSQL, error: parsed.message, hint: parsed.hint, rawError: rawErr }
    }

    const rows = result.rows ?? []
    const rawColumns = rows.length > 0 ? Object.keys(rows[0]) : []

    // Sort result columns to match the source field ordinal_position order.
    // Fields are already fetched ordered by ordinal_position in getTableMappingsForProject,
    // so we just need to find which mapping's fields appear in this result set.
    const orderedColumns = sortColumnsByOrdinalPosition(rawColumns, mappings)

    return {
      success: true,
      columns: orderedColumns,
      rows,
      rowCount: rows.length,
      friendlySQL,
      executedSQL,
    }
  } catch (e) {
    console.error('[executeQuery]', e)
    const rawErr = e instanceof Error ? e.message : 'Unexpected error'
    const parsed = parseQueryError(rawErr)
    return { ...empty, error: parsed.message, hint: parsed.hint, rawError: rawErr }
  }
}

// ─── Table mapping loader ─────────────────────────────────────────────────────

export async function getTableMappingsForProject(
  projectId: string,
  _userId: string
): Promise<TableMapping[]> {
  const supabase = await createClient()

  // Fetch tables with friendly_name (RLS ensures ownership)
  const { data: datasets } = await supabase
    .from('datasets')
    .select('id, name')
    .eq('project_id', projectId)

  if (!datasets?.length) return []

  const datasetIds = datasets.map((d) => d.id)
  const datasetNames = new Map(datasets.map((d) => [d.id, d.name]))

  const { data: tables } = await supabase
    .from('tables')
    .select('id, dataset_id, name, friendly_name')
    .in('dataset_id', datasetIds)

  if (!tables?.length) return []

  const tableIds = tables.map((t) => t.id)

  const { data: fields } = await supabase
    .from('fields')
    .select('id, table_id, name, data_type')
    .in('table_id', tableIds)
    .order('ordinal_position', { ascending: true })

  // Fetch full profiling stats — used to build the enriched NL prompt context
  const fieldIds = (fields ?? []).map((f) => f.id)
  const { data: profiles } =
    fieldIds.length > 0
      ? await supabase
          .from('field_profiles')
          .select('field_id, sample_values, null_percentage, format_issues_count, value_distribution, cardinality, min_value, max_value')
          .in('field_id', fieldIds)
      : { data: [] }

  const profileByFieldId = new Map(
    (profiles ?? []).map((p) => [p.field_id, p])
  )

  const fieldsByTable = new Map<string, {
    name: string
    dataType: string
    sampleValues?: string[]
    nullPercentage?: number
    formatIssues?: number
    cardinality?: number
    valueDistribution?: Array<{ value: string; count: number }>
    minValue?: string
    maxValue?: string
  }[]>()
  for (const f of fields || []) {
    const profile = profileByFieldId.get(f.id)
    const list = fieldsByTable.get(f.table_id) ?? []
    list.push({
      name: f.name,
      dataType: f.data_type,
      sampleValues: profile?.sample_values
        ? (profile.sample_values as unknown[]).slice(0, 5).map((v) => String(v ?? ''))
        : undefined,
      nullPercentage: profile?.null_percentage ?? undefined,
      formatIssues: profile?.format_issues_count ?? undefined,
      cardinality: profile?.cardinality ?? undefined,
      valueDistribution: Array.isArray(profile?.value_distribution)
        ? (profile.value_distribution as Array<{ value: string; count: number }>)
        : undefined,
      minValue: profile?.min_value ?? undefined,
      maxValue: profile?.max_value ?? undefined,
    })
    fieldsByTable.set(f.table_id, list)
  }

  // Compute friendly_name on the fly if not stored yet (handles old tables)
  return tables.map((t) => {
    const dsName = datasetNames.get(t.dataset_id) ?? 'unknown'
    const friendlyName =
      t.friendly_name ??
      `${dsName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`

    return {
      friendlyName,
      tableId: t.id,
      fields: fieldsByTable.get(t.id) ?? [],
    }
  })
}

// ─── RPC execution ────────────────────────────────────────────────────────────

async function executeViaRPC(
  sql: string,
  tableIds: string[]
): Promise<{ success: boolean; rows?: Record<string, unknown>[]; error?: string }> {
  const supabase = await createClient()

  try {
    const { data, error } = await supabase.rpc('execute_readonly_query', {
      p_query: sql,
      p_table_ids: tableIds,
    })

    if (error) {
      return { success: false, error: error.message ?? 'Query execution failed' }
    }

    return { success: true, rows: Array.isArray(data) ? data : [] }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Query execution failed',
    }
  }
}
