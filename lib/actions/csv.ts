'use server'

import Papa from 'papaparse'
import { createClient } from '@/lib/supabase/server'
import { validateCSVUpload } from '@/lib/upload/validate'
import { computeFriendlyName } from '@/lib/db/sql-rewriter'

export interface UploadCSVResult {
  success: boolean
  tableId?: string
  fieldCount?: number
  rowCount?: number
  error?: string
}

export async function uploadCSV(formData: FormData): Promise<UploadCSVResult> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const file = formData.get('file') as File
    const projectId = formData.get('projectId') as string
    const role = formData.get('role') as 'source' | 'target'
    const datasetId = formData.get('datasetId') as string
    const tableName = formData.get('tableName') as string

    if (!file || !projectId || !role || !datasetId || !tableName) {
      return { success: false, error: 'Missing required fields' }
    }

    // ── Step 1: Validate file ─────────────────────────────────────────────────
    const validation = validateCSVUpload(file)
    if (!validation.valid) {
      return { success: false, error: validation.reason }
    }

    // ── Step 1b: Verify dataset ownership BEFORE any parsing work ─────────────
    // This prevents CPU waste from parsing files that will always fail RLS
    const { data: ownedDataset } = await supabase
      .from('datasets')
      .select('id, name')
      .eq('id', datasetId)
      .eq('project_id', projectId)
      .maybeSingle()

    if (!ownedDataset) {
      return { success: false, error: 'Dataset not found or access denied' }
    }

    const friendlyName = computeFriendlyName(ownedDataset.name, tableName)

    // ── Step 2: Parse CSV ─────────────────────────────────────────────────────
    const text = await file.text()
    const parseResult = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    })

    if (parseResult.errors.length > 0 && parseResult.data.length === 0) {
      return { success: false, error: 'Failed to parse CSV: ' + parseResult.errors[0].message }
    }

    const rows = parseResult.data
    if (rows.length === 0) {
      return { success: false, error: 'CSV has no data rows' }
    }
    if (rows.length > 100_000) {
      return { success: false, error: 'CSV exceeds 100,000 row limit' }
    }

    // ── Step 3: Sanitize + validate headers ───────────────────────────────────
    const rawHeaders = parseResult.meta.fields || Object.keys(rows[0])
    if (rawHeaders.length < 2) {
      return { success: false, error: 'CSV must have at least 2 columns' }
    }

    const headers = deduplicateHeaders(rawHeaders.map(sanitizeHeader))

    // ── Step 4: Sanitize all cell values ─────────────────────────────────────
    const sanitizedRows = rows.map((row: Record<string, string>) => {
      const out: Record<string, string> = {}
      rawHeaders.forEach((raw: string, i: number) => {
        const sanitized = headers[i]
        const val = row[raw] ?? ''
        out[sanitized] = sanitizeValue(String(val))
      })
      return out
    })

    // ── Step 5: Infer schema ──────────────────────────────────────────────────
    const sampleRows = sanitizedRows.slice(0, 100)
    const inferredFields = headers.map((header, index) => {
      const values = sampleRows
        .map((r: Record<string, string>) => r[header])
        .filter((v: string) => v !== '' && v !== null && v !== undefined)

      const { dataType, inferredType } = inferColumnType(header, values)
      const isNullable = values.length < sampleRows.length
      const uniqueValues = new Set(values)
      const isPrimaryKey =
        !isNullable &&
        uniqueValues.size === values.length &&
        values.length > 0 &&
        isPKName(header)
      const isForeignKey = !isPrimaryKey && isFKName(header)

      return {
        name: header,
        data_type: dataType,
        inferred_type: inferredType,
        is_nullable: isNullable,
        is_primary_key: isPrimaryKey,
        is_foreign_key: isForeignKey,
        fk_reference: null as string | null,
        ordinal_position: index + 1,
      }
    })

    // ── Step 6: Upsert table record (delete old + recreate) ───────────────────
    const { data: existingTable } = await supabase
      .from('tables')
      .select('id')
      .eq('dataset_id', datasetId)
      .eq('name', tableName)
      .maybeSingle()

    let tableId: string

    if (existingTable) {
      // Cascade delete cleans up fields, data_rows, field_profiles
      await supabase.from('tables').delete().eq('id', existingTable.id)
    }

    const { data: newTable, error: tableError } = await supabase
      .from('tables')
      .insert({ dataset_id: datasetId, name: tableName, row_count: rows.length, friendly_name: friendlyName })
      .select()
      .single()

    if (tableError || !newTable) {
      return { success: false, error: tableError?.message || 'Failed to create table record' }
    }
    tableId = newTable.id

    // ── Step 7: Insert fields ─────────────────────────────────────────────────
    const { data: createdFields, error: fieldsError } = await supabase
      .from('fields')
      .insert(inferredFields.map((f) => ({ ...f, table_id: tableId })))
      .select()

    if (fieldsError || !createdFields) {
      await supabase.from('tables').delete().eq('id', tableId)
      return { success: false, error: 'Failed to create field records: ' + fieldsError?.message }
    }

    // ── Step 8: Insert data_rows in batches of 1,000 ─────────────────────────
    const BATCH_SIZE = 1000
    for (let i = 0; i < sanitizedRows.length; i += BATCH_SIZE) {
      const batch = sanitizedRows.slice(i, i + BATCH_SIZE).map((row: Record<string, string>, idx: number) => ({
        table_id: tableId,
        row_number: i + idx + 1,
        row_data: row,
      }))
      const { error: rowsError } = await supabase.from('data_rows').insert(batch)
      if (rowsError) {
        await supabase.from('tables').delete().eq('id', tableId)
        return { success: false, error: 'Failed to insert rows: ' + rowsError.message }
      }
    }

    // ── Step 9: Compute and insert field_profiles ─────────────────────────────
    const profiles = createdFields.map((field) => {
        const fieldValues = sanitizedRows.map((r: Record<string, string>) => r[field.name] ?? '')
        const nonNull = fieldValues.filter((v: string) => v !== '' && v !== null && v !== undefined)
      const uniqueSet = new Set(nonNull)
      const sorted = [...nonNull].sort()
      const formatIssues = countFormatIssues(nonNull, field.data_type)

      return {
        field_id: field.id,
        total_rows: sanitizedRows.length,
        null_count: sanitizedRows.length - nonNull.length,
        null_percentage: +(
          (((sanitizedRows.length - nonNull.length) / sanitizedRows.length) * 100).toFixed(2)
        ),
        cardinality: uniqueSet.size,
        unique_percentage:
          nonNull.length > 0 ? +((uniqueSet.size / nonNull.length) * 100).toFixed(2) : 0,
        format_issues_count: formatIssues,
        min_value: sorted[0] ?? null,
        max_value: sorted[sorted.length - 1] ?? null,
        sample_values: [...uniqueSet].slice(0, 5),
      }
    })

    await supabase.from('field_profiles').insert(profiles)

    // ── Step 10: Upload raw CSV to Supabase Storage ───────────────────────────
    const sanitizedFilename = validation.sanitizedFilename ?? `${tableName}.csv`
    const storagePath = `${user.id}/${projectId}/${role}/${sanitizedFilename}`

    const { error: storageError } = await supabase.storage
      .from('project-files')
      .upload(storagePath, file, { upsert: true, contentType: 'text/csv' })

    if (!storageError) {
      await supabase.from('tables').update({ csv_storage_path: storagePath }).eq('id', tableId)
    }
    // Storage failure is non-fatal — DB records are already created

    // ── Step 11: Auto-run source data quality checks ──────────────────────────
    // Fire-and-forget: don't fail the upload if detection has an error
    try {
      const { runSourceDataChecks } = await import('@/lib/quality/detection-engine')
      await runSourceDataChecks(projectId, tableId, 'auto')
    } catch (detectionErr) {
      console.warn('[csv] Auto detection failed (non-fatal):', detectionErr)
    }

    return {
      success: true,
      tableId,
      fieldCount: inferredFields.length,
      rowCount: sanitizedRows.length,
    }
  } catch (err) {
    console.error('[uploadCSV]', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unexpected error occurred',
    }
  }
}

// ─── Header sanitization ──────────────────────────────────────────────────────

function sanitizeHeader(name: string): string {
  const trimmed = name.trim().slice(0, 100)
  return trimmed.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'column'
}

function deduplicateHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((h) => {
    const count = seen.get(h) ?? 0
    seen.set(h, count + 1)
    return count === 0 ? h : `${h}_${count + 1}`
  })
}

// ─── Value sanitization ───────────────────────────────────────────────────────

function sanitizeValue(value: string): string {
  // Neutralize CSV formula injection (Excel/Sheets attack vector)
  if (/^[=+\-@\t\r]/.test(value)) {
    return "'" + value
  }
  return value
}

// ─── Schema inference ─────────────────────────────────────────────────────────

function inferColumnType(
  name: string,
  values: string[]
): { dataType: string; inferredType: string | null } {
  const lower = name.toLowerCase()

  if (values.length === 0) return { dataType: 'VARCHAR(255)', inferredType: null }

  // Email — name hint or value pattern
  if (lower.includes('email') || values.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) {
    return { dataType: 'VARCHAR(255)', inferredType: 'email' }
  }

  // Boolean
  const boolSet = new Set(['true', 'false', '0', '1', 'yes', 'no', 'y', 'n', 't', 'f'])
  if (values.every((v) => boolSet.has(v.toLowerCase()))) {
    return { dataType: 'BOOLEAN', inferredType: null }
  }

  // ISO timestamp (must check before date)
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) {
    return { dataType: 'TIMESTAMP', inferredType: null }
  }

  // Date patterns
  const datePatterns = [/^\d{4}-\d{2}-\d{2}$/, /^\d{1,2}\/\d{1,2}\/\d{4}$/, /^\d{1,2}-\d{1,2}-\d{4}$/]
  if (values.every((v) => datePatterns.some((p) => p.test(v)))) {
    return { dataType: 'DATE', inferredType: null }
  }

  // Integer (no decimals)
  if (values.every((v) => /^-?\d+$/.test(v))) {
    const isCurrency =
      lower.includes('price') ||
      lower.includes('amount') ||
      lower.includes('revenue') ||
      lower.includes('salary') ||
      lower.includes('cost') ||
      lower.includes('total')
    if (isCurrency) return { dataType: 'DECIMAL(18,2)', inferredType: 'currency' }
    return { dataType: 'INT', inferredType: null }
  }

  // Decimal
  if (values.every((v) => /^-?\d+\.?\d*$/.test(v)) && values.some((v) => v.includes('.'))) {
    const isCurrency =
      lower.includes('price') ||
      lower.includes('amount') ||
      lower.includes('revenue') ||
      lower.includes('salary') ||
      lower.includes('cost') ||
      lower.includes('total')
    return { dataType: 'DECIMAL(18,2)', inferredType: isCurrency ? 'currency' : null }
  }

  // Phone
  if (lower.includes('phone') || lower.includes('mobile') || lower.includes('fax')) {
    return { dataType: 'VARCHAR(20)', inferredType: 'phone' }
  }

  // URL
  if (lower.includes('url') || lower.includes('website') || values.some((v) => /^https?:\/\//.test(v))) {
    return { dataType: 'VARCHAR(2048)', inferredType: 'url' }
  }

  // Default: VARCHAR sized to max observed length, min 40, round up to nearest 10
  const maxLen = Math.max(...values.map((v) => v.length), 1)
  const roundedLen = Math.min(4096, Math.max(40, Math.ceil(maxLen / 10) * 10))
  return { dataType: `VARCHAR(${roundedLen})`, inferredType: null }
}

function isPKName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'id' || lower === 'pk' || lower === 'key' || /^.+_id$/.test(lower)
}

function isFKName(name: string): boolean {
  const lower = name.toLowerCase()
  return (/^.+_id$/.test(lower) || /^.+id$/.test(lower)) && lower !== 'id'
}

function countFormatIssues(values: string[], dataType: string): number {
  if (dataType === 'INT') {
    return values.filter((v) => !/^-?\d+$/.test(v)).length
  }
  if (dataType === 'DECIMAL(18,2)') {
    return values.filter((v) => !/^-?\d+\.?\d*$/.test(v)).length
  }
  if (dataType === 'BOOLEAN') {
    const boolSet = new Set(['true', 'false', '0', '1', 'yes', 'no', 'y', 'n', 't', 'f'])
    return values.filter((v) => !boolSet.has(v.toLowerCase())).length
  }
  if (dataType === 'DATE') {
    return values.filter(
      (v) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(v) &&
        !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) &&
        !/^\d{1,2}-\d{1,2}-\d{4}$/.test(v)
    ).length
  }
  if (dataType === 'TIMESTAMP') {
    return values.filter((v) => !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)).length
  }
  return 0
}
