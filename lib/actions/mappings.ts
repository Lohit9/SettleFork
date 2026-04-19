'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatSchemaForPrompt, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { logActivity } from '@/lib/actions/activity-log'
import { resetFieldTransform, resetAllTransformsForTable, checkFieldMappingHasTransform } from '@/lib/actions/transformations'

export { checkFieldMappingHasTransform }

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
  source_field_id: string | null
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
  /** Whether the underlying column is declared NULLable. Drives the
   *  "required — needs mapping" warning on unmapped target rows. */
  is_nullable?: boolean
  /** Raw DEFAULT expression from the target DDL (migration 064). When set,
   *  the target column will auto-populate on INSERT even if unmapped, so
   *  the UI shows a muted "has default" hint rather than a warning. */
  default_value?: string | null
}

export interface SimpleField {
  id: string
  name: string
  data_type: string
  is_nullable?: boolean
  /** Raw DEFAULT from DDL / information_schema (migration 064). Used by
   *  the mapping UI to distinguish "unmapped but self-populating" target
   *  fields from "unmapped and will fail on INSERT" target fields. */
  default_value?: string | null
}

export interface FieldAcknowledgmentRow {
  id: string
  project_id: string
  field_id: string
  side: string
  reason: string
  notes: string | null
  acknowledged_at: string
}

export interface MappingsResult {
  tableMappings: RichTableMapping[]
  unmappedSourceFields: UnmappedField[]
  unmappedTargetFields: UnmappedField[]
  allSourceTables: { id: string; name: string; datasetName: string }[]
  allTargetTables: { id: string; name: string; datasetName: string }[]
  /** All fields for every table in the project, keyed by table_id */
  allFieldsByTable: Record<string, SimpleField[]>
  /** Persisted acknowledgments for unmapped fields */
  acknowledgments: FieldAcknowledgmentRow[]
}

// ─── Helper: parse Claude JSON with fence stripping ───────────────────────────

function parseClaudeJSON(raw: string): ClaudeResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }

  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed.table_mappings || !Array.isArray(parsed.table_mappings)) {
      throw new Error('Invalid response: missing table_mappings array')
    }
    return parsed as ClaudeResponse
  } catch (err) {
    // If the response looks truncated (long, and doesn't close its outer
    // container), surface that up front so logs point at the real cause
    // before the caller's retry path runs.
    const trimmed = cleaned.trimEnd()
    const isLikelyTruncation =
      cleaned.length > 500 && !trimmed.endsWith('}') && !trimmed.endsWith(']')

    if (isLikelyTruncation) {
      console.error(
        `[Mapping] Response appears truncated (${cleaned.length} chars). ` +
          `Last 100 chars: "${cleaned.slice(-100)}"`
      )
    }

    throw err
  }
}

// ─── Shared mapping-generation helpers ────────────────────────────────────────

/**
 * Strip a dataset/table prefix from a qualified name (e.g., "trux.prices" → "prices"
 * or "ARTICLE_PRICES.PRICE" → "PRICE") and normalize to lowercase. Used to make
 * Claude's response tolerant of occasional qualified-name drift.
 */
function bareTableName(s: string | null | undefined): string {
  if (!s || typeof s !== 'string') return ''
  const parts = s.split('.')
  return parts[parts.length - 1].toLowerCase().trim()
}

/**
 * The canonical system prompt for AI mapping generation. Used by BOTH the
 * initial generation path (generateMappings) and the regeneration path
 * (runMappingGenerationForPair). Keeping this as a shared module-level const
 * guarantees the two paths produce identical quality — particularly around
 * many-to-one and one-to-many pattern detection. Do not duplicate this string.
 */
const MAPPING_GENERATION_SYSTEM_PROMPT = `You are an enterprise data migration expert specializing in source-to-target schema mapping. Given source and target database schemas with sample data and optional documentation context, generate comprehensive mapping suggestions.

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

TABLE-LEVEL MATCHING — WHEN TO EMIT A table_mapping:

You process ONE source table per request, but the migration contains OTHER source tables that will be processed in separate requests. When the user message includes an <other_source_tables> block, use that list to decide which targets actually deserve a mapping from the current source.

Rules for emitting table_mappings:

1. PRIMARY-MATCH RULE: Only emit a table_mapping when the current source table is the best (or a strong secondary) semantic match for the target. If another source table listed in <other_source_tables> is clearly a better primary match for a target — based on name similarity, field overlap, or business meaning — DO NOT emit a table_mapping to that target from the current source. Let the better-matching source table claim it when its own batch runs.

2. LOOKUP / REFERENCE TABLES: Narrow source tables whose shape is a code + description (typically 2-4 columns like CODE + DESC, ID + NAME, TYPE + LABEL — e.g., STATUS_CODES, COUNTRY_CODES, CURRENCY_CODES, PRODUCT_TYPES) represent enumerated reference data. They should map to AT MOST ONE target — the target table that stores the SAME enumeration (e.g., STATUS_CODES → account_status, COUNTRY_CODES → countries). They MUST NOT map to entity tables (customers, accounts, orders, contacts) even when an entity table has a matching status/type/code column — that column is populated via a foreign-key join at the field level, not by copying rows from the lookup table into the entity. Emitting a lookup → entity table_mapping is almost always wrong.

3. ENTITY TABLES: Wide tables representing business entities (e.g., CIF_MASTER → customers, ACCT_MASTER → accounts) should map to their corresponding entity target. Legitimate one-to-many entity mappings exist (denormalization, splitting), but each must have clear field-level overlap — not just one or two coincidental columns.

4. WEAK-OVERLAP RULE: If the current source has weak field overlap with a candidate target (fewer than roughly a third of the source's non-trivial fields map, OR only generic fields like id / name / created_at / updated_at match), DO NOT emit a table_mapping to that target — the target almost certainly belongs to a different source table. It is better to emit zero table_mappings for the current source than to emit low-quality mappings that the user will have to reject.

5. When in doubt between two candidate targets, pick the ONE target whose name and field set most closely mirrors the current source, and skip the others.

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
- Set higher confidence scores when documentation confirms a mapping from a business logic perspective. If documentation describes different data types or constraints than the structured schema, always follow the structured schema — it reflects the user's latest configuration.

CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.`

/**
 * Build the user-facing message for a mapping generation Claude call.
 * Shared by generateMappings (which may render multiple target tables in
 * `targetSection`) and runMappingGenerationForPair (which renders a single
 * target). The JSON structure, CRITICAL RULES, and example rows are
 * identical in both paths to guarantee consistent output quality.
 */
function buildMappingUserMessage(args: {
  sourceSection: string
  targetSection: string
  docBlock: string
  intelligenceCtx: string | null
  /** Optional cross-table awareness block listing the OTHER source tables
   *  in this migration (field names only) so Claude can avoid emitting
   *  spurious table_mappings when another source is a better primary match. */
  otherSourcesBlock?: string | null
}): string {
  const { sourceSection, targetSection, docBlock, intelligenceCtx, otherSourcesBlock } = args
  return `${sourceSection}
${targetSection}
${docBlock}
${intelligenceCtx ? intelligenceCtx + '\n\n' : ''}${otherSourcesBlock ? otherSourcesBlock + '\n\n' : ''}Generate source-to-target mappings. Respond with this exact JSON structure.

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
}

/**
 * Run AI mapping generation for a single (source_table, target_table) pair
 * against an EXISTING table_mapping row, writing new field_mappings (primary
 * + is_contributing rows for many-to-one, separate rows per target for
 * one-to-many) all at status='needs_review'.
 *
 * This is the "full-quality" generation path used by regenerateFieldMappings.
 * It deliberately uses the same system prompt, same user-message template,
 * same AI context options, and same insert logic as generateMappings — the
 * only difference is that it is scoped to a single pair and reuses the
 * caller's tableMappingId instead of creating a new table_mappings row.
 */
async function runMappingGenerationForPair(args: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  projectId: string
  tableMappingId: string
  sourceTableId: string
  targetTableId: string
}): Promise<{ inserted: number; error?: string }> {
  const { supabase, userId, projectId, tableMappingId, sourceTableId, targetTableId } = args

  try {
    // Fetch source + target table metadata (for name-based response matching)
    const [{ data: sourceTables, error: stErr }, { data: targetTables, error: ttErr }] = await Promise.all([
      supabase
        .from('tables')
        .select('id, name, dataset_id, datasets(id, name)')
        .eq('id', sourceTableId),
      supabase
        .from('tables')
        .select('id, name, dataset_id, datasets(id, name)')
        .eq('id', targetTableId),
    ])
    if (stErr) return { inserted: 0, error: stErr.message }
    if (ttErr) return { inserted: 0, error: ttErr.message }
    if (!sourceTables?.length || !targetTables?.length) {
      return { inserted: 0, error: 'Source or target table not found' }
    }

    // Fetch source + target fields for name→id resolution during insert
    const [{ data: sourceFields, error: sfErr }, { data: targetFields, error: tfErr }] = await Promise.all([
      supabase
        .from('fields')
        .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
        .eq('table_id', sourceTableId)
        .order('ordinal_position', { ascending: true }),
      supabase
        .from('fields')
        .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
        .eq('table_id', targetTableId)
        .order('ordinal_position', { ascending: true }),
    ])
    if (sfErr) return { inserted: 0, error: sfErr.message }
    if (tfErr) return { inserted: 0, error: tfErr.message }

    // Rich AI context — IDENTICAL options to generateMappings so regenerate
    // output quality matches initial generation.
    const aiCtx = await buildAIContext(projectId, {
      tableIds: [sourceTableId, targetTableId],
      includeProfilingStats: true,
      includeValueDistributions: true,
      includeSampleValues: true,
      includeDocuments: true,
      maxDistributionValues: 15,
      maxSampleValues: 5,
    }, userId)

    const sourceCtx = aiCtx.source_tables[0]
    if (!sourceCtx) {
      return { inserted: 0, error: 'Source table context could not be built' }
    }

    const sourceSection = formatSchemaForPrompt([sourceCtx], 'source')
    const targetSection = formatSchemaForPrompt(aiCtx.target_tables, 'target')
    const docBlock = formatDocumentsForPrompt(aiCtx.documents)
    const userMessage = buildMappingUserMessage({
      sourceSection,
      targetSection,
      docBlock,
      intelligenceCtx: aiCtx.intelligence_context ?? null,
    })

    // Same token budget as generateMappings' per-batch calls so large schemas
    // (hundreds of fields) don't truncate mid-JSON.
    const PER_BATCH_MAX_TOKENS = 16000

    let raw: string
    try {
      raw = await callClaude(MAPPING_GENERATION_SYSTEM_PROMPT, userMessage, PER_BATCH_MAX_TOKENS)
    } catch (err) {
      console.error(`[Mapping] Claude call failed for pair ${sourceTables[0].name} → ${targetTables[0].name}:`, err)
      return { inserted: 0, error: err instanceof Error ? err.message : 'Claude call failed' }
    }

    let parsedResponse: ClaudeResponse
    try {
      parsedResponse = parseClaudeJSON(raw)
    } catch {
      // Retry once asking Claude to repair the JSON — same budget as the
      // original call so the repair isn't itself truncated.
      try {
        const retryRaw = await callClaude(
          'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
          `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${raw}`,
          PER_BATCH_MAX_TOKENS
        )
        parsedResponse = parseClaudeJSON(retryRaw)
      } catch (retryErr) {
        console.error(`[Mapping] Failed to parse response for pair ${sourceTables[0].name} → ${targetTables[0].name} after retry:`, retryErr)
        return { inserted: 0, error: 'AI returned invalid response. Please try again.' }
      }
    }

    // Name→id lookup maps (case-insensitive, bare name)
    const srcFieldMap = new Map((sourceFields ?? []).map((f) => [f.name.toLowerCase(), f]))
    const tgtFieldMap = new Map((targetFields ?? []).map((f) => [f.name.toLowerCase(), f]))

    const srcTableKey = sourceTables[0].name.toLowerCase()
    const tgtTableKey = targetTables[0].name.toLowerCase()

    // Build inserts across all table_mappings in the response that match our
    // pair. Claude usually returns a single TM for a single-pair call, but
    // be defensive about unexpected extras.
    const fieldInserts: Record<string, unknown>[] = []

    for (const tm of parsedResponse.table_mappings ?? []) {
      if (!tm.source_table || !tm.target_table) continue
      if (bareTableName(tm.source_table) !== srcTableKey || bareTableName(tm.target_table) !== tgtTableKey) {
        console.warn(`[mappings] Skipping unexpected TM in single-pair response: "${tm.source_table}" → "${tm.target_table}"`)
        continue
      }

      for (const fm of tm.field_mappings ?? []) {
        const srcFieldKey = bareTableName(fm.source_field)
        const tgtFieldKey = bareTableName(fm.target_field)
        const srcField = srcFieldMap.get(srcFieldKey)
        const tgtField = tgtFieldMap.get(tgtFieldKey)
        if (!srcField || !tgtField) {
          console.warn(`[mappings] Field no match: "${fm.source_field}" → "${fm.target_field}"`)
          continue
        }

        const mappingType = fm.mapping_type || 'one_to_one'

        let reasoningText = fm.reasoning
        if (fm.combination_hint) reasoningText += ` [Combination: ${fm.combination_hint}]`
        if (fm.split_hint) reasoningText += ` [Split: ${fm.split_hint}]`

        // Primary row (always inserted). For one-to-many, each target gets
        // its own primary row here because Claude emits a separate entry
        // per target sharing the same source_field.
        fieldInserts.push({
          table_mapping_id: tableMappingId,
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

        // Many-to-one: emit is_contributing rows for each additional source
        // field pointing at the same target.
        if (mappingType === 'many_to_one' && fm.contributing_source_fields?.length) {
          for (const contribFieldName of fm.contributing_source_fields) {
            const contribField = srcFieldMap.get(bareTableName(contribFieldName))
            if (!contribField) {
              console.warn(`[mappings] Contributing field "${contribFieldName}" not found in source table — skipping`)
              continue
            }
            fieldInserts.push({
              table_mapping_id: tableMappingId,
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
      }
    }

    if (fieldInserts.length > 0) {
      const { error: insErr } = await supabase.from('field_mappings').insert(fieldInserts)
      if (insErr) return { inserted: 0, error: insErr.message }
    }

    return { inserted: fieldInserts.length }
  } catch (err) {
    console.error('runMappingGenerationForPair error:', err)
    return { inserted: 0, error: err instanceof Error ? err.message : 'Mapping generation failed' }
  }
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

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
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
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
      .in('table_id', sourceTableIds)
      .order('ordinal_position', { ascending: true })
    if (sfErr) throw sfErr

    const { data: targetFields, error: tfErr } = await supabase
      .from('fields')
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
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

    // Target schema + docs + intelligence are constant across all batches —
    // render them once. Source schema is rebuilt per-batch inside the loop.
    const targetSection = formatSchemaForPrompt(aiCtx.target_tables, 'target')
    const docBlock = formatDocumentsForPrompt(aiCtx.documents)

    // Cross-table awareness: compact field-name-only listing of EVERY source
    // table, indexed by table id. The per-batch loop uses this to render an
    // <other_source_tables> block excluding the current source so Claude can
    // decline to map e.g. STATUS_CODES → customers when CIF_MASTER is the
    // obvious primary match for customers.
    const sourceFieldNamesByTableId = new Map<string, string[]>()
    for (const f of sourceFields ?? []) {
      const list = sourceFieldNamesByTableId.get(f.table_id) ?? []
      list.push(f.name)
      sourceFieldNamesByTableId.set(f.table_id, list)
    }
    const sourceTableRowsByNameKey = new Map(
      (sourceTables ?? []).map((t) => [t.name.toLowerCase(), t])
    )

    // Batch by source table — one Claude call per source table against ALL
    // target tables. Bounds each response well under the max_tokens cap so
    // large schemas (8×8 with hundreds of fields) don't truncate mid-JSON.
    const PER_BATCH_MAX_TOKENS = 16000
    const allTableMappings: ClaudeTableMapping[] = []
    const sourceTablesForBatching = aiCtx.source_tables

    for (let i = 0; i < sourceTablesForBatching.length; i++) {
      const sourceCtx = sourceTablesForBatching[i]
      console.log(
        `[Mapping] Generating mappings for ${sourceCtx.table_name} ` +
          `(${i + 1}/${sourceTablesForBatching.length})...`
      )

      const sourceSection = formatSchemaForPrompt([sourceCtx], 'source')

      // Build the cross-table awareness block for this batch. Skip if this
      // is the only source table — the block would be empty and the primary-
      // match rule in the system prompt is moot with a single source.
      const currentSourceRow = sourceTableRowsByNameKey.get(sourceCtx.table_name.toLowerCase())
      const otherSourcesList = (sourceTables ?? [])
        .filter((st) => st.id !== currentSourceRow?.id)
        .map((st) => {
          const fields = sourceFieldNamesByTableId.get(st.id) ?? []
          return `  - ${st.name} (${fields.join(', ')})`
        })
        .join('\n')

      const otherSourcesBlock = otherSourcesList
        ? `<other_source_tables>
These other source tables also exist in this migration and will be processed separately in their own requests. Use this information to decide whether the current source table (${sourceCtx.table_name}) is the best primary match for each target table. If another source table listed below is clearly a better primary match for a target, do NOT create a table_mapping to that target from ${sourceCtx.table_name} — let the better-matching source claim it in its own batch.

See the TABLE-LEVEL MATCHING rules in the system prompt for lookup/reference tables vs entity tables and weak-overlap handling.

${otherSourcesList}
</other_source_tables>`
        : ''

      const batchUserMessage = buildMappingUserMessage({
        sourceSection,
        targetSection,
        docBlock,
        intelligenceCtx: aiCtx.intelligence_context ?? null,
        otherSourcesBlock,
      })

      let batchRaw: string
      try {
        batchRaw = await callClaude(MAPPING_GENERATION_SYSTEM_PROMPT, batchUserMessage, PER_BATCH_MAX_TOKENS)
      } catch (err) {
        console.error(
          `[Mapping] Claude call failed for source table ${sourceCtx.table_name}:`,
          err
        )
        continue
      }

      try {
        const batchParsed = parseClaudeJSON(batchRaw)
        allTableMappings.push(...(batchParsed.table_mappings ?? []))
      } catch {
        // Retry once asking Claude to fix the JSON — use the same token
        // budget as the original call so the repair isn't itself truncated.
        try {
          const retryRaw = await callClaude(
            'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
            `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${batchRaw}`,
            PER_BATCH_MAX_TOKENS
          )
          const retryParsed = parseClaudeJSON(retryRaw)
          allTableMappings.push(...(retryParsed.table_mappings ?? []))
        } catch (retryErr) {
          console.error(
            `[Mapping] Failed to parse mappings for source table ${sourceCtx.table_name} after retry:`,
            retryErr
          )
          // Continue with other source tables — don't fail the entire batch
        }
      }
    }

    const parsedResponse: ClaudeResponse = { table_mappings: allTableMappings }

    // Additive generation — fetch existing pairs so we can skip them instead of deleting
    const { data: existingMappingPairs } = await supabase
      .from('table_mappings')
      .select('source_table_id, target_table_id')
      .eq('project_id', projectId)

    const existingPairSet = new Set(
      (existingMappingPairs ?? []).map((m) => `${m.source_table_id}::${m.target_table_id}`)
    )
    let skippedCount = 0

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

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return null

  // Hop 2: everything that only needs projectId — run in parallel
  const [{ data: allDatasets }, { data: rawTMs }, { data: rawAcks }] = await Promise.all([
    supabase.from('datasets').select('id, name, role').eq('project_id', projectId),
    supabase.from('table_mappings').select('*').eq('project_id', projectId).order('created_at', { ascending: true }),
    supabase.from('field_acknowledgments').select('id, project_id, field_id, side, reason, notes, acknowledged_at').eq('project_id', projectId),
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
    .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, ordinal_position, default_value, field_profiles(field_id, sample_values)')
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
        const srcField = fm.source_field_id ? (fieldMap.get(fm.source_field_id) ?? null) : null
        const tgtField = fieldMap.get(fm.target_field_id) ?? null
        const srcProfile = fm.source_field_id ? profileMap.get(fm.source_field_id) : undefined
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
      .sort((a, b) => {
        if (!a.source_field_id && b.source_field_id) return 1
        if (a.source_field_id && !b.source_field_id) return -1
        const posA = a.source_field_id ? (fieldMap.get(a.source_field_id)?.ordinal_position ?? 9999) : 9999
        const posB = b.source_field_id ? (fieldMap.get(b.source_field_id)?.ordinal_position ?? 9999) : 9999
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
    (rawFMs ?? []).filter((fm) => fm.status !== 'rejected' && fm.source_field_id).map((fm) => fm.source_field_id as string)
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
      .map((f) => ({
        id: f.id,
        name: f.name,
        data_type: f.data_type,
        is_nullable: f.is_nullable ?? true,
        // Surfaced so the mapping UI can render the "has default" hint
        // and the "required" warning without an extra round-trip.
        default_value: (f as { default_value?: string | null }).default_value ?? null,
      }))
  }

  const acknowledgments: FieldAcknowledgmentRow[] = (rawAcks ?? []) as FieldAcknowledgmentRow[]

  return { tableMappings, unmappedSourceFields, unmappedTargetFields, allSourceTables, allTargetTables, allFieldsByTable, acknowledgments }
}

// ─── recomputeTableMappingStatus ──────────────────────────────────────────────

/**
 * Re-evaluates a table mapping's status after a child field_mapping was
 * deleted, rejected, approved, or an acknowledgment was added/removed.
 * Unifies promote and demote paths so TM.status always reflects the
 * current truth of its non-rejected FMs + target-field coverage.
 *
 * Rule: TM is `approved` iff
 *   (a) it has at least one non-rejected FM, AND
 *   (b) every non-rejected FM is `approved`, AND
 *   (c) every target field on the target table is either covered by a
 *       non-rejected FM or acknowledged in field_acknowledgments.
 * Otherwise it is `needs_review`.
 *
 * Rejected FM rows are ignored — under the rejection-is-deletion UX
 * they are legacy ghosts that must not block either direction.
 */
export async function recomputeTableMappingStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tableMappingId: string
): Promise<void> {
  // 1. Every non-rejected FM on the TM must be approved.
  const { data: siblings } = await supabase
    .from('field_mappings')
    .select('status, target_field_id, source_field_id')
    .eq('table_mapping_id', tableMappingId)
    .neq('status', 'rejected')

  const rows = siblings ?? []
  const allMappingsApproved = rows.length > 0 && rows.every((s) => s.status === 'approved')

  // 2. Every target field must be mapped or acknowledged.
  // 3. Every source field must be mapped or acknowledged (else it would
  //    silently drop during migration).
  let allTargetFieldsCovered = true
  let allSourceFieldsCovered = true
  const { data: tm } = await supabase
    .from('table_mappings')
    .select('target_table_id, source_table_id, project_id')
    .eq('id', tableMappingId)
    .single()

  if (tm) {
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.target_table_id)

    const mappedTargetIds = new Set(
      rows.map((r) => r.target_field_id).filter((id): id is string => Boolean(id))
    )

    const { data: acks } = await supabase
      .from('field_acknowledgments')
      .select('field_id')
      .eq('project_id', tm.project_id)

    const acknowledgedIds = new Set((acks ?? []).map((a) => a.field_id))

    const uncoveredFields = (targetFields ?? []).filter(
      (f) => !mappedTargetIds.has(f.id) && !acknowledgedIds.has(f.id)
    )

    allTargetFieldsCovered = uncoveredFields.length === 0

    const { data: sourceFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.source_table_id)

    // Contributing rows carry source_field_id too, so they count as "mapped"
    // on the source side — matching the unmapped-source computation in
    // getMappings and MappingContent.
    const mappedSourceIds = new Set(
      rows.map((r) => r.source_field_id).filter((id): id is string => Boolean(id))
    )

    const uncoveredSourceFields = (sourceFields ?? []).filter(
      (f) => !mappedSourceIds.has(f.id) && !acknowledgedIds.has(f.id)
    )

    allSourceFieldsCovered = uncoveredSourceFields.length === 0
  }

  const shouldBeApproved =
    allMappingsApproved && allTargetFieldsCovered && allSourceFieldsCovered

  await supabase
    .from('table_mappings')
    .update({ status: shouldBeApproved ? 'approved' : 'needs_review' })
    .eq('id', tableMappingId)
}

// ─── updateFieldMappingStatus ─────────────────────────────────────────────────

export async function updateFieldMappingStatus(
  fieldMappingId: string,
  status: 'approved' | 'rejected' | 'needs_review'
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: fmLookup } = await supabaseAdmin.from('field_mappings').select('table_mapping_id, table_mappings!inner(project_id)').eq('id', fieldMappingId).single()
  if (!fmLookup) return { success: false, error: 'Mapping not found' }
  const perm = await requireProjectPermission((fmLookup as any).table_mappings.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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

    // Propagate status to contributors so the user's decision on the primary
    // covers the whole many-to-one group. Without this, contributors stuck at
    // 'needs_review' block table auto-promotion forever, because the chip UI
    // no longer exposes per-contributor approve buttons.
    if (!fmBefore.is_contributing && (status === 'approved' || status === 'rejected')) {
      await supabase
        .from('field_mappings')
        .update({ status })
        .eq('table_mapping_id', fmBefore.table_mapping_id)
        .eq('target_field_id', fmBefore.target_field_id)
        .eq('is_contributing', true)
    }

    // Re-evaluate table mapping status (promote or demote) so it reflects the
    // current state of non-rejected children after this write.
    await recomputeTableMappingStatus(supabase, fmBefore.table_mapping_id)

    // Log mapping approval / rejection
    if (status === 'approved' || status === 'rejected') {
      try {
        const { data: tm } = await supabase
          .from('table_mappings')
          .select('project_id')
          .eq('id', fmBefore.table_mapping_id)
          .single()
        const srcFld = fmBefore.source_field_id
          ? (await supabase.from('fields').select('name').eq('id', fmBefore.source_field_id).single()).data
          : null
        const { data: tgtFld } = await supabase.from('fields').select('name').eq('id', fmBefore.target_field_id).single()
        if (tm) {
          const confNote = fmBefore.confidence ? ` (${Math.round(fmBefore.confidence)}% confidence)` : ''
          await logActivity(
            tm.project_id,
            status === 'approved' ? 'mapping_approved' : 'mapping_rejected',
            `Mapping ${status}: ${srcFld?.name ?? '[value]'} \u2192 ${tgtFld?.name ?? '?'}${status === 'approved' ? confNote : ''}`,
            'mapping',
            {
              field_mapping_id: fieldMappingId,
              source_field: srcFld?.name,
              target_field: tgtFld?.name,
              confidence: fmBefore.confidence,
            }
          )
          revalidatePath(`/app/projects/${tm.project_id}/transform`)
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

  const { data: tmLookup } = await supabaseAdmin.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (!tmLookup) return { success: false, error: 'Table mapping not found' }
  const perm = await requireProjectPermission(tmLookup.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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
    source_field_id?: string
    confidence?: number | null
    ai_reasoning?: string
    type_compatibility?: string | null
    is_contributing?: boolean
  }
): Promise<{ success: boolean; transformReset?: boolean; stagedRowsReverted?: number; valueAssignmentReplaced?: boolean; becameContributing?: boolean; promotedContributor?: boolean; fkDependentsReset?: number; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: fmLookup } = await supabaseAdmin.from('field_mappings').select('table_mapping_id, table_mappings!inner(project_id)').eq('id', fieldMappingId).single()
  if (!fmLookup) return { success: false, error: 'Mapping not found' }
  const perm = await requireProjectPermission((fmLookup as any).table_mappings.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // If the source or target field is changing, reset the existing transform and
  // revert any staged data that was written under the old field mapping.
  let transformReset = false
  let stagedRowsReverted = 0
  let valueAssignmentReplaced = false
  let promotedContributor = false
  let fkDependentsReset = 0

  if (updates.target_field_id || updates.source_field_id) {
    const resetResult = await resetFieldTransform(fieldMappingId)
    transformReset = resetResult.hadTransform
    stagedRowsReverted = resetResult.rowsReverted
    fkDependentsReset = resetResult.fkDependentsReset ?? 0
    stagedRowsReverted += resetResult.fkRowsReverted ?? 0
  }

  // If target is changing, handle old-target cleanup and new-target conflicts
  if (updates.target_field_id) {
    const tableMappingId = fmLookup.table_mapping_id

    // ── B: Handle the OLD target's contributors ────────────────────────────
    // Fetch current state before the update so we know what we're leaving behind
    const { data: currentFM } = await supabaseAdmin
      .from('field_mappings')
      .select('target_field_id, is_contributing')
      .eq('id', fieldMappingId)
      .single()

    if (currentFM && updates.target_field_id !== currentFM.target_field_id) {
      if (!currentFM.is_contributing) {
        // This mapping is the PRIMARY for the old target — look for contributors to promote
        const { data: oldContributors } = await supabaseAdmin
          .from('field_mappings')
          .select('id')
          .eq('table_mapping_id', tableMappingId)
          .eq('target_field_id', currentFM.target_field_id)
          .eq('is_contributing', true)
          .neq('status', 'rejected')
          .order('created_at', { ascending: true })

        if (oldContributors && oldContributors.length > 0) {
          // Promote the oldest contributor to primary
          await supabaseAdmin
            .from('field_mappings')
            .update({ is_contributing: false })
            .eq('id', oldContributors[0].id)
          // Reset its transform — it's now the primary and needs fresh SQL
          await resetFieldTransform(oldContributors[0].id)
          promotedContributor = true
        }
      } else {
        // This mapping is a CONTRIBUTOR leaving the old target.
        // Reset the primary's transform since it's losing a contributing source.
        const { data: oldPrimary } = await supabaseAdmin
          .from('field_mappings')
          .select('id')
          .eq('table_mapping_id', tableMappingId)
          .eq('target_field_id', currentFM.target_field_id)
          .eq('is_contributing', false)
          .neq('status', 'rejected')
          .limit(1)

        if (oldPrimary && oldPrimary.length > 0) {
          const oldPrimaryReset = await resetFieldTransform(oldPrimary[0].id)
          stagedRowsReverted += oldPrimaryReset.rowsReverted
        }
      }
    }

    // ── A: Determine is_contributing for the NEW target ───────────────────
    // Replace any value assignment on the new target first
    const vaResult = await replaceValueAssignment(tableMappingId, updates.target_field_id)
    if (vaResult.transformReset) valueAssignmentReplaced = true
    stagedRowsReverted += vaResult.rowsReverted

    // Check if the new target already has a primary (after VA removal)
    const { data: existingPrimary } = await supabaseAdmin
      .from('field_mappings')
      .select('id')
      .eq('table_mapping_id', tableMappingId)
      .eq('target_field_id', updates.target_field_id)
      .eq('is_contributing', false)
      .neq('status', 'rejected')
      .neq('id', fieldMappingId)
      .limit(1)

    if (existingPrimary && existingPrimary.length > 0) {
      // New target already has a primary — incoming becomes contributing
      updates.is_contributing = true
      // Reset the existing primary's transform since its inputs are growing
      const conflict = await handleTargetFieldConflict(tableMappingId, updates.target_field_id, fieldMappingId)
      for (const existing of conflict.existingMappings) {
        if (!existing.isValueAssignment && existing.hasTransform) {
          const existingReset = await resetFieldTransform(existing.id)
          stagedRowsReverted += existingReset.rowsReverted
        }
      }
    } else {
      // No existing primary — incoming is the primary
      updates.is_contributing = false
    }
  }

  const { error } = await supabase
    .from('field_mappings')
    .update({ ...updates, status: 'needs_review' })
    .eq('id', fieldMappingId)

  if (error) return { success: false, error: error.message }

  return {
    success: true,
    transformReset,
    stagedRowsReverted,
    valueAssignmentReplaced,
    becameContributing: updates.is_contributing === true,
    promotedContributor,
    fkDependentsReset,
  }
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

  const { data: tmLookup } = await supabaseAdmin.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (!tmLookup) return { success: false, error: 'Table mapping not found' }
  const perm = await requireProjectPermission(tmLookup.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Replace any value assignment on the target before creating the real mapping
  if (!isContributing) {
    await replaceValueAssignment(tableMappingId, targetFieldId)
  }

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

  const { data: tm } = await supabase.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (tm) revalidatePath(`/app/projects/${tm.project_id}/transform`)

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

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
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
): Promise<{ success: boolean; fieldCount: number; transformsReset?: number; stagedRowsReverted?: number; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, fieldCount: 0, error: 'Not authenticated' }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, fieldCount: 0, error: 'Table mapping not found' }
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, fieldCount: 0, error: perm.error }

  // Clear staged data BEFORE deleting field mappings.
  // Cascade on field_mapping → transformations handles the transform rows, but
  // staged_data_rows is only linked to table_mappings (no per-field-mapping FK),
  // so stale JSONB keys would persist without this explicit cleanup.
  const resetResult = await resetAllTransformsForTable(tableMappingId)

  // Delete all existing field mappings for this table pair
  // (cascade-deletes their transformations rows automatically)
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

  // Regeneration is a "start fresh" action — the user is explicitly asking to
  // re-evaluate the whole table. Clear any acknowledgments on both the target
  // and source table's fields so previously-dismissed unmapped columns get
  // re-surfaced for review, and demote the TM to `needs_review` so the status
  // badge reflects the fact that the old mappings are gone before the AI
  // produces new ones. (Without this reset the TM would keep whatever status
  // it had pre-regenerate, e.g. a stale `approved`.)
  const { data: tmMeta } = await supabase
    .from('table_mappings')
    .select('source_table_id, target_table_id, project_id')
    .eq('id', tableMappingId)
    .single()

  if (tmMeta) {
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tmMeta.target_table_id)

    const targetFieldIds = (targetFields ?? []).map((f) => f.id)
    if (targetFieldIds.length > 0) {
      await supabase
        .from('field_acknowledgments')
        .delete()
        .eq('project_id', tmMeta.project_id)
        .in('field_id', targetFieldIds)
    }

    const { data: sourceFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tmMeta.source_table_id)

    const sourceFieldIds = (sourceFields ?? []).map((f) => f.id)
    if (sourceFieldIds.length > 0) {
      await supabase
        .from('field_acknowledgments')
        .delete()
        .eq('project_id', tmMeta.project_id)
        .in('field_id', sourceFieldIds)
    }
  }

  await supabase
    .from('table_mappings')
    .update({ status: 'needs_review' })
    .eq('id', tableMappingId)

  if (!tmMeta) {
    return { success: false, fieldCount: 0, error: 'Table mapping metadata not available' }
  }

  // Rate-limit the AI call the same way generateMappings and
  // suggestRemainingMappings do — regenerate makes one Claude call.
  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) {
    return { success: false, fieldCount: 0, error: rateLimit.error }
  }

  // Regenerate using the SHARED full-quality generation helper. This uses the
  // same system prompt, same AI context options, and same insert logic as
  // the initial generateMappings path, so many-to-one (FNAME+LNAME+MI →
  // full_name) and one-to-many (FULL_ADDR → street/city/state/zip) patterns
  // are preserved on regeneration.
  const genResult = await runMappingGenerationForPair({
    supabase,
    userId: user.id,
    projectId: tmMeta.project_id,
    tableMappingId,
    sourceTableId: tmMeta.source_table_id,
    targetTableId: tmMeta.target_table_id,
  })

  // Recompute table-level confidence from all newly-inserted field mappings.
  // Mirrors suggestRemainingMappings's behavior — the TM's old confidence is
  // now meaningless because we just rebuilt the field mappings from scratch.
  if (!genResult.error && genResult.inserted > 0) {
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
        .update({ confidence: avgConfidence })
        .eq('id', tableMappingId)
    }
  }

  // Safety net: repair any is_contributing inconsistencies the AI may have introduced
  if (!genResult.error) {
    await cleanupOrphanedContributors(tableMappingId)
  }

  return {
    success: !genResult.error,
    fieldCount: genResult.inserted,
    transformsReset: resetResult.transformsReset,
    stagedRowsReverted: resetResult.stagedRowsReverted,
    error: genResult.error,
  }
}

// ─── deleteFieldMapping ───────────────────────────────────────────────────────

export async function deleteFieldMapping(
  fieldMappingId: string
): Promise<{ success: boolean; transformReset?: boolean; stagedRowsReverted?: number; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: fmLookupDel } = await supabaseAdmin.from('field_mappings').select('table_mapping_id, table_mappings!inner(project_id)').eq('id', fieldMappingId).single()
  if (!fmLookupDel) return { success: false, error: 'Mapping not found' }
  const perm = await requireProjectPermission((fmLookupDel as any).table_mappings.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Fetch before deleting so we can promote a contributor and revalidate
  const { data: fmBefore } = await supabase
    .from('field_mappings')
    .select('table_mapping_id, target_field_id, is_contributing, table_mappings!inner(project_id)')
    .eq('id', fieldMappingId)
    .single()

  // Revert staged JSONB key BEFORE deleting — resetFieldTransform needs the field mapping
  // row to exist so it can resolve target_field_id → field name for the RPC call.
  // The transform row itself will be cascade-deleted when the field mapping is deleted.
  const resetResult = await resetFieldTransform(fieldMappingId)

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

  // Re-evaluate TM status after the deletion: coverage may have dropped
  // (demote to needs_review) or the deleted row may have been the last
  // needs_review holdout (stay / promote to approved).
  if (fmBefore?.table_mapping_id) {
    await recomputeTableMappingStatus(supabase, fmBefore.table_mapping_id)
  }

  const pid = (fmBefore?.table_mappings as unknown as { project_id: string })?.project_id
  if (pid) revalidatePath(`/app/projects/${pid}/transform`)

  return {
    success: true,
    transformReset: resetResult.hadTransform,
    stagedRowsReverted: resetResult.rowsReverted,
  }
}

// ─── deleteTableMapping ───────────────────────────────────────────────────────

export async function deleteTableMapping(
  tableMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: tm } = await supabaseAdmin.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (!tm) return { success: false, error: 'Table mapping not found' }
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const { error } = await supabase.from('table_mappings').delete().eq('id', tableMappingId)
  if (error) return { success: false, error: error.message }

  if (tm) revalidatePath(`/app/projects/${tm.project_id}/transform`)

  return { success: true }
}

// ─── approveAllFieldMappings ──────────────────────────────────────────────────

export async function approveAllFieldMappings(
  tableMappingId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: tmLookupApprove } = await supabaseAdmin.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (!tmLookupApprove) return { success: false, error: 'Table mapping not found' }
  const perm = await requireProjectPermission(tmLookupApprove.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Purge legacy rejected ghost rows before the force-approve. Under the
  // current UX, clicking ✕ deletes a mapping outright — so any row still
  // carrying status='rejected' is a pre-fix ghost that the UI no longer
  // surfaces but that would otherwise resurrect on the next refetch and
  // keep blocking downstream auto-approve paths (updateFieldMappingStatus,
  // autoApproveHighConfidence). "Approve All" is an explicit user intent
  // to approve everything on this table, so lazy-cleaning them here is
  // safe and idempotent.
  await supabase
    .from('field_mappings')
    .delete()
    .eq('table_mapping_id', tableMappingId)
    .eq('status', 'rejected')

  const { error: fmErr } = await supabase
    .from('field_mappings').update({ status: 'approved' }).eq('table_mapping_id', tableMappingId)
  if (fmErr) return { success: false, error: fmErr.message }

  // "Approve All" is an explicit user intent to approve the ENTIRE table,
  // including the target columns that never got a mapping AND the source
  // columns that will be silently dropped. Auto-acknowledge every unmapped
  // field on both sides so the ack-aware recomputeTableMappingStatus rules
  // — every target and source field must be mapped or acknowledged — are
  // satisfied. Uses reason='approved_via_approve_all' so we can tell these
  // bulk acks apart from manual ✓-clicks later if needed.
  const { data: tm } = await supabase
    .from('table_mappings')
    .select('target_table_id, source_table_id, project_id')
    .eq('id', tableMappingId)
    .single()

  if (tm) {
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.target_table_id)

    const { data: mappedFMs } = await supabase
      .from('field_mappings')
      .select('target_field_id, source_field_id')
      .eq('table_mapping_id', tableMappingId)
      .neq('status', 'rejected')

    const mappedTargetIds = new Set(
      (mappedFMs ?? []).map((fm) => fm.target_field_id).filter((id): id is string => Boolean(id))
    )

    const unmappedTargetFields = (targetFields ?? []).filter((f) => !mappedTargetIds.has(f.id))

    if (unmappedTargetFields.length > 0) {
      const ackRows = unmappedTargetFields.map((f) => ({
        project_id: tm.project_id,
        field_id: f.id,
        side: 'target' as const,
        reason: 'approved_via_approve_all',
        acknowledged_by: user.id,
        acknowledged_at: new Date().toISOString(),
      }))

      await supabase
        .from('field_acknowledgments')
        .upsert(ackRows, { onConflict: 'project_id,field_id' })
    }

    // Mirror on the source side: any source column without a non-rejected FM
    // (primary or contributing) would otherwise be silently dropped during
    // migration, so the user's "approve all" must acknowledge them too.
    const { data: sourceFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.source_table_id)

    const mappedSourceIds = new Set(
      (mappedFMs ?? [])
        .map((fm) => fm.source_field_id)
        .filter((id): id is string => Boolean(id))
    )

    const unmappedSourceFields = (sourceFields ?? []).filter((f) => !mappedSourceIds.has(f.id))

    if (unmappedSourceFields.length > 0) {
      const ackRows = unmappedSourceFields.map((f) => ({
        project_id: tm.project_id,
        field_id: f.id,
        side: 'source' as const,
        reason: 'approved_via_approve_all',
        acknowledged_by: user.id,
        acknowledged_at: new Date().toISOString(),
      }))

      await supabase
        .from('field_acknowledgments')
        .upsert(ackRows, { onConflict: 'project_id,field_id' })
    }
  }

  // Safe to force-approve now: all FMs are approved AND every unmapped field
  // on both sides is acknowledged, so the TM satisfies recomputeTableMappingStatus's
  // full rule (approved FMs + target coverage + source coverage). Using a
  // direct update instead of calling the recompute helper is a minor perf win
  // (skips the re-reads) and matches the original "explicit user intent" semantics.
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

  const { data: tmLookupReject } = await supabaseAdmin.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (!tmLookupReject) return { success: false, error: 'Table mapping not found' }
  const perm = await requireProjectPermission(tmLookupReject.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const { error } = await supabase
    .from('field_mappings').update({ status: 'rejected' }).eq('table_mapping_id', tableMappingId)
  if (error) return { success: false, error: error.message }

  // All children just became rejected — TM has zero non-rejected FMs and
  // must demote to needs_review so the UI reflects the lost coverage.
  await recomputeTableMappingStatus(supabase, tableMappingId)

  const { data: tm } = await supabase.from('table_mappings').select('project_id').eq('id', tableMappingId).single()
  if (tm) revalidatePath(`/app/projects/${tm.project_id}/transform`)

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

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, count: 0, error: perm.error }

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

  // Auto-approve TMs where all FMs are now approved. Same rationale as
  // updateFieldMappingStatus: rejected ghost rows are excluded so they
  // don't block promotion. Contributors still count.
  const affectedTMIds = [...new Set((updated ?? []).map((fm) => fm.table_mapping_id))]
  for (const tmId of affectedTMIds) {
    const { data: siblings } = await supabase
      .from('field_mappings')
      .select('status')
      .eq('table_mapping_id', tmId)
      .neq('status', 'rejected')
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
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, newMappingsCount: 0, error: perm.error }

  const { data: existingFMs } = await supabase.from('field_mappings').select('source_field_id, target_field_id').eq('table_mapping_id', tableMappingId)
  const mappedSrcIds = new Set((existingFMs ?? []).filter((fm) => fm.source_field_id).map((fm) => fm.source_field_id as string))
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
    const alreadyMappedSrcIds = new Set((latestFMs ?? []).filter((fm) => fm.source_field_id).map((fm) => fm.source_field_id as string))
    const safeInserts = inserts.filter((i) => !i.source_field_id || !alreadyMappedSrcIds.has(i.source_field_id as string))

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

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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

  // Replace any value assignment on the target before creating the real mapping
  if (!isContributing) {
    await replaceValueAssignment(tmId, targetFieldId)
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

// ─── handleTargetFieldConflict ───────────────────────────────────────────────

export async function handleTargetFieldConflict(
  tableMappingId: string,
  targetFieldId: string,
  incomingFieldMappingId?: string
): Promise<{
  hasConflict: boolean
  conflictType: 'none' | 'value_assignment' | 'field_mapping' | 'both'
  existingMappings: Array<{ id: string; sourceFieldName: string | null; isValueAssignment: boolean; hasTransform: boolean; hasStaged: boolean }>
}> {
  const { data: existing } = await supabaseAdmin
    .from('field_mappings')
    .select('id, source_field_id, is_contributing, status, fields!field_mappings_source_field_id_fkey(name)')
    .eq('table_mapping_id', tableMappingId)
    .eq('target_field_id', targetFieldId)
    .eq('is_contributing', false)
    .neq('status', 'rejected')

  const conflicts = (existing ?? []).filter((fm) => fm.id !== incomingFieldMappingId)

  if (conflicts.length === 0) {
    return { hasConflict: false, conflictType: 'none', existingMappings: [] }
  }

  const enriched = await Promise.all(conflicts.map(async (fm) => {
    const isValueAssignment = fm.source_field_id === null
    const check = await checkFieldMappingHasTransform(fm.id)
    return {
      id: fm.id,
      sourceFieldName: isValueAssignment ? null : ((fm as any).fields?.name ?? 'Unknown') as string | null,
      isValueAssignment,
      hasTransform: check.hasTransform,
      hasStaged: check.hasStaged,
    }
  }))

  const hasVA = enriched.some((e) => e.isValueAssignment)
  const hasFM = enriched.some((e) => !e.isValueAssignment)

  return {
    hasConflict: true,
    conflictType: hasVA && hasFM ? 'both' : hasVA ? 'value_assignment' : 'field_mapping',
    existingMappings: enriched,
  }
}

// ─── replaceValueAssignment ───────────────────────────────────────────────────

export async function replaceValueAssignment(
  tableMappingId: string,
  targetFieldId: string
): Promise<{ success: boolean; transformReset: boolean; rowsReverted: number }> {
  const { data: va } = await supabaseAdmin
    .from('field_mappings')
    .select('id')
    .eq('table_mapping_id', tableMappingId)
    .eq('target_field_id', targetFieldId)
    .is('source_field_id', null)
    .eq('is_contributing', false)
    .maybeSingle()

  if (!va) return { success: true, transformReset: false, rowsReverted: 0 }

  const resetResult = await resetFieldTransform(va.id)

  await supabaseAdmin
    .from('field_mappings')
    .delete()
    .eq('id', va.id)

  return {
    success: true,
    transformReset: resetResult.hadTransform,
    rowsReverted: resetResult.rowsReverted,
  }
}

// ─── Value Assignment — field_mapping with NULL source_field_id ──────────────

export async function createValueAssignment(
  projectId: string,
  tableMappingId: string,
  targetFieldId: string
): Promise<{ success: boolean; fieldMappingId?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Check all non-rejected primary mappings on this target (value assignments and regular)
  const { data: existingPrimary } = await supabase
    .from('field_mappings')
    .select('id, source_field_id')
    .eq('table_mapping_id', tableMappingId)
    .eq('target_field_id', targetFieldId)
    .eq('is_contributing', false)
    .neq('status', 'rejected')

  const existingVA = (existingPrimary ?? []).find((fm) => fm.source_field_id === null)
  if (existingVA) return { success: true, fieldMappingId: existingVA.id }

  const existingFM = (existingPrimary ?? []).find((fm) => fm.source_field_id !== null)
  if (existingFM) {
    return {
      success: false,
      error: 'This target field already has a field mapping. Remove the mapping first to add a value assignment.',
    }
  }

  const { data, error } = await supabase
    .from('field_mappings')
    .insert({
      table_mapping_id: tableMappingId,
      source_field_id: null,
      target_field_id: targetFieldId,
      confidence: 100,
      status: 'approved',
      ai_reasoning: 'Value assignment — no source field. User will define the value in Transform.',
      needs_transformation: true,
      is_contributing: false,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true, fieldMappingId: data.id }
}

// ─── cleanupOrphanedContributors ──────────────────────────────────────────────
// Repairs two classes of is_contributing inconsistency for a given table mapping:
//   1. Targets with contributing rows but no primary → promote the oldest contributor
//   2. Targets with more than one non-contributing primary → demote extras to contributing
// Can be called after bulk AI regeneration or as a manual admin repair.

export async function cleanupOrphanedContributors(
  tableMappingId: string
): Promise<{ promoted: number; demoted: number }> {
  const { data: allFMs } = await supabaseAdmin
    .from('field_mappings')
    .select('id, target_field_id, is_contributing, status, created_at')
    .eq('table_mapping_id', tableMappingId)
    .neq('status', 'rejected')
    .order('created_at', { ascending: true })

  if (!allFMs) return { promoted: 0, demoted: 0 }

  // Group by target_field_id
  const byTarget = new Map<string, typeof allFMs>()
  for (const fm of allFMs) {
    const list = byTarget.get(fm.target_field_id) ?? []
    list.push(fm)
    byTarget.set(fm.target_field_id, list)
  }

  let promoted = 0
  let demoted = 0

  for (const [, fms] of byTarget) {
    const primaries = fms.filter((f) => !f.is_contributing)
    const contributors = fms.filter((f) => f.is_contributing)

    if (primaries.length === 0 && contributors.length > 0) {
      // No primary exists — promote the oldest contributor (already sorted by created_at)
      await supabaseAdmin
        .from('field_mappings')
        .update({ is_contributing: false })
        .eq('id', contributors[0].id)
      promoted++
    }

    if (primaries.length > 1) {
      // Multiple non-contributing primaries — keep oldest, demote the rest to contributors
      for (let i = 1; i < primaries.length; i++) {
        await supabaseAdmin
          .from('field_mappings')
          .update({ is_contributing: true })
          .eq('id', primaries[i].id)
        demoted++
      }
    }
  }

  return { promoted, demoted }
}
