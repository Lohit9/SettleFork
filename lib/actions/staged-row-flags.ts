'use server'

/**
 * flagStagedRowIssues
 *
 * Post-staging action that cross-references staged rows against open quality
 * issues and populates the row_issues JSONB column on staged_data_rows.
 *
 * Design:
 *  1. Reset row_issues = [] on all rows for this table mapping (idempotent).
 *  2. Load open quality issues for the source table.
 *  3. For each issue, look up the source field name + mapped target field name.
 *  4. Call the flag_staged_rows_for_issue RPC to append the issue object to
 *     matching rows using the condition that matches the issue_kind.
 *
 * Call after every stageAllData and applyTransform invocation.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StagedRowIssue {
  field: string          // target field name
  source_field: string   // source CSV field name
  issue_id: string       // quality_issues.id
  issue_kind: string     // machine-readable kind (matches flag_staged_rows_for_issue CASE)
  severity: 'blocking' | 'warning'
  description: string    // human-readable description shown in UI
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Falls back to keyword-matching against the issue description when issue_kind
 * was not stored on the quality_issues row (e.g. pre-024 rows or custom rules).
 */
function inferIssueKind(
  description: string,
  isPk: boolean,
  isFk: boolean
): string | null {
  const d = description.toLowerCase()
  if (d.includes('null') && isPk && !d.includes('duplicate')) return 'null_pk'
  if (d.includes('null') && !isPk && (d.includes('non-nullable') || d.includes('required'))) return 'null_required'
  if (d.includes('duplicate') && isPk) return 'duplicate_pk'
  if (d.includes('invalid date strings') || d.includes('not recognisable as any date')) return 'invalid_date_string'
  if (d.includes('non-iso date')) return 'non_iso_date'
  if (d.includes('currency formatting')) return 'currency_format'
  if (d.includes('negative values')) return 'negative_value'
  if (d.includes('invalid email')) return 'email_format'
  if (d.includes('invalid phone')) return 'phone_format'
  if (d.includes('not valid integers')) return 'type_mismatch_integer'
  if (d.includes('not valid numbers')) return 'type_mismatch_numeric'
  if ((d.includes('referential integrity') || d.includes('orphaned')) && isFk) return 'orphaned_fk'
  if (d.includes('high null rate')) return 'high_null_rate'
  return null
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function flagStagedRowIssues(
  projectId: string,
  tableMappingId: string
): Promise<{ flaggedRows: number; error?: string }> {
  try {
    // ── Step 1: Get the table mapping ────────────────────────────────────────
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('table_mappings')
      .select('source_table_id, target_table_id, project_id')
      .eq('id', tableMappingId)
      .single()

    if (tmErr || !tm) {
      return { flaggedRows: 0, error: 'Table mapping not found' }
    }
    if (tm.project_id !== projectId) {
      return { flaggedRows: 0, error: 'Access denied' }
    }

    // ── Step 2: Reset row_issues for idempotency ─────────────────────────────
    await supabaseAdmin
      .from('staged_data_rows')
      .update({ row_issues: [] })
      .eq('table_mapping_id', tableMappingId)

    // ── Step 3: Load open quality issues for this source table ───────────────
    const { data: issues } = await supabaseAdmin
      .from('quality_issues')
      .select('id, field_id, title, description, severity, issue_kind')
      .eq('project_id', projectId)
      .eq('table_id', tm.source_table_id)
      .eq('status', 'open')
      .in('severity', ['blocking', 'warning'])

    if (!issues || issues.length === 0) {
      return { flaggedRows: 0 }
    }

    // ── Step 4: Fetch source field metadata in one shot ──────────────────────
    const fieldIds = [...new Set(issues.map((i) => i.field_id).filter(Boolean) as string[])]

    const { data: sourceFields } = await supabaseAdmin
      .from('fields')
      .select('id, name, is_primary_key, is_foreign_key, fk_reference')
      .in('id', fieldIds)

    const srcById = new Map(
      (sourceFields ?? []).map((f) => [f.id, f])
    )

    // ── Step 5: Load field mappings (source field id → target field name) ────
    const { data: fieldMappings } = await supabaseAdmin
      .from('field_mappings')
      .select('source_field_id, target_field:fields!field_mappings_target_field_id_fkey(name)')
      .eq('table_mapping_id', tableMappingId)
      .neq('status', 'rejected')

    const targetNameBySrcId = new Map<string, string>()
    for (const fm of fieldMappings ?? []) {
      const tgt = fm.target_field as { name: string } | null
      if (tgt?.name) {
        targetNameBySrcId.set(fm.source_field_id, tgt.name)
      }
    }

    // ── Step 6: Pre-resolve FK reference table IDs ───────────────────────────
    // For orphaned_fk issues we need the parent table ID within the same dataset.
    const fkFields = (sourceFields ?? []).filter((f) => f.is_foreign_key && f.fk_reference)
    const refTableIdMap = new Map<string, { refTableId: string; refFieldName: string }>()

    if (fkFields.length > 0) {
      // Get the dataset_id of the source table to scope the lookup
      const { data: srcTableRow } = await supabaseAdmin
        .from('tables')
        .select('dataset_id')
        .eq('id', tm.source_table_id)
        .single()

      if (srcTableRow) {
        const refNames = [...new Set(fkFields.map((f) => f.fk_reference!.split('.')[0]))]
        const { data: refTables } = await supabaseAdmin
          .from('tables')
          .select('id, name')
          .eq('dataset_id', srcTableRow.dataset_id)
          .in('name', refNames)

        const refTableByName = new Map((refTables ?? []).map((t) => [t.name, t.id]))

        for (const f of fkFields) {
          const [refTableName, refFieldName] = f.fk_reference!.split('.')
          const refTableId = refTableByName.get(refTableName)
          if (refTableId) {
            refTableIdMap.set(f.id, { refTableId, refFieldName })
          }
        }
      }
    }

    // ── Step 7: For each quality issue, flag matching staged rows ─────────────
    let maxFlagged = 0

    for (const issue of issues) {
      if (!issue.field_id) continue

      const srcField = srcById.get(issue.field_id)
      if (!srcField) continue

      const sourceFieldName = srcField.name
      const targetFieldName = targetNameBySrcId.get(issue.field_id) ?? sourceFieldName

      // Resolve the issue kind — prefer stored value, fall back to inference
      const issueKind =
        (issue.issue_kind as string | null) ??
        inferIssueKind(issue.description, srcField.is_primary_key, srcField.is_foreign_key)

      if (!issueKind) continue

      const issueObj: StagedRowIssue = {
        field: targetFieldName,
        source_field: sourceFieldName,
        issue_id: issue.id,
        issue_kind: issueKind,
        severity: issue.severity as 'blocking' | 'warning',
        description: issue.title || issue.description,
      }

      // Build RPC params — only pass optional params when required
      const rpcParams: Record<string, unknown> = {
        p_table_mapping_id: tableMappingId,
        p_source_field_name: sourceFieldName,
        p_issue_kind: issueKind,
        p_issue: issueObj,
      }

      if (issueKind === 'duplicate_pk') {
        rpcParams.p_source_table_id = tm.source_table_id
      }

      if (issueKind === 'orphaned_fk') {
        const fkInfo = refTableIdMap.get(issue.field_id)
        if (!fkInfo) continue
        rpcParams.p_ref_table_id = fkInfo.refTableId
        rpcParams.p_ref_field_name = fkInfo.refFieldName
      }

      const { data: affected, error: rpcErr } = await supabaseAdmin.rpc(
        'flag_staged_rows_for_issue',
        rpcParams
      )

      if (rpcErr) {
        console.warn(
          `[flagStagedRowIssues] RPC error for field "${sourceFieldName}" kind "${issueKind}":`,
          rpcErr.message
        )
        continue
      }

      maxFlagged = Math.max(maxFlagged, Number(affected ?? 0))
    }

    return { flaggedRows: maxFlagged }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[flagStagedRowIssues] Unexpected error:', msg)
    return { flaggedRows: 0, error: msg }
  }
}
