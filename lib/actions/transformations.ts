'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { getSchemaDocumentContext, formatDocumentContextForPrompt } from '@/lib/ai/document-context'
import { fieldNeedsTransform, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import type { Transformation } from '@/lib/types/database'

export { fieldNeedsTransform, wrapFieldRefsInJsonb }

// ── Shared types ──────────────────────────────────────────────────────────────

export interface FieldItem {
  fieldMappingId: string
  sourceFieldId: string
  sourceFieldName: string
  sourceFieldDataType: string
  sourceFieldInferredType: string | null
  sourceFieldIsNullable: boolean
  targetFieldId: string
  targetFieldName: string
  targetFieldDataType: string
  targetFieldInferredType: string | null
  targetFieldIsNullable: boolean
  sourceTableId: string
  typeCompatibility: string | null
  confidence: number | null
  sampleValues: unknown[]
  cardinality: number
  needsTransform: boolean
  transformation: Transformation | null
}

export interface TableGroup {
  tableMappingId: string
  sourceTableId: string
  sourceTableName: string
  targetTableName: string
  fields: FieldItem[]
}

export interface DatasetGroup {
  datasetId: string
  datasetName: string
  tables: TableGroup[]
}

export interface TransformPageData {
  datasets: DatasetGroup[]
  schemaDocText: string
  hasMappings: boolean
}

// ── getTransformData ──────────────────────────────────────────────────────────

export async function getTransformData(
  projectId: string
): Promise<TransformPageData> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { datasets: [], schemaDocText: '', hasMappings: false }

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { datasets: [], schemaDocText: '', hasMappings: false }

  // 1. Table mappings (non-rejected)
  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) {
    return { datasets: [], schemaDocText: '', hasMappings: false }
  }

  const tmIds = tms.map((tm) => tm.id)
  const allTableIds = [
    ...new Set([
      ...tms.map((tm) => tm.source_table_id),
      ...tms.map((tm) => tm.target_table_id),
    ]),
  ]

  // 2. Tables with dataset info, field_mappings, source/target fields, profiles, transformations
  const [
    { data: tables },
    { data: fieldMappings },
  ] = await Promise.all([
    supabase
      .from('tables')
      .select('id, name, dataset_id, datasets(id, name, role)')
      .in('id', allTableIds),
    supabase
      .from('field_mappings')
      .select('id, table_mapping_id, source_field_id, target_field_id, type_compatibility, confidence')
      .in('table_mapping_id', tmIds)
      .neq('status', 'rejected'),
  ])

  if (!fieldMappings || fieldMappings.length === 0) {
    return { datasets: [], schemaDocText: '', hasMappings: true }
  }

  const allSourceFieldIds = fieldMappings.map((fm) => fm.source_field_id)
  const allTargetFieldIds = fieldMappings.map((fm) => fm.target_field_id)
  const allFieldMappingIds = fieldMappings.map((fm) => fm.id)

  // 3. Fields, profiles, transformations
  const [
    { data: sourceFields },
    { data: targetFields },
    { data: fieldProfiles },
    { data: transformations },
  ] = await Promise.all([
    supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable, table_id')
      .in('id', allSourceFieldIds),
    supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable')
      .in('id', allTargetFieldIds),
    supabase
      .from('field_profiles')
      .select('field_id, sample_values, cardinality')
      .in('field_id', allSourceFieldIds),
    supabase
      .from('transformations')
      .select('*')
      .in('field_mapping_id', allFieldMappingIds),
  ])

  // 4. Schema documents for context
  const allDatasetIds = [
    ...new Set((tables ?? []).map((t) => t.dataset_id)),
  ]
  const { data: schemaDocs } = await supabase
    .from('schema_documents')
    .select('extracted_text')
    .in('dataset_id', allDatasetIds)
    .not('extracted_text', 'is', null)

  const schemaDocText = schemaDocs
    ?.map((d) => d.extracted_text ?? '')
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000) ?? ''

  // ── Index lookups ─────────────────────────────────────────────────────────
  const tableById = new Map((tables ?? []).map((t) => [t.id, t]))
  const srcFieldById = new Map((sourceFields ?? []).map((f) => [f.id, f]))
  const tgtFieldById = new Map((targetFields ?? []).map((f) => [f.id, f]))
  const profileByFieldId = new Map(
    (fieldProfiles ?? []).map((p) => [p.field_id, p])
  )
  const transformByFMId = new Map(
    (transformations ?? []).map((tr) => [tr.field_mapping_id, tr as Transformation])
  )
  const fmsByTmId = new Map<string, typeof fieldMappings>()
  for (const fm of fieldMappings) {
    const arr = fmsByTmId.get(fm.table_mapping_id) ?? []
    arr.push(fm)
    fmsByTmId.set(fm.table_mapping_id, arr)
  }

  // ── Group: dataset → table → fields ───────────────────────────────────────
  const datasetGroupMap = new Map<string, DatasetGroup>()

  for (const tm of tms) {
    const srcTable = tableById.get(tm.source_table_id)
    const tgtTable = tableById.get(tm.target_table_id)
    if (!srcTable || !tgtTable) continue

    const dataset = (srcTable.datasets as unknown as { id: string; name: string; role: string } | null)
    if (!dataset) continue

    // Only process source dataset groups (we group by source)
    if (dataset.role !== 'source') continue

    let dsGroup = datasetGroupMap.get(dataset.id)
    if (!dsGroup) {
      dsGroup = { datasetId: dataset.id, datasetName: dataset.name, tables: [] }
      datasetGroupMap.set(dataset.id, dsGroup)
    }

    const fms = fmsByTmId.get(tm.id) ?? []
    const fields: FieldItem[] = []

    for (const fm of fms) {
      const srcField = srcFieldById.get(fm.source_field_id)
      const tgtField = tgtFieldById.get(fm.target_field_id)
      if (!srcField || !tgtField) continue

      const profile = profileByFieldId.get(fm.source_field_id)
      const transformation = transformByFMId.get(fm.id) ?? null

      const needsTransform = fieldNeedsTransform({
        typeCompatibility: fm.type_compatibility,
        confidence: fm.confidence,
        sourceDataType: srcField.data_type,
        targetDataType: tgtField.data_type,
        sourceFieldName: srcField.name,
        targetFieldName: tgtField.name,
        hasTransformation: transformation !== null,
      })

      fields.push({
        fieldMappingId: fm.id,
        sourceFieldId: srcField.id,
        sourceFieldName: srcField.name,
        sourceFieldDataType: srcField.data_type,
        sourceFieldInferredType: srcField.inferred_type,
        sourceFieldIsNullable: srcField.is_nullable,
        targetFieldId: tgtField.id,
        targetFieldName: tgtField.name,
        targetFieldDataType: tgtField.data_type,
        targetFieldInferredType: tgtField.inferred_type,
        targetFieldIsNullable: tgtField.is_nullable,
        sourceTableId: srcField.table_id,
        typeCompatibility: fm.type_compatibility,
        confidence: fm.confidence,
        sampleValues: (profile?.sample_values as unknown[]) ?? [],
        cardinality: profile?.cardinality ?? 0,
        needsTransform,
        transformation,
      })
    }

    if (fields.length > 0) {
      dsGroup.tables.push({
        tableMappingId: tm.id,
        sourceTableId: tm.source_table_id,
        sourceTableName: srcTable.name,
        targetTableName: tgtTable.name,
        fields,
      })
    }
  }

  return {
    datasets: [...datasetGroupMap.values()],
    schemaDocText,
    hasMappings: true,
  }
}

// ── Claude system prompt ──────────────────────────────────────────────────────

const TRANSFORM_SYSTEM_PROMPT = `You are a SQL transformation expert for enterprise data migrations.
Given a source field, target field, their schemas, sample data, and a natural language description of the desired transformation, generate the SQL transformation expression.

CRITICAL RULES:
1. Output ONLY the SQL expression (CASE statement, function call, type cast, string operation, etc.)
2. Do NOT output a full SELECT, UPDATE, or INSERT statement
3. Do NOT include semicolons
4. Do NOT include column aliases (no AS clause at the top level)
5. The expression will be embedded inside: SELECT {your_expression} AS "target_field" FROM ...
6. Use ONLY the bare field name without any table prefix — write "Region", NOT "Sales.Region"; write "Type", NOT "Account.Type". The system handles table context automatically.
7. Handle NULL values explicitly when relevant using COALESCE or CASE WHEN ... IS NULL
8. Handle edge cases (unexpected values) with an ELSE clause in CASE statements
9. Be precise — map actual sample values from the data, not generic patterns
10. Do NOT use window functions (ROW_NUMBER, RANK, etc.) — they are not allowed in expressions

Common transformation patterns:
- Value mapping: CASE WHEN field = 'X' THEN 'Y' WHEN field = 'Z' THEN 'W' ELSE 'OTHER' END
- Type casting: field::integer, field::date, field::numeric
- String operations: UPPER(field), LOWER(field), TRIM(field), LEFT(field, 10)
- Concatenation: field1 || '-' || field2
- Null handling: COALESCE(field, 'default')
- Date formatting: TO_CHAR(field::date, 'YYYY-MM-DD')
- Substring: SUBSTRING(field FROM 1 FOR 10)
- Regex replace: REGEXP_REPLACE(field, 'pattern', 'replacement')
- Hash: MD5(field)
- Truncation: LEFT(field, 10) or SUBSTRING(field FROM 1 FOR 10)

If documentation is provided, follow the exact value mappings and transformation rules specified in the business rules. Do not invent mappings that contradict the documentation. If the documentation specifies edge cases or special handling, include them in the expression.`

// ── generateTransform ─────────────────────────────────────────────────────────

export async function generateTransform(
  fieldMappingId: string,
  description: string
): Promise<{ success: boolean; sql?: string; transformationId?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Rate limit
  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  if (!description.trim()) return { success: false, error: 'Description is required' }

  // Fetch field mapping with context
  const { data: fm } = await supabase
    .from('field_mappings')
    .select('id, source_field_id, target_field_id, type_compatibility, confidence, table_mapping_id')
    .eq('id', fieldMappingId)
    .single()
  if (!fm) return { success: false, error: 'Field mapping not found' }

  // Verify ownership through table_mapping → project
  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', fm.table_mapping_id)
    .single()
  if (!tm) return { success: false, error: 'Mapping not found' }

  const { data: projectCheck } = await supabase
    .from('projects')
    .select('id')
    .eq('id', tm.project_id)
    .eq('user_id', user.id)
    .single()
  if (!projectCheck) return { success: false, error: 'Access denied' }

  // Fetch fields
  const [{ data: srcField }, { data: tgtField }] = await Promise.all([
    supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable, table_id')
      .eq('id', fm.source_field_id)
      .single(),
    supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable')
      .eq('id', fm.target_field_id)
      .single(),
  ])
  if (!srcField || !tgtField) return { success: false, error: 'Fields not found' }

  // Fetch tables
  const [{ data: srcTable }, { data: tgtTable }] = await Promise.all([
    supabase.from('tables').select('id, name, datasets(id, name)').eq('id', tm.source_table_id).single(),
    supabase.from('tables').select('id, name').eq('id', tm.target_table_id).single(),
  ])

  // Fetch field profile for sample values
  const { data: profile } = await supabase
    .from('field_profiles')
    .select('sample_values, cardinality')
    .eq('field_id', srcField.id)
    .single()

  // Fetch schema document context (source + target docs, up to 15k chars each)
  const transformDocBlock = formatDocumentContextForPrompt(
    await getSchemaDocumentContext(tm.project_id)
  )

  const srcDatasetName = (srcTable?.datasets as unknown as { name: string } | null)?.name ?? ''
  const tgtTableName = tgtTable?.name ?? ''
  const sampleValues = (profile?.sample_values as unknown[]) ?? []

  // Build user message
  const userMessage = `<source_field>
Field: ${srcTable?.name ?? ''}.${srcField.name}
Type: ${srcField.data_type}${srcField.inferred_type ? ` (${srcField.inferred_type})` : ''}
Nullable: ${srcField.is_nullable}
Sample values: ${sampleValues.length > 0 ? sampleValues.slice(0, 15).join(', ') : 'none available'}
Distinct value count: ${profile?.cardinality ?? 'unknown'}
</source_field>

<target_field>
Field: ${tgtTableName}.${tgtField.name}
Type: ${tgtField.data_type}${tgtField.inferred_type ? ` (${tgtField.inferred_type})` : ''}
Nullable: ${tgtField.is_nullable}
</target_field>

<type_compatibility>
${fm.type_compatibility ?? 'Not specified'}
</type_compatibility>
${transformDocBlock}
<description>
${description}
</description>

Generate the SQL transformation expression.`

  let rawSql: string
  try {
    rawSql = await callClaude(TRANSFORM_SYSTEM_PROMPT, userMessage, 1024)
  } catch (err) {
    return { success: false, error: 'AI generation failed. Please try again.' }
  }

  // Clean the response: strip markdown fences, trim, remove trailing semicolons
  let sql = rawSql.trim()
  if (sql.startsWith('```')) {
    sql = sql.replace(/^```(?:sql)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  sql = sql.replace(/;+$/, '').trim()

  if (!sql) return { success: false, error: 'AI returned empty SQL. Please try again.' }

  // Store or update the transformation record
  const { data: existing } = await supabase
    .from('transformations')
    .select('id')
    .eq('field_mapping_id', fieldMappingId)
    .single()

  let transformationId: string

  if (existing) {
    const { error: updateErr } = await supabase
      .from('transformations')
      .update({
        description: description.trim(),
        generated_sql: sql,
        is_ai_generated: true,
        status: 'draft',
        test_results: null,
      })
      .eq('id', existing.id)
    if (updateErr) return { success: false, error: 'Failed to save transformation' }
    transformationId = existing.id
  } else {
    const { data: created, error: insertErr } = await supabase
      .from('transformations')
      .insert({
        field_mapping_id: fieldMappingId,
        description: description.trim(),
        generated_sql: sql,
        is_ai_generated: true,
        status: 'draft',
        test_results: null,
      })
      .select('id')
      .single()
    if (insertErr || !created) return { success: false, error: 'Failed to save transformation' }
    transformationId = created.id
  }

  return { success: true, sql, transformationId }
}

// ── updateTransformSQL ────────────────────────────────────────────────────────

export async function updateTransformSQL(
  transformationId: string,
  sql: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const cleanSql = sql.replace(/;+$/, '').trim()
  if (!cleanSql) return { success: false, error: 'SQL cannot be empty' }

  // Check current status — if applied, mark as stale instead of draft
  const { data: current } = await supabase
    .from('transformations')
    .select('status')
    .eq('id', transformationId)
    .single()

  const newStatus = current?.status === 'applied' ? 'stale' : 'draft'

  const { error } = await supabase
    .from('transformations')
    .update({
      generated_sql: cleanSql,
      is_ai_generated: false,
      status: newStatus,
      test_results: null,
    })
    .eq('id', transformationId)

  if (error) return { success: false, error: 'Failed to update SQL' }
  return { success: true }
}

// ── testTransformation ────────────────────────────────────────────────────────

export async function testTransformation(
  fieldMappingId: string,
  sql: string
): Promise<{
  success: boolean
  results?: { before: string | null; after: string | null }[]
  transformationId?: string
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  if (!sql.trim()) return { success: false, error: 'No SQL to test' }

  // Fetch field mapping with ownership chain
  const { data: fm } = await supabase
    .from('field_mappings')
    .select('id, source_field_id, target_field_id, table_mapping_id')
    .eq('id', fieldMappingId)
    .single()
  if (!fm) return { success: false, error: 'Field mapping not found' }

  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id')
    .eq('id', fm.table_mapping_id)
    .single()
  if (!tm) return { success: false, error: 'Table mapping not found' }

  const { data: projectCheck } = await supabase
    .from('projects')
    .select('id')
    .eq('id', tm.project_id)
    .eq('user_id', user.id)
    .single()
  if (!projectCheck) return { success: false, error: 'Access denied' }

  // Get source field info
  const { data: srcField } = await supabase
    .from('fields')
    .select('id, name, table_id')
    .eq('id', fm.source_field_id)
    .single()
  if (!srcField) return { success: false, error: 'Source field not found' }

  // Get all field names in source table for JSONB wrapping
  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', srcField.table_id)

  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  // Wrap bare field refs with JSONB access
  const wrappedSql = wrapFieldRefsInJsonb(sql.trim(), fieldNames)

  // Execute via RPC — uses supabaseAdmin since execute_transform_test is SECURITY DEFINER
  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
    'execute_transform_test',
    {
      p_expression: wrappedSql,
      p_table_id: srcField.table_id,
      p_source_field: srcField.name,
      p_limit: 20,
    }
  )

  if (rpcErr) {
    // Return the database error message — it's safe and useful for debugging
    return { success: false, error: rpcErr.message }
  }

  const rows = (rpcResult as { before_value: unknown; after_value: unknown }[]) ?? []
  const results = rows.map((r) => ({
    before: r.before_value != null ? String(r.before_value) : null,
    after: r.after_value != null ? String(r.after_value) : null,
  }))

  // Update the transformation record with test results and status
  const { data: existing } = await supabase
    .from('transformations')
    .select('id')
    .eq('field_mapping_id', fieldMappingId)
    .single()

  let transformationId: string | undefined

  if (existing) {
    await supabase
      .from('transformations')
      .update({ status: 'tested', test_results: results })
      .eq('id', existing.id)
    transformationId = existing.id
  }

  return { success: true, results, transformationId }
}

// ── saveTransformation ────────────────────────────────────────────────────────

export async function saveTransformation(
  transformationId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase
    .from('transformations')
    .update({ status: 'saved' })
    .eq('id', transformationId)

  if (error) return { success: false, error: 'Failed to save transformation' }
  return { success: true }
}

// ── autoGenerateAllTransforms ─────────────────────────────────────────────────

export async function autoGenerateAllTransforms(
  projectId: string
): Promise<{
  success: boolean
  generated: number
  failed: number
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, generated: 0, failed: 0, error: 'Not authenticated' }

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { success: false, generated: 0, failed: 0, error: 'Project not found' }

  // Get transform data to find flagged fields without transforms
  const pageData = await getTransformData(projectId)
  if (!pageData.hasMappings) {
    return { success: true, generated: 0, failed: 0 }
  }

  // Collect all field items that need transformation but don't have one
  const targets: FieldItem[] = []
  for (const ds of pageData.datasets) {
    for (const tbl of ds.tables) {
      for (const field of tbl.fields) {
        if (field.needsTransform && !field.transformation) {
          targets.push(field)
        }
      }
    }
  }

  if (targets.length === 0) {
    return { success: true, generated: 0, failed: 0 }
  }

  let generated = 0
  let failed = 0

  for (const field of targets) {
    // Auto-generate a description based on available context
    const autoDesc = field.typeCompatibility
      ? `Transform ${field.sourceFieldName} to ${field.targetFieldName}: ${field.typeCompatibility}`
      : `Map ${field.sourceFieldName} (${field.sourceFieldDataType}) to ${field.targetFieldName} (${field.targetFieldDataType})`

    const result = await generateTransform(field.fieldMappingId, autoDesc)
    if (result.success) {
      generated++
    } else {
      failed++
    }
  }

  return { success: true, generated, failed }
}

// ── applyTransform ────────────────────────────────────────────────────────────
// Applies a single field's transform to staged_data_rows via the
// dq_apply_field_transform RPC. Creates staged rows if none exist for the
// table mapping yet (incremental staging).

export async function applyTransform(
  fieldMappingId: string,
  sql: string
): Promise<{ success: boolean; rowsAffected: number; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, rowsAffected: 0, error: 'Not authenticated' }

  if (!sql.trim()) return { success: false, rowsAffected: 0, error: 'No SQL to apply' }

  // Resolve ownership chain
  const { data: fm } = await supabase
    .from('field_mappings')
    .select('id, source_field_id, target_field_id, table_mapping_id')
    .eq('id', fieldMappingId)
    .single()
  if (!fm) return { success: false, rowsAffected: 0, error: 'Field mapping not found' }

  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', fm.table_mapping_id)
    .single()
  if (!tm) return { success: false, rowsAffected: 0, error: 'Table mapping not found' }

  const { data: projectCheck } = await supabase
    .from('projects')
    .select('id')
    .eq('id', tm.project_id)
    .eq('user_id', user.id)
    .single()
  if (!projectCheck) return { success: false, rowsAffected: 0, error: 'Access denied' }

  // Fetch source and target field names
  const [{ data: srcField }, { data: tgtField }] = await Promise.all([
    supabase.from('fields').select('id, name, table_id').eq('id', fm.source_field_id).single(),
    supabase.from('fields').select('id, name').eq('id', fm.target_field_id).single(),
  ])
  if (!srcField || !tgtField) {
    return { success: false, rowsAffected: 0, error: 'Fields not found' }
  }

  // All source field names for JSONB rewriting
  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', srcField.table_id)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(sql.replace(/;+$/, '').trim(), fieldNames)

  // Check if staged rows already exist for this table mapping
  const { count: stagedCount } = await supabaseAdmin
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .eq('table_mapping_id', tm.id)

  const hasExistingStaged = (stagedCount ?? 0) > 0

  // Execute via RPC
  const { data: rowsAffected, error: rpcErr } = await supabaseAdmin.rpc(
    'dq_apply_field_transform',
    {
      p_table_mapping_id: tm.id,
      p_source_table_id: tm.source_table_id,
      p_target_table_id: tm.target_table_id,
      p_target_field_name: tgtField.name,
      p_transform_sql: wrappedSql,
      p_has_existing_staged: hasExistingStaged,
    }
  )

  if (rpcErr) {
    return { success: false, rowsAffected: 0, error: rpcErr.message }
  }

  // Mark this transformation as applied
  await supabase
    .from('transformations')
    .update({ status: 'applied' })
    .eq('field_mapping_id', fieldMappingId)

  return { success: true, rowsAffected: Number(rowsAffected ?? 0) }
}

// ── previewTransformDistinct ──────────────────────────────────────────────────
// Returns all distinct (before, after, count) triples for a SQL expression.
// Used by the "All Distinct Values" toggle in the live preview panel.

export async function previewTransformDistinct(
  fieldMappingId: string,
  sql: string
): Promise<{
  success: boolean
  results?: { before: string | null; after: string | null; count: number }[]
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  if (!sql.trim()) return { success: false, error: 'No SQL to preview' }

  const { data: fm } = await supabase
    .from('field_mappings')
    .select('id, source_field_id, table_mapping_id')
    .eq('id', fieldMappingId)
    .single()
  if (!fm) return { success: false, error: 'Field mapping not found' }

  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id')
    .eq('id', fm.table_mapping_id)
    .single()
  if (!tm) return { success: false, error: 'Table mapping not found' }

  const { data: projectCheck } = await supabase
    .from('projects')
    .select('id')
    .eq('id', tm.project_id)
    .eq('user_id', user.id)
    .single()
  if (!projectCheck) return { success: false, error: 'Access denied' }

  const { data: srcField } = await supabase
    .from('fields')
    .select('id, name, table_id')
    .eq('id', fm.source_field_id)
    .single()
  if (!srcField) return { success: false, error: 'Source field not found' }

  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', srcField.table_id)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(sql.replace(/;+$/, '').trim(), fieldNames)

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
    'execute_transform_test_distinct',
    {
      p_expression: wrappedSql,
      p_table_id: srcField.table_id,
      p_source_field: srcField.name,
      p_limit: 200,
    }
  )

  if (rpcErr) {
    return { success: false, error: rpcErr.message }
  }

  const rows = (rpcResult as { before_value: unknown; after_value: unknown; row_count: number }[]) ?? []
  const results = rows.map((r) => ({
    before: r.before_value != null ? String(r.before_value) : null,
    after: r.after_value != null ? String(r.after_value) : null,
    count: r.row_count ?? 0,
  }))

  return { success: true, results }
}
