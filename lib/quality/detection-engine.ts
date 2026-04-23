/**
 * Deterministic Data Quality Detection Engine
 *
 * Design principle: pure SQL aggregation — no row-by-row iteration.
 * All queries run via Supabase RPC helper functions defined in 006_data_quality.sql.
 * The admin client is used for aggregation queries; project ownership is verified
 * explicitly before any data access.
 *
 * Module architecture (Prompt 3d Path A refactor):
 *
 *   This file ('use server') exposes the three public entry points the UI
 *   calls:
 *     - runSourceDataChecks  (source-stage data quality detection)
 *     - runInFlightChecks    (in-flight / post-transform detection)
 *     - runStagedValidation  (composite re-run + custom rules)
 *
 *   The bodies of runSourceDataChecks and runStagedValidation remain here.
 *   runInFlightChecks is a thin wrapper — its body lives in the non-server
 *   module `lib/quality/_detection-engine-core.ts` as
 *   `runInFlightChecksInternal`, which is directly testable against
 *   Heritage Core without the `'use server'` + auth plumbing. See
 *   `tests/integration/detection-engine-heritage.test.ts`.
 *
 *   Shared helpers (rpcCount / rpcSamples / makeIssue) also live in the
 *   core module and are imported back here.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { QualityIssue, Field } from '@/lib/types/database'
import {
  rpcCount,
  rpcSamples,
  makeIssue,
  runInFlightChecksInternal,
} from '@/lib/quality/_detection-engine-core'

// ── helpers (server-action-local) ─────────────────────────────────────────────

async function verifyTableOwnership(
  tableId: string,
  userId: string
): Promise<{ tableName: string; datasetId: string } | null> {
  const { data } = await supabaseAdmin
    .from('tables')
    .select('name, dataset_id, datasets!inner(project_id, projects!inner(user_id))')
    .eq('id', tableId)
    .single()

  if (!data) return null
  // @ts-expect-error nested join typing
  if (data.datasets?.projects?.user_id !== userId) return null

  return { tableName: data.name, datasetId: data.dataset_id }
}

async function getTableFields(tableId: string): Promise<Field[]> {
  const { data } = await supabaseAdmin
    .from('fields')
    .select('*')
    .eq('table_id', tableId)
    .order('ordinal_position')

  return (data as Field[]) ?? []
}

async function getTotalRowCount(tableId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('data_rows')
    .select('*', { count: 'exact', head: true })
    .eq('table_id', tableId)

  return count ?? 0
}

// ── SOURCE DATA CHECKS ────────────────────────────────────────────────────────

export async function runSourceDataChecks(
  projectId: string,
  tableId: string,
  detectionSource: 'auto' | 'manual_scan' = 'auto'
): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const tableInfo = await verifyTableOwnership(tableId, user.id)
  if (!tableInfo) throw new Error('Table not found or access denied')

  const { tableName } = tableInfo
  const fields = await getTableFields(tableId)
  const totalRows = await getTotalRowCount(tableId)

  // Delete existing auto-detected source issues for this table so re-scan is idempotent
  if (detectionSource === 'manual_scan') {
    await supabaseAdmin
      .from('quality_issues')
      .delete()
      .eq('table_id', tableId)
      .eq('stage', 'source')
      .in('detection_source', ['auto', 'manual_scan'])
  }

  const issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[] = []

  for (const field of fields) {
    const fieldTitle = `${tableName}.${field.name}`

    // ── Check 1: Null values in primary key fields (BLOCKING)
    if (field.is_primary_key) {
      const nullCount = await rpcCount('dq_null_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (nullCount > 0) {
        const samples = await rpcSamples('dq_null_samples', {
          p_table_id: tableId,
          p_field: field.name,
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'blocking',
            title: fieldTitle,
            description: 'Null values in primary key field',
            affected_records: Number(nullCount),
            issue_kind: 'null_pk',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 2: Null values in non-nullable (non-PK) fields (BLOCKING)
    if (!field.is_nullable && !field.is_primary_key) {
      const nullCount = await rpcCount('dq_null_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (nullCount > 0) {
        const samples = await rpcSamples('dq_null_samples', {
          p_table_id: tableId,
          p_field: field.name,
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'blocking',
            title: fieldTitle,
            description: 'Null values in non-nullable field',
            affected_records: Number(nullCount),
            issue_kind: 'null_required',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 3: Duplicate primary keys (BLOCKING)
    if (field.is_primary_key) {
      const dupeCount = await rpcCount('dq_duplicate_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (dupeCount > 0) {
        const samples = await rpcSamples('dq_duplicate_samples', {
          p_table_id: tableId,
          p_field: field.name,
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'blocking',
            title: fieldTitle,
            description: `Duplicate values in primary key field (${dupeCount} duplicate rows)`,
            affected_records: Number(dupeCount),
            issue_kind: 'duplicate_pk',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 4: Type mismatches (WARNING)
    const inferred = (field.inferred_type ?? '').toLowerCase()
    if (inferred === 'integer' || inferred === 'int') {
      const mismatchCount = await rpcCount('dq_non_integer_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (mismatchCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'type_integer',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Type mismatch: ${mismatchCount} values in ${field.name} are not valid integers`,
            affected_records: Number(mismatchCount),
            issue_kind: 'type_mismatch_integer',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    } else if (inferred === 'decimal' || inferred === 'float' || inferred === 'numeric') {
      const mismatchCount = await rpcCount('dq_non_numeric_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (mismatchCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'type_numeric',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Type mismatch: ${mismatchCount} values in ${field.name} are not valid numbers`,
            affected_records: Number(mismatchCount),
            issue_kind: 'type_mismatch_numeric',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 5: Format validation (WARNING)
    if (inferred === 'email') {
      const invalidCount = await rpcCount('dq_invalid_email_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (invalidCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'format_email',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Invalid email format detected in ${invalidCount} records`,
            affected_records: Number(invalidCount),
            issue_kind: 'email_format',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    } else if (inferred === 'phone') {
      const invalidCount = await rpcCount('dq_invalid_phone_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      if (invalidCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'format_phone',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Invalid phone format detected in ${invalidCount} records`,
            affected_records: Number(invalidCount),
            issue_kind: 'phone_format',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 6: Referential integrity within source (BLOCKING)
    if (field.is_foreign_key && field.fk_reference) {
      // fk_reference format: "tableName.fieldName" (bare names)
      const [refTableName, refFieldName] = field.fk_reference.split('.')
      if (refTableName && refFieldName) {
        // Find the referenced table within the same dataset
        const { data: refTableData } = await supabaseAdmin
          .from('tables')
          .select('id, dataset_id')
          .eq('name', refTableName)
          .eq('dataset_id', tableInfo.datasetId)
          .maybeSingle()

        if (refTableData) {
          const orphanCount = await rpcCount('dq_orphaned_fk_count', {
            p_source_table_id: tableId,
            p_source_field: field.name,
            p_target_table_id: refTableData.id,
            p_target_field: refFieldName,
          })
          if (orphanCount > 0) {
            const samples = await rpcSamples('dq_orphaned_fk_samples', {
              p_table_id: tableId,
              p_field_name: field.name,
              p_ref_table_id: refTableData.id,
              p_ref_field_name: refFieldName,
              p_limit: 5,
            })
            issuesToInsert.push(
              makeIssue({
                project_id: projectId,
                table_id: tableId,
                field_id: field.id,
                stage: 'source',
                severity: 'blocking',
                title: fieldTitle,
                description: `Referential integrity violation: ${orphanCount} orphaned records in ${field.name} referencing non-existent ${refTableName}.${refFieldName}`,
                affected_records: Number(orphanCount),
                issue_kind: 'orphaned_fk',
                affected_rows_sample: samples,
                detection_source: detectionSource,
              })
            )
          }
        }
      }
    }

    // ── Check 7: Anomalously high null rate in nullable fields (WARNING)
    if (field.is_nullable && totalRows > 0) {
      const nullCount = await rpcCount('dq_null_count', {
        p_table_id: tableId,
        p_field: field.name,
      })
      const nullRate = (Number(nullCount) / totalRows) * 100
      if (nullRate > 50 && nullCount > 0) {
        const samples = await rpcSamples('dq_null_samples', {
          p_table_id: tableId,
          p_field: field.name,
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `High null rate (${Math.round(nullRate)}%) in ${field.name} — review if this data should be populated`,
            affected_records: Number(nullCount),
            issue_kind: 'high_null_rate',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 8: Date format issues — non-ISO dates and fully-invalid date strings (WARNING / BLOCKING)
    const dateKeywords = ['date', 'created', 'updated', 'modified', 'dob', 'birth', 'start', 'end', 'expir']
    const fieldLower = field.name.toLowerCase()
    const fieldWordMatch = (k: string) => new RegExp(`(?:^|_|\\b)${k}(?:$|_|\\b)`).test(fieldLower)
    const isDateField =
      dateKeywords.some(fieldWordMatch) ||
      (field.inferred_type ?? '').toLowerCase() === 'date'

    if (isDateField) {
      // Non-ISO but parseable date formats (WARNING) — uses live RPC for accurate count
      // covering MM/DD/YYYY, DD-MM-YYYY, "Mar 15 2024", "15 March 2024", YYYY/MM/DD, etc.
      const nonIsoDateCount = await rpcCount('dq_non_iso_date_count', {
        p_table_id: tableId,
        p_field_name: field.name,
      })

      if (nonIsoDateCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'non_iso_date',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Non-standard date formats in ${nonIsoDateCount} records — transform to ISO 8601 (YYYY-MM-DD) before loading. Common patterns: MM/DD/YYYY, DD-MM-YY, "Mar 15 2024".`,
            affected_records: nonIsoDateCount,
            issue_kind: 'non_iso_date',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }

      // Truly unparseable date strings (BLOCKING) — random text, "N/A", "TBD", etc.
      // After migration 042, month-name and numeric formats are excluded from this count.
      const invalidDateCount = await rpcCount('dq_invalid_date_string_count', {
        p_table_id: tableId,
        p_field_name: field.name,
      })
      if (invalidDateCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'invalid_date',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'blocking',
            title: fieldTitle,
            description: `Unparseable date values in ${invalidDateCount} records — not recognisable as any date format and will fail on load.`,
            affected_records: Number(invalidDateCount),
            issue_kind: 'invalid_date_string',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 9: Currency formatting — $ signs and commas in numeric fields (WARNING)
    const currencyKeywords = ['revenue', 'amount', 'price', 'cost', 'total', 'salary', 'income', 'budget', 'fee', 'rate', 'pay', 'charge', 'balance']
    const isCurrencyField =
      (field.inferred_type ?? '').toLowerCase() === 'currency' ||
      ['decimal', 'float', 'numeric'].includes((field.inferred_type ?? '').toLowerCase()) ||
      currencyKeywords.some((k) => new RegExp(`(?:^|_|\\b)${k}(?:$|_|\\b)`).test(field.name.toLowerCase()))

    if (isCurrencyField) {
      const currencyFmtCount = await rpcCount('dq_currency_format_count', {
        p_table_id: tableId,
        p_field_name: field.name,
      })
      if (currencyFmtCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'format_currency',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Currency formatting detected in ${currencyFmtCount} records ($ signs or commas). Strip formatting before casting to a numeric target field.`,
            affected_records: Number(currencyFmtCount),
            issue_kind: 'currency_format',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }

      // ── Check 10: Negative values in currency/revenue fields (WARNING)
      const negativeCount = await rpcCount('dq_negative_numeric_count', {
        p_table_id: tableId,
        p_field_name: field.name,
      })
      if (negativeCount > 0) {
        const samples = await rpcSamples('dq_field_issue_samples', {
          p_table_id: tableId,
          p_field_name: field.name,
          p_condition: 'negative_value',
          p_limit: 5,
        })
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Negative values found in ${negativeCount} records. Revenue/amount fields typically should not contain negative values — verify these are intentional credits or adjustments.`,
            affected_records: Number(negativeCount),
            issue_kind: 'negative_value',
            affected_rows_sample: samples,
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 11: Inconsistent capitalisation in name fields (WARNING)
    // Exact-match keywords prevent false positives on 'title', 'department', etc.
    const nameExactKeywords = ['first_name', 'last_name', 'full_name', 'display_name', 'given_name', 'family_name', 'middle_name', 'preferred_name']
    const fn = field.name.toLowerCase()
    const isNameField =
      (field.inferred_type ?? '').toLowerCase() === 'name' ||
      nameExactKeywords.includes(fn) ||
      // Fields ending in _name, excluding company/product/file/table names (can be all-caps)
      (fn.endsWith('_name') &&
        !fn.includes('company') &&
        !fn.includes('product') &&
        !fn.includes('file') &&
        !fn.includes('table') &&
        !fn.includes('column'))

    if (isNameField) {
      const capsCount = await rpcCount('dq_inconsistent_caps_count', {
        p_table_id: tableId,
        p_field_name: field.name,
      })
      if (capsCount > 0) {
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Inconsistent capitalisation in ${capsCount} records — some values are all-lowercase or ALL-UPPERCASE where proper case (Title Case) is expected.`,
            affected_records: Number(capsCount),
            detection_source: detectionSource,
          })
        )
      }
    }

    // ── Check 12: Non-standard boolean representations (WARNING)
    const boolKeywords = ['is_', 'has_', 'active', 'enabled', 'flag', 'valid']
    const isBoolField =
      (field.inferred_type ?? '').toLowerCase() === 'boolean' ||
      field.data_type.toUpperCase() === 'BOOLEAN' ||
      boolKeywords.some((k) => new RegExp(`(?:^|_|\\b)${k}(?:$|_|\\b)`).test(field.name.toLowerCase()))

    if (isBoolField) {
      const nonBoolCount = await rpcCount('dq_non_standard_boolean_count', {
        p_table_id: tableId,
        p_field_name: field.name,
      })
      if (nonBoolCount > 0) {
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tableId,
            field_id: field.id,
            stage: 'source',
            severity: 'warning',
            title: fieldTitle,
            description: `Non-standard boolean representations in ${nonBoolCount} records (Y/N, yes/no, 1/0, etc.). Transform to TRUE/FALSE before loading into a boolean target field.`,
            affected_records: Number(nonBoolCount),
            detection_source: detectionSource,
          })
        )
      }
    }
  }

  // Batch insert all issues
  if (issuesToInsert.length > 0) {
    const { error } = await supabaseAdmin.from('quality_issues').insert(issuesToInsert)
    if (error) {
      console.error('[detection] Failed to insert source issues:', error.message)
    }
  }
}

// ── IN-FLIGHT CHECKS ──────────────────────────────────────────────────────────

// Thin server-action wrapper. Auth check + project-existence guard, then
// delegate to runInFlightChecksInternal. All business logic lives in
// lib/quality/_detection-engine-core.ts so it is directly testable against
// Heritage Core without the 'use server' + cookies/auth plumbing.

export async function runInFlightChecks(projectId: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) throw new Error('Project not found or access denied')

  return runInFlightChecksInternal(projectId)
}

// ── STAGED VALIDATION ─────────────────────────────────────────────────────────

/**
 * Lightweight scan that only validates staged (in-flight) data.
 * Re-runs the 5 in-flight checks plus custom rules against staged_data_rows.
 * Much faster than runFullScan — typically 1-3 seconds for a typical project.
 * Preserves source-stage issues; only in_flight issues are refreshed.
 */
export async function runStagedValidation(
  projectId: string
): Promise<{ success: boolean; issuesFound: number; error?: string }> {
  try {
    // runInFlightChecks already deletes auto/manual_scan in_flight issues internally.
    // Separately clear custom_rule in_flight issues so they get re-evaluated below.
    await supabaseAdmin
      .from('quality_issues')
      .delete()
      .eq('project_id', projectId)
      .eq('stage', 'in_flight')
      .eq('detection_source', 'custom_rule')

    // Run structural in-flight checks (handles its own auto/manual_scan deletion)
    await runInFlightChecks(projectId)

    // Re-run custom rules for each source table that has validation rules
    const { data: ruleRows } = await supabaseAdmin
      .from('validation_rules')
      .select('table_id')
      .eq('project_id', projectId)
      .not('table_id', 'is', null)

    const uniqueTableIds = [
      ...new Set(
        (ruleRows ?? []).map((r) => r.table_id).filter((id): id is string => !!id)
      ),
    ]

    if (uniqueTableIds.length > 0) {
      // Dynamic import avoids circular dependency (validation-rules imports nothing from here)
      const { executeCustomRules } = await import('@/lib/actions/validation-rules')
      for (const tableId of uniqueTableIds) {
        await executeCustomRules(projectId, tableId)
      }
    }

    // Count all open in-flight issues after the refresh
    const { count } = await supabaseAdmin
      .from('quality_issues')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('stage', 'in_flight')
      .eq('status', 'open')

    return { success: true, issuesFound: count ?? 0 }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[detection] runStagedValidation error:', error)
    return { success: false, issuesFound: 0, error }
  }
}
