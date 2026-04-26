// ─────────────────────────────────────────────────────────────────────────────
// Cross-table transform apply — JoinSpec derivation for the RPC.
// ─────────────────────────────────────────────────────────────────────────────
//
// Phase 4a-6 (lock §1-OQ-A, §3-OQ-A, §3-OQ-B, §8f-OQ).
//
// `dq_apply_field_transform_joined` (migration 076) accepts an optional
// `p_join_spec` JSONB describing how to LEFT JOIN LATERAL the dominant
// `data_rows` partition to one or more joined source tables. This module
// builds that JSONB from a TFM's stored `mapping_sources` rows.
//
// Per-source vs per-table
//
//   `mapping_sources.join_spec` is recorded per ROW (one per contributing
//   source field). The RPC consumes per TABLE — one LATERAL clause per
//   distinct joined source table, regardless of how many fields from that
//   table contribute to the transform. `deriveJoinSpec` performs that
//   dedupe.
//
// Re-derivation when stored join_spec is null
//
//   `createFieldMapping` writes `join_spec=null` when a single FK
//   candidate was found at write time (read path re-derives the
//   annotation). At apply time we re-derive again (parity, schema may
//   have shifted). If `inferFkCandidates` now returns 0 or 2+ candidates
//   the apply path returns `CROSS_TABLE_FK_INFERENCE_FAILED` rather than
//   guessing — the user must re-author the mapping.
//
// Field reference qualification
//
//   The action layer rewrites `{Table.Field}` references in the transform
//   SQL using a new overload of `wrapFieldRefsInJsonb` (see
//   `lib/utils/transform-helpers.ts`). The aliases produced here
//   (`'d'` for dominant, `'j0' / 'j1' / …` for joined) match what the
//   RPC expects in its LATERAL clauses. Bare/unqualified field
//   references in cross-table TFMs are rejected by the helper.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  inferFkCandidates,
  type FkInferenceField,
  type FkInferenceTable,
} from '@/lib/utils/fk-inference'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * RPC contract — see `supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql`.
 *
 * Snake_case keys mirror the on-disk JSONB shape the RPC consumes.
 * Distinct from the camelCase `JoinSpec` interface in
 * `lib/types/mappings-for-redesign.ts` which describes the per-row
 * `mapping_sources.join_spec` storage shape.
 */
export interface RpcJoinSpec {
  dominant_table_id: string
  joins: Array<{
    joined_table_id: string
    via_fk_field: string
    to_fk_field: string
    alias: string
  }>
}

/**
 * Maps user-typed table names (case-sensitive) to the alias the RPC
 * uses for that table's `data_rows` projection plus the set of valid
 * field names in that table. Consumed by the cross-table overload of
 * `wrapFieldRefsInJsonb`. The dominant entry uses alias `'d'`.
 */
export type CrossTableFieldMap = Map<
  string,
  { alias: string; fieldNames: Set<string> }
>

/** Per-table input shape consumed by `deriveJoinSpec` (pure helper). */
export interface JoinSpecInput {
  dominant: {
    tableId: string
    tableName: string
    fieldNames: string[]
    /** Used for FK re-derivation when stored spec is null. */
    fkFields: FkInferenceField[]
  }
  /**
   * One entry per distinct contributing source table (ordinal > 0).
   * Caller deduplicates from per-row mapping_sources before calling.
   */
  contributors: Array<{
    tableId: string
    tableName: string
    fieldNames: string[]
    /**
     * The first non-null `join_spec` observed for any mapping_source
     * targeting this table. NULL when every row stored null (FK was
     * inferred at write time — re-derive here).
     */
    storedJoinSpec: { viaFkField: string; toFkField: string } | null
  }>
  /** All tables in the project — needed by `inferFkCandidates`. */
  tablesById: Map<string, FkInferenceTable>
}

export type BuildJoinSpecResult =
  | {
      ok: true
      /** NULL when the TFM is single-table (same-table apply path). */
      spec: RpcJoinSpec | null
      /**
       * NULL for same-table; populated for cross-table so the caller
       * can pass into `wrapFieldRefsInJsonb`.
       */
      fieldMap: CrossTableFieldMap | null
    }
  | {
      ok: false
      errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED'
      error: string
    }

// ─── Pure derivation ─────────────────────────────────────────────────────────

/**
 * Pure helper. Given pre-fetched dominant + contributor metadata,
 * produce the RPC `p_join_spec` JSONB plus the `wrapFieldRefsInJsonb`
 * field map. Unit-tested in `tests/utils/transform-cross-table.test.ts`.
 *
 * Returns `{ ok: true, spec: null, fieldMap: null }` when there are no
 * contributors (same-table TFM). The caller passes `null` to the RPC
 * and uses the existing `string[]` overload of `wrapFieldRefsInJsonb`.
 */
export function deriveJoinSpec(input: JoinSpecInput): BuildJoinSpecResult {
  const { dominant, contributors, tablesById } = input

  // Same-table TFMs short-circuit. The caller will invoke the
  // pre-existing same-table apply path with `p_join_spec=null`.
  if (contributors.length === 0) {
    return { ok: true, spec: null, fieldMap: null }
  }

  const joins: RpcJoinSpec['joins'] = []
  const fieldMap: CrossTableFieldMap = new Map()

  // Dominant entry — alias 'd' lines up with the `data_rows d` projection
  // the RPC's same-table and cross-table branches both UPDATE/INSERT
  // through.
  fieldMap.set(dominant.tableName, {
    alias: 'd',
    fieldNames: new Set(dominant.fieldNames),
  })

  for (let i = 0; i < contributors.length; i += 1) {
    const c = contributors[i]
    const alias = `j${i}`

    let viaFkField: string | null = null
    let toFkField: string | null = null

    if (c.storedJoinSpec) {
      viaFkField = c.storedJoinSpec.viaFkField
      toFkField = c.storedJoinSpec.toFkField
    } else {
      // Re-derive — schema may have shifted since write time.
      const candidates = inferFkCandidates(
        dominant.fkFields,
        c.tableId,
        c.tableName,
        tablesById,
      )
      if (candidates.length !== 1) {
        return {
          ok: false,
          errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED',
          error: `FK relationship changed since this mapping was authored. Please re-author the mapping.`,
        }
      }
      viaFkField = candidates[0]

      // toFkField fallback: parse from the matching dominant field's
      // fk_reference. If unparseable, error — we need a definite
      // joined-side column to LATERAL-key on.
      const fkRowMatch = dominant.fkFields.find((f) => f.name === viaFkField)
      const ref = fkRowMatch?.fk_reference ?? null
      toFkField = ref ? parseToFkColumnName(ref) : null
      if (!toFkField) {
        return {
          ok: false,
          errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED',
          error: `FK relationship changed since this mapping was authored. Please re-author the mapping.`,
        }
      }
    }

    joins.push({
      joined_table_id: c.tableId,
      via_fk_field: viaFkField,
      to_fk_field: toFkField,
      alias,
    })

    fieldMap.set(c.tableName, {
      alias,
      fieldNames: new Set(c.fieldNames),
    })
  }

  return {
    ok: true,
    spec: { dominant_table_id: dominant.tableId, joins },
    fieldMap,
  }
}

// ─── fk_reference column parser ──────────────────────────────────────────────
//
// Local helper — extracts the joined-side column from `"Table.Column"` or
// `"Table(Column)"` shapes. Bare `"Table"` returns null. Parallel of
// `parseToFkFieldFromReference` in fk-inference.ts but kept local so the
// derivation contract is self-contained and the callers don't need to
// care about that helper's broader scope.

function parseToFkColumnName(fkReference: string): string | null {
  const dotIdx = fkReference.indexOf('.')
  if (dotIdx > 0 && dotIdx < fkReference.length - 1) {
    const tail = fkReference.slice(dotIdx + 1).trim()
    if (tail.length > 0 && !tail.includes('.')) return tail
    if (tail.length > 0) return tail.split('.')[0]
  }
  const parenMatch = fkReference.match(/^[^(]+\(([^)]+)\)\s*$/)
  if (parenMatch) {
    const col = parenMatch[1].trim()
    if (col.length > 0) return col
  }
  return null
}

// ─── Async fetcher ───────────────────────────────────────────────────────────

/**
 * Async wrapper around `deriveJoinSpec` that pulls everything it needs
 * straight from Supabase. Used by `applyTransform` and
 * `testTransformation` in `lib/actions/transformations.ts` to decide
 * between the same-table and cross-table RPC branches.
 *
 * Caller supplies the admin client (writes go through service-role
 * elsewhere; reads here use the admin client too for parity with
 * `loadTfmContext`).
 */
export async function buildJoinSpec(
  tfmId: string,
  supabase: SupabaseClient,
): Promise<BuildJoinSpecResult> {
  // 1. mapping_sources — ordered by ordinal so we know the dominant.
  const { data: sources } = await supabase
    .from('mapping_sources')
    .select('id, source_table_id, ordinal, join_spec')
    .eq('target_field_mapping_id', tfmId)
    .order('ordinal', { ascending: true })

  const sourceRows =
    (sources as
      | Array<{
          id: string
          source_table_id: string | null
          ordinal: number
          join_spec: { via_fk_field?: string; to_fk_field?: string } | null
        }>
      | null) ?? []

  if (sourceRows.length === 0) {
    return { ok: true, spec: null, fieldMap: null }
  }

  const dominantRow = sourceRows.find((r) => r.ordinal === 0) ?? sourceRows[0]
  const dominantTableId = dominantRow.source_table_id
  if (!dominantTableId) {
    // No dominant table id — treat as same-table fallback. Same-table
    // path handles VAs / malformed rows correctly.
    return { ok: true, spec: null, fieldMap: null }
  }

  // 2. Distinct contributing source tables (excluding the dominant).
  const contributorTableIds: string[] = []
  // Dedupe per-table while preserving first-seen ordinal order. Picks
  // the first non-null join_spec observed per table.
  const firstSpecByTable = new Map<
    string,
    { viaFkField: string; toFkField: string } | null
  >()
  for (const r of sourceRows) {
    if (!r.source_table_id || r.source_table_id === dominantTableId) continue
    if (!firstSpecByTable.has(r.source_table_id)) {
      contributorTableIds.push(r.source_table_id)
      firstSpecByTable.set(r.source_table_id, null)
    }
    if (
      firstSpecByTable.get(r.source_table_id) == null &&
      r.join_spec &&
      typeof r.join_spec === 'object' &&
      typeof r.join_spec.via_fk_field === 'string' &&
      typeof r.join_spec.to_fk_field === 'string'
    ) {
      firstSpecByTable.set(r.source_table_id, {
        viaFkField: r.join_spec.via_fk_field,
        toFkField: r.join_spec.to_fk_field,
      })
    }
  }

  // Same-table TFM — early exit before any extra queries.
  if (contributorTableIds.length === 0) {
    return { ok: true, spec: null, fieldMap: null }
  }

  // 3. Resolve the dominant TFM's project_id so we can scope the
  //    tablesById universe needed by `inferFkCandidates`.
  const { data: tfmRow } = await supabase
    .from('target_field_mappings')
    .select('project_id')
    .eq('id', tfmId)
    .maybeSingle<{ project_id: string }>()

  if (!tfmRow) {
    return { ok: true, spec: null, fieldMap: null }
  }
  const projectId = tfmRow.project_id

  // 4. Bulk-load tables (id, name) for the project — covers dominant +
  //    every joined contributor + the broader universe `inferFkCandidates`
  //    needs for fk_reference resolution.
  const { data: allTablesRaw } = await supabase
    .from('tables')
    .select('id, name, datasets!inner(project_id)')
    .eq('datasets.project_id', projectId)

  const tablesById = new Map<string, FkInferenceTable>()
  for (const t of (allTablesRaw ?? []) as Array<{ id: string; name: string }>) {
    tablesById.set(t.id, { id: t.id, name: t.name })
  }

  const dominantTable = tablesById.get(dominantTableId)
  if (!dominantTable) {
    // Schema mismatch — bail to same-table to avoid invoking the RPC
    // with garbage. The action layer's RPC call will surface a clearer
    // error if it actually matters.
    return { ok: true, spec: null, fieldMap: null }
  }

  // 5. Bulk-load fields for every involved table. Single round-trip.
  const involvedTableIds = [dominantTableId, ...contributorTableIds]
  const { data: allFieldsRaw } = await supabase
    .from('fields')
    .select('table_id, name, is_foreign_key, fk_reference')
    .in('table_id', involvedTableIds)

  const fieldsByTable = new Map<
    string,
    Array<{ name: string; is_foreign_key: boolean | null; fk_reference: string | null }>
  >()
  for (const t of involvedTableIds) fieldsByTable.set(t, [])
  for (const f of (allFieldsRaw ??
    []) as Array<{
    table_id: string
    name: string
    is_foreign_key: boolean | null
    fk_reference: string | null
  }>) {
    const arr = fieldsByTable.get(f.table_id)
    if (arr) arr.push(f)
  }

  const dominantFields = fieldsByTable.get(dominantTableId) ?? []
  const dominantInput: JoinSpecInput['dominant'] = {
    tableId: dominantTableId,
    tableName: dominantTable.name,
    fieldNames: dominantFields.map((f) => f.name),
    fkFields: dominantFields.map((f) => ({
      name: f.name,
      is_foreign_key: f.is_foreign_key,
      fk_reference: f.fk_reference,
    })),
  }

  const contributorsInput: JoinSpecInput['contributors'] = contributorTableIds.map(
    (tableId) => {
      const t = tablesById.get(tableId)
      const fields = fieldsByTable.get(tableId) ?? []
      return {
        tableId,
        tableName: t?.name ?? '',
        fieldNames: fields.map((f) => f.name),
        storedJoinSpec: firstSpecByTable.get(tableId) ?? null,
      }
    },
  )

  return deriveJoinSpec({
    dominant: dominantInput,
    contributors: contributorsInput,
    tablesById,
  })
}
