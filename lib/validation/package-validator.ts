/**
 * Cross-mapping + package consistency validator (S1 — Task #18).
 *
 * Runs on the FULL approved mapping set for a project, at the boundary
 * between the Mapping and Transform stages. Catches invariants that are
 * invisible when validating proposals one at a time.
 *
 * Checks:
 *   1. unmapped_required       — NOT NULL target field with no default and
 *                                no approved/needs_review mapping and not
 *                                acknowledged by the user
 *   2. many_source_no_merge    — TFM has combination_type='single' but more
 *                                than one mapping_source row (collision without
 *                                a declared merge strategy)
 *   3. transform_ref_invalid   — transform SQL references row_data->>'X' where
 *                                X doesn't exist in the TFM's declared source
 *                                fields
 *   4. pk_transform_no_fk_cascade — a PK target field has a transform, but FK
 *                                target fields that reference that PK have no
 *                                transform (cascade drift)
 *
 * All checks are deterministic — no LLM calls, no side effects. Results
 * are returned as a typed structure suitable for display in the Validate tab
 * and for consumption by the self-correction loop (S1 Task #5).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PackageCheckId =
  | 'unmapped_required'
  | 'many_source_no_merge'
  | 'transform_ref_invalid'
  | 'pk_transform_no_fk_cascade'

export interface PackageIssue {
  check: PackageCheckId
  severity: 'error' | 'warning'
  message: string
  /** Target field ID involved, if applicable. */
  targetFieldId?: string
  /** Target field name for human display. */
  targetFieldName?: string
  /** Suggested remediation for the self-correction loop. */
  suggestion?: string
}

export interface PackageValidationResult {
  issues: PackageIssue[]
  counts: { errors: number; warnings: number }
}

// ─── SQL field reference extractor ───────────────────────────────────────────

/** Extract bare field names from row_data->>'FieldName' expressions. */
function extractRowDataRefs(sql: string): string[] {
  const matches = sql.matchAll(/row_data\s*->>\s*'([^']+)'/g)
  return [...matches].map((m) => m[1])
}

// ─── Check 1: unmapped required targets ──────────────────────────────────────

async function checkUnmappedRequired(
  supabase: SupabaseClient,
  projectId: string,
): Promise<PackageIssue[]> {
  // Fetch all target fields in the project that are NOT NULL and have no default.
  // These must have an approved or needs_review mapping, or be acknowledged.
  const { data: targetFields } = await supabase
    .from('fields')
    .select('id, name, table_id, is_nullable, default_value, is_primary_key')
    .eq('is_nullable', false)
    .is('default_value', null)
    .in(
      'table_id',
      (
        await supabase
          .from('tables')
          .select('id')
          .in(
            'dataset_id',
            (
              await supabase
                .from('datasets')
                .select('id')
                .eq('project_id', projectId)
                .eq('role', 'target')
            ).data?.map((d) => d.id) ?? [],
          )
      ).data?.map((t) => t.id) ?? [],
    )

  if (!targetFields?.length) return []

  // Fetch all TFMs for this project that cover those target fields.
  const targetFieldIds = targetFields.map((f) => f.id)

  const { data: tfms } = await supabase
    .from('target_field_mappings')
    .select('target_field_id, status, is_acknowledged, combination_type')
    .eq('project_id', projectId)
    .in('target_field_id', targetFieldIds)

  const coveredIds = new Set(
    (tfms ?? [])
      .filter((t) =>
        t.is_acknowledged === true ||
        t.status === 'approved' ||
        t.status === 'needs_review',
      )
      .map((t) => t.target_field_id),
  )

  return (targetFields ?? [])
    .filter((f) => !coveredIds.has(f.id) && !f.is_primary_key)
    .map((f) => ({
      check: 'unmapped_required' as PackageCheckId,
      severity: 'error' as const,
      message: `Target field "${f.name}" is NOT NULL with no default and has no mapping`,
      targetFieldId: f.id,
      targetFieldName: f.name,
      suggestion:
        `Either map a source field to "${f.name}", provide a default value in the schema, ` +
        `or acknowledge that this field will not be migrated.`,
    }))
}

// ─── Check 2: multiple sources without merge strategy ────────────────────────

async function checkManySrcNoMerge(
  supabase: SupabaseClient,
  projectId: string,
): Promise<PackageIssue[]> {
  // Find TFMs with combination_type='single' that have more than one mapping_source.
  const { data: tfms } = await supabase
    .from('target_field_mappings')
    .select('id, target_field_id, combination_type, fields!target_field_id(name)')
    .eq('project_id', projectId)
    .eq('combination_type', 'single')
    .neq('status', 'rejected')

  if (!tfms?.length) return []

  const tfmIds = tfms.map((t) => t.id)

  const { data: sources } = await supabase
    .from('mapping_sources')
    .select('target_field_mapping_id')
    .in('target_field_mapping_id', tfmIds)

  // Count sources per TFM
  const counts = new Map<string, number>()
  for (const s of sources ?? []) {
    counts.set(s.target_field_mapping_id, (counts.get(s.target_field_mapping_id) ?? 0) + 1)
  }

  const issues: PackageIssue[] = []
  for (const tfm of tfms) {
    const count = counts.get(tfm.id) ?? 0
    if (count > 1) {
      const fieldName = (tfm.fields as unknown as { name: string } | null)?.name ?? tfm.target_field_id
      issues.push({
        check: 'many_source_no_merge',
        severity: 'error',
        message: `Target field "${fieldName}" has ${count} source fields but no merge strategy`,
        targetFieldId: tfm.target_field_id,
        targetFieldName: fieldName,
        suggestion:
          `Set combination_type to 'concat_space', 'concat_comma', or 'custom_sql' ` +
          `to declare how the ${count} sources combine into "${fieldName}".`,
      })
    }
  }

  return issues
}

// ─── Check 3: transform SQL references non-existent source fields ─────────────

async function checkTransformRefInvalid(
  supabase: SupabaseClient,
  projectId: string,
): Promise<PackageIssue[]> {
  // Fetch all transformations for this project with their TFM's source fields.
  const { data: txRows } = await supabase
    .from('transformations')
    .select(`
      id,
      generated_sql,
      target_field_mapping_id,
      target_field_mappings!inner(
        project_id,
        target_field_id,
        fields!target_field_id(name)
      )
    `)
    .eq('target_field_mappings.project_id', projectId)

  if (!txRows?.length) return []

  // For each transformation, get the source field names from mapping_sources.
  const tfmIds = [...new Set(txRows.map((t) => t.target_field_mapping_id))]

  const { data: sources } = await supabase
    .from('mapping_sources')
    .select('target_field_mapping_id, source_field_id, fields!source_field_id(name)')
    .in('target_field_mapping_id', tfmIds)

  // Build TFM → source field names map
  const tfmSourceNames = new Map<string, Set<string>>()
  for (const s of sources ?? []) {
    const name = (s.fields as unknown as { name: string } | null)?.name
    if (!name) continue
    const set = tfmSourceNames.get(s.target_field_mapping_id) ?? new Set()
    set.add(name)
    tfmSourceNames.set(s.target_field_mapping_id, set)
  }

  const issues: PackageIssue[] = []
  for (const tx of txRows) {
    const refs = extractRowDataRefs(tx.generated_sql ?? '')
    if (!refs.length) continue

    const sourceNames = tfmSourceNames.get(tx.target_field_mapping_id) ?? new Set()
    const invalid = refs.filter((r) => !sourceNames.has(r))
    if (!invalid.length) continue

    const tfmData = tx.target_field_mappings as unknown as {
      target_field_id: string
      fields: { name: string } | null
    }
    const targetName = tfmData.fields?.name ?? tfmData.target_field_id

    issues.push({
      check: 'transform_ref_invalid',
      severity: 'warning',
      message: `Transform for "${targetName}" references unknown source field(s): ${invalid.map((r) => `"${r}"`).join(', ')}`,
      targetFieldId: tfmData.target_field_id,
      targetFieldName: targetName,
      suggestion:
        `Verify that the field reference(s) match the exact source field names declared in the mapping. ` +
        `Use row_data->>'ExactFieldName' (case-sensitive).`,
    })
  }

  return issues
}

// ─── Check 4: PK transform without FK cascade ────────────────────────────────

async function checkPkTransformNoFkCascade(
  supabase: SupabaseClient,
  projectId: string,
): Promise<PackageIssue[]> {
  // Find target PK fields that have a transformation.
  const { data: pkTxRows } = await supabase
    .from('transformations')
    .select(`
      target_field_mapping_id,
      target_field_mappings!inner(
        project_id,
        target_field_id,
        fields!target_field_id(id, name, is_primary_key, table_id)
      )
    `)
    .eq('target_field_mappings.project_id', projectId)

  if (!pkTxRows?.length) return []

  const pkTransforms: { fieldId: string; fieldName: string; tableId: string }[] = []
  for (const row of pkTxRows) {
    const tfmData = row.target_field_mappings as unknown as {
      target_field_id: string
      fields: { id: string; name: string; is_primary_key: boolean; table_id: string } | null
    }
    if (tfmData.fields?.is_primary_key) {
      pkTransforms.push({
        fieldId: tfmData.fields.id,
        fieldName: tfmData.fields.name,
        tableId: tfmData.fields.table_id,
      })
    }
  }

  if (!pkTransforms.length) return []

  // For each transformed PK, find FK target fields that reference it.
  // FK reference format: 'TableName.field_name' — check if the table + field match.
  const { data: allTargetFields } = await supabase
    .from('fields')
    .select('id, name, is_foreign_key, fk_reference, table_id, tables!inner(name)')
    .eq('is_foreign_key', true)
    .in(
      'table_id',
      (
        await supabase
          .from('tables')
          .select('id')
          .in(
            'dataset_id',
            (
              await supabase
                .from('datasets')
                .select('id')
                .eq('project_id', projectId)
                .eq('role', 'target')
            ).data?.map((d) => d.id) ?? [],
          )
      ).data?.map((t) => t.id) ?? [],
    )

  if (!allTargetFields?.length) return []

  // Build set of target field IDs that have transforms.
  const transformedTargetFieldIds = new Set(
    pkTxRows.map((r) => {
      const d = r.target_field_mappings as unknown as { target_field_id: string }
      return d.target_field_id
    }),
  )

  const issues: PackageIssue[] = []

  for (const pk of pkTransforms) {
    // FK reference could be 'TableName.fieldName' — match against the PK field name.
    const fkFields = (allTargetFields as unknown as Array<{
      id: string
      name: string
      fk_reference: string | null
      tables: { name: string } | null
    }>).filter((f) => {
      if (!f.fk_reference) return false
      const [, refField] = f.fk_reference.split('.')
      return refField === pk.fieldName
    })

    for (const fk of fkFields) {
      if (!transformedTargetFieldIds.has(fk.id)) {
        issues.push({
          check: 'pk_transform_no_fk_cascade',
          severity: 'warning',
          message: `PK field "${pk.fieldName}" has a transform but FK field "${fk.name}" (→ ${fk.fk_reference}) does not`,
          targetFieldId: fk.id,
          targetFieldName: fk.name,
          suggestion:
            `If the PK transform changes the value format (e.g. ID reformat), ` +
            `add a matching transform on "${fk.name}" so the FK reference stays consistent.`,
        })
      }
    }
  }

  return issues
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run all cross-mapping consistency checks on the full approved mapping set
 * for a project.
 *
 * Called at the Mapping→Transform boundary. Errors indicate the mapping set
 * is not ready to proceed. Warnings are surfaced in the Validate tab and
 * optionally fed to the self-correction loop.
 *
 * All checks are read-only. No LLM calls. No side effects.
 */
export async function validatePackageConsistency(
  supabase: SupabaseClient,
  projectId: string,
): Promise<PackageValidationResult> {
  const [required, merge, refs, cascade] = await Promise.all([
    checkUnmappedRequired(supabase, projectId),
    checkManySrcNoMerge(supabase, projectId),
    checkTransformRefInvalid(supabase, projectId),
    checkPkTransformNoFkCascade(supabase, projectId),
  ])

  const issues = [...required, ...merge, ...refs, ...cascade]

  return {
    issues,
    counts: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
    },
  }
}
