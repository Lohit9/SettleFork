'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Returns the Set of source field IDs whose quality issues are considered
 * "resolved by transform" for display purposes.
 *
 * A source field is resolved when it is the primary source (mapping_sources
 * row with ordinal=0) of an approved, non-acknowledged target_field_mapping
 * that EITHER:
 *   a) has needs_transformation = false (user dismissed the transform badge), OR
 *   b) has at least one saved transformation record.
 *
 * This is a pure read — it never mutates any data. The result is used to
 * visually downgrade source quality issues to a "Resolved by Transform"
 * state without modifying quality_issues rows.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Prompt 3d decision (2026-04-22): preserve legacy primary-source-only
 * semantics (MS[ordinal=0] only). Extending to contributor sources
 * (ordinal >= 1) would change user-visible UI behavior — contributor
 * source-field quality issues would suddenly gray out across every
 * multi-source mapping. Product decision outside 3d scope.
 *
 * The legacy implementation queried `field_mappings` with `is_contributing
 * = false`; the new-model equivalent is `mapping_sources.ordinal = 0`.
 * TFMs are project-scoped directly (no pre-fetch of table_mappings needed).
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function getResolvedSourceFieldIds(projectId: string): Promise<string[]> {
  const { data: tfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      `
      id,
      needs_transformation,
      mapping_sources!inner ( source_field_id, ordinal ),
      transformations ( id )
    `,
    )
    .eq('project_id', projectId)
    .eq('status', 'approved')
    .eq('is_acknowledged', false)
    .eq('mapping_sources.ordinal', 0)

  const resolvedIds = new Set<string>()

  for (const tfm of tfms ?? []) {
    const primary = (tfm.mapping_sources ?? []).find((m) => m.ordinal === 0)
    if (!primary?.source_field_id) continue

    const hasTransform =
      Array.isArray(tfm.transformations) && tfm.transformations.length > 0
    const noTransformNeeded = tfm.needs_transformation === false

    if (hasTransform || noTransformNeeded) {
      resolvedIds.add(primary.source_field_id)
    }
  }

  return [...resolvedIds]
}
