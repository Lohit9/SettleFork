'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatFieldForPrompt, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { fieldNeedsTransform, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { logActivity } from '@/lib/actions/activity-log'
import { revalidatePath } from 'next/cache'
import type { Transformation } from '@/lib/types/database'

export { fieldNeedsTransform, wrapFieldRefsInJsonb }

// ── Shared types ──────────────────────────────────────────────────────────────

export interface FieldItem {
  fieldMappingId: string
  sourceFieldId: string | null
  sourceFieldName: string | null
  sourceFieldDataType: string | null
  sourceFieldInferredType: string | null
  sourceFieldIsNullable: boolean
  targetFieldId: string
  targetFieldName: string
  targetFieldDataType: string
  targetFieldInferredType: string | null
  targetFieldIsNullable: boolean
  targetFieldIsPrimaryKey: boolean
  sourceTableId: string | null
  isValueAssignment: boolean
  typeCompatibility: string | null
  confidence: number | null
  /** AI-generated reasoning from the field mapping (why this mapping was made) */
  aiReasoning: string | null
  /** Null rate for the source field (from field_profiles) */
  nullPercentage: number
  /** Count of format issues for the source field (from field_profiles) */
  formatIssuesCount: number
  sampleValues: unknown[]
  cardinality: number
  needsTransform: boolean
  transformation: Transformation | null
  /** True when this mapping is a contributing (secondary) source — hidden from the transform tree */
  isContributing: boolean
  /** Additional source fields that contribute to the same target (for primary mappings only) */
  contributingSourceFields: { id: string; name: string; data_type: string }[]
  /** Target field check constraint (for value assignments — helps guide value selection) */
  targetCheckConstraint?: { type: string; allowedValues?: string[]; pattern?: string; raw?: string } | null
}

export interface TableGroup {
  tableMappingId: string
  sourceTableId: string
  targetTableId: string
  sourceTableName: string
  targetTableName: string
  fields: FieldItem[]
}

export interface DatasetGroup {
  datasetId: string
  datasetName: string
  tables: TableGroup[]
}

export interface UnmappedTargetField {
  id: string
  name: string
  data_type: string
  is_nullable: boolean
  is_primary_key: boolean
  table_id: string
  table_name: string
  check_constraint: { type: string; allowedValues?: string[]; pattern?: string; raw?: string } | null
}

export interface TransformPageData {
  datasets: DatasetGroup[]
  schemaDocText: string
  hasMappings: boolean
  unmappedNotNullTargetFields: UnmappedTargetField[]
  unmappedNullableTargetFields: UnmappedTargetField[]
}

// ── getTransformData ──────────────────────────────────────────────────────────

export async function getTransformData(
  projectId: string
): Promise<TransformPageData> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { datasets: [], schemaDocText: '', hasMappings: false, unmappedNotNullTargetFields: [], unmappedNullableTargetFields: [] }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { datasets: [], schemaDocText: '', hasMappings: false, unmappedNotNullTargetFields: [], unmappedNullableTargetFields: [] }

  // 1. Table mappings (non-rejected)
  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) {
    return { datasets: [], schemaDocText: '', hasMappings: false, unmappedNotNullTargetFields: [], unmappedNullableTargetFields: [] }
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
      .select('id, table_mapping_id, source_field_id, target_field_id, type_compatibility, confidence, is_contributing, ai_reasoning, needs_transformation')
      .in('table_mapping_id', tmIds)
      .neq('status', 'rejected'),
  ])

  if (!fieldMappings || fieldMappings.length === 0) {
    return { datasets: [], schemaDocText: '', hasMappings: true, unmappedNotNullTargetFields: [], unmappedNullableTargetFields: [] }
  }

  const allSourceFieldIds = fieldMappings.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)
  const allTargetFieldIds = fieldMappings.map((fm) => fm.target_field_id)
  const allFieldMappingIds = fieldMappings.map((fm) => fm.id)

  // 3. Fields, profiles, transformations
  const [
    { data: sourceFields },
    { data: targetFields },
    { data: fieldProfiles },
    { data: transformations },
  ] = await Promise.all([
    allSourceFieldIds.length > 0
      ? supabase
          .from('fields')
          .select('id, name, data_type, inferred_type, is_nullable, table_id, ordinal_position')
          .in('id', allSourceFieldIds)
          .order('ordinal_position', { ascending: true })
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; data_type: string; inferred_type: string | null; is_nullable: boolean; table_id: string; ordinal_position: number }>, error: null }),
    supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable, is_primary_key, check_constraint')
      .in('id', allTargetFieldIds),
    allSourceFieldIds.length > 0
      ? supabase
          .from('field_profiles')
          .select('field_id, sample_values, cardinality, null_percentage, format_issues_count')
          .in('field_id', allSourceFieldIds)
      : Promise.resolve({ data: [] as Array<{ field_id: string; sample_values: string[] | null; cardinality: number | null; null_percentage: number | null; format_issues_count: number | null }>, error: null }),
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

    // Build a lookup: target_field_id → contributing source field names (for primary mappings)
    const contributingByTarget = new Map<string, { id: string; name: string; data_type: string }[]>()
    for (const fm of fms) {
      if (!(fm as typeof fm & { is_contributing?: boolean }).is_contributing) continue
      if (!fm.source_field_id) continue
      const srcField = srcFieldById.get(fm.source_field_id)
      if (!srcField) continue
      const list = contributingByTarget.get(fm.target_field_id) ?? []
      list.push({ id: srcField.id, name: srcField.name, data_type: srcField.data_type })
      contributingByTarget.set(fm.target_field_id, list)
    }

    for (const fm of fms) {
      const tgtField = tgtFieldById.get(fm.target_field_id)
      if (!tgtField) continue

      const isValueAssignment = fm.source_field_id === null
      const srcField = fm.source_field_id ? srcFieldById.get(fm.source_field_id) : null
      if (!isValueAssignment && !srcField) continue

      const isContributing = !!(fm as typeof fm & { is_contributing?: boolean }).is_contributing

      const profile = fm.source_field_id ? profileByFieldId.get(fm.source_field_id) : null
      const transformation = transformByFMId.get(fm.id) ?? null

      const fmWithFlags = fm as typeof fm & { ai_reasoning?: string | null; needs_transformation?: boolean | null }

      const needsTransform = isValueAssignment ? true : fieldNeedsTransform({
        typeCompatibility: fm.type_compatibility,
        confidence: fm.confidence,
        sourceDataType: srcField!.data_type,
        targetDataType: tgtField.data_type,
        sourceFieldName: srcField!.name,
        targetFieldName: tgtField.name,
        hasTransformation: transformation !== null,
        needsTransformation: fmWithFlags.needs_transformation ?? null,
      })

      const fmTyped = fmWithFlags
      fields.push({
        fieldMappingId: fm.id,
        sourceFieldId: srcField?.id ?? null,
        sourceFieldName: srcField?.name ?? null,
        sourceFieldDataType: srcField?.data_type ?? null,
        sourceFieldInferredType: srcField?.inferred_type ?? null,
        sourceFieldIsNullable: srcField?.is_nullable ?? true,
        targetFieldId: tgtField.id,
        targetFieldName: tgtField.name,
        targetFieldDataType: tgtField.data_type,
        targetFieldInferredType: tgtField.inferred_type,
        targetFieldIsNullable: tgtField.is_nullable,
        targetFieldIsPrimaryKey: !!(tgtField as typeof tgtField & { is_primary_key?: boolean }).is_primary_key,
        sourceTableId: srcField?.table_id ?? null,
        isValueAssignment,
        typeCompatibility: fm.type_compatibility,
        confidence: fm.confidence,
        aiReasoning: fmTyped.ai_reasoning ?? null,
        nullPercentage: (profile as typeof profile & { null_percentage?: number } | undefined)?.null_percentage ?? 0,
        formatIssuesCount: (profile as typeof profile & { format_issues_count?: number } | undefined)?.format_issues_count ?? 0,
        sampleValues: (profile?.sample_values as unknown[]) ?? [],
        cardinality: profile?.cardinality ?? 0,
        needsTransform,
        transformation,
        isContributing,
        contributingSourceFields: isContributing ? [] : (contributingByTarget.get(fm.target_field_id) ?? []),
        targetCheckConstraint: isValueAssignment ? ((tgtField as typeof tgtField & { check_constraint?: unknown }).check_constraint as FieldItem['targetCheckConstraint'] ?? null) : null,
      })
    }

    if (fields.length > 0) {
      // Sort: mapped fields by source ordinal_position, value assignments at end by target name
      fields.sort((a, b) => {
        if (a.isValueAssignment && !b.isValueAssignment) return 1
        if (!a.isValueAssignment && b.isValueAssignment) return -1
        if (a.isValueAssignment && b.isValueAssignment) {
          return a.targetFieldName.localeCompare(b.targetFieldName)
        }
        const sfA = a.sourceFieldId ? srcFieldById.get(a.sourceFieldId) as { ordinal_position?: number } | undefined : undefined
        const sfB = b.sourceFieldId ? srcFieldById.get(b.sourceFieldId) as { ordinal_position?: number } | undefined : undefined
        return (sfA?.ordinal_position ?? 9999) - (sfB?.ordinal_position ?? 9999)
      })
      dsGroup.tables.push({
        tableMappingId: tm.id,
        sourceTableId: tm.source_table_id,
        targetTableId: tm.target_table_id,
        sourceTableName: srcTable.name,
        targetTableName: tgtTable.name,
        fields,
      })
    }
  }

  // ── Compute unmapped NOT NULL target fields ─────────────────────────────────
  const allTargetTableIds = [...new Set(tms.map((tm) => tm.target_table_id))]
  const { data: allTgtFieldRows } = await supabase
    .from('fields')
    .select('id, name, data_type, is_nullable, is_primary_key, table_id, check_constraint')
    .in('table_id', allTargetTableIds.length > 0 ? allTargetTableIds : ['__none__'])
    .order('ordinal_position', { ascending: true })

  const mappedTargetFieldIds = new Set(
    fieldMappings.filter((fm) => !fm.is_contributing).map((fm) => fm.target_field_id)
  )

  const tgtTableNameById = new Map(
    (tables ?? []).filter((t) => allTargetTableIds.includes(t.id)).map((t) => [t.id, t.name])
  )

  const allUnmapped = (allTgtFieldRows ?? []).filter((f) => !mappedTargetFieldIds.has(f.id))
  const toUnmapped = (f: typeof allUnmapped[number]): UnmappedTargetField => ({
    id: f.id,
    name: f.name,
    data_type: f.data_type,
    is_nullable: f.is_nullable,
    is_primary_key: f.is_primary_key ?? false,
    table_id: f.table_id,
    table_name: tgtTableNameById.get(f.table_id) ?? '',
    check_constraint: f.check_constraint as UnmappedTargetField['check_constraint'],
  })

  const unmappedNotNullTargetFields = allUnmapped.filter((f) => !f.is_nullable).map(toUnmapped)
  const unmappedNullableTargetFields = allUnmapped.filter((f) => f.is_nullable).map(toUnmapped)

  return {
    datasets: [...datasetGroupMap.values()],
    schemaDocText,
    hasMappings: true,
    unmappedNotNullTargetFields,
    unmappedNullableTargetFields,
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
11. LPAD / RPAD require TEXT as their first argument. ALWAYS cast numeric/integer/bigint expressions
    to text before passing to LPAD or RPAD:
    CORRECT: LPAD(some_number::text, 7, '0')
    WRONG:   LPAD(some_number, 7, '0')  ← crashes with "function lpad(bigint, integer, unknown) does not exist"
    This applies to row_number, any integer column, ROW_NUMBER() results, etc.

Common transformation patterns:
- Value mapping: CASE WHEN field = 'X' THEN 'Y' WHEN field = 'Z' THEN 'W' ELSE 'OTHER' END
- Type casting: field::integer, field::numeric (avoid bare ::date — use TO_DATE with explicit format instead)
- String operations: UPPER(field), LOWER(field), TRIM(field), LEFT(field, 10)
- Concatenation: field1 || '-' || field2
- Null handling: COALESCE(field, 'default')
- Substring: SUBSTRING(field FROM 1 FOR 10)
- Regex replace: REGEXP_REPLACE(field, 'pattern', 'replacement')
- Hash: MD5(field)
- Truncation: LEFT(field, 10) or SUBSTRING(field FROM 1 FOR 10)

DATE FORMATTING — CRITICAL RULES:
NEVER use bare ::date casts or TO_CHAR(field::date, ...) — these fail when data contains mixed formats.
NEVER call TO_DATE(field, 'MM/DD/YYYY') on data that may contain DD/MM/YYYY values — month=22 will crash.
ALWAYS use a CASE + regex approach that detects the format before parsing.
Each WHEN branch must target ONE specific format with its own separator and format string.
NEVER nest a CASE expression inside a SPLIT_PART argument — use separate WHEN branches instead.

Example template (adapt branches to actual sample data, remove unused branches):

  CASE
    WHEN field IS NULL OR TRIM(field) = '' THEN NULL
    -- Already ISO 8601 (YYYY-MM-DD) — pass through
    WHEN field ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN SUBSTRING(field FROM 1 FOR 10)
    -- YYYY/MM/DD
    WHEN field ~ '^[0-9]{4}/[0-9]' THEN TO_CHAR(TO_DATE(field, 'YYYY/MM/DD'), 'YYYY-MM-DD')
    -- Slash 4-digit year: first part > 12 → DD/MM/YYYY (e.g. 22/11/2025)
    WHEN field ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' AND SPLIT_PART(field, '/', 1)::int > 12 THEN TO_CHAR(TO_DATE(field, 'DD/MM/YYYY'), 'YYYY-MM-DD')
    -- Slash 4-digit year: first part <= 12 → MM/DD/YYYY (e.g. 03/06/2027)
    WHEN field ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' THEN TO_CHAR(TO_DATE(field, 'MM/DD/YYYY'), 'YYYY-MM-DD')
    -- Slash 2-digit year → MM/DD/YY (e.g. 08/15/22)
    WHEN field ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$' THEN TO_CHAR(TO_DATE(field, 'MM/DD/YY'), 'YYYY-MM-DD')
    -- Dash 4-digit year: first part > 12 → DD-MM-YYYY (e.g. 13-09-2026)
    WHEN field ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' AND SPLIT_PART(field, '-', 1)::int > 12 THEN TO_CHAR(TO_DATE(field, 'DD-MM-YYYY'), 'YYYY-MM-DD')
    -- Dash 4-digit year: first part <= 12 → MM-DD-YYYY (e.g. 05-31-2026)
    WHEN field ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' THEN TO_CHAR(TO_DATE(field, 'MM-DD-YYYY'), 'YYYY-MM-DD')
    -- Dash 2-digit year → MM-DD-YY
    WHEN field ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{2}$' THEN TO_CHAR(TO_DATE(field, 'MM-DD-YY'), 'YYYY-MM-DD')
    -- Month name (Mar 15 2024, 15 March 2024, March 15 2024)
    WHEN field ~* '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)' THEN TO_CHAR((field)::date, 'YYYY-MM-DD')
    ELSE NULL
  END

Rules:
- Include only WHEN branches for formats actually observed in the sample data. Remove unused branches.
- Always keep the ISO passthrough branch and ELSE NULL.
- Never mix separators in a single TO_DATE call — use separate WHEN branches.
- The SPLIT_PART "first part > 12" check disambiguates DD/MM from MM/DD without nested CASEs.

If documentation is provided, follow the exact value mappings and transformation rules specified in the business rules. Do not invent mappings that contradict the documentation. If the documentation specifies edge cases or special handling, include them in the expression.

CRITICAL — USER INSTRUCTION FAITHFULNESS:
The user's natural language description is the AUTHORITATIVE specification for this transformation. Follow it exactly.
- If the user specifies explicit value mappings and a default/catch-all (e.g., "all others=X" or "everything else=X"), generate ONLY the mappings they listed. All values not explicitly mapped MUST go to the catch-all via ELSE. Do NOT invent additional mappings for values you see in the data.
- If the user specifies a general rule (e.g., "convert to uppercase", "strip $ and commas"), apply that rule uniformly — do not add case-by-case logic unless the user asked for it.
- If the user's instruction is ambiguous or incomplete, prefer a simpler interpretation that matches their words over a more "complete" one that adds logic they didn't request.
- The value distribution and sample data are provided so you can write CORRECT SQL (proper quoting, case handling, edge cases) — NOT so you can expand the user's specification with additional mappings.
- It is ALWAYS better to under-engineer (strict adherence to user's words + ELSE catch-all) than to over-engineer (inventing mappings the user didn't ask for).

NULL HANDLING:
Always preserve NULL and empty values unless the user explicitly instructs you to convert them. When generating CASE expressions or any conditional logic, add a NULL/empty guard as the FIRST condition:
  CASE
    WHEN field_name IS NULL OR TRIM(field_name::text) = '' THEN NULL
    WHEN ... (user's specified logic)
    ELSE ...
  END
This ensures that NULL source values do not accidentally map to a default/catch-all value. "All others" or "everything else" in the user's description means "all other NON-NULL, NON-EMPTY values" unless they explicitly say otherwise (e.g., "including nulls" or "map nulls to X"). Apply this NULL guard to ALL conditional expressions (CASE, COALESCE chains, IIF, etc.) unless the user's instruction explicitly handles nulls differently.`

// ── wrapWithNullGuard ─────────────────────────────────────────────────────────

/**
 * Deterministically ensures NULL/empty source values are preserved as NULL
 * in the generated SQL, regardless of what Claude produced.
 *
 * - If Claude already included a NULL guard for the source field → return as-is
 * - If the SQL is a CASE expression → prepend a NULL WHEN as the first clause
 * - Otherwise → wrap the whole expression in a NULL-safe CASE/ELSE
 */
function wrapWithNullGuard(sql: string, sourceFieldName: string): string {
  const trimmed = sql.trim()
  const escapedName = sourceFieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Already has a null guard for this field — trust Claude
  const hasNullGuard = new RegExp(
    `WHEN\\s+["']?${escapedName}["']?\\s+IS\\s+NULL|WHEN\\s+TRIM\\s*\\(\\s*["']?${escapedName}["']?`,
    'i'
  ).test(trimmed)
  if (hasNullGuard) return trimmed

  const nullWhen = `WHEN "${sourceFieldName}" IS NULL OR TRIM("${sourceFieldName}"::text) = '' THEN NULL`

  // CASE expression → insert NULL guard as the first WHEN clause
  if (/^\s*CASE\b/i.test(trimmed)) {
    return trimmed.replace(/^(\s*CASE\b)/i, `$1\n  ${nullWhen}`)
  }

  // Non-CASE expression (function call, arithmetic, etc.) → wrap entirely
  return `CASE\n  ${nullWhen}\n  ELSE ${trimmed}\nEND`
}

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

  // Verify access through table_mapping → project
  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', fm.table_mapping_id)
    .single()
  if (!tm) return { success: false, error: 'Mapping not found' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(tm.project_id, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  // Fetch fields — source may be null for value assignments
  const isValueAssignment = fm.source_field_id === null
  const [srcFieldResult, { data: tgtField }] = await Promise.all([
    fm.source_field_id
      ? supabase.from('fields').select('id, name, data_type, inferred_type, is_nullable, table_id').eq('id', fm.source_field_id).single()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('fields').select('id, name, data_type, inferred_type, is_nullable').eq('id', fm.target_field_id).single(),
  ])
  const srcField = srcFieldResult.data
  if (!isValueAssignment && !srcField) return { success: false, error: 'Source field not found' }
  if (!tgtField) return { success: false, error: 'Target field not found' }

  // Fetch tables
  const [{ data: srcTable }, { data: tgtTable }] = await Promise.all([
    supabase.from('tables').select('id, name, datasets(id, name)').eq('id', tm.source_table_id).single(),
    supabase.from('tables').select('id, name').eq('id', tm.target_table_id).single(),
  ])

  // Fetch any contributing field mappings for this target (for multi-source transforms)
  const { data: contributingFMs } = await supabase
    .from('field_mappings')
    .select('source_field_id')
    .eq('table_mapping_id', fm.table_mapping_id)
    .eq('target_field_id', fm.target_field_id)
    .eq('is_contributing', true)
    .neq('status', 'rejected')

  const contributingFieldIds = (contributingFMs ?? []).map((c) => c.source_field_id).filter((id): id is string => id !== null)

  // Build rich AI context
  const allSourceFieldIds = srcField ? [srcField.id, ...contributingFieldIds] : contributingFieldIds
  const txCtx = await buildAIContext(tm.project_id, {
    tableIds: [tm.source_table_id, tm.target_table_id],
    fieldIds: [...allSourceFieldIds, tgtField.id],
    includeProfilingStats: true,
    includeValueDistributions: true,
    includeSampleValues: true,
    includeDocuments: true,
    maxDistributionValues: 25,
  }, user.id)

  const tgtTableName = tgtTable?.name ?? ''
  const transformDocBlock = formatDocumentsForPrompt(txCtx.documents)

  // Find field contexts (source has distribution data; target is DDL-only so profile is empty)
  const allSrcCtxFields = txCtx.source_tables.flatMap((t) => t.fields)
  const srcFieldCtx = srcField ? allSrcCtxFields.find((f) => f.name === srcField.name) : null
  const tgtFieldCtx = txCtx.target_tables.flatMap((t) => t.fields).find((f) => f.name === tgtField.name)

  // Fetch contributing field metadata for the prompt
  let contributingSourcesBlock = ''
  if (contributingFieldIds.length > 0) {
    const { data: contribFields } = await supabase
      .from('fields')
      .select('id, name, data_type')
      .in('id', contributingFieldIds)
    if (contribFields && contribFields.length > 0) {
      const lines = contribFields.map((cf) => {
        const ctx = allSrcCtxFields.find((f) => f.name === cf.name)
        return ctx ? formatFieldForPrompt(ctx) : `${cf.name} (${cf.data_type})`
      })
      // Extract combination hint from the primary mapping's AI reasoning
      const { data: primaryMapping } = await supabase
        .from('field_mappings')
        .select('ai_reasoning')
        .eq('id', fieldMappingId)
        .single()
      const hintMatch = primaryMapping?.ai_reasoning?.match(/\[Combination:\s*(.*?)\]/)
      const combinationHint = hintMatch ? hintMatch[1] : ''
      contributingSourcesBlock = `\n<contributing_source_fields>
This is a MANY-TO-ONE mapping. Multiple source fields must be combined into a single target field value.

${srcField ? `Primary source field: ${srcField.name} (${srcField.data_type})` : 'No primary source field — this is a value assignment.'}
Contributing source fields:
${lines.join('\n')}
${combinationHint ? `\nCombination hint: ${combinationHint}` : ''}
Generate a SQL expression that COMBINES all source fields into the target field.
Reference source fields by name — they are accessible as row_data->>'field_name'.
Handle nulls gracefully — if one source field is null, use the remaining field(s).
</contributing_source_fields>\n`
    }
  }

  // Build user message
  const sourceBlock = isValueAssignment
    ? `<source_field>\nNo source field — this is a VALUE ASSIGNMENT.\nDefine a constant, expression, or function that produces the value for the target field.\nDo NOT reference row_data unless you know the source table columns.\nTable: ${srcTable?.name ?? ''}\n</source_field>`
    : `<source_field>\n${srcFieldCtx ? formatFieldForPrompt(srcFieldCtx) : `${srcField!.name} (${srcField!.data_type})\n  Nullable: ${srcField!.is_nullable}`}\nTable: ${srcTable?.name ?? ''}\n</source_field>`
  const userMessage = `${sourceBlock}
${contributingSourcesBlock}
<target_field>
Field: ${tgtTableName}.${tgtField.name}
Type: ${tgtField.data_type}${tgtField.inferred_type ? ` (${tgtField.inferred_type})` : ''}
Nullable: ${tgtField.is_nullable}
${tgtFieldCtx && tgtFieldCtx.cardinality > 0 ? `Distinct values: ${tgtFieldCtx.cardinality}` : ''}
</target_field>

<type_compatibility>
${fm.type_compatibility ?? 'Not specified'}
</type_compatibility>
${transformDocBlock}
${txCtx.intelligence_context ? txCtx.intelligence_context + '\n\n' : ''}<description>
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

  // Deterministically wrap with NULL guard — skipped for value assignments (no source field)
  if (srcField) {
    sql = wrapWithNullGuard(sql, srcField.name)
  }

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

  const { data: txLookup } = await supabaseAdmin.from('transformations').select('field_mapping_id, field_mappings!inner(table_mapping_id, table_mappings!inner(project_id))').eq('id', transformationId).single()
  if (!txLookup) return { success: false, error: 'Transformation not found' }
  const perm = await requireProjectPermission((txLookup as any).field_mappings.table_mappings.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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

// ── autoSaveTransform ─────────────────────────────────────────────────────────
// Persists sql, description, and optionally status.
// Used by the client-side debounced auto-save.

export async function autoSaveTransform(
  transformationId: string,
  sql: string,
  description: string,
  status?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: txLookupAS } = await supabaseAdmin.from('transformations').select('field_mapping_id, field_mappings!inner(table_mapping_id, table_mappings!inner(project_id))').eq('id', transformationId).single()
  if (!txLookupAS) return { success: false, error: 'Transformation not found' }
  const perm = await requireProjectPermission((txLookupAS as any).field_mappings.table_mappings.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const cleanSql = sql.replace(/;+$/, '').trim()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {
    generated_sql: cleanSql || sql,
    description: description.trim() || null,
  }
  if (status) updates.status = status

  const { error } = await supabase
    .from('transformations')
    .update(updates)
    .eq('id', transformationId)

  if (error) return { success: false, error: 'Auto-save failed' }
  return { success: true }
}

// ── runFullTransformTest ──────────────────────────────────────────────────────
// Runs the stored transform SQL against ALL rows in the source table.
// Returns pass/fail counts and up to 20 failure details.
// On success (0 failures) sets transformation status → 'tested'.
// On failures keeps status as 'draft'.

export interface TransformTestFailure {
  rowNumber: number
  sourceValue: string
  errorMessage: string
}

export interface FullTransformTestResult {
  totalRows: number
  passedRows: number
  failedRows: number
  failures: TransformTestFailure[]
}

export async function runFullTransformTest(
  fieldMappingId: string
): Promise<{ success: boolean; result?: FullTransformTestResult; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

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
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Load the current transformation record
  const { data: transformation } = await supabase
    .from('transformations')
    .select('id, generated_sql, status')
    .eq('field_mapping_id', fieldMappingId)
    .single()
  if (!transformation?.generated_sql) return { success: false, error: 'No transform SQL found. Generate a transform first.' }

  const srcField = fm.source_field_id
    ? (await supabase.from('fields').select('id, name, table_id').eq('id', fm.source_field_id).single()).data
    : null
  if (fm.source_field_id && !srcField) return { success: false, error: 'Source field not found' }

  const sourceTableId = srcField?.table_id ?? tm.source_table_id
  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(transformation.generated_sql.replace(/;+$/, '').trim(), fieldNames)

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
    'execute_transform_full_test',
    {
      p_expression: wrappedSql,
      p_table_id: sourceTableId,
      p_source_field: srcField?.name ?? '_none_',
    }
  )

  if (rpcErr) return { success: false, error: rpcErr.message }

  const raw = rpcResult as {
    total_rows: number
    passed_rows: number
    failed_rows: number
    failures: { row_number: number; source_value: string; error_message: string }[]
  }

  const result: FullTransformTestResult = {
    totalRows: raw.total_rows ?? 0,
    passedRows: raw.passed_rows ?? 0,
    failedRows: raw.failed_rows ?? 0,
    failures: (raw.failures ?? []).map((f) => ({
      rowNumber: f.row_number,
      sourceValue: f.source_value,
      errorMessage: f.error_message,
    })),
  }

  // Update transformation status based on test outcome
  const newStatus = result.failedRows === 0 ? 'tested' : 'draft'
  await supabase
    .from('transformations')
    .update({ status: newStatus })
    .eq('id', transformation.id)

  return { success: true, result }
}

// ── testTransformation ────────────────────────────────────────────────────────

export async function testTransformation(
  fieldMappingId: string,
  sql: string,
  contributingFieldNames?: string[],
  options?: { silent?: boolean }
): Promise<{
  success: boolean
  results?: { before: string | null; after: string | null; beforeValues?: Record<string, string | null> }[]
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
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Value assignments have no source field — for constants/expressions we can evaluate directly
  const isValueAssignment = fm.source_field_id === null

  // Get source field info (if it exists)
  const srcField = fm.source_field_id
    ? (await supabase.from('fields').select('id, name, table_id').eq('id', fm.source_field_id).single()).data
    : null
  if (!isValueAssignment && !srcField) return { success: false, error: 'Source field not found' }

  // Get all field names in source table for JSONB wrapping
  const sourceTableId = srcField?.table_id ?? tm.source_table_id
  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)

  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  // Wrap bare field refs with JSONB access (no-op for pure constants)
  const wrappedSql = wrapFieldRefsInJsonb(sql.trim(), fieldNames)

  // For value assignments, evaluate the expression against source table rows
  const sourceFieldNames = srcField ? [srcField.name, ...(contributingFieldNames ?? [])] : (contributingFieldNames ?? [])
  const useMultiField = sourceFieldNames.length > 1

  // Execute via RPC
  const { data: rpcResult, error: rpcErr } = useMultiField
    ? await supabaseAdmin.rpc('execute_transform_test', {
        p_expression: wrappedSql,
        p_table_id: sourceTableId,
        p_source_fields: sourceFieldNames,
        p_limit: 20,
      })
    : sourceFieldNames.length === 1
    ? await supabaseAdmin.rpc('execute_transform_test', {
        p_expression: wrappedSql,
        p_table_id: sourceTableId,
        p_source_field: sourceFieldNames[0],
        p_limit: 20,
      })
    // Value assignment with no source fields — evaluate expression against source table
    : await supabaseAdmin.rpc('execute_transform_test', {
        p_expression: wrappedSql,
        p_table_id: sourceTableId,
        p_source_field: '_none_',
        p_limit: 10,
      })

  if (rpcErr) {
    return { success: false, error: rpcErr.message }
  }

  const rows = (rpcResult as { before_value: unknown; after_value: unknown; before_values?: Record<string, unknown> }[]) ?? []
  const results = rows.map((r) => ({
    before: r.before_value != null ? String(r.before_value) : null,
    after: r.after_value != null ? String(r.after_value) : null,
    ...(r.before_values ? {
      beforeValues: Object.fromEntries(
        Object.entries(r.before_values).map(([k, v]) => [k, v != null ? String(v) : null])
      ),
    } : {}),
  }))

  // Update the transformation record with test results and status
  const { data: existing } = await supabase
    .from('transformations')
    .select('id')
    .eq('field_mapping_id', fieldMappingId)
    .single()

  let transformationId: string | undefined

  if (existing) {
    // Never downgrade an applied transform — the auto-preview calls this function
    // on field selection, which would overwrite 'applied' → 'tested'.
    await supabase
      .from('transformations')
      .update({ status: 'tested', test_results: results })
      .eq('id', existing.id)
      .neq('status', 'applied')
    transformationId = existing.id
  }

  // Only log explicit user-initiated tests — not the background auto-preview
  if (!options?.silent) {
    const srcFldLog = fm.source_field_id
      ? (await supabase.from('fields').select('name').eq('id', fm.source_field_id).single()).data
      : null
    const { data: tgtFldLog } = await supabase.from('fields').select('name').eq('id', fm.target_field_id).single()
    await logActivity(
      tm.project_id,
      'transform_tested',
      `Transform tested: ${srcFldLog?.name ?? '[value]'} \u2192 ${tgtFldLog?.name ?? '?'}`,
      'transform',
      { transformation_id: transformationId, source_field: srcFldLog?.name ?? null, target_field: tgtFldLog?.name }
    )
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

  const { data: txLookupSave } = await supabaseAdmin.from('transformations').select('field_mapping_id, field_mappings!inner(table_mapping_id, table_mappings!inner(project_id))').eq('id', transformationId).single()
  if (!txLookupSave) return { success: false, error: 'Transformation not found' }
  const perm = await requireProjectPermission((txLookupSave as any).field_mappings.table_mappings.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

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

  const { checkProjectPermission: checkPerm } = await import('@/lib/actions/role-resolution')
  if (!(await checkPerm(projectId, 'editor'))) {
    return { success: false, generated: 0, failed: 0, error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
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

  // Gate: require the transform to have been tested first
  const { data: trans } = await supabase
    .from('transformations')
    .select('status')
    .eq('field_mapping_id', fieldMappingId)
    .single()
  if (trans && trans.status !== 'tested' && trans.status !== 'applied') {
    return { success: false, rowsAffected: 0, error: 'Run "Test Transform" before applying.' }
  }

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
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, rowsAffected: 0, error: perm.error }

  // Fetch source and target field names — source may be null for value assignments
  const srcField = fm.source_field_id
    ? (await supabase.from('fields').select('id, name, table_id').eq('id', fm.source_field_id).single()).data
    : null
  const { data: tgtField } = await supabase.from('fields').select('id, name').eq('id', fm.target_field_id).single()
  if (!tgtField) return { success: false, rowsAffected: 0, error: 'Target field not found' }
  if (!fm.source_field_id && !srcField) { /* value assignment — ok */ }
  else if (!srcField) return { success: false, rowsAffected: 0, error: 'Source field not found' }

  // All source field names for JSONB rewriting
  const sourceTableId = srcField?.table_id ?? tm.source_table_id
  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
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

  // Re-flag row_issues now that transform values have changed
  try {
    const { flagStagedRowIssues } = await import('@/lib/actions/staged-row-flags')
    await flagStagedRowIssues(tm.project_id, tm.id)
  } catch {
    // Non-critical — row_issues may be stale but staging data is intact
  }

  const appliedRows = Number(rowsAffected ?? 0)
  await logActivity(
    tm.project_id,
    'transform_applied',
    `Transform applied: ${srcField?.name ?? '[value]'} \u2192 ${tgtField.name} — ${appliedRows} row${appliedRows !== 1 ? 's' : ''}`,
    'transform',
    {
      field_mapping_id: fieldMappingId,
      source_field: srcField?.name ?? null,
      target_field: tgtField.name,
      rows_affected: appliedRows,
    }
  )

  revalidatePath(`/app/projects/${tm.project_id}`, 'layout')
  return { success: true, rowsAffected: appliedRows }
}

// ── previewTransformDistinct ──────────────────────────────────────────────────
// Returns all distinct (before, after, count) triples for a SQL expression.
// Used by the "All Distinct Values" toggle in the live preview panel.
// For many-to-one mappings pass contributingFieldNames so the before-values
// object includes all contributing source fields, not just the primary.

export async function previewTransformDistinct(
  fieldMappingId: string,
  sql: string,
  contributingFieldNames?: string[]
): Promise<{
  success: boolean
  results?: { before: string | null; beforeValues: Record<string, string | null>; after: string | null; count: number }[]
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
  const perm = await requireProjectPermission(tm.project_id, 'viewer')
  if (!perm.allowed) return { success: false, error: perm.error }

  const srcField = fm.source_field_id
    ? (await supabase.from('fields').select('id, name, table_id').eq('id', fm.source_field_id).single()).data
    : null
  if (fm.source_field_id && !srcField) return { success: false, error: 'Source field not found' }

  const sourceTableId = srcField?.table_id ?? tm.source_table_id
  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(sql.replace(/;+$/, '').trim(), fieldNames)

  const sourceFields = srcField ? [srcField.name, ...(contributingFieldNames ?? [])] : (contributingFieldNames ?? [])
  if (sourceFields.length === 0) sourceFields.push('_none_')

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
    'execute_transform_test_distinct',
    {
      p_table_id: sourceTableId,
      p_source_fields: sourceFields,
      p_transform_sql: wrappedSql,
      p_limit: 200,
    }
  )

  if (rpcErr) {
    return { success: false, error: rpcErr.message }
  }

  const rows = (rpcResult as { before_values: unknown; after_value: unknown; occurrence_count: number }[]) ?? []
  const results = rows.map((r) => {
    const bv = r.before_values as Record<string, string | null> | null
    // If the DB returned an error sentinel, surface it
    if (bv && (bv as { _error?: boolean })._error) {
      return { before: null, beforeValues: {} as Record<string, string | null>, after: r.after_value != null ? String(r.after_value) : null, count: 0 }
    }
    const primaryVal = bv && srcField ? (bv[srcField.name] ?? null) : null
    return {
      before: primaryVal != null ? String(primaryVal) : null,
      beforeValues: (bv ?? {}) as Record<string, string | null>,
      after: r.after_value != null ? String(r.after_value) : null,
      count: r.occurrence_count ?? 0,
    }
  })

  return { success: true, results }
}

// ── suggestTransformDescription ───────────────────────────────────────────────

const SUGGEST_SYSTEM_PROMPT = `You are a data migration expert. Given context about a source-to-target field mapping, generate a concise natural language description of how this field should be transformed.

The description will be fed directly into a SQL transform generator, so be specific and actionable. Include:
- The type of transformation needed (value mapping, format change, type conversion, etc.)
- Specific value mappings if the value distribution and documentation make them clear
- How to handle edge cases (nulls are handled automatically — do NOT include null handling instructions)
- Any truncation, formatting, or normalization rules

Write as a direct instruction. Keep it under 2-3 sentences for simple transforms, or use a clear mapping format for value mappings.

Examples of good descriptions:
- "Convert to uppercase and trim whitespace"
- "Strip $ signs and commas, then cast to decimal number"
- "Map industry names to codes: Technology=TECH, Manufacturing=MANU, Healthcare=HLTH. All other non-null values=OTHR"
- "Parse mixed date formats (MM/DD/YYYY and YYYY-MM-DD) to ISO 8601 (YYYY-MM-DD)"
- "Convert boolean representations (Y/N, yes/no, 1/0, true/false) to PostgreSQL TRUE/FALSE"
- "Strip CUST- prefix and return the numeric portion as a string"

Return ONLY the description text — no explanation, no preamble, no markdown.`

export async function suggestTransformDescription(
  fieldMappingId: string
): Promise<{ success: boolean; suggestion?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  // Fetch field mapping with context
  const { data: fm } = await supabase
    .from('field_mappings')
    .select('id, source_field_id, target_field_id, type_compatibility, confidence, ai_reasoning, table_mapping_id')
    .eq('id', fieldMappingId)
    .single()
  if (!fm) return { success: false, error: 'Field mapping not found' }

  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', fm.table_mapping_id)
    .single()
  if (!tm) return { success: false, error: 'Mapping not found' }
  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const srcField = fm.source_field_id
    ? (await supabase.from('fields').select('id, name, data_type, inferred_type, is_nullable').eq('id', fm.source_field_id).single()).data
    : null
  const { data: tgtField } = await supabase.from('fields').select('id, name, data_type, inferred_type, is_nullable').eq('id', fm.target_field_id).single()
  if (fm.source_field_id && !srcField) return { success: false, error: 'Source field not found' }
  if (!tgtField) return { success: false, error: 'Target field not found' }

  const fieldIds = srcField ? [srcField.id, tgtField.id] : [tgtField.id]
  const ctx = await buildAIContext(tm.project_id, {
    tableIds: [tm.source_table_id, tm.target_table_id],
    fieldIds,
    includeProfilingStats: true,
    includeValueDistributions: true,
    includeSampleValues: true,
    includeDocuments: true,
    maxDistributionValues: 20,
  }, user.id)

  const srcFieldCtx = srcField ? ctx.source_tables.flatMap((t) => t.fields).find((f) => f.name === srcField.name) : null
  const tgtFieldCtx = ctx.target_tables.flatMap((t) => t.fields).find((f) => f.name === tgtField.name)
  const docsBlock = formatDocumentsForPrompt(ctx.documents)

  const fmWithReasoning = fm as typeof fm & { ai_reasoning?: string | null }

  const sourceBlock = srcField
    ? `<source_field>\n${srcFieldCtx ? formatFieldForPrompt(srcFieldCtx) : `${srcField.name} (${srcField.data_type})\n  Nullable: ${srcField.is_nullable}`}\n</source_field>`
    : `<source_field>\nNo source field — this is a value assignment. Define a constant or expression for the target field.\n</source_field>`

  const userMessage = `${sourceBlock}

<target_field>
${tgtField.name} (${tgtField.data_type}${tgtField.inferred_type ? `, ${tgtField.inferred_type}` : ''})
Nullable: ${tgtField.is_nullable}
${tgtFieldCtx && tgtFieldCtx.cardinality > 0 ? `Distinct values: ${tgtFieldCtx.cardinality}` : ''}
</target_field>

<mapping_context>
Type compatibility: ${fm.type_compatibility ?? 'Not specified'}
Confidence: ${fm.confidence ?? 'N/A'}%
AI reasoning: ${fmWithReasoning.ai_reasoning ?? 'Not available'}
</mapping_context>
${docsBlock}
${ctx.intelligence_context ? ctx.intelligence_context + '\n\n' : ''}Suggest a transformation description for this field mapping.`

  let suggestion: string
  try {
    suggestion = await callClaude(SUGGEST_SYSTEM_PROMPT, userMessage, 256)
  } catch {
    return { success: false, error: 'AI suggestion failed. Please describe the transformation manually.' }
  }

  return { success: true, suggestion: suggestion.trim() }
}

// ── Dismiss / reinstate needs_transformation ──────────────────────────────────

/**
 * Marks a field mapping as NOT needing transformation.
 * Used when the AI incorrectly flagged a direct-passthrough field.
 * Does NOT delete any existing transformation record.
 */
export async function dismissTransformNeeded(
  projectId: string,
  fieldMappingId: string,
): Promise<{ success: boolean; error?: string }> {
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }
  const supabase = await createClient()
  const { error } = await supabase
    .from('field_mappings')
    .update({ needs_transformation: false })
    .eq('id', fieldMappingId)
  if (error) throw new Error(`Failed to dismiss transform: ${error.message}`)
  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

/**
 * Reinstates a field mapping as needing transformation.
 * Used to undo a previous dismissal.
 */
export async function reinstateTransformNeeded(
  projectId: string,
  fieldMappingId: string,
): Promise<{ success: boolean; error?: string }> {
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }
  const supabase = await createClient()
  const { error } = await supabase
    .from('field_mappings')
    .update({ needs_transformation: true })
    .eq('id', fieldMappingId)
  if (error) throw new Error(`Failed to reinstate transform: ${error.message}`)
  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}
