import type {
  MappedRow,
  MappingsForRedesignResult,
  MappingSourceRef,
  SourceFieldWithState,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

/**
 * Flat-view row projection used by the Mapping list view.
 *
 * The redesign data feed already emits a flat `rows: MappingRow[]`
 * array; this helper folds the source-side derivations (acks +
 * unmapped source fields) in.
 *
 *   • mapped TFM (any source count) → 1 flat row carrying the full
 *     `sources` array sorted by ordinal ASC. The renderer shows the
 *     first source inline and, for multi-source TFMs, surfaces an
 *     expand/collapse pill that reveals indented "Also contributes
 *     to …" sub-rows for sources[1..]. Per-source actions (reject,
 *     swap) for non-primary sources move to the edit drawer.
 *   • value assignment         → 1 flat row, source cells blank
 *                                 (kind: 'value-assignment')
 *   • unmapped target          → 1 flat row, source cells blank
 *                                 (kind: 'unmapped-target')
 *   • source-side ack          → 1 flat row, target cells blank
 *                                 (kind: 'unmapped-source')
 *   • source-only unmapped     → 1 flat row, target cells blank
 *
 * INF-57 (2026-05-10): acknowledged target fields are surfaced by the
 * server as `UnmappedRow` with status='approved'. The flat view treats
 * them like any other unmapped target row — the status field carries
 * the 'approved' value and the renderer draws the green Approved dot.
 *
 * Source-side acknowledgments live separately on
 * `result.sourceFieldAcknowledgments`. They ALWAYS appear in the flat
 * view, because they represent explicit user decisions worth surfacing.
 *
 * Multi-source layout history (for grep-archaeology):
 *   • v1 architecture review locked Option C — parent + N children.
 *   • Third polish pass collapsed to ONE compact row with a `N×` badge.
 *   • Sixth polish pass split into N independent rows + left-accent
 *     bracket, with per-source reject on the inline row.
 *   • feat/mapping-table-redesign (this revision) returns to ONE flat
 *     row per TFM. The full `sources` array travels on the row so the
 *     renderer can show the first source inline + a "+N source" pill
 *     and sub-rows on expand. Approve / reject / edit on the main row
 *     are TFM-atomic; per-source reject moves to the drawer.
 */

export type FlatRowStatus = 'approved' | 'needs_review' | 'rejected'

interface FlatRowBase {
  /**
   * Stable rendering + mutation id. For mapped-parent and value
   * assignment + unmapped-target this is the TFM / synthetic row id
   * straight from the server. For mapped-child it is the shimmed
   * contributor id `<tfmId>::<mappingSourceId>`. For
   * source-side rows it is a synthetic prefix-namespaced id.
   */
  id: string

  /**
   * Group identity used for visual grouping of multi-source families.
   * All children of a multi-source TFM share their parent's groupId
   * (the TFM uuid). Leaf rows have groupId === id.
   */
  groupId: string

  /** Display status (3-bucket scheme: approved / needs_review / rejected). */
  status: FlatRowStatus
}

export interface MappedFlatRow extends FlatRowBase {
  kind: 'mapped'
  targetField: TargetFieldRef
  /**
   * All sources for this TFM, sorted by ordinal ASC (0 first).
   * `sources[0]` is shown inline on the main flat row; sources[1..]
   * surface in the expand/collapse pill's sub-rows. Always length ≥ 1
   * (zero-source TFMs are emitted as `kind: 'value-assignment'`).
   */
  sources: MappingSourceRef[]
  /**
   * TFM-aggregate confidence (`MappingRow.confidence`, MIN across
   * sources, server-derived). Per-source confidence lives on each
   * `MappingSourceRef` but is often null in real data; the aggregate
   * is the right surface for the flat view's Confidence column.
   */
  confidence: number | null
  parentRow: MappedRow
}

export interface ValueAssignmentFlatRow extends FlatRowBase {
  kind: 'value-assignment'
  targetField: TargetFieldRef
  confidence: number | null
  parentRow: ValueAssignmentRow
}

export interface UnmappedTargetFlatRow extends FlatRowBase {
  kind: 'unmapped-target'
  targetField: TargetFieldRef
  confidence: number | null
  parentRow: UnmappedRow
}

export interface UnmappedSourceFlatRow extends FlatRowBase {
  kind: 'unmapped-source'
  sourceField: SourceFieldWithState
  /**
   * Static-config confidence for the unmapped source field, mirrored
   * from `SourceFieldWithState.confidence`. Carried on the flat row so
   * the list view's Confidence cell reads `row.confidence` uniformly
   * across all four row kinds. `null` when the project has no static
   * config entry for this field.
   */
  confidence: number | null
  /** Non-null when this row represents a source-side acknowledgment. */
  acknowledgmentId: string | null
  /** Reason text for source-side acks; null otherwise. */
  acknowledgmentReason: string | null
}

export type FlatRow =
  | MappedFlatRow
  | ValueAssignmentFlatRow
  | UnmappedTargetFlatRow
  | UnmappedSourceFlatRow

export function flattenRowsForListView(
  result: MappingsForRedesignResult,
): FlatRow[] {
  const out: FlatRow[] = []
  const sourceFieldIdsReferenced = new Set<string>()

  for (const row of result.rows) {
    if (row.kind === 'mapped') {
      const status = normalizeMappedStatus(row.status)
      if (row.sources.length === 0) {
        // Defensive: a 'mapped' row with no sources is not expected
        // server-side, but skip it cleanly rather than emit a
        // half-rendered row. The row will reappear as an unmapped
        // target after the next refresh once server-side state settles.
        continue
      }
      for (const src of row.sources) {
        sourceFieldIdsReferenced.add(src.sourceField.id)
      }
      // One flat row per TFM. The renderer reads `sources[0]` as the
      // inline primary and exposes sources[1..] via the "+N source"
      // expand/collapse pill. Sort by ordinal ASC so the primary is
      // deterministic across reloads.
      const sources = [...row.sources].sort((a, b) => a.ordinal - b.ordinal)
      out.push({
        kind: 'mapped',
        id: row.id,
        groupId: row.id,
        status,
        targetField: row.targetField,
        sources,
        confidence: row.confidence,
        parentRow: row,
      })
      continue
    }
    if (row.kind === 'value_assignment') {
      out.push({
        kind: 'value-assignment',
        id: row.id,
        groupId: row.id,
        status: normalizeMappedStatus(row.status),
        targetField: row.targetField,
        confidence: row.confidence,
        parentRow: row,
      })
      continue
    }
    // kind === 'unmapped' — covers coverage-only rows AND INF-57 target acks
    out.push({
      kind: 'unmapped-target',
      id: row.id,
      groupId: row.id,
      status: normalizeUnmappedStatus(row.status),
      targetField: row.targetField,
      confidence: row.confidence,
      parentRow: row,
    })
  }

  const sourceFieldById = new Map(result.sourceFields.map((f) => [f.id, f]))

  // Source-side acks first — always visible, independent of the toggle.
  // The ack carries a `decision` field which determines the rendered
  // status:
  //   decision='acknowledged' → 'approved' (green dot, modal-path
  //     explicit accept that the field will not be migrated)
  //   decision='rejected'     → 'needs_review' (grey dot). Reject = reset
  //     (PR #157): a rejected source row returns to the neutral state,
  //     identical to the mapped / VA / unmapped-target reject outcomes.
  //     The ack row's PRESENCE — not its rendered status — is the
  //     suppression marker that zeroes the static-config rationale +
  //     confidence (handled upstream in `buildSourceFieldsWithState`),
  //     so the row reads like a fresh unmapped-source row with no AI
  //     commentary.
  // Both decisions are addressable: the row stays visible because it
  // represents a deliberate user choice worth surfacing in audit.
  const ackedSourceFieldIds = new Set<string>()
  for (const ack of result.sourceFieldAcknowledgments) {
    const sf = sourceFieldById.get(ack.sourceFieldId)
    if (!sf) continue
    if (sourceFieldIdsReferenced.has(sf.id)) continue
    ackedSourceFieldIds.add(sf.id)
    const ackStatus: FlatRowStatus =
      ack.decision === 'rejected' ? 'needs_review' : 'approved'
    out.push({
      kind: 'unmapped-source',
      id: `ack::source::${ack.id}`,
      groupId: `ack::source::${ack.id}`,
      status: ackStatus,
      sourceField: sf,
      confidence: sf.confidence,
      acknowledgmentId: ack.id,
      acknowledgmentReason: ack.reason,
    })
  }

  // Pure source-only unmapped — always emitted. The prior
  // `showUnmappedSourceFields` toggle was retired at the
  // feat/mapping-list-toggle-and-columns refinement pass: the
  // flat view always shows every source field. Audit workflows
  // need a complete picture, and clustering by target keeps
  // the unaddressed source rows contained at the bottom rather
  // than drowning the table mid-list.
  for (const sf of result.sourceFields) {
    if (sourceFieldIdsReferenced.has(sf.id)) continue
    if (ackedSourceFieldIds.has(sf.id)) continue
    out.push({
      kind: 'unmapped-source',
      id: `unmapped-source::${sf.id}`,
      groupId: `unmapped-source::${sf.id}`,
      status: 'needs_review',
      sourceField: sf,
      confidence: sf.confidence,
      acknowledgmentId: null,
      acknowledgmentReason: null,
    })
  }

  return out
}

/**
 * Status tally over a flat-row projection.
 *
 * Canonical counter for the Mapping page summary strip's Approved /
 * Needs Review chips AND the Migration Center "Mapping Coverage" card.
 * Both surfaces flatten the same `MappingsForRedesignResult` through
 * `flattenRowsForListView` and tally it here, so the two numbers are
 * guaranteed identical for a given project.
 *
 * The tally spans all four flat-row kinds (`mapped`, `value-assignment`,
 * `unmapped-target`, `unmapped-source`). Folding in `unmapped-source`
 * is the deliberate behavior the Mapping strip relies on — counting
 * the target-keyed rows alone undercounts Needs Review (the Rootstock
 * POC undercount: 87 vs. the true total). `rejected` rows are folded
 * into `needsReview` (post-#157/#158/A2 'rejected' carries no semantic
 * distinct from 'needs_review' — Reject = reset).
 */
export function countFlatRowStatuses(flatRows: FlatRow[]): {
  approved: number
  needsReview: number
} {
  let approved = 0
  let needsReview = 0
  for (const row of flatRows) {
    if (row.status === 'approved') approved++
    else if (row.status === 'needs_review' || row.status === 'rejected')
      needsReview++
  }
  return { approved, needsReview }
}

function normalizeMappedStatus(
  status: 'needs_review' | 'approved' | 'rejected' | 'unmapped',
): FlatRowStatus {
  if (status === 'unmapped') return 'needs_review'
  return status
}

function normalizeUnmappedStatus(
  status: 'needs_review' | 'approved' | 'rejected' | 'unmapped',
): FlatRowStatus {
  if (status === 'unmapped') return 'needs_review'
  return status
}
