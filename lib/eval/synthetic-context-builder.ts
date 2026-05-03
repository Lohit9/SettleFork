/**
 * Phase 1 PR 10.4 — synthetic context builder for the eval runner.
 *
 * Inserts the minimum DB rows the production AI entry point
 * (`runMappingGenerationForPair`) needs to do its work:
 *
 *   project (created upstream by createSyntheticProject)
 *   ↓
 *   source dataset (role='source') + target dataset (role='target')
 *   ↓
 *   source table + target table (both with the schema-defined fields)
 *   ↓
 *   table_mappings row (status='approved' so the engine accepts it)
 *
 * Returns the inserted ids plus name→id lookups for translating gold
 * field labels to the field-uuids the scorer expects.
 *
 * Teardown is implicit: deleting the project cascades through every
 * child via ON DELETE CASCADE, so the eval runner's
 * `teardownSyntheticProject` (PR 10.1) cleans this up automatically.
 *
 * Per-example overhead at the fixture's scale (1 source table + 1
 * target table, 4 fields total): ~7 INSERTs before the AI call. For a
 * full 60-example NetSuite→Rootstock dataset (~10 tables × 50 fields),
 * scales to ~70 inserts/example × 60 = ~4200 inserts total → measured
 * in ~5s of DB latency per example, ~5min total wall-clock for the
 * baseline run. Acceptable.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import type { DatasetSchema, SchemaField } from '@/lib/eval/types'

export interface BuildMappingContextInput {
  projectId: string
  schema: DatasetSchema
  /** Must match a `name` in `schema.source.tables`. */
  sourceTableName: string
  /** Must match a `name` in `schema.target.tables`. */
  targetTableName: string
  /**
   * Path 2 PR 2 B-1: when true, insert a `field_profiles` row per
   * source field with hand-crafted realistic stats. The Hard-tier
   * eval features (quality_issues, extracted_patterns, fix_options)
   * all depend on field profiles for the AI to surface meaningful
   * signal — without profiles, the AI sees "perfect data" and emits
   * nothing. Per-field stat values are documented inline below.
   */
  withFieldProfiles?: boolean
  /**
   * Path 2 PR 2 B-1: when set, insert one `quality_issues` row tagged
   * to a named source field. The fix_options eval requires a
   * pre-existing issueId as input; this seeds it. The inserted row's
   * id is returned via `BuiltMappingContext.qualityIssueId`.
   */
  seedQualityIssue?: {
    /** Must match a name in `schema.source.tables[*].fields`. */
    fieldName: string
    severity: 'blocking' | 'warning'
    title: string
    description: string
  }
}

export interface BuiltMappingContext {
  projectId: string
  sourceDatasetId: string
  targetDatasetId: string
  sourceTableId: string
  targetTableId: string
  tableMappingId: string
  /** name → field id, for translating gold field labels to scorer ids. */
  sourceFieldsByName: Map<string, string>
  targetFieldsByName: Map<string, string>
  /** Populated only when `seedQualityIssue` was set on the input. */
  qualityIssueId?: string
}

/**
 * Build the minimum row set for one mapping example.
 *
 * Throws on:
 *   - Either named table missing from `schema`
 *   - Any DB insert failing (FK violation, RLS denial, unique constraint, etc.)
 *
 * Caller is responsible for project teardown — typically wrapped in a
 * try/finally that calls `teardownSyntheticProject(projectId)`.
 */
export async function buildSyntheticMappingContext(
  input: BuildMappingContextInput,
): Promise<BuiltMappingContext> {
  const sourceTableSpec = input.schema.source.tables.find(
    (t) => t.name === input.sourceTableName,
  )
  if (!sourceTableSpec) {
    throw new Error(
      `[eval/synthetic-context] source table "${input.sourceTableName}" not in schema. Available: ${input.schema.source.tables.map((t) => t.name).join(', ')}`,
    )
  }
  const targetTableSpec = input.schema.target.tables.find(
    (t) => t.name === input.targetTableName,
  )
  if (!targetTableSpec) {
    throw new Error(
      `[eval/synthetic-context] target table "${input.targetTableName}" not in schema. Available: ${input.schema.target.tables.map((t) => t.name).join(', ')}`,
    )
  }

  // 1. datasets — one source + one target.
  const { data: sourceDs, error: sdErr } = await supabaseAdmin
    .from('datasets')
    .insert({
      project_id: input.projectId,
      role: 'source',
      name: 'eval-source',
    })
    .select('id')
    .single()
  if (sdErr || !sourceDs) {
    throw new Error(
      `[eval/synthetic-context] insert source dataset failed: ${sdErr?.message ?? 'no row'}`,
    )
  }

  const { data: targetDs, error: tdErr } = await supabaseAdmin
    .from('datasets')
    .insert({
      project_id: input.projectId,
      role: 'target',
      name: 'eval-target',
    })
    .select('id')
    .single()
  if (tdErr || !targetDs) {
    throw new Error(
      `[eval/synthetic-context] insert target dataset failed: ${tdErr?.message ?? 'no row'}`,
    )
  }

  // 2. tables — one per side.
  const { data: srcTbl, error: stErr } = await supabaseAdmin
    .from('tables')
    .insert({
      dataset_id: sourceDs.id,
      name: sourceTableSpec.name,
    })
    .select('id')
    .single()
  if (stErr || !srcTbl) {
    throw new Error(
      `[eval/synthetic-context] insert source table failed: ${stErr?.message ?? 'no row'}`,
    )
  }

  const { data: tgtTbl, error: ttErr } = await supabaseAdmin
    .from('tables')
    .insert({
      dataset_id: targetDs.id,
      name: targetTableSpec.name,
    })
    .select('id')
    .single()
  if (ttErr || !tgtTbl) {
    throw new Error(
      `[eval/synthetic-context] insert target table failed: ${ttErr?.message ?? 'no row'}`,
    )
  }

  // 3. fields — bulk insert per side. ordinal_position is 1-indexed.
  const sourceFieldRows = sourceTableSpec.fields.map((f, i) =>
    fieldRow(srcTbl.id as string, f, i + 1),
  )
  const targetFieldRows = targetTableSpec.fields.map((f, i) =>
    fieldRow(tgtTbl.id as string, f, i + 1),
  )

  const { data: srcFields, error: sfErr } = await supabaseAdmin
    .from('fields')
    .insert(sourceFieldRows)
    .select('id, name')
  if (sfErr || !srcFields) {
    throw new Error(
      `[eval/synthetic-context] insert source fields failed: ${sfErr?.message ?? 'no rows'}`,
    )
  }

  const { data: tgtFields, error: tfErr } = await supabaseAdmin
    .from('fields')
    .insert(targetFieldRows)
    .select('id, name')
  if (tfErr || !tgtFields) {
    throw new Error(
      `[eval/synthetic-context] insert target fields failed: ${tfErr?.message ?? 'no rows'}`,
    )
  }

  const sourceFieldsByName = new Map<string, string>(
    (srcFields as Array<{ id: string; name: string }>).map((f) => [f.name, f.id]),
  )
  const targetFieldsByName = new Map<string, string>(
    (tgtFields as Array<{ id: string; name: string }>).map((f) => [f.name, f.id]),
  )

  // 4. table_mappings — status='approved' so the engine accepts it.
  // The mapping engine refuses to generate against rejected pairs.
  const { data: tm, error: tmErr } = await supabaseAdmin
    .from('table_mappings')
    .insert({
      project_id: input.projectId,
      source_table_id: srcTbl.id,
      target_table_id: tgtTbl.id,
      status: 'approved',
      confidence: 100,
      ai_reasoning: 'eval-synthetic context — confidence is a placeholder',
    })
    .select('id')
    .single()
  if (tmErr || !tm) {
    throw new Error(
      `[eval/synthetic-context] insert table_mapping failed: ${tmErr?.message ?? 'no row'}`,
    )
  }

  // Path 2 PR 2 B-1: optional `field_profiles` rows for source fields.
  // Hand-crafted stats designed to surface AI behavior in the Hard-tier
  // smoke fixtures: every field has SOME imperfection (non-zero null_count
  // OR cardinality < total_rows) so the quality_issues / extracted_patterns
  // / fix_options scorers see meaningful AI output.
  if (input.withFieldProfiles) {
    const profileRows = (srcFields as Array<{ id: string; name: string }>).map(
      (f) => fieldProfileRow(f.id, f.name),
    )
    const { error: fpErr } = await supabaseAdmin.from('field_profiles').insert(profileRows)
    if (fpErr) {
      throw new Error(
        `[eval/synthetic-context] insert field_profiles failed: ${fpErr.message}`,
      )
    }
  }

  // Path 2 PR 2 B-1: optional seed `quality_issues` row. The fix_options
  // eval requires a pre-existing issueId as input — this seeds it from
  // the fixture's `seed_issue` block.
  let qualityIssueId: string | undefined
  if (input.seedQualityIssue) {
    const seed = input.seedQualityIssue
    const fieldId = sourceFieldsByName.get(seed.fieldName)
    if (!fieldId) {
      throw new Error(
        `[eval/synthetic-context] seedQualityIssue references unknown source field "${seed.fieldName}"`,
      )
    }
    const { data: qiRow, error: qiErr } = await supabaseAdmin
      .from('quality_issues')
      .insert({
        project_id: input.projectId,
        table_id: srcTbl.id,
        field_id: fieldId,
        stage: 'source',
        severity: seed.severity,
        title: seed.title,
        description: seed.description,
        affected_records: 0,
        status: 'open',
      })
      .select('id')
      .single()
    if (qiErr || !qiRow) {
      throw new Error(
        `[eval/synthetic-context] insert seed quality_issues failed: ${qiErr?.message ?? 'no row'}`,
      )
    }
    qualityIssueId = qiRow.id as string
  }

  return {
    projectId: input.projectId,
    sourceDatasetId: sourceDs.id as string,
    targetDatasetId: targetDs.id as string,
    sourceTableId: srcTbl.id as string,
    targetTableId: tgtTbl.id as string,
    tableMappingId: tm.id as string,
    sourceFieldsByName,
    targetFieldsByName,
    ...(qualityIssueId !== undefined ? { qualityIssueId } : {}),
  }
}

function fieldRow(
  tableId: string,
  spec: SchemaField,
  ordinalPosition: number,
): Record<string, unknown> {
  return {
    table_id: tableId,
    name: spec.name,
    data_type: spec.data_type,
    is_nullable: spec.is_nullable,
    is_primary_key: spec.is_primary_key ?? false,
    is_foreign_key: spec.is_foreign_key ?? false,
    ordinal_position: ordinalPosition,
  }
}

/**
 * Hand-crafted `field_profiles` row stats per locked decision B1.
 *
 * Per-field strategy: name-based dispatch picks values that
 * (a) match what the synthetic schema is documenting (e.g., a `name`
 * field gets human-name samples; an `id` field gets high-cardinality
 * uuid-shaped samples), and
 * (b) introduce realistic imperfections (non-zero null_count OR
 * cardinality < total_rows) so the AI surfaces meaningful issues
 * rather than seeing "perfect data".
 *
 * Field profiles cascade-clean automatically: field_profiles → fields
 * → tables → datasets → projects (all FK ON DELETE CASCADE).
 */
function fieldProfileRow(fieldId: string, fieldName: string): Record<string, unknown> {
  // Default profile (any field name not specifically handled): some
  // null_count, moderate cardinality, mixed sample values.
  let totalRows = 100
  let nullCount = 5
  let nullPercentage = 5.0
  let cardinality = 87
  let uniquePercentage = 87.0
  let sampleValues: string[] = ['value1', 'value2', 'value3', 'value4', 'value5']
  let minValue: string | null = 'value1'
  let maxValue: string | null = 'value5'

  const lower = fieldName.toLowerCase()
  if (lower === 'name' || lower.endsWith('_name')) {
    // Human-name field: 5% null, high cardinality, plausible name samples.
    sampleValues = ['Alice', 'Bob', 'Carol', 'David', 'Eve']
    minValue = 'Alice'
    maxValue = 'Zoe'
  } else if (lower === 'id' || lower.endsWith('_id')) {
    // ID field: typically NOT NULL + high uniqueness, no nulls.
    nullCount = 0
    nullPercentage = 0.0
    cardinality = 100
    uniquePercentage = 100.0
    sampleValues = [
      'a1b2c3d4-0001',
      'a1b2c3d4-0002',
      'a1b2c3d4-0003',
      'a1b2c3d4-0004',
      'a1b2c3d4-0005',
    ]
    minValue = 'a1b2c3d4-0001'
    maxValue = 'z9y8x7w6-9999'
  } else if (lower === 'label' || lower === 'description' || lower === 'title') {
    // Text label field: moderate nulls, lower cardinality.
    nullCount = 12
    nullPercentage = 12.0
    cardinality = 60
    uniquePercentage = 60.0
    sampleValues = ['Active', 'Inactive', 'Pending', 'Closed', 'Open']
  }

  return {
    field_id: fieldId,
    total_rows: totalRows,
    null_count: nullCount,
    null_percentage: nullPercentage,
    cardinality,
    unique_percentage: uniquePercentage,
    format_issues_count: 0,
    min_value: minValue,
    max_value: maxValue,
    sample_values: sampleValues,
  }
}
