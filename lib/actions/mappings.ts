'use server'

import { createClient } from '@/lib/supabase/server'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { getSchemaDocumentContext, formatDocumentContextForPrompt } from '@/lib/ai/document-context'

// ─── Claude Response Types ─────────────────────────────────────────────────────

interface ClaudeFieldMapping {
  source_field: string
  target_field: string
  confidence: number
  reasoning: string
  similar_fields_considered?: string[]
  type_compatibility?: string
  needs_transformation?: boolean
}

interface ClaudeTableMapping {
  source_table: string
  target_table: string
  confidence: number
  reasoning: string
  field_mappings: ClaudeFieldMapping[]
}

interface ClaudeResponse {
  table_mappings: ClaudeTableMapping[]
}

// ─── Rich Types for getMappings ────────────────────────────────────────────────

export interface RichFieldMapping {
  id: string
  table_mapping_id: string
  source_field_id: string
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  similar_fields_considered: string[] | null
  type_compatibility: string | null
  created_at: string
  sourceField: { id: string; name: string; data_type: string; inferred_type: string | null } | null
  targetField: { id: string; name: string; data_type: string; inferred_type: string | null } | null
  sourceFieldSamples: string[]
  targetFieldSamples: string[]
}

export interface RichTableMapping {
  id: string
  project_id: string
  source_table_id: string
  target_table_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  created_at: string
  sourceTable: { id: string; name: string; dataset: { id: string; name: string; role: string } } | null
  targetTable: { id: string; name: string; dataset: { id: string; name: string; role: string } } | null
  fieldMappings: RichFieldMapping[]
}

export interface UnmappedField {
  id: string
  name: string
  data_type: string
  table_id: string
  table: { id: string; name: string } | null
}

export interface SimpleField {
  id: string
  name: string
  data_type: string
}

export interface MappingsResult {
  tableMappings: RichTableMapping[]
  unmappedSourceFields: UnmappedField[]
  unmappedTargetFields: UnmappedField[]
  allSourceTables: { id: string; name: string; datasetName: string }[]
  allTargetTables: { id: string; name: string; datasetName: string }[]
  /** All fields for every table in the project, keyed by table_id */
  allFieldsByTable: Record<string, SimpleField[]>
}

// ─── Helper: parse Claude JSON with fence stripping ───────────────────────────

function parseClaudeJSON(raw: string): ClaudeResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  const parsed = JSON.parse(cleaned)
  if (!parsed.table_mappings || !Array.isArray(parsed.table_mappings)) {
    throw new Error('Invalid response: missing table_mappings array')
  }
  return parsed as ClaudeResponse
}

// ─── generateMappings ─────────────────────────────────────────────────────────

export async function generateMappings(
  projectId: string,
  sourceTableIds: string[],
  targetTableIds: string[]
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { success: false, error: 'Project not found' }

  // Rate limit check
  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  if (!sourceTableIds.length || !targetTableIds.length) {
    return { success: false, error: 'Select at least one source and one target table' }
  }

  try {
    // Fetch source tables
    const { data: sourceTables, error: stErr } = await supabase
      .from('tables')
      .select('id, name, dataset_id, datasets(id, name)')
      .in('id', sourceTableIds)
    if (stErr) throw stErr

    const { data: targetTables, error: ttErr } = await supabase
      .from('tables')
      .select('id, name, dataset_id, datasets(id, name)')
      .in('id', targetTableIds)
    if (ttErr) throw ttErr

    // Fetch fields
    const { data: sourceFields, error: sfErr } = await supabase
      .from('fields')
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key')
      .in('table_id', sourceTableIds)
      .order('ordinal_position', { ascending: true })
    if (sfErr) throw sfErr

    const { data: targetFields, error: tfErr } = await supabase
      .from('fields')
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key')
      .in('table_id', targetTableIds)
      .order('ordinal_position', { ascending: true })
    if (tfErr) throw tfErr

    // Fetch field profiles for sample values
    const allFieldIds = [
      ...(sourceFields ?? []).map((f) => f.id),
      ...(targetFields ?? []).map((f) => f.id),
    ]
    const { data: fieldProfiles } = await supabase
      .from('field_profiles')
      .select('field_id, sample_values')
      .in('field_id', allFieldIds)

    const profileByFieldId = new Map(fieldProfiles?.map((p) => [p.field_id, p]) ?? [])

    // Fetch schema document context (source + target docs, up to 15k chars each)
    const docContext = await getSchemaDocumentContext(projectId)
    const docBlock = formatDocumentContextForPrompt(docContext)

    // Build schema section string
    function buildSchemaSection(
      tables: NonNullable<typeof sourceTables>,
      fields: NonNullable<typeof sourceFields>
    ): string {
      return tables
        .map((table) => {
          const tableFields = fields.filter((f) => f.table_id === table.id)
          const rawDs = table.datasets as unknown
          const datasetName = Array.isArray(rawDs)
            ? ((rawDs[0] as { name?: string })?.name ?? 'unknown')
            : ((rawDs as { name?: string } | null)?.name ?? 'unknown')

          const fieldLines = tableFields
            .map((f) => {
              const tags: string[] = []
              if (f.is_primary_key) tags.push('PK')
              if (f.is_foreign_key) tags.push('FK')
              if (f.is_nullable) tags.push('nullable')
              const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''

              const profile = profileByFieldId.get(f.id)
              const samples = profile?.sample_values
                ? (profile.sample_values as unknown[])
                    .filter(Boolean)
                    .slice(0, 5)
                    .map((v) => String(v))
                    .join(', ')
                : 'no samples'

              return `  - ${f.name} (${f.data_type})${tagStr}\n    Sample values: ${samples}`
            })
            .join('\n')

          return `Table: ${datasetName}.${table.name}\nFields:\n${fieldLines}`
        })
        .join('\n\n')
    }

    const sourceSection = buildSchemaSection(sourceTables ?? [], sourceFields ?? [])
    const targetSection = buildSchemaSection(targetTables ?? [], targetFields ?? [])

    const systemPrompt = `You are an enterprise data migration expert specializing in source-to-target schema mapping. Given source and target database schemas with sample data and optional documentation context, generate comprehensive mapping suggestions.

For each mapping, provide:
- A confidence score (0-100) based on how certain you are about the match
- Brief reasoning explaining WHY this mapping makes sense
- Alternative target fields you considered
- Type compatibility assessment
- Whether a transformation will be needed

Scoring guidelines:
- 90-100: Near-certain match (identical names, same types, same business meaning)
- 75-89: High confidence (similar names, compatible types, clear business alignment)
- 50-74: Moderate confidence (partial name match, type conversion needed, or ambiguous business meaning)
- Below 50: Low confidence (weak signals, multiple possible targets)

Consider these signals when mapping:
- Field name similarity (camelCase vs UPPER_SNAKE_CASE conventions)
- Data type compatibility
- Business meaning and context from documentation
- Common enterprise patterns (Id→ID, Name→NAME, Email→EMAIL_ADDRESS)
- Primary/foreign key relationships
- Cardinality and value patterns from sample data
- Field position and grouping within tables

If documentation is provided, use it to:
- Identify exact value mappings (industry codes, stage values, status values)
- Understand target field constraints (picklist values, required formats, NOT NULL fields)
- Flag fields that need specific transformation logic based on documented rules
- Set higher confidence scores when documentation confirms a mapping

CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.`

    const userMessage = `<source_schema>
${sourceSection}
</source_schema>
<target_schema>
${targetSection}
</target_schema>
${docBlock}
Generate source-to-target mappings. Respond with this exact JSON structure.

CRITICAL RULES FOR THE JSON:
- "source_table" must be ONLY the table name (e.g., "prices") — NOT the qualified name (NOT "trux.prices")
- "target_table" must be ONLY the table name (e.g., "ARTICLE_PRICES") — NOT "dataset.ARTICLE_PRICES"
- "source_field" must be ONLY the field name (e.g., "item_price") — NOT "prices.item_price"
- "target_field" must be ONLY the field name (e.g., "PRICE") — NOT "ARTICLE_PRICES.PRICE"

{
  "table_mappings": [
    {
      "source_table": "prices",
      "target_table": "ARTICLE_PRICES",
      "confidence": 88,
      "reasoning": "Both tables store pricing information for items/articles...",
      "field_mappings": [
        {
          "source_field": "item_price",
          "target_field": "PRICE",
          "confidence": 85,
          "reasoning": "Direct price field mapping, DECIMAL to DECIMAL compatible",
          "similar_fields_considered": ["UNIT_PRICE", "BASE_PRICE"],
          "type_compatibility": "DECIMAL(10,2) → DECIMAL(15,4) — target has higher precision",
          "needs_transformation": false
        }
      ]
    }
  ]
}

Map ALL source fields to their best target match. If a source field has no reasonable target match, omit it.`

    // Call Claude — use 8192 tokens so large schemas don't get truncated
    let parsedResponse: ClaudeResponse
    const claudeRaw = await callClaude(systemPrompt, userMessage, 8192)

    try {
      parsedResponse = parseClaudeJSON(claudeRaw)
    } catch {
      // Retry once asking Claude to fix the JSON
      const retryRaw = await callClaude(
        'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
        `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${claudeRaw}`
      )
      parsedResponse = parseClaudeJSON(retryRaw)
    }

    // Delete existing mappings (re-generate flow) — cascade deletes field_mappings
    await supabase.from('table_mappings').delete().eq('project_id', projectId)

    // Normalize: strip dataset prefix if Claude returns "dataset.table" or "dataset.field"
    function bareTableName(s: string | null | undefined): string {
      if (!s || typeof s !== 'string') return ''
      const parts = s.split('.')
      return parts[parts.length - 1].toLowerCase().trim()
    }

    // Build lookup maps for name matching (case-insensitive, bare name only)
    const sourceTableMap = new Map(
      (sourceTables ?? []).map((t) => [t.name.toLowerCase(), t])
    )
    const targetTableMap = new Map(
      (targetTables ?? []).map((t) => [t.name.toLowerCase(), t])
    )

    const sourceFieldsByTable = new Map<string, Map<string, (typeof sourceFields)[0]>>()
    for (const f of sourceFields ?? []) {
      if (!sourceFieldsByTable.has(f.table_id)) {
        sourceFieldsByTable.set(f.table_id, new Map())
      }
      sourceFieldsByTable.get(f.table_id)!.set(f.name.toLowerCase(), f)
    }

    const targetFieldsByTable = new Map<string, Map<string, (typeof targetFields)[0]>>()
    for (const f of targetFields ?? []) {
      if (!targetFieldsByTable.has(f.table_id)) {
        targetFieldsByTable.set(f.table_id, new Map())
      }
      targetFieldsByTable.get(f.table_id)!.set(f.name.toLowerCase(), f)
    }

    let storedCount = 0

    // Store mappings
    for (const tm of parsedResponse.table_mappings) {
      // Accept both "tableName" and "dataset.tableName" from Claude; skip null entries
      if (!tm.source_table || !tm.target_table) continue
      const srcKey = bareTableName(tm.source_table)
      const tgtKey = bareTableName(tm.target_table)
      if (!srcKey || !tgtKey) continue
      const srcTable = sourceTableMap.get(srcKey)
      const tgtTable = targetTableMap.get(tgtKey)
      if (!srcTable || !tgtTable) {
        console.warn(`[mappings] No match for "${tm.source_table}" → "${tm.target_table}" (keys: ${srcKey}, ${tgtKey})`)
        continue
      }

      const { data: insertedTM, error: tmErr } = await supabase
        .from('table_mappings')
        .insert({
          project_id: projectId,
          source_table_id: srcTable.id,
          target_table_id: tgtTable.id,
          confidence: tm.confidence,
          status: 'needs_review',
          ai_reasoning: tm.reasoning,
        })
        .select()
        .single()

      if (tmErr || !insertedTM) continue

      storedCount++

      const srcFieldsForTable = sourceFieldsByTable.get(srcTable.id) ?? new Map()
      const tgtFieldsForTable = targetFieldsByTable.get(tgtTable.id) ?? new Map()

      const fieldInserts: Record<string, unknown>[] = []
      for (const fm of tm.field_mappings ?? []) {
        // Accept both "fieldName" and "table.fieldName" from Claude
        const srcFieldKey = bareTableName(fm.source_field)
        const tgtFieldKey = bareTableName(fm.target_field)
        const srcField = srcFieldsForTable.get(srcFieldKey)
        const tgtField = tgtFieldsForTable.get(tgtFieldKey)
        if (!srcField || !tgtField) {
          console.warn(`[mappings] Field no match: "${fm.source_field}" → "${fm.target_field}"`)
          continue
        }

        fieldInserts.push({
          table_mapping_id: insertedTM.id,
          source_field_id: srcField.id,
          target_field_id: tgtField.id,
          confidence: fm.confidence,
          status: 'needs_review',
          ai_reasoning: fm.reasoning,
          similar_fields_considered: fm.similar_fields_considered ?? [],
          type_compatibility: fm.type_compatibility ?? null,
        })
      }

      if (fieldInserts.length > 0) {
        await supabase.from('field_mappings').insert(fieldInserts)
      }
    }

    if (storedCount === 0) {
      // Nothing was stored — Claude returned names that don't match any table
      console.error('[mappings] Zero table mappings stored. Claude response tables:', 
        parsedResponse.table_mappings.map(tm => `${tm.source_table} → ${tm.target_table}`))
      return {
        success: false,
        error: `AI returned ${parsedResponse.table_mappings.length} mapping suggestion(s) but none matched your table names. Please try again — the AI may need another attempt to use the correct names.`,
      }
    }

    return { success: true }
  } catch (err) {
    console.error('generateMappings error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Generation failed' }
  }
}

// ─── getMappings ───────────────────────────────────────────────────────────────

export async function getMappings(projectId: string): Promise<MappingsResult | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return null

  // Fetch all datasets for the project
  const { data: allDatasets } = await supabase
    .from('datasets')
    .select('id, name, role')
    .eq('project_id', projectId)

  const datasetMap = new Map((allDatasets ?? []).map((d) => [d.id, d]))

  // Fetch all tables for the project
  const datasetIds = (allDatasets ?? []).map((d) => d.id)
  const { data: allTables } = await supabase
    .from('tables')
    .select('id, name, dataset_id, row_count')
    .in('dataset_id', datasetIds.length ? datasetIds : ['__none__'])

  const tableMap = new Map((allTables ?? []).map((t) => [t.id, t]))

  // Fetch all fields for the project
  const tableIds = (allTables ?? []).map((t) => t.id)
  const { data: allFields } = await supabase
    .from('fields')
    .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, ordinal_position')
    .in('table_id', tableIds.length ? tableIds : ['__none__'])
    .order('ordinal_position', { ascending: true })

  const fieldMap = new Map((allFields ?? []).map((f) => [f.id, f]))

  // Fetch field profiles for sample values
  const allFieldIds = (allFields ?? []).map((f) => f.id)
  const { data: fieldProfiles } = await supabase
    .from('field_profiles')
    .select('field_id, sample_values')
    .in('field_id', allFieldIds.length ? allFieldIds : ['__none__'])

  const profileMap = new Map((fieldProfiles ?? []).map((p) => [p.field_id, p]))

  // Fetch table mappings
  const { data: rawTMs } = await supabase
    .from('table_mappings')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  const tmIds = (rawTMs ?? []).map((tm) => tm.id)

  // Fetch field mappings
  const { data: rawFMs } = await supabase
    .from('field_mappings')
    .select('*')
    .in('table_mapping_id', tmIds.length ? tmIds : ['__none__'])
    .order('created_at', { ascending: true })

  // Join table mappings with related data
  const tableMappings: RichTableMapping[] = (rawTMs ?? []).map((tm) => {
    const srcTable = tableMap.get(tm.source_table_id)
    const tgtTable = tableMap.get(tm.target_table_id)
    const fms = (rawFMs ?? []).filter((fm) => fm.table_mapping_id === tm.id)

    const fieldMappings: RichFieldMapping[] = fms.map((fm) => {
      const srcField = fieldMap.get(fm.source_field_id) ?? null
      const tgtField = fieldMap.get(fm.target_field_id) ?? null
      const srcProfile = profileMap.get(fm.source_field_id)
      const tgtProfile = profileMap.get(fm.target_field_id)

      const toSamples = (p: typeof srcProfile) =>
        p?.sample_values
          ? (p.sample_values as unknown[]).filter(Boolean).slice(0, 3).map((v) => String(v))
          : []

      return {
        id: fm.id,
        table_mapping_id: fm.table_mapping_id,
        source_field_id: fm.source_field_id,
        target_field_id: fm.target_field_id,
        confidence: fm.confidence,
        status: fm.status as RichFieldMapping['status'],
        ai_reasoning: fm.ai_reasoning,
        similar_fields_considered: fm.similar_fields_considered as string[] | null,
        type_compatibility: fm.type_compatibility,
        created_at: fm.created_at,
        sourceField: srcField
          ? { id: srcField.id, name: srcField.name, data_type: srcField.data_type, inferred_type: srcField.inferred_type }
          : null,
        targetField: tgtField
          ? { id: tgtField.id, name: tgtField.name, data_type: tgtField.data_type, inferred_type: tgtField.inferred_type }
          : null,
        sourceFieldSamples: toSamples(srcProfile),
        targetFieldSamples: toSamples(tgtProfile),
      }
    })

    return {
      id: tm.id,
      project_id: tm.project_id,
      source_table_id: tm.source_table_id,
      target_table_id: tm.target_table_id,
      confidence: tm.confidence,
      status: tm.status as RichTableMapping['status'],
      ai_reasoning: tm.ai_reasoning,
      created_at: tm.created_at,
      sourceTable: srcTable
        ? {
            id: srcTable.id,
            name: srcTable.name,
            dataset: datasetMap.get(srcTable.dataset_id) as { id: string; name: string; role: string },
          }
        : null,
      targetTable: tgtTable
        ? {
            id: tgtTable.id,
            name: tgtTable.name,
            dataset: datasetMap.get(tgtTable.dataset_id) as { id: string; name: string; role: string },
          }
        : null,
      fieldMappings,
    }
  })

  // Compute unmapped fields
  const mappedSourceFieldIds = new Set((rawFMs ?? []).map((fm) => fm.source_field_id))
  const mappedTargetFieldIds = new Set((rawFMs ?? []).map((fm) => fm.target_field_id))

  const sourceDatasetIds = new Set(
    (allDatasets ?? []).filter((d) => d.role === 'source').map((d) => d.id)
  )
  const targetDatasetIds = new Set(
    (allDatasets ?? []).filter((d) => d.role === 'target').map((d) => d.id)
  )

  const sourceTableIds = new Set(
    (allTables ?? []).filter((t) => sourceDatasetIds.has(t.dataset_id)).map((t) => t.id)
  )
  const targetTableIdSet = new Set(
    (allTables ?? []).filter((t) => targetDatasetIds.has(t.dataset_id)).map((t) => t.id)
  )

  const unmappedSourceFields: UnmappedField[] = (allFields ?? [])
    .filter((f) => sourceTableIds.has(f.table_id) && !mappedSourceFieldIds.has(f.id))
    .map((f) => ({ ...f, table: tableMap.get(f.table_id) ?? null }))

  const unmappedTargetFields: UnmappedField[] = (allFields ?? [])
    .filter((f) => targetTableIdSet.has(f.table_id) && !mappedTargetFieldIds.has(f.id))
    .map((f) => ({ ...f, table: tableMap.get(f.table_id) ?? null }))

  // Build source/target table lists for "add mapping" modal
  const allSourceTables = (allTables ?? [])
    .filter((t) => sourceDatasetIds.has(t.dataset_id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      datasetName: datasetMap.get(t.dataset_id)?.name ?? '',
    }))
  const allTargetTables = (allTables ?? [])
    .filter((t) => targetDatasetIds.has(t.dataset_id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      datasetName: datasetMap.get(t.dataset_id)?.name ?? '',
    }))

  // Build allFieldsByTable map
  const allFieldsByTable: Record<string, SimpleField[]> = {}
  for (const t of allTables ?? []) {
    allFieldsByTable[t.id] = (allFields ?? [])
      .filter((f) => f.table_id === t.id)
      .map((f) => ({ id: f.id, name: f.name, data_type: f.data_type }))
  }

  return { tableMappings, unmappedSourceFields, unmappedTargetFields, allSourceTables, allTargetTables, allFieldsByTable }
}

// ─── updateFieldMappingStatus ─────────────────────────────────────────────────

export async function updateFieldMappingStatus(
  fieldMappingId: string,
  status: 'approved' | 'rejected' | 'needs_review'
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase
    .from('field_mappings')
    .update({ status })
    .eq('id', fieldMappingId)

  if (error) return { success: false, error: error.message }

  // Auto-approve table mapping if all field mappings are approved
  if (status === 'approved') {
    const { data: fm } = await supabase
      .from('field_mappings')
      .select('table_mapping_id')
      .eq('id', fieldMappingId)
      .single()

    if (fm) {
      const { data: siblings } = await supabase
        .from('field_mappings')
        .select('status')
        .eq('table_mapping_id', fm.table_mapping_id)

      if (siblings && siblings.every((s) => s.status === 'approved')) {
        await supabase
          .from('table_mappings')
          .update({ status: 'approved' })
          .eq('id', fm.table_mapping_id)
      }
    }
  }

  return { success: true }
}

// ─── updateTableMappingStatus ─────────────────────────────────────────────────

export async function updateTableMappingStatus(
  tableMappingId: string,
  status: 'approved' | 'rejected' | 'needs_review'
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase
    .from('table_mappings')
    .update({ status })
    .eq('id', tableMappingId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── editFieldMapping ─────────────────────────────────────────────────────────

export async function editFieldMapping(
  fieldMappingId: string,
  updates: {
    target_field_id?: string
    confidence?: number | null
    ai_reasoning?: string
    type_compatibility?: string | null
  }
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase
    .from('field_mappings')
    .update({ ...updates, status: 'needs_review' })
    .eq('id', fieldMappingId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── addManualFieldMapping ────────────────────────────────────────────────────

export async function addManualFieldMapping(
  tableMappingId: string,
  sourceFieldId: string,
  targetFieldId: string
): Promise<{ success: boolean; data?: { id: string }; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data, error } = await supabase
    .from('field_mappings')
    .insert({
      table_mapping_id: tableMappingId,
      source_field_id: sourceFieldId,
      target_field_id: targetFieldId,
      confidence: 100,
      status: 'approved',
      ai_reasoning: 'Manually mapped by user',
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, data: { id: data.id } }
}

// ─── addManualTableMapping ────────────────────────────────────────────────────

export async function addManualTableMapping(
  projectId: string,
  sourceTableId: string,
  targetTableId: string
): Promise<{ success: boolean; data?: { id: string }; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { success: false, error: 'Project not found' }

  const { data, error } = await supabase
    .from('table_mappings')
    .insert({
      project_id: projectId,
      source_table_id: sourceTableId,
      target_table_id: targetTableId,
      confidence: null,
      status: 'needs_review',
      ai_reasoning: null,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, data: { id: data.id } }
}

// ─── deleteFieldMapping ───────────────────────────────────────────────────────

export async function deleteFieldMapping(
  fieldMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase
    .from('field_mappings')
    .delete()
    .eq('id', fieldMappingId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── deleteTableMapping ───────────────────────────────────────────────────────

export async function deleteTableMapping(
  tableMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase.from('table_mappings').delete().eq('id', tableMappingId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── approveAllFieldMappings ──────────────────────────────────────────────────

export async function approveAllFieldMappings(
  tableMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error: fmErr } = await supabase
    .from('field_mappings').update({ status: 'approved' }).eq('table_mapping_id', tableMappingId)
  if (fmErr) return { success: false, error: fmErr.message }

  await supabase.from('table_mappings').update({ status: 'approved' }).eq('id', tableMappingId)
  return { success: true }
}

// ─── rejectAllFieldMappings ───────────────────────────────────────────────────

export async function rejectAllFieldMappings(
  tableMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { error } = await supabase
    .from('field_mappings').update({ status: 'rejected' }).eq('table_mapping_id', tableMappingId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── approveHighConfidenceMappings ────────────────────────────────────────────

export async function approveHighConfidenceMappings(
  projectId: string,
  threshold = 85
): Promise<{ success: boolean; count: number; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, count: 0, error: 'Not authenticated' }

  const { data: tms } = await supabase.from('table_mappings').select('id').eq('project_id', projectId)
  if (!tms?.length) return { success: true, count: 0 }

  const tmIds = tms.map((tm) => tm.id)
  const { data: updated, error } = await supabase
    .from('field_mappings')
    .update({ status: 'approved' })
    .in('table_mapping_id', tmIds)
    .gte('confidence', threshold)
    .eq('status', 'needs_review')
    .select('id, table_mapping_id')

  if (error) return { success: false, count: 0, error: error.message }
  const count = updated?.length ?? 0

  // Auto-approve TMs where all FMs are now approved
  const affectedTMIds = [...new Set((updated ?? []).map((fm) => fm.table_mapping_id))]
  for (const tmId of affectedTMIds) {
    const { data: siblings } = await supabase.from('field_mappings').select('status').eq('table_mapping_id', tmId)
    if (siblings?.every((s) => s.status === 'approved')) {
      await supabase.from('table_mappings').update({ status: 'approved' }).eq('id', tmId)
    }
  }

  return { success: true, count }
}

// ─── suggestRemainingMappings ─────────────────────────────────────────────────

export async function suggestRemainingMappings(
  tableMappingId: string
): Promise<{ success: boolean; newMappingsCount: number; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, newMappingsCount: 0, error: 'Not authenticated' }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, newMappingsCount: 0, error: rateLimit.error }

  const { data: tm } = await supabase.from('table_mappings').select('*').eq('id', tableMappingId).single()
  if (!tm) return { success: false, newMappingsCount: 0, error: 'Table mapping not found' }

  const { data: proj } = await supabase.from('projects').select('id').eq('id', tm.project_id).eq('user_id', user.id).single()
  if (!proj) return { success: false, newMappingsCount: 0, error: 'Not authorized' }

  const { data: existingFMs } = await supabase.from('field_mappings').select('source_field_id, target_field_id').eq('table_mapping_id', tableMappingId)
  const mappedSrcIds = new Set((existingFMs ?? []).map((fm) => fm.source_field_id))
  const mappedTgtIds = new Set((existingFMs ?? []).map((fm) => fm.target_field_id))

  const { data: allSrcF } = await supabase.from('fields')
    .select('id, name, data_type, is_primary_key, is_foreign_key, is_nullable')
    .eq('table_id', tm.source_table_id).order('ordinal_position', { ascending: true })
  const { data: allTgtF } = await supabase.from('fields')
    .select('id, name, data_type, is_primary_key, is_foreign_key, is_nullable')
    .eq('table_id', tm.target_table_id).order('ordinal_position', { ascending: true })

  const unmapSrc = (allSrcF ?? []).filter((f) => !mappedSrcIds.has(f.id))
  const unmapTgt = (allTgtF ?? []).filter((f) => !mappedTgtIds.has(f.id))
  if (!unmapSrc.length || !unmapTgt.length) return { success: true, newMappingsCount: 0 }

  const { data: srcT } = await supabase.from('tables').select('name, datasets(name)').eq('id', tm.source_table_id).single()
  const { data: tgtT } = await supabase.from('tables').select('name, datasets(name)').eq('id', tm.target_table_id).single()

  const allFIds = [...unmapSrc.map((f) => f.id), ...unmapTgt.map((f) => f.id)]
  const { data: profs } = await supabase.from('field_profiles').select('field_id, sample_values').in('field_id', allFIds)
  const profMap = new Map((profs ?? []).map((p) => [p.field_id, p]))

  function fLine(f: { id: string; name: string; data_type: string; is_primary_key: boolean; is_foreign_key: boolean; is_nullable: boolean }) {
    const tags: string[] = []
    if (f.is_primary_key) tags.push('PK')
    if (f.is_foreign_key) tags.push('FK')
    if (f.is_nullable) tags.push('nullable')
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
    const p = profMap.get(f.id)
    const samples = p?.sample_values ? (p.sample_values as unknown[]).filter(Boolean).slice(0, 3).map((v) => String(v)).join(', ') : 'no samples'
    return `  - ${f.name} (${f.data_type})${tagStr}\n    Samples: ${samples}`
  }

  const rawSrcDs = srcT?.datasets as unknown
  const srcDsN = Array.isArray(rawSrcDs) ? (rawSrcDs[0]?.name ?? 'source') : ((rawSrcDs as { name?: string } | null)?.name ?? 'source')
  const rawTgtDs = tgtT?.datasets as unknown
  const tgtDsN = Array.isArray(rawTgtDs) ? (rawTgtDs[0]?.name ?? 'target') : ((rawTgtDs as { name?: string } | null)?.name ?? 'target')

  const remainingDocBlock = formatDocumentContextForPrompt(
    await getSchemaDocumentContext(tm.project_id)
  )

  const userMsg = `Source ${srcDsN}.${srcT?.name} → Target ${tgtDsN}.${tgtT?.name}. Suggest mappings for these UNMAPPED fields only.

<source_unmapped>
${unmapSrc.map(fLine).join('\n')}
</source_unmapped>
<target_unmapped>
${unmapTgt.map(fLine).join('\n')}
</target_unmapped>
${remainingDocBlock}
CRITICAL: Use ONLY the bare field name (not table.field). Respond with ONLY valid JSON:
{"field_mappings":[{"source_field":"name","target_field":"name","confidence":75,"reasoning":"reason","similar_fields_considered":[],"type_compatibility":"TYPE→TYPE"}]}`

  let parsed: { field_mappings: ClaudeFieldMapping[] }
  try {
    const raw = await callClaude('You are a data migration expert. Return ONLY valid JSON.', userMsg, 4096)
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed.field_mappings)) throw new Error('bad structure')
  } catch {
    return { success: false, newMappingsCount: 0, error: 'AI returned invalid response. Please try again.' }
  }

  function bareN(s: string | null | undefined): string {
    if (!s || typeof s !== 'string') return ''
    return s.split('.').pop()!.toLowerCase().trim()
  }

  const srcFMap = new Map(unmapSrc.map((f) => [f.name.toLowerCase(), f]))
  const tgtFMap = new Map(unmapTgt.map((f) => [f.name.toLowerCase(), f]))

  const inserts: Record<string, unknown>[] = []
  for (const fm of parsed.field_mappings) {
    const sf = srcFMap.get(bareN(fm.source_field))
    const tf = tgtFMap.get(bareN(fm.target_field))
    if (!sf || !tf) continue
    inserts.push({
      table_mapping_id: tableMappingId,
      source_field_id: sf.id,
      target_field_id: tf.id,
      confidence: fm.confidence,
      status: 'needs_review',
      ai_reasoning: fm.reasoning,
      similar_fields_considered: fm.similar_fields_considered ?? [],
      type_compatibility: fm.type_compatibility ?? null,
    })
  }

  if (inserts.length > 0) await supabase.from('field_mappings').insert(inserts)
  return { success: true, newMappingsCount: inserts.length }
}

// ─── mapUnmappedField ─────────────────────────────────────────────────────────

export async function mapUnmappedField(
  projectId: string,
  sourceFieldId: string,
  targetFieldId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: proj } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).single()
  if (!proj) return { success: false, error: 'Not authorized' }

  const { data: sf } = await supabase.from('fields').select('table_id').eq('id', sourceFieldId).single()
  const { data: tf } = await supabase.from('fields').select('table_id').eq('id', targetFieldId).single()
  if (!sf || !tf) return { success: false, error: 'Field not found' }

  // Find or create table mapping
  let tmId: string
  const { data: existingTM } = await supabase
    .from('table_mappings').select('id')
    .eq('project_id', projectId).eq('source_table_id', sf.table_id).eq('target_table_id', tf.table_id)
    .maybeSingle()

  if (existingTM) {
    tmId = existingTM.id
  } else {
    const { data: newTM, error: tmErr } = await supabase
      .from('table_mappings')
      .insert({ project_id: projectId, source_table_id: sf.table_id, target_table_id: tf.table_id, confidence: null, status: 'needs_review' })
      .select('id').single()
    if (tmErr || !newTM) return { success: false, error: tmErr?.message ?? 'Failed to create table mapping' }
    tmId = newTM.id
  }

  const { error: fmErr } = await supabase.from('field_mappings').insert({
    table_mapping_id: tmId,
    source_field_id: sourceFieldId,
    target_field_id: targetFieldId,
    confidence: 100,
    status: 'approved',
    ai_reasoning: 'Manually mapped by user',
  })

  if (fmErr) return { success: false, error: fmErr.message }
  return { success: true }
}
