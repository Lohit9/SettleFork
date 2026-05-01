/**
 * Mapping engine — pure logic for transforming raw mapping data into
 * the redesign UI's view model. No 'use server' directive: this file
 * exports sync helpers and types alongside async functions.
 *
 * Server actions in lib/actions/mappings.ts and lib/actions/mappings-for-redesign.ts
 * call into this module. UI code MUST NOT import this file directly —
 * see tests/lib/no-engine-in-redesign-ui.test.ts for the enforcement.
 *
 * File convention: pure things first, side-effecting things last.
 *   1. Types
 *   2. Pure helpers (un-exported)
 *   3. Pure exported entry points (`assembleMappingsForRedesign`, …)
 *   4. DB-touching orchestrators (`getMappingsForRedesignCore`, future
 *      `runMappingGeneration`, `runMappingSuggestion`, …)
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import type {
  JoinSpec,
  MappedRow,
  MappingCounts,
  MappingRow,
  MappingSourceRef,
  MappingTransformationStatus,
  MappingsForRedesignResult,
  SourceFieldAcknowledgmentSummary,
  SourceFieldWithState,
  SourceTableSummary,
  TargetAcknowledgedRow,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import { inferFkCandidates } from '@/lib/utils/fk-inference'

// ─── Raw row shapes fetched from Supabase ────────────────────────────
//
// Kept local to this module. They're a strict subset of the public
// `lib/types/mapping-redesign.ts` row shapes — just enough columns to
// assemble the redesign contract. Narrow upfront so downstream code
// has full type safety without `as any` escape hatches.

interface RawDatasetRow {
  id: string
  role: 'source' | 'target' | string
  name: string
}

interface RawTableRow {
  id: string
  dataset_id: string
  name: string
}

interface RawFieldRow {
  id: string
  table_id: string
  name: string
  data_type: string
  is_nullable: boolean | null
  is_primary_key: boolean | null
  is_foreign_key: boolean | null
  fk_reference: string | null
  default_value: string | null
  ordinal_position: number
  field_profiles?: Array<{
    field_id: string
    sample_values: unknown
  }> | null
}

interface RawTfmRow {
  id: string
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected' | string
  ai_reasoning: string | null
  is_acknowledged: boolean
  acknowledgment_reason: string | null
  combination_type: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql' | null | string
  combination_sql: string | null
}

interface RawMappingSourceRow {
  id: string
  target_field_mapping_id: string
  source_field_id: string | null
  source_table_id: string | null
  confidence: number | null
  ai_reasoning: string | null
  type_compatibility: string | null
  join_spec: unknown | null
  ordinal: number
}

interface RawSourceAckRow {
  id: string
  source_field_id: string
  reason: string
}

interface RawTransformationRow {
  id: string
  target_field_mapping_id: string
  status: string | null
  // Q11.E lock (drawer redesign, 2026-04-26): added to power the
  // drawer-redesign Transformation section. `description` is the
  // human-authored intent line; `generated_sql` is the full SQL,
  // truncated server-side (`MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH`)
  // before being placed on `MappingRowBase.transformationSqlPreview`.
  description: string | null
  generated_sql: string | null
}

/**
 * Server-side cap for `MappingRowBase.transformationSqlPreview`.
 * Mirrors the legacy mapping page preview length (see
 * `app/app/projects/[projectId]/mapping/MappingContent.tsx` Transform
 * tab preview block). Values longer than the cap are truncated and a
 * single `…` appended so the wire payload stays bounded.
 *
 * The standalone Transform page is the canonical surface for the full
 * SQL — the drawer is a glance-only consumer.
 */
const MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH = 300

/**
 * The raw inputs to `assembleMappingsForRedesign`. Exported so unit
 * tests can construct fixtures with full type checking.
 */
export interface AssembleInput {
  projectId: string
  datasets: RawDatasetRow[]
  tables: RawTableRow[]
  fields: RawFieldRow[]
  tfms: RawTfmRow[]
  mappingSources: RawMappingSourceRow[]
  sourceAcks: RawSourceAckRow[]
  transformations: RawTransformationRow[]
}

// Also export the raw row types so tests and future call sites can
// import them without duplicating the shapes.
export type {
  RawDatasetRow,
  RawTableRow,
  RawFieldRow,
  RawTfmRow,
  RawMappingSourceRow,
  RawSourceAckRow,
  RawTransformationRow,
}

// ─── Row builders ────────────────────────────────────────────────────

function buildTargetFieldRef(
  field: RawFieldRow,
  tablesById: Map<string, RawTableRow>,
): TargetFieldRef | null {
  const table = tablesById.get(field.table_id)
  if (!table) return null
  return {
    id: field.id,
    name: field.name,
    dataType: field.data_type,
    // `fields.is_nullable` is nullable in the DB (legacy rows may be NULL).
    // Conservative default: treat missing as NULL-able (`true`) — matches
    // PostgreSQL's own default for unconstrained columns.
    isNullable: field.is_nullable === null ? true : field.is_nullable,
    defaultValue: field.default_value,
    targetTable: { id: table.id, name: table.name },
    ordinalPosition: field.ordinal_position,
  }
}

function buildUnmappedRow(targetField: TargetFieldRef): UnmappedRow {
  return {
    kind: 'unmapped',
    id: `unmapped::${targetField.id}`,
    targetField,
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
  }
}

function buildTargetAcknowledgedRow(
  tfm: RawTfmRow,
  targetField: TargetFieldRef,
): TargetAcknowledgedRow {
  return {
    kind: 'target_acknowledged',
    id: tfm.id,
    targetField,
    confidence: null,
    // Migration 074 STEP 3c writes 'approved' for all ack rows; narrow
    // here even if the row happens to carry another value (no recovery
    // path — the UI treats all acks as approved).
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    acknowledgmentReason: tfm.acknowledgment_reason,
  }
}

function buildValueAssignmentRow(
  tfm: RawTfmRow,
  targetField: TargetFieldRef,
  transformation: RawTransformationRow | null,
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: tfm.id,
    targetField,
    confidence: tfm.confidence,
    status: coerceStatus(tfm.status),
    hasTransformation: transformation !== null,
    transformationStatus: coerceTransformationStatus(
      transformation?.status ?? null,
      transformation !== null,
    ),
    transformationDescription: transformation?.description ?? null,
    transformationSqlPreview: buildTransformationSqlPreview(
      transformation?.generated_sql ?? null,
    ),
    combinationType: 'custom_sql',
    combinationSql: tfm.combination_sql,
    aiReasoning: tfm.ai_reasoning,
  }
}

function buildMappedRow(
  tfm: RawTfmRow,
  targetField: TargetFieldRef,
  tfmSources: RawMappingSourceRow[],
  transformation: RawTransformationRow | null,
  tablesById: Map<string, RawTableRow>,
  fieldsById: Map<string, RawFieldRow>,
  fieldsByTableId: Map<string, RawFieldRow[]>,
): MappedRow {
  // Filter out defensively-null sources — a live mapping_source with
  // no source_field_id cannot be rendered.
  const validSources = tfmSources.filter(
    (s) => s.source_field_id !== null && s.source_table_id !== null,
  )

  // Dominant (ordinal=0) source drives cross-table join-annotation.
  const dominantSource = validSources.find((s) => s.ordinal === 0) ?? validSources[0] ?? null
  const dominantTableId = dominantSource?.source_table_id ?? null

  const sources: MappingSourceRef[] = validSources
    .map((s) =>
      buildMappingSourceRef(
        s,
        dominantTableId,
        tablesById,
        fieldsById,
        fieldsByTableId,
      ),
    )
    .filter((s): s is MappingSourceRef => s !== null)

  return {
    kind: 'mapped',
    id: tfm.id,
    targetField,
    confidence: tfm.confidence,
    status: coerceStatus(tfm.status),
    hasTransformation: transformation !== null,
    transformationStatus: coerceTransformationStatus(
      transformation?.status ?? null,
      transformation !== null,
    ),
    transformationDescription: transformation?.description ?? null,
    transformationSqlPreview: buildTransformationSqlPreview(
      transformation?.generated_sql ?? null,
    ),
    sources,
    combinationType: coerceCombinationType(tfm.combination_type),
    // `combinationSql` is only meaningful for `custom_sql` multi-source
    // mapped rows. Null otherwise.
    combinationSql:
      tfm.combination_type === 'custom_sql' ? tfm.combination_sql : null,
    aiReasoning: tfm.ai_reasoning,
  }
}

function buildMappingSourceRef(
  ms: RawMappingSourceRow,
  dominantTableId: string | null,
  tablesById: Map<string, RawTableRow>,
  fieldsById: Map<string, RawFieldRow>,
  fieldsByTableId: Map<string, RawFieldRow[]>,
): MappingSourceRef | null {
  if (!ms.source_field_id || !ms.source_table_id) return null
  const sourceField = fieldsById.get(ms.source_field_id)
  const sourceTable = tablesById.get(ms.source_table_id)
  if (!sourceField || !sourceTable) return null

  // Cross-table join annotation: only emitted when this source's
  // table differs from the dominant (ordinal=0) source's table.
  const isCrossTable =
    dominantTableId !== null && dominantTableId !== ms.source_table_id

  const joinAnnotation = isCrossTable
    ? deriveJoinAnnotation(ms, dominantTableId, sourceTable.name, tablesById, fieldsByTableId)
    : null
  const joinSpec = isCrossTable ? coerceJoinSpec(ms.join_spec) : null

  const sampleValues = extractSampleValues(sourceField.field_profiles)

  return {
    id: ms.id,
    ordinal: ms.ordinal,
    confidence: ms.confidence,
    aiReasoning: ms.ai_reasoning,
    typeCompatibility: ms.type_compatibility,
    sourceField: {
      id: sourceField.id,
      name: sourceField.name,
      dataType: sourceField.data_type,
      isNullable: sourceField.is_nullable === null ? true : sourceField.is_nullable,
    },
    sourceTable: {
      id: sourceTable.id,
      name: sourceTable.name,
    },
    joinAnnotation,
    joinSpec,
    sampleValues,
  }
}

// ─── Derivation helpers ──────────────────────────────────────────────

/**
 * Derive the human-readable join annotation for a cross-table
 * mapping_source. Per design §3.2 `MappingSourceRef.joinAnnotation`:
 *
 *   1. Scan fields in the dominant source table for an FK pointing at
 *      this source's table. If exactly one match, use its name.
 *   2. Otherwise fall back to parsing the raw `join_spec.via_fk_field`
 *      — the AI-authored spec is authoritative when FK inference is
 *      ambiguous.
 *
 * Returns null when no annotation can be derived (ambiguous FK graph
 * + missing join_spec). The UI hides the annotation in that case.
 *
 * Phase 4a-3: the FK inference primitive lives in
 * `lib/utils/fk-inference.ts` so the write path can reuse it.
 */
function deriveJoinAnnotation(
  ms: RawMappingSourceRow,
  dominantTableId: string,
  joinedTableName: string,
  tablesById: Map<string, RawTableRow>,
  fieldsByTableId: Map<string, RawFieldRow[]>,
): string | null {
  const dominantFields = fieldsByTableId.get(dominantTableId) ?? []
  const fkCandidates = inferFkCandidates(
    dominantFields,
    ms.source_table_id!,
    joinedTableName,
    tablesById,
  )
  if (fkCandidates.length === 1) {
    return `(join: ${fkCandidates[0]})`
  }

  const spec = coerceJoinSpec(ms.join_spec)
  if (spec?.viaFkField) {
    return `(join: ${spec.viaFkField})`
  }

  return null
}

/**
 * Try to coerce a `mapping_sources.join_spec` JSONB value into the
 * `JoinSpec` contract. Returns null for any shape mismatch. The
 * stored JSONB is snake_case (verbatim AI output); we translate to
 * camelCase at the API boundary to match the rest of the contract.
 */
function coerceJoinSpec(raw: unknown): JoinSpec | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const viaSourceTable = asNonEmptyString(r.via_source_table)
  const viaFkField = asNonEmptyString(r.via_fk_field)
  const toFkField = asNonEmptyString(r.to_fk_field)
  if (!viaSourceTable || !viaFkField || !toFkField) return null
  return { viaSourceTable, viaFkField, toFkField }
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Max sample values we ship on the wire per source field.
 *
 * CONSUMER — drawer Source tab card (Gaps 7-10).
 * ────────────────────────────────────────────────────────────────────
 * Raised from 3 → 10 on 2026-04-24 to support deep per-source review
 * in the drawer. The main-page expanded view (chevron-toggled per-
 * source list) does NOT render these values — that path is optimized
 * for scanning, not for inspection. See
 * `docs/features/mapping-redesign.md` §Expanded view for the scoping
 * rationale and `MappingSourceRef.sampleValues` JSDoc for the
 * authoritative shape contract.
 *
 * History: a Gap 6 attempt inlined a 3-sample preview + "+N more"
 * affordance on the expanded-view bullet line. Smoke test revealed
 * the density overwhelmed the scanning use case, so the frontend
 * rendering was reverted. The 10-value wire cap survives because the
 * drawer will consume this data.
 *
 * Trade-offs considered at 10:
 *   • Heritage production data has ≥4 values on 85/99 source fields
 *     (86%). Most have ~10. Raising beyond 10 would inflate payload
 *     without a matching UX benefit at current drawer fidelity.
 *   • 10 short string values per source × ~3 sources per row × ~100
 *     rows = negligible wire cost (<50 KB at worst-case 100-char
 *     values, typically <10 KB).
 */
const MAX_SAMPLE_VALUES = 10

function extractSampleValues(
  profiles: RawFieldRow['field_profiles'],
): string[] {
  if (!profiles || profiles.length === 0) return []
  const first = profiles[0]
  const raw = first?.sample_values
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_SAMPLE_VALUES)
    .map((v) => (typeof v === 'string' ? v : String(v)))
}

function coerceStatus(status: string): 'needs_review' | 'approved' | 'rejected' {
  if (status === 'needs_review' || status === 'approved' || status === 'rejected') {
    return status
  }
  // Defensive default: unknown DB status values treated as 'needs_review'.
  return 'needs_review'
}

function coerceCombinationType(
  v: RawTfmRow['combination_type'],
): 'single' | 'concat_space' | 'concat_comma' | 'custom_sql' {
  if (v === 'single' || v === 'concat_space' || v === 'concat_comma' || v === 'custom_sql') {
    return v
  }
  // A mapped row with NULL or unknown combination_type defaults to
  // 'single' — the most common case and a safe fallback that keeps
  // downstream Rule-selection logic working.
  return 'single'
}

function coerceTransformationStatus(
  status: string | null,
  hasTransformation: boolean,
): MappingTransformationStatus | null {
  if (!hasTransformation) return null
  if (
    status === 'draft' ||
    status === 'tested' ||
    status === 'saved' ||
    status === 'applied' ||
    status === 'stale'
  ) {
    return status
  }
  // Defensive default per §3.2 `MappingRowBase.transformationStatus`:
  // when a transformation row exists but carries a null/unknown status,
  // emit 'draft' (the initial lifecycle state).
  return 'draft'
}

/**
 * Server-truncate `transformations.generated_sql` to the wire cap so
 * the drawer-redesign Transformation section can render a glance-only
 * preview without paying the cost of the full SQL.
 *
 *   • null transformation row → null (no section rendered)
 *   • null/empty SQL          → null (translator emits null when there
 *                                     is nothing to preview, even if
 *                                     a transformation row exists in
 *                                     a degenerate state)
 *   • SQL ≤ cap               → verbatim SQL
 *   • SQL > cap               → first cap chars + `…`
 *
 * Q11.E lock (drawer redesign, 2026-04-26).
 */
function buildTransformationSqlPreview(
  sql: string | null | undefined,
): string | null {
  if (sql === null || sql === undefined) return null
  if (sql.length === 0) return null
  if (sql.length <= MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH) return sql
  return `${sql.slice(0, MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH)}…`
}

function countByKey<T>(items: T[], keyFn: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    const k = keyFn(it)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

function localeCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

/**
 * Canonical row ordering per design §9 Q7 resolution.
 *
 *   ORDER BY
 *     targetTable.name         ASC,
 *     targetField.ordinalPosition ASC,
 *     targetField.name         ASC
 *
 * Keep this sort stable across re-renders: the client relies on
 * server-guaranteed ordering per the `MappingsForRedesignResult.rows`
 * JSDoc. Any change here must update the design doc first.
 */
function compareRows(a: MappingRow, b: MappingRow): number {
  const byTable = localeCompare(a.targetField.targetTable.name, b.targetField.targetTable.name)
  if (byTable !== 0) return byTable
  const byOrdinal = a.targetField.ordinalPosition - b.targetField.ordinalPosition
  if (byOrdinal !== 0) return byOrdinal
  return localeCompare(a.targetField.name, b.targetField.name)
}

// ─── Source schema sidebar — Phase 3 Gap 11b ─────────────────────────

/**
 * Build the `sourceFields: SourceFieldWithState[]` payload consumed
 * by the source-schema sidebar.
 *
 * SEMANTICS — `mappingStatus`
 * ───────────────────────────
 * A source field is `'mapped'` iff its id appears in
 * `mapping_sources.source_field_id` for any TFM in this project whose
 * `status !== 'rejected'`. Otherwise `'unmapped'`.
 *
 * Excluding rejected TFMs is founder-locked (Gap 11b decision 2): a
 * rejected TFM does not "claim" its contributing sources as mapped.
 * Post-Gap-9, new rejects = deletes (the TFM disappears entirely);
 * the legacy SimpleLegal rejected row is the only production case
 * where `status='rejected'` rows still carry live `mapping_sources`.
 * Excluding here is defensive against that legacy row + any future
 * data that does not delete-on-reject.
 *
 * ORDERING
 * ────────
 * Server-emitted in canonical order:
 *   (sourceTable.name ASC, ordinalPosition ASC, name ASC)
 *
 * Mirrors `rows[]` ordering. The redesign-path sort guard prevents
 * any client-side re-sorting downstream.
 */
function buildSourceFieldsWithState(
  sourceFields: RawFieldRow[],
  tablesById: Map<string, RawTableRow>,
  tfms: RawTfmRow[],
  mappingSources: RawMappingSourceRow[],
  sourceAcks: RawSourceAckRow[],
): SourceFieldWithState[] {
  const tfmStatusById = new Map<string, string>(
    tfms.map((t) => [t.id, t.status]),
  )

  const mappedSourceFieldIds = new Set<string>()
  for (const ms of mappingSources) {
    if (ms.source_field_id === null) continue
    if (tfmStatusById.get(ms.target_field_mapping_id) === 'rejected') continue
    mappedSourceFieldIds.add(ms.source_field_id)
  }

  const acknowledgedSourceFieldIds = new Set<string>(
    sourceAcks.map((a) => a.source_field_id),
  )

  const out: SourceFieldWithState[] = []
  for (const field of sourceFields) {
    const table = tablesById.get(field.table_id)
    if (!table) continue
    out.push({
      id: field.id,
      name: field.name,
      dataType: field.data_type,
      ordinalPosition: field.ordinal_position,
      sourceTable: { id: table.id, name: table.name },
      mappingStatus: mappedSourceFieldIds.has(field.id) ? 'mapped' : 'unmapped',
      sampleValues: extractSampleValues(field.field_profiles),
      isAcknowledged: acknowledgedSourceFieldIds.has(field.id),
    })
  }

  out.sort(compareSourceFields)
  return out
}

function compareSourceFields(
  a: SourceFieldWithState,
  b: SourceFieldWithState,
): number {
  const byTable = localeCompare(a.sourceTable.name, b.sourceTable.name)
  if (byTable !== 0) return byTable
  const byOrdinal = a.ordinalPosition - b.ordinalPosition
  if (byOrdinal !== 0) return byOrdinal
  return localeCompare(a.name, b.name)
}

function computeCounts(rows: MappingRow[]): MappingCounts {
  let total = 0
  let approved = 0
  let needsReview = 0
  let rejected = 0
  let unmapped = 0
  for (const row of rows) {
    total++
    switch (row.status) {
      case 'approved':
        approved++
        break
      case 'needs_review':
        needsReview++
        break
      case 'rejected':
        rejected++
        break
      case 'unmapped':
        unmapped++
        break
    }
  }
  return { total, approved, needsReview, rejected, unmapped }
}

// ─── Pure assembly ───────────────────────────────────────────────────

/**
 * Pure, testable assembly step — no DB, no side effects. Consumes the
 * raw row arrays from Round 2-4 and emits the public contract.
 *
 * All design-contract invariants live here:
 *   • row kind discrimination (mapped / VA / acknowledged / unmapped)
 *   • canonical row ordering (see §9 Q7 resolution)
 *   • server-side `MappingCounts` rollup
 *   • join-annotation derivation (FK inference + JSONB fallback)
 *   • defensive coercion of nullable DB columns
 *
 * Do not add new invariants here without updating the design doc §3/§5
 * — this function IS the contract implementation.
 */
export function assembleMappingsForRedesign(
  input: AssembleInput,
): MappingsForRedesignResult {
  const {
    projectId,
    datasets,
    tables,
    fields,
    tfms,
    mappingSources,
    sourceAcks,
    transformations,
  } = input

  // ── Build dataset / table / field indexes ──────────────────────────
  const datasetsById = new Map(datasets.map((d) => [d.id, d]))
  const tablesById = new Map(tables.map((t) => [t.id, t]))
  const fieldsById = new Map(fields.map((f) => [f.id, f]))

  const sourceDatasetIds = new Set(
    datasets.filter((d) => d.role === 'source').map((d) => d.id),
  )
  const targetDatasetIds = new Set(
    datasets.filter((d) => d.role === 'target').map((d) => d.id),
  )

  const sourceTables = tables.filter((t) => sourceDatasetIds.has(t.dataset_id))
  const targetTables = tables.filter((t) => targetDatasetIds.has(t.dataset_id))

  const sourceTableIds = new Set(sourceTables.map((t) => t.id))
  const targetTableIds = new Set(targetTables.map((t) => t.id))

  const sourceFields = fields.filter((f) => sourceTableIds.has(f.table_id))
  const targetFields = fields.filter((f) => targetTableIds.has(f.table_id))

  // Field-count indexes for TableSummary rollups.
  const sourceFieldCountByTable = countByKey(sourceFields, (f) => f.table_id)
  const targetFieldCountByTable = countByKey(targetFields, (f) => f.table_id)

  // Fields grouped by table — needed for FK-inference during joinAnnotation.
  const fieldsByTableId = new Map<string, RawFieldRow[]>()
  for (const f of fields) {
    const arr = fieldsByTableId.get(f.table_id) ?? []
    arr.push(f)
    fieldsByTableId.set(f.table_id, arr)
  }

  // ── Build mapping_sources and transformations by TFM ──────────────
  const mappingSourcesByTfm = new Map<string, RawMappingSourceRow[]>()
  for (const ms of mappingSources) {
    const arr = mappingSourcesByTfm.get(ms.target_field_mapping_id) ?? []
    arr.push(ms)
    mappingSourcesByTfm.set(ms.target_field_mapping_id, arr)
  }
  for (const [k, arr] of mappingSourcesByTfm) {
    arr.sort((a, b) => a.ordinal - b.ordinal)
    mappingSourcesByTfm.set(k, arr)
  }

  const transformationByTfm = new Map<string, RawTransformationRow>()
  for (const tr of transformations) {
    // Invariant: COUNT(transformations) per tfm ≤ 1 (see lib/types/mapping-redesign.ts).
    // If the DB contains a duplicate, the second entry wins here — consistent
    // with the legacy getMappings behaviour (upsert semantics).
    transformationByTfm.set(tr.target_field_mapping_id, tr)
  }

  // ── Build TFMs by target_field_id for row assembly ────────────────
  const tfmByTargetFieldId = new Map<string, RawTfmRow>()
  for (const t of tfms) {
    tfmByTargetFieldId.set(t.target_field_id, t)
  }

  // ── Assemble rows ─────────────────────────────────────────────────
  const rows: MappingRow[] = []

  for (const targetField of targetFields) {
    const targetFieldRef = buildTargetFieldRef(targetField, tablesById)
    if (!targetFieldRef) continue // Parent target table missing (shouldn't happen under normal ingestion).

    const tfm = tfmByTargetFieldId.get(targetField.id)
    if (!tfm) {
      rows.push(buildUnmappedRow(targetFieldRef))
      continue
    }

    const tfmSources = mappingSourcesByTfm.get(tfm.id) ?? []
    const transformation = transformationByTfm.get(tfm.id) ?? null

    // Discriminator logic per design §3.1 Call A:
    //   is_acknowledged === true              → 'target_acknowledged'
    //   combination_type === 'custom_sql' with zero sources → 'value_assignment'
    //   otherwise (has ≥ 1 source)            → 'mapped'
    if (tfm.is_acknowledged) {
      rows.push(buildTargetAcknowledgedRow(tfm, targetFieldRef))
      continue
    }

    if (tfm.combination_type === 'custom_sql' && tfmSources.length === 0) {
      rows.push(buildValueAssignmentRow(tfm, targetFieldRef, transformation))
      continue
    }

    // Mapped row. Require at least one source — a TFM with
    // combination_type != 'custom_sql' and zero sources is
    // semantically invalid; surface it as unmapped to avoid emitting
    // a MappedRow with an empty `sources` array that would violate
    // the Rules 1-4 selector.
    if (tfmSources.length === 0) {
      rows.push(buildUnmappedRow(targetFieldRef))
      continue
    }

    rows.push(
      buildMappedRow(
        tfm,
        targetFieldRef,
        tfmSources,
        transformation,
        tablesById,
        fieldsById,
        fieldsByTableId,
      ),
    )
  }

  // ── Canonical ordering (§9 Q7) ────────────────────────────────────
  rows.sort(compareRows)

  // ── Filter universes ──────────────────────────────────────────────
  const targetTableSummaries: TargetTableSummary[] = targetTables
    .map((t) => {
      const dataset = datasetsById.get(t.dataset_id)
      return {
        id: t.id,
        name: t.name,
        datasetName: dataset?.name ?? '',
        fieldCount: targetFieldCountByTable.get(t.id) ?? 0,
      }
    })
    .sort((a, b) => localeCompare(a.name, b.name))

  const sourceTableSummaries: SourceTableSummary[] = sourceTables
    .map((t) => {
      const dataset = datasetsById.get(t.dataset_id)
      return {
        id: t.id,
        name: t.name,
        datasetName: dataset?.name ?? '',
        fieldCount: sourceFieldCountByTable.get(t.id) ?? 0,
      }
    })
    .sort((a, b) => localeCompare(a.name, b.name))

  const sourceFieldAcknowledgments: SourceFieldAcknowledgmentSummary[] =
    sourceAcks.map((a) => ({
      id: a.id,
      sourceFieldId: a.source_field_id,
      reason: a.reason,
    }))

  // ── Source schema sidebar (Phase 3 Gap 11b) ──────────────────────
  const sourceFieldsWithState = buildSourceFieldsWithState(
    sourceFields,
    tablesById,
    tfms,
    mappingSources,
    sourceAcks,
  )

  // ── Project-level counters ────────────────────────────────────────
  const counts: MappingCounts = computeCounts(rows)

  return {
    projectId,
    rows,
    targetTables: targetTableSummaries,
    sourceTables: sourceTableSummaries,
    sourceFieldAcknowledgments,
    sourceFields: sourceFieldsWithState,
    counts,
    targetSchemaEmpty: targetTables.length === 0 || targetFields.length === 0,
  }
}

// ─── Full 4-round fetch + assembly ───────────────────────────────────

/**
 * Full Mapping-page read path for the Phase 3 redesign UI.
 *
 * Returns `null` on any failure to access the project (unauthenticated
 * via RLS, project missing, or project ID malformed) — callers fall
 * back to `notFound()`. All other errors propagate as thrown exceptions
 * the wrapping server action surfaces to the user.
 *
 * Uses the supplied Supabase client — typically a user-scoped
 * `createClient()` from `lib/supabase/server.ts` so RLS gates the read.
 * The integration test can pass `supabaseAdmin` to bypass RLS (it
 * filters by `projectId` explicitly, so the bypass is scope-safe).
 */
export async function getMappingsForRedesignCore(
  supabase: SupabaseClient,
  projectId: string,
): Promise<MappingsForRedesignResult | null> {
  // ── Round 1 — access gate ─────────────────────────────────────────
  const { data: projectRow } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle()
  if (!projectRow) return null

  // ── Round 2 — project-scoped parallel fetch ───────────────────────
  const [
    { data: datasetsRaw },
    { data: tfmsRaw },
    { data: sourceAcksRaw },
  ] = await Promise.all([
    supabase
      .from('datasets')
      .select('id, role, name')
      .eq('project_id', projectId),
    supabase
      .from('target_field_mappings')
      .select('id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql')
      .eq('project_id', projectId),
    supabase
      .from('source_field_acknowledgments')
      .select('id, source_field_id, reason')
      .eq('project_id', projectId),
  ])

  const datasets = (datasetsRaw ?? []) as RawDatasetRow[]
  const tfms = (tfmsRaw ?? []) as RawTfmRow[]
  const sourceAcks = (sourceAcksRaw ?? []) as RawSourceAckRow[]

  const datasetIds = datasets.map((d) => d.id)
  const tfmIds = tfms.map((t) => t.id)

  // ── Round 3 — dependent IN-list fetch (tables + mapping_sources) ──
  const [
    { data: tablesRaw },
    { data: mappingSourcesRaw },
  ] = await Promise.all([
    datasetIds.length > 0
      ? supabase
          .from('tables')
          .select('id, dataset_id, name')
          .in('dataset_id', datasetIds)
      : Promise.resolve({ data: [] as RawTableRow[] }),
    tfmIds.length > 0
      ? supabase
          .from('mapping_sources')
          .select('id, target_field_mapping_id, source_field_id, source_table_id, confidence, ai_reasoning, type_compatibility, join_spec, ordinal')
          .in('target_field_mapping_id', tfmIds)
          .order('ordinal', { ascending: true })
      : Promise.resolve({ data: [] as RawMappingSourceRow[] }),
  ])

  const tables = (tablesRaw ?? []) as RawTableRow[]
  const mappingSources = (mappingSourcesRaw ?? []) as RawMappingSourceRow[]

  const tableIds = tables.map((t) => t.id)

  // ── Round 4 — fields + transformations ───────────────────────────
  const [
    { data: fieldsRaw },
    { data: transformationsRaw },
  ] = await Promise.all([
    tableIds.length > 0
      ? supabase
          .from('fields')
          .select('id, table_id, name, data_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, default_value, ordinal_position, field_profiles(field_id, sample_values)')
          .in('table_id', tableIds)
      : Promise.resolve({ data: [] as RawFieldRow[] }),
    tfmIds.length > 0
      ? supabase
          .from('transformations')
          .select('id, target_field_mapping_id, status, description, generated_sql')
          .in('target_field_mapping_id', tfmIds)
      : Promise.resolve({ data: [] as RawTransformationRow[] }),
  ])

  const fields = (fieldsRaw ?? []) as RawFieldRow[]
  const transformations = (transformationsRaw ?? []) as RawTransformationRow[]

  return assembleMappingsForRedesign({
    projectId,
    datasets,
    tables,
    fields,
    tfms,
    mappingSources,
    sourceAcks,
    transformations,
  })
}
