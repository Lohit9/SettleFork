// @vitest-environment node
//
// PR 3.3 — unit tests for the agent-tool handler factories
// (`makeQueryFieldDataHandler`, `makeCountDistinctPatternsHandler`,
// `makeCrossFieldCorrelationHandler`). The supabase client is mocked
// at the rpc() boundary; no real Supabase calls.
//
// Coverage per factory: happy path + input validation + error
// classification (RLS denial fatal, where_filter rejection retryable,
// statement timeout retryable).

import { describe, expect, it, vi } from 'vitest'

import {
  makeCountDistinctPatternsHandler,
  makeCrossFieldCorrelationHandler,
  makeQueryFieldDataHandler,
} from '@/lib/ai/agent-tools'

// ─── Mock supabase client helper ─────────────────────────────────────────────

interface MockRpcCall {
  fn: string
  args: Record<string, unknown>
}

function mockSupabase(rpcImpl: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: MockRpcCall[] = []
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      try {
        const data = rpcImpl(fn, args)
        return { data, error: null }
      } catch (err) {
        return { data: null, error: err as Error }
      }
    }),
  } as unknown as Parameters<typeof makeQueryFieldDataHandler>[0]['supabase']
  return { client, calls }
}

const baseDeps = {
  projectId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
}

const VALID_TABLE_ID = '11111111-1111-1111-1111-111111111111'

// ─── B1: query_field_data ────────────────────────────────────────────────────

describe('makeQueryFieldDataHandler — happy path', () => {
  it('invokes RPC with mapped args; returns serialized JSONB result + metadata', async () => {
    const { client, calls } = mockSupabase(() => ({
      values: ['Alice', 'Bob', null],
      total_returned: 3,
      total_in_table_estimate: 1000,
    }))
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })

    const result = await handler({
      table_id: VALID_TABLE_ID,
      field_name: 'name',
      where_filter: "row_data->>'name' IS NULL",
      limit: 5,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.fn).toBe('agent_query_field_data')
    expect(calls[0]!.args).toMatchObject({
      p_project_id: baseDeps.projectId,
      p_table_id: VALID_TABLE_ID,
      p_field_name: 'name',
      p_where_filter: "row_data->>'name' IS NULL",
      p_limit: 5,
    })

    expect(result.fatal).toBeUndefined()
    const parsed = JSON.parse(result.result)
    expect(parsed.values).toEqual(['Alice', 'Bob', null])
    expect(result.metadata).toMatchObject({
      tool: 'query_field_data',
      table_id: VALID_TABLE_ID,
      field_name: 'name',
      limit: 5,
      where_filter: "row_data->>'name' IS NULL",
    })
  })
})

describe('makeQueryFieldDataHandler — validation', () => {
  it('rejects non-UUID table_id without calling the RPC; returns retryable error', async () => {
    const { client, calls } = mockSupabase(() => ({}))
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: 'not-a-uuid', field_name: 'name' })
    expect(calls).toHaveLength(0)
    expect(result.fatal).toBe(false)
    expect(JSON.parse(result.result).error).toMatch(/table_id must be a UUID/)
  })

  it('rejects empty/invalid field_name without calling the RPC', async () => {
    const { client, calls } = mockSupabase(() => ({}))
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: '' })
    expect(calls).toHaveLength(0)
    expect(result.fatal).toBe(false)
    expect(JSON.parse(result.result).error).toMatch(/field_name must be a non-empty string/)
  })

  it('rejects field_name with JSONB-operator characters', async () => {
    const { client, calls } = mockSupabase(() => ({}))
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: "row_data->>'x'" })
    expect(calls).toHaveLength(0)
    expect(result.fatal).toBe(false)
    expect(JSON.parse(result.result).error).toMatch(/bare identifier/)
  })

  it('clamps limit to 50 server-side (client also clamps as defensive belt)', async () => {
    const { client, calls } = mockSupabase(() => ({ values: [], total_returned: 0, total_in_table_estimate: 0 }))
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    await handler({ table_id: VALID_TABLE_ID, field_name: 'name', limit: 999 })
    expect(calls[0]!.args.p_limit).toBe(50)
  })
})

describe('makeQueryFieldDataHandler — error classification', () => {
  it("'Access denied' from RPC → fatal=true", async () => {
    const { client } = mockSupabase(() => {
      throw new Error('Access denied')
    })
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: 'name' })
    expect(result.fatal).toBe(true)
    expect(JSON.parse(result.result).error).toMatch(/Access denied/)
  })

  it("'Table not in project' from RPC → fatal=true", async () => {
    const { client } = mockSupabase(() => {
      throw new Error('Table not in project')
    })
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: 'name' })
    expect(result.fatal).toBe(true)
  })

  it("'Unsafe where_filter' from RPC → fatal=false (retryable)", async () => {
    const { client } = mockSupabase(() => {
      throw new Error('Unsafe where_filter')
    })
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({
      table_id: VALID_TABLE_ID,
      field_name: 'name',
      where_filter: 'DROP TABLE data_rows',
    })
    expect(result.fatal).toBe(false)
    expect(JSON.parse(result.result).error).toMatch(/safety allowlist/)
  })

  it('statement timeout → fatal=false with retry hint', async () => {
    const { client } = mockSupabase(() => {
      throw new Error('canceling statement due to statement timeout')
    })
    const handler = makeQueryFieldDataHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: 'name' })
    expect(result.fatal).toBe(false)
    expect(JSON.parse(result.result).error).toMatch(/timed out/)
    expect(JSON.parse(result.result).error).toMatch(/tighter filter/)
  })
})

// ─── B2: count_distinct_patterns ─────────────────────────────────────────────

describe('makeCountDistinctPatternsHandler', () => {
  it('happy path: invokes RPC; returns serialized result', async () => {
    const { client, calls } = mockSupabase(() => ({
      patterns: [
        { value: 'US', count: 100, percent: 0.5 },
        { value: 'CA', count: 50, percent: 0.25 },
      ],
      total_distinct: 5,
      truncated: false,
    }))
    const handler = makeCountDistinctPatternsHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: 'country', limit: 10 })

    expect(calls[0]!.fn).toBe('agent_count_distinct_patterns')
    expect(calls[0]!.args.p_limit).toBe(10)
    expect(JSON.parse(result.result).patterns).toHaveLength(2)
  })

  it('clamps limit to 30 server-side ceiling', async () => {
    const { client, calls } = mockSupabase(() => ({ patterns: [], total_distinct: 0, truncated: false }))
    const handler = makeCountDistinctPatternsHandler({ supabase: client, ...baseDeps })
    await handler({ table_id: VALID_TABLE_ID, field_name: 'x', limit: 100 })
    expect(calls[0]!.args.p_limit).toBe(30)
  })

  it("'Access denied' → fatal=true", async () => {
    const { client } = mockSupabase(() => {
      throw new Error('Access denied')
    })
    const handler = makeCountDistinctPatternsHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: VALID_TABLE_ID, field_name: 'name' })
    expect(result.fatal).toBe(true)
  })

  it('rejects invalid table_id without calling RPC', async () => {
    const { client, calls } = mockSupabase(() => ({}))
    const handler = makeCountDistinctPatternsHandler({ supabase: client, ...baseDeps })
    const result = await handler({ table_id: 'bad', field_name: 'name' })
    expect(calls).toHaveLength(0)
    expect(result.fatal).toBe(false)
  })
})

// ─── B3: cross_field_correlation ─────────────────────────────────────────────

describe('makeCrossFieldCorrelationHandler', () => {
  it('happy path: invokes RPC with both field names; returns serialized result', async () => {
    const { client, calls } = mockSupabase(() => ({
      joint_top: [{ a: 'Won', b: '12500', count: 10 }],
      conditional_null_rates: [{ a_value: 'Won', a_count: 10, b_null_count: 1, b_null_rate: 0.1 }],
    }))
    const handler = makeCrossFieldCorrelationHandler({ supabase: client, ...baseDeps })
    const result = await handler({
      table_id: VALID_TABLE_ID,
      field_a_name: 'stage',
      field_b_name: 'amount',
    })

    expect(calls[0]!.fn).toBe('agent_cross_field_correlation')
    expect(calls[0]!.args).toMatchObject({
      p_project_id: baseDeps.projectId,
      p_table_id: VALID_TABLE_ID,
      p_field_a_name: 'stage',
      p_field_b_name: 'amount',
    })
    expect(JSON.parse(result.result).joint_top).toHaveLength(1)
  })

  it('rejects invalid field_a_name OR field_b_name without calling RPC', async () => {
    const { client, calls } = mockSupabase(() => ({}))
    const handler = makeCrossFieldCorrelationHandler({ supabase: client, ...baseDeps })
    const r1 = await handler({ table_id: VALID_TABLE_ID, field_a_name: '', field_b_name: 'x' })
    expect(r1.fatal).toBe(false)
    expect(JSON.parse(r1.result).error).toMatch(/field_a_name/)
    const r2 = await handler({ table_id: VALID_TABLE_ID, field_a_name: 'x', field_b_name: 'bad-name!' })
    expect(r2.fatal).toBe(false)
    expect(JSON.parse(r2.result).error).toMatch(/field_b_name/)
    expect(calls).toHaveLength(0)
  })

  it("'Table not in project' → fatal=true", async () => {
    const { client } = mockSupabase(() => {
      throw new Error('Table not in project')
    })
    const handler = makeCrossFieldCorrelationHandler({ supabase: client, ...baseDeps })
    const result = await handler({
      table_id: VALID_TABLE_ID,
      field_a_name: 'a',
      field_b_name: 'b',
    })
    expect(result.fatal).toBe(true)
  })
})
