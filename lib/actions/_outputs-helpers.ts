/**
 * Pure helpers for output generation against the new mapping-redesign data
 * model (migration 074 + 075).
 *
 * This module is deliberately:
 *   - Pure (no DB access; every input arrives fully hydrated from the caller)
 *   - Free of side effects (no logging, no mutation of inputs)
 *   - Free of `'use server'` (callers import it from server actions AND from
 *     unit tests that feed in-memory fixtures)
 *
 * Rationale: `lib/actions/outputs.ts`, `lib/actions/execution-package.ts`, and
 * `lib/quality/readiness-score.ts` all need to answer the same question —
 * "given the full set of TFMs + mapping_sources for a project, which TFMs
 * belong to which table_mapping?" — and produce the same answer. Centralising
 * the pairing rule here guarantees those three consumers never drift.
 *
 * Pairing rules implemented below (see §Rules comment on `groupTfmsByTableMapping`):
 *
 *   MAPPED TFMs    — owned by the TM where MS[ordinal=0].source_table matches
 *                    tm.source_table_id AND tfm.target_field.table_id matches
 *                    tm.target_table_id.
 *
 *   VA TFMs        — fan out to EVERY TM whose target_table_id matches the
 *                    VA's target_field.table_id. Matches the shim's Design
 *                    Call A behaviour so the shim and the output pipeline
 *                    agree on what belongs to a TM.
 *
 *   ACK'd TFMs     — excluded (they represent "this target will not be
 *                    populated" and so never appear in any customer-facing
 *                    SQL, CSV, or JSON output).
 *
 *   REJECTED TFMs  — excluded.
 *
 * Output consumers rely on deterministic ordering within a TM:
 *   - TFMs sorted by target_field.ordinal_position (stable across runs)
 *   - Contributor MS rows sorted by ordinal (ascending)
 *
 * This stability is load-bearing for golden-output fixtures in
 * `tests/fixtures/outputs/`. If you change the ordering rule you will break
 * every golden test — do so intentionally, and regenerate the fixtures via
 * `UPDATE_FIXTURES=1 npx vitest tests/outputs/`.
 */

import type {
  MappingSourceRow,
  TargetFieldMappingRow,
} from '@/lib/types/mapping-redesign'

// ─── Public types ──────────────────────────────────────────────────────────

/** One (project, field) lookup row. Callers populate this from the fields query. */
export interface FieldLookupRow {
  id: string
  table_id: string
  /** Optional — only needed by consumers that sort by ordinal_position. */
  ordinal_position?: number | null
}

export interface TableMappingLookup {
  id: string
  source_table_id: string
  target_table_id: string
}

/**
 * A TFM grouped under its owning table_mapping, along with its hydrated
 * primary source (null for VAs) and contributors (ordinal >= 1, sorted).
 */
export interface TfmForTm {
  tfm: TargetFieldMappingRow
  /**
   * MS[ordinal = 0] for mapped TFMs. NULL for VAs (combination_type='custom_sql'
   * with zero MS rows). For ANY non-VA TFM, primarySource is guaranteed
   * non-null by the pairing rule (a mapped TFM must have a primary source to
   * be pairable to a TM).
   */
  primarySource: MappingSourceRow | null
  /** MS[ordinal >= 1], sorted ascending by ordinal. */
  contributors: MappingSourceRow[]
}

export interface GroupTfmsInput {
  tableMappings: readonly TableMappingLookup[]
  targetFieldMappings: readonly TargetFieldMappingRow[]
  mappingSources: readonly MappingSourceRow[]
  /** Field id → { table_id, ordinal_position? }. Must contain every target_field_id
   *  referenced by `targetFieldMappings` and every source_field_id referenced
   *  by `mappingSources`. Missing entries cause the owning TFM/MS to be
   *  silently excluded from the output — callers should pre-validate. */
  fieldsById: ReadonlyMap<string, FieldLookupRow>
}

// ─── Public functions ──────────────────────────────────────────────────────

/**
 * Group TFMs by the table_mapping that owns them.
 *
 * Returns: Map<tm.id, TfmForTm[]> with TFMs sorted per §file header.
 *
 * Consumers that need a TM → TFMs dictionary for iteration should call this
 * exactly once at the top of their function. It runs in O(N*M) where N is
 * the number of non-rejected non-acknowledged TFMs and M is the number of
 * TMs matching each TFM's target table; in practice M is small (≤ 2) because
 * a project rarely duplicates TMs for the same target table.
 */
export function groupTfmsByTableMapping(input: GroupTfmsInput): Map<string, TfmForTm[]> {
  const { tableMappings, targetFieldMappings, mappingSources, fieldsById } = input

  // Index mapping_sources by TFM for O(1) lookup.
  const msByTfm = new Map<string, MappingSourceRow[]>()
  for (const ms of mappingSources) {
    const list = msByTfm.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfm.set(ms.target_field_mapping_id, list)
  }
  // Sort each TFM's MS rows by ordinal ascending. Stable for golden fixtures.
  for (const list of msByTfm.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal)
  }

  // Index TMs by target_table for VA fan-out, and by (source_table, target_table)
  // for mapped pairing.
  const tmsByTargetTable = new Map<string, TableMappingLookup[]>()
  const tmByPair = new Map<string, TableMappingLookup>() // key: `${src}::${tgt}`
  for (const tm of tableMappings) {
    const tgtList = tmsByTargetTable.get(tm.target_table_id) ?? []
    tgtList.push(tm)
    tmsByTargetTable.set(tm.target_table_id, tgtList)
    tmByPair.set(`${tm.source_table_id}::${tm.target_table_id}`, tm)
  }

  // Bucket TFMs into per-TM lists.
  const byTm = new Map<string, TfmForTm[]>()
  for (const tm of tableMappings) byTm.set(tm.id, [])

  for (const tfm of targetFieldMappings) {
    // Rule: exclude rejected TFMs from every output. The legacy field_mappings
    // table had `.neq('status', 'rejected')` in every exporter query; the new
    // model concentrates rejection state on the TFM row (MS rows don't carry
    // a status).
    if (tfm.status === 'rejected') continue

    // Rule: exclude bare acknowledgments (is_acknowledged=true, combination_type IS NULL).
    // These represent "target field will not be populated" — they carry no
    // column in SELECT lists and appear only in ack-aware metrics, which are
    // computed separately by the caller (see outputs.ts acknowledgedCount).
    if (tfm.is_acknowledged && tfm.combination_type === null) continue

    const tgtField = fieldsById.get(tfm.target_field_id)
    if (!tgtField) continue // defensive; caller should pre-validate fieldsById

    const msList = msByTfm.get(tfm.id) ?? []
    const primaryMs = msList.find((m) => m.ordinal === 0) ?? null
    const contributors = msList.filter((m) => m.ordinal >= 1)

    const isVA = tfm.combination_type === 'custom_sql' && msList.length === 0

    if (isVA) {
      // Rule (migration 077): VAs the user dismissed in the Transform tab
      // (`va_dismissed=true`) are excluded from grouping. They produce no
      // output rows in the execution package, the migration runbook, or
      // the per-table scripts — semantically equivalent to a target field
      // the user "knows is intentionally null/default".
      if (tfm.va_dismissed === true) continue
      // VA fan-out: every TM targeting this target-table owns a copy of the VA.
      const matchingTms = tmsByTargetTable.get(tgtField.table_id) ?? []
      for (const tm of matchingTms) {
        byTm.get(tm.id)!.push({ tfm, primarySource: null, contributors: [] })
      }
      continue
    }

    // Mapped case: primary MS must exist and its source_field must resolve
    // to a table. Any deviation is a data bug upstream — skip defensively so
    // we don't crash customer output generation on a single malformed row.
    if (!primaryMs || !primaryMs.source_field_id) continue
    const primarySrcField = fieldsById.get(primaryMs.source_field_id)
    if (!primarySrcField) continue

    const pairKey = `${primarySrcField.table_id}::${tgtField.table_id}`
    const owningTm = tmByPair.get(pairKey)
    if (!owningTm) continue // no TM for this pairing — TFM is orphaned

    byTm.get(owningTm.id)!.push({ tfm, primarySource: primaryMs, contributors })
  }

  // Sort within each TM by target_field.ordinal_position (stable, fallback to
  // target_field_id for pathological cases where ordinal is missing).
  for (const list of byTm.values()) {
    list.sort((a, b) => {
      const ao = fieldsById.get(a.tfm.target_field_id)?.ordinal_position ?? 0
      const bo = fieldsById.get(b.tfm.target_field_id)?.ordinal_position ?? 0
      if (ao !== bo) return ao - bo
      return a.tfm.target_field_id.localeCompare(b.tfm.target_field_id)
    })
  }

  return byTm
}

// ─── Derived row-level convenience ────────────────────────────────────────

/**
 * One (primary or contributor) field-pair produced by flattening a TfmForTm.
 *
 * Used by:
 *   - generateMappingFile (emits one CSV row per pair)
 *   - execution-package prompt assembly (emits one line per pair)
 *   - generateTransformSpecs (emits one SQL block per *primary* pair, skipping
 *     contributors since the transformation SQL already references them via
 *     wrapFieldRefsInJsonb)
 */
export interface FieldPair {
  /** null iff this is a VA primary pair. */
  sourceFieldId: string | null
  targetFieldId: string
  /** true for MS[0] or VA; false for contributor MS rows. */
  isPrimary: boolean
  /** 0 for primary/VA; 1.. for contributors. */
  ordinal: number
  /** null iff VA primary pair. */
  mappingSourceId: string | null
  /** Confidence surfaced per legacy semantics: tfm.confidence for primary,
   *  ms.confidence for contributors. */
  confidence: number | null
  aiReasoning: string | null
  /** null for primary pairs (target side has no type_compat); ms.type_compatibility for contributors. */
  typeCompatibility: string | null
}

export function enumerateFieldPairs(entry: TfmForTm): FieldPair[] {
  const out: FieldPair[] = []
  const { tfm, primarySource, contributors } = entry

  // Primary pair first (VA or mapped).
  out.push({
    sourceFieldId: primarySource?.source_field_id ?? null,
    targetFieldId: tfm.target_field_id,
    isPrimary: true,
    ordinal: 0,
    mappingSourceId: primarySource?.id ?? null,
    confidence: tfm.confidence,
    aiReasoning: tfm.ai_reasoning,
    typeCompatibility: null,
  })

  // Contributors in ordinal order.
  for (const ms of contributors) {
    out.push({
      sourceFieldId: ms.source_field_id,
      targetFieldId: tfm.target_field_id,
      isPrimary: false,
      ordinal: ms.ordinal,
      mappingSourceId: ms.id,
      confidence: ms.confidence,
      aiReasoning: ms.ai_reasoning,
      typeCompatibility: ms.type_compatibility,
    })
  }

  return out
}

/**
 * True iff the TFM is a value assignment (custom_sql combination, zero sources).
 * Callers must pass msCount derived from the same mapping_sources set used in
 * groupTfmsByTableMapping.
 */
export function isValueAssignment(tfm: TargetFieldMappingRow, msCount: number): boolean {
  return tfm.combination_type === 'custom_sql' && msCount === 0
}
