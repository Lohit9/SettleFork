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
 *   • mapped TFM (1+ sources)  → 1 flat row (kind: 'mapped')
 *                                 sources[] carries every contributor;
 *                                 the renderer shows a compact
 *                                 "N× Multiple sources" treatment when
 *                                 sources.length > 1.
 *   • value assignment         → 1 flat row, source cells blank
 *                                 (kind: 'value-assignment')
 *   • unmapped target          → 1 flat row, source cells blank
 *                                 (kind: 'unmapped-target')
 *   • source-side ack          → 1 flat row, target cells blank
 *                                 (kind: 'unmapped-source')
 *   • source-only unmapped     → 1 flat row, target cells blank;
 *                                 emitted ONLY when
 *                                 showUnmappedSourceFields=true
 *
 * INF-57 (2026-05-10): acknowledged target fields are surfaced by the
 * server as `UnmappedRow` with status='approved'. The flat view treats
 * them like any other unmapped target row — the status field carries
 * the 'approved' value and the renderer draws the green Approved pill.
 *
 * Source-side acknowledgments live separately on
 * `result.sourceFieldAcknowledgments`. They ALWAYS appear in the flat
 * view (independent of showUnmappedSourceFields), because they
 * represent explicit user decisions worth surfacing.
 *
 * Prior to the second visual polish pass, multi-source TFMs split into
 * a parent + N child rows (Option C). The founder's reference shot
 * superseded that — multi-source now renders as one compact row with a
 * blue `N×` badge in the source-table cell + "N fields combined" in
 * the source-field cell. Per-contributor edits / rejects route through
 * the drawer.
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
   * All contributing source attributions, in `ordinal` order (server-
   * emitted). Always non-empty for 'mapped' rows. The renderer shows a
   * compact "N× Multiple sources" badge when length > 1.
   */
  sources: MappingSourceRef[]
  /** TFM aggregate confidence (MIN across sources, server-derived). */
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

export interface FlattenOptions {
  /**
   * When true, source fields that are NOT referenced by any mapping
   * AND have no acknowledgment row are emitted as `unmapped-source`
   * rows with status='needs_review'. When false (default), only
   * source-side acknowledgments surface on the source-only side.
   */
  showUnmappedSourceFields: boolean
}

export const DEFAULT_FLATTEN_OPTIONS: FlattenOptions = {
  showUnmappedSourceFields: false,
}

export function flattenRowsForListView(
  result: MappingsForRedesignResult,
  options: FlattenOptions = DEFAULT_FLATTEN_OPTIONS,
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
      out.push({
        kind: 'mapped',
        id: row.id,
        groupId: row.id,
        status,
        targetField: row.targetField,
        sources: row.sources,
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
  // Migration 103 (A's PR #132): the ack carries a `decision` field
  // which determines the rendered status:
  //   decision='acknowledged' → 'approved' (green dot, modal-path
  //     explicit accept that the field will not be migrated)
  //   decision='rejected'    → 'rejected' (gray dot, flat-view inline
  //     reject affordance — explicit user decision against migration)
  // Both decisions are addressable: the row stays visible because it
  // represents a deliberate user choice worth surfacing in audit.
  const ackedSourceFieldIds = new Set<string>()
  for (const ack of result.sourceFieldAcknowledgments) {
    const sf = sourceFieldById.get(ack.sourceFieldId)
    if (!sf) continue
    if (sourceFieldIdsReferenced.has(sf.id)) continue
    ackedSourceFieldIds.add(sf.id)
    const ackStatus: FlatRowStatus =
      ack.decision === 'rejected' ? 'rejected' : 'approved'
    out.push({
      kind: 'unmapped-source',
      id: `ack::source::${ack.id}`,
      groupId: `ack::source::${ack.id}`,
      status: ackStatus,
      sourceField: sf,
      acknowledgmentId: ack.id,
      acknowledgmentReason: ack.reason,
    })
  }

  // Pure source-only unmapped — gated by toggle to avoid drowning the
  // grid with one row per unmapped source field on schemas with hundreds
  // of unaddressed source fields.
  if (options.showUnmappedSourceFields) {
    for (const sf of result.sourceFields) {
      if (sourceFieldIdsReferenced.has(sf.id)) continue
      if (ackedSourceFieldIds.has(sf.id)) continue
      out.push({
        kind: 'unmapped-source',
        id: `unmapped-source::${sf.id}`,
        groupId: `unmapped-source::${sf.id}`,
        status: 'needs_review',
        sourceField: sf,
        acknowledgmentId: null,
        acknowledgmentReason: null,
      })
    }
  }

  return out
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
