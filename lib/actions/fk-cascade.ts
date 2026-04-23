'use server'

/**
 * FK cascade logic for the redesigned mapping model.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ID SEMANTICS (Prompt 3b, Gate 2 decision)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * This module operates on bare `target_field_mappings.id` (UUID) values, NOT
 * the composite shimmed ids emitted by `lib/compat/mapping-shim.ts` for
 * contributor FieldItem rows. The decision at Gate 2 was:
 *
 *   "Shim coupling contained to transformations.ts only. fk-cascade.ts does
 *    not import from mapping-shim directly."
 *
 * Rationale:
 *   • `findFKDependents` is a read-only query that fabricates the ids it
 *     returns from `target_field_mappings.id` — always bare.
 *   • `cascadeTransformToFKs` is only called with ids that come out of
 *     `findFKDependents` (see TransformContent.tsx). Bare by construction.
 *   • `resetFKDependentTransforms` / `staleFKDependentTransforms` are called
 *     internally from `transformations.ts` with `ctx.tfm.id` — bare by
 *     construction.
 *   • `checkPKSourceChangeImpact` is the only entry that can receive a
 *     shimmed composite id (the Mapping page passes whatever the user
 *     clicked). To avoid importing the shim, a *minimal* local helper
 *     strips the contributor suffix. The separator literal matches
 *     `SHIMMED_ID_SEPARATOR` in `lib/compat/mapping-shim.ts`; if that
 *     separator ever changes the `mapping-shim.test.ts` snapshot test
 *     will fail first and this file will be updated alongside.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * APPLY RPC WIRING (Gate 2 Q2 / G-a decisions)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * `cascadeTransformToFKs` uses `dq_apply_field_transform_joined` EXCLUSIVELY.
 * FK cascade applies only to mapped dependents (a Value Assignment is a
 * constant that does not depend on the PK's source value), so the legacy
 * `dq_apply_field_transform` RPC is never called from here.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * MAINTENANCE GUARD
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * `cascadeTransformToFKs` is a UI-initiated write and threads through
 * `guardWrites(projectId, …)`. The two internal helpers
 * (`resetFKDependentTransforms`, `staleFKDependentTransforms`) are called
 * from *already-guarded* paths in `transformations.ts`; they deliberately
 * do NOT re-assert the guard to avoid double-throw at the apply boundary
 * — the outer `applyTransform` / `resetFieldTransform` already failed fast
 * if the project is in maintenance mode.
 *
 * `findFKDependents` and `checkPKSourceChangeImpact` are read-only and
 * unguarded.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { resetFieldTransform } from '@/lib/actions/transformations'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import type { TransformationStatus } from '@/lib/types/mapping-redesign'

// ─── Shared types ────────────────────────────────────────────────────────────

export interface FKDependent {
  fieldId: string
  fieldName: string
  tableName: string
  tableId: string
  /**
   * Bare `target_field_mappings.id`, or NULL when the FK target field has
   * no primary TFM yet. The legacy field name is preserved so existing
   * UI (`TransformContent.tsx`) continues to compile without edits.
   */
  fieldMappingId: string | null
  hasExistingTransform: boolean
  existingTransformStatus: string | null
}

export type FKCascadeWriteErrorCode =
  | 'MAINTENANCE_MODE'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VALIDATION'
  | 'INTERNAL'

// ─── Guard wiring helper ─────────────────────────────────────────────────────
//
// Mirrors the `guardWrites` helper in `lib/actions/transformations.ts`.

const MAINTENANCE_GUARD_MESSAGE =
  'Mapping writes are temporarily disabled for scheduled maintenance'

async function guardWrites<
  T extends { success: boolean; error?: string; errorCode?: FKCascadeWriteErrorCode },
>(projectId: string, body: () => Promise<T>): Promise<T> {
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === MAINTENANCE_GUARD_MESSAGE) {
      return {
        success: false,
        error: MAINTENANCE_GUARD_MESSAGE,
        errorCode: 'MAINTENANCE_MODE',
      } as T
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    } as T
  }
  return body()
}

// ─── Local id helper (see header for rationale) ──────────────────────────────

/**
 * If the caller hands us a composite shimmed id (`<tfm>::<ms>` for a
 * contributor row) we want only the TFM portion. Bare UUIDs are returned
 * untouched. See the ID SEMANTICS block above for why this helper is
 * inlined rather than imported from `lib/compat/mapping-shim`.
 */
const SHIMMED_ID_SEPARATOR_LITERAL = '::'
function extractBareTfmId(id: string): string {
  const idx = id.indexOf(SHIMMED_ID_SEPARATOR_LITERAL)
  return idx === -1 ? id : id.slice(0, idx)
}

// ─── findFKDependents ────────────────────────────────────────────────────────
//
// Given a target PK field that just had a transform applied, find all FK
// fields in other target tables that reference it and surface their primary
// `target_field_mappings` (mapped, non-rejected, non-acknowledged) along
// with any existing transformation status.
//
// Uses the same fk_reference parsing approach as computeLoadOrder in
// execution-package.ts (split('.'), case-insensitive match).

export async function findFKDependents(
  projectId: string,
  pkFieldId: string,
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

  const { data: dataset } = await supabase
    .from('datasets')
    .select('id')
    .eq('project_id', projectId)
    .eq('role', 'target')
    .single()

  if (!dataset) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  const { data: targetTables } = await supabase
    .from('tables')
    .select('id, name')
    .eq('dataset_id', dataset.id)

  if (!targetTables || targetTables.length === 0) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  const targetTableIds = targetTables.map((t) => t.id)
  const tableNameById = new Map(targetTables.map((t) => [t.id, t.name]))

  const { data: allFKFields } = await supabase
    .from('fields')
    .select('id, name, table_id, is_foreign_key, fk_reference')
    .in('table_id', targetTableIds)
    .eq('is_foreign_key', true)

  if (!allFKFields || allFKFields.length === 0) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  // fk_reference format: "TableName.column_name" or "schema.TableName.column_name".
  // Case-insensitive to tolerate CSV fallback capitalisation differences.
  const pkRefString = `${pkTable.name}.${pkField.name}`.toLowerCase()

  const matchingFKFields = allFKFields.filter((f) => {
    if (!f.fk_reference) return false
    if (f.table_id === pkField.table_id) return false // skip self-references
    const parts = f.fk_reference.split('.')
    if (parts.length < 2) return false
    const refString = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
    return refString.toLowerCase() === pkRefString
  })

  if (matchingFKFields.length === 0) {
    return { dependents: [], pkTableName: pkTable.name, pkFieldName: pkField.name }
  }

  const fkFieldIds = matchingFKFields.map((f) => f.id)

  // Load primary TFMs for the FK target fields. Filter to mapped TFMs only
  // (VAs are fixed values; they never cascade from a PK transform). Gate 2
  // Precision P1: "Add filter for EXISTS (mapping_sources …) when
  // combination_type IN ('single', 'concat_space', 'concat_comma', …)."
  // The EXISTS join is baked in naturally — we select TFMs that have at
  // least one mapping_source via the inner FK join below.
  const { data: candidateTfms } = await supabase
    .from('target_field_mappings')
    .select('id, project_id, target_field_id, status, is_acknowledged, combination_type')
    .eq('project_id', projectId)
    .in('target_field_id', fkFieldIds)
    .neq('status', 'rejected')
    .eq('is_acknowledged', false)

  type TfmRow = {
    id: string
    project_id: string
    target_field_id: string
    status: string
    is_acknowledged: boolean
    combination_type: string | null
  }

  const mappedTfms: TfmRow[] = (candidateTfms ?? []).filter(
    (tfm) => tfm.combination_type !== 'custom_sql', // 'custom_sql' = VA in the new model
  )

  // Defense in depth: drop any TFM that has zero mapping_sources (malformed).
  const tfmIds = mappedTfms.map((t) => t.id)
  const liveTfmIds = new Set<string>()
  if (tfmIds.length > 0) {
    const { data: msRows } = await supabase
      .from('mapping_sources')
      .select('target_field_mapping_id')
      .in('target_field_mapping_id', tfmIds)
    for (const row of msRows ?? []) {
      liveTfmIds.add(row.target_field_mapping_id)
    }
  }

  const primaryTfmByTargetField = new Map<string, TfmRow>()
  for (const tfm of mappedTfms) {
    if (!liveTfmIds.has(tfm.id)) continue
    primaryTfmByTargetField.set(tfm.target_field_id, tfm)
  }

  // Load existing transformations for those TFMs (unique per TFM).
  const liveTfmIdArr = Array.from(liveTfmIds)
  const existingTransforms = new Map<string, { status: string }>()
  if (liveTfmIdArr.length > 0) {
    const { data: transforms } = await supabase
      .from('transformations')
      .select('target_field_mapping_id, status')
      .in('target_field_mapping_id', liveTfmIdArr)

    for (const t of transforms ?? []) {
      existingTransforms.set(t.target_field_mapping_id, { status: t.status })
    }
  }

  const dependents: FKDependent[] = matchingFKFields.map((f) => {
    const tfm = primaryTfmByTargetField.get(f.id)
    const transform = tfm ? existingTransforms.get(tfm.id) : null
    return {
      fieldId: f.id,
      fieldName: f.name,
      tableName: tableNameById.get(f.table_id) ?? 'Unknown',
      tableId: f.table_id,
      fieldMappingId: tfm?.id ?? null,
      hasExistingTransform: !!transform,
      existingTransformStatus: transform?.status ?? null,
    }
  })

  return { dependents, pkTableName: pkTable.name, pkFieldName: pkField.name }
}

// ─── cascadeTransformToFKs ───────────────────────────────────────────────────
//
// Apply the PK's transform SQL to every selected FK dependent TFM and immediately
// write the transformed values into staged_data_rows via
// `dq_apply_field_transform_joined`. Each TFM gets an independent
// transformation record (unique per `target_field_mapping_id`). On RPC
// failure the transform row is reverted to 'draft' so the user can see it
// needs manual attention.

export async function cascadeTransformToFKs(
  fkTfmIds: string[],
  pkTransformSQL: string,
  pkTransformDescription: string,
  pkTableName: string,
  pkFieldName: string,
): Promise<{
  success: boolean
  cascadedCount: number
  cascadedTransforms: Array<{ fieldMappingId: string; transformationId: string }>
  error?: string
  errorCode?: FKCascadeWriteErrorCode
}> {
  if (fkTfmIds.length === 0) {
    return { success: true, cascadedCount: 0, cascadedTransforms: [] }
  }

  // Resolve the project id from the first TFM — they must all share it
  // (findFKDependents filters by project_id). Used for the guard + RBAC.
  const supabase = await createClient()
  const { data: firstTfm } = await supabase
    .from('target_field_mappings')
    .select('project_id')
    .eq('id', fkTfmIds[0])
    .maybeSingle<{ project_id: string }>()

  if (!firstTfm) {
    return {
      success: false,
      cascadedCount: 0,
      cascadedTransforms: [],
      error: 'Field mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const projectId = firstTfm.project_id

  return guardWrites(projectId, async () => {
    let cascadedCount = 0
    const cascadedTransforms: Array<{ fieldMappingId: string; transformationId: string }> = []
    const cascadeDescription = `Cascaded from ${pkTableName}.${pkFieldName}: ${pkTransformDescription}`
    const strippedSql = pkTransformSQL.replace(/;+$/, '').trim()

    for (const tfmId of fkTfmIds) {
      // ── 1. Upsert the transformation row (optimistically 'applied') ───────
      const { data: existing } = await supabase
        .from('transformations')
        .select('id')
        .eq('target_field_mapping_id', tfmId)
        .maybeSingle<{ id: string }>()

      let upsertError = false
      let transId: string | null = null

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
        if (error) {
          upsertError = true
        } else {
          transId = existing.id
        }
      } else {
        const { data: inserted, error } = await supabase
          .from('transformations')
          .insert({
            target_field_mapping_id: tfmId,
            generated_sql: pkTransformSQL,
            description: cascadeDescription,
            is_ai_generated: true,
            status: 'applied',
            test_results: null,
          })
          .select('id')
          .single()
        if (error) {
          upsertError = true
        } else {
          transId = inserted.id
        }
      }

      if (upsertError) continue

      // Flag the TFM as needing transformation so it surfaces in the sidebar.
      // `needs_transformation` lives on `target_field_mappings` in the new
      // model (migration 075).
      await supabase
        .from('target_field_mappings')
        .update({ needs_transformation: true })
        .eq('id', tfmId)

      // ── 2. Resolve the TFM's primary source for JSONB field wrapping ──────
      const { data: primarySrc } = await supabase
        .from('mapping_sources')
        .select('source_field_id')
        .eq('target_field_mapping_id', tfmId)
        .eq('ordinal', 0)
        .maybeSingle<{ source_field_id: string | null }>()

      if (!primarySrc?.source_field_id) {
        // A mapped FK TFM must have a primary source — if not, this is a
        // defense-in-depth skip (findFKDependents already filtered zero-source
        // TFMs out). Revert status so the user notices.
        await supabase
          .from('transformations')
          .update({ status: 'draft' })
          .eq('target_field_mapping_id', tfmId)
        continue
      }

      const { data: srcField } = await supabase
        .from('fields')
        .select('id, name, table_id')
        .eq('id', primarySrc.source_field_id)
        .single()

      if (!srcField) continue

      const { data: tgtFieldByTfm } = await supabase
        .from('target_field_mappings')
        .select('fields:target_field_id(id, name)')
        .eq('id', tfmId)
        .single()

      const tgtField = (tgtFieldByTfm as unknown as { fields: { id: string; name: string } | null })?.fields
      if (!tgtField) continue

      // Wrap `field_name` → `row_data->>'field_name'` for the apply RPC.
      const { data: allSourceFields } = await supabase
        .from('fields')
        .select('name')
        .eq('table_id', srcField.table_id)

      const fieldNames = (allSourceFields ?? []).map((f) => f.name)
      const wrappedSql = wrapFieldRefsInJsonb(strippedSql, fieldNames)

      // ── 3. Apply via dq_apply_field_transform_joined ──────────────────────
      const { error: rpcErr } = await supabase.rpc(
        'dq_apply_field_transform_joined',
        {
          p_target_field_mapping_id: tfmId,
          p_target_field_name: tgtField.name,
          p_transform_sql: wrappedSql,
          p_join_spec: null,
        },
      )

      if (rpcErr) {
        console.error(`[fk-cascade] RPC failed for tfm ${tfmId}:`, rpcErr.message)
        await supabase
          .from('transformations')
          .update({ status: 'draft' })
          .eq('target_field_mapping_id', tfmId)
        continue
      }

      cascadedCount++
      if (transId) {
        cascadedTransforms.push({ fieldMappingId: tfmId, transformationId: transId })
      }
    }

    return { success: true, cascadedCount, cascadedTransforms }
  })
}

// ─── resetFKDependentTransforms ──────────────────────────────────────────────
//
// Called from `transformations.ts` (already guarded) when a PK field's
// mapping or transform is reset. Walks every FK target that references the
// PK and resets its transform too — FK values must remain consistent with
// the PK.
//
// Deliberately does NOT assert the maintenance guard: the caller
// (`resetFieldTransform`) already did, and asserting again at this depth
// would double-throw the sentinel in a spot the outer layer cannot catch.

export async function resetFKDependentTransforms(
  projectId: string,
  targetFieldId: string,
): Promise<{ success: boolean; dependentsReset: number; stagedRowsReverted: number }> {
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, is_primary_key')
    .eq('id', targetFieldId)
    .single()

  if (!targetField?.is_primary_key) {
    return { success: true, dependentsReset: 0, stagedRowsReverted: 0 }
  }

  const { dependents } = await findFKDependents(projectId, targetFieldId)
  if (!dependents || dependents.length === 0) {
    return { success: true, dependentsReset: 0, stagedRowsReverted: 0 }
  }

  let dependentsReset = 0
  let stagedRowsReverted = 0

  for (const dep of dependents) {
    if (!dep.fieldMappingId) continue
    if (!dep.hasExistingTransform) continue

    // skipFKCascade prevents infinite recursion.
    const resetResult = await resetFieldTransform(dep.fieldMappingId, { skipFKCascade: true })
    if (resetResult.hadTransform) dependentsReset++
    stagedRowsReverted += resetResult.rowsReverted
  }

  return { success: true, dependentsReset, stagedRowsReverted }
}

// ─── staleFKDependentTransforms ──────────────────────────────────────────────
//
// Called from `transformations.ts` (already guarded) when a PK transform is
// regenerated or its mapping changes. Marks FK dependent transforms as
// 'stale' rather than deleting them — preserves the SQL for reference while
// signalling that the transform may no longer produce values consistent
// with the PK. Applied staged data for those TFMs is reverted.

export async function staleFKDependentTransforms(
  projectId: string,
  targetFieldId: string,
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

    const staleStatus: TransformationStatus = 'stale'

    await supabaseAdmin
      .from('transformations')
      .update({ status: staleStatus })
      .eq('target_field_mapping_id', dep.fieldMappingId)

    // Revert applied staged values — the old transform output may no longer
    // match the PK's new shape. Mirrors the legacy behaviour keyed on the
    // TFM's primary source table.
    if (dep.existingTransformStatus === 'applied') {
      const { data: primarySrc } = await supabaseAdmin
        .from('mapping_sources')
        .select('source_field_id')
        .eq('target_field_mapping_id', dep.fieldMappingId)
        .eq('ordinal', 0)
        .maybeSingle<{ source_field_id: string | null }>()

      if (primarySrc?.source_field_id) {
        const { data: srcField } = await supabaseAdmin
          .from('fields')
          .select('table_id')
          .eq('id', primarySrc.source_field_id)
          .single<{ table_id: string }>()

        if (srcField) {
          // Resolve the target table via the TFM → target_field_id → fields.table_id.
          const { data: tfmTgt } = await supabaseAdmin
            .from('target_field_mappings')
            .select('target_field_id, fields:target_field_id(id, name, table_id)')
            .eq('id', dep.fieldMappingId)
            .single()

          const tgt = (tfmTgt as unknown as {
            fields: { id: string; name: string; table_id: string } | null
          } | null)?.fields

          if (tgt) {
            const { data: tm } = await supabaseAdmin
              .from('table_mappings')
              .select('id')
              .eq('project_id', projectId)
              .eq('source_table_id', srcField.table_id)
              .eq('target_table_id', tgt.table_id)
              .neq('status', 'rejected')
              .maybeSingle<{ id: string }>()

            if (tm) {
              const { data: count } = await supabaseAdmin.rpc('revert_field_transform', {
                p_table_mapping_id: tm.id,
                p_target_field_name: tgt.name,
              })
              stagedRowsReverted += (count as number) ?? 0
            }
          }
        }
      }
    }

    dependentsStaled++
  }

  return { success: true, dependentsStaled, stagedRowsReverted }
}

// ─── checkPKSourceChangeImpact ───────────────────────────────────────────────
//
// Lightweight pre-edit check used by the Mapping page before saving a source
// field change. Returns the FK dependent count so the UI can warn the user
// that changing a PK's source will stale all dependent FK transforms.
//
// Read-only, no guard. Accepts either a bare TFM id or a shimmed composite
// id (only the TFM portion is used — see the ID SEMANTICS block above).

export async function checkPKSourceChangeImpact(
  fieldMappingId: string,
): Promise<{ isPK: boolean; fkDependentCount: number; dependentNames: string[] }> {
  const tfmId = extractBareTfmId(fieldMappingId)

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('project_id, target_field_id')
    .eq('id', tfmId)
    .maybeSingle<{ project_id: string; target_field_id: string }>()

  if (!tfm) return { isPK: false, fkDependentCount: 0, dependentNames: [] }

  const { data: tgtField } = await supabaseAdmin
    .from('fields')
    .select('is_primary_key')
    .eq('id', tfm.target_field_id)
    .single()

  if (!tgtField?.is_primary_key) {
    return { isPK: false, fkDependentCount: 0, dependentNames: [] }
  }

  const { dependents } = await findFKDependents(tfm.project_id, tfm.target_field_id)
  const mapped = dependents.filter((d) => d.fieldMappingId !== null)

  return {
    isPK: true,
    fkDependentCount: mapped.length,
    dependentNames: mapped.map((d) => `${d.tableName}.${d.fieldName}`),
  }
}
