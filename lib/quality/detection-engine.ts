/**
 * Deterministic Data Quality Detection Engine
 *
 * Design principle: pure SQL aggregation — no row-by-row iteration.
 * All queries run via Supabase RPC helper functions defined in 006_data_quality.sql.
 * The admin client is used for aggregation queries; project ownership is verified
 * explicitly before any data access.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { QualityIssue, Field } from '@/lib/types/database'

// ── helpers ──────────────────────────────────────────────────────────────────

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

async function rpcCount(fn: string, params: Record<string, unknown>): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc(fn, params)
  if (error) {
    console.warn(`[detection] RPC ${fn} error:`, error.message)
    return 0
  }
  return Number(data ?? 0)
}

async function rpcSamples(
  fn: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin.rpc(fn, params)
  if (error) {
    console.warn(`[detection] RPC ${fn} samples error:`, error.message)
    return []
  }
  return Array.isArray(data) ? data : []
}

function makeIssue(
  overrides: Partial<QualityIssue> & {
    project_id: string
    table_id: string
    field_id: string | null
    stage: QualityIssue['stage']
    severity: QualityIssue['severity']
    title: string
    description: string
    affected_records: number
    issue_kind?: string | null
    affected_rows_sample?: Record<string, unknown>[]
    detection_source?: QualityIssue['detection_source']
  }
): Omit<QualityIssue, 'id' | 'created_at'> {
  return {
    ai_suggested_fix: null,
    ai_fix_options: null,
    downstream_impact: null,
    generated_sql: null,
    status: 'open',
    detection_source: 'auto',
    validation_rule_id: null,
    affected_rows_sample: null,
    issue_kind: null,
    ...overrides,
  }
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

export async function runInFlightChecks(projectId: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Verify project ownership
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) throw new Error('Project not found or access denied')

  // Delete existing in-flight issues for this project (re-scan is idempotent)
  await supabaseAdmin
    .from('quality_issues')
    .delete()
    .eq('project_id', projectId)
    .eq('stage', 'in_flight')
    .in('detection_source', ['auto', 'manual_scan'])

  // Fetch all approved/needs_review field mappings with full context
  const { data: fieldMappings } = await supabaseAdmin
    .from('field_mappings')
    .select(
      `
      id,
      source_field_id,
      target_field_id,
      table_mapping_id,
      table_mappings!inner(
        project_id,
        source_table_id,
        target_table_id
      ),
      source_field:fields!source_field_id(id, name, data_type, inferred_type, is_nullable, is_primary_key, table_id),
      target_field:fields!target_field_id(id, name, data_type, is_nullable, is_foreign_key, fk_reference, table_id)
    `
    )
    .eq('table_mappings.project_id', projectId)

  if (!fieldMappings || fieldMappings.length === 0) return

  type TMRow = { project_id: string; source_table_id: string; target_table_id: string }
  type SFRow = { id: string; name: string; data_type: string; inferred_type: string | null; is_nullable: boolean; is_primary_key: boolean; table_id: string }
  type TFRow = { id: string; name: string; data_type: string; is_nullable: boolean; is_foreign_key: boolean; fk_reference: string | null; table_id: string }

  // Determine which table_mappings have staged data (transforms applied)
  const uniqueMappingIds = [
    ...new Set(fieldMappings.map((fm) => fm.table_mapping_id)),
  ]
  const stagedMappingIds = new Set<string>()
  for (const mappingId of uniqueMappingIds) {
    const { count } = await supabaseAdmin
      .from('staged_data_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_mapping_id', mappingId)
      .limit(1)
    if ((count ?? 0) > 0) stagedMappingIds.add(mappingId)
  }

  // Fetch target table names for display
  const targetTableIds = [
    ...new Set(
      fieldMappings.map((fm) => (fm.table_mappings as unknown as TMRow).target_table_id)
    ),
  ]
  const { data: targetTables } = await supabaseAdmin
    .from('tables')
    .select('id, name')
    .in('id', targetTableIds)
  const targetTableMap = new Map((targetTables ?? []).map((t) => [t.id, t.name]))

  // Build reverse map: target table name (uppercase) → table_mapping_id
  // Used for FK parent lookup in Check 10.
  const targetNameToMappingId = new Map<string, string>()
  for (const fm of fieldMappings) {
    const tm = fm.table_mappings as unknown as { project_id: string; source_table_id: string; target_table_id: string }
    const tName = targetTableMap.get(tm.target_table_id)
    if (tName && !targetNameToMappingId.has(tName.toUpperCase())) {
      targetNameToMappingId.set(tName.toUpperCase(), fm.table_mapping_id)
    }
  }

  // Fetch source table names
  const sourceTableIds = [
    ...new Set(
      fieldMappings.map((fm) => (fm.table_mappings as unknown as TMRow).source_table_id)
    ),
  ]
  const { data: sourceTables } = await supabaseAdmin
    .from('tables')
    .select('id, name')
    .in('id', sourceTableIds)
  const sourceTableMap = new Map((sourceTables ?? []).map((t) => [t.id, t.name]))

  const issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[] = []

  for (const fm of fieldMappings) {
    const tm = fm.table_mappings as unknown as TMRow
    const sf = fm.source_field as unknown as SFRow | null
    const tf = fm.target_field as unknown as TFRow | null

    if (!sf || !tf) continue

    const sourceTableName = sourceTableMap.get(tm.source_table_id) ?? 'source'
    const targetTableName = targetTableMap.get(tm.target_table_id) ?? 'target'
    const fieldTitle = `${sourceTableName}.${sf.name}`
    const hasStaged = stagedMappingIds.has(fm.table_mapping_id)

    // ── Check 8: String length truncation (BLOCKING)
    // Checks TRANSFORMED value against target length limit when staged data exists;
    // falls back to source data otherwise.
    const targetType = tf.data_type?.toUpperCase() ?? ''
    const lengthMatch = targetType.match(/(?:CHAR|VARCHAR)\((\d+)\)/)
    if (lengthMatch) {
      const maxLen = parseInt(lengthMatch[1], 10)

      let exceededCount = 0
      let samples: Record<string, unknown>[] = []

      if (hasStaged) {
        exceededCount = await rpcCount('dq_staged_length_exceeded', {
          p_mapping_id: fm.table_mapping_id,
          p_field: tf.name,
          p_max: maxLen,
        })
        if (exceededCount > 0) {
          samples = await rpcSamples('dq_staged_length_exceeded_samples', {
            p_mapping_id: fm.table_mapping_id,
            p_field: tf.name,
            p_max: maxLen,
            p_limit: 5,
          })
        }
      } else {
        exceededCount = await rpcCount('dq_length_exceeded_count', {
          p_table_id: tm.source_table_id,
          p_field: sf.name,
          p_max: maxLen,
        })
        if (exceededCount > 0) {
          samples = await rpcSamples('dq_length_exceeded_samples', {
            p_table_id: tm.source_table_id,
            p_field: sf.name,
            p_max: maxLen,
            p_limit: 5,
          })
        }
      }

      if (exceededCount > 0) {
        const dataNote = hasStaged ? '' : ' (checked against source data — stage transforms for transformed validation)'
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: hasStaged ? tm.target_table_id : tm.source_table_id,
            field_id: hasStaged ? tf.id : sf.id,
            stage: 'in_flight',
            severity: 'blocking',
            title: hasStaged ? `${targetTableName}.${tf.name}` : fieldTitle,
            description: `Transformed ${tf.name} values exceed target field limit (${maxLen} chars) — ${exceededCount} records affected${dataNote}`,
            affected_records: Number(exceededCount),
            affected_rows_sample: samples,
            detection_source: 'manual_scan',
          })
        )
      }
    }

    // ── Check 9: Case inconsistency (WARNING)
    // When staged data exists, check the TRANSFORMED values; target codes should
    // already be uppercase, so this should be rare after a transform is applied.
    const targetIsUpper =
      targetTableName === targetTableName.toUpperCase() &&
      tf.name === tf.name.toUpperCase() &&
      tf.name.includes('_')
    if (targetIsUpper) {
      let mixedCount = 0
      if (hasStaged) {
        mixedCount = await rpcCount('dq_staged_mixed_case_count', {
          p_mapping_id: fm.table_mapping_id,
          p_field: tf.name,
        })
      } else {
        mixedCount = await rpcCount('dq_mixed_case_count', {
          p_table_id: tm.source_table_id,
          p_field: sf.name,
        })
      }
      if (mixedCount > 0) {
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: hasStaged ? tm.target_table_id : tm.source_table_id,
            field_id: hasStaged ? tf.id : sf.id,
            stage: 'in_flight',
            severity: 'warning',
            title: `${targetTableName}.${tf.name}`,
            description: `Case inconsistency: ${hasStaged ? 'transformed' : 'source'} values contain lowercase, target expects uppercase — ${mixedCount} records affected`,
            affected_records: Number(mixedCount),
            detection_source: 'manual_scan',
          })
        )
      }
    }

    // ── Check 10: FK referential integrity against staged parent data (BLOCKING)
    // Only runs when both the child and parent table mappings have been staged.
    if (hasStaged && tf.is_foreign_key && tf.fk_reference) {
      const [parentTableName, parentFieldName] = tf.fk_reference.split('.')
      if (parentTableName && parentFieldName) {
        const parentMappingId = targetNameToMappingId.get(parentTableName.toUpperCase())
        if (parentMappingId && stagedMappingIds.has(parentMappingId)) {
          const orphanCount = await rpcCount('dq_staged_orphaned_fk_count', {
            p_child_mapping_id: fm.table_mapping_id,
            p_child_field: tf.name,
            p_parent_mapping_id: parentMappingId,
            p_parent_field: parentFieldName,
          })
          if (orphanCount > 0) {
            const samples = await rpcSamples('dq_staged_orphaned_fk_samples', {
              p_child_mapping_id: fm.table_mapping_id,
              p_child_field: tf.name,
              p_parent_mapping_id: parentMappingId,
              p_parent_field: parentFieldName,
              p_limit: 5,
            })
            issuesToInsert.push(
              makeIssue({
                project_id: projectId,
                table_id: tm.target_table_id,
                field_id: tf.id,
                stage: 'in_flight',
                severity: 'blocking',
                title: `${targetTableName}.${tf.name}`,
                description: `Referential integrity violation: ${orphanCount} staged record${orphanCount !== 1 ? 's' : ''} in ${targetTableName}.${tf.name} reference values not found in staged ${parentTableName}.${parentFieldName} — these records will fail on load`,
                affected_records: Number(orphanCount),
                affected_rows_sample: samples,
                issue_kind: 'orphaned_fk',
                detection_source: 'manual_scan',
              })
            )
          }
        }
      }
    }

    // ── Check 11: Non-nullable target with null/empty values (BLOCKING)
    // When staged data exists, check the TRANSFORMED value for the TARGET field.
    if (!tf.is_nullable && sf.is_nullable) {
      let nullCount = 0
      if (hasStaged) {
        nullCount = await rpcCount('dq_staged_null_count', {
          p_mapping_id: fm.table_mapping_id,
          p_field: tf.name,
        })
      } else {
        nullCount = await rpcCount('dq_null_count', {
          p_table_id: tm.source_table_id,
          p_field: sf.name,
        })
      }
      if (nullCount > 0) {
        const dataNote = hasStaged ? '' : ' (checked against source data — stage transforms for transformed validation)'
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: hasStaged ? tm.target_table_id : tm.source_table_id,
            field_id: hasStaged ? tf.id : sf.id,
            stage: 'in_flight',
            severity: 'blocking',
            title: hasStaged ? `${targetTableName}.${tf.name}` : fieldTitle,
            description: `Target field ${targetTableName}.${tf.name} is non-nullable but has ${nullCount} null/empty values after transformation — these records will fail on load${dataNote}`,
            affected_records: Number(nullCount),
            detection_source: 'manual_scan',
          })
        )
      }
    }
  }

  // ── Check 12: Required target fields with no mapping (BLOCKING)
  const { data: datasets } = await supabaseAdmin
    .from('datasets')
    .select('id')
    .eq('project_id', projectId)
    .eq('role', 'target')

  if (datasets && datasets.length > 0) {
    const targetDatasetIds = datasets.map((d) => d.id)
    const { data: targetTablesData } = await supabaseAdmin
      .from('tables')
      .select('id, name, dataset_id')
      .in('dataset_id', targetDatasetIds)

    if (targetTablesData) {
      for (const tbl of targetTablesData) {
        const { data: requiredFields } = await supabaseAdmin
          .from('fields')
          .select('id, name')
          .eq('table_id', tbl.id)
          .eq('is_nullable', false)

        if (!requiredFields) continue

        for (const rf of requiredFields) {
          // Check if any field_mapping points to this target field
          const { count } = await supabaseAdmin
            .from('field_mappings')
            .select('*', { count: 'exact', head: true })
            .eq('target_field_id', rf.id)

          if ((count ?? 0) === 0) {
            issuesToInsert.push(
              makeIssue({
                project_id: projectId,
                table_id: tbl.id,
                field_id: rf.id,
                stage: 'in_flight',
                severity: 'blocking',
                title: `${tbl.name}.${rf.name}`,
                description: `Required target field ${tbl.name}.${rf.name} has no source mapping — all records will fail on load unless a default value is provided`,
                affected_records: 0,
                detection_source: 'manual_scan',
              })
            )
          }
        }
      }
    }
  }

  if (issuesToInsert.length > 0) {
    const { error } = await supabaseAdmin.from('quality_issues').insert(issuesToInsert)
    if (error) {
      console.error('[detection] Failed to insert in-flight issues:', error.message)
    }
  }
}
