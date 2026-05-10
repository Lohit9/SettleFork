'use server'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — Path D outputs read-side helper for the mapping drawer.
// ─────────────────────────────────────────────────────────────────────────────
//
// Page-level batch fetch returning sidecar maps the drawer can consult on
// open. Three parallel SELECTs (target_field_coverage, project_decisions,
// project_data_quality_issues) plus a client-side reduce to split the
// decisions list into two indexes (by tfm_id and by coverage_id).
//
// Read-only. SECURITY INVOKER (uses the user-cookie supabase client) so RLS
// enforces tenant isolation — no service-role elevation, no audit log entry
// (existing convention for read-side helpers).
//
// Defensive empty-map returns on auth failure / fetch error so the drawer
// can render gracefully when Path D outputs are unavailable. The drawer
// treats a populated sidecar as enrichment, never a hard dependency.
//
// The reduce step (`buildPathDOutputs` in `_path-d-outputs-core.ts`) is
// pure and unit-testable in isolation.

import { createClient } from '@/lib/supabase/server'
import type { PathDOutputs } from '@/lib/utils/_path-d-outputs-core'
import {
  buildPathDOutputs,
  emptyPathDOutputs,
} from '@/lib/utils/_path-d-outputs-core'
import type {
  ProjectDataQualityIssueRow,
  ProjectDecisionRow,
  TargetFieldCoverageRow,
} from '@/lib/types/path-d'

export type { PathDOutputs } from '@/lib/utils/_path-d-outputs-core'

/**
 * Fetch Path D outputs for one project, indexed for drawer consumption.
 *
 * Returns empty maps on:
 *   • unauthenticated session (no user) — the page renders a stub anyway,
 *     so the drawer should never surface a Path D query failure as user-
 *     visible noise.
 *   • RLS denial / network error on any of the three SELECTs — partial
 *     enrichment is acceptable; the drawer's empty-state collapse rules
 *     mean missing sidecar data simply hides the new sections.
 *
 * Three parallel SELECTs (Promise.all) — typical project at this stage
 * carries < 100 coverage rows + < 50 decisions + < 200 DQ issues, so the
 * round-trip cost is well below the existing page-level mappings fetch.
 */
export async function getPathDOutputsForProject(
  projectId: string,
): Promise<PathDOutputs> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return emptyPathDOutputs()

  const [coverageResult, decisionsResult, dqResult] = await Promise.all([
    supabase
      .from('target_field_coverage')
      .select(
        'id, project_id, target_field_id, coverage_status, ai_reasoning, ' +
          'default_value_recommendation, default_value_decided, ' +
          'default_decided_at, default_decided_by, created_at, updated_at, ' +
          'experiment_run_id',
      )
      .eq('project_id', projectId),
    supabase
      .from('project_decisions')
      .select(
        'id, project_id, decision_type, title, description, ai_recommendation, ' +
          'alternatives, customer_decision, applies_to, status, decided_at, ' +
          'decided_by, created_at, updated_at, experiment_run_id',
      )
      .eq('project_id', projectId),
    supabase
      .from('project_data_quality_issues')
      .select(
        'id, project_id, source_field_id, severity, category, description, ' +
          'example_values, recommendation, acknowledged_at, acknowledged_by, ' +
          'created_at, experiment_run_id',
      )
      .eq('project_id', projectId),
  ])

  // Supabase generic-client typings return a discriminated union that
  // TypeScript can't narrow through `.eq()` without going via `unknown`.
  // The shape lock for these queries lives in `_path-d-outputs-core.ts`
  // and `lib/types/path-d.ts` (migration 093 schema).
  const coverageRows: TargetFieldCoverageRow[] =
    !coverageResult.error && coverageResult.data
      ? (coverageResult.data as unknown as TargetFieldCoverageRow[])
      : []
  const decisionRows: ProjectDecisionRow[] =
    !decisionsResult.error && decisionsResult.data
      ? (decisionsResult.data as unknown as ProjectDecisionRow[])
      : []
  const dqRows: ProjectDataQualityIssueRow[] =
    !dqResult.error && dqResult.data
      ? (dqResult.data as unknown as ProjectDataQualityIssueRow[])
      : []

  return buildPathDOutputs(coverageRows, decisionRows, dqRows)
}
