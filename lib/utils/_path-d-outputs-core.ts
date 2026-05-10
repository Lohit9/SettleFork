// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — pure reducer for Path D outputs sidecar maps.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure helpers extracted from `lib/actions/path-d-outputs.ts` so the reduce
// logic (especially the "one decision can index under multiple TFM ids OR
// multiple coverage ids depending on applies_to") can be unit-tested
// without spinning up the supabase client.
//
// The leading underscore in the filename mirrors the existing
// `_mappings-for-redesign-core.ts` convention — "internal helper, not
// part of the public action surface."

import type {
  ProjectDataQualityIssueRow,
  ProjectDecisionRow,
  TargetFieldCoverageRow,
} from '@/lib/types/path-d'

export interface PathDOutputs {
  /** target_field_coverage rows keyed by target_field_id (one row per pair). */
  coverageByTargetFieldId: Map<string, TargetFieldCoverageRow>
  /**
   * project_decisions whose `applies_to.tfm_ids` array references a given
   * TFM. A single decision may appear under multiple keys when its
   * `applies_to` lists multiple TFMs.
   */
  decisionsByTfmId: Map<string, ProjectDecisionRow[]>
  /**
   * project_decisions whose `applies_to.coverage_ids` array references a
   * given coverage row. Mirrors `decisionsByTfmId` shape; a decision may
   * appear in both indexes when it spans both axes.
   */
  decisionsByCoverageId: Map<string, ProjectDecisionRow[]>
  /**
   * project_data_quality_issues keyed by source_field_id. Issues with
   * `source_field_id === null` (project-level / cross-field findings) are
   * NOT indexed here — the drawer renders source-field-scoped DQ only in
   * Phase E PR α; project-level surfacing is deferred to a future PR.
   */
  dqIssuesBySourceFieldId: Map<string, ProjectDataQualityIssueRow[]>
}

export function emptyPathDOutputs(): PathDOutputs {
  return {
    coverageByTargetFieldId: new Map(),
    decisionsByTfmId: new Map(),
    decisionsByCoverageId: new Map(),
    dqIssuesBySourceFieldId: new Map(),
  }
}

/**
 * Append a value to a Map<string, T[]>, allocating the array on first hit.
 */
function pushToIndex<T>(
  index: Map<string, T[]>,
  key: string,
  value: T,
): void {
  const existing = index.get(key)
  if (existing) {
    existing.push(value)
  } else {
    index.set(key, [value])
  }
}

/**
 * Reduce raw row arrays into the indexed sidecar shape.
 *
 *   • Coverage rows index by target_field_id (UNIQUE per migration 093:67,
 *     so the Map is a 1:1 lookup).
 *   • Decisions fan out into two indexes by `applies_to.tfm_ids` and
 *     `applies_to.coverage_ids`. A single decision can appear in both
 *     indexes (when both arrays are populated) and under multiple keys
 *     within each index (when an array carries multiple ids).
 *   • DQ issues index by source_field_id; rows with NULL source_field_id
 *     (project-level findings) are skipped entirely — surfacing project-
 *     level DQ is deferred to a follow-up PR.
 */
export function buildPathDOutputs(
  coverageRows: readonly TargetFieldCoverageRow[],
  decisionRows: readonly ProjectDecisionRow[],
  dqRows: readonly ProjectDataQualityIssueRow[],
): PathDOutputs {
  const out = emptyPathDOutputs()

  for (const row of coverageRows) {
    out.coverageByTargetFieldId.set(row.target_field_id, row)
  }

  for (const row of decisionRows) {
    const tfmIds = row.applies_to?.tfm_ids ?? []
    for (const tfmId of tfmIds) {
      pushToIndex(out.decisionsByTfmId, tfmId, row)
    }
    const coverageIds = row.applies_to?.coverage_ids ?? []
    for (const coverageId of coverageIds) {
      pushToIndex(out.decisionsByCoverageId, coverageId, row)
    }
  }

  for (const row of dqRows) {
    if (row.source_field_id === null) continue
    pushToIndex(out.dqIssuesBySourceFieldId, row.source_field_id, row)
  }

  return out
}
