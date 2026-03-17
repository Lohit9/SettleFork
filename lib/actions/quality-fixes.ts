'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { validateFixSQL } from '@/lib/quality/fix-sql-validator'
import { runSourceDataChecks } from '@/lib/quality/detection-engine'
import { executeCustomRules } from '@/lib/actions/validation-rules'
import type { QualityIssue, FixHistory } from '@/lib/types/database'

// ── helpers ───────────────────────────────────────────────────────────────────

type RLSClient = Awaited<ReturnType<typeof createClient>>

// Verifies the issue exists and belongs to the authenticated user.
// Uses the RLS client so ownership is enforced by Postgres policy.
async function verifyIssueAccess(
  supabase: RLSClient,
  issueId: string,
  userId: string
): Promise<QualityIssue | null> {
  const { data } = await supabase
    .from('quality_issues')
    .select('*, projects!inner(user_id)')
    .eq('id', issueId)
    .single()

  if (!data) return null
  if ((data as unknown as { projects: { user_id: string } }).projects?.user_id !== userId) return null
  return data as QualityIssue
}

/**
 * Extracts the WHERE clause from a plain UPDATE or DELETE statement.
 * Returns null for CTEs (WITH ...) — they cannot be snapshotted automatically.
 */
function extractWhereClause(sql: string, tableId: string): string | null {
  const normalized = sql.replace(/\s+/g, ' ').trim().replace(/;\s*$/, '')
  if (/^WITH\s/i.test(normalized)) return null

  let lastWhereClause: string | null = null
  const regex = /\bWHERE\b\s*/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(normalized)) !== null) {
    const clauseStart = match.index + match[0].length
    const clause = normalized.substring(clauseStart)
    if (clause.includes(tableId)) {
      lastWhereClause = clause
    }
  }
  return lastWhereClause
}

/**
 * Snapshots all affected rows into fix_snapshots BEFORE the fix executes.
 *
 * Returns:
 *   { snapshotted: true }  — all rows captured successfully
 *   { requiresConfirmation: true } — CTE/complex SQL; user must confirm before applying
 *
 * Throws on technical failure (RPC error, insert error) so callers can abort the fix.
 *
 * Why dq_snapshot_rows instead of the old dq_snapshot_for_fix + client-side INSERT:
 *   dq_snapshot_for_fix returned TABLE rows through PostgREST, which capped the response
 *   at ~1,000 rows. A fix on 9,487 rows only got 1,000 snapshotted — revert silently
 *   left 8,487 rows permanently changed. dq_snapshot_rows does the INSERT INTO
 *   fix_snapshots SELECT ... directly inside PostgreSQL and returns only a BIGINT count.
 *   PostgREST applies no row limit to scalar returns, so every affected row is captured.
 */
async function snapshotAffectedRows(
  fixHistoryId: string,
  fixSql: string,
  tableId: string
): Promise<{ snapshotted: boolean; requiresConfirmation: boolean; rowCount: number }> {
  const whereClause = extractWhereClause(fixSql, tableId)
  if (!whereClause) {
    // CTE or unrecognised pattern — caller must confirm before applying without snapshot
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

// ── apply a fix ───────────────────────────────────────────────────────────────

export async function applyFix(
  issueId: string,
  fixOptionIndex: number,
  skipSnapshot = false
): Promise<{ success: boolean; rowsAffected?: number; error?: string; requiresSnapshotConfirmation?: boolean }> {
  // RLS client — all table operations are enforced by Postgres RLS policies
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const issue = await verifyIssueAccess(supabase, issueId, user.id)
  if (!issue) return { success: false, error: 'Issue not found or access denied' }

  if (!issue.ai_fix_options || fixOptionIndex >= issue.ai_fix_options.length) {
    return { success: false, error: 'Invalid fix option selected' }
  }

  const chosenFix = issue.ai_fix_options[fixOptionIndex]
  const tableId = issue.table_id

  if (!tableId) return { success: false, error: 'Issue has no associated table' }

  const validation = validateFixSQL(chosenFix.sql, tableId)
  if (!validation.safe) {
    return { success: false, error: `Fix SQL failed safety check: ${validation.reason}` }
  }

  // Admin required: dq_table_samples is SECURITY DEFINER and reads data_rows
  let oldValuesSample: Record<string, unknown>[] = []
  try {
    const { data: sampleData } = await supabaseAdmin.rpc('dq_table_samples', {
      p_table_id: tableId,
      p_limit: 5,
    })
    oldValuesSample = Array.isArray(sampleData) ? sampleData : []
  } catch {
    // Non-critical audit sample — continue
  }

  // Create fix_history first (snapshot FK depends on this ID)
  const { data: histRecord, error: histError } = await supabase
    .from('fix_history')
    .insert({
      quality_issue_id: issueId,
      project_id: issue.project_id,
      table_id: tableId,
      fix_description: chosenFix.description,
      fix_sql: chosenFix.sql,
      fix_option_chosen: chosenFix.label,
      affected_row_count: 0,
      old_values_sample: oldValuesSample.length > 0 ? oldValuesSample : null,
      applied_by: user.id,
      status: 'applied',
      snapshot_failed: false,
    })
    .select('id')
    .single()

  if (histError || !histRecord) {
    console.warn('[quality-fixes] Failed to create fix_history:', histError?.message)
    return { success: false, error: 'Failed to log fix. Please try again.' }
  }

  const fixHistoryId = histRecord.id

  // Snapshot rows BEFORE executing — abort if snapshot fails
  let snapshotResult: { snapshotted: boolean; requiresConfirmation: boolean; rowCount: number }
  try {
    snapshotResult = await snapshotAffectedRows(fixHistoryId, chosenFix.sql, tableId)
  } catch {
    // Technical snapshot failure — abort entirely
    await supabase.from('fix_history').delete().eq('id', fixHistoryId)
    return {
      success: false,
      error: 'Failed to save data snapshot before fix. Fix was NOT applied. Please try again.',
    }
  }

  // CTE/complex SQL detected — requires user confirmation before proceeding without snapshot
  if (snapshotResult.requiresConfirmation && !skipSnapshot) {
    await supabase.from('fix_history').delete().eq('id', fixHistoryId)
    return { success: false, requiresSnapshotConfirmation: true }
  }

  // User confirmed applying without snapshot — mark it so revert shows the correct message
  if (!snapshotResult.snapshotted && skipSnapshot) {
    await supabase.from('fix_history').update({ snapshot_failed: true }).eq('id', fixHistoryId)
  }

  // Set affected_row_count from the snapshot count immediately — this is the most reliable
  // source because dq_snapshot_rows counts rows directly in PostgreSQL with no PostgREST
  // row limit. We'll overwrite with the execute_data_fix count afterwards.
  if (snapshotResult.rowCount > 0) {
    await supabase
      .from('fix_history')
      .update({ affected_row_count: snapshotResult.rowCount })
      .eq('id', fixHistoryId)
  }

  // Admin required: execute_data_fix is SECURITY DEFINER and modifies data_rows
  const { data: execData, error: execError } = await supabaseAdmin.rpc('execute_data_fix', {
    p_sql: chosenFix.sql,
    p_table_id: tableId,
  })

  if (execError) {
    console.error('[quality-fixes] execute_data_fix error:', execError.message)
    // Clean up snapshot and history since fix did not run
    await supabase.from('fix_snapshots').delete().eq('fix_history_id', fixHistoryId)
    await supabase.from('fix_history').delete().eq('id', fixHistoryId)
    return { success: false, error: `Fix execution failed: ${execError.message}` }
  }

  // execData is the INT returned by execute_data_fix (GET DIAGNOSTICS ROW_COUNT).
  // Prefer this over the snapshot count for the final value since it reflects what
  // PostgreSQL actually modified (DELETE fixes may differ from the snapshot count).
  const rowsAffected = typeof execData === 'number' && execData >= 0
    ? execData
    : snapshotResult.rowCount

  await supabase
    .from('fix_history')
    .update({ affected_row_count: rowsAffected })
    .eq('id', fixHistoryId)

  await supabase.from('quality_issues').update({ status: 'fixed' }).eq('id', issueId)

  if (issue.stage === 'source') {
    try {
      await runSourceDataChecks(issue.project_id, tableId, 'manual_scan')
    } catch {
      // Non-critical
    }
  }

  if (issue.field_id) {
    try {
      await recomputeFieldProfile(issue.field_id, tableId)
    } catch {
      // Non-critical
    }
  }

  return { success: true, rowsAffected }
}

// ── accept risk ───────────────────────────────────────────────────────────────

export async function acceptRisk(
  issueId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const issue = await verifyIssueAccess(supabase, issueId, user.id)
  if (!issue) return { success: false, error: 'Issue not found or access denied' }

  if (!issue.table_id) return { success: false, error: 'Issue has no associated table' }

  await supabase.from('quality_issues').update({ status: 'accepted_risk' }).eq('id', issueId)

  await supabase.from('fix_history').insert({
    quality_issue_id: issueId,
    project_id: issue.project_id,
    table_id: issue.table_id,
    fix_description: reason ? `Risk accepted: ${reason}` : 'Risk accepted without fix',
    fix_sql: '-- Risk accepted, no SQL executed',
    fix_option_chosen: null,
    affected_row_count: 0,
    old_values_sample: null,
    applied_by: user.id,
    status: 'applied',
    snapshot_failed: false,
  })

  return { success: true }
}

// ── revert a fix ──────────────────────────────────────────────────────────────

export async function revertFix(
  fixHistoryId: string
): Promise<{ success: boolean; rowsAffected?: number; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: histRecord } = await supabase
    .from('fix_history')
    .select('*, projects!inner(user_id)')
    .eq('id', fixHistoryId)
    .single()

  if (!histRecord) return { success: false, error: 'Fix history record not found' }
  if ((histRecord as unknown as { projects: { user_id: string } }).projects?.user_id !== user.id) {
    return { success: false, error: 'Access denied' }
  }

  if (histRecord.status === 'reverted') {
    return { success: false, error: 'This fix has already been reverted' }
  }

  // Risk-accepted records: just flip the issue status back — no data was changed
  if (histRecord.fix_sql === '-- Risk accepted, no SQL executed') {
    if (histRecord.quality_issue_id) {
      await supabase
        .from('quality_issues')
        .update({ status: 'open' })
        .eq('id', histRecord.quality_issue_id)
    }
    await supabase
      .from('fix_history')
      .update({ status: 'reverted', reverted_at: new Date().toISOString() })
      .eq('id', fixHistoryId)
    return { success: true, rowsAffected: 0 }
  }

  // Fix was applied without a snapshot (user confirmed CTE/complex SQL) — cannot revert
  if (histRecord.snapshot_failed) {
    return {
      success: false,
      error:
        'Cannot revert — no data snapshot was taken for this fix. ' +
        'Re-upload the original CSV from Control Plane to restore data.',
    }
  }

  // Check snapshot count
  const { count: snapshotCount } = await supabase
    .from('fix_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('fix_history_id', fixHistoryId)

  if (!snapshotCount || snapshotCount === 0) {
    // 0 rows were affected — nothing to restore, just flip status
    if (histRecord.affected_row_count === 0) {
      if (histRecord.quality_issue_id) {
        await supabase
          .from('quality_issues')
          .update({ status: 'open' })
          .eq('id', histRecord.quality_issue_id)
      }
      await supabase
        .from('fix_history')
        .update({ status: 'reverted', reverted_at: new Date().toISOString() })
        .eq('id', fixHistoryId)
      return { success: true, rowsAffected: 0 }
    }

    return {
      success: false,
      error:
        'No snapshot found for this fix. This fix was applied before snapshot-based revert ' +
        'was added. Re-upload the original CSV from Control Plane to restore data.',
    }
  }

  const isDeleteFix = /^\s*DELETE\b/i.test(histRecord.fix_sql.trim())
  let rowsAffected = 0

  if (isDeleteFix) {
    // Admin required: dq_revert_insert_rows is SECURITY DEFINER and inserts into data_rows
    const { data: insertCount, error: insertError } = await supabaseAdmin.rpc(
      'dq_revert_insert_rows',
      { p_table_id: histRecord.table_id, p_fix_history_id: fixHistoryId }
    )
    if (insertError) {
      console.error('[quality-fixes] dq_revert_insert_rows error:', insertError.message)
      return { success: false, error: `Revert failed: ${insertError.message}` }
    }
    rowsAffected = Number(insertCount ?? 0)
  } else {
    // Admin required: dq_revert_update_rows is SECURITY DEFINER and bulk-updates data_rows
    const { data: updateCount, error: updateError } = await supabaseAdmin.rpc(
      'dq_revert_update_rows',
      { p_fix_history_id: fixHistoryId }
    )
    if (updateError) {
      console.error('[quality-fixes] dq_revert_update_rows error:', updateError.message)
      return { success: false, error: `Revert failed: ${updateError.message}` }
    }
    rowsAffected = Number(updateCount ?? 0)
  }

  // Snapshots no longer needed after a successful revert
  await supabase.from('fix_snapshots').delete().eq('fix_history_id', fixHistoryId)

  await supabase
    .from('fix_history')
    .update({ status: 'reverted', reverted_at: new Date().toISOString() })
    .eq('id', fixHistoryId)

  if (histRecord.quality_issue_id) {
    await supabase
      .from('quality_issues')
      .update({ status: 'open' })
      .eq('id', histRecord.quality_issue_id)
  }

  try {
    const { data: fields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', histRecord.table_id)
    for (const f of fields ?? []) {
      await recomputeFieldProfile(f.id, histRecord.table_id)
    }
  } catch {
    // Non-critical
  }

  return { success: true, rowsAffected }
}

// ── get fix history ───────────────────────────────────────────────────────────

export async function getFixHistory(
  projectId: string
): Promise<FixHistory[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data } = await supabase
    .from('fix_history')
    .select('*')
    .eq('project_id', projectId)
    .order('applied_at', { ascending: false })

  return (data as FixHistory[]) ?? []
}

// ── run full scan ─────────────────────────────────────────────────────────────

export async function runFullScan(
  projectId: string
): Promise<{ success: boolean; issueCount: number; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, issueCount: 0, error: 'Not authenticated' }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { success: false, issueCount: 0, error: 'Project not found or access denied' }

  const { data: datasets } = await supabase
    .from('datasets')
    .select('id, role')
    .eq('project_id', projectId)

  if (!datasets) return { success: true, issueCount: 0 }

  const sourceDatasetIds = datasets.filter((d) => d.role === 'source').map((d) => d.id)
  const { data: sourceTables } = await supabase
    .from('tables')
    .select('id')
    .in('dataset_id', sourceDatasetIds)

  const tableIds = (sourceTables ?? []).map((t) => t.id)

  for (const tid of tableIds) {
    try {
      await runSourceDataChecks(projectId, tid, 'manual_scan')
    } catch (err) {
      console.warn(`[quality-fixes] Source scan failed for table ${tid}:`, err)
    }
    try {
      await executeCustomRules(projectId, tid)
    } catch (err) {
      console.warn(`[quality-fixes] Custom rules failed for table ${tid}:`, err)
    }
  }

  const targetDatasetIds = datasets.filter((d) => d.role === 'target').map((d) => d.id)
  if (targetDatasetIds.length > 0) {
    const { data: targetTables } = await supabase
      .from('tables')
      .select('id')
      .in('dataset_id', targetDatasetIds)
    for (const tid of (targetTables ?? []).map((t) => t.id)) {
      try {
        await executeCustomRules(projectId, tid)
      } catch (err) {
        console.warn(`[quality-fixes] Custom rules failed for target table ${tid}:`, err)
      }
    }
  }

  const { runInFlightChecks } = await import('@/lib/quality/detection-engine')
  try {
    await runInFlightChecks(projectId)
  } catch {
    // No mappings is acceptable
  }

  const { count } = await supabase
    .from('quality_issues')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'open')

  return { success: true, issueCount: count ?? 0 }
}

// ── get all issues for a project ──────────────────────────────────────────────

export async function getQualityIssues(
  projectId: string
): Promise<{ issues: QualityIssue[]; hasMappings: boolean }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { issues: [], hasMappings: false }

  const { data: issues } = await supabase
    .from('quality_issues')
    .select('*')
    .eq('project_id', projectId)
    .order('severity', { ascending: true })
    .order('affected_records', { ascending: false })

  const { count: mappingCount } = await supabase
    .from('table_mappings')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)

  return {
    issues: (issues as QualityIssue[]) ?? [],
    hasMappings: (mappingCount ?? 0) > 0,
  }
}

// ── helper: recompute field profile ──────────────────────────────────────────

async function recomputeFieldProfile(fieldId: string, tableId: string): Promise<void> {
  // Uses the RLS client — data_rows, fields, and field_profiles all have RLS policies
  // that allow access to the current user's project data.
  const supabase = await createClient()

  const { data: rows } = await supabase
    .from('data_rows')
    .select('row_data')
    .eq('table_id', tableId)

  if (!rows || rows.length === 0) return

  const { data: field } = await supabase
    .from('fields')
    .select('name')
    .eq('id', fieldId)
    .single()

  if (!field) return

  const fieldName = field.name
  const total = rows.length
  const values = rows.map((r) => (r.row_data as Record<string, unknown>)[fieldName])
  const nullCount = values.filter((v) => v === null || v === undefined || v === '').length
  const nonNullValues = values.filter((v) => v !== null && v !== undefined && v !== '')
  const uniqueSet = new Set(nonNullValues.map((v) => String(v)))
  const cardinality = uniqueSet.size
  const sampleValues = [...uniqueSet].slice(0, 10)

  await supabase.from('field_profiles').upsert(
    {
      field_id: fieldId,
      total_rows: total,
      null_count: nullCount,
      null_percentage: total > 0 ? (nullCount / total) * 100 : 0,
      cardinality,
      unique_percentage: total > 0 ? (uniqueSet.size / total) * 100 : 0,
      format_issues_count: 0,
      min_value: nonNullValues.length > 0 ? String(nonNullValues[0]) : null,
      max_value:
        nonNullValues.length > 0 ? String(nonNullValues[nonNullValues.length - 1]) : null,
      sample_values: sampleValues,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'field_id' }
  )
}
