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
