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
import { unstable_noStore as noStore } from 'next/cache'
import type { Dataset, ProjectWithStats } from '@/lib/types/database'
import { computeProjectStats } from '@/lib/quality/stat-formulas'
import {
  getProjectStats,
  type ProjectStats,
} from '@/lib/quality/project-stats'

/**
 * TFM row shape used by the `getProjectsWithStatsInternal` aggregation.
 * Columns mirror the legacy FM projection (`status`, `source_field_id`,
 * `target_field_id`, `needs_transformation`) plus new-model fields
 * needed to identify bare-acks (`is_acknowledged`, `combination_type`)
 * and source-field contributors via the nested `mapping_sources` array.
 *
 * `confidence` + `type_compatibility` were added in Prompt B to feed the
 * canonical `computeProjectStats` helper — the `fieldNeedsTransform`
 * heuristic reads both to short-circuit the "same-family, direct
 * compatible at high confidence" passthrough case.
 */
export type TfmRollupRow = {
  id: string
  project_id: string
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  is_acknowledged: boolean
  combination_type: string | null
  needs_transformation: boolean | null
  va_dismissed: boolean | null
  mapping_sources: Array<{
    source_field_id: string | null
    ordinal: number
    type_compatibility: string | null
  }>
}

export async function getProjectsWithStatsInternal(
  supabase: SupabaseClient,
  orgId?: string,
): Promise<ProjectWithStats[]> {
  // Opt out of RSC caching: dashboard tile aggregates rows from tables
  // that mutate via server actions across the project (TFMs, transforms,
  // quality_issues, source_field_acks). Without noStore() Next.js caches
  // the aggregation across requests, leaving the tile stale relative to
  // the Mapping page and Migration Center which fetch fresh per request.
  // PR-4 chokepoint fix — see feat/stats-data-alignment.
  noStore()

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
    // `title` was added in Prompt B so the helper's `isNeverResolvable`
    // check can read both description and title when deciding whether a
    // resolved-source-field suppression applies.
    supabase
      .from('quality_issues')
      .select('project_id, severity, status, field_id, stage, issue_kind, description, title')
      .in('project_id', projectIds),
    supabase.from('outputs').select('project_id').in('project_id', projectIds),
    // Q5 union part 1: source-side acks live in their own table.
    supabase
      .from('source_field_acknowledgments')
      .select('project_id, source_field_id')
      .in('project_id', projectIds),
  ])

  const sourceTableIds = (sourceTables || []).map((t) => t.id)
  // Every table in the target dataset — this is what Migration Center
  // and the canonical `computeProjectStats` helper consider the "total
  // target field" universe. Prompt B switched the target-field fetch
  // from `tableMappings.target_table_id` (which is narrower: only
  // tables referenced by an approved TM) to this broader set so the
  // card's mapping ratio matches Migration Center exactly.
  const targetTableIds = (targetTables || []).map((t) => t.id)
  // Legacy helper: target tables referenced by at least one non-rejected
  // TM. Still used below to feed `totalTargetFieldCount` (which in turn
  // drives the phase-progression `mappingDone` calc) so we don't
  // accidentally shift phase transitions on projects whose target
  // dataset has unmapped tables.
  const mappedTargetTableIds = new Set((tableMappings || []).map((tm) => tm.target_table_id))

  // Round 3: source fields, target_field_mappings (FLAT — no nested
  // mapping_sources, see PR-1 INF-32 leak fix), ALL target fields.
  //
  // PR-1 (feat/project-stats-shared-helper, 2026-05-07): the previous
  // nested `mapping_sources(...)` select on `target_field_mappings` was
  // the leak vector behind the tile-vs-Migration-Center stat divergence.
  // Two failure modes coexisted: (1) the outer `.in('project_id', ...)`
  // could trip the PostgREST default 1000-row response cap when the org
  // had many TFMs; (2) the nested-array roll-up made each TFM row larger
  // and reduced the effective row budget further. Flat select +
  // explicit `.limit(50000)` + separate `mapping_sources` fetch
  // (filtered by tfmIds, also `.limit(50000)`) eliminates both. The new
  // shared helper at `lib/quality/project-stats.ts` owns the same
  // pattern and is the canonical consumer for PR-2 / PR-3.
  const TFM_ROW_LIMIT = 50_000
  const [{ data: fields }, { data: tfmRows }, { data: allTargetFields }] = await Promise.all([
    sourceTableIds.length > 0
      ? supabase
          .from('fields')
          .select('id, name, data_type, table_id')
          .in('table_id', sourceTableIds)
          .limit(TFM_ROW_LIMIT)
      : Promise.resolve({
          data: [] as { id: string; name: string | null; data_type: string | null; table_id: string }[],
          error: null,
        }),
    projectIds.length > 0
      ? supabase
          .from('target_field_mappings')
          .select(
            'id, project_id, target_field_id, confidence, status, is_acknowledged, combination_type, needs_transformation, va_dismissed',
            { count: 'exact' },
          )
          .in('project_id', projectIds)
          .limit(TFM_ROW_LIMIT)
      : Promise.resolve({
          data: [] as Array<{
            id: string
            project_id: string
            target_field_id: string
            confidence: number | null
            status: 'needs_review' | 'approved' | 'rejected'
            is_acknowledged: boolean
            combination_type: string | null
            needs_transformation: boolean | null
            va_dismissed: boolean | null
          }>,
          count: 0,
          error: null,
        }),
    targetTableIds.length > 0
      ? supabase
          .from('fields')
          .select('id, name, data_type, table_id')
          .in('table_id', targetTableIds)
          .limit(TFM_ROW_LIMIT)
      : Promise.resolve({
          data: [] as { id: string; name: string | null; data_type: string | null; table_id: string }[],
          error: null,
        }),
  ])

  const tfmsFlat = (tfmRows ?? []) as Array<{
    id: string
    project_id: string
    target_field_id: string
    confidence: number | null
    status: 'needs_review' | 'approved' | 'rejected'
    is_acknowledged: boolean
    combination_type: string | null
    needs_transformation: boolean | null
    va_dismissed: boolean | null
  }>
  const tfmIds = tfmsFlat.map((t) => t.id)

  // Round 3.5: mapping_sources for the fetched TFMs. Separate query —
  // not a nested PostgREST select — so the per-parent array roll-up
  // doesn't compete with the outer row budget. Filtered by `tfmIds` to
  // avoid pulling rows for projects we're not surfacing.
  const { data: mappingSourceRows } =
    tfmIds.length > 0
      ? await supabase
          .from('mapping_sources')
          .select(
            'target_field_mapping_id, source_field_id, ordinal, type_compatibility',
            { count: 'exact' },
          )
          .in('target_field_mapping_id', tfmIds)
          .limit(TFM_ROW_LIMIT)
      : { data: [] as Array<{
          target_field_mapping_id: string
          source_field_id: string | null
          ordinal: number
          type_compatibility: string | null
        }> }

  // In-memory join: build a TfmRollupRow-shaped list (same legacy
  // contract — `mapping_sources` field present on each TFM) so the
  // downstream bucket aggregation continues to read `tfm.mapping_sources`
  // without changing.
  const msByTfmId = new Map<
    string,
    Array<{ source_field_id: string | null; ordinal: number; type_compatibility: string | null }>
  >()
  for (const ms of mappingSourceRows ?? []) {
    const list = msByTfmId.get(ms.target_field_mapping_id) ?? []
    list.push({
      source_field_id: ms.source_field_id,
      ordinal: ms.ordinal,
      type_compatibility: ms.type_compatibility,
    })
    msByTfmId.set(ms.target_field_mapping_id, list)
  }
  const tfms: TfmRollupRow[] = tfmsFlat.map((t) => ({
    ...t,
    mapping_sources: msByTfmId.get(t.id) ?? [],
  }))

  // Round 4: transformations (column rename: field_mapping_id →
  // target_field_mapping_id).
  //
  // Filtering strategy: use a PostgREST embedded inner-join on
  // `target_field_mappings!inner(project_id)` so the `.in(...)` clause
  // stays short (projectIds is O(# projects in the org) — single digits
  // in practice), instead of listing every TFM id. The previous
  // `.in('target_field_mapping_id', tfmIds)` approach silently returned
  // zero rows once `tfmIds` crossed the PostgREST URL length ceiling
  // (~300 UUIDs). That had been masking the dashboard card's
  // `totalTransforms` / `savedTransforms` figures as 0 even for
  // projects with many applied transforms — latent since before Prompt
  // B, and the reason the pre-Prompt-B heritage snapshot captured
  // `totalTransforms: 0` despite 28 transformations existing in the
  // org.
  const { data: transformations } =
    projectIds.length > 0
      ? await supabase
          .from('transformations')
          .select(
            'target_field_mapping_id, status, target_field_mappings!inner(project_id)',
          )
          .in('target_field_mappings.project_id', projectIds)
      : {
          data: [] as Array<{
            target_field_mapping_id: string
            status: string
            target_field_mappings: { project_id: string } | null
          }>,
        }

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
  // Count target fields per project for the phase-progression
  // `mappingDone` calc. Scope remains "tables referenced by a
  // non-rejected TM" (legacy semantics) even though `allTargetFields`
  // now covers every table in the target dataset; that broader set is
  // for the canonical helper below. Restricting the count via
  // `mappedTargetTableIds` preserves phase behavior for projects whose
  // target dataset has unmapped tables.
  ;(allTargetFields || []).forEach((f) => {
    if (!mappedTargetTableIds.has(f.table_id)) return
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

  // ── Per-project slices for the canonical `computeProjectStats` ───────
  //
  // The helper in `lib/quality/stat-formulas.ts` is the single source of
  // truth for mapping / transform / blocking counts shared with the
  // Migration Center page and the readiness scorer. We feed it
  // per-project slices of the already-fetched bulk data — no additional
  // round trips — and stash each result keyed by project id so the
  // `.map(...)` below can stamp the canonical figures onto every
  // `ProjectWithStats` without re-doing work.
  //
  // Slicing strategy: build a router from TFM id → project_id, then
  // bucket mapping_sources / transformations by project in a single
  // pass each. Same O(N) we already paid for the legacy buckets above.
  type ProjectSlices = {
    tfms: TfmRollupRow[]
    mappingSources: Array<{
      target_field_mapping_id: string
      source_field_id: string | null
      ordinal: number
      type_compatibility: string | null
    }>
    transforms: Array<{ target_field_mapping_id: string; status: string | null }>
    sourceFields: Array<{ id: string; name: string | null; data_type: string | null }>
    targetFields: Array<{ id: string; name: string | null; data_type: string | null }>
    sourceAckFieldIds: string[]
    qualityIssues: Array<{
      status: string
      stage: string
      severity: string
      field_id: string | null
      issue_kind: string | null
      description: string | null
      title: string | null
    }>
  }
  const slices = new Map<string, ProjectSlices>()
  projectIds.forEach((id) =>
    slices.set(id, {
      tfms: [],
      mappingSources: [],
      transforms: [],
      sourceFields: [],
      targetFields: [],
      sourceAckFieldIds: [],
      qualityIssues: [],
    })
  )

  // Route source fields to projects via tableToProject (already built).
  ;(fields || []).forEach((f) => {
    const pid = tableToProject.get(f.table_id)
    if (!pid) return
    slices.get(pid)!.sourceFields.push({ id: f.id, name: f.name, data_type: f.data_type })
  })
  // Route target fields via the dataset → project map. `allTargetFields`
  // covers every target-dataset table, which is exactly what the helper
  // expects (matches Migration Center's `targetFieldRows`).
  const targetTableToProjectAll = new Map<string, string>()
  ;(targetTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (pid) targetTableToProjectAll.set(t.id, pid)
  })
  ;(allTargetFields || []).forEach((f) => {
    const pid = targetTableToProjectAll.get(f.table_id)
    if (!pid) return
    slices.get(pid)!.targetFields.push({ id: f.id, name: f.name, data_type: f.data_type })
  })
  tfms.forEach((tfm) => {
    const s = slices.get(tfm.project_id)
    if (!s) return
    s.tfms.push(tfm)
    for (const ms of tfm.mapping_sources ?? []) {
      s.mappingSources.push({
        target_field_mapping_id: tfm.id,
        source_field_id: ms.source_field_id,
        ordinal: ms.ordinal,
        type_compatibility: ms.type_compatibility,
      })
    }
  })
  ;(transformations || []).forEach((t) => {
    const pid = tfmToProject.get(t.target_field_mapping_id)
    if (!pid) return
    slices.get(pid)!.transforms.push({
      target_field_mapping_id: t.target_field_mapping_id,
      status: t.status,
    })
  })
  ;(sourceFieldAcks || []).forEach((a) => {
    const s = slices.get(a.project_id)
    if (s) s.sourceAckFieldIds.push(a.source_field_id)
  })
  ;(qualityIssues || []).forEach((qi) => {
    const s = slices.get(qi.project_id)
    if (!s) return
    s.qualityIssues.push({
      status: qi.status,
      stage: qi.stage,
      severity: qi.severity,
      field_id: qi.field_id,
      issue_kind: qi.issue_kind,
      description: qi.description,
      title: (qi as { title: string | null }).title,
    })
  })

  // One helper call per project; all inputs come from the slices above.
  const statsByProject = new Map<string, ReturnType<typeof computeProjectStats>>()
  for (const pid of projectIds) {
    const s = slices.get(pid)!
    statsByProject.set(
      pid,
      computeProjectStats({
        tfms: s.tfms,
        mappingSources: s.mappingSources,
        sourceFields: s.sourceFields,
        targetFields: s.targetFields,
        sourceAckFieldIds: s.sourceAckFieldIds,
        transforms: s.transforms,
        qualityIssues: s.qualityIssues,
      })
    )
  }

  // PR-1 (feat/project-stats-shared-helper): the new public-surface
  // `ProjectStats` view exposed on each `ProjectWithStats` for PR-2 (tile
  // state-machine redesign) to consume.
  //
  // PR-4 followup-B: per-project narrow fetch instead of a single bulk
  // `getProjectStats(projectIds, supabase)` call. The bulk shape hit
  // PostgREST's server-side `db-max-rows` cap (1000 in this environment)
  // for orgs with many projects — silently truncating
  // `target_field_mappings`, `fields`, and (transitively) the per-project
  // rollups. The diagnostic for "Epicor to Rootstock" showed
  // `state=awaiting_data, target=8/8` because the project's source-side
  // fields fell outside the truncated 1000-row window; per-project
  // narrowing keeps each fetch well under the cap. Trade-off: O(N)
  // round-trips instead of O(1), where N = projects in the org.
  // Acceptable for typical Settle orgs (<50 projects); pagination of
  // `fetchProjectStatsData` is the future-proof escape hatch when N
  // grows large. Parallelized via Promise.all so wall-time stays close
  // to a single round-trip.
  const perProjectStatsResults = await Promise.all(
    projectIds.map((projectId) => getProjectStats([projectId], supabase)),
  )
  const projectStatsByProject = new Map<string, ProjectStats>()
  for (let i = 0; i < projectIds.length; i++) {
    const stats = perProjectStatsResults[i].get(projectIds[i])
    if (stats) projectStatsByProject.set(projectIds[i], stats)
  }

  return projects.map((project) => {
    const b = buckets.get(project.id)!
    const stats = statsByProject.get(project.id)!
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
      // Prompt B: switched from the naive in-flight blocking count
      // (legacy `b.blockingIssueCount`) to the resolution-suppressed
      // figure from `computeProjectStats`. This matches the Migration
      // Center card exactly — when a user dismisses a source field or
      // applies a transform, the dashboard card drops the blocking
      // count in lockstep instead of going stale until the next scan.
      blockingIssueCount: stats.openBlockingResolutionSuppressed,
      warningCount: b.warningCount,
      totalTransforms: b.totalTransforms,
      savedTransforms: b.savedTransforms,
      needsTransformCount: b.needsTransformIds.size,
      coveredTransformCount: b.coveredTransformIds.size,
      // ── Canonical card stats (Prompt B) ───────────────────────────
      // Single source of truth: `computeProjectStats`. The Projects
      // Dashboard card renders these directly; Migration Center renders
      // them via `getOutputsPageDataCore`. Any future formula change
      // lands in `lib/quality/stat-formulas.ts` and propagates to both
      // surfaces automatically.
      mappingApproved: stats.mappingApproved,
      mappingTotal: stats.mappingTotal,
      transformApplied: stats.transformApplied,
      transformScope: stats.transformScope,
      transformNeedsWork: stats.transformNeedsWork,
      readinessScore,
      currentPhase,
      outputCount: b.outputCount,
      // PR-1: new public-surface view (state machine + axis-shaped stats).
      // Tile rendering still reads the legacy fields above; PR-2 switches
      // the tile to consume `projectStats` directly and retire the legacy
      // duplicates.
      projectStats: projectStatsByProject.get(project.id) ?? null,
    }
  })
}
