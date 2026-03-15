'use server'

import Papa from 'papaparse'
import { createClient } from '@/lib/supabase/server'

export type UploadCSVResult = {
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
    const datasetId = formData.get('datasetId') as string
    const tableName = formData.get('tableName') as string

    if (!file || !datasetId || !tableName) {
      return { success: false, error: 'Missing required fields' }
    }

    if (file.size > 10 * 1024 * 1024) {
      return { success: false, error: 'File exceeds 10MB limit' }
    }

    const validTypes = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv']
    if (!validTypes.includes(file.type) && !file.name.toLowerCase().endsWith('.csv')) {
      return { success: false, error: 'File must be a CSV (.csv)' }
    }

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
      return { success: false, error: 'CSV file is empty or has no data rows' }
    }

    if (rows.length > 100000) {
      return { success: false, error: 'CSV exceeds 100,000 row limit' }
    }

    const headers = parseResult.meta.fields || Object.keys(rows[0])
    if (headers.length === 0) {
      return { success: false, error: 'CSV has no columns' }
    }

    const sampleRows = rows.slice(0, 100)

    // Infer schema for each column
    const inferredFields = headers.map((header, index) => {
      const values = sampleRows
        .map((r) => r[header])
        .filter((v) => v !== '' && v !== null && v !== undefined)

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
        name: header.trim(),
        data_type: dataType,
        inferred_type: inferredType,
        is_nullable: isNullable,
        is_primary_key: isPrimaryKey,
        is_foreign_key: isForeignKey,
        fk_reference: null as string | null,
        ordinal_position: index + 1,
      }
    })

    // Upsert table — delete and recreate if it already exists
    const { data: existingTable } = await supabase
      .from('tables')
      .select('id')
      .eq('dataset_id', datasetId)
      .eq('name', tableName)
      .single()

    let tableId: string

    if (existingTable) {
      await supabase.from('fields').delete().eq('table_id', existingTable.id)
      await supabase.from('data_rows').delete().eq('table_id', existingTable.id)
      await supabase.from('field_profiles').delete().in(
        'field_id',
        (await supabase.from('fields').select('id').eq('table_id', existingTable.id)).data?.map(
          (f) => f.id
        ) || []
      )
      await supabase
        .from('tables')
        .update({ row_count: rows.length })
        .eq('id', existingTable.id)
      tableId = existingTable.id
    } else {
      const { data: newTable, error: tableError } = await supabase
        .from('tables')
        .insert({ dataset_id: datasetId, name: tableName, row_count: rows.length })
        .select()
        .single()
      if (tableError || !newTable) {
        return { success: false, error: tableError?.message || 'Failed to create table' }
      }
      tableId = newTable.id
    }

    // Insert fields
    const { data: createdFields, error: fieldsError } = await supabase
      .from('fields')
      .insert(inferredFields.map((f) => ({ ...f, table_id: tableId })))
      .select()
    if (fieldsError) {
      return { success: false, error: 'Failed to create fields: ' + fieldsError.message }
    }

    // Insert data_rows in batches of 500
    const BATCH_SIZE = 500
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE).map((row, idx) => ({
        table_id: tableId,
        row_number: i + idx + 1,
        row_data: sanitizeRow(row),
      }))
      const { error: rowsError } = await supabase.from('data_rows').insert(batch)
      if (rowsError) {
        return { success: false, error: 'Failed to insert rows: ' + rowsError.message }
      }
    }

    // Compute and insert field profiles
    if (createdFields && createdFields.length > 0) {
      const profiles = createdFields.map((field) => {
        const fieldValues = rows.map((r) => r[field.name])
        const nonNull = fieldValues.filter((v) => v !== '' && v !== null && v !== undefined)
        const uniqueSet = new Set(nonNull)
        const sorted = [...nonNull].sort()

        return {
          field_id: field.id,
          total_rows: rows.length,
          null_count: rows.length - nonNull.length,
          null_percentage: +((((rows.length - nonNull.length) / rows.length) * 100).toFixed(2)),
          cardinality: uniqueSet.size,
          unique_percentage:
            nonNull.length > 0 ? +((uniqueSet.size / nonNull.length) * 100).toFixed(2) : 0,
          format_issues_count: 0,
          min_value: sorted[0] ?? null,
          max_value: sorted[sorted.length - 1] ?? null,
          sample_values: [...uniqueSet].slice(0, 10),
        }
      })
      await supabase.from('field_profiles').insert(profiles)
    }

    return {
      success: true,
      tableId,
      fieldCount: inferredFields.length,
      rowCount: rows.length,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unexpected error occurred',
    }
  }
}

// ─── Schema inference helpers ──────────────────────────────────────────────

function inferColumnType(
  name: string,
  values: string[]
): { dataType: string; inferredType: string | null } {
  const lower = name.toLowerCase()

  if (values.length === 0) return { dataType: 'VARCHAR(255)', inferredType: null }

  // Email
  if (lower.includes('email') || values.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) {
    return { dataType: 'VARCHAR(255)', inferredType: 'email' }
  }

  // Boolean
  const boolSet = new Set(['true', 'false', '0', '1', 'yes', 'no', 'y', 'n'])
  if (values.every((v) => boolSet.has(v.toLowerCase()))) {
    return { dataType: 'BOOLEAN', inferredType: null }
  }

  // Integer (no decimals)
  if (values.every((v) => /^-?\d+$/.test(v))) {
    const isCurrency =
      lower.includes('price') ||
      lower.includes('amount') ||
      lower.includes('revenue') ||
      lower.includes('salary') ||
      lower.includes('cost')
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
      lower.includes('cost')
    return {
      dataType: 'DECIMAL(18,2)',
      inferredType: isCurrency ? 'currency' : null,
    }
  }

  // Date / Timestamp
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}$/,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    /^\d{1,2}\/\d{1,2}\/\d{4}$/,
    /^\d{1,2}-\d{1,2}-\d{4}$/,
  ]
  if (values.some((v) => datePatterns.some((p) => p.test(v)))) {
    const hasTime = values.some((v) => /T\d{2}:\d{2}/.test(v) || /\d{2}:\d{2}:\d{2}/.test(v))
    return { dataType: hasTime ? 'TIMESTAMP' : 'DATE', inferredType: null }
  }

  // Phone
  if (lower.includes('phone') || lower.includes('mobile') || lower.includes('fax')) {
    return { dataType: 'VARCHAR(50)', inferredType: 'phone' }
  }

  // URL
  if (lower.includes('url') || lower.includes('website') || values.some((v) => v.startsWith('http'))) {
    return { dataType: 'VARCHAR(2048)', inferredType: 'url' }
  }

  // Default: VARCHAR sized to max observed length
  const maxLen = Math.max(...values.map((v) => v.length), 1)
  const roundedLen = Math.min(4096, Math.max(50, Math.ceil(maxLen / 50) * 50))
  return { dataType: `VARCHAR(${roundedLen})`, inferredType: null }
}

function isPKName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'id' || lower.endsWith('_id') || lower === 'pk' || lower === 'key'
}

function isFKName(name: string): boolean {
  const lower = name.toLowerCase()
  return (lower.endsWith('_id') || lower.endsWith('id')) && lower !== 'id'
}

function sanitizeRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    // Neutralize CSV formula injection (Excel/Sheets attack vector)
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) {
      out[key] = "'" + value
    } else {
      out[key] = value
    }
  }
  return out
}
