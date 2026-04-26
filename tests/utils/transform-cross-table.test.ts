import { describe, it, expect } from 'vitest'
import {
  deriveJoinSpec,
  buildJoinSpec,
  type JoinSpecInput,
} from '@/lib/utils/transform-cross-table'
import type { FkInferenceTable } from '@/lib/utils/fk-inference'

/**
 * Unit coverage for `deriveJoinSpec` (pure helper) and `buildJoinSpec`
 * (async fetcher) — Phase 4a-6.
 *
 * Two surfaces under test:
 *   1. `deriveJoinSpec` — translates pre-fetched dominant + per-table
 *      contributor metadata into the `RpcJoinSpec` JSONB the migration-076
 *      RPC consumes, plus the `CrossTableFieldMap` the cross-table
 *      `wrapFieldRefsInJsonb` overload consumes.
 *   2. `buildJoinSpec` — pulls the same shape straight from Supabase,
 *      handling per-row → per-table dedupe of `mapping_sources.join_spec`
 *      rows. Tested against a hand-built stub so we can exercise the
 *      dedupe and FK-inference paths without a live database.
 *
 * What we're pinning (matches Phase 4a-6 design notes in
 * `lib/utils/transform-cross-table.ts`):
 *   • Same-table TFMs (no contributors) → spec=null, fieldMap=null —
 *     caller falls through to the byte-for-byte same-table RPC branch.
 *   • Stored `mapping_sources.join_spec` is honored verbatim when set.
 *   • NULL stored spec → re-derive via `inferFkCandidates`. Schema may
 *     have shifted since write time, so 0 / 2+ candidates raise
 *     `CROSS_TABLE_FK_INFERENCE_FAILED` rather than guessing.
 *   • Aliases line up with the LATERAL clauses in migration 076:
 *     dominant=`d`, joined contributors=`j0`, `j1`, …
 *   • Per-row → per-table dedupe collapses N contributing fields from
 *     the same source table into ONE LATERAL clause for the RPC.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOMINANT_TABLE_ID = 't-loan'
const CIF_TABLE_ID = 't-cif'
const PROD_TABLE_ID = 't-prod'

const tablesById: Map<string, FkInferenceTable> = new Map([
  [DOMINANT_TABLE_ID, { id: DOMINANT_TABLE_ID, name: 'LOAN_MASTER' }],
  [CIF_TABLE_ID, { id: CIF_TABLE_ID, name: 'CIF_MASTER' }],
  [PROD_TABLE_ID, { id: PROD_TABLE_ID, name: 'PROD_MASTER' }],
])

function dominantWithFks(
  fks: Array<{ name: string; ref: string | null; isFk?: boolean }>,
): JoinSpecInput['dominant'] {
  return {
    tableId: DOMINANT_TABLE_ID,
    tableName: 'LOAN_MASTER',
    fieldNames: ['LOAN_TYPE', 'LOAN_NO', ...fks.map((f) => f.name)],
    fkFields: [
      { name: 'LOAN_TYPE', is_foreign_key: false, fk_reference: null },
      { name: 'LOAN_NO', is_foreign_key: false, fk_reference: null },
      ...fks.map((f) => ({
        name: f.name,
        is_foreign_key: f.isFk ?? true,
        fk_reference: f.ref,
      })),
    ],
  }
}

// ─── deriveJoinSpec — same-table short-circuit ───────────────────────────────

describe('[transform-cross-table] deriveJoinSpec — same-table short-circuit', () => {
  it('returns spec=null and fieldMap=null when there are zero contributors', () => {
    const result = deriveJoinSpec({
      dominant: dominantWithFks([]),
      contributors: [],
      tablesById,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec).toBeNull()
    expect(result.fieldMap).toBeNull()
  })
})

// ─── deriveJoinSpec — stored join_spec honored ───────────────────────────────

describe('[transform-cross-table] deriveJoinSpec — honors stored join_spec', () => {
  it('uses the stored viaFkField/toFkField verbatim, no FK inference', () => {
    const result = deriveJoinSpec({
      // No FK fields on the dominant — proves we're NOT re-deriving
      // when the storedJoinSpec is set.
      dominant: dominantWithFks([]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: { viaFkField: 'CIF_NO', toFkField: 'CIF_NO' },
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec).toEqual({
      dominant_table_id: DOMINANT_TABLE_ID,
      joins: [
        {
          joined_table_id: CIF_TABLE_ID,
          via_fk_field: 'CIF_NO',
          to_fk_field: 'CIF_NO',
          alias: 'j0',
        },
      ],
    })
    expect(result.fieldMap).not.toBeNull()
    const fieldMap = result.fieldMap!
    expect(fieldMap.get('LOAN_MASTER')).toEqual({
      alias: 'd',
      fieldNames: new Set(['LOAN_TYPE', 'LOAN_NO']),
    })
    expect(fieldMap.get('CIF_MASTER')).toEqual({
      alias: 'j0',
      fieldNames: new Set(['CIF_TYPE']),
    })
  })
})

// ─── deriveJoinSpec — re-derivation via inferFkCandidates ────────────────────

describe('[transform-cross-table] deriveJoinSpec — FK re-derivation when stored is null', () => {
  it('exactly one candidate → derives via_fk_field + to_fk_field from fk_reference', () => {
    const result = deriveJoinSpec({
      dominant: dominantWithFks([
        { name: 'CIF_NO', ref: 'CIF_MASTER.CIF_NO' },
      ]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: null,
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec?.joins).toEqual([
      {
        joined_table_id: CIF_TABLE_ID,
        via_fk_field: 'CIF_NO',
        to_fk_field: 'CIF_NO',
        alias: 'j0',
      },
    ])
  })

  it('zero candidates → CROSS_TABLE_FK_INFERENCE_FAILED', () => {
    const result = deriveJoinSpec({
      // Dominant has no FK pointing at CIF_MASTER.
      dominant: dominantWithFks([]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: null,
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('CROSS_TABLE_FK_INFERENCE_FAILED')
    expect(result.error).toMatch(/re-author/i)
  })

  it('two candidates → CROSS_TABLE_FK_INFERENCE_FAILED', () => {
    const result = deriveJoinSpec({
      dominant: dominantWithFks([
        { name: 'PRIMARY_CIF_NO', ref: 'CIF_MASTER.CIF_NO' },
        { name: 'GUARANTOR_CIF_NO', ref: 'CIF_MASTER.CIF_NO' },
      ]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: null,
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('CROSS_TABLE_FK_INFERENCE_FAILED')
  })

  it('single candidate but unparseable fk_reference (bare table name) → fails', () => {
    // `parseToFkColumnName` returns null for `"CIF_MASTER"` (no column),
    // so the helper bails rather than emit an invalid LATERAL.
    const result = deriveJoinSpec({
      dominant: dominantWithFks([{ name: 'CIF_NO', ref: 'CIF_MASTER' }]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: null,
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('CROSS_TABLE_FK_INFERENCE_FAILED')
  })

  it('parses Table(Column) shape for to_fk_field', () => {
    const result = deriveJoinSpec({
      dominant: dominantWithFks([
        { name: 'CIF_NO', ref: 'CIF_MASTER(CIF_NO)' },
      ]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: null,
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec?.joins[0]).toMatchObject({
      via_fk_field: 'CIF_NO',
      to_fk_field: 'CIF_NO',
    })
  })
})

// ─── deriveJoinSpec — multi-contributor aliasing (3-table) ───────────────────

describe('[transform-cross-table] deriveJoinSpec — multi-contributor aliasing', () => {
  it('three-table TFM produces aliases d / j0 / j1 in input order', () => {
    const result = deriveJoinSpec({
      dominant: dominantWithFks([]),
      contributors: [
        {
          tableId: CIF_TABLE_ID,
          tableName: 'CIF_MASTER',
          fieldNames: ['CIF_TYPE'],
          storedJoinSpec: { viaFkField: 'CIF_NO', toFkField: 'CIF_NO' },
        },
        {
          tableId: PROD_TABLE_ID,
          tableName: 'PROD_MASTER',
          fieldNames: ['PROD_NAME'],
          storedJoinSpec: { viaFkField: 'PROD_CODE', toFkField: 'CODE' },
        },
      ],
      tablesById,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec?.joins.map((j) => j.alias)).toEqual(['j0', 'j1'])
    expect(result.fieldMap?.get('LOAN_MASTER')?.alias).toBe('d')
    expect(result.fieldMap?.get('CIF_MASTER')?.alias).toBe('j0')
    expect(result.fieldMap?.get('PROD_MASTER')?.alias).toBe('j1')
  })
})

// ─── buildJoinSpec — async fetcher dedupe behavior ───────────────────────────
//
// Stub Supabase client. The buildJoinSpec helper issues exactly four
// queries:
//   1. mapping_sources       — order by ordinal asc
//   2. target_field_mappings — to look up project_id
//   3. tables                — for project's table universe
//   4. fields                — for the involved tables' columns
// We mirror just enough of the chainable API to satisfy each call.

function makeSupabaseStub(routes: Record<string, () => unknown>) {
  const from = (table: string) => {
    const route = routes[table]
    if (!route) throw new Error(`unstubbed table query: ${table}`)
    return route()
  }
  return { from } as unknown as Parameters<typeof buildJoinSpec>[1]
}

function fromRows<T>(rows: T[]) {
  // Each chained method returns `this` until a terminal awaitable is
  // reached. The terminal shape is `{ data, error }` (Supabase's PostgREST
  // result envelope).
  const self: Record<string, unknown> = {}
  const passthrough = () => self
  self.select = passthrough
  self.eq = passthrough
  self.in = passthrough
  self.order = () =>
    Promise.resolve({ data: rows, error: null }) as unknown as typeof self
  self.maybeSingle = () =>
    Promise.resolve({ data: rows[0] ?? null, error: null }) as unknown as typeof self
  // `select` MUST resolve directly when not chained with `.order`
  // (`tables`, `fields` queries). To support both, make the outer
  // object thenable so `await supabase.from(...).select(...).eq(...).in(...)`
  // resolves to `{ data, error }`.
  ;(self as { then?: unknown }).then = (
    onFulfilled: (v: { data: T[]; error: null }) => unknown,
  ) => Promise.resolve({ data: rows, error: null }).then(onFulfilled)
  return self
}

describe('[transform-cross-table] buildJoinSpec — per-row → per-table dedupe', () => {
  it('collapses two mapping_sources rows from the same joined table into ONE LATERAL', async () => {
    // Two contributing fields from CIF_MASTER (CIF_TYPE + CIF_NAME) — the
    // RPC needs ONE LATERAL clause for that table, not two.
    const supabase = makeSupabaseStub({
      mapping_sources: () =>
        fromRows([
          {
            id: 'ms-0',
            source_table_id: DOMINANT_TABLE_ID,
            ordinal: 0,
            join_spec: null,
          },
          {
            id: 'ms-1',
            source_table_id: CIF_TABLE_ID,
            ordinal: 1,
            join_spec: { via_fk_field: 'CIF_NO', to_fk_field: 'CIF_NO' },
          },
          {
            id: 'ms-2',
            source_table_id: CIF_TABLE_ID,
            ordinal: 2,
            join_spec: { via_fk_field: 'CIF_NO', to_fk_field: 'CIF_NO' },
          },
        ]),
      target_field_mappings: () => fromRows([{ project_id: 'proj-1' }]),
      tables: () =>
        fromRows([
          { id: DOMINANT_TABLE_ID, name: 'LOAN_MASTER' },
          { id: CIF_TABLE_ID, name: 'CIF_MASTER' },
        ]),
      fields: () =>
        fromRows([
          {
            table_id: DOMINANT_TABLE_ID,
            name: 'CIF_NO',
            is_foreign_key: true,
            fk_reference: 'CIF_MASTER.CIF_NO',
          },
          {
            table_id: DOMINANT_TABLE_ID,
            name: 'LOAN_TYPE',
            is_foreign_key: false,
            fk_reference: null,
          },
          {
            table_id: CIF_TABLE_ID,
            name: 'CIF_TYPE',
            is_foreign_key: false,
            fk_reference: null,
          },
          {
            table_id: CIF_TABLE_ID,
            name: 'CIF_NAME',
            is_foreign_key: false,
            fk_reference: null,
          },
        ]),
    })

    const result = await buildJoinSpec('tfm-1', supabase)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec).not.toBeNull()
    // Exactly ONE LATERAL — dedupe collapsed both ms-1 and ms-2 down.
    expect(result.spec!.joins).toHaveLength(1)
    expect(result.spec!.joins[0]).toMatchObject({
      joined_table_id: CIF_TABLE_ID,
      alias: 'j0',
    })
    // Field map exposes BOTH joined columns under the same `j0` alias —
    // so the cross-table `wrapFieldRefsInJsonb` overload can rewrite
    // both `{CIF_MASTER.CIF_TYPE}` and `{CIF_MASTER.CIF_NAME}`.
    const cifEntry = result.fieldMap!.get('CIF_MASTER')!
    expect(cifEntry.alias).toBe('j0')
    expect(cifEntry.fieldNames.has('CIF_TYPE')).toBe(true)
    expect(cifEntry.fieldNames.has('CIF_NAME')).toBe(true)
  })

  it('first non-null stored join_spec per table wins; null rows fall back to inference', async () => {
    // Mixed: ms-1 has null spec, ms-2 has a populated spec for the same
    // table. The helper must prefer the populated spec (no extra inference).
    const supabase = makeSupabaseStub({
      mapping_sources: () =>
        fromRows([
          {
            id: 'ms-0',
            source_table_id: DOMINANT_TABLE_ID,
            ordinal: 0,
            join_spec: null,
          },
          {
            id: 'ms-1',
            source_table_id: CIF_TABLE_ID,
            ordinal: 1,
            join_spec: null,
          },
          {
            id: 'ms-2',
            source_table_id: CIF_TABLE_ID,
            ordinal: 2,
            join_spec: { via_fk_field: 'GUARANTOR_NO', to_fk_field: 'CIF_NO' },
          },
        ]),
      target_field_mappings: () => fromRows([{ project_id: 'proj-1' }]),
      tables: () =>
        fromRows([
          { id: DOMINANT_TABLE_ID, name: 'LOAN_MASTER' },
          { id: CIF_TABLE_ID, name: 'CIF_MASTER' },
        ]),
      fields: () =>
        fromRows([
          {
            table_id: DOMINANT_TABLE_ID,
            name: 'GUARANTOR_NO',
            is_foreign_key: true,
            fk_reference: 'CIF_MASTER.CIF_NO',
          },
        ]),
    })

    const result = await buildJoinSpec('tfm-2', supabase)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec!.joins[0].via_fk_field).toBe('GUARANTOR_NO')
  })

  it('all-same-table mapping_sources → spec=null (same-table TFM)', async () => {
    const supabase = makeSupabaseStub({
      mapping_sources: () =>
        fromRows([
          {
            id: 'ms-0',
            source_table_id: DOMINANT_TABLE_ID,
            ordinal: 0,
            join_spec: null,
          },
          {
            id: 'ms-1',
            source_table_id: DOMINANT_TABLE_ID,
            ordinal: 1,
            join_spec: null,
          },
        ]),
    })

    const result = await buildJoinSpec('tfm-3', supabase)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec).toBeNull()
    expect(result.fieldMap).toBeNull()
  })

  it('cross-table with NULL stored spec and ambiguous FKs → CROSS_TABLE_FK_INFERENCE_FAILED', async () => {
    // Schema drift simulation: mapping was authored when there was a
    // single FK from LOAN_MASTER → CIF_MASTER. Since then a second FK
    // was added to LOAN_MASTER pointing at the same table.
    const supabase = makeSupabaseStub({
      mapping_sources: () =>
        fromRows([
          {
            id: 'ms-0',
            source_table_id: DOMINANT_TABLE_ID,
            ordinal: 0,
            join_spec: null,
          },
          {
            id: 'ms-1',
            source_table_id: CIF_TABLE_ID,
            ordinal: 1,
            join_spec: null,
          },
        ]),
      target_field_mappings: () => fromRows([{ project_id: 'proj-1' }]),
      tables: () =>
        fromRows([
          { id: DOMINANT_TABLE_ID, name: 'LOAN_MASTER' },
          { id: CIF_TABLE_ID, name: 'CIF_MASTER' },
        ]),
      fields: () =>
        fromRows([
          {
            table_id: DOMINANT_TABLE_ID,
            name: 'PRIMARY_CIF_NO',
            is_foreign_key: true,
            fk_reference: 'CIF_MASTER.CIF_NO',
          },
          {
            table_id: DOMINANT_TABLE_ID,
            name: 'GUARANTOR_CIF_NO',
            is_foreign_key: true,
            fk_reference: 'CIF_MASTER.CIF_NO',
          },
        ]),
    })

    const result = await buildJoinSpec('tfm-4', supabase)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('CROSS_TABLE_FK_INFERENCE_FAILED')
    expect(result.error).toMatch(/re-author/i)
  })
})
