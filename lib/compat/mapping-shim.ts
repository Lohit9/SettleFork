/**
 * Mapping redesign back-compatibility shim (Phase 2).
 *
 * =========================================================================
 * CONTRACT
 * =========================================================================
 * This module is a **pure** translation layer. It takes already-fetched
 * rows from the new mapping-redesign schema (migration 074):
 *
 *   - public.target_field_mappings       (TFM)
 *   - public.mapping_sources             (MS)
 *   - public.source_field_acknowledgments (SA)
 *
 * …and produces the `MappingsResult` shape that the legacy UI
 * (`MappingContent.tsx`, `TransformContent.tsx`, drawers, pickers)
 * already consumes. It performs NO database access. The caller is
 * responsible for executing every query and passing the fully-hydrated
 * rows in via `ShimInput`.
 *
 * The shim exists ONLY for the Phase 2 period — between the migration
 * landing (074) and the new mapping UI shipping (Phase 3). Once the new
 * UI consumes `target_field_mappings` / `mapping_sources` directly,
 * delete this module in the Phase 5 cleanup pass (spec §Cleanup items).
 *
 * =========================================================================
 * SHIMMED ID FORMAT
 * =========================================================================
 * The legacy UI keys rows by opaque `id` strings. Several conceptual
 * rows in the new model do not have a single natural UUID to return
 * (notably: contributor mapping_sources that must masquerade as their
 * own RichFieldMapping). We therefore produce composite IDs using
 * `SHIMMED_ID_SEPARATOR`:
 *
 *   <tfmId>                     → primary RichFieldMapping for TFM
 *   <tfmId>::<mappingSourceId>  → contributor RichFieldMapping
 *   ack::target::<tfmId>        → FieldAcknowledgmentRow for target-side ack
 *   ack::source::<sourceAckId>  → FieldAcknowledgmentRow for source-side ack
 *
 * `decodeShimmedRowId(raw)` is the exhaustive inverse. Any server action
 * that receives an id from the UI MUST route through the decoder so that
 * write paths target the correct underlying row. The decoder logs a
 * warning and returns `{ kind: 'unknown' }` for unrecognised formats —
 * callers should treat that as a bug (never as a runtime fallback).
 *
 * =========================================================================
 * INVARIANTS
 * =========================================================================
 * The shim throws `ShimError` on ANY of the following — every case is a
 * data-integrity bug and must never be swallowed:
 *
 *   - CROSS_TABLE:  a TFM has sources spanning multiple source tables,
 *                   OR a TFM's source table does not match any existing
 *                   table_mapping.target_table_id pairing. The legacy
 *                   UI cannot render cross-table mappings; the new UI
 *                   handles them natively. Feature flag gates the old
 *                   UI off in projects that need this.
 *   - ORPHAN_TFM:   a TFM's target_field is in a target table that has
 *                   NO row in table_mappings at all. Orphaned TFMs
 *                   cannot be rendered by the legacy UI.
 *   - INVARIANT:    DB-level contradiction. E.g. a TFM row with BOTH
 *                   `is_acknowledged=true` AND `combination_type != NULL`,
 *                   or a VA TFM missing combination_sql. These are
 *                   blocked by check constraints in migration 074 —
 *                   the shim re-asserts defensively.
 *   - MISSING_FIELD: a TFM or mapping_source references a field_id
 *                   that was not in the caller-supplied fieldIndex.
 * =========================================================================
 */

import type {
  FieldAcknowledgmentRow,
  MappingsResult,
  RichFieldMapping,
  RichTableMapping,
  SimpleField,
  UnmappedField,
} from '@/lib/types/mappings-ui'
import type {
  MappingSourceRow,
  SourceFieldAcknowledgmentRow,
  TargetFieldMappingRow,
} from '@/lib/types/mapping-redesign'

// ─── Error type ───────────────────────────────────────────────────────────────

export type ShimErrorCode =
  | 'CROSS_TABLE'
  | 'ORPHAN_TFM'
  | 'INVARIANT'
  | 'MISSING_FIELD'

export class ShimError extends Error {
  readonly code: ShimErrorCode
  readonly context: Readonly<Record<string, unknown>>
  constructor(
    code: ShimErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ShimError'
    this.code = code
    this.context = context
  }
}

// ─── Shimmed id codec ─────────────────────────────────────────────────────────

export const SHIMMED_ID_SEPARATOR = '::'

export type DecodedShimmedRowId =
  | { kind: 'tfm-primary'; tfmId: string }
  | { kind: 'tfm-contributor'; tfmId: string; mappingSourceId: string }
  | { kind: 'target-ack'; tfmId: string }
  | { kind: 'source-ack'; sourceAckId: string }
  | { kind: 'unknown'; raw: string }

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Encode a contributor RichFieldMapping id. Exported for callers that
 * need to construct ids without allocating a full mapping row (e.g. the
 * `editFieldMapping` path that must reference a contributor by id).
 */
export function encodeContributorRowId(
  tfmId: string,
  mappingSourceId: string,
): string {
  return `${tfmId}${SHIMMED_ID_SEPARATOR}${mappingSourceId}`
}

export function encodeTargetAckRowId(tfmId: string): string {
  return `ack${SHIMMED_ID_SEPARATOR}target${SHIMMED_ID_SEPARATOR}${tfmId}`
}

export function encodeSourceAckRowId(sourceAckId: string): string {
  return `ack${SHIMMED_ID_SEPARATOR}source${SHIMMED_ID_SEPARATOR}${sourceAckId}`
}

/**
 * Exhaustive decoder for shimmed row ids. Recognises the four formats
 * documented in the module header. Logs a warning and returns
 * `{ kind: 'unknown' }` for anything else — callers MUST treat that as
 * a programming error, not a runtime fallback.
 */
export function decodeShimmedRowId(raw: string): DecodedShimmedRowId {
  if (typeof raw !== 'string' || raw.length === 0) {
    console.warn('[mapping-shim] decodeShimmedRowId: empty input')
    return { kind: 'unknown', raw }
  }

  const parts = raw.split(SHIMMED_ID_SEPARATOR)

  if (parts.length === 1) {
    if (UUID_REGEX.test(parts[0])) {
      return { kind: 'tfm-primary', tfmId: parts[0] }
    }
    console.warn('[mapping-shim] decodeShimmedRowId: non-UUID plain id', { raw })
    return { kind: 'unknown', raw }
  }

  if (parts.length === 2) {
    if (UUID_REGEX.test(parts[0]) && UUID_REGEX.test(parts[1])) {
      return {
        kind: 'tfm-contributor',
        tfmId: parts[0],
        mappingSourceId: parts[1],
      }
    }
    console.warn('[mapping-shim] decodeShimmedRowId: malformed contributor id', {
      raw,
    })
    return { kind: 'unknown', raw }
  }

  if (parts.length === 3 && parts[0] === 'ack') {
    if (parts[1] === 'target' && UUID_REGEX.test(parts[2])) {
      return { kind: 'target-ack', tfmId: parts[2] }
    }
    if (parts[1] === 'source' && UUID_REGEX.test(parts[2])) {
      return { kind: 'source-ack', sourceAckId: parts[2] }
    }
  }

  console.warn('[mapping-shim] decodeShimmedRowId: unrecognised format', { raw })
  return { kind: 'unknown', raw }
}

// ─── Input contract ───────────────────────────────────────────────────────────

/**
 * Minimal shape of a table_mappings row that the shim needs. We keep
 * this tight so callers can project only what the shim consumes.
 */
export interface ShimTableMappingRow {
  id: string
  project_id: string
  source_table_id: string
  target_table_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  created_at: string
}

export interface ShimFieldRow {
  id: string
  name: string
  data_type: string
  table_id: string
  inferred_type: string | null
  is_nullable?: boolean
  default_value?: string | null
}

export interface ShimTableRow {
  id: string
  name: string
  dataset_id: string
}

export interface ShimDatasetRow {
  id: string
  name: string
  role: string
}

export interface ShimTransformationRow {
  id: string
  target_field_mapping_id: string
  status: 'draft' | 'tested' | 'saved' | 'applied' | 'stale'
  description: string | null
  generated_sql: string | null
}

export interface ShimInput {
  projectId: string
  tableMappings: ShimTableMappingRow[]
  targetFieldMappings: TargetFieldMappingRow[]
  mappingSources: MappingSourceRow[]
  sourceAcks: SourceFieldAcknowledgmentRow[]
  /** All fields in the project, keyed by id. Used for both TFM target
   *  resolution and source lookups inside mapping_sources rows. */
  fieldsById: Record<string, ShimFieldRow>
  /** All tables in the project, keyed by id. */
  tablesById: Record<string, ShimTableRow>
  /** All datasets in the project, keyed by id. */
  datasetsById: Record<string, ShimDatasetRow>
  /** field_id → first N sample values, already stringified. */
  fieldSamples: Record<string, string[]>
  /** field_id → null percentage (0..100). Unknown fields default to 0. */
  fieldNullPercentages: Record<string, number>
  /** Transformations in the project. The shim will build a
   *  target_field_mapping_id → transformation map internally. */
  transformations: ShimTransformationRow[]
  /** Pre-computed: fields with NO mapping_sources row (project-wide). */
  unmappedSourceFields: UnmappedField[]
  /** Pre-computed: target fields with NO target_field_mappings row. */
  unmappedTargetFields: UnmappedField[]
  /** Pre-computed: grouped view of every field by table_id. */
  allFieldsByTable: Record<string, SimpleField[]>
  /** Pre-computed: all source tables for pickers. */
  allSourceTables: { id: string; name: string; datasetName: string }[]
  /** Pre-computed: all target tables for pickers. */
  allTargetTables: { id: string; name: string; datasetName: string }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertField(
  fieldsById: Record<string, ShimFieldRow>,
  fieldId: string,
  context: Record<string, unknown>,
): ShimFieldRow {
  const row = fieldsById[fieldId]
  if (!row) {
    throw new ShimError(
      'MISSING_FIELD',
      `Field ${fieldId} not present in fieldsById`,
      { fieldId, ...context },
    )
  }
  return row
}

function toPublicField(row: ShimFieldRow): RichFieldMapping['sourceField'] {
  return {
    id: row.id,
    name: row.name,
    data_type: row.data_type,
    inferred_type: row.inferred_type,
  }
}

function toSimilarFields(raw: unknown): string[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string')
  }
  return null
}

// ─── Main translator ──────────────────────────────────────────────────────────

/**
 * Build a legacy `MappingsResult` from the new-model row bundle. Pure
 * function; throws `ShimError` on any invariant violation. Callers
 * should treat a thrown ShimError as a 500-equivalent — there is no
 * sensible partial render.
 */
export function shimToMappingsResult(input: ShimInput): MappingsResult {
  const {
    tableMappings,
    targetFieldMappings,
    mappingSources,
    sourceAcks,
    fieldsById,
    tablesById,
    datasetsById,
    fieldSamples,
    fieldNullPercentages,
    transformations,
    unmappedSourceFields,
    unmappedTargetFields,
    allFieldsByTable,
    allSourceTables,
    allTargetTables,
  } = input

  // 1. Build fast indexes.
  const tmsByTargetTable = new Map<string, ShimTableMappingRow[]>()
  for (const tm of tableMappings) {
    const list = tmsByTargetTable.get(tm.target_table_id) ?? []
    list.push(tm)
    tmsByTargetTable.set(tm.target_table_id, list)
  }

  const sourcesByTfm = new Map<string, MappingSourceRow[]>()
  for (const ms of mappingSources) {
    const list = sourcesByTfm.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    sourcesByTfm.set(ms.target_field_mapping_id, list)
  }
  // Deterministic ordering: primary (ordinal=0) first, then ordinal ASC.
  for (const list of sourcesByTfm.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal)
  }

  const transformByTfm = new Map<string, ShimTransformationRow>()
  for (const t of transformations) {
    transformByTfm.set(t.target_field_mapping_id, t)
  }

  // 2. Prepare output shell for each table_mapping.
  const fieldMappingsByTm = new Map<string, RichFieldMapping[]>()
  for (const tm of tableMappings) fieldMappingsByTm.set(tm.id, [])

  // 3. Walk every TFM and emit RichFieldMapping(s) under the correct TM(s).
  for (const tfm of targetFieldMappings) {
    translateTfm({
      tfm,
      sourcesByTfm,
      tmsByTargetTable,
      fieldsById,
      fieldSamples,
      fieldNullPercentages,
      transformByTfm,
      fieldMappingsByTm,
    })
  }

  // 4. Build RichTableMapping[].
  const richTableMappings: RichTableMapping[] = tableMappings.map((tm) => {
    const sourceTable = tablesById[tm.source_table_id]
    const targetTable = tablesById[tm.target_table_id]
    const sourceDataset = sourceTable ? datasetsById[sourceTable.dataset_id] : undefined
    const targetDataset = targetTable ? datasetsById[targetTable.dataset_id] : undefined

    return {
      id: tm.id,
      project_id: tm.project_id,
      source_table_id: tm.source_table_id,
      target_table_id: tm.target_table_id,
      confidence: tm.confidence,
      status: tm.status,
      ai_reasoning: tm.ai_reasoning,
      created_at: tm.created_at,
      sourceTable: sourceTable && sourceDataset
        ? {
            id: sourceTable.id,
            name: sourceTable.name,
            dataset: {
              id: sourceDataset.id,
              name: sourceDataset.name,
              role: sourceDataset.role,
            },
          }
        : null,
      targetTable: targetTable && targetDataset
        ? {
            id: targetTable.id,
            name: targetTable.name,
            dataset: {
              id: targetDataset.id,
              name: targetDataset.name,
              role: targetDataset.role,
            },
          }
        : null,
      fieldMappings: sortFieldMappings(fieldMappingsByTm.get(tm.id) ?? [], fieldsById),
    }
  })

  // 5. Translate acknowledgments.
  const acknowledgments: FieldAcknowledgmentRow[] = []

  // 5a. Target-side acks = TFM rows with is_acknowledged=true (and no sources).
  for (const tfm of targetFieldMappings) {
    if (!tfm.is_acknowledged) continue
    if (tfm.combination_type != null) {
      // DB check constraint 074 forbids this; defensive assertion.
      throw new ShimError(
        'INVARIANT',
        'TFM is_acknowledged=true with non-null combination_type',
        { tfmId: tfm.id, combination_type: tfm.combination_type },
      )
    }
    acknowledgments.push({
      id: encodeTargetAckRowId(tfm.id),
      project_id: tfm.project_id,
      field_id: tfm.target_field_id,
      side: 'target',
      reason: tfm.acknowledgment_reason ?? 'acknowledged',
      notes: null,
      acknowledged_at: tfm.updated_at,
    })
  }

  // 5b. Source-side acks.
  for (const sa of sourceAcks) {
    acknowledgments.push({
      id: encodeSourceAckRowId(sa.id),
      project_id: sa.project_id,
      field_id: sa.source_field_id,
      side: 'source',
      reason: sa.reason,
      notes: sa.notes,
      acknowledged_at: sa.acknowledged_at,
    })
  }

  return {
    tableMappings: richTableMappings,
    unmappedSourceFields,
    unmappedTargetFields,
    allSourceTables,
    allTargetTables,
    allFieldsByTable,
    acknowledgments,
  }
}

// ─── Per-TFM translation ─────────────────────────────────────────────────────

interface TranslateTfmArgs {
  tfm: TargetFieldMappingRow
  sourcesByTfm: Map<string, MappingSourceRow[]>
  tmsByTargetTable: Map<string, ShimTableMappingRow[]>
  fieldsById: Record<string, ShimFieldRow>
  fieldSamples: Record<string, string[]>
  fieldNullPercentages: Record<string, number>
  transformByTfm: Map<string, ShimTransformationRow>
  fieldMappingsByTm: Map<string, RichFieldMapping[]>
}

function translateTfm(args: TranslateTfmArgs): void {
  const {
    tfm,
    sourcesByTfm,
    tmsByTargetTable,
    fieldsById,
    fieldSamples,
    fieldNullPercentages,
    transformByTfm,
    fieldMappingsByTm,
  } = args

  // Acknowledgment-only TFM — emitted as FieldAcknowledgmentRow elsewhere.
  if (tfm.is_acknowledged) {
    if (tfm.combination_type != null) {
      throw new ShimError(
        'INVARIANT',
        'TFM is_acknowledged=true with non-null combination_type',
        { tfmId: tfm.id, combination_type: tfm.combination_type },
      )
    }
    return
  }

  // Non-acknowledged TFM MUST have a combination_type (migration 074 ckc_tfm_shape).
  if (tfm.combination_type == null) {
    throw new ShimError(
      'INVARIANT',
      'Non-acknowledged TFM missing combination_type',
      { tfmId: tfm.id },
    )
  }

  const targetField = assertField(fieldsById, tfm.target_field_id, {
    tfmId: tfm.id,
    role: 'target_field',
  })
  const targetTable = tmsByTargetTable.get(targetField.table_id)

  const sources = sourcesByTfm.get(tfm.id) ?? []
  const transform = transformByTfm.get(tfm.id) ?? null
  const transformationShape = transform
    ? {
        id: transform.id,
        status: transform.status,
        description: transform.description,
        generated_sql: transform.generated_sql,
      }
    : null

  // ── Value assignment (custom_sql) ─────────────────────────────────────────
  // Per Design Call A: emit synthesized VA under EVERY table_mapping whose
  // target table matches. This matches the legacy UI expectation that a VA
  // appears in every TM feeding the same target table.
  if (tfm.combination_type === 'custom_sql') {
    // INTENTIONAL LIFECYCLE STATE — not data corruption.
    //
    // A value-assignment TFM is created by `createValueAssignment` with
    // `combination_sql = NULL`. The user then authors the SQL via the
    // Transform tab, which writes `transformations.generated_sql` — the
    // canonical source of truth for VA SQL. Migration 074 STEP 7 back-
    // filled `combination_sql` on PRE-EXISTING VAs from that column so
    // the shim could render them without a join, but it is NOT a hard
    // invariant going forward. The legacy UI reads `transformation.id /
    // .status / .generated_sql` off the RichFieldMapping's `transformation`
    // field (populated via `transformByTfm`), so an empty
    // `combination_sql` has no observable effect.
    //
    // Do NOT throw here. A `ShimError('INVARIANT')` would fire on every
    // freshly-created VA before the user opens the Transform tab.
    if (!targetTable || targetTable.length === 0) {
      throw new ShimError(
        'ORPHAN_TFM',
        'VA TFM target_field is in a table with no table_mappings',
        { tfmId: tfm.id, targetTableId: targetField.table_id },
      )
    }

    for (const tm of targetTable) {
      const list = fieldMappingsByTm.get(tm.id)
      if (!list) continue
      list.push(buildValueAssignmentRow({
        tfm,
        tm,
        targetField,
        fieldSamples,
        transformation: transformationShape,
      }))
    }
    return
  }

  // ── Mapped TFM (single / concat_*) ────────────────────────────────────────
  if (sources.length === 0) {
    throw new ShimError(
      'INVARIANT',
      'Mapped TFM has zero mapping_sources',
      { tfmId: tfm.id, combination_type: tfm.combination_type },
    )
  }

  // All sources must share the same source_table_id for legacy-UI rendering.
  const sourceTableId = sources[0].source_table_id
  for (const s of sources) {
    if (s.source_table_id !== sourceTableId) {
      throw new ShimError(
        'CROSS_TABLE',
        'TFM sources span multiple source tables',
        {
          tfmId: tfm.id,
          sourceTableIds: [
            ...new Set(sources.map((x) => x.source_table_id)),
          ],
        },
      )
    }
    if (s.source_field_id == null || s.source_table_id == null) {
      throw new ShimError(
        'INVARIANT',
        'mapping_sources row has NULL source_field_id or source_table_id',
        { tfmId: tfm.id, msId: s.id },
      )
    }
  }

  if (!targetTable || targetTable.length === 0) {
    throw new ShimError(
      'ORPHAN_TFM',
      'TFM target_field is in a table with no table_mappings',
      { tfmId: tfm.id, targetTableId: targetField.table_id },
    )
  }

  // Pick the table_mapping pairing (sourceTableId → targetField.table_id).
  const matchingTm = targetTable.find((tm) => tm.source_table_id === sourceTableId)
  if (!matchingTm) {
    throw new ShimError(
      'CROSS_TABLE',
      'TFM source table has no matching table_mapping into its target table',
      {
        tfmId: tfm.id,
        sourceTableId,
        targetTableId: targetField.table_id,
      },
    )
  }

  const list = fieldMappingsByTm.get(matchingTm.id)
  if (!list) return // defensive; should be impossible since we seeded every TM

  for (const source of sources) {
    const sourceField = assertField(fieldsById, source.source_field_id!, {
      tfmId: tfm.id,
      msId: source.id,
      role: 'source_field',
    })
    const isPrimary = source.ordinal === 0
    list.push({
      id: isPrimary ? tfm.id : encodeContributorRowId(tfm.id, source.id),
      table_mapping_id: matchingTm.id,
      source_field_id: sourceField.id,
      target_field_id: targetField.id,
      confidence: isPrimary ? tfm.confidence : source.confidence,
      status: tfm.status,
      ai_reasoning: isPrimary ? tfm.ai_reasoning : source.ai_reasoning,
      similar_fields_considered: toSimilarFields(source.similar_fields_considered),
      type_compatibility: source.type_compatibility,
      is_contributing: !isPrimary,
      created_at: isPrimary ? tfm.created_at : source.created_at,
      sourceField: toPublicField(sourceField),
      targetField: toPublicField(targetField),
      sourceFieldSamples: fieldSamples[sourceField.id] ?? [],
      targetFieldSamples: fieldSamples[targetField.id] ?? [],
      sourceFieldNullPercentage: fieldNullPercentages[sourceField.id] ?? 0,
      transformation: isPrimary ? transformationShape : null,
    })
  }
}

interface BuildVaArgs {
  tfm: TargetFieldMappingRow
  tm: ShimTableMappingRow
  targetField: ShimFieldRow
  fieldSamples: Record<string, string[]>
  transformation: RichFieldMapping['transformation']
}

function buildValueAssignmentRow(args: BuildVaArgs): RichFieldMapping {
  const { tfm, tm, targetField, fieldSamples, transformation } = args
  return {
    id: tfm.id,
    table_mapping_id: tm.id,
    source_field_id: null,
    target_field_id: targetField.id,
    confidence: tfm.confidence,
    status: tfm.status,
    ai_reasoning: tfm.ai_reasoning,
    similar_fields_considered: null,
    type_compatibility: null,
    is_contributing: false,
    created_at: tfm.created_at,
    sourceField: null,
    targetField: toPublicField(targetField),
    sourceFieldSamples: [],
    targetFieldSamples: fieldSamples[targetField.id] ?? [],
    sourceFieldNullPercentage: 0,
    transformation,
  }
}

/**
 * Deterministic ordering inside a single RichTableMapping.fieldMappings list:
 *   1. target field name ASC (so UI rows line up with target schema order
 *      when sorted alphabetically — matches legacy behaviour)
 *   2. same target: primary (is_contributing=false) before contributors
 *   3. source-null (VAs) last within a tie
 *   4. finally: created_at ASC for stability
 */
function sortFieldMappings(
  rows: RichFieldMapping[],
  _fieldsById: Record<string, ShimFieldRow>,
): RichFieldMapping[] {
  return [...rows].sort((a, b) => {
    const aName = a.targetField?.name ?? ''
    const bName = b.targetField?.name ?? ''
    if (aName !== bName) return aName < bName ? -1 : 1

    // Same target. Primary before contributor.
    if (a.is_contributing !== b.is_contributing) {
      return a.is_contributing ? 1 : -1
    }

    // Source-null (VA) last.
    const aNull = a.source_field_id == null
    const bNull = b.source_field_id == null
    if (aNull !== bNull) return aNull ? 1 : -1

    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
  })
}
