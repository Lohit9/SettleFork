/**
 * Unit tests for `lib/ai/path-d-persistence.ts`.
 *
 * Mocked-Supabase tests: chain-call tracking on a fluent builder mock.
 * Asserts on the SQL operations issued + the cross-section UUID resolution
 * (data_quality_flag_indices → dq UUIDs; applies_to.tfm_indices → TFM UUIDs).
 *
 * Real-DB integration of the cascade behavior + RLS enforcement is deferred
 * to Sub-PR 4b's happy-path integration test (env-gated, real LLM).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { persistPathDOutput } from '@/lib/ai/path-d-persistence'
import type { PathDParsedOutput } from '@/lib/ai/path-d-parser'

// ── Mock supabase admin with chain-call tracking ───────────────────────────

interface ChainCall {
  table: string
  method: string
  args: unknown[]
}

function makeMockAdmin(opts: {
  // Per-table-method override of what `await chain` resolves to.
  // Key format: 'table.method' (e.g., 'project_data_quality_issues.insert')
  insertResolves?: Record<string, { data: { id: string }[]; error: null } | { data: null; error: { message: string } }>
  upsertResolves?: Record<string, { data: { id: string; target_field_id?: string }[]; error: null } | { data: null; error: { message: string } }>
  deleteResolves?: Record<string, { data: null; error: null } | { data: null; error: { message: string } }>
  // INF-45: select() chain support — needed for the persistMappingSources
  // pass which batch-fetches fields.table_id by source_field_id. Same
  // chain shape as the other ops; resolves to { data, error }. Default
  // is empty data on any unmapped key.
  // INF-53: also used for the coverage + TFM user-lock pre-fetches; the
  // row shape varies by table, so we accept any record array.
  selectResolves?: Record<string, { data: Array<Record<string, unknown>>; error: null } | { data: null; error: { message: string } }>
}) {
  const calls: ChainCall[] = []

  const buildChain = (table: string, op: string, resolveTo: () => unknown) => {
    const chain: Record<string, unknown> = {}
    const noopMethods = ['eq', 'is', 'in', 'neq', 'order', 'limit', 'range']
    for (const m of noopMethods) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: `${op}.${m}`, args })
        return chain
      }
    }
    chain.select = (...args: unknown[]) => {
      calls.push({ table, method: `${op}.select`, args })
      return chain
    }
    chain.then = (onResolve: (v: unknown) => unknown) =>
      Promise.resolve(resolveTo()).then(onResolve)
    return chain
  }

  return {
    admin: {
      from: (table: string) => ({
        insert: (rows: unknown) => {
          calls.push({ table, method: 'insert', args: [rows] })
          const key = `${table}.insert`
          const resolve = opts.insertResolves?.[key] ?? { data: [], error: null }
          return buildChain(table, 'insert', () => resolve)
        },
        upsert: (rows: unknown, options?: unknown) => {
          calls.push({ table, method: 'upsert', args: [rows, options] })
          const key = `${table}.upsert`
          const resolve = opts.upsertResolves?.[key] ?? { data: [], error: null }
          return buildChain(table, 'upsert', () => resolve)
        },
        delete: () => {
          calls.push({ table, method: 'delete', args: [] })
          const key = `${table}.delete`
          const resolve = opts.deleteResolves?.[key] ?? { data: null, error: null }
          return buildChain(table, 'delete', () => resolve)
        },
        select: (...args: unknown[]) => {
          // INF-45: top-level select() (no preceding insert/upsert/delete).
          // Used by persistMappingSources to batch-fetch fields.table_id
          // for source_table_id resolution. The chain returned here
          // accepts .in('id', [...]) and resolves to selectResolves entry.
          calls.push({ table, method: 'select', args })
          const key = `${table}.select`
          const resolve = opts.selectResolves?.[key] ?? { data: [], error: null }
          return buildChain(table, 'select', () => resolve)
        },
      }),
    },
    calls,
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROJECT_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const USER_ID = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const RUN_ID = '33333333-3333-4333-8333-aaaaaaaaaaaa'

const ALL_OK_PARSED: PathDParsedOutput = {
  mappings: {
    status: 'parsed_ok',
    data: [
      {
        target_field_id: '11111111-1111-4111-8111-111111111111',
        source_field_ids: [],
        combination_type: 'single',
        combination_sql: null,
        ai_reasoning: 'Direct.',
        transformation_intent: 'Identity.',
        mapping_cardinality: '1:1',
        dedup_required: false,
        dedup_strategy: null,
        data_quality_flag_indices: [0], // refs DQ #0
        confidence: 0.9,
        status: 'needs_review',
      },
    ],
  },
  coverage: {
    status: 'parsed_ok',
    data: [
      {
        target_field_id: '11111111-1111-4111-8111-111111111111',
        coverage_status: 'covered',
        ai_reasoning: 'Mapped.',
        default_value_recommendation: null,
      },
    ],
  },
  decisions: {
    status: 'parsed_ok',
    data: [
      {
        decision_type: 'picklist_transform',
        title: 'Test',
        description: '',
        ai_recommendation: { option: 'A' },
        alternatives: [],
        applies_to: { tfm_indices: [0] }, // refs TFM #0
        status: 'pending',
      },
    ],
  },
  lookup_tables: { status: 'parsed_ok', data: [] },
  data_quality: {
    status: 'parsed_ok',
    data: [
      {
        source_field_id: null,
        severity: 'warning',
        category: 'test',
        description: 'A DQ finding.',
        example_values: [],
        recommendation: '',
      },
    ],
  },
  inferred_targets: { status: 'parsed_ok', data: [] },
  project_notes: { status: 'parsed_ok', data: 'Notes markdown.' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('persistPathDOutput — happy path with cross-references', () => {
  it('resolves data_quality_flag_indices → dqIds[] when persisting mappings', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': {
          data: [{ id: 'dq-uuid-0' }],
          error: null,
        },
        'project_inferred_targets.insert': { data: [], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-uuid-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [
            {
              id: 'tfm-uuid-0',
              target_field_id: '11111111-1111-4111-8111-111111111111',
            },
          ],
          error: null,
        },
        'target_field_coverage.upsert': {
          data: [
            {
              id: 'cov-uuid-0',
              target_field_id: '11111111-1111-4111-8111-111111111111',
            },
          ],
          error: null,
        },
      },
    })

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    expect(result.data_quality.status).toBe('inserted')
    expect(result.mappings.status).toBe('inserted')
    expect(result.coverage.status).toBe('inserted')
    expect(result.decisions.status).toBe('inserted')

    // Find the mappings upsert call and verify data_quality_flag_ids was
    // resolved from the index [0] to the actual DQ UUID 'dq-uuid-0'.
    const tfmUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    expect(tfmUpsert).toBeDefined()
    const tfmRows = tfmUpsert!.args[0] as Array<{ data_quality_flag_ids: string[] }>
    expect(tfmRows[0].data_quality_flag_ids).toEqual(['dq-uuid-0'])
  })

  it('resolves applies_to.tfm_indices → tfmIds[] when persisting decisions', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-uuid-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-uuid-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [
            {
              id: 'tfm-uuid-0',
              target_field_id: '11111111-1111-4111-8111-111111111111',
            },
          ],
          error: null,
        },
        'target_field_coverage.upsert': { data: [], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    const decInsert = mockResult.calls.find(
      (c) => c.table === 'project_decisions' && c.method === 'insert',
    )
    expect(decInsert).toBeDefined()
    const decRows = decInsert!.args[0] as Array<{ applies_to: { tfm_ids: string[] } }>
    expect(decRows[0].applies_to.tfm_ids).toEqual(['tfm-uuid-0'])
  })

  it('issues idempotency DELETE before INSERT for non-natural-key sections', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_inferred_targets.insert': { data: [], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': { data: [{ id: 'tfm-0', target_field_id: 'x' }], error: null },
        'target_field_coverage.upsert': { data: [], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    // DQ + decisions + inferred_targets + outputs → DELETE before INSERT
    const dqDelete = mockResult.calls.find(
      (c) => c.table === 'project_data_quality_issues' && c.method === 'delete',
    )
    expect(dqDelete).toBeDefined()
    const decDelete = mockResult.calls.find(
      (c) => c.table === 'project_decisions' && c.method === 'delete',
    )
    expect(decDelete).toBeDefined()
    const infDelete = mockResult.calls.find(
      (c) => c.table === 'project_inferred_targets' && c.method === 'delete',
    )
    expect(infDelete).toBeDefined()
    const outDelete = mockResult.calls.find(
      (c) => c.table === 'outputs' && c.method === 'delete',
    )
    expect(outDelete).toBeDefined()
  })

  it('uses UPSERT (not delete-then-insert) for mappings + coverage + lookup_tables', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': { data: [{ id: 'tfm-0', target_field_id: 'x' }], error: null },
        'target_field_coverage.upsert': { data: [{ id: 'cov-0', target_field_id: 'x' }], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    // No DELETE on TFM, coverage, lookup_tables — they upsert by natural key
    expect(
      mockResult.calls.find(
        (c) => c.table === 'target_field_mappings' && c.method === 'delete',
      ),
    ).toBeUndefined()
    expect(
      mockResult.calls.find(
        (c) => c.table === 'target_field_coverage' && c.method === 'delete',
      ),
    ).toBeUndefined()
    expect(
      mockResult.calls.find(
        (c) => c.table === 'project_lookup_tables' && c.method === 'delete',
      ),
    ).toBeUndefined()

    // UPSERTs do happen
    const tfmUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    expect(tfmUpsert).toBeDefined()
    // Verify onConflict option is the natural key
    expect(tfmUpsert!.args[1]).toEqual({ onConflict: 'project_id,target_field_id' })
  })
})

describe('persistPathDOutput — skipped sections do not block downstream', () => {
  it('skipped data_quality (parse_error) does NOT prevent mappings persistence', async () => {
    const mockResult = makeMockAdmin({
      upsertResolves: {
        'target_field_mappings.upsert': { data: [{ id: 'tfm-0', target_field_id: 'x' }], error: null },
        'target_field_coverage.upsert': { data: [], error: null },
      },
    })

    const parsed: PathDParsedOutput = {
      ...ALL_OK_PARSED,
      data_quality: { status: 'parse_error', error: 'broken' },
    }

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed,
    })

    expect(result.data_quality.status).toBe('skipped')
    if (result.data_quality.status === 'skipped') {
      expect(result.data_quality.reason).toContain('broken')
    }
    // Mappings still inserted, but with empty data_quality_flag_ids array
    expect(result.mappings.status).toBe('inserted')
    const tfmUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    const tfmRows = tfmUpsert!.args[0] as Array<{ data_quality_flag_ids: string[] }>
    expect(tfmRows[0].data_quality_flag_ids).toEqual([]) // refs to missing DQ resolve to empty
  })

  it('errored section reports error status without crashing the whole run', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: null, error: { message: 'rls denied' } },
      },
    })

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    expect(result.data_quality.status).toBe('errored')
    if (result.data_quality.status === 'errored') {
      expect(result.data_quality.error).toContain('rls denied')
    }
  })
})

describe('persistPathDOutput — empty sections', () => {
  it('all sections empty arrays produce inserted with count=0', async () => {
    const mockResult = makeMockAdmin({})
    const parsed: PathDParsedOutput = {
      mappings: { status: 'parsed_ok', data: [] },
      coverage: { status: 'parsed_ok', data: [] },
      decisions: { status: 'parsed_ok', data: [] },
      lookup_tables: { status: 'parsed_ok', data: [] },
      data_quality: { status: 'parsed_ok', data: [] },
      inferred_targets: { status: 'parsed_ok', data: [] },
      project_notes: { status: 'parsed_ok', data: 'notes' },
    }

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed,
    })

    expect(result.data_quality.status).toBe('inserted')
    if (result.data_quality.status === 'inserted') expect(result.data_quality.count).toBe(0)
    expect(result.mappings.status).toBe('inserted')
    if (result.mappings.status === 'inserted') expect(result.mappings.count).toBe(0)
    // project_notes always counts as 1 insert (markdown body)
    expect(result.project_notes.status).toBe('inserted')
    if (result.project_notes.status === 'inserted') expect(result.project_notes.count).toBe(1)
  })
})

// ─── INF-45 regression guard: mapping_sources persistence ────────────────────
//
// Pre-INF-45 the TFM UPSERT in Pass 2 silently dropped
// MappingPayload.source_field_ids — every Path D run wrote TFM shells with
// no children rows in mapping_sources, leaving the UI to render every
// Path D-generated mapping as "—" (no source).
//
// These tests pin the contract: when a mapping has non-empty
// source_field_ids, the persistence layer MUST insert one mapping_sources
// row per source field, with the correct target_field_mapping_id,
// source_field_id, source_table_id, and ordinal.
//
// A future refactor that drops the Pass 2.5 wiring or the persistMappingSources
// function would fail Test 1 (the load-bearing positive case) immediately.

const INF45_TARGET_FIELD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INF45_TFM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INF45_SOURCE_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INF45_SOURCE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INF45_SOURCE_TABLE_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const INF45_SOURCE_TABLE_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

function buildInf45Parsed(sourceFieldIds: string[]): PathDParsedOutput {
  return {
    mappings: {
      status: 'parsed_ok',
      data: [
        {
          target_field_id: INF45_TARGET_FIELD_ID,
          source_field_ids: sourceFieldIds,
          combination_type: sourceFieldIds.length > 1 ? 'concat_space' : 'single',
          combination_sql: null,
          ai_reasoning: 'INF-45 fixture',
          transformation_intent: 'Identity.',
          mapping_cardinality: '1:1',
          dedup_required: false,
          dedup_strategy: null,
          data_quality_flag_indices: [],
          confidence: 0.9,
          status: 'needs_review',
        },
      ],
    },
    coverage: { status: 'parsed_ok', data: [] },
    decisions: { status: 'parsed_ok', data: [] },
    lookup_tables: { status: 'parsed_ok', data: [] },
    data_quality: { status: 'parsed_ok', data: [] },
    inferred_targets: { status: 'parsed_ok', data: [] },
    project_notes: { status: 'parsed_ok', data: 'INF-45 notes' },
  }
}

function inf45MockAdminWithFields(fieldRows: { id: string; table_id: string }[]) {
  return makeMockAdmin({
    upsertResolves: {
      'target_field_mappings.upsert': {
        data: [{ id: INF45_TFM_ID, target_field_id: INF45_TARGET_FIELD_ID }],
        error: null,
      },
    },
    selectResolves: {
      'fields.select': { data: fieldRows, error: null },
    },
  })
}

describe('persistPathDOutput — INF-45 mapping_sources regression guard', () => {
  it('positive — writes one mapping_sources row per source_field_id, with correct ordinals', async () => {
    const mockResult = inf45MockAdminWithFields([
      { id: INF45_SOURCE_A, table_id: INF45_SOURCE_TABLE_A },
      { id: INF45_SOURCE_B, table_id: INF45_SOURCE_TABLE_B },
    ])

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildInf45Parsed([INF45_SOURCE_A, INF45_SOURCE_B]),
    })

    // Result section reports inserted with count = number of source rows.
    expect(result.mapping_sources.status).toBe('inserted')
    if (result.mapping_sources.status === 'inserted') {
      expect(result.mapping_sources.count).toBe(2)
    }

    // Mock saw the insert call with 2 rows; verify shape per row.
    const msInsert = mockResult.calls.find(
      (c) => c.table === 'mapping_sources' && c.method === 'insert',
    )
    expect(msInsert).toBeDefined()
    const rows = msInsert!.args[0] as Array<{
      target_field_mapping_id: string
      source_field_id: string
      source_table_id: string
      ordinal: number
    }>
    expect(rows).toHaveLength(2)

    // Row 0 — primary source, ordinal 0
    expect(rows[0]!.target_field_mapping_id).toBe(INF45_TFM_ID)
    expect(rows[0]!.source_field_id).toBe(INF45_SOURCE_A)
    expect(rows[0]!.source_table_id).toBe(INF45_SOURCE_TABLE_A)
    expect(rows[0]!.ordinal).toBe(0)

    // Row 1 — contributor source, ordinal 1 (preserves emit order)
    expect(rows[1]!.target_field_mapping_id).toBe(INF45_TFM_ID)
    expect(rows[1]!.source_field_id).toBe(INF45_SOURCE_B)
    expect(rows[1]!.source_table_id).toBe(INF45_SOURCE_TABLE_B)
    expect(rows[1]!.ordinal).toBe(1)
  })

  it('negative — empty source_field_ids array does NOT trigger mapping_sources insert', async () => {
    // Path D may emit a mapping with zero sources (rare edge case — would
    // be a value-assignment-shaped mapping in Path B terms). The
    // persistence pass must short-circuit cleanly: no fields fetch, no
    // delete, no insert.
    const mockResult = inf45MockAdminWithFields([])

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildInf45Parsed([]),
    })

    expect(result.mapping_sources.status).toBe('inserted')
    if (result.mapping_sources.status === 'inserted') {
      expect(result.mapping_sources.count).toBe(0)
    }

    // Verify the early-return short-circuit: no mapping_sources insert,
    // no mapping_sources delete, no fields select. The upstream TFM
    // upsert still happened, but Pass 2.5 produced zero side effects.
    const msInsert = mockResult.calls.find(
      (c) => c.table === 'mapping_sources' && c.method === 'insert',
    )
    expect(msInsert).toBeUndefined()
    const msDelete = mockResult.calls.find(
      (c) => c.table === 'mapping_sources' && c.method === 'delete',
    )
    expect(msDelete).toBeUndefined()
    const fieldsSelect = mockResult.calls.find(
      (c) => c.table === 'fields' && c.method === 'select',
    )
    expect(fieldsSelect).toBeUndefined()
  })

  it('re-run idempotency — DELETE precedes INSERT and is filtered to upserted TFM ids', async () => {
    // The TFM UPSERT preserves ids across runs. mapping_sources
    // therefore must explicitly clear stale rows before inserting fresh
    // ones — otherwise a re-run that emits fewer sources for a TFM
    // would leave orphan associations behind. This test pins the
    // DELETE-before-INSERT order AND verifies the DELETE is scoped to
    // the upserted TFM ids (not project-wide). A future refactor that
    // drops the DELETE step would fail this test.
    const mockResult = inf45MockAdminWithFields([
      { id: INF45_SOURCE_A, table_id: INF45_SOURCE_TABLE_A },
    ])

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildInf45Parsed([INF45_SOURCE_A]),
    })

    const calls = mockResult.calls
    const msDeleteIdx = calls.findIndex(
      (c) => c.table === 'mapping_sources' && c.method === 'delete',
    )
    const msDeleteFilterIdx = calls.findIndex(
      (c) => c.table === 'mapping_sources' && c.method === 'delete.in',
    )
    const msInsertIdx = calls.findIndex(
      (c) => c.table === 'mapping_sources' && c.method === 'insert',
    )

    // Order invariant: delete → delete.in → insert.
    expect(msDeleteIdx).toBeGreaterThanOrEqual(0)
    expect(msDeleteFilterIdx).toBeGreaterThan(msDeleteIdx)
    expect(msInsertIdx).toBeGreaterThan(msDeleteFilterIdx)

    // Filter scope: the .in() filter targets the upserted TFM ids
    // (NOT a blanket project-wide delete). Verifies the surgical
    // scoping that prevents accidental cross-project deletion.
    const filterCall = calls[msDeleteFilterIdx]!
    expect(filterCall.args[0]).toBe('target_field_mapping_id')
    expect(filterCall.args[1]).toEqual([INF45_TFM_ID])
  })
})

// ─── Flat-view confidence bug — mapping_sources.confidence propagation ───────
//
// Before this fix, persistMappingSources hard-coded `confidence: null` on
// every inserted row. Because the DB-side trigger
// `mapping_sources_confidence_recompute` (migration 074 STEP 4) runs
// `SET TFM.confidence = MIN(mapping_sources.confidence)` after every
// source INSERT, the all-NULL set produced MIN=NULL and clobbered the
// TFM's Path-D-emitted 0-1 confidence to NULL — leaving the flat
// (spreadsheet) Mapping view to render "—" for every Path-D-generated
// mapped TFM, and the per-source rows alongside.
//
// The fix propagates the parent MappingPayload's `confidence` onto each
// inserted mapping_source row (same value for all sources of a TFM —
// Path D's schema carries one confidence per mapping, not per source).
// MIN of identical values equals the value, so the trigger no longer
// overwrites a meaningful TFM.confidence with NULL.
//
// These tests pin: (1) the wire shape includes a non-null confidence
// matching the parent payload, (2) NULL on the payload (defensive)
// still maps to NULL on the rows.

describe('persistPathDOutput — flat-view confidence propagation', () => {
  it('propagates parent MappingPayload.confidence onto every mapping_source row', async () => {
    const mockResult = inf45MockAdminWithFields([
      { id: INF45_SOURCE_A, table_id: INF45_SOURCE_TABLE_A },
      { id: INF45_SOURCE_B, table_id: INF45_SOURCE_TABLE_B },
    ])

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildInf45Parsed([INF45_SOURCE_A, INF45_SOURCE_B]),
    })

    const msInsert = mockResult.calls.find(
      (c) => c.table === 'mapping_sources' && c.method === 'insert',
    )
    expect(msInsert).toBeDefined()
    const rows = msInsert!.args[0] as Array<{
      target_field_mapping_id: string
      source_field_id: string
      confidence: number | null
    }>
    expect(rows).toHaveLength(2)

    // buildInf45Parsed pins parent confidence to 0.9. Both source rows
    // must carry the same value so the trigger's MIN computes 0.9 (not
    // NULL) and TFM.confidence survives the recompute.
    expect(rows[0]!.confidence).toBe(0.9)
    expect(rows[1]!.confidence).toBe(0.9)
  })

  it('passes through null when the parent MappingPayload omits confidence (defensive)', async () => {
    // Build a payload with `confidence: undefined` (Zod allows .optional()
    // on path-d-parser.ts:49). The persistence layer must NOT crash and
    // must write null — matches the pre-fix safety net for malformed
    // payloads.
    const parsed = buildInf45Parsed([INF45_SOURCE_A])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(parsed.mappings as any).data[0].confidence = undefined

    const mockResult = inf45MockAdminWithFields([
      { id: INF45_SOURCE_A, table_id: INF45_SOURCE_TABLE_A },
    ])

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed,
    })

    const msInsert = mockResult.calls.find(
      (c) => c.table === 'mapping_sources' && c.method === 'insert',
    )
    const rows = msInsert!.args[0] as Array<{ confidence: number | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.confidence).toBeNull()
  })
})

// ── INF-53: re-run preserves user-set status ───────────────────────────────
//
// Pre-INF-53 the coverage + TFM UPSERTs unconditionally overwrote `status`
// on every Path D re-run, silently clobbering user approve/reject decisions.
// These tests verify the pre-fetch + selective-preserve merge logic:
//
//   * coverage rows with status_set_by='user' keep their status +
//     status_set_by; AI metadata (coverage_status, ai_reasoning,
//     default_value_recommendation, confidence) refreshes on every run
//   * TFM rows with status IN ('approved', 'rejected') keep their status;
//     AI metadata (ai_reasoning, transformation_intent, confidence, etc.)
//     refreshes
//   * non-locked rows continue to receive the AI default ('needs_review')
//
// The chain-mock's top-level `select()` resolves to the configured
// `selectResolves[<table>.select]` entry, which simulates the user-lock
// fetch result.

const LOCKED_TARGET_FIELD_ID = '11111111-1111-4111-8111-111111111111'

describe('persistPathDOutput — INF-53 user-lock preservation on re-run', () => {
  it('coverage: preserves status + status_set_by for user-locked rows on re-run', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
        'target_field_coverage.upsert': {
          data: [{ id: 'cov-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
      },
      selectResolves: {
        // Simulate one user-approved coverage row already on the project.
        'target_field_coverage.select': {
          data: [{ target_field_id: LOCKED_TARGET_FIELD_ID, status: 'approved' }],
          error: null,
        },
        // No user-locked TFMs in this scenario.
        'target_field_mappings.select': { data: [], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      // The fixture's coverage entry has coverage_status='covered' (AI's
      // new verdict) — locked status should NOT change to 'needs_review'.
      parsed: ALL_OK_PARSED,
    })

    const covUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_coverage' && c.method === 'upsert',
    )
    expect(covUpsert).toBeDefined()
    const rows = covUpsert!.args[0] as Array<{
      target_field_id: string
      status: string
      status_set_by: string
      coverage_status: string
      ai_reasoning: string | null
    }>
    const lockedRow = rows.find((r) => r.target_field_id === LOCKED_TARGET_FIELD_ID)
    expect(lockedRow).toBeDefined()
    // User decision preserved.
    expect(lockedRow!.status).toBe('approved')
    expect(lockedRow!.status_set_by).toBe('user')
    // AI metadata refreshed (locked semantic = "respect my decision," not
    // "freeze the AI commentary").
    expect(lockedRow!.coverage_status).toBe('covered')
    expect(lockedRow!.ai_reasoning).toBe('Mapped.')
  })

  it('coverage: non-locked rows still default to needs_review + ai_auto', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
        'target_field_coverage.upsert': {
          data: [{ id: 'cov-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
      },
      // No user locks at all — selectResolves left unset; mock defaults
      // to empty data → empty user-lock Maps.
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    const covUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_coverage' && c.method === 'upsert',
    )
    const rows = covUpsert!.args[0] as Array<{
      status: string
      status_set_by: string
    }>
    expect(rows[0].status).toBe('needs_review')
    expect(rows[0].status_set_by).toBe('ai_auto')
  })

  it("TFM: preserves status='approved' for user-locked TFMs on re-run", async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
        'target_field_coverage.upsert': {
          data: [{ id: 'cov-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
      },
      selectResolves: {
        // Simulate one user-approved TFM already on the project.
        'target_field_mappings.select': {
          data: [{ target_field_id: LOCKED_TARGET_FIELD_ID, status: 'approved' }],
          error: null,
        },
        'target_field_coverage.select': { data: [], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      // Fixture emits status='needs_review' (the AI default) — locked
      // status should NOT collapse back to needs_review.
      parsed: ALL_OK_PARSED,
    })

    const tfmUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    expect(tfmUpsert).toBeDefined()
    const rows = tfmUpsert!.args[0] as Array<{
      target_field_id: string
      status: string
      ai_reasoning: string
      confidence: number | null
    }>
    const lockedRow = rows.find((r) => r.target_field_id === LOCKED_TARGET_FIELD_ID)
    expect(lockedRow).toBeDefined()
    // User approval preserved.
    expect(lockedRow!.status).toBe('approved')
    // AI metadata refreshed.
    expect(lockedRow!.ai_reasoning).toBe('Direct.')
    expect(lockedRow!.confidence).toBe(0.9)
  })

  it("TFM: preserves status='rejected' for user-rejected TFMs on re-run", async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
        'target_field_coverage.upsert': { data: [], error: null },
      },
      selectResolves: {
        // Simulate a legacy SimpleLegal-style rejected TFM (rare; pre-
        // Gap-9 reject==delete amendment, but the lock still applies).
        'target_field_mappings.select': {
          data: [{ target_field_id: LOCKED_TARGET_FIELD_ID, status: 'rejected' }],
          error: null,
        },
        'target_field_coverage.select': { data: [], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    const tfmUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    const rows = tfmUpsert!.args[0] as Array<{ status: string }>
    expect(rows[0].status).toBe('rejected')
  })

  it('TFM: non-locked rows still write the AI default status', async () => {
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
        'target_field_coverage.upsert': { data: [], error: null },
      },
      // No locks set — empty data on user-lock fetches.
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    const tfmUpsert = mockResult.calls.find(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    const rows = tfmUpsert!.args[0] as Array<{ status: string }>
    expect(rows[0].status).toBe('needs_review')
  })

  it('issues a user-lock SELECT on each surface before the UPSERT', async () => {
    // Order invariant: SELECT (user-lock fetch) must precede the UPSERT
    // for both coverage and TFM. A future refactor that moves the SELECT
    // after the UPSERT would silently regress to the pre-INF-53 clobber
    // behaviour.
    const mockResult = makeMockAdmin({
      insertResolves: {
        'project_data_quality_issues.insert': { data: [{ id: 'dq-0' }], error: null },
        'project_decisions.insert': { data: [{ id: 'dec-0' }], error: null },
        'outputs.insert': { data: [], error: null },
      },
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-0', target_field_id: LOCKED_TARGET_FIELD_ID }],
          error: null,
        },
        'target_field_coverage.upsert': { data: [], error: null },
      },
    })

    await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: ALL_OK_PARSED,
    })

    const calls = mockResult.calls
    const tfmSelectIdx = calls.findIndex(
      (c) => c.table === 'target_field_mappings' && c.method === 'select',
    )
    const tfmUpsertIdx = calls.findIndex(
      (c) => c.table === 'target_field_mappings' && c.method === 'upsert',
    )
    const covSelectIdx = calls.findIndex(
      (c) => c.table === 'target_field_coverage' && c.method === 'select',
    )
    const covUpsertIdx = calls.findIndex(
      (c) => c.table === 'target_field_coverage' && c.method === 'upsert',
    )
    expect(tfmSelectIdx).toBeGreaterThanOrEqual(0)
    expect(tfmUpsertIdx).toBeGreaterThan(tfmSelectIdx)
    expect(covSelectIdx).toBeGreaterThanOrEqual(0)
    expect(covUpsertIdx).toBeGreaterThan(covSelectIdx)
  })
})

// ─── Transform-page fix: Pass 2.6 table_mappings persistence ─────────────────
//
// Path D originally skipped `table_mappings` entirely — its data model is
// TFM-centric and the redesigned Mapping read path doesn't need TM rows.
// But `getTransformData` (lib/actions/transformations.ts:551), readiness-
// score, fix-target, and detection-engine-core all gate on
// `table_mappings.length > 0` for the project. Without TMs, every Path
// D-only project showed an empty Transform page despite having approved
// TFMs in the Mapping page.
//
// Pass 2.6 derives one TM per unique (source_table_id, target_table_id)
// pair implied by MappingPayload.source_field_ids × target_field_id,
// dedupes against existing TMs, and inserts the rest with
// status='needs_review'. These tests pin:
//   1) positive single-source pair → 1 TM insert
//   2) multi-source-table TFM (sources span 2 source_tables) → 2 TMs
//   3) VA-only mappings (every source_field_ids is empty) → 0 TMs
//   4) idempotency: existing-pair pre-fetch filters duplicates
//   5) skipped when parsed.mappings.status !== 'parsed_ok'

const TM_TGT_FIELD_1 = '99999999-9999-4999-8999-aaaaaaaaaaaa'
const TM_TGT_FIELD_2 = '99999999-9999-4999-8999-bbbbbbbbbbbb'
const TM_TGT_TABLE_X = '88888888-8888-4888-8888-aaaaaaaaaaaa'
const TM_TGT_TABLE_Y = '88888888-8888-4888-8888-bbbbbbbbbbbb'
const TM_SRC_FIELD_A = '77777777-7777-4777-8777-aaaaaaaaaaaa'
const TM_SRC_FIELD_B = '77777777-7777-4777-8777-bbbbbbbbbbbb'
const TM_SRC_TABLE_P = '66666666-6666-4666-8666-aaaaaaaaaaaa'
const TM_SRC_TABLE_Q = '66666666-6666-4666-8666-bbbbbbbbbbbb'

function buildTmMapping(
  targetFieldId: string,
  sourceFieldIds: string[],
): MappingPayloadFixture {
  return {
    target_field_id: targetFieldId,
    source_field_ids: sourceFieldIds,
    combination_type: sourceFieldIds.length > 1 ? 'concat_space' : 'single',
    combination_sql: null,
    ai_reasoning: 'TM fixture',
    transformation_intent: 'Identity.',
    mapping_cardinality: '1:1',
    dedup_required: false,
    dedup_strategy: null,
    data_quality_flag_indices: [],
    confidence: 0.9,
    status: 'needs_review',
  }
}

// Local helper type — mirrors MappingPayload shape from path-d-parser without
// re-importing it here. Used only by buildTmMapping for the table_mappings
// test block; an `any`-cast plugs it into PathDParsedOutput.mappings.data
// in the same pattern as buildInf45Parsed (which also returns a literal).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MappingPayloadFixture = any

function buildTmParsed(
  mappings: MappingPayloadFixture[],
): PathDParsedOutput {
  return {
    mappings: { status: 'parsed_ok', data: mappings },
    coverage: { status: 'parsed_ok', data: [] },
    decisions: { status: 'parsed_ok', data: [] },
    lookup_tables: { status: 'parsed_ok', data: [] },
    data_quality: { status: 'parsed_ok', data: [] },
    inferred_targets: { status: 'parsed_ok', data: [] },
    project_notes: { status: 'parsed_ok', data: 'TM notes' },
  }
}

describe('persistPathDOutput — Pass 2.6 table_mappings (Transform-page fix)', () => {
  it('positive — derives one TM per (source_table, target_table) pair and inserts with status=needs_review', async () => {
    const mockResult = makeMockAdmin({
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [
            { id: 'tfm-tm-1', target_field_id: TM_TGT_FIELD_1 },
            { id: 'tfm-tm-2', target_field_id: TM_TGT_FIELD_2 },
          ],
          error: null,
        },
      },
      selectResolves: {
        'fields.select': {
          data: [
            // Source fields → source_table_P / Q
            { id: TM_SRC_FIELD_A, table_id: TM_SRC_TABLE_P },
            { id: TM_SRC_FIELD_B, table_id: TM_SRC_TABLE_Q },
            // Target fields → target_table_X / Y
            { id: TM_TGT_FIELD_1, table_id: TM_TGT_TABLE_X },
            { id: TM_TGT_FIELD_2, table_id: TM_TGT_TABLE_Y },
          ],
          error: null,
        },
        'table_mappings.select': { data: [], error: null },
      },
    })

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildTmParsed([
        // mapping 1: src_A (table_P) → tgt_field_1 (table_X)
        buildTmMapping(TM_TGT_FIELD_1, [TM_SRC_FIELD_A]),
        // mapping 2: src_B (table_Q) → tgt_field_2 (table_Y)
        buildTmMapping(TM_TGT_FIELD_2, [TM_SRC_FIELD_B]),
      ]),
    })

    expect(result.table_mappings.status).toBe('inserted')
    if (result.table_mappings.status === 'inserted') {
      expect(result.table_mappings.count).toBe(2)
    }

    const tmInsert = mockResult.calls.find(
      (c) => c.table === 'table_mappings' && c.method === 'insert',
    )
    expect(tmInsert).toBeDefined()
    const rows = tmInsert!.args[0] as Array<{
      project_id: string
      source_table_id: string
      target_table_id: string
      status: string
      confidence: number | null
      ai_reasoning: string | null
    }>
    expect(rows).toHaveLength(2)
    // Pair (table_P, table_X) and (table_Q, table_Y) — order is Set-iteration
    // dependent, so sort for stable comparison.
    const sorted = [...rows].sort((a, b) =>
      a.source_table_id.localeCompare(b.source_table_id),
    )
    expect(sorted[0]!.source_table_id).toBe(TM_SRC_TABLE_P)
    expect(sorted[0]!.target_table_id).toBe(TM_TGT_TABLE_X)
    expect(sorted[1]!.source_table_id).toBe(TM_SRC_TABLE_Q)
    expect(sorted[1]!.target_table_id).toBe(TM_TGT_TABLE_Y)
    // All rows: needs_review, null confidence, null ai_reasoning — mirrors
    // the legacy writer at lib/ai/mapping-engine.ts:1986-1997.
    for (const r of rows) {
      expect(r.project_id).toBe(PROJECT_ID)
      expect(r.status).toBe('needs_review')
      expect(r.confidence).toBeNull()
      expect(r.ai_reasoning).toBeNull()
    }
  })

  it('multi-source-table TFM — single TFM whose sources span 2 source_tables produces 2 TM pairs', async () => {
    // One TFM, two sources from different source_tables, one target_table.
    // Both (P→X) and (Q→X) pairs are real distinct apply batches — the
    // downstream apply machinery joins on (source_table, target_table)
    // to fetch staged rows. Test #7 in the wild has 4 TFMs with this shape.
    const mockResult = makeMockAdmin({
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [{ id: 'tfm-multi', target_field_id: TM_TGT_FIELD_1 }],
          error: null,
        },
      },
      selectResolves: {
        'fields.select': {
          data: [
            { id: TM_SRC_FIELD_A, table_id: TM_SRC_TABLE_P },
            { id: TM_SRC_FIELD_B, table_id: TM_SRC_TABLE_Q },
            { id: TM_TGT_FIELD_1, table_id: TM_TGT_TABLE_X },
          ],
          error: null,
        },
        'table_mappings.select': { data: [], error: null },
      },
    })

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildTmParsed([
        // One TFM, sources spanning 2 distinct source_tables
        buildTmMapping(TM_TGT_FIELD_1, [TM_SRC_FIELD_A, TM_SRC_FIELD_B]),
      ]),
    })

    expect(result.table_mappings.status).toBe('inserted')
    if (result.table_mappings.status === 'inserted') {
      expect(result.table_mappings.count).toBe(2)
    }

    const tmInsert = mockResult.calls.find(
      (c) => c.table === 'table_mappings' && c.method === 'insert',
    )
    const rows = tmInsert!.args[0] as Array<{
      source_table_id: string
      target_table_id: string
    }>
    expect(rows).toHaveLength(2)
    const pairKeys = new Set(
      rows.map((r) => `${r.source_table_id}::${r.target_table_id}`),
    )
    expect(pairKeys.has(`${TM_SRC_TABLE_P}::${TM_TGT_TABLE_X}`)).toBe(true)
    expect(pairKeys.has(`${TM_SRC_TABLE_Q}::${TM_TGT_TABLE_X}`)).toBe(true)
  })

  it('VA-only mappings — all source_field_ids empty → zero TMs, no fields.select, no insert', async () => {
    // Every MappingPayload has source_field_ids: []. Pass 2.6 must short-
    // circuit BEFORE the fields.select round-trip — verifies the early-out
    // that keeps Pass 2.5's "no fields.select on VA-only" invariant intact.
    const mockResult = makeMockAdmin({
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [
            { id: 'tfm-va-1', target_field_id: TM_TGT_FIELD_1 },
            { id: 'tfm-va-2', target_field_id: TM_TGT_FIELD_2 },
          ],
          error: null,
        },
      },
    })

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildTmParsed([
        buildTmMapping(TM_TGT_FIELD_1, []),
        buildTmMapping(TM_TGT_FIELD_2, []),
      ]),
    })

    expect(result.table_mappings.status).toBe('inserted')
    if (result.table_mappings.status === 'inserted') {
      expect(result.table_mappings.count).toBe(0)
    }

    // No insert into table_mappings.
    const tmInsert = mockResult.calls.find(
      (c) => c.table === 'table_mappings' && c.method === 'insert',
    )
    expect(tmInsert).toBeUndefined()
    // No fields.select, no table_mappings.select (the existing-pair lookup
    // is skipped by the early-out).
    const fieldsSelect = mockResult.calls.find(
      (c) => c.table === 'fields' && c.method === 'select',
    )
    expect(fieldsSelect).toBeUndefined()
    const tmSelect = mockResult.calls.find(
      (c) => c.table === 'table_mappings' && c.method === 'select',
    )
    expect(tmSelect).toBeUndefined()
  })

  it('idempotency — existing (source,target) pair pre-fetched and skipped on re-run', async () => {
    // Simulate a re-run: the second pair already exists in table_mappings.
    // Only the missing pair should be inserted.
    const mockResult = makeMockAdmin({
      upsertResolves: {
        'target_field_mappings.upsert': {
          data: [
            { id: 'tfm-id-1', target_field_id: TM_TGT_FIELD_1 },
            { id: 'tfm-id-2', target_field_id: TM_TGT_FIELD_2 },
          ],
          error: null,
        },
      },
      selectResolves: {
        'fields.select': {
          data: [
            { id: TM_SRC_FIELD_A, table_id: TM_SRC_TABLE_P },
            { id: TM_SRC_FIELD_B, table_id: TM_SRC_TABLE_Q },
            { id: TM_TGT_FIELD_1, table_id: TM_TGT_TABLE_X },
            { id: TM_TGT_FIELD_2, table_id: TM_TGT_TABLE_Y },
          ],
          error: null,
        },
        'table_mappings.select': {
          // Pre-existing TM for the (P → X) pair.
          data: [
            { source_table_id: TM_SRC_TABLE_P, target_table_id: TM_TGT_TABLE_X },
          ],
          error: null,
        },
      },
    })

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed: buildTmParsed([
        buildTmMapping(TM_TGT_FIELD_1, [TM_SRC_FIELD_A]), // P → X (exists)
        buildTmMapping(TM_TGT_FIELD_2, [TM_SRC_FIELD_B]), // Q → Y (new)
      ]),
    })

    expect(result.table_mappings.status).toBe('inserted')
    if (result.table_mappings.status === 'inserted') {
      expect(result.table_mappings.count).toBe(1)
    }

    const tmInsert = mockResult.calls.find(
      (c) => c.table === 'table_mappings' && c.method === 'insert',
    )
    expect(tmInsert).toBeDefined()
    const rows = tmInsert!.args[0] as Array<{
      source_table_id: string
      target_table_id: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source_table_id).toBe(TM_SRC_TABLE_Q)
    expect(rows[0]!.target_table_id).toBe(TM_TGT_TABLE_Y)
  })

  it('skipped when parsed.mappings.status !== parsed_ok — no fields.select, no table_mappings ops', async () => {
    const mockResult = makeMockAdmin({})
    const parsed: PathDParsedOutput = {
      mappings: { status: 'parse_error', error: 'malformed JSON' },
      coverage: { status: 'parsed_ok', data: [] },
      decisions: { status: 'parsed_ok', data: [] },
      lookup_tables: { status: 'parsed_ok', data: [] },
      data_quality: { status: 'parsed_ok', data: [] },
      inferred_targets: { status: 'parsed_ok', data: [] },
      project_notes: { status: 'parsed_ok', data: '' },
    }

    const result = await persistPathDOutput({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseAdmin: mockResult.admin as any,
      projectId: PROJECT_ID,
      userId: USER_ID,
      experimentRunId: RUN_ID,
      parsed,
    })

    expect(result.table_mappings.status).toBe('skipped')
    if (result.table_mappings.status === 'skipped') {
      expect(result.table_mappings.reason).toBe('mappings section not parsed_ok')
    }

    // No table_mappings ops were issued at all.
    const anyTmCall = mockResult.calls.find((c) => c.table === 'table_mappings')
    expect(anyTmCall).toBeUndefined()
  })
})
