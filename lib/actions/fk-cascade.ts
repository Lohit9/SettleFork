'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { resetFieldTransform } from '@/lib/actions/transformations'

export interface FKDependent {
  fieldId: string
  fieldName: string
  tableName: string
  tableId: string
  fieldMappingId: string | null
  hasExistingTransform: boolean
  existingTransformStatus: string | null
}

/**
 * Given a target PK field that just had a transform applied,
 * find all FK fields in other target tables that reference it.
 *
 * Uses the same fk_reference parsing approach as computeLoadOrder
 * in execution-package.ts (split('.'), case-insensitive match).
 */
export async function findFKDependents(
  projectId: string,
  pkFieldId: string
): Promise<{ dependents: FKDependent[]; pkTableName: string; pkFieldName: string }> {
  const supabase = await createClient()

  const { data: pkField } = await supabase
    .from('fields')
    .select('id, name, table_id, is_primary_key')
    .eq('id', pkFieldId)
    .single()

  if (!pkField || !pkField.is_primary_key) {
    return { dependents: [], pkTableName: '', pkFieldName: '' }
  }

  const { data: pkTable } = await supabase
    .from('tables')
    .select('id, name, dataset_id')
    .eq('id', pkField.table_id)
    .single()

  if (!pkTable) {
    return { dependents: [], pkTableName: '', pkFieldName: '' }
  }

  // Get the target dataset for this project
  const { data: dataset } = await supabase
    .from('datasets')
    .select('id')
    .eq('project_id', projectId)
    .eq('role', 'target')
    .single()

  if (!dataset) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  // Get ALL target tables for this project
  const { data: targetTables } = await supabase
    .from('tables')
    .select('id, name')
    .eq('dataset_id', dataset.id)

  if (!targetTables || targetTables.length === 0) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  const targetTableIds = targetTables.map((t) => t.id)
  const tableNameById = new Map(targetTables.map((t) => [t.id, t.name]))

  // Get all FK fields across all target tables
  const { data: allFKFields } = await supabase
    .from('fields')
    .select('id, name, table_id, is_foreign_key, fk_reference')
    .in('table_id', targetTableIds)
    .eq('is_foreign_key', true)

  if (!allFKFields || allFKFields.length === 0) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  // Filter to FK fields that reference this PK field.
  // fk_reference format: "TableName.column_name" or "schema.TableName.column_name"
  // Use case-insensitive comparison to handle CSV fallback capitalisation differences.
  const pkRefString = `${pkTable.name}.${pkField.name}`.toLowerCase()

  const matchingFKFields = allFKFields.filter((f) => {
    if (!f.fk_reference) return false
    // Skip FK fields in the same table as the PK (self-referencing)
    if (f.table_id === pkField.table_id) return false

    const parts = f.fk_reference.split('.')
    if (parts.length < 2) return false
    const refString = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
    return refString.toLowerCase() === pkRefString
  })

  if (matchingFKFields.length === 0) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  const fkFieldIds = matchingFKFields.map((f) => f.id)

  // Find field_mappings for these FK fields (primary / non-contributing, non-rejected)
  const { data: fkFieldMappings } = await supabase
    .from('field_mappings')
    .select('id, target_field_id, status')
    .in('target_field_id', fkFieldIds)
    .eq('is_contributing', false)
    .neq('status', 'rejected')

  const fmByTargetField = new Map(
    (fkFieldMappings ?? []).map((fm) => [fm.target_field_id, fm])
  )

  // Find existing transforms for these field_mappings
  const fmIds = (fkFieldMappings ?? []).map((fm) => fm.id)
  const existingTransforms = new Map<string, { status: string }>()

  if (fmIds.length > 0) {
    const { data: transforms } = await supabase
      .from('transformations')
      .select('field_mapping_id, status')
      .in('field_mapping_id', fmIds)

    for (const t of transforms ?? []) {
      existingTransforms.set(t.field_mapping_id, { status: t.status })
    }
  }

  const dependents: FKDependent[] = matchingFKFields.map((f) => {
    const fm = fmByTargetField.get(f.id)
    const transform = fm ? existingTransforms.get(fm.id) : null
    return {
      fieldId: f.id,
      fieldName: f.name,
      tableName: tableNameById.get(f.table_id) ?? 'Unknown',
      tableId: f.table_id,
      fieldMappingId: fm?.id ?? null,
      hasExistingTransform: !!transform,
      existingTransformStatus: transform?.status ?? null,
    }
  })

  return { dependents, pkTableName: pkTable.name, pkFieldName: pkField.name }
}

/**
 * Apply the same transform SQL to one or more FK field_mappings and immediately
 * write the transformed values into staged_data_rows via the same RPC that
 * applyTransform uses.
 *
 * Each field_mapping gets an independent copy of the SQL (status: 'applied').
 * If the RPC call fails for a particular FK field the transform record is
 * reverted to 'draft' so the user can see it needs manual attention.
 */
export async function cascadeTransformToFKs(
  fkFieldMappingIds: string[],
  pkTransformSQL: string,
  pkTransformDescription: string,
  pkTableName: string,
  pkFieldName: string
): Promise<{ success: boolean; cascadedCount: number; error?: string }> {
  const supabase = await createClient()

  let cascadedCount = 0
  const cascadeDescription = `Cascaded from ${pkTableName}.${pkFieldName}: ${pkTransformDescription}`

  for (const fmId of fkFieldMappingIds) {
    // ── 1. Upsert the transform record (optimistically as 'applied') ───────────
    const { data: existing } = await supabase
      .from('transformations')
      .select('id')
      .eq('field_mapping_id', fmId)
      .maybeSingle()

    let upsertError = false

    if (existing) {
      const { error } = await supabase
        .from('transformations')
        .update({
          generated_sql: pkTransformSQL,
          description: cascadeDescription,
          is_ai_generated: true,
          status: 'applied',
          test_results: null,
        })
        .eq('id', existing.id)
      if (error) { upsertError = true }
    } else {
      const { error } = await supabase
        .from('transformations')
        .insert({
          field_mapping_id: fmId,
          generated_sql: pkTransformSQL,
          description: cascadeDescription,
          is_ai_generated: true,
          status: 'applied',
          test_results: null,
        })
      if (error) { upsertError = true }
    }

    if (upsertError) continue

    // Mark the field_mapping as needing transformation so it surfaces in the sidebar
    await supabase
      .from('field_mappings')
      .update({ needs_transformation: true })
      .eq('id', fmId)

    // ── 2. Resolve the ownership chain (mirrors applyTransform) ───────────────
    const { data: fm } = await supabase
      .from('field_mappings')
      .select('id, source_field_id, target_field_id, table_mapping_id')
      .eq('id', fmId)
      .single()

    if (!fm) continue

    const { data: tm } = await supabase
      .from('table_mappings')
      .select('id, source_table_id, target_table_id')
      .eq('id', fm.table_mapping_id)
      .single()

    if (!tm) continue

    // ── 3. Resolve field names and wrap SQL (mirrors applyTransform) ──────────
    const srcField = fm.source_field_id
      ? (await supabase.from('fields').select('id, name, table_id').eq('id', fm.source_field_id).single()).data
      : null
    const { data: tgtField } = await supabase
      .from('fields')
      .select('id, name')
      .eq('id', fm.target_field_id)
      .single()

    if (!tgtField) continue

    const sourceTableId = srcField?.table_id ?? tm.source_table_id
    const { data: allSourceFields } = await supabase
      .from('fields')
      .select('name')
      .eq('table_id', sourceTableId)

    const fieldNames = (allSourceFields ?? []).map((f) => f.name)
    const wrappedSql = wrapFieldRefsInJsonb(pkTransformSQL.replace(/;+$/, '').trim(), fieldNames)

    // ── 4. Check if staged rows already exist for this table mapping ──────────
    const { count: stagedCount } = await supabaseAdmin
      .from('staged_data_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_mapping_id', tm.id)

    const hasExistingStaged = (stagedCount ?? 0) > 0

    // ── 5. Apply via the same RPC used by applyTransform ─────────────────────
    const { error: rpcErr } = await supabaseAdmin.rpc('dq_apply_field_transform', {
      p_table_mapping_id: tm.id,
      p_source_table_id: tm.source_table_id,
      p_target_table_id: tm.target_table_id,
      p_target_field_name: tgtField.name,
      p_transform_sql: wrappedSql,
      p_has_existing_staged: hasExistingStaged,
    })

    if (rpcErr) {
      // Revert transform status to draft so user can see it needs attention
      console.error(`FK cascade RPC failed for field_mapping ${fmId}:`, rpcErr.message)
      await supabase
        .from('transformations')
        .update({ status: 'draft' })
        .eq('field_mapping_id', fmId)
      continue
    }

    cascadedCount++
  }

  return { success: true, cascadedCount }
}

/**
 * When a PK field's mapping or transform is reset, also reset the transforms
 * on all FK fields that reference it — they produce values that must remain
 * consistent with the PK (e.g. matter_id format across TC_MATTERS / TC_INVOICES).
 *
 * Called from resetFieldTransform via dynamic import to avoid a circular
 * dependency between transformations.ts and fk-cascade.ts.
 * Pass { skipFKCascade: true } when calling resetFieldTransform internally
 * to prevent infinite recursion.
 */
export async function resetFKDependentTransforms(
  projectId: string,
  targetFieldId: string
): Promise<{ success: boolean; dependentsReset: number; stagedRowsReverted: number }> {
  // 1. Confirm this target field is a PK — only PKs have FK dependents
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, is_primary_key')
    .eq('id', targetFieldId)
    .single()

  if (!targetField?.is_primary_key) {
    return { success: true, dependentsReset: 0, stagedRowsReverted: 0 }
  }

  // 2. Find all FK fields that reference this PK (reuses existing findFKDependents)
  const { dependents } = await findFKDependents(projectId, targetFieldId)

  if (!dependents || dependents.length === 0) {
    return { success: true, dependentsReset: 0, stagedRowsReverted: 0 }
  }

  // 3. Reset each FK dependent that has a field mapping and a transform
  let dependentsReset = 0
  let stagedRowsReverted = 0

  for (const dep of dependents) {
    if (!dep.fieldMappingId) continue
    if (!dep.hasExistingTransform) continue

    // Pass skipFKCascade: true to avoid infinite recursion
    const resetResult = await resetFieldTransform(dep.fieldMappingId, { skipFKCascade: true })
    if (resetResult.hadTransform) dependentsReset++
    stagedRowsReverted += resetResult.rowsReverted
  }

  return { success: true, dependentsReset, stagedRowsReverted }
}

/**
 * When a PK transform is regenerated or its mapping changes, mark FK dependent
 * transforms as 'stale' rather than deleting them. This preserves the SQL for
 * reference (the user can re-test or re-cascade) while making it clear the
 * transform may no longer produce values consistent with the PK.
 * Staged data for stale transforms is reverted — stale output shouldn't stay
 * in staged_data_rows since it may not match the new PK format.
 */
export async function staleFKDependentTransforms(
  projectId: string,
  targetFieldId: string
): Promise<{ success: boolean; dependentsStaled: number; stagedRowsReverted: number }> {
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, is_primary_key')
    .eq('id', targetFieldId)
    .single()

  if (!targetField?.is_primary_key) {
    return { success: true, dependentsStaled: 0, stagedRowsReverted: 0 }
  }

  const { dependents } = await findFKDependents(projectId, targetFieldId)
  if (!dependents || dependents.length === 0) {
    return { success: true, dependentsStaled: 0, stagedRowsReverted: 0 }
  }

  let dependentsStaled = 0
  let stagedRowsReverted = 0

  for (const dep of dependents) {
    if (!dep.fieldMappingId) continue
    if (!dep.hasExistingTransform) continue

    // Mark the transform as stale — keep the SQL for reference
    await supabaseAdmin
      .from('transformations')
      .update({ status: 'stale' })
      .eq('field_mapping_id', dep.fieldMappingId)

    // Revert staged data: stale output shouldn't remain in staged_data_rows
    if (dep.existingTransformStatus === 'applied') {
      const { data: fmData } = await supabaseAdmin
        .from('field_mappings')
        .select('table_mapping_id, target_field_id, fields!field_mappings_target_field_id_fkey(name)')
        .eq('id', dep.fieldMappingId)
        .single()

      if (fmData) {
        const targetFieldName = (fmData as unknown as { fields: { name: string } | null }).fields?.name
        if (targetFieldName) {
          const { data: count } = await supabaseAdmin.rpc('revert_field_transform', {
            p_table_mapping_id: fmData.table_mapping_id,
            p_target_field_name: targetFieldName,
          })
          stagedRowsReverted += (count as number) ?? 0
        }
      }
    }

    dependentsStaled++
  }

  return { success: true, dependentsStaled, stagedRowsReverted }
}

/**
 * Lightweight pre-edit check used by the Mapping page before saving a source
 * field change. Returns the FK dependent count so the UI can warn the user that
 * changing a PK's source will stale all dependent FK transforms.
 */
export async function checkPKSourceChangeImpact(
  fieldMappingId: string
): Promise<{ isPK: boolean; fkDependentCount: number; dependentNames: string[] }> {
  const { data: fm } = await supabaseAdmin
    .from('field_mappings')
    .select('target_field_id, table_mappings!inner(project_id)')
    .eq('id', fieldMappingId)
    .single()

  if (!fm) return { isPK: false, fkDependentCount: 0, dependentNames: [] }

  const { data: tgtField } = await supabaseAdmin
    .from('fields')
    .select('is_primary_key')
    .eq('id', fm.target_field_id)
    .single()

  if (!tgtField?.is_primary_key) return { isPK: false, fkDependentCount: 0, dependentNames: [] }

  const projectId = (fm as unknown as { table_mappings: { project_id: string } }).table_mappings.project_id
  const { dependents } = await findFKDependents(projectId, fm.target_field_id)
  const mapped = dependents.filter((d) => d.fieldMappingId !== null)

  return {
    isPK: true,
    fkDependentCount: mapped.length,
    dependentNames: mapped.map((d) => `${d.tableName}.${d.fieldName}`),
  }
}
