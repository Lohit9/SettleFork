'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { validateFixSQL } from '@/lib/quality/fix-sql-validator'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts the WHERE clause from a plain UPDATE or DELETE SQL statement.
 * Returns null for CTEs or unrecognised patterns.
 */
function extractWhereClause(sql: string, tableId: string): string | null {
  const normalized = sql.replace(/\s+/g, ' ').trim().replace(/;\s*$/, '')
  if (/^WITH\s/i.test(normalized)) return null

  let lastWhere: string | null = null
  const regex = /\bWHERE\b\s*/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(normalized)) !== null) {
    const clause = normalized.substring(match.index + match[0].length)
    if (clause.includes(tableId)) lastWhere = clause
  }
  return lastWhere
}

/**
 * Snapshots all affected rows into fix_snapshots BEFORE the fix executes.
 *
 * Returns:
 *   { snapshotted: true }  — rows captured successfully
 *   { requiresConfirmation: true } — CTE/complex SQL; caller must get user confirmation
 *
 * Throws on technical failure so callers can abort the fix entirely.
 *
 * Why dq_snapshot_rows instead of the old dq_snapshot_for_fix + client-side INSERT:
 *   dq_snapshot_for_fix returned TABLE rows through PostgREST, which capped the response
 *   at ~1,000 rows. dq_snapshot_rows does the INSERT INTO fix_snapshots SELECT ... directly
 *   inside PostgreSQL and returns only a BIGINT count — PostgREST applies no row limit to
 *   scalar returns, so every affected row is captured regardless of dataset size.
 */
async function snapshotRows(
  fixHistoryId: string,
  fixSql: string,
  tableId: string
): Promise<{ snapshotted: boolean; requiresConfirmation: boolean; rowCount: number }> {
  const whereClause = extractWhereClause(fixSql, tableId)
  if (!whereClause) {
    return { snapshotted: false, requiresConfirmation: true, rowCount: 0 }
  }

  // Admin required: dq_snapshot_rows is SECURITY DEFINER. It inserts snapshots directly
  // inside PostgreSQL, bypassing PostgREST's 1,000-row response limit. Returns row count.
  const { data: count, error } = await supabaseAdmin.rpc('dq_snapshot_rows', {
    p_fix_history_id: fixHistoryId,
    p_where_clause: whereClause,
    p_table_id: tableId,
  })

  if (error) {
    throw new Error(`Snapshot RPC failed: ${error.message}`)
  }

  return { snapshotted: true, requiresConfirmation: false, rowCount: Number(count ?? 0) }
}

// ── generate manual fix via Claude ───────────────────────────────────────────

export async function generateManualFix(
  projectId: string,
  tableId: string,
  fieldId: string | null,
  description: string
): Promise<{ sql: string; estimatedRows: number; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { sql: '', estimatedRows: 0, error: 'Not authenticated' }

  if (!checkAIRateLimit(user.id)) {
    return {
      sql: '',
      estimatedRows: 0,
      error: 'AI rate limit reached. Please wait before generating more fixes.',
    }
  }

  // Fix 1: use RLS client for project/table ownership checks
  const { data: proj } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!proj) return { sql: '', estimatedRows: 0, error: 'Project not found or access denied' }

  const { data: tableRow } = await supabase
    .from('tables')
    .select('id, name, dataset_id, datasets!inner(project_id)')
    .eq('id', tableId)
    .single()

  if (!tableRow) return { sql: '', estimatedRows: 0, error: 'Table not found' }
  const tds = tableRow.datasets as unknown as { project_id: string }
  if (tds.project_id !== projectId) {
    return { sql: '', estimatedRows: 0, error: 'Access denied' }
  }

  // Fix 1: use RLS client for fields
  const { data: fields } = await supabase
    .from('fields')
    .select('name, data_type, inferred_type, is_nullable')
    .eq('table_id', tableId)

  const fieldList = (fields ?? [])
    .map((f) => `  - ${f.name} (${f.inferred_type ?? f.data_type}, nullable: ${f.is_nullable})`)
    .join('\n')

  let focusedFieldContext = ''
  if (fieldId) {
    const { data: fld } = await supabase
      .from('fields')
      .select('name, data_type, inferred_type')
      .eq('id', fieldId)
      .single()
    if (fld) {
      focusedFieldContext = `\nFocused field: ${fld.name} (${fld.inferred_type ?? fld.data_type})`
    }
  }

  const systemPrompt = `You are a data migration fix expert. Given a table's schema and a natural language description of a fix, generate the exact SQL to implement it.

The data is stored in a PostgreSQL table called 'data_rows' with:
- id BIGINT (primary key)
- table_id UUID
- row_number INT
- row_data JSONB (contains actual field values as key-value pairs)

RULES:
- Always include WHERE table_id = '${tableId}' in every SQL statement
- Use JSONB operators for all field access: row_data->>'FieldName'
- For numeric comparisons: (row_data->>'FieldName')::numeric
- Never use window functions inside UPDATE SET clauses (use a CTE if needed)
- Never reference tables other than data_rows
- Never use DDL (DROP, ALTER, CREATE, TRUNCATE)
- NEVER use LIMIT, FETCH FIRST, or OFFSET — fixes must apply to ALL matching rows
- Generate ONLY the SQL, no explanation, no markdown fences`

  const userMessage = `Table: ${tableRow.name} (table_id: '${tableId}')
Fields:
${fieldList}${focusedFieldContext}

Fix description: "${description}"`

  let generatedSql = ''
  try {
    const raw = await callClaude(systemPrompt, userMessage, 512)
    generatedSql = raw
      .replace(/^```(?:sql)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
  } catch (err) {
    console.error('[manual-fix] Claude error:', err)
    return {
      sql: '',
      estimatedRows: 0,
      error: 'AI returned an unexpected response. Please try again.',
    }
  }

  if (!generatedSql) {
    return {
      sql: '',
      estimatedRows: 0,
      error: 'No SQL generated. Please rephrase your description.',
    }
  }

  // Estimate affected rows using the WHERE clause
  // Admin required: dq_count_for_fix is SECURITY DEFINER and reads data_rows
  let estimatedRows = 0
  try {
    const whereClause = extractWhereClause(generatedSql, tableId)
    if (whereClause) {
      const { data: cnt } = await supabaseAdmin.rpc('dq_count_for_fix', {
        p_where_clause: whereClause,
        p_table_id: tableId,
      })
      estimatedRows = Number(cnt ?? 0)
    }
  } catch {
    // Non-critical — estimation is best-effort
  }

  return { sql: generatedSql, estimatedRows }
}

// ── apply a manual fix ────────────────────────────────────────────────────────

export async function applyManualFix(
  projectId: string,
  tableId: string,
  sql: string,
  description: string,
  skipSnapshot = false
): Promise<{ success: boolean; rowsAffected: number; error?: string; requiresSnapshotConfirmation?: boolean }> {
  // Fix 1: use RLS client for table ownership and fix_history operations
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, rowsAffected: 0, error: 'Not authenticated' }

  const { data: proj } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!proj) return { success: false, rowsAffected: 0, error: 'Project not found or access denied' }

  const { data: tableRow } = await supabase
    .from('tables')
    .select('id, datasets!inner(project_id)')
    .eq('id', tableId)
    .single()
  if (!tableRow) return { success: false, rowsAffected: 0, error: 'Table not found' }
  const tds = tableRow.datasets as unknown as { project_id: string }
  if (tds.project_id !== projectId) {
    return { success: false, rowsAffected: 0, error: 'Access denied' }
  }

  const validation = validateFixSQL(sql, tableId)
  if (!validation.safe) {
    return { success: false, rowsAffected: 0, error: `SQL validation failed: ${validation.reason}` }
  }

  // Fix 1: use RLS client for fix_history INSERT
  const { data: histRecord, error: histError } = await supabase
    .from('fix_history')
    .insert({
      quality_issue_id: null,
      project_id: projectId,
      table_id: tableId,
      fix_description: description,
      fix_sql: sql,
      fix_option_chosen: 'Manual fix',
      affected_row_count: 0,
      old_values_sample: null,
      applied_by: user.id,
      status: 'applied',
      snapshot_failed: false,
    })
    .select('id')
    .single()

  if (histError || !histRecord) {
    return { success: false, rowsAffected: 0, error: 'Failed to log fix. Please try again.' }
  }

  const fixHistoryId = histRecord.id

  // Fix 3: snapshot BEFORE executing — abort if snapshot fails
  let snapshotResult: { snapshotted: boolean; requiresConfirmation: boolean; rowCount: number }
  try {
    snapshotResult = await snapshotRows(fixHistoryId, sql, tableId)
  } catch {
    // Technical snapshot failure — abort entirely
    await supabase.from('fix_history').delete().eq('id', fixHistoryId)
    return {
      success: false,
      rowsAffected: 0,
      error:
        'Failed to save data snapshot before fix. Fix was NOT applied. Please try again.',
    }
  }

  // Fix 4: CTE/complex SQL requires user confirmation
  if (snapshotResult.requiresConfirmation && !skipSnapshot) {
    await supabase.from('fix_history').delete().eq('id', fixHistoryId)
    return { success: false, rowsAffected: 0, requiresSnapshotConfirmation: true }
  }

  // Mark snapshot_failed if user confirmed applying without snapshot
  if (!snapshotResult.snapshotted && skipSnapshot) {
    await supabase.from('fix_history').update({ snapshot_failed: true }).eq('id', fixHistoryId)
  }

  // Set affected_row_count from snapshot count first — reliable since dq_snapshot_rows
  // counts in PostgreSQL with no PostgREST row limit
  if (snapshotResult.rowCount > 0) {
    await supabase
      .from('fix_history')
      .update({ affected_row_count: snapshotResult.rowCount })
      .eq('id', fixHistoryId)
  }

  // Admin required: execute_data_fix is SECURITY DEFINER and modifies data_rows
  const { data: execData, error: execError } = await supabaseAdmin.rpc('execute_data_fix', {
    p_sql: sql,
    p_table_id: tableId,
  })

  if (execError) {
    await supabase.from('fix_snapshots').delete().eq('fix_history_id', fixHistoryId)
    await supabase.from('fix_history').delete().eq('id', fixHistoryId)
    return { success: false, rowsAffected: 0, error: `Execution failed: ${execError.message}` }
  }

  // Prefer the actual exec count; fall back to snapshot count if execData is unexpected
  const rowsAffected = typeof execData === 'number' && execData >= 0
    ? execData
    : snapshotResult.rowCount

  // Fix 1: use RLS client for fix_history UPDATE
  await supabase
    .from('fix_history')
    .update({ affected_row_count: rowsAffected })
    .eq('id', fixHistoryId)

  // Recompute field profiles for all fields on this table
  try {
    // Fix 1: use RLS client for fields, data_rows, and field_profiles
    const { data: fields } = await supabase
      .from('fields')
      .select('id, name')
      .eq('table_id', tableId)

    const { data: rows } = await supabase
      .from('data_rows')
      .select('row_data')
      .eq('table_id', tableId)

    for (const f of fields ?? []) {
      if (!rows || rows.length === 0) continue
      const total = rows.length
      const values = rows.map((r) => (r.row_data as Record<string, unknown>)[f.name])
      const nullCount = values.filter((v) => v === null || v === undefined || v === '').length
      const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '')
      const uniqueSet = new Set(nonNull.map((v) => String(v)))

      await supabase.from('field_profiles').upsert(
        {
          field_id: f.id,
          total_rows: total,
          null_count: nullCount,
          null_percentage: total > 0 ? (nullCount / total) * 100 : 0,
          cardinality: uniqueSet.size,
          unique_percentage: total > 0 ? (uniqueSet.size / total) * 100 : 0,
          format_issues_count: 0,
          min_value: nonNull.length > 0 ? String(nonNull[0]) : null,
          max_value: nonNull.length > 0 ? String(nonNull[nonNull.length - 1]) : null,
          sample_values: [...uniqueSet].slice(0, 10),
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'field_id' }
      )
    }
  } catch {
    // Non-critical
  }

  return { success: true, rowsAffected }
}

// ── validate and preview manual fix SQL ───────────────────────────────────────

export async function previewManualFix(
  projectId: string,
  tableId: string,
  sql: string
): Promise<{ valid: boolean; estimatedRows: number; error?: string }> {
  // Fix 1: use RLS client for project ownership check
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { valid: false, estimatedRows: 0, error: 'Not authenticated' }

  const { data: proj } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!proj) return { valid: false, estimatedRows: 0, error: 'Project not found' }

  const validation = validateFixSQL(sql, tableId)
  if (!validation.safe) {
    return { valid: false, estimatedRows: 0, error: validation.reason }
  }

  // Admin required: dq_count_for_fix is SECURITY DEFINER and reads data_rows
  let estimatedRows = 0
  try {
    const whereClause = extractWhereClause(sql, tableId)
    if (whereClause) {
      const { data: cnt } = await supabaseAdmin.rpc('dq_count_for_fix', {
        p_where_clause: whereClause,
        p_table_id: tableId,
      })
      estimatedRows = Number(cnt ?? 0)
    }
  } catch {
    // Estimation is best-effort
  }

  return { valid: true, estimatedRows }
}
