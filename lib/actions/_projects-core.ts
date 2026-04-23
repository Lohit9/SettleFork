/**
 * Business logic for the project-list aggregation rollup.
 * NOT a 'use server' module.
 *
 * The server action in `lib/actions/projects.ts` (`getProjectsWithStats`)
 * is a thin wrapper that:
 *   1. Builds a cookies-bound Supabase client via `createClient()`
 *      (RLS active; user sees only their own projects/orgs)
 *   2. Delegates to `getProjectsWithStatsInternal` here, passing the
 *      client through
 *
 * Why the split (Prompt 3d, Step 3D-14 Path A refactor)
 * -----------------------------------------------------
 * `getProjectsWithStats` is read-only and purely aggregational. It
 * does not need `'use server'`; the only reason the original lived
 * there was colocation with the rest of the projects server actions.
 *
 * The Path A split is required for `tests/integration/projects-heritage.test.ts`
 * to call the aggregation against Heritage Core without going through
 * the `cookies()` / request-scope plumbing that a `'use server'`
 * function transitively requires. The integration test calls
 * `getProjectsWithStatsInternal(supabaseAdmin, orgId)` directly,
 * bypassing both auth and RLS (which is fine for a read-only
 * aggregation on a canary project the test explicitly filters by
 * id).
 *
 * Mirrors the pattern established in `lib/quality/_detection-engine-core.ts`
 * (Prompt 3d Step 3D-4, Path A refactor).
 *
 * Client scoping model
 * --------------------
 * The function takes the client as a parameter rather than
 * constructing its own (unlike detection-engine-core which
 * unconditionally uses supabaseAdmin). That's because projects-list
 * MUST honour RLS in production — the cookies-bound client
 * transparently filters `projects` (and transitively all per-project
 * queries) to the authenticated user's visibility set. If we
 * hard-coded `supabaseAdmin` here, every logged-in user would see
 * every project across every organization. That is a production
 * hazard that the Path A refactor cannot introduce.
 *
 * The integration test opts into admin-mode by passing `supabaseAdmin`
 * explicitly. That is safe BECAUSE the test is read-only AND narrows
 * to a known canary project by id after the fetch — any extra rows
 * admin returns vs. RLS get filtered out at `.find()`.
 *
 * NEW-MODEL NOTE (Prompt 3d, Step 3D-11 rewrite)
 * ----------------------------------------------
 * Three legacy sites were rewritten against the new mapping model:
 *
 *   1. `field_acknowledgments` → `source_field_acknowledgments`
 *      UNION bare-ack TFMs (`is_acknowledged=true AND
 *      combination_type IS NULL`). Mirrors the Q5 union pattern
 *      formalized in `lib/quality/readiness-score.ts` — source-side
 *      acks come from their own table, target-side acks live
 *      directly on TFMs as "acknowledged unmapped target field"
 *      markers.
 *
 *   2. `field_mappings` → `target_field_mappings` with nested
 *      `mapping_sources`. TFMs are project-scoped, so the per-TM
 *      filter (`.in('table_mapping_id', …)`) is replaced with
 *      `.in('project_id', projectIds)`. The legacy
 *      `is_contributing=false` vs `is_contributing=true` split
 *      collapses: every TFM is a primary, and contributors are
 *      pulled from the nested `mapping_sources` array. Per-project
 *      source-field union iterates EVERY MS row (primary +
 *      contributor), matching legacy's `if (fm.source_field_id)`
 *      which accepted both is_contributing values.
 *
 *   3. `transformations.field_mapping_id` →
 *      `transformations.target_field_mapping_id` (column rename).
 *      Per-project routing for transformations goes through
 *      `tfmToProject` (TFM → project_id) directly — no longer a
 *      two-hop FM → TM → project chain, because TFMs carry
 *      `project_id` natively.
 *
 * Bare-ack bucket handling aligns with readiness-score.ts Q5:
 *   - bare-ack TFMs do NOT count as mappings (excluded from
 *     mappedFieldCount and primaryMappingCount)
 *   - bare-ack TFMs DO contribute their target_field_id to the
 *     per-project acknowledgedFieldIds set
 *   - bare-ack TFMs do NOT affect allPrimaryApproved (legacy
 *     parity: field_acknowledgments had no status and never
 *     influenced the flag)
 *
 * Rejected-TM scope collapse: legacy filtered FMs via approved TMs
 * only (`.in('table_mapping_id', non-rejected TM ids)`). Under the
 * new model, TFMs are not TM-scoped at all, so we scope directly
 * on `project_id` and let TFM.status drive exclusion. Integration
 * note (for 3D-14 Heritage parity): if a count diverges from
 * legacy, the owning-TM rule is the first place to re-scope.
 *
 * Guard-wiring decision (Prompt 3d, Step 3D-11, Gate 2 §1.11):
 * This function is READ-ONLY — SELECTs against datasets/tables/
 * fields/target_field_mappings/mapping_sources/transformations/
 * quality_issues/outputs/source_field_acknowledgments and performs
 * no mutations. Per the Gate 2 guard-wiring policy, only functions
 * that mutate mapping-shape tables need `assertMappingWritesEnabled`
 * guards; this function is out of scope. Safe to run while mapping
 * writes are disabled (maintenance_mode=true).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Dataset, ProjectWithStats } from '@/lib/types/database'

/**
 * TFM row shape used by the `getProjectsWithStatsInternal` aggregation.
 * Columns mirror the legacy FM projection (`status`, `source_field_id`,
 * `target_field_id`, `needs_transformation`) plus new-model fields
 * needed to identify bare-acks (`is_acknowledged`, `combination_type`)
 * and source-field contributors via the nested `mapping_sources` array.
 */
export type TfmRollupRow = {
  id: string
  project_id: string
  target_field_id: string
  status: string
  is_acknowledged: boolean
  combination_type: string | null
  needs_transformation: boolean | null
  mapping_sources: Array<{ source_field_id: string | null; ordinal: number }>
}

export async function getProjectsWithStatsInternal(
  supabase: SupabaseClient,
  orgId?: string,
): Promise<ProjectWithStats[]> {
  let query = supabase
    .from('projects')
    .select('*, datasets(id, role, name)')
    .order('created_at', { ascending: false })

  if (orgId) {
    query = query.eq('org_id', orgId)
  }

  const { data: projects, error } = await query

  if (error || !projects || projects.length === 0) return []

  const projectIds = projects.map((p) => p.id)
  const allDatasets = projects.flatMap((p) => (p.datasets || []) as Dataset[])
  const sourceDatasetIds = allDatasets.filter((d) => d.role === 'source').map((d) => d.id)
  const targetDatasetIds = allDatasets.filter((d) => d.role === 'target').map((d) => d.id)

  const DUMMY_ID = '00000000-0000-0000-0000-000000000000'
  const [
    { data: sourceTables },
    { data: targetTables },
    { data: tableMappings },
    { data: qualityIssues },
    { data: outputs },
    { data: sourceFieldAcks },
  ] = await Promise.all([
    supabase
      .from('tables')
      .select('id, dataset_id, row_count')
      .in('dataset_id', sourceDatasetIds.length > 0 ? sourceDatasetIds : [DUMMY_ID]),
    supabase
      .from('tables')
      .select('id, dataset_id')
      .in('dataset_id', targetDatasetIds.length > 0 ? targetDatasetIds : [DUMMY_ID]),
    supabase
      .from('table_mappings')
      .select('id, project_id, target_table_id')
      .in('project_id', projectIds)
      .neq('status', 'rejected'),
    supabase
      .from('quality_issues')
      .select('project_id, severity, status, field_id, stage, issue_kind, description')
      .in('project_id', projectIds),
    supabase.from('outputs').select('project_id').in('project_id', projectIds),
    // Q5 union part 1: source-side acks live in their own table.
    supabase
      .from('source_field_acknowledgments')
      .select('project_id, source_field_id')
      .in('project_id', projectIds),
  ])

  const sourceTableIds = (sourceTables || []).map((t) => t.id)
  const allTargetTableIds = [...new Set((tableMappings || []).map((tm) => tm.target_table_id))]

  // Round 3: source fields, target_field_mappings (+ nested mapping_sources),
  // ALL target fields (for counting).
  const [{ data: fields }, { data: tfmRows }, { data: allTargetFields }] = await Promise.all([
    sourceTableIds.length > 0
      ? supabase.from('fields').select('id, table_id').in('table_id', sourceTableIds)
      : Promise.resolve({ data: [] as { id: string; table_id: string }[], error: null }),
    projectIds.length > 0
      ? supabase
          .from('target_field_mappings')
          .select(
            'id, project_id, target_field_id, status, is_acknowledged, combination_type, needs_transformation, mapping_sources(source_field_id, ordinal)'
          )
          .in('project_id', projectIds)
      : Promise.resolve({
          data: [] as TfmRollupRow[],
          error: null,
        }),
    allTargetTableIds.length > 0
      ? supabase.from('fields').select('id, table_id').in('table_id', allTargetTableIds)
      : Promise.resolve({ data: [] as { id: string; table_id: string }[], error: null }),
  ])

  const tfms = (tfmRows ?? []) as unknown as TfmRollupRow[]
  const tfmIds = tfms.map((t) => t.id)

  // Round 4: transformations (column rename: field_mapping_id → target_field_mapping_id).
  const { data: transformations } =
    tfmIds.length > 0
      ? await supabase
          .from('transformations')
          .select('target_field_mapping_id, status')
          .in('target_field_mapping_id', tfmIds)
      : { data: [] as { target_field_mapping_id: string; status: string }[] }

  // Build lookup maps
  const datasetToProject = new Map<string, string>()
  projects.forEach((p) => {
    ;(p.datasets || []).forEach((d: Dataset) => datasetToProject.set(d.id, p.id))
  })

  const tableToProject = new Map<string, string>()
  ;(sourceTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (pid) tableToProject.set(t.id, pid)
  })

  const tmToProject = new Map<string, string>()
  ;(tableMappings || []).forEach((tm) => tmToProject.set(tm.id, tm.project_id))

  // TFM → project_id (direct, no TM hop required — TFMs are project-scoped).
  // Replaces the legacy two-hop fmToTM → tmToProject chain used to route
  // transformations to projects.
  const tfmToProject = new Map<string, string>()
  tfms.forEach((t) => tfmToProject.set(t.id, t.project_id))

  // Per-project aggregation buckets
  type Bucket = {
    totalSourceFields: number
    totalRows: number
    mappedFieldCount: number
    blockingIssueCount: number
    warningCount: number
    totalTransforms: number
    savedTransforms: number
    totalQualityIssues: number
    resolvedQualityIssues: number
    outputCount: number
    hasSourceTables: boolean
    hasTargetTables: boolean
    // Mapping phase: track primary mappings, approvals, and acknowledgments
    primaryMappingCount: number
    allPrimaryApproved: boolean
    mappedTargetFieldIds: Set<string>
    mappedSourceFieldIds: Set<string>
    acknowledgedFieldIds: Set<string>
    totalSourceFieldCount: number
    totalTargetFieldCount: number
    // Transform phase: track needs_transformation coverage
    needsTransformIds: Set<string>
    coveredTransformIds: Set<string>
    // Dedup guard for target field counting
    countedTargetFieldIds: Set<string>
  }
  const buckets = new Map<string, Bucket>()
  projectIds.forEach((id) =>
    buckets.set(id, {
      totalSourceFields: 0,
      totalRows: 0,
      mappedFieldCount: 0,
      blockingIssueCount: 0,
      warningCount: 0,
      totalTransforms: 0,
      savedTransforms: 0,
      totalQualityIssues: 0,
      resolvedQualityIssues: 0,
      outputCount: 0,
      hasSourceTables: false,
      hasTargetTables: false,
      primaryMappingCount: 0,
      allPrimaryApproved: true,
      mappedTargetFieldIds: new Set(),
      mappedSourceFieldIds: new Set(),
      acknowledgedFieldIds: new Set(),
      totalSourceFieldCount: 0,
      totalTargetFieldCount: 0,
      needsTransformIds: new Set(),
      coveredTransformIds: new Set(),
      countedTargetFieldIds: new Set(),
    })
  )

  ;(fields || []).forEach((f) => {
    const pid = tableToProject.get(f.table_id)
    if (pid) {
      buckets.get(pid)!.totalSourceFields++
      buckets.get(pid)!.totalSourceFieldCount++
    }
  })
  ;(sourceTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (!pid) return
    const b = buckets.get(pid)!
    b.totalRows += t.row_count || 0
    b.hasSourceTables = true
  })
  // Count target fields per project (via target tables → datasets → project)
  const targetTableToProject = new Map<string, string>()
  ;(targetTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (pid) {
      buckets.get(pid)!.hasTargetTables = true
      targetTableToProject.set(t.id, pid)
    }
  })
  // Count target fields per project (via table mapping target tables).
  // Use countedTargetFieldIds to avoid double-counting when multiple source
  // tables map to the same target table.
  ;(allTargetFields || []).forEach((f) => {
    const tms = (tableMappings || []).filter((tm) => tm.target_table_id === f.table_id)
    for (const tm of tms) {
      const b = buckets.get(tm.project_id)
      if (b && !b.countedTargetFieldIds.has(f.id)) {
        b.totalTargetFieldCount++
        b.countedTargetFieldIds.add(f.id)
      }
    }
  })
  // ── Q5 acknowledgedFieldIds union (source_field_acks ∪ bare-ack TFMs) ─
  // Part 1: source-side acks (from dedicated source_field_acknowledgments
  // table). Part 2 (bare-ack TFMs) is folded in during the TFM loop
  // below so we walk `tfms` only once.
  ;(sourceFieldAcks || []).forEach((a) => {
    const b = buckets.get(a.project_id)
    if (b) b.acknowledgedFieldIds.add(a.source_field_id)
  })

  // ── TFM rollup (replaces legacy fieldMappings.forEach) ──────────────
  // Every TFM maps to a project via `tfm.project_id` (no TM hop). Bare
  // acks (is_acknowledged=true AND combination_type IS NULL) bypass
  // mapping counts and contribute to acknowledgedFieldIds instead —
  // same rule as readiness-score.ts (Q5).
  tfms.forEach((tfm) => {
    const b = buckets.get(tfm.project_id)
    if (!b) return

    const isBareAck = tfm.is_acknowledged && tfm.combination_type === null
    if (isBareAck) {
      // Q5 part 2: target-side ack — replaces legacy
      // field_acknowledgments rows whose field_id was a target field.
      b.acknowledgedFieldIds.add(tfm.target_field_id)
      return
    }

    // Non-bare-ack TFM = a mapping (either multi-source, single-source,
    // or value-assignment). Every such TFM is a primary in the new
    // model — the legacy is_contributing=false distinction collapses
    // because contributors are MS rows, not TFMs.
    b.primaryMappingCount++
    if (tfm.status !== 'approved') b.allPrimaryApproved = false
    if (tfm.status !== 'rejected') {
      b.mappedFieldCount++
      b.mappedTargetFieldIds.add(tfm.target_field_id)
    }
    if (tfm.status === 'approved' && tfm.needs_transformation) {
      b.needsTransformIds.add(tfm.id)
    }

    // Union source_field_ids from ALL MS rows (primary AND contributor)
    // for non-rejected TFMs — preserves legacy semantics where every
    // FM with a source_field_id contributed, regardless of
    // is_contributing value.
    if (tfm.status !== 'rejected') {
      for (const ms of tfm.mapping_sources ?? []) {
        if (ms.source_field_id) b.mappedSourceFieldIds.add(ms.source_field_id)
      }
    }
  })
  ;(qualityIssues || []).forEach((qi) => {
    const b = buckets.get(qi.project_id)
    if (!b) return
    b.totalQualityIssues++
    if (qi.status === 'fixed' || qi.status === 'accepted_risk') b.resolvedQualityIssues++
    if (qi.status === 'open' && qi.stage === 'in_flight') {
      if (qi.severity === 'blocking') b.blockingIssueCount++
      else if (qi.severity === 'warning') b.warningCount++
    }
  })
  ;(transformations || []).forEach((t) => {
    // Direct TFM → project lookup (no FM → TM → project hop).
    const pid = tfmToProject.get(t.target_field_mapping_id)
    if (!pid) return
    const b = buckets.get(pid)!
    b.totalTransforms++
    if (t.status === 'saved' || t.status === 'applied') b.savedTransforms++
    if (b.needsTransformIds.has(t.target_field_mapping_id)) {
      b.coveredTransformIds.add(t.target_field_mapping_id)
    }
  })
  ;(outputs || []).forEach((o) => {
    const b = buckets.get(o.project_id)
    if (b) b.outputCount++
  })

  return projects.map((project) => {
    const b = buckets.get(project.id)!
    const datasets = (project.datasets || []) as Dataset[]
    const src = datasets.find((d) => d.role === 'source')
    const tgt = datasets.find((d) => d.role === 'target')

    // NOTE: This is a "quality-resolution %" (fixed/accepted vs total issues),
    // NOT the weighted 5-factor Migration Readiness score computed by
    // `calculateReadinessScore` in lib/quality/readiness-formula.ts. It is
    // kept here only because (a) the project list intentionally avoids the
    // expensive per-project query fan-out that the real readiness score
    // requires, and (b) nothing in the UI currently renders this field. If
    // this ever becomes user-visible, rename it to `qualityResolutionPercent`
    // or replace it with `computeReadinessScore(project.id)` behind a cache.
    const readinessScore =
      b.totalQualityIssues === 0
        ? null
        : Math.round((b.resolvedQualityIssues / b.totalQualityIssues) * 100)

    // Phase 1 — Ingestion: both source and target tables exist
    const ingestionDone = b.hasSourceTables && b.hasTargetTables

    // Phase 2 — Mapping: all fields addressed (mapped or acknowledged)
    const hasMappings = b.primaryMappingCount > 0
    const totalFields = b.totalSourceFieldCount + b.totalTargetFieldCount
    const allMappedOrAckedIds = new Set([...b.mappedSourceFieldIds, ...b.mappedTargetFieldIds, ...b.acknowledgedFieldIds])
    const addressedCount = allMappedOrAckedIds.size
    const mappingDone = hasMappings && b.allPrimaryApproved && totalFields > 0 && addressedCount >= totalFields

    // Phase 3 — Transform: all approved needs_transformation mappings have a saved transform
    const transformDone = b.needsTransformIds.size === 0
      ? hasMappings
      : b.coveredTransformIds.size >= b.needsTransformIds.size

    // Phase 4 — Validate: at least one scan run AND zero open blocking issues
    const validateDone = b.totalQualityIssues > 0 && b.blockingIssueCount === 0

    let completed = 0
    if (ingestionDone) completed = 1
    if (completed >= 1 && mappingDone) completed = 2
    if (completed >= 2 && transformDone) completed = 3
    if (completed >= 3 && validateDone) completed = 4
    if (completed >= 4 && b.outputCount > 0) completed = 5
    const currentPhase = completed >= 5 ? 6 : completed + 1

    return {
      id: project.id,
      name: project.name,
      source_label: src?.name || 'Source',
      target_label: tgt?.name || 'Target',
      status: project.status as 'active' | 'completed' | 'archived',
      created_at: project.created_at,
      updated_at: project.updated_at,
      completed_at: project.completed_at ?? null,
      archived_at: project.archived_at ?? null,
      totalSourceFields: b.totalSourceFields,
      mappedFieldCount: b.mappedFieldCount,
      totalRows: b.totalRows,
      blockingIssueCount: b.blockingIssueCount,
      warningCount: b.warningCount,
      totalTransforms: b.totalTransforms,
      savedTransforms: b.savedTransforms,
      needsTransformCount: b.needsTransformIds.size,
      coveredTransformCount: b.coveredTransformIds.size,
      readinessScore,
      currentPhase,
      outputCount: b.outputCount,
    }
  })
}
