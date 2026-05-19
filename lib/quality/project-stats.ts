/**
 * Canonical project-stats helper — single source of truth for the figures
 * rendered on the Projects Dashboard tile, the Migration Center widgets, and
 * (in PR-3) the Mapping page header strip.
 *
 * ─── PR-1 scope (feat/project-stats-shared-helper) ──────────────────────────
 *
 * Closes the leak observed across surfaces (tile showed `52/68 mapped` while
 * Migration Center showed `59/140` for the same project). Root cause was
 * the tile's row-fetch shape: a nested `mapping_sources(...)` select on the
 * TFM query plus a default-1000-row response limit that silently truncated
 * rows when the org had many TFMs across all projects combined.
 *
 * The fix here is structural: this helper owns the safe fetch pattern (flat
 * queries, in-memory join, `count: 'exact'` instrumentation, defensive
 * `.limit()` caps) and the per-project rollup. Both `_projects-core.ts`
 * (tile) and `_outputs-core.ts` (Migration Center) call it. The Mapping
 * page (`getMappingsForRedesignCore`) stays on its own grid-specific path
 * for now and adopts the helper in PR-3.
 *
 * ─── Surface contract ───────────────────────────────────────────────────────
 *
 * `ProjectStats` is the new public view. The shape mirrors what each surface
 * actually renders: a state-machine label plus four axes (target / source /
 * transforms / blocking). The internal `ComputeProjectStatsResult` shape
 * (in `stat-formulas.ts`) stays intact and is reused for the proven
 * mapping/transform/blocking math; this file adds state detection + the
 * source axis on top.
 *
 * ─── State machine (3-state per Q1) ─────────────────────────────────────────
 *
 *   awaiting_data       — EITHER source or target side has zero fields
 *   data_ingested       — both sides have ≥1 field, no real mappings yet
 *   mappings_generated  — ≥1 non-acknowledged TFM with mapping_sources rows
 *                         carrying source_field_id IS NOT NULL (excludes
 *                         bare-acks and empty-MS value-assignments)
 *
 * State 4 (`validated`) was scoped out per Q1: no validation-run history
 * table exists in the current schema and `projects.completed_at` is a manual
 * marker. A separate INF ticket tracks the schema gap.
 *
 * ─── Transforms numerator (per Q2) ──────────────────────────────────────────
 *
 * `transforms.complete` = `transformScope - transformNeedsWork`, i.e. all
 * in-scope TFMs that have ANY transformation row (status='draft' / 'tested' /
 * 'applied'). Diverges from the Migration Center's historical "applied only"
 * numerator: user-saved-but-not-applied work counts as completed by the user.
 * Surfaces that want the stricter "applied only" count can read
 * `transformApplied` off the underlying `ComputeProjectStatsResult` (this
 * helper exposes both via the row-by-row reuse pattern).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeProjectStats } from '@/lib/quality/stat-formulas'

// ─── Public types ───────────────────────────────────────────────────────────

export type ProjectState =
  | 'awaiting_data'
  | 'data_ingested'
  | 'mappings_generated'

export interface ProjectStatsTargetAxis {
  /** mappingApproved — approved primary TFMs + acknowledged-unmapped fields.
   *  Unchanged in PR-7 (only the denominator was redefined). */
  approved: number
  /** mappingTotal — TARGET-SIDE mapping slots only (PR-7). Specifically:
   *  primary TFMs + unmapped target fields + acknowledged-unmapped fields.
   *  Pre-PR-7 also included unmapped SOURCE fields, conflating source-side
   *  accounting into a target-axis denominator. Source-side accounting now
   *  lives on `ProjectStatsSourceAxis.{decided, total}` exclusively. The
   *  post-PR-7 value matches the visible Mapping page grid count exactly. */
  total: number
  /** mappingUnmapped — TARGET fields with no primary TFM and no bare-ack
   *  (PR-7 made this target-side-only too, matching `total`). Sub-component
   *  of `needsReview`; consumers wanting the broader "everything not
   *  approved" bucket should read `needsReview` instead. */
  unmapped: number
  /** mappingNeedsReview — `total - approved` (PR-7). Pre-PR-7 (added in
   *  PR-6) this only counted primary TFMs with status='needs_review'.
   *  Post-PR-7 it's the residual: needs_review TFMs + rejected primary
   *  TFMs + unacknowledged unmapped target fields. Aligns the chip math
   *  on the Mapping page strip — `Approved + Needs Review = total`. */
  needsReview: number
  /** Distinct target_field_id count across primary TFMs (non-rejected,
   *  non-bare-ack). Answers "how many target fields are used in at least
   *  one real mapping?" — status-agnostic across `needs_review` and
   *  `approved`. Numerator for the Mapping page strip's "Target Fields"
   *  chip alongside `schemaTotal`. Always <= `schemaTotal`. */
  usedInMapping: number
  /** Schema-wide target-field count (`datasets.role='target'`). Distinct
   *  from `total`, which counts addressable mapping slots (primary TFMs
   *  + unmapped target fields + acknowledged-unmapped). Use `schemaTotal`
   *  when the question is "how many target fields does the schema
   *  define?", `total` when the question is "how many mapping slots
   *  exist?". */
  schemaTotal: number
}

export interface ProjectStatsSourceAxis {
  /** |mapped ∪ acknowledged| — distinct source_field_ids appearing in non-rejected
   *  mapping_sources rows OR in source_field_acknowledgments. */
  decided: number
  /** Total source-side fields for the project (from datasets.role='source'). */
  total: number
  /** Distinct source_field_id count across non-rejected TFMs'
   *  `mapping_sources` rows. Answers "how many source fields contribute
   *  to at least one real mapping?". Differs from `decided` by excluding
   *  acknowledged-only sources (which carry no mapping). Always
   *  <= `decided` <= `total`. */
  usedInMapping: number
}

export interface ProjectStatsTransforms {
  /** transformScope - transformNeedsWork = TFMs in scope with ANY transformation row
   *  (draft / tested / applied). User-saved counts; see Q2 in PR-1 brief. */
  complete: number
  /** transformScope — primary TFMs flagged by `fieldNeedsTransform`, plus
   *  non-dismissed value assignments. Matches Transform page "Define + Saved + Applied". */
  total: number
}

export interface ProjectStats {
  state: ProjectState
  target: ProjectStatsTargetAxis
  source: ProjectStatsSourceAxis
  transforms: ProjectStatsTransforms
  /** openBlockingResolutionSuppressed — same suppression rules as Migration Center. */
  blocking: number
}

// ─── Defensive fetch parameters ─────────────────────────────────────────────

/**
 * Per-query row cap. Set well above the largest realistic project-scoped
 * row count (typical migration projects: < 1000 TFMs, < 10K mapping_sources).
 * Without an explicit `.limit()`, PostgREST applies its default-1000 cap
 * silently — that's the leak root cause this helper exists to close.
 *
 * If a single org's bulk fetch ever genuinely exceeds 50K rows for a single
 * table, the count-vs-rows invariant below logs a warning so we know to
 * paginate properly.
 */
const ROW_LIMIT = 50_000

interface RawProjectStatsData {
  datasets: Array<{ id: string; project_id: string; role: string }>
  tables: Array<{ id: string; dataset_id: string }>
  fields: Array<{ id: string; name: string | null; data_type: string | null; table_id: string }>
  tfms: Array<{
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
  mappingSources: Array<{
    target_field_mapping_id: string
    source_field_id: string | null
    ordinal: number
    type_compatibility: string | null
  }>
  sourceAcks: Array<{ project_id: string; source_field_id: string }>
  transformations: Array<{
    target_field_mapping_id: string
    status: string
    target_field_mappings: { project_id: string } | null
  }>
  qualityIssues: Array<{
    project_id: string
    status: string
    stage: string
    severity: string
    field_id: string | null
    issue_kind: string | null
    description: string | null
    title: string | null
  }>
  /** PR γ.2 — `target_field_coverage` rows for the project set. The
   *  rollup feeds these into `computeProjectStats` so coverage-status
   *  ='approved' (user-driven, post-γ.2) contributes to mappingApproved
   *  on no-source target fields. */
  coverage: Array<{
    project_id: string
    target_field_id: string
    status: 'needs_review' | 'approved' | 'rejected'
    status_set_by: 'ai_auto' | 'user' | 'system_default'
  }>
}

/** Internal: warn (don't throw) when PostgREST returns fewer rows than the
 *  exact count says exist. Surfaces the leak unambiguously without breaking
 *  callers if a row cap is genuinely hit on a real production-scale fetch. */
function assertNoTruncation(label: string, count: number | null, rowsLength: number): void {
  if (count !== null && count > rowsLength) {
    // eslint-disable-next-line no-console -- diagnostic for the leak fix
    console.warn(
      `[getProjectStats] ${label} fetch truncated: count=${count} rows=${rowsLength}. ` +
        `Increase ROW_LIMIT or paginate.`,
    )
  }
}

/**
 * Fetch the raw project-scoped rows the rollup needs. Exported so callers
 * that already need raw rows for surface-specific rendering (tile phase
 * logic, Migration Center detail widgets) can do one fetch per request and
 * thread the same data through both `rollupProjectStats` and their own
 * downstream code, instead of paying for a second round-trip.
 *
 * Safe against PostgREST default row caps via explicit `.limit(ROW_LIMIT)`
 * and `count: 'exact'` invariant checks (warns to stderr on truncation).
 */
export async function fetchProjectStatsData(
  projectIds: string[],
  client: SupabaseClient,
): Promise<RawProjectStatsData> {
  if (projectIds.length === 0) {
    return {
      datasets: [],
      tables: [],
      fields: [],
      tfms: [],
      mappingSources: [],
      sourceAcks: [],
      transformations: [],
      qualityIssues: [],
      coverage: [],
    }
  }

  // Round 1: datasets define source/target sides for the project set. We
  // need them resolved before fetching tables / fields.
  const datasetsRes = await client
    .from('datasets')
    .select('id, project_id, role', { count: 'exact' })
    .in('project_id', projectIds)
    .limit(ROW_LIMIT)
  assertNoTruncation('datasets', datasetsRes.count, datasetsRes.data?.length ?? 0)
  const datasets = datasetsRes.data ?? []
  const datasetIds = datasets.map((d) => d.id)
  const sourceDatasetIds = new Set(
    datasets.filter((d) => d.role === 'source').map((d) => d.id),
  )
  const targetDatasetIds = new Set(
    datasets.filter((d) => d.role === 'target').map((d) => d.id),
  )

  // Round 2: tables (scoped to the project's datasets — narrows the field
  // fetch in round 3). All other project-scoped fetches run in parallel
  // since they don't depend on table IDs.
  const [tablesRes, tfmsRes, sourceAcksRes, qualityIssuesRes, coverageRes] = await Promise.all([
    datasetIds.length > 0
      ? client
          .from('tables')
          .select('id, dataset_id', { count: 'exact' })
          .in('dataset_id', datasetIds)
          .limit(ROW_LIMIT)
      : Promise.resolve({ data: [], count: 0, error: null }),
    client
      .from('target_field_mappings')
      .select(
        'id, project_id, target_field_id, confidence, status, is_acknowledged, combination_type, needs_transformation, va_dismissed',
        { count: 'exact' },
      )
      .in('project_id', projectIds)
      .limit(ROW_LIMIT),
    client
      .from('source_field_acknowledgments')
      .select('project_id, source_field_id', { count: 'exact' })
      .in('project_id', projectIds)
      .limit(ROW_LIMIT),
    client
      .from('quality_issues')
      .select(
        'project_id, severity, status, field_id, stage, issue_kind, description, title',
        { count: 'exact' },
      )
      .in('project_id', projectIds)
      .limit(ROW_LIMIT),
    // PR γ.2 — fetch target_field_coverage rows so the rollup can UNION
    // coverage-status='approved' into mappingApproved for no-source rows
    // (drawer-side user-approved coverage rows post-γ.2). Pre-Path-D
    // projects return zero rows; pre-PR-γ rows lack the status column
    // (legacy), but the SELECT defaults missing columns to NULL on the
    // wire — which is filtered out by the 'approved' check downstream.
    client
      .from('target_field_coverage')
      .select('project_id, target_field_id, status, status_set_by', { count: 'exact' })
      .in('project_id', projectIds)
      .limit(ROW_LIMIT),
  ])
  assertNoTruncation('tables', tablesRes.count, tablesRes.data?.length ?? 0)
  assertNoTruncation('target_field_mappings', tfmsRes.count, tfmsRes.data?.length ?? 0)
  assertNoTruncation(
    'source_field_acknowledgments',
    sourceAcksRes.count,
    sourceAcksRes.data?.length ?? 0,
  )
  assertNoTruncation('quality_issues', qualityIssuesRes.count, qualityIssuesRes.data?.length ?? 0)
  assertNoTruncation('target_field_coverage', coverageRes.count, coverageRes.data?.length ?? 0)

  const tables = tablesRes.data ?? []
  const tfms = (tfmsRes.data ?? []) as RawProjectStatsData['tfms']
  const sourceAcks = sourceAcksRes.data ?? []
  const qualityIssues = (qualityIssuesRes.data ?? []) as RawProjectStatsData['qualityIssues']
  const coverage = (coverageRes.data ?? []) as RawProjectStatsData['coverage']

  // Round 3: fields scoped to the project's tables; mapping_sources scoped
  // to the project's TFMs; transformations via embedded inner-join on
  // project_id (matches the existing tile-path pattern proven against the
  // PostgREST URL-length ceiling). All three run in parallel.
  const tableIds = tables.map((t) => t.id)
  const tfmIds = tfms.map((t) => t.id)

  const [fieldsRes, msRes, transformsRes] = await Promise.all([
    tableIds.length > 0
      ? client
          .from('fields')
          .select('id, name, data_type, table_id', { count: 'exact' })
          .in('table_id', tableIds)
          .limit(ROW_LIMIT)
      : Promise.resolve({ data: [], count: 0, error: null }),
    tfmIds.length > 0
      ? client
          .from('mapping_sources')
          .select(
            'target_field_mapping_id, source_field_id, ordinal, type_compatibility',
            { count: 'exact' },
          )
          .in('target_field_mapping_id', tfmIds)
          .limit(ROW_LIMIT)
      : Promise.resolve({ data: [], count: 0, error: null }),
    projectIds.length > 0
      ? client
          .from('transformations')
          .select(
            'target_field_mapping_id, status, target_field_mappings!inner(project_id)',
            { count: 'exact' },
          )
          .in('target_field_mappings.project_id', projectIds)
          .limit(ROW_LIMIT)
      : Promise.resolve({ data: [], count: 0, error: null }),
  ])
  assertNoTruncation('fields', fieldsRes.count, fieldsRes.data?.length ?? 0)
  assertNoTruncation('mapping_sources', msRes.count, msRes.data?.length ?? 0)
  assertNoTruncation('transformations', transformsRes.count, transformsRes.data?.length ?? 0)

  // Hint about source/target attribution for fields: we need to know which
  // dataset role each field belongs to. Build a tableId → role map.
  const tableIdToRole = new Map<string, 'source' | 'target' | null>()
  for (const t of tables) {
    if (sourceDatasetIds.has(t.dataset_id)) tableIdToRole.set(t.id, 'source')
    else if (targetDatasetIds.has(t.dataset_id)) tableIdToRole.set(t.id, 'target')
    else tableIdToRole.set(t.id, null)
  }

  return {
    datasets,
    tables,
    fields: (fieldsRes.data ?? []) as RawProjectStatsData['fields'],
    tfms,
    mappingSources: (msRes.data ?? []) as RawProjectStatsData['mappingSources'],
    sourceAcks,
    transformations: (transformsRes.data ?? []) as unknown as RawProjectStatsData['transformations'],
    qualityIssues,
    coverage,
  }
}

// ─── Per-project rollup (pure) ──────────────────────────────────────────────

/**
 * Compute a single project's `ProjectStats` from pre-fetched raw rows. Pure
 * function — exported for unit testing without a Supabase client. The
 * `getProjectStats()` async wrapper handles the fetch.
 */
export function rollupProjectStats(
  projectId: string,
  raw: RawProjectStatsData,
): ProjectStats {
  // Source/target sides via datasets.role join.
  const projectDatasets = raw.datasets.filter((d) => d.project_id === projectId)
  const sourceDatasetIds = new Set(
    projectDatasets.filter((d) => d.role === 'source').map((d) => d.id),
  )
  const targetDatasetIds = new Set(
    projectDatasets.filter((d) => d.role === 'target').map((d) => d.id),
  )

  const sourceTableIds = new Set(
    raw.tables.filter((t) => sourceDatasetIds.has(t.dataset_id)).map((t) => t.id),
  )
  const targetTableIds = new Set(
    raw.tables.filter((t) => targetDatasetIds.has(t.dataset_id)).map((t) => t.id),
  )

  const sourceFields = raw.fields.filter((f) => sourceTableIds.has(f.table_id))
  const targetFields = raw.fields.filter((f) => targetTableIds.has(f.table_id))

  // Project-scoped row slices.
  const projectTfms = raw.tfms.filter((t) => t.project_id === projectId)
  const projectTfmIdSet = new Set(projectTfms.map((t) => t.id))
  const projectMs = raw.mappingSources.filter((m) =>
    projectTfmIdSet.has(m.target_field_mapping_id),
  )
  const projectAcks = raw.sourceAcks.filter((a) => a.project_id === projectId)
  const projectQI = raw.qualityIssues.filter((q) => q.project_id === projectId)
  // PR γ.2 — project-scoped coverage rows for the mappingApproved UNION.
  const projectCoverage = raw.coverage.filter((c) => c.project_id === projectId)

  // Transformations were fetched via embedded inner-join; the row's
  // `target_field_mappings.project_id` carries the routing key.
  const projectTransforms = raw.transformations.filter(
    (t) => t.target_field_mappings?.project_id === projectId,
  )

  // ── State detection (3-state per Q1) ────────────────────────────────
  let state: ProjectState
  if (sourceFields.length === 0 || targetFields.length === 0) {
    state = 'awaiting_data'
  } else {
    // ≥1 non-acknowledged TFM with at least one MS row carrying a real
    // source_field_id. Bare acks (is_acknowledged=true) are excluded; empty-MS
    // value-assignments (combination_type='custom_sql' with zero MS rows)
    // are excluded by virtue of the .some() not finding a non-null source.
    const realMappingExists = projectTfms.some(
      (t) =>
        !t.is_acknowledged &&
        projectMs.some(
          (m) => m.target_field_mapping_id === t.id && m.source_field_id !== null,
        ),
    )
    state = realMappingExists ? 'mappings_generated' : 'data_ingested'
  }

  // ── Target axis + transforms + blocking via canonical formula ───────
  const stats = computeProjectStats({
    tfms: projectTfms,
    mappingSources: projectMs,
    sourceFields: sourceFields.map((f) => ({
      id: f.id,
      name: f.name,
      data_type: f.data_type,
    })),
    targetFields: targetFields.map((f) => ({
      id: f.id,
      name: f.name,
      data_type: f.data_type,
    })),
    sourceAckFieldIds: projectAcks.map((a) => a.source_field_id),
    transforms: projectTransforms.map((t) => ({
      target_field_mapping_id: t.target_field_mapping_id,
      status: t.status,
    })),
    qualityIssues: projectQI,
    coverage: projectCoverage.map((c) => ({
      target_field_id: c.target_field_id,
      status: c.status,
      status_set_by: c.status_set_by,
    })),
  })

  // ── Source axis (new — distinct mapped ∪ acknowledged) ──────────────
  // Mapped = distinct source_field_ids in non-rejected TFMs' mapping_sources.
  // Rejected TFMs don't claim sources (they're explicitly disowned).
  const nonRejectedTfmIdSet = new Set(
    projectTfms.filter((t) => t.status !== 'rejected').map((t) => t.id),
  )
  const mappedSourceIds = new Set<string>()
  for (const ms of projectMs) {
    if (ms.source_field_id && nonRejectedTfmIdSet.has(ms.target_field_mapping_id)) {
      mappedSourceIds.add(ms.source_field_id)
    }
  }
  const ackSourceIds = new Set(projectAcks.map((a) => a.source_field_id))
  const decidedSourceIds = new Set<string>([...mappedSourceIds, ...ackSourceIds])

  // ── Transforms numerator: scope - needsWork = saved + applied (Q2) ──
  const transformsComplete = stats.transformScope - stats.transformNeedsWork

  return {
    state,
    target: {
      approved: stats.mappingApproved,
      total: stats.mappingTotal,
      unmapped: stats.mappingUnmapped,
      needsReview: stats.mappingNeedsReview,
      usedInMapping: stats.targetFieldsUsedInMapping,
      schemaTotal: targetFields.length,
    },
    source: {
      decided: decidedSourceIds.size,
      total: sourceFields.length,
      usedInMapping: mappedSourceIds.size,
    },
    transforms: {
      complete: transformsComplete,
      total: stats.transformScope,
    },
    blocking: stats.openBlockingResolutionSuppressed,
  }
}

// ─── Public async helper ────────────────────────────────────────────────────

/**
 * Fetch + roll up `ProjectStats` for one or many projects. Single Supabase
 * round-trip (4 parallel queries). Safe against PostgREST default row caps
 * via explicit `.limit(ROW_LIMIT)` and `count: 'exact'` invariant checks.
 *
 * @param projectIds  Project IDs to compute stats for. Pass a single-element
 *                    array for one project; pass the full org's IDs to amortize
 *                    fetch cost across the dashboard tile.
 * @param client      Supabase client. Pass an RLS-bound user client for
 *                    surfaces the user navigated to (Projects Dashboard,
 *                    Mapping page); pass `supabaseAdmin` for operational reads
 *                    where RLS is already enforced upstream (Migration Center).
 *
 * @returns A `Map` keyed by project ID. Projects with no rows in any table
 *          (e.g. brand-new empty project) yield an `awaiting_data` state with
 *          all zero counts. Projects in `projectIds` that don't exist in the
 *          `projects` table will be absent from the returned map (the helper
 *          doesn't fetch the projects table itself — callers do).
 */
export async function getProjectStats(
  projectIds: string[],
  client: SupabaseClient,
): Promise<Map<string, ProjectStats>> {
  const result = new Map<string, ProjectStats>()
  if (projectIds.length === 0) return result

  const raw = await fetchProjectStatsData(projectIds, client)

  for (const projectId of projectIds) {
    result.set(projectId, rollupProjectStats(projectId, raw))
  }
  return result
}

// Re-export the raw-data type so call sites that thread it through helper
// functions (or compose multiple rollups from one fetch) can do so without
// re-deriving the shape.
export type { RawProjectStatsData }
