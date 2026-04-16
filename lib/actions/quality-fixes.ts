'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { validateFixSQL } from '@/lib/quality/fix-sql-validator'
import { countFormatIssues } from '@/lib/utils/profiling'
import { runSourceDataChecks } from '@/lib/quality/detection-engine'
import { mapIssueKindToCondition } from '@/lib/quality/diagnostic-queries'
import { executeCustomRules } from '@/lib/actions/validation-rules'
import { logActivity } from '@/lib/actions/activity-log'
import type { QualityIssue, FixHistory } from '@/lib/types/database'

// ── helpers ───────────────────────────────────────────────────────────────────

type RLSClient = Awaited<ReturnType<typeof createClient>>

async function verifyIssueAccess(
  supabase: RLSClient,
  issueId: string
): Promise<QualityIssue | null> {
  const { data } = await supabase
    .from('quality_issues')
    .select('*')
    .eq('id', issueId)
    .single()
  return data as QualityIssue | null
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

  const issue = await verifyIssueAccess(supabase, issueId)
  if (!issue) return { success: false, error: 'Issue not found or access denied' }
  const perm = await requireProjectPermission(issue.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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
    const { error: snapshotUpdateError } = await supabaseAdmin
      .from('fix_history')
      .update({ affected_row_count: snapshotResult.rowCount })
      .eq('id', fixHistoryId)
    if (snapshotUpdateError) {
      console.error('[applyFix] Failed to update snapshot row count:', snapshotUpdateError)
    }
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
  const execRowCount = Number(execData ?? -1)
  const rowsAffected = execRowCount >= 0
    ? execRowCount
    : snapshotResult.rowCount

  const { error: rowCountUpdateError } = await supabaseAdmin
    .from('fix_history')
    .update({ affected_row_count: rowsAffected })
    .eq('id', fixHistoryId)
  if (rowCountUpdateError) {
    console.error('[applyFix] Failed to update final row count:', rowCountUpdateError)
  }

  await supabase.from('quality_issues').update({ status: 'fixed' }).eq('id', issueId)

  // Mark the source table as modified so staleness checks detect stale staged data
  await supabaseAdmin
    .from('tables')
    .update({ data_modified_at: new Date().toISOString() })
    .eq('id', tableId)

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

  await logActivity(
    issue.project_id,
    'fix_applied',
    `Fix applied: ${chosenFix.label} — ${rowsAffected} record${rowsAffected !== 1 ? 's' : ''}`,
    'fix',
    { fix_history_id: fixHistoryId, quality_issue_id: issueId, affected_rows: rowsAffected }
  )

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

  const issue = await verifyIssueAccess(supabase, issueId)
  if (!issue) return { success: false, error: 'Issue not found or access denied' }
  const perm = await requireProjectPermission(issue.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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

  await logActivity(
    issue.project_id,
    'risk_accepted',
    `Risk accepted: ${issue.title}${reason ? ' — ' + reason : ''}`,
    'validation',
    { quality_issue_id: issueId }
  )

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
    .select('*')
    .eq('id', fixHistoryId)
    .single()

  if (!histRecord) return { success: false, error: 'Fix history record not found' }
  const perm = await requireProjectPermission(histRecord.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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
        'Re-upload the original CSV from Project Setup to restore data.',
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
        'was added. Re-upload the original CSV from Project Setup to restore data.',
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

  await logActivity(
    histRecord.project_id,
    'fix_reverted',
    `Fix reverted: ${histRecord.fix_description}`,
    'fix',
    {
      fix_history_id: fixHistoryId,
      quality_issue_id: histRecord.quality_issue_id ?? null,
      affected_rows: rowsAffected,
    }
  )

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
): Promise<{ success: boolean; issueCount: number; warnings?: string[]; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, issueCount: 0, error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, issueCount: 0, error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { success: false, issueCount: 0, error: 'Project not found or access denied' }

  const { data: datasets } = await supabase
    .from('datasets')
    .select('id, role')
    .eq('project_id', projectId)

  if (!datasets) return { success: true, issueCount: 0, warnings: [] }

  const warnings: string[] = []

  const sourceDatasetIds = datasets.filter((d) => d.role === 'source').map((d) => d.id)
  const { data: sourceTables } = await supabase
    .from('tables')
    .select('id, name')
    .in('dataset_id', sourceDatasetIds)

  const tableIds = (sourceTables ?? []).map((t) => t.id)

  for (const tid of tableIds) {
    const tableName = (sourceTables ?? []).find((t) => t.id === tid)?.name ?? tid
    try {
      await runSourceDataChecks(projectId, tid, 'manual_scan')
    } catch (err) {
      console.warn(`[quality-fixes] Source scan failed for table ${tid}:`, err)
      warnings.push(`Source data scan encountered an error for table ${tableName}`)
    }
    try {
      const result = await executeCustomRules(projectId, tid)
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[quality-fixes] Custom rules failed for table ${tid}:`, msg)
      warnings.push(`Custom rule evaluation failed for table ${tableName}: ${msg}`)
    }
    try {
      const { runAIAugmentedChecks } = await import('@/lib/actions/ai-quality-detection')
      const aiResult = await runAIAugmentedChecks(projectId, tid)
      if (aiResult.error) {
        console.error(`[quality-fixes] AI augmented checks error for table ${tid}:`, aiResult.error)
      } else if (aiResult.skipped) {
        console.warn(`[quality-fixes] AI augmented checks skipped for table ${tid} (rate limit)`)
      } else {
        console.log(`[quality-fixes] AI augmented checks found ${aiResult.issuesFound} issues for table ${tid}`)
      }
    } catch (err) {
      console.error(`[quality-fixes] AI augmented checks FAILED for table ${tid}:`, err)
    }
  }

  const targetDatasetIds = datasets.filter((d) => d.role === 'target').map((d) => d.id)
  if (targetDatasetIds.length > 0) {
    const { data: targetTables } = await supabase
      .from('tables')
      .select('id, name')
      .in('dataset_id', targetDatasetIds)
    for (const ttRow of targetTables ?? []) {
      try {
        const result = await executeCustomRules(projectId, ttRow.id)
        if (result.warnings.length > 0) {
          warnings.push(...result.warnings)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[quality-fixes] Custom rules failed for target table ${ttRow.id}:`, msg)
        warnings.push(`Custom rule evaluation failed for table ${ttRow.name}: ${msg}`)
      }
    }
  }

  // Regenerate staged data so in-flight checks validate transformed values
  const { stageAllData } = await import('@/lib/actions/staging')
  try {
    await stageAllData(projectId)
  } catch {
    // Non-fatal — in-flight checks will fall back to source data
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

  const issueCount = count ?? 0
  await logActivity(
    projectId,
    'scan_run',
    `Full scan completed — ${issueCount} open issue${issueCount !== 1 ? 's' : ''} found`,
    'system',
    { issue_count: issueCount, warning_count: warnings.length }
  )

  return { success: true, issueCount, warnings }
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

// ── mark issue as fixed (used after a custom manual fix is applied) ───────────
// Updates the issue status to 'fixed' and, if the fix_history row ID is known,
// links it back to the quality issue so Fix History correctly shows the association.

export async function markIssueFixed(
  issueId: string,
  fixHistoryId?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const issue = await verifyIssueAccess(supabase, issueId)
  if (!issue) return { success: false, error: 'Issue not found or access denied' }
  const perm = await requireProjectPermission(issue.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const { error: updateErr } = await supabase
    .from('quality_issues')
    .update({ status: 'fixed' })
    .eq('id', issueId)

  if (updateErr) return { success: false, error: updateErr.message }

  if (fixHistoryId) {
    // Link the manual fix_history row to this quality issue so Fix History
    // shows the issue title alongside the fix and so Revert can re-open the issue.
    await supabase
      .from('fix_history')
      .update({ quality_issue_id: issueId })
      .eq('id', fixHistoryId)
  }

  return { success: true }
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
    .select('name, data_type, inferred_type')
    .eq('id', fieldId)
    .single()

  if (!field) return

  const fieldName = field.name
  const total = rows.length
  const rawValues = rows.map((r) => String((r.row_data as Record<string, unknown>)[fieldName] ?? ''))
  const nullCount = rawValues.filter((v) => v === '' || v === 'null' || v === 'undefined').length
  const nonNullValues = rawValues.filter((v) => v !== '' && v !== 'null' && v !== 'undefined')
  const uniqueSet = new Set(nonNullValues)
  const cardinality = uniqueSet.size

  // Frequency distribution — top 25 most frequent values
  const freqMap = new Map<string, number>()
  for (const v of nonNullValues) {
    const t = v.trim()
    if (t) freqMap.set(t, (freqMap.get(t) ?? 0) + 1)
  }
  const valueDistribution = Array.from(freqMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)

  const sampleValues = valueDistribution.slice(0, 10).map((d) => d.value)

  // Numeric-aware min/max
  let minValue: string | null = null
  let maxValue: string | null = null
  const inferredType = field.inferred_type
  if (nonNullValues.length > 0) {
    if (inferredType === 'currency' || inferredType === 'integer' || inferredType === 'decimal') {
      const numeric = nonNullValues
        .map((v) => { const n = Number(v.replace(/[$,\s]/g, '')); return isNaN(n) ? null : { v, n } })
        .filter(Boolean) as { v: string; n: number }[]
      if (numeric.length > 0) {
        numeric.sort((a, b) => a.n - b.n)
        minValue = numeric[0].v
        maxValue = numeric[numeric.length - 1].v
      }
    }
    if (!minValue) {
      const sorted = [...nonNullValues].sort()
      minValue = sorted[0]
      maxValue = sorted[sorted.length - 1]
    }
  }

  const formatIssuesCount = countFormatIssues(nonNullValues, field.data_type ?? '', field.inferred_type ?? null, fieldName)

  await supabase.from('field_profiles').upsert(
    {
      field_id: fieldId,
      total_rows: total,
      null_count: nullCount,
      null_percentage: total > 0 ? (nullCount / total) * 100 : 0,
      cardinality,
      unique_percentage: total > 0 ? (cardinality / total) * 100 : 0,
      format_issues_count: formatIssuesCount,
      min_value: minValue,
      max_value: maxValue,
      sample_values: sampleValues,
      value_distribution: valueDistribution,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'field_id' }
  )
}

// ── lazy-load affected rows for a quality issue ────────────────────────────────

/**
 * Fetches affected rows for a quality issue on demand.
 * For most issue types, delegates to the dq_field_issue_samples RPC.
 * For orphaned_fk issues, resolves the FK reference and uses dq_orphaned_fk_samples.
 */
export async function getAffectedRowsForIssue(
  issueId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ success: boolean; rows: Record<string, unknown>[]; total: number; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, rows: [], total: 0, error: 'Not authenticated' }

  const { data: issue } = await supabase
    .from('quality_issues')
    .select('id, project_id, table_id, field_id, issue_kind, affected_records')
    .eq('id', issueId)
    .single()

  if (!issue) return { success: false, rows: [], total: 0, error: 'Issue not found' }

  // Verify the user has access to this project
  const perm = await requireProjectPermission(issue.project_id, 'viewer')
  if (!perm.allowed) return { success: false, rows: [], total: 0, error: perm.error }

  if (!issue.field_id || !issue.table_id) {
    return { success: false, rows: [], total: 0, error: 'Cannot determine field context' }
  }

  const { data: field } = await supabaseAdmin
    .from('fields')
    .select('name, fk_reference')
    .eq('id', issue.field_id)
    .single()

  if (!field?.name) {
    return { success: false, rows: [], total: 0, error: 'Field not found' }
  }

  // Orphaned FK: resolve reference and use specialised RPC
  if (issue.issue_kind === 'orphaned_fk' && field.fk_reference) {
    const parts = field.fk_reference.split('.')
    const refFieldName = parts[parts.length - 1]
    const refTableName = parts[parts.length - 2]

    if (refTableName && refFieldName) {
      // Scope ref-table lookup to the same dataset as the source table
      const { data: srcTable } = await supabaseAdmin
        .from('tables')
        .select('dataset_id')
        .eq('id', issue.table_id)
        .single()

      const { data: refTable } = await supabaseAdmin
        .from('tables')
        .select('id')
        .eq('name', refTableName)
        .eq('dataset_id', srcTable?.dataset_id ?? '')
        .maybeSingle()

      if (refTable) {
        const { data: rows, error: rpcErr } = await supabaseAdmin.rpc('dq_orphaned_fk_samples', {
          p_table_id: issue.table_id,
          p_field_name: field.name,
          p_ref_table_id: refTable.id,
          p_ref_field_name: refFieldName,
          p_limit: limit,
        })

        if (rpcErr) {
          return { success: false, rows: [], total: issue.affected_records ?? 0, error: rpcErr.message }
        }
        return {
          success: true,
          rows: Array.isArray(rows) ? rows : [],
          total: issue.affected_records ?? 0,
        }
      }
    }
  }

  // All other issue types: use the generic field issue samples RPC
  const condition = mapIssueKindToCondition(issue.issue_kind)
  const { data: rows, error: rpcErr } = await supabaseAdmin.rpc('dq_field_issue_samples', {
    p_table_id: issue.table_id,
    p_field_name: field.name,
    p_condition: condition,
    p_limit: limit,
  })

  if (rpcErr) {
    return { success: false, rows: [], total: issue.affected_records ?? 0, error: rpcErr.message }
  }

  return {
    success: true,
    rows: Array.isArray(rows) ? rows : [],
    total: issue.affected_records ?? 0,
  }
}

// ── Staged validation server action ──────────────────────────────────────────
// Thin wrapper so client components can call runStagedValidation as a server
// action without needing direct access to detection-engine (non-server-action file).

export async function triggerStagedValidation(
  projectId: string
): Promise<{ success: boolean; issuesFound: number; error?: string }> {
  const { runStagedValidation } = await import('@/lib/quality/detection-engine')
  return runStagedValidation(projectId)
}

