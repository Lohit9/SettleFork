'use server'

import { createClient } from '@/lib/supabase/server'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatSchemaForPrompt, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { logActivity } from '@/lib/actions/activity-log'

// ─── Claude Response Types ─────────────────────────────────────────────────────

interface ClaudeFieldMapping {
  source_field: string                   // primary source field name (always present)
  target_field: string                   // target field name (always present)
  confidence: number
  reasoning: string
  similar_fields_considered?: string[]
  type_compatibility?: string
  needs_transformation?: boolean
  // Many-to-one / one-to-many support
  mapping_type?: 'one_to_one' | 'many_to_one' | 'one_to_many'
  contributing_source_fields?: string[]  // additional source fields for many-to-one (not including primary)
  combination_hint?: string              // e.g., "Concatenate with space separator"
  split_hint?: string                    // e.g., "Extract city portion" (for one-to-many)
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
  /** True when this is a secondary source contributing to a target that already has a primary mapping */
  is_contributing: boolean
  created_at: string
  sourceField: { id: string; name: string; data_type: string; inferred_type: string | null } | null
  targetField: { id: string; name: string; data_type: string; inferred_type: string | null } | null
  sourceFieldSamples: string[]
  targetFieldSamples: string[]
  sourceFieldNullPercentage: number
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
  is_nullable?: boolean
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
): Promise<{ success: boolean; error?: string; generated?: number; skipped?: number; message?: string }> {
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

    // Build rich AI context: value distributions, format issues, profiling stats, and docs
    const aiCtx = await buildAIContext(projectId, {
      tableIds: [...sourceTableIds, ...targetTableIds],
      includeProfilingStats: true,
      includeValueDistributions: true,
      includeSampleValues: true,
      includeDocuments: true,
      maxDistributionValues: 15,
      maxSampleValues: 5,
    }, user.id)

    const sourceSection = formatSchemaForPrompt(aiCtx.source_tables, 'source')
    const targetSection = formatSchemaForPrompt(aiCtx.target_tables, 'target')
    const docBlock = formatDocumentsForPrompt(aiCtx.documents)

    const systemPrompt = `You are an enterprise data migration expert specializing in source-to-target schema mapping. Given source and target database schemas with sample data and optional documentation context, generate comprehensive mapping suggestions.

For each mapping, provide:
- A confidence score (0-100) based on how certain you are about the match
- Brief reasoning explaining WHY this mapping makes sense
- Alternative target fields you considered
- Type compatibility assessment — describe what specific conversion or validation is needed, not just whether types match. Examples: "VARCHAR → DECIMAL — strip $ and commas, parse to number", "VARCHAR → BOOLEAN — normalize Y/N/yes/no/1/0 to TRUE/FALSE", "VARCHAR(200) → VARCHAR(120) — truncation needed, 12 values exceed limit". If no conversion is needed, write "direct compatible — no conversion needed".
- Whether a transformation will be needed (see transformation rules below)

TRANSFORMATION RULES — A field needs_transformation = true if ANY of these apply:
1. DATA TYPE CONVERSION: Source data type must change to fit target (VARCHAR → DECIMAL, VARCHAR → DATE, VARCHAR → BOOLEAN, etc.)
2. VALUE MAPPING: Source values must be translated to different target values (e.g., "Won" → "Closed Won", "Technology" → "TECH"). Look at the value distribution — if source values don't match expected target picklist/enum values from documentation, this needs transformation.
3. FORMAT STANDARDIZATION: Source values are in inconsistent or wrong format for target (mixed date formats like "01/15/2024" and "2024-01-15" → ISO only, phone numbers needing E.164, currency strings like "$1,234.56" → numeric).
4. ID FORMAT CHANGE: Source uses one ID scheme, target uses another (e.g., "CUST-00001" → Salesforce 18-char alphanumeric ID).
5. BOOLEAN NORMALIZATION: Source uses mixed representations (Y/N, yes/no, 1/0, true/false) and target expects a specific boolean format. Check the value distribution for mixed boolean-like values.
6. CASING / CAPITALIZATION: Source values need systematic casing changes (e.g., "john" or "JOHN" → "John" for proper name fields). Check sample values for inconsistent casing.
7. TRUNCATION: Source values exceed target field's max length.
8. COMPUTATION: Target value must be derived (stripping currency symbols, concatenating fields, splitting fields).
9. FOREIGN KEY REFORMAT: A FK field whose referenced PK is being transformed (if customer_id → Account.Id changes format, then contact.customer_id → Contact.AccountId also needs transformation to stay consistent).

A field DOES NOT need transformation for:
- Naming convention differences only (snake_case vs camelCase, lowercase vs PascalCase) when data values pass through unchanged
- Minor type aliasing where data is compatible without conversion (TEXT vs VARCHAR, VARCHAR(100) vs VARCHAR(255) when no values exceed the smaller limit)
- Fields where source and target are semantically identical and values can be copied directly

MULTI-FIELD MAPPING PATTERNS:

You MUST detect and correctly map these patterns:

MANY-TO-ONE (multiple source fields → one target field):
When multiple source fields should be combined into a single target field, set:
- mapping_type: "many_to_one"
- source_field: the FIRST/PRIMARY source field name
- contributing_source_fields: array of ADDITIONAL source field names (do NOT repeat the primary)
- combination_hint: brief description of how to combine (e.g., "Concatenate with space separator")
- needs_transformation: true (always true for many-to-one)

Common many-to-one patterns:
- first_name + last_name → full_name, name, display_name, primary_contact
- street + city + state + zip → full_address, address
- date_field + time_field → datetime
- Any name component fields → a single combined name field

IMPORTANT: Return many-to-one as a SINGLE mapping entry (not separate entries for each source field). The contributing_source_fields array tells the system which other fields to include.

ONE-TO-MANY (one source field → multiple target fields):
When a single source field should be split into multiple target fields, create SEPARATE mapping entries for EACH target field, each with:
- mapping_type: "one_to_many"
- source_field: the SAME source field name in each entry
- target_field: DIFFERENT target field in each entry
- split_hint: description of what part to extract (e.g., "Extract first name", "Extract last name")
- needs_transformation: true (always true for one-to-many)

Common one-to-many patterns:
- full_name → first_name, last_name
- full_address → street, city, state, zip
- datetime → date, time

IMPORTANT: Each split target gets its OWN mapping entry in the field_mappings array. They share the same source_field but have different target_field values.

If a mapping is standard one-to-one, either omit mapping_type or set it to "one_to_one". Do NOT include contributing_source_fields or split_hint for one-to-one mappings.

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

    const userMessage = `${sourceSection}
${targetSection}
${docBlock}
${aiCtx.intelligence_context ? aiCtx.intelligence_context + '\n\n' : ''}Generate source-to-target mappings. Respond with this exact JSON structure.

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
            "needs_transformation": true
          },
          {
            "source_field": "contact_first",
            "target_field": "CONTACT_NAME",
            "confidence": 90,
            "reasoning": "First and last name components should be combined into full name",
            "type_compatibility": "VARCHAR(50) + VARCHAR(50) → VARCHAR(100)",
            "needs_transformation": true,
            "mapping_type": "many_to_one",
            "contributing_source_fields": ["contact_last"],
            "combination_hint": "Concatenate first and last name with space separator"
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

    // Additive generation — fetch existing pairs so we can skip them instead of deleting
    const { data: existingMappingPairs } = await supabase
      .from('table_mappings')
      .select('source_table_id, target_table_id')
      .eq('project_id', projectId)

    const existingPairSet = new Set(
      (existingMappingPairs ?? []).map((m) => `${m.source_table_id}::${m.target_table_id}`)
    )
    let skippedCount = 0

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

      // Skip pairs that already have a table mapping (additive — preserve existing work)
      const pairKey = `${srcTable.id}::${tgtTable.id}`
      if (existingPairSet.has(pairKey)) {
        skippedCount++
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

        const mappingType = fm.mapping_type || 'one_to_one'

        // Build the reasoning string, appending hints for multi-field mappings
        let reasoningText = fm.reasoning
        if (fm.combination_hint) reasoningText += ` [Combination: ${fm.combination_hint}]`
        if (fm.split_hint) reasoningText += ` [Split: ${fm.split_hint}]`

        // Primary mapping row (always inserted)
        fieldInserts.push({
          table_mapping_id: insertedTM.id,
          source_field_id: srcField.id,
          target_field_id: tgtField.id,
          confidence: fm.confidence,
          status: 'needs_review',
          ai_reasoning: reasoningText,
          similar_fields_considered: fm.similar_fields_considered ?? [],
          type_compatibility: fm.type_compatibility ?? null,
          needs_transformation: fm.needs_transformation ?? (mappingType !== 'one_to_one' ? true : null),
          is_contributing: false,
        })

        // For many-to-one: create a contributing row for each additional source field
        if (mappingType === 'many_to_one' && fm.contributing_source_fields?.length) {
          for (const contribFieldName of fm.contributing_source_fields) {
            const contribKey = bareTableName(contribFieldName)
            const contribField = srcFieldsForTable.get(contribKey)
            if (!contribField) {
              console.warn(`[mappings] Contributing field "${contribFieldName}" not found in source table — skipping`)
              continue
            }
            fieldInserts.push({
              table_mapping_id: insertedTM.id,
              source_field_id: contribField.id,
              target_field_id: tgtField.id,
              confidence: fm.confidence,
              status: 'needs_review',
              ai_reasoning: `Contributing field for many-to-one: ${fm.source_field} + ${contribFieldName} → ${fm.target_field}. ${fm.combination_hint ?? ''}`.trim(),
              similar_fields_considered: [],
              type_compatibility: fm.type_compatibility ?? null,
              needs_transformation: false,
              is_contributing: true,
            })
          }
        }

        // For one-to-many: no special handling — Claude returns a separate entry per target
        // field naturally, all sharing the same source_field. The split_hint is embedded in
        // the ai_reasoning of each row above.
      }

      if (fieldInserts.length > 0) {
        await supabase.from('field_mappings').insert(fieldInserts)
      }
    }

    if (storedCount === 0) {
      // All pairs already existed — every suggestion was skipped
      if (skippedCount > 0) {
        return {
          success: true,
          generated: 0,
          skipped: skippedCount,
          message: 'All selected table pairs already have mappings. Go to the Mapping tab to manage them.',
        }
      }
      // Claude returned names that don't match any table
      console.error('[mappings] Zero table mappings stored. Claude response tables:', 
        parsedResponse.table_mappings.map(tm => `${tm.source_table} → ${tm.target_table}`))
      return {
        success: false,
        error: `AI returned ${parsedResponse.table_mappings.length} mapping suggestion(s) but none matched your table names. Please try again — the AI may need another attempt to use the correct names.`,
      }
    }

    return {
      success: true,
      generated: storedCount,
      skipped: skippedCount,
      message: skippedCount > 0
        ? `Generated mappings for ${storedCount} table pair${storedCount !== 1 ? 's' : ''}. Skipped ${skippedCount} pair${skippedCount !== 1 ? 's' : ''} that already have mappings.`
        : undefined,
    }
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

  // Hop 2: everything that only needs projectId — run in parallel
  const [{ data: allDatasets }, { data: rawTMs }] = await Promise.all([
    supabase.from('datasets').select('id, name, role').eq('project_id', projectId),
    supabase.from('table_mappings').select('*').eq('project_id', projectId).order('created_at', { ascending: true }),
  ])

  const datasetMap = new Map((allDatasets ?? []).map((d) => [d.id, d]))
  const datasetIds = (allDatasets ?? []).map((d) => d.id)
  const tmIds = (rawTMs ?? []).map((tm) => tm.id)

  // Hop 3: things that need dataset/TM IDs — run in parallel
  const [{ data: allTables }, { data: rawFMs }] = await Promise.all([
    supabase
      .from('tables')
      .select('id, name, dataset_id, row_count')
      .in('dataset_id', datasetIds.length ? datasetIds : ['__none__']),
    supabase
      .from('field_mappings')
      .select('*')
      .in('table_mapping_id', tmIds.length ? tmIds : ['__none__'])
      .order('created_at', { ascending: true }),
  ])

  const tableMap = new Map((allTables ?? []).map((t) => [t.id, t]))
  const tableIds = (allTables ?? []).map((t) => t.id)

  // Hop 4: fields with their profiles embedded — single query instead of two sequential ones
  const { data: allFields } = await supabase
    .from('fields')
    .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, ordinal_position, field_profiles(field_id, sample_values)')
    .in('table_id', tableIds.length ? tableIds : ['__none__'])
    .order('ordinal_position', { ascending: true })

  const fieldMap = new Map((allFields ?? []).map((f) => [f.id, f]))
  const profileMap = new Map(
    (allFields ?? [])
      .map((f) => {
        const p = Array.isArray(f.field_profiles) ? f.field_profiles[0] : null
        return p ? ([f.id, p] as [string, { field_id: string; sample_values: unknown }]) : null
      })
      .filter((entry): entry is [string, { field_id: string; sample_values: unknown }] => entry !== null)
  )

  // Join table mappings with related data
  const tableMappings: RichTableMapping[] = (rawTMs ?? []).map((tm) => {
    const srcTable = tableMap.get(tm.source_table_id)
    const tgtTable = tableMap.get(tm.target_table_id)
    const fms = (rawFMs ?? []).filter((fm) => fm.table_mapping_id === tm.id)

    const fieldMappings: RichFieldMapping[] = fms
      .map((fm) => {
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
          is_contributing: fm.is_contributing ?? false,
          created_at: fm.created_at,
          sourceField: srcField
            ? { id: srcField.id, name: srcField.name, data_type: srcField.data_type, inferred_type: srcField.inferred_type }
            : null,
          targetField: tgtField
            ? { id: tgtField.id, name: tgtField.name, data_type: tgtField.data_type, inferred_type: tgtField.inferred_type }
            : null,
          sourceFieldSamples: toSamples(srcProfile),
          targetFieldSamples: toSamples(tgtProfile),
          sourceFieldNullPercentage: (srcProfile as { null_percentage?: number } | undefined)?.null_percentage ?? 0,
        }
      })
      // Sort by source field's ordinal_position so mapping rows follow CSV upload order
      .sort((a, b) => {
        const posA = fieldMap.get(a.source_field_id)?.ordinal_position ?? 9999
        const posB = fieldMap.get(b.source_field_id)?.ordinal_position ?? 9999
        return posA - posB
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
  // Only non-rejected mappings count as "active" — a field whose only mapping
  // is rejected should appear in the Unmapped tab and coverage indicator
  const mappedSourceFieldIds = new Set(
    (rawFMs ?? []).filter((fm) => fm.status !== 'rejected').map((fm) => fm.source_field_id)
  )
  const mappedTargetFieldIds = new Set(
    (rawFMs ?? []).filter((fm) => fm.status !== 'rejected').map((fm) => fm.target_field_id)
  )

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
      .map((f) => ({ id: f.id, name: f.name, data_type: f.data_type, is_nullable: f.is_nullable ?? true }))
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

  // Fetch the FM before updating so we can run promotion logic and logging
  const { data: fmBefore } = await supabase
    .from('field_mappings')
    .select('table_mapping_id, source_field_id, target_field_id, confidence, is_contributing')
    .eq('id', fieldMappingId)
    .single()

  const { error } = await supabase
    .from('field_mappings')
    .update({ status })
    .eq('id', fieldMappingId)

  if (error) return { success: false, error: error.message }

  if (fmBefore) {
    // If we're rejecting a PRIMARY mapping, promote the first active contributor for that target
    if (status === 'rejected' && !fmBefore.is_contributing) {
      const { data: contributors } = await supabase
        .from('field_mappings')
        .select('id')
        .eq('table_mapping_id', fmBefore.table_mapping_id)
        .eq('target_field_id', fmBefore.target_field_id)
        .eq('is_contributing', true)
        .neq('status', 'rejected')
        .order('created_at', { ascending: true })
        .limit(1)

      if (contributors && contributors.length > 0) {
        await supabase
          .from('field_mappings')
          .update({ is_contributing: false })
          .eq('id', contributors[0].id)
      }
    }

    // Auto-approve table mapping if all field mappings are approved
    if (status === 'approved') {
      const { data: siblings } = await supabase
        .from('field_mappings')
        .select('status')
        .eq('table_mapping_id', fmBefore.table_mapping_id)

      if (siblings && siblings.every((s) => s.status === 'approved')) {
        await supabase
          .from('table_mappings')
          .update({ status: 'approved' })
          .eq('id', fmBefore.table_mapping_id)
      }
    }

    // Log mapping approval / rejection
    if (status === 'approved' || status === 'rejected') {
      try {
        const { data: tm } = await supabase
          .from('table_mappings')
          .select('project_id')
          .eq('id', fmBefore.table_mapping_id)
          .single()
        const [{ data: srcFld }, { data: tgtFld }] = await Promise.all([
          supabase.from('fields').select('name').eq('id', fmBefore.source_field_id).single(),
          supabase.from('fields').select('name').eq('id', fmBefore.target_field_id).single(),
        ])
        if (tm) {
          const confNote = fmBefore.confidence ? ` (${Math.round(fmBefore.confidence)}% confidence)` : ''
          await logActivity(
            tm.project_id,
            status === 'approved' ? 'mapping_approved' : 'mapping_rejected',
            `Mapping ${status}: ${srcFld?.name ?? '?'} \u2192 ${tgtFld?.name ?? '?'}${status === 'approved' ? confNote : ''}`,
            'mapping',
            {
              field_mapping_id: fieldMappingId,
              source_field: srcFld?.name,
              target_field: tgtFld?.name,
              confidence: fmBefore.confidence,
            }
          )
        }
      } catch {
        // Non-critical
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
  targetFieldId: string,
  isContributing = false,
  aiReasoning?: string
): Promise<{ success: boolean; data?: { id: string; is_contributing: boolean }; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const defaultReasoning = isContributing ? 'Contributing source — manually mapped by user' : 'Manually mapped by user'
  const { data, error } = await supabase
    .from('field_mappings')
    .insert({
      table_mapping_id: tableMappingId,
      source_field_id: sourceFieldId,
      target_field_id: targetFieldId,
      confidence: 100,
      status: 'approved',
      ai_reasoning: aiReasoning ?? defaultReasoning,
      is_contributing: isContributing,
    })
    .select('id, is_contributing')
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, data: { id: data.id, is_contributing: data.is_contributing } }
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

  // Prevent duplicate table mappings for the exact same source→target pair
  const { data: existingMapping } = await supabase
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .eq('source_table_id', sourceTableId)
    .eq('target_table_id', targetTableId)
    .limit(1)

  if (existingMapping && existingMapping.length > 0) {
    const [{ data: srcTableData }, { data: tgtTableData }] = await Promise.all([
      supabase.from('tables').select('name').eq('id', sourceTableId).single(),
      supabase.from('tables').select('name').eq('id', targetTableId).single(),
    ])
    return {
      success: false,
      error: `A mapping from ${srcTableData?.name ?? 'source table'} → ${tgtTableData?.name ?? 'target table'} already exists.`,
    }
  }

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

// ─── regenerateFieldMappings ──────────────────────────────────────────────────

/**
 * Delete all existing field mappings for a table mapping and regenerate them
 * using AI. Ownership is verified before deletion. The regeneration reuses
 * suggestRemainingMappings since all fields will be unmapped after deletion.
 */
export async function regenerateFieldMappings(
  tableMappingId: string
): Promise<{ success: boolean; fieldCount: number; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, fieldCount: 0, error: 'Not authenticated' }

  // Verify ownership by tracing through project
  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, fieldCount: 0, error: 'Table mapping not found' }

  const { data: proj } = await supabase
    .from('projects')
    .select('id')
    .eq('id', tm.project_id)
    .eq('user_id', user.id)
    .single()
  if (!proj) return { success: false, fieldCount: 0, error: 'Access denied' }

  // Delete all existing field mappings for this table pair
  const { error: deleteError } = await supabase
    .from('field_mappings')
    .delete()
    .eq('table_mapping_id', tableMappingId)

  if (deleteError) {
    return { success: false, fieldCount: 0, error: `Failed to clear existing field mappings: ${deleteError.message}` }
  }

  // Verify delete actually cleared the records before proceeding
  const { count: remaining } = await supabase
    .from('field_mappings')
    .select('id', { count: 'exact', head: true })
    .eq('table_mapping_id', tableMappingId)

  if (remaining && remaining > 0) {
    return { success: false, fieldCount: 0, error: 'Could not clear existing field mappings. Please try again.' }
  }

  // Regenerate: with all fields now unmapped, suggestRemainingMappings generates all
  const result = await suggestRemainingMappings(tableMappingId)
  return {
    success: result.success,
    fieldCount: result.newMappingsCount,
    error: result.error,
  }
}

// ─── deleteFieldMapping ───────────────────────────────────────────────────────

export async function deleteFieldMapping(
  fieldMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Fetch before deleting so we can promote a contributor if this is a primary mapping
  const { data: fmBefore } = await supabase
    .from('field_mappings')
    .select('table_mapping_id, target_field_id, is_contributing')
    .eq('id', fieldMappingId)
    .single()

  const { error } = await supabase
    .from('field_mappings')
    .delete()
    .eq('id', fieldMappingId)

  if (error) return { success: false, error: error.message }

  // If a primary was deleted, promote the first active contributor for that target
  if (fmBefore && !fmBefore.is_contributing) {
    const { data: contributors } = await supabase
      .from('field_mappings')
      .select('id')
      .eq('table_mapping_id', fmBefore.table_mapping_id)
      .eq('target_field_id', fmBefore.target_field_id)
      .eq('is_contributing', true)
      .neq('status', 'rejected')
      .order('created_at', { ascending: true })
      .limit(1)

    if (contributors && contributors.length > 0) {
      await supabase
        .from('field_mappings')
        .update({ is_contributing: false })
        .eq('id', contributors[0].id)
    }
  }

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

  const rawSrcDs = srcT?.datasets as unknown
  const srcDsN = Array.isArray(rawSrcDs) ? (rawSrcDs[0]?.name ?? 'source') : ((rawSrcDs as { name?: string } | null)?.name ?? 'source')
  const rawTgtDs = tgtT?.datasets as unknown
  const tgtDsN = Array.isArray(rawTgtDs) ? (rawTgtDs[0]?.name ?? 'target') : ((rawTgtDs as { name?: string } | null)?.name ?? 'target')

  // Build rich AI context for unmapped fields: value distributions + docs
  const remCtx = await buildAIContext(tm.project_id, {
    tableIds: [tm.source_table_id, tm.target_table_id],
    fieldIds: [...unmapSrc.map((f) => f.id), ...unmapTgt.map((f) => f.id)],
    includeValueDistributions: true,
    includeSampleValues: true,
    includeDocuments: true,
    maxDistributionValues: 15,
    maxSampleValues: 5,
  }, user.id)

  // Build per-name context lookups for the fLine formatter
  const srcCtxByName = new Map(
    remCtx.source_tables.flatMap((t) => t.fields).map((f) => [f.name.toLowerCase(), f])
  )
  const tgtCtxByName = new Map(
    remCtx.target_tables.flatMap((t) => t.fields).map((f) => [f.name.toLowerCase(), f])
  )

  type UnmapFieldRow = { id: string; name: string; data_type: string; is_primary_key: boolean; is_foreign_key: boolean; is_nullable: boolean }

  function fLine(f: UnmapFieldRow, ctxByName: Map<string, { value_distribution: { value: string; count: number }[]; sample_values: string[] }>) {
    const tags: string[] = []
    if (f.is_primary_key) tags.push('PK')
    if (f.is_foreign_key) tags.push('FK')
    if (f.is_nullable) tags.push('nullable')
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
    const ctx = ctxByName.get(f.name.toLowerCase())
    let line = `  - ${f.name} (${f.data_type})${tagStr}`
    if (ctx?.value_distribution?.length) {
      const top = ctx.value_distribution.slice(0, 10)
      line += `\n    Values: ${top.map((v) => `"${v.value}"(${v.count})`).join(', ')}`
    } else if (ctx?.sample_values?.length) {
      line += `\n    Samples: ${ctx.sample_values.slice(0, 5).map((v) => `"${v}"`).join(', ')}`
    }
    return line
  }

  const remainingDocBlock = formatDocumentsForPrompt(remCtx.documents)

  const userMsg = `Source ${srcDsN}.${srcT?.name} → Target ${tgtDsN}.${tgtT?.name}. Suggest mappings for these UNMAPPED fields only.

<source_unmapped>
${unmapSrc.map((f) => fLine(f, srcCtxByName)).join('\n')}
</source_unmapped>
<target_unmapped>
${unmapTgt.map((f) => fLine(f, tgtCtxByName)).join('\n')}
</target_unmapped>
${remainingDocBlock}
${remCtx.intelligence_context ? remCtx.intelligence_context + '\n\n' : ''}CRITICAL: Use ONLY the bare field name (not table.field). Respond with ONLY valid JSON:
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
      needs_transformation: fm.needs_transformation ?? null,
    })
  }

  if (inserts.length > 0) {
    // De-duplicate: re-fetch any field_mappings that may have been created between
    // our initial "find unmapped" check and this insert (handles race conditions / double-calls)
    const { data: latestFMs } = await supabase
      .from('field_mappings')
      .select('source_field_id')
      .eq('table_mapping_id', tableMappingId)
    const alreadyMappedSrcIds = new Set((latestFMs ?? []).map((fm) => fm.source_field_id))
    const safeInserts = inserts.filter((i) => !alreadyMappedSrcIds.has(i.source_field_id as string))

    if (safeInserts.length > 0) {
      await supabase.from('field_mappings').insert(safeInserts)
    }

    // Recompute table-level confidence from ALL field mappings (including any pre-existing ones)
    const { data: allFMs } = await supabase
      .from('field_mappings')
      .select('confidence')
      .eq('table_mapping_id', tableMappingId)

    const confidences = (allFMs ?? [])
      .map((fm) => fm.confidence)
      .filter((c): c is number => c !== null && c !== undefined)

    if (confidences.length > 0) {
      const avgConfidence = Math.round(
        confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      )
      await supabase
        .from('table_mappings')
        .update({
          confidence: avgConfidence,
          // Only set ai_reasoning if the table mapping was created manually (null reasoning)
          // — don't overwrite reasoning already set by generateMappings
          ...(tm.ai_reasoning === null && {
            ai_reasoning: `Auto-generated ${confidences.length} field mapping${confidences.length !== 1 ? 's' : ''}. Average confidence: ${avgConfidence}%.`,
          }),
        })
        .eq('id', tableMappingId)
    }
  }

  return { success: true, newMappingsCount: inserts.length }
}

// ─── mapUnmappedField ─────────────────────────────────────────────────────────

export async function mapUnmappedField(
  projectId: string,
  sourceFieldId: string,
  targetFieldId: string,
  isContributing = false
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
    ai_reasoning: isContributing ? 'Contributing source — manually mapped by user' : 'Manually mapped by user',
    is_contributing: isContributing,
  })

  if (fmErr) return { success: false, error: fmErr.message }
  return { success: true }
}
