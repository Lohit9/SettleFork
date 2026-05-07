/**
 * removeTable server action tests.
 *
 * Covers the auth/permission boundary, error paths, the happy path, AND
 * the orphan-TFM cleanup filter logic (the only novel surface in this PR).
 *
 * Cascade behavior (fields → data_rows → mapping_sources → TFMs etc.) is
 * guaranteed by FK constraints in migrations 002 / 074 / 093 and is NOT
 * re-tested here — those FK declarations are themselves the contract.
 *
 * Test pattern: mocked (Option A from the PR review). Real-DB integration
 * coverage is deferred to INF-35; the chain-call tracking below pins the
 * filter parameters (combination_type allowlist, is_acknowledged exclusion)
 * structurally, which is the only way a regression in the cleanup filter
 * could silently corrupt user data.
 *
 * Mocked auth via vi.mock pattern from mapping-persistence-write-path.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (vi.hoisted shared state) ─────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getUser: vi.fn(),
    requirePerm: vi.fn(),
    logActivity: vi.fn(),
    // Per-test override for what the supabase admin mock returns.
    tablesLookup: { data: null as unknown, error: null as unknown },
    tablesDelete: { error: null as unknown },
    tfmCandidates: { data: [] as unknown[], error: null as unknown },
    tfmDelete: { error: null as unknown },
    // Chain-call tracker for the target_field_mappings table. Each method
    // call captures { method, args } so tests can assert on the filter
    // parameters that were applied to the candidate-load + orphan-delete
    // queries.
    tfmChainCalls: [] as Array<{ method: string; args: unknown[] }>,
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => mocks.getUser() },
  }),
}))

vi.mock('@/lib/supabase/admin', () => {
  // Generic chain builder that resolves to a per-table override on `mocks`.
  // Records every method invocation on the target_field_mappings chain
  // into mocks.tfmChainCalls so tests can verify filter parameters.
  const buildChain = (resolveTo: () => unknown, track: boolean) => {
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'neq', 'in', 'not', 'or', 'order', 'limit', 'range', 'is']
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        if (track) mocks.tfmChainCalls.push({ method: m, args })
        return chain
      }
    }
    chain.single = async () => resolveTo()
    chain.maybeSingle = async () => resolveTo()
    chain.then = (onResolve: (v: unknown) => unknown) =>
      Promise.resolve(resolveTo()).then(onResolve)
    return chain
  }

  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === 'tables') {
          return {
            select: () => buildChain(() => mocks.tablesLookup, false),
            delete: () => buildChain(() => mocks.tablesDelete, false),
          }
        }
        if (table === 'target_field_mappings') {
          return {
            select: () => buildChain(() => mocks.tfmCandidates, true),
            delete: () => buildChain(() => mocks.tfmDelete, true),
          }
        }
        throw new Error(`unexpected from(${table})`)
      },
    },
  }
})

vi.mock('@/lib/actions/role-resolution', () => ({
  requireProjectPermission: (...args: unknown[]) => mocks.requirePerm(...args),
}))

vi.mock('@/lib/actions/activity-log', () => ({
  logActivity: (...args: unknown[]) => mocks.logActivity(...args),
}))

import { removeTable } from '@/lib/actions/tables'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mocks.requirePerm.mockResolvedValue({ allowed: true })
  mocks.logActivity.mockResolvedValue(undefined)
  mocks.tablesLookup = { data: null, error: null }
  mocks.tablesDelete = { error: null }
  mocks.tfmCandidates = { data: [], error: null }
  mocks.tfmDelete = { error: null }
  mocks.tfmChainCalls = []
})

const FOUND_TABLE_ROW = {
  id: 'tbl-1',
  dataset_id: 'ds-1',
  name: 'Item Master',
  row_count: 7,
  datasets: { project_id: 'proj-1' },
}

describe('removeTable — boundary + error paths', () => {
  it('returns "Not authenticated" when no user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })

    const result = await removeTable('tbl-1')

    expect(result).toEqual({ success: false, error: 'Not authenticated' })
    expect(mocks.requirePerm).not.toHaveBeenCalled()
    expect(mocks.logActivity).not.toHaveBeenCalled()
  })

  it('returns "Table not found" when the lookup returns no row', async () => {
    mocks.tablesLookup = { data: null, error: null }

    const result = await removeTable('tbl-missing')

    expect(result).toEqual({ success: false, error: 'Table not found' })
    expect(mocks.requirePerm).not.toHaveBeenCalled()
    expect(mocks.logActivity).not.toHaveBeenCalled()
  })

  it('returns the perm error when requireProjectPermission denies', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }
    mocks.requirePerm.mockResolvedValue({ allowed: false, error: 'Insufficient permissions' })

    const result = await removeTable('tbl-1')

    expect(result).toEqual({ success: false, error: 'Insufficient permissions' })
    expect(mocks.requirePerm).toHaveBeenCalledWith('proj-1', 'editor')
    expect(mocks.logActivity).not.toHaveBeenCalled()
  })

  it('returns the delete error when the parent delete fails (RLS denial / network)', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }
    mocks.tablesDelete = { error: { message: 'permission denied for table tables' } }

    const result = await removeTable('tbl-1')

    expect(result).toEqual({ success: false, error: 'permission denied for table tables' })
    expect(mocks.logActivity).not.toHaveBeenCalled()
  })
})

describe('removeTable — happy path', () => {
  it('returns success and emits activity log with correct shape', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }
    mocks.tablesDelete = { error: null }
    mocks.tfmCandidates = { data: [], error: null }

    const result = await removeTable('tbl-1')

    expect(result).toEqual({ success: true })

    expect(mocks.logActivity).toHaveBeenCalledTimes(1)
    // logActivity is positional: (projectId, actionType, description, category, metadata)
    const args = mocks.logActivity.mock.calls[0]
    expect(args[0]).toBe('proj-1')
    expect(args[1]).toBe('table_removed')
    expect(args[2]).toContain('Item Master')
    expect(args[2]).toContain('7 rows')
    expect(args[3]).toBe('data')
    expect(args[4]).toEqual({
      table_id: 'tbl-1',
      dataset_id: 'ds-1',
      table_name: 'Item Master',
      row_count: 7,
    })
  })

  it('cleanup pass tolerates empty candidate list (no-op idempotent)', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }
    mocks.tfmCandidates = { data: [], error: null }

    const result = await removeTable('tbl-1')

    expect(result).toEqual({ success: true })
  })
})

describe('removeTable — orphan-TFM cleanup filter logic', () => {
  // Test #6 from Stop 2: positive case — TFM with 0 mapping_sources gets cleaned up.
  it('cleanup pass deletes TFMs returned by the candidates query that have empty mapping_sources', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }
    // Candidates query returns 3 rows. The supabase `.in('combination_type', ...)`
    // and `.eq('is_acknowledged', false)` filters are simulated here by only
    // returning rows that pass them — that filter is verified separately
    // below (tests #7/#8). What this test pins is the JS-side post-filter:
    // "of the rows the query returned, delete ONLY the ones with empty
    // mapping_sources."
    mocks.tfmCandidates = {
      data: [
        { id: 'tfm-orphan-1', mapping_sources: [] }, // single, 0 sources → ORPHAN
        { id: 'tfm-keep', mapping_sources: [{ id: 'ms-1' }] }, // single, 1 source → keep
        { id: 'tfm-orphan-2', mapping_sources: null }, // null sources → ORPHAN (defensive)
      ],
      error: null,
    }

    const result = await removeTable('tbl-1')

    expect(result).toEqual({ success: true })

    // The orphan-delete chain should call .in('id', [...orphan IDs...]).
    // Find that call in the recorded chain history.
    const inCall = mocks.tfmChainCalls.find(
      (c) => c.method === 'in' && c.args[0] === 'id' && Array.isArray(c.args[1]),
    )
    expect(inCall).toBeDefined()
    const deletedIds = inCall!.args[1] as string[]
    expect(deletedIds).toEqual(expect.arrayContaining(['tfm-orphan-1', 'tfm-orphan-2']))
    expect(deletedIds).not.toContain('tfm-keep')
    expect(deletedIds).toHaveLength(2)
  })

  // Test #7 from Stop 2: VA exclusion is enforced by the candidates-query filter.
  // The query MUST include `combination_type IN ('single', 'concat_space',
  // 'concat_comma')` so VAs (combination_type='custom_sql') are excluded
  // BEFORE the JS-side empty-sources check. Pin the allow-list.
  it('candidates query filters combination_type to mapped types only (excludes custom_sql VAs)', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }

    await removeTable('tbl-1')

    // Find the .in('combination_type', [...]) call on the candidates select chain.
    const inCall = mocks.tfmChainCalls.find(
      (c) => c.method === 'in' && c.args[0] === 'combination_type',
    )
    expect(inCall).toBeDefined()
    const allowedTypes = inCall!.args[1] as string[]
    expect(allowedTypes).toEqual(
      expect.arrayContaining(['single', 'concat_space', 'concat_comma']),
    )
    expect(allowedTypes).not.toContain('custom_sql')
  })

  // Test #8 from Stop 2: target-acknowledgment exclusion is enforced by the
  // candidates-query filter. is_acknowledged=TRUE TFMs are legitimately
  // empty (0 sources by design — they represent "this target won't be
  // mapped"). Pin the .eq('is_acknowledged', false) filter.
  it('candidates query filters is_acknowledged=false to exclude target acknowledgments', async () => {
    mocks.tablesLookup = { data: FOUND_TABLE_ROW, error: null }

    await removeTable('tbl-1')

    const eqCall = mocks.tfmChainCalls.find(
      (c) => c.method === 'eq' && c.args[0] === 'is_acknowledged',
    )
    expect(eqCall).toBeDefined()
    expect(eqCall!.args[1]).toBe(false)
  })
})
