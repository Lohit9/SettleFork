/**
 * Canonical project-stats formulas.
 *
 * Single source of truth for the Mapping / Transform / Quality-Issue counts
 * that appear on the Projects Dashboard card, the Migration Center page, and
 * the Readiness Report. Historically each surface computed these numbers
 * independently, which led to the Projects Dashboard drifting out of sync
 * with the Migration Center (the user-visible `102/99 fields` and `0/34
 * Transforms` mismatch).
 *
 * This module owns the formulas. All callers must feed it raw project-scoped
 * rows (TFMs, mapping_sources, fields, acknowledgments, transformations,
 * quality_issues) and read the computed counts from the returned shape.
 *
 * The function is **pure** — no I/O, no mutation of inputs. Callers are
 * responsible for fetching the rows (in bulk or per-project) and slicing
 * them to the project before handing them off. This lets the Projects
 * Dashboard amortize one round of queries across N projects while the
 * Migration Center fetches a single project's rows — both call the same
 * formulas.
 *
 * ─── Historical context ────────────────────────────────────────────────────
 *
 * Before this module existed:
 *   - `lib/actions/_outputs-core.ts:1061-1176` computed Migration Center
 *     stats with resolution-suppression-aware blocking/warning counts and a
 *     `primaryTfms`-scoped "mapped source field" set.
 *   - `lib/quality/readiness-score.ts:144-250` computed the readiness
 *     report's stats with a *near-copy* of the same logic — same mapping
 *     formula, same transform heuristic, same quality count shape. Two
 *     minor deltas had drifted in unintentionally:
 *       1. readiness-score iterated `nonRejectedTfms` (which includes bare
 *          acks) to build `mappedSourceIds`, whereas _outputs-core iterated
 *          `primaryTfms` (which excludes bare acks).
 *       2. readiness-score used the *naive* `open + in_flight + severity`
 *          counts for the readiness formula, whereas _outputs-core passed
 *          the resolution-suppressed counts. In Heritage Core these
 *          coincide because no `stage='source'` issue ever reaches the
 *          suppression branch once we've filtered to `stage='in_flight'`
 *          upstream, but the two code paths had diverged.
 *   - `lib/actions/_projects-core.ts` (the dashboard card) implemented a
 *     third, looser variant that compared target-side mapping counts
 *     against source-side field counts, producing the `102/99` artifact
 *     when a project had multiple primary TFMs pointing at the same source
 *     field.
 *
 * Extracting the canonical formula here lets all three surfaces share one
 * implementation and adds a source-level invariant test
 * (`tests/quality/stat-formulas-source-invariant.test.ts`) that pins the
 * imports so future contributors don't re-fork the logic.
 */

import { fieldNeedsTransform } from '@/lib/utils/transform-helpers'

// ─── Input shapes ─────────────────────────────────────────────────────────
//
// Each caller hands in project-scoped rows with only the columns the formula
// reads. The shapes are intentionally narrower than the full DB row types so
// that callers which bulk-select a minimal column list (e.g.
// `_projects-core.ts`) don't need to widen their SELECTs just to satisfy the
// helper's signature. Tests can construct fixtures with the smallest useful
// shape.

/** Field row used for the `fieldNeedsTransform` heuristic's type-matching
 *  carve-out. Name is consumed but never required to be non-empty; missing
 *  `data_type` falls back to `''` which the heuristic tolerates. */
export interface StatsFieldRow {
  id: string
  name?: string | null
  data_type?: string | null
}

/** Mapping-source row. `ordinal=0` is the primary; higher ordinals are
 *  contributor rows. `source_field_id` can legitimately be null for value
 *  assignments (they have no source), so we tolerate that explicitly. */
export interface StatsMappingSourceRow {
  target_field_mapping_id: string
  source_field_id: string | null
  ordinal: number
  type_compatibility: string | null
}

/** Transformation row. The formula only needs the TFM linkage and the
 *  lifecycle status; everything else (generated SQL, description) is
 *  irrelevant to the counts. */
export interface StatsTransformRow {
  target_field_mapping_id: string
  status: string | null
}

/** Quality-issue row. The formula reads the severity/stage/status to build
 *  the naive count, and consults `field_id` + `issue_kind` + description/
 *  title to decide whether resolution suppression applies.
 *
 *  Deliberately NOT a `Pick<QualityIssue, ...>`. The `QualityIssue`
 *  interface declares `description` and `title` as `string` (non-null),
 *  but the formula tolerates null for both (string comparisons cast `null`
 *  to `''`). Keeping the shape explicit and nullable lets test fixtures —
 *  which omit these fields for readability — pass without casting, AND
 *  lets callers that select the row locally without the full type
 *  (e.g. `_projects-core.ts`) hand the row in directly. */
export interface StatsQualityIssueRow {
  status: string
  stage: string
  severity: string
  field_id: string | null
  issue_kind?: string | null
  description?: string | null
  title?: string | null
}

/** Narrow TFM shape — only the columns the formula reads. Deliberately NOT
 *  a `Pick<TargetFieldMappingRow, ...>` because callers pull these rows from
 *  Supabase with local SELECTs whose inferred `combination_type` is the raw
 *  DB `string | null` (the `TFMCombinationType` narrowing only happens when
 *  you cast to the full row type). Accepting the looser shape lets every
 *  caller feed its own locally-typed row without re-casting.
 *
 *  The formula only compares `combination_type` to `null` and `'custom_sql'`;
 *  both branches are safe for any string.
 *
 *  `va_dismissed` (migration 077) marks a value-assignment TFM the user
 *  flagged as "no value needed" in the Transform tab. The formula treats a
 *  dismissed VA as out-of-scope for transform progress (it still counts as
 *  a primary TFM for mapping ratios because the row exists; it just stops
 *  inflating `transformScope`). Callers may omit the field for legacy
 *  fixtures — undefined is treated as `false`, preserving pre-077 behavior
 *  exactly. */
export interface StatsTfmRow {
  id: string
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  is_acknowledged: boolean
  combination_type: string | null
  needs_transformation: boolean | null
  va_dismissed?: boolean | null
}

export interface ComputeProjectStatsInputs {
  /** All TFMs for the project (any status — we filter inside). */
  tfms: StatsTfmRow[]
  /** All mapping_sources for the project's TFMs. Rows whose
   *  `target_field_mapping_id` is not in `tfms` are silently ignored. */
  mappingSources: StatsMappingSourceRow[]
  /** All source-side fields across all source tables in the project. */
  sourceFields: StatsFieldRow[]
  /** All target-side fields across all target tables in the project. */
  targetFields: StatsFieldRow[]
  /** IDs of source fields the user has explicitly acknowledged as
   *  intentionally unmapped (`source_field_acknowledgments.source_field_id`).
   *  Any iterable is accepted so callers can pass a `Set` or a raw array. */
  sourceAckFieldIds: Iterable<string>
  /** All transformations for the project's TFMs. */
  transforms: StatsTransformRow[]
  /** All quality issues for the project. */
  qualityIssues: StatsQualityIssueRow[]
}

// ─── Output shape ─────────────────────────────────────────────────────────
//
// The public names (`mappingApproved`, `mappingTotal`, `transformApplied`,
// `transformScope`) match the readiness-formula's input contract so that
// callers can forward them directly to `calculateReadinessScore(...)` with
// no renaming. The Migration Center's DTO still exposes the historical
// `approvedFieldMappings` / `totalFieldMappings` names for backward
// compatibility with `OutputsContent.tsx` and the heritage snapshot test;
// that renaming is a separate cleanup pass, not this lift-and-shift.

// PR-1 (feat/project-stats-shared-helper): renamed from `ProjectStats` so the
// new public-surface type at `lib/quality/project-stats.ts` can own the
// `ProjectStats` name. The output of `computeProjectStats` is purely
// internal: callers consume it via the new `ProjectStats` view assembled by
// `getProjectStats()`. No external file imports this type by name.
export interface ComputeProjectStatsResult {
  // ── Mapping ────────────────────────────────────────────────────────────
  /** Numerator: approved primary TFMs + fields counted as "acknowledged
   *  unmapped" (both source-side ACKs and bare-ack target TFMs). */
  mappingApproved: number
  /** Denominator: every "mapping slot" that exists — primary TFMs,
   *  genuinely unmapped source fields, genuinely unmapped target fields,
   *  and acknowledged-unmapped fields on either side. Always >=
   *  `mappingApproved`. */
  mappingTotal: number
  /** Source fields with no MS row and no ACK **plus** target fields with
   *  no primary TFM and no bare-ack TFM. Excluded from `mappingApproved`
   *  but counted in `mappingTotal`. */
  mappingUnmapped: number

  // ── Transform ──────────────────────────────────────────────────────────
  /** Primary TFMs the `fieldNeedsTransform` heuristic flags as needing a
   *  transform, including value assignments which are always in-scope. */
  transformScope: number
  /** In-scope TFMs whose single transformation row has status='applied'. */
  transformApplied: number
  /** In-scope TFMs with NO transformation row (status-agnostic — any
   *  existing row counts as "in progress", not "needs work"). */
  transformNeedsWork: number
  /** In-scope TFMs whose single transformation row has status='draft'. */
  transformDraft: number
  /** In-scope TFMs whose single transformation row has status='tested'. */
  transformTested: number

  // ── Quality issues ─────────────────────────────────────────────────────
  /** Naive count of `open + in_flight + severity='blocking'` quality
   *  issues. Used by the readiness-score component formula, which
   *  historically consumed this shape. */
  openBlocking: number
  /** Naive count of `open + in_flight + severity='warning'` quality
   *  issues. Mirror of `openBlocking`. */
  openWarnings: number
  /** `openBlocking` with resolution-suppression applied: a `stage='source'`
   *  issue is hidden if its `field_id` is in `resolvedSourceFieldIds` and
   *  the issue is not `isNeverResolvable`. Note that this subset is
   *  empty-by-construction in the current code path because the naive
   *  filter is scoped to `stage='in_flight'` upstream — the suppression
   *  check is preserved for parity with the pre-extraction
   *  `_outputs-core.ts` implementation and to keep the formula honest if
   *  the upstream filter ever widens. */
  openBlockingResolutionSuppressed: number
  /** Mirror of `openBlockingResolutionSuppressed` for warnings. */
  openWarningsResolutionSuppressed: number

  /** Source field IDs whose mapping is "resolved" — the field is the
   *  primary source of an approved TFM that either has a transformation
   *  row or is explicitly marked `needs_transformation=false`. Exposed so
   *  callers can apply the same suppression to other quality surfaces
   *  (per-field issue lists, fix-option counts). */
  resolvedSourceFieldIds: ReadonlySet<string>
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Issues whose field-level resolution is conceptually impossible and must
 * never be suppressed by the resolved-source-field carve-out. Preserved
 * verbatim from `_outputs-core.ts`'s inline function of the same name.
 */
function isNeverResolvable(q: {
  issue_kind?: string | null
  description?: string | null
  title?: string | null
}): boolean {
  const desc = (q.description ?? '').toLowerCase()
  const title = (q.title ?? '').toLowerCase()
  if (q.issue_kind === 'null_primary_key') return true
  if (q.issue_kind === 'orphaned_fk') return true
  if (q.issue_kind === 'referential_integrity') return true
  if (desc.includes('null') && (desc.includes('primary key') || desc.includes('primary_key'))) return true
  if (desc.includes('orphan') || title.includes('orphan')) return true
  if (desc.includes('referential') || title.includes('referential')) return true
  return false
}

// ─── Main formula ─────────────────────────────────────────────────────────

/**
 * Compute the canonical mapping / transform / quality-issue counts for a
 * single project.
 *
 * Semantic contract (MUST be preserved across refactors — any change here
 * drifts three UI surfaces simultaneously):
 *
 *   **Mapping**
 *     mappingTotal      = primaryTfms + unmappedSource + unmappedTarget + acknowledged
 *     mappingApproved   = approvedPrimaryTfms + acknowledged
 *     mappingUnmapped   = unmappedSource + unmappedTarget
 *
 *     where:
 *       primaryTfms      = non-rejected TFMs excluding bare-acks
 *                          (is_acknowledged AND combination_type IS NULL)
 *       unmappedSource   = source fields with no MS row on any primaryTfm
 *                          AND no source-side ACK
 *       unmappedTarget   = target fields with no primaryTfm pointing at
 *                          them AND no bare-ack TFM pointing at them
 *       acknowledged     = source-side ACKs UNION bare-ack TFMs' target_field_id,
 *                          counted once per field ID
 *
 *   **Transform scope**
 *     transformScope    = count of primaryTfms where
 *                           (isValueAssignment AND NOT va_dismissed)
 *                           OR fieldNeedsTransform(...) returns true
 *     transformApplied  = in-scope TFMs with transformation.status='applied'
 *     transformNeedsWork= in-scope TFMs with NO transformation row
 *
 *     value assignments (combination_type='custom_sql' AND no primary MS)
 *     are in scope EXCEPT when the user has dismissed them via the
 *     Transform tab's "no value needed" affordance (`va_dismissed=true`,
 *     migration 077). Dismissed VAs still count as primary TFMs for the
 *     mapping ratio (the row exists), they just exit the transform
 *     denominator — same effect as `needs_transformation=false` for a
 *     mapped TFM.
 *
 *   **Quality issues**
 *     openBlocking / openWarnings      = naive count of open+in_flight
 *                                        rows by severity
 *     *ResolutionSuppressed            = naive count MINUS rows whose
 *                                        stage='source' AND field is
 *                                        resolvedSourceFieldIds AND NOT
 *                                        isNeverResolvable
 *
 *     resolvedSourceFieldIds           = source_field_id of any approved
 *                                        primaryTfm whose MS row is
 *                                        primary and either
 *                                          - has a transformation row, OR
 *                                          - has needs_transformation=false
 */
export function computeProjectStats(inputs: ComputeProjectStatsInputs): ComputeProjectStatsResult {
  const {
    tfms,
    mappingSources,
    sourceFields,
    targetFields,
    sourceAckFieldIds,
    transforms,
    qualityIssues,
  } = inputs

  const tfmIdSet = new Set(tfms.map((t) => t.id))

  // Group MS rows by TFM, ignoring any MS that points at an unknown TFM.
  // ordinal=0 is the primary; we sort so `find(m => m.ordinal === 0)` picks
  // the canonical row even if the caller hands in rows in arbitrary order.
  const msByTfmId = new Map<string, StatsMappingSourceRow[]>()
  for (const ms of mappingSources) {
    if (!tfmIdSet.has(ms.target_field_mapping_id)) continue
    const list = msByTfmId.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfmId.set(ms.target_field_mapping_id, list)
  }
  for (const list of msByTfmId.values()) list.sort((a, b) => a.ordinal - b.ordinal)

  // ── Mapping ────────────────────────────────────────────────────────────
  //
  // `primaryTfms` excludes bare acks: a TFM with is_acknowledged=true AND
  // combination_type=null is an "acknowledged unmapped target field", not a
  // mapping. It gets counted in `acknowledgedCount` below, not in
  // `primaryTfms.length`.
  const nonRejectedTfms = tfms.filter((t) => t.status !== 'rejected')
  const primaryTfms = nonRejectedTfms.filter(
    (t) => !(t.is_acknowledged && t.combination_type === null),
  )
  const approvedPrimaryTfms = primaryTfms.filter((t) => t.status === 'approved')

  const mappedSourceIds = new Set<string>()
  for (const tfm of primaryTfms) {
    for (const ms of msByTfmId.get(tfm.id) ?? []) {
      if (ms.source_field_id) mappedSourceIds.add(ms.source_field_id)
    }
  }
  const primaryMappedTargetIds = new Set(primaryTfms.map((t) => t.target_field_id))

  // Bare-ack TFMs contribute target-side "acknowledged unmapped" entries.
  const targetAckFieldIds = new Set(
    tfms
      .filter((t) => t.is_acknowledged && t.combination_type === null)
      .map((t) => t.target_field_id),
  )
  const acknowledgedFieldIds = new Set<string>([
    ...sourceAckFieldIds,
    ...targetAckFieldIds,
  ])

  let unmappedSourceCount = 0
  let unmappedTargetCount = 0
  let acknowledgedCount = 0

  for (const f of sourceFields) {
    if (!mappedSourceIds.has(f.id)) {
      if (acknowledgedFieldIds.has(f.id)) acknowledgedCount++
      else unmappedSourceCount++
    }
  }
  for (const f of targetFields) {
    if (!primaryMappedTargetIds.has(f.id)) {
      if (acknowledgedFieldIds.has(f.id)) acknowledgedCount++
      else unmappedTargetCount++
    }
  }

  const mappingTotal =
    primaryTfms.length + unmappedSourceCount + unmappedTargetCount + acknowledgedCount
  const mappingApproved = approvedPrimaryTfms.length + acknowledgedCount
  const mappingUnmapped = unmappedSourceCount + unmappedTargetCount

  // ── Transform scope ────────────────────────────────────────────────────
  //
  // We build two indexes over the transformation rows: a Set for "does
  // this TFM have any transformation at all?" (drives the scope heuristic
  // and the resolved-field suppression) and a Map for the latest status
  // (drives the applied/draft/tested breakdown).
  const tfmIdsWithTransforms = new Set(transforms.map((t) => t.target_field_mapping_id))
  const transformByTfmId = new Map(transforms.map((t) => [t.target_field_mapping_id, t]))

  const sourceFieldById = new Map(sourceFields.map((f) => [f.id, f]))
  const targetFieldById = new Map(targetFields.map((f) => [f.id, f]))

  const scoredTfms = primaryTfms.map((tfm) => {
    const msList = msByTfmId.get(tfm.id) ?? []
    const primary = msList.find((m) => m.ordinal === 0) ?? null
    const isValueAssignment = primary === null && tfm.combination_type === 'custom_sql'
    const srcField = primary?.source_field_id ? sourceFieldById.get(primary.source_field_id) : null
    const tgtField = tfm.target_field_id ? targetFieldById.get(tfm.target_field_id) : null
    const hasTransformation = tfmIdsWithTransforms.has(tfm.id)

    const needsTransform = isValueAssignment
      ? !(tfm.va_dismissed === true)
      : fieldNeedsTransform({
          typeCompatibility: primary?.type_compatibility ?? '',
          confidence: tfm.confidence ?? 0,
          sourceDataType: srcField?.data_type ?? '',
          targetDataType: tgtField?.data_type ?? '',
          sourceFieldName: srcField?.name ?? '',
          targetFieldName: tgtField?.name ?? '',
          hasTransformation,
          needsTransformation: tfm.needs_transformation ?? null,
        })

    return { id: tfm.id, needsTransform, hasTransformation }
  })

  const fieldsInScope = scoredTfms.filter((t) => t.needsTransform)
  const transformScope = fieldsInScope.length
  const transformApplied = fieldsInScope.filter(
    (t) => transformByTfmId.get(t.id)?.status === 'applied',
  ).length
  const transformNeedsWork = fieldsInScope.filter((t) => !t.hasTransformation).length
  const transformDraft = fieldsInScope.filter(
    (t) => transformByTfmId.get(t.id)?.status === 'draft',
  ).length
  const transformTested = fieldsInScope.filter(
    (t) => transformByTfmId.get(t.id)?.status === 'tested',
  ).length

  // ── Resolved source fields (for quality-issue suppression) ─────────────
  const resolvedSourceFieldIds = new Set<string>()
  for (const tfm of approvedPrimaryTfms) {
    const primary = (msByTfmId.get(tfm.id) ?? []).find((m) => m.ordinal === 0)
    const sfId = primary?.source_field_id
    if (!sfId) continue
    const hasTransform = tfmIdsWithTransforms.has(tfm.id)
    const noTransformNeeded = tfm.needs_transformation === false
    if (hasTransform || noTransformNeeded) resolvedSourceFieldIds.add(sfId)
  }

  // ── Quality issue counts ───────────────────────────────────────────────
  //
  // Two flavors: naive (used by the readiness-score component formula) and
  // resolution-suppressed (used by the Migration Center card + outstanding
  // roll-up). Both start from the same `open + in_flight` filter.
  const openInFlight = qualityIssues.filter(
    (q) => q.status === 'open' && q.stage === 'in_flight',
  )
  const openBlocking = openInFlight.filter((q) => q.severity === 'blocking').length
  const openWarnings = openInFlight.filter((q) => q.severity === 'warning').length

  const openBlockingResolutionSuppressed = openInFlight.filter((q) => {
    if (q.severity !== 'blocking') return false
    if (
      q.stage === 'source' &&
      !isNeverResolvable(q) &&
      q.field_id &&
      resolvedSourceFieldIds.has(q.field_id)
    ) {
      return false
    }
    return true
  }).length
  const openWarningsResolutionSuppressed = openInFlight.filter((q) => {
    if (q.severity !== 'warning') return false
    if (
      q.stage === 'source' &&
      !isNeverResolvable(q) &&
      q.field_id &&
      resolvedSourceFieldIds.has(q.field_id)
    ) {
      return false
    }
    return true
  }).length

  return {
    mappingApproved,
    mappingTotal,
    mappingUnmapped,
    transformScope,
    transformApplied,
    transformNeedsWork,
    transformDraft,
    transformTested,
    openBlocking,
    openWarnings,
    openBlockingResolutionSuppressed,
    openWarningsResolutionSuppressed,
    resolvedSourceFieldIds,
  }
}
