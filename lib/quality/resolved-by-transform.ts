'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Returns the Set of source field IDs whose quality issues are considered
 * "resolved by transform" for display purposes.
 *
 * A source field is resolved when it has an approved, non-contributing
 * field_mapping that EITHER:
 *   a) has needs_transformation = false (user dismissed the transform badge), OR
 *   b) has at least one saved/tested/applied transformation record
 *
 * This is a pure read — it never mutates any data.
 * The result is used to visually downgrade source quality issues to a
 * "Resolved by Transform" state without modifying quality_issues rows.
 */
export async function getResolvedSourceFieldIds(projectId: string): Promise<string[]> {
  // Get all non-rejected table mappings for the project
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) return []
  const tmIds = tms.map((tm) => tm.id)

  // Fetch approved, primary (non-contributing) field mappings with their
  // source_field_id and whether a saved transformation exists
  const { data: fms } = await supabaseAdmin
    .from('field_mappings')
    .select('source_field_id, needs_transformation, transformations(id)')
    .in('table_mapping_id', tmIds)
    .eq('status', 'approved')
    .eq('is_contributing', false)
    .not('source_field_id', 'is', null)

  const resolvedIds = new Set<string>()

  for (const fm of fms ?? []) {
    if (!fm.source_field_id) continue

    const hasTransform =
      Array.isArray(fm.transformations) && fm.transformations.length > 0
    const noTransformNeeded = fm.needs_transformation === false

    if (hasTransform || noTransformNeeded) {
      resolvedIds.add(fm.source_field_id)
    }
  }

  return [...resolvedIds]
}
