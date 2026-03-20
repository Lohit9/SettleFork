'use server'

import { createClient } from '@/lib/supabase/server'
import { parseDDL, parseDDLWithAI } from '@/lib/parsers/ddl-parser'
import type { ParsedTable } from '@/lib/parsers/ddl-parser'
import { computeFriendlyName } from '@/lib/db/sql-rewriter'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'

export type { ParsedTable }

// ── parseDDLFile ──────────────────────────────────────────────────────────────
// Step 1: read file, parse DDL, return parsed tables for user review.
// Does NOT write to the database — that happens in confirmDDLSchema.

export async function parseDDLFile(
  formData: FormData
): Promise<{
  success: boolean
  tables?: ParsedTable[]
  usedAI?: boolean
  ddlContent?: string
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const file = formData.get('file') as File | null
  const projectId = formData.get('projectId') as string
  const datasetId = formData.get('datasetId') as string

  if (!file || !projectId || !datasetId) {
    return { success: false, error: 'Missing required fields' }
  }

  // Validate file type
  const filename = file.name.toLowerCase()
  if (!filename.endsWith('.sql') && !filename.endsWith('.ddl') && !filename.endsWith('.txt')) {
    return { success: false, error: 'Accepted file types: .sql, .ddl, .txt' }
  }

  // Max 2 MB for DDL files (they're text, should be well under this)
  if (file.size > 2 * 1024 * 1024) {
    return { success: false, error: 'DDL file must be under 2 MB' }
  }

  // Verify dataset ownership via RLS
  const { data: dataset } = await supabase
    .from('datasets')
    .select('id, name')
    .eq('id', datasetId)
    .eq('project_id', projectId)
    .maybeSingle()

  if (!dataset) {
    return { success: false, error: 'Dataset not found or access denied' }
  }

  const ddlContent = (await file.text()).trim()
  if (!ddlContent) {
    return { success: false, error: 'File is empty' }
  }

  // ── Deterministic parse first ─────────────────────────────────────────────
  let tables = parseDDL(ddlContent)
  let usedAI = false

  // ── AI fallback if deterministic parser found nothing ────────────────────
  if (tables.length === 0) {
    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) {
      return {
        success: false,
        error:
          'Deterministic parser found no CREATE TABLE statements. ' +
          'AI fallback is rate limited — try again later or check the DDL format.',
      }
    }

    try {
      tables = await parseDDLWithAI(ddlContent)
      usedAI = true
    } catch {
      return {
        success: false,
        error:
          'Could not parse DDL — no CREATE TABLE statements found, and the AI fallback failed. ' +
          'Ensure the file contains standard CREATE TABLE syntax.',
      }
    }
  }

  if (tables.length === 0) {
    return {
      success: false,
      error: 'No CREATE TABLE definitions found in the uploaded file.',
    }
  }

  return { success: true, tables, usedAI, ddlContent }
}

// ── confirmDDLSchema ──────────────────────────────────────────────────────────
// Step 2: save the reviewed (and possibly edited) parsed tables to the database.
// Creates tables + fields records. No data_rows (schema-only).
// Stores original DDL text in schema_documents.

export async function confirmDDLSchema(
  projectId: string,
  role: 'source' | 'target',
  datasetId: string,
  tables: ParsedTable[],
  ddlContent: string,
  filename: string
): Promise<{ success: boolean; tableCount?: number; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify dataset ownership + get name
  const { data: dataset } = await supabase
    .from('datasets')
    .select('id, name')
    .eq('id', datasetId)
    .eq('project_id', projectId)
    .maybeSingle()

  if (!dataset) return { success: false, error: 'Dataset not found or access denied' }

  if (tables.length === 0) return { success: false, error: 'No tables to save' }

  let tableCount = 0

  for (const parsedTable of tables) {
    if (!parsedTable.name || parsedTable.fields.length === 0) continue

    const friendlyName = computeFriendlyName(dataset.name, parsedTable.name)

    // Delete existing table with same name (clean re-upload)
    const { data: existing } = await supabase
      .from('tables')
      .select('id')
      .eq('dataset_id', datasetId)
      .eq('name', parsedTable.name)
      .maybeSingle()

    if (existing) {
      // Cascade-delete cleans fields, data_rows, field_profiles
      await supabase.from('tables').delete().eq('id', existing.id)
    }

    // Create table record (row_count=0 — schema only, no data)
    const { data: newTable, error: tableErr } = await supabase
      .from('tables')
      .insert({
        dataset_id: datasetId,
        name: parsedTable.name,
        row_count: 0,
        friendly_name: friendlyName,
        csv_storage_path: null,
      })
      .select()
      .single()

    if (tableErr || !newTable) {
      console.error('[confirmDDLSchema] table insert failed:', tableErr?.message)
      continue
    }

    // Build field records
    const fieldRecords = parsedTable.fields.map((f, idx) => ({
      table_id: newTable.id,
      name: f.name,
      data_type: f.dataType,
      inferred_type: inferBasicType(f.dataType),
      is_nullable: f.isNullable,
      is_primary_key: f.isPrimaryKey,
      is_foreign_key: f.isForeignKey,
      fk_reference: f.fkReference,
      ordinal_position: idx + 1,
    }))

    const { error: fieldsErr } = await supabase.from('fields').insert(fieldRecords)

    if (fieldsErr) {
      console.error('[confirmDDLSchema] fields insert failed:', fieldsErr.message)
      // Roll back the table record
      await supabase.from('tables').delete().eq('id', newTable.id)
      continue
    }

    tableCount++
  }

  if (tableCount === 0) {
    return { success: false, error: 'Failed to save any tables — check the console for details.' }
  }

  // Store original DDL as a schema document for AI context
  try {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const storagePath = `${user.id}/${projectId}/schemas/${sanitizedFilename}`

    const blob = new Blob([ddlContent], { type: 'text/plain' })
    await supabase.storage.from('project-files').upload(storagePath, blob, { upsert: true })

    await supabase.from('schema_documents').insert({
      dataset_id: datasetId,
      filename: sanitizedFilename,
      file_size: ddlContent.length,
      file_storage_path: storagePath,
      extracted_text: ddlContent,
    })
  } catch {
    // Non-fatal — schema is saved even if document record fails
  }

  return { success: true, tableCount }
}

// ── Helper: infer a basic type category from a DDL type string ────────────────

function inferBasicType(dataType: string): string | null {
  const upper = dataType.toUpperCase()
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|INT2|INT4|INT8|INT64|NUMBER\s*\(\s*\d+\s*,\s*0\s*\))/.test(upper)) return 'integer'
  if (/^(FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|NUMBER|MONEY|SMALLMONEY)/.test(upper)) return 'decimal'
  if (/^(VARCHAR|NVARCHAR|CHARACTER\s+VARYING|CHAR|NCHAR|TEXT|CLOB|STRING|LONGTEXT|MEDIUMTEXT|TINYTEXT)/.test(upper)) return 'string'
  if (/^(BOOLEAN|BOOL|BIT)/.test(upper)) return 'boolean'
  if (/^DATE$/.test(upper)) return 'date'
  if (/^(TIMESTAMP|DATETIME|DATETIME2|SMALLDATETIME)/.test(upper)) return 'datetime'
  if (/^(TIME)/.test(upper)) return 'string'
  return null
}
