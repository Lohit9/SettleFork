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
  error?: string
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
      return { ...empty, executedSQL, error: result.error }
    }

    const rows = result.rows ?? []
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []

    return {
      success: true,
      columns,
      rows,
      rowCount: rows.length,
      friendlySQL,
      executedSQL,
    }
  } catch (e) {
    console.error('[executeQuery]', e)
    return { ...empty, error: e instanceof Error ? e.message : 'Unexpected error' }
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

  // Fetch sample values and null rates so the NL prompt can see actual data formatting
  const fieldIds = (fields ?? []).map((f) => f.id)
  const { data: profiles } =
    fieldIds.length > 0
      ? await supabase
          .from('field_profiles')
          .select('field_id, sample_values, null_percentage, format_issues')
          .in('field_id', fieldIds)
      : { data: [] }

  const profileByFieldId = new Map(
    (profiles ?? []).map((p) => [p.field_id, p])
  )

  const fieldsByTable = new Map<string, { name: string; dataType: string; sampleValues?: string[]; nullPercentage?: number; formatIssues?: number }[]>()
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
      formatIssues: profile?.format_issues ?? undefined,
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
      const msg = error.message ?? 'Query execution failed'
      // Sanitize Postgres internals from the error message
      const sanitized = msg
        .replace(/relation ".*?" does not exist/gi, 'Column or table not found')
        .replace(/column ".*?" does not exist/gi, 'Column not found — check field name spelling and quotes')
      return { success: false, error: sanitized }
    }

    return { success: true, rows: Array.isArray(data) ? data : [] }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Query execution failed',
    }
  }
}
