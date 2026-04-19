/**
 * Resolves the effective fix target for a quality issue.
 *
 * Why this is needed: in-flight quality issues (stage='in_flight') carry
 * table_id/field_id pointing at the TARGET side of a mapping. Target tables
 * are schema-only — data_rows for a target table_id is empty. Fix SQL that
 * uses the target table_id therefore affects zero rows (silent no-op) even
 * when the underlying source data is actually full of fixable problems.
 *
 * Resolution rule:
 *   - source stage → pass through unchanged
 *   - in_flight with a matching table_mapping + field_mapping → route to the
 *     source table/field, so generated fix SQL operates on the real
 *     data_rows payload. Fixes to source values propagate to the staged view
 *     on the next re-stage.
 *   - in_flight with no mapping (e.g. Check 12 "no source mapping" issues) →
 *     pass through unchanged; the apply layer will report that the fix
 *     cannot be executed as a row-level data fix.
 */
import { supabaseAdmin } from '@/lib/supabase/admin'

export interface FixTarget {
  /** The table_id to use in fix SQL WHERE clauses (data_rows anchor). */
  tableId: string
  /** The field_id whose profile should be recomputed after the fix applies. */
  fieldId: string | null
  /** The field NAME to reference in row_data->>'<name>' JSONB expressions. */
  fieldName: string | null
  /** Human-readable table name for prompts / UI. */
  tableName: string | null
  /** True if the fix target was routed from target to source (in-flight case). */
  routedToSource: boolean
  /**
   * Explains why we could not route (for in-flight issues only). Populated
   * when routedToSource is false and stage === 'in_flight' — e.g. "no
   * table_mapping" or "no field_mapping". Null in all other cases.
   */
  routingBlockedReason: string | null
}

export interface ResolvableIssue {
  id?: string
  project_id: string
  stage: 'source' | 'in_flight' | 'target'
  table_id: string | null
  field_id: string | null
}

/**
 * Returns the effective fix target for the given issue. For in-flight issues
 * with an existing mapping, returns the SOURCE table_id/field. For source
 * issues, returns the issue's own table_id/field. Never throws — unresolvable
 * cases return a FixTarget with routedToSource=false and an explanation.
 */
export async function resolveFixTarget(issue: ResolvableIssue): Promise<FixTarget> {
  const originalTableId = issue.table_id ?? ''

  // Default: pass through. Fill in table/field names below for consistency.
  const fallback = async (reason: string | null): Promise<FixTarget> => {
    let fieldName: string | null = null
    let tableName: string | null = null
    if (issue.field_id) {
      const { data: f } = await supabaseAdmin
        .from('fields')
        .select('name')
        .eq('id', issue.field_id)
        .single()
      fieldName = f?.name ?? null
    }
    if (originalTableId) {
      const { data: t } = await supabaseAdmin
        .from('tables')
        .select('name')
        .eq('id', originalTableId)
        .single()
      tableName = t?.name ?? null
    }
    return {
      tableId: originalTableId,
      fieldId: issue.field_id,
      fieldName,
      tableName,
      routedToSource: false,
      routingBlockedReason: reason,
    }
  }

  if (issue.stage !== 'in_flight' || !originalTableId) {
    return fallback(null)
  }

  // Look up the table_mapping for this target table within the project
  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', issue.project_id)
    .eq('target_table_id', originalTableId)
    .maybeSingle()

  if (!tm || !tm.source_table_id) {
    return fallback('no table_mapping for target')
  }

  // Resolve source field from field_mapping (by target_field_id)
  let sourceFieldId: string | null = null
  let sourceFieldName: string | null = null
  if (issue.field_id) {
    const { data: fm } = await supabaseAdmin
      .from('field_mappings')
      .select('source_field_id')
      .eq('target_field_id', issue.field_id)
      .eq('table_mapping_id', tm.id)
      .maybeSingle()

    if (!fm?.source_field_id) {
      // No source field mapped (Check 12 territory) — cannot route
      return fallback('no field_mapping for target field')
    }

    sourceFieldId = fm.source_field_id
    const { data: srcField } = await supabaseAdmin
      .from('fields')
      .select('name')
      .eq('id', sourceFieldId)
      .single()
    sourceFieldName = srcField?.name ?? null

    if (!sourceFieldName) {
      return fallback('source field name not found')
    }
  }

  // Source table name for prompt context
  let sourceTableName: string | null = null
  const { data: srcTable } = await supabaseAdmin
    .from('tables')
    .select('name')
    .eq('id', tm.source_table_id)
    .single()
  sourceTableName = srcTable?.name ?? null

  return {
    tableId: tm.source_table_id,
    fieldId: sourceFieldId,
    fieldName: sourceFieldName,
    tableName: sourceTableName,
    routedToSource: true,
    routingBlockedReason: null,
  }
}
