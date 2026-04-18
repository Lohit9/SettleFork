'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseDDL, parseDDLWithAI } from '@/lib/parsers/ddl-parser'
import type { ParsedTable } from '@/lib/parsers/ddl-parser'
import { computeFriendlyName } from '@/lib/db/sql-rewriter'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { inferBasicType } from '@/lib/utils/infer-basic-type'

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

  // Accumulate (parsedTable, tableId, insertedFields) for validation rule seeding
  const seededTables: Array<{
    parsedTable: (typeof tables)[number]
    tableId: string
    fieldIdByName: Map<string, string>
  }> = []

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

    // Build field records — includes check_constraint from parsed DDL.
    // schema_source = 'ddl_parsed' because the metadata came from an
    // authoritative DDL script (not from sampling CSV values). Requires
    // migration 063 which expanded the schema_source CHECK constraint.
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
      check_constraint: f.checkConstraint ?? null,
      schema_source: 'ddl_parsed' as const,
    }))

    const { data: insertedFields, error: fieldsErr } = await supabase
      .from('fields')
      .insert(fieldRecords)
      .select('id, name')

    if (fieldsErr) {
      console.error('[confirmDDLSchema] fields insert failed:', fieldsErr.message)
      // Roll back the table record
      await supabase.from('tables').delete().eq('id', newTable.id)
      continue
    }

    // Build name → id map for validation rule seeding
    const fieldIdByName = new Map<string, string>(
      (insertedFields ?? []).map((f: { id: string; name: string }) => [f.name, f.id])
    )

    seededTables.push({ parsedTable, tableId: newTable.id, fieldIdByName })
    tableCount++
  }

  // ── Auto-seed validation rules from CHECK constraints ──────────────────────
  // Deduplication: don't insert rules we already created (handles re-uploads)
  const { data: existingRules } = await supabase
    .from('validation_rules')
    .select('name')
    .eq('project_id', projectId)
    .like('name', '%(from DDL)%')

  const existingRuleNames = new Set((existingRules ?? []).map((r: { name: string }) => r.name))

  const validationRuleInserts: Array<{
    project_id: string
    table_id: string
    field_id: string
    name: string
    rule_type: string
    rule_config: Record<string, unknown>
    severity: 'blocking'
    is_ai_generated: boolean
  }> = []

  // rule_config keys MUST match the shapes read by executeCustomRules and
  // validateRuleConfig in lib/actions/validation-rules.ts. Canonical shapes:
  //   allowed_values → { values: string[] }
  //   regex          → { pattern: string }
  //   range          → { min: number, max: number }
  //   min_value      → { min: number }
  //   max_value      → { max: number }
  // We insert directly (bypassing addValidationRule) because this is a bulk
  // seed, but that means any key drift here silently yields zero violations
  // at scan time. Update validation-rules.ts in lockstep if you change keys.
  for (const { parsedTable, tableId, fieldIdByName } of seededTables) {
    for (const field of parsedTable.fields) {
      const constraint = field.checkConstraint
      if (!constraint) continue

      const fieldId = fieldIdByName.get(field.name)
      if (!fieldId) continue

      if (constraint.type === 'in_list' && constraint.allowedValues.length > 0) {
        const ruleName = `${field.name}: allowed values (from DDL)`
        if (!existingRuleNames.has(ruleName)) {
          validationRuleInserts.push({
            project_id: projectId,
            table_id: tableId,
            field_id: fieldId,
            name: ruleName,
            rule_type: 'allowed_values',
            rule_config: { values: constraint.allowedValues },
            severity: 'blocking',
            is_ai_generated: false,
          })
        }
      }

      if (constraint.type === 'regex' && constraint.pattern) {
        const ruleName = `${field.name}: format validation (from DDL)`
        if (!existingRuleNames.has(ruleName)) {
          validationRuleInserts.push({
            project_id: projectId,
            table_id: tableId,
            field_id: fieldId,
            name: ruleName,
            rule_type: 'regex',
            rule_config: { pattern: constraint.pattern },
            severity: 'blocking',
            is_ai_generated: false,
          })
        }
      }

      if (constraint.type === 'range') {
        if (constraint.min !== undefined && constraint.max !== undefined) {
          const ruleName = `${field.name}: value range (from DDL)`
          if (!existingRuleNames.has(ruleName)) {
            validationRuleInserts.push({
              project_id: projectId,
              table_id: tableId,
              field_id: fieldId,
              name: ruleName,
              rule_type: 'range',
              rule_config: { min: constraint.min, max: constraint.max },
              severity: 'blocking',
              is_ai_generated: false,
            })
          }
        } else if (constraint.min !== undefined) {
          const ruleName = `${field.name}: minimum value (from DDL)`
          if (!existingRuleNames.has(ruleName)) {
            validationRuleInserts.push({
              project_id: projectId,
              table_id: tableId,
              field_id: fieldId,
              name: ruleName,
              rule_type: 'min_value',
              rule_config: { min: constraint.min },
              severity: 'blocking',
              is_ai_generated: false,
            })
          }
        } else if (constraint.max !== undefined) {
          const ruleName = `${field.name}: maximum value (from DDL)`
          if (!existingRuleNames.has(ruleName)) {
            validationRuleInserts.push({
              project_id: projectId,
              table_id: tableId,
              field_id: fieldId,
              name: ruleName,
              rule_type: 'max_value',
              rule_config: { max: constraint.max },
              severity: 'blocking',
              is_ai_generated: false,
            })
          }
        }
      }
    }
  }

  if (validationRuleInserts.length > 0) {
    const { error: rulesError } = await supabase
      .from('validation_rules')
      .insert(validationRuleInserts)

    if (rulesError) {
      console.error('[confirmDDLSchema] failed to auto-seed validation rules:', rulesError.message)
      // Non-blocking — DDL upload succeeds even if rule seeding fails
    } else {
      console.log(`[confirmDDLSchema] auto-seeded ${validationRuleInserts.length} validation rules from CHECK constraints`)
    }
  }

  if (tableCount === 0) {
    return { success: false, error: 'Failed to save any tables — check the console for details.' }
  }

  // ── Cross-table FK inference ───────────────────────────────────────────────
  // All tables for this dataset have now been inserted in one transactional
  // batch, so this is the natural single "done" point to scan for implicit
  // FK relationships between them. Only fields with schema_source='inferred'
  // are touched, so DDL-declared FKs (schema_source='ddl_parsed') remain
  // authoritative. Non-fatal — detection and execution still function on the
  // explicit DDL FKs if this fails.
  try {
    const { inferCrossTableFKs } = await import('@/lib/quality/fk-inference')
    const result = await inferCrossTableFKs(projectId, datasetId)
    if (result.inferred.length > 0) {
      console.log(`[confirmDDLSchema] FK inference added ${result.inferred.length} cross-table FK(s)`)
    }
    if (result.errors.length > 0) {
      console.warn('[confirmDDLSchema] FK inference completed with errors:', result.errors)
    }
  } catch (inferErr) {
    console.warn('[confirmDDLSchema] FK inference failed (non-fatal):', inferErr)
  }

  // Store original DDL as a schema document for AI context
  try {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    const storagePath = `${user.id}/${projectId}/schemas/${sanitizedFilename}`

    const blob = new Blob([ddlContent], { type: 'text/plain' })
    await supabase.storage.from('project-files').upload(storagePath, blob, { upsert: true })

    // Replace any existing document with the same filename — delete-before-insert
    const { data: existingDoc } = await supabase
      .from('schema_documents')
      .select('id')
      .eq('dataset_id', datasetId)
      .eq('filename', sanitizedFilename)
      .maybeSingle()

    if (existingDoc) {
      await supabase.from('schema_documents').delete().eq('id', existingDoc.id)
      console.log(`[confirmDDLSchema] Replacing existing DDL document: ${sanitizedFilename}`)
    }

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

  // Invalidate the project subtree cache so navigating back to any tab shows fresh data
  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, tableCount }
}

