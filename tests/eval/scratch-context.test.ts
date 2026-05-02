// @vitest-environment node
//
// Scratch-context guard tests.
//
// These verify the three load-bearing guards:
//   1. Hard prefix on synthetic project names (create + teardown both check).
//   2. Cleanup invariant — sweepOrphans returns zero on a clean DB.
//   3. Fail-closed teardown — refuses to delete when name doesn't match.
//
// Mocks supabaseAdmin to keep these unit tests fast and DB-free.
// PR 10.4 adds an integration test that exercises the real DB path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock harness ──────────────────────────────────────────────────────────────

interface QueryState {
  // Sequence of pending results consumed by .single()/.maybeSingle()
  selectResults: Array<{ data: unknown; error: unknown }>
  insertResults: Array<{ data: unknown; error: unknown }>
  deleteResults: Array<{ error: unknown }>
  // Captured filter args for assertion
  lastDeleteFilter?: { col: string; value: unknown }
}

const { state, fromSpy } = vi.hoisted(() => {
  const state: {
    selectResults: Array<{ data: unknown; error: unknown }>
    insertResults: Array<{ data: unknown; error: unknown }>
    deleteResults: Array<{ error: unknown }>
    lastDeleteFilter?: { col: string; value: unknown }
  } = {
    selectResults: [],
    insertResults: [],
    deleteResults: [],
  }

  function buildSelectChain() {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.like = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(async () => {
      const r = state.selectResults.shift()
      return r ?? { data: null, error: null }
    })
    chain.single = vi.fn(async () => {
      const r = state.selectResults.shift()
      return r ?? { data: null, error: null }
    })
    // For sweepOrphans: SELECT … LIKE returns the array directly (no .single).
    // The chain itself is awaitable as a Promise that resolves to selectResults[0].
    chain.then = (resolve: (v: unknown) => void) => {
      const r = state.selectResults.shift()
      resolve(r ?? { data: [], error: null })
    }
    return chain
  }

  function buildInsertChain() {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.single = vi.fn(async () => {
      const r = state.insertResults.shift()
      return r ?? { data: null, error: null }
    })
    return chain
  }

  function buildDeleteChain() {
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn((col: string, value: unknown) => {
      state.lastDeleteFilter = { col, value }
      return Promise.resolve(state.deleteResults.shift() ?? { error: null })
    })
    return chain
  }

  const fromSpy = vi.fn((_table: string) => {
    const tableChain: Record<string, unknown> = {
      select: vi.fn(() => {
        const c = buildSelectChain() as Record<string, (...args: unknown[]) => unknown>
        return c.select!()
      }),
      insert: vi.fn(() => buildInsertChain()),
      delete: vi.fn(() => buildDeleteChain()),
    }
    return tableChain
  })

  return { state, fromSpy } as unknown as {
    state: QueryState
    fromSpy: typeof fromSpy
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: fromSpy },
}))

import {
  EVAL_PROJECT_PREFIX,
  createSyntheticProject,
  teardownSyntheticProject,
  sweepOrphans,
} from '@/lib/eval/scratch-context'

// ── Helpers ───────────────────────────────────────────────────────────────────

function pushSelect(data: unknown, error: unknown = null) {
  state.selectResults.push({ data, error })
}

function pushInsert(data: unknown, error: unknown = null) {
  state.insertResults.push({ data, error })
}

function pushDelete(error: unknown = null) {
  state.deleteResults.push({ error })
}

function resetState() {
  state.selectResults = []
  state.insertResults = []
  state.deleteResults = []
  state.lastDeleteFilter = undefined
}

beforeEach(() => {
  resetState()
  fromSpy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Guard 1 — prefix check on createSyntheticProject ─────────────────────────

describe('createSyntheticProject — prefix guard', () => {
  it('inserts when name starts with EVAL_PROJECT_PREFIX', async () => {
    pushInsert({ id: 'p-uuid-123' })
    const id = await createSyntheticProject({
      name: `${EVAL_PROJECT_PREFIX}abc-123`,
      userId: 'u1',
      orgId: 'o1',
    })
    expect(id).toBe('p-uuid-123')
  })

  it('throws when name does NOT start with EVAL_PROJECT_PREFIX', async () => {
    await expect(
      createSyntheticProject({
        name: 'Real Customer Project',
        userId: 'u1',
        orgId: 'o1',
      }),
    ).rejects.toThrow(/MUST start with "eval-synthetic-"/)
  })

  it('throws when supabase insert fails', async () => {
    pushInsert(null, { message: 'unique violation on name' })
    await expect(
      createSyntheticProject({
        name: `${EVAL_PROJECT_PREFIX}xyz`,
        userId: 'u1',
        orgId: 'o1',
      }),
    ).rejects.toThrow(/Failed to insert synthetic project/)
  })
})

// ── Guard 3 — fail-closed teardown ────────────────────────────────────────────

describe('teardownSyntheticProject — fail-closed prefix guard', () => {
  it('deletes when row name has the prefix', async () => {
    pushSelect({ id: 'p1', name: `${EVAL_PROJECT_PREFIX}abc` })
    pushDelete(null)
    const ok = await teardownSyntheticProject('p1')
    expect(ok).toBe(true)
    expect(state.lastDeleteFilter).toEqual({ col: 'id', value: 'p1' })
  })

  it('REFUSES to delete a project whose name lacks the prefix', async () => {
    // CRITICAL: this test simulates the bug-protection case — if the
    // runner ever passed a real project id by mistake, the function
    // must throw without issuing a DELETE.
    pushSelect({ id: 'p1', name: 'Heritage Core Migration' })
    await expect(teardownSyntheticProject('p1')).rejects.toThrow(
      /REFUSED to delete/,
    )
    // Confirm no DELETE was issued — the from('projects').delete() call
    // chain should not have been touched. If it had, lastDeleteFilter
    // would be set.
    expect(state.lastDeleteFilter).toBeUndefined()
  })

  it('returns false (not throw) when the row is already gone', async () => {
    pushSelect(null)
    const ok = await teardownSyntheticProject('p1')
    expect(ok).toBe(false)
  })

  it('throws on a database error during read-before-delete', async () => {
    pushSelect(null, { message: 'permission denied' })
    await expect(teardownSyntheticProject('p1')).rejects.toThrow(
      /Read-before-delete failed/,
    )
  })

  it('throws on a database error during the delete itself', async () => {
    pushSelect({ id: 'p1', name: `${EVAL_PROJECT_PREFIX}abc` })
    pushDelete({ message: 'foreign key violation' })
    await expect(teardownSyntheticProject('p1')).rejects.toThrow(
      /Failed to delete synthetic project/,
    )
  })
})

// ── Guard 2 — sweepOrphans cleanup invariant ──────────────────────────────────

describe('sweepOrphans — cleanup invariant', () => {
  it('returns zero when no orphans exist (clean DB)', async () => {
    // The first SELECT (.like) returns an empty array — chain via .then.
    pushSelect([])
    const result = await sweepOrphans()
    expect(result.swept).toBe(0)
    expect(result.ids).toEqual([])
  })

  it('sweeps each orphan via teardownSyntheticProject (which re-checks the prefix)', async () => {
    // First SELECT returns the orphan list.
    pushSelect([
      { id: 'p-a', name: `${EVAL_PROJECT_PREFIX}aaa` },
      { id: 'p-b', name: `${EVAL_PROJECT_PREFIX}bbb` },
    ])
    // Each teardown does its own SELECT-then-DELETE.
    pushSelect({ id: 'p-a', name: `${EVAL_PROJECT_PREFIX}aaa` })
    pushDelete(null)
    pushSelect({ id: 'p-b', name: `${EVAL_PROJECT_PREFIX}bbb` })
    pushDelete(null)

    const result = await sweepOrphans()
    expect(result.swept).toBe(2)
    expect(result.ids).toEqual(['p-a', 'p-b'])
  })

  it('throws on a database error during the orphan query', async () => {
    pushSelect(null, { message: 'permission denied' })
    await expect(sweepOrphans()).rejects.toThrow(
      /Failed to query orphan projects/,
    )
  })
})
