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

  return {
    projectId: input.projectId,
    sourceDatasetId: sourceDs.id as string,
    targetDatasetId: targetDs.id as string,
    sourceTableId: srcTbl.id as string,
    targetTableId: tgtTbl.id as string,
    tableMappingId: tm.id as string,
    sourceFieldsByName,
    targetFieldsByName,
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
