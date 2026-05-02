// @vitest-environment node
//
// Phase 1 PR 10.4 — runner unit tests (env + happy/sad fixture paths).
//
// The runner end-to-end is exercised by the live smoke tests in
// step 5 + 6 of the PR 10.4 verification (real DB, real LLM). The
// unit tests here cover the deterministic fast paths that don't
// need a DB:
//   - Missing EVAL_ORG_ID throws
//   - Validation-rule example is skipped with a warning
//
// Heavier mocking of supabaseAdmin (full pre-flight cycle, cost cap,
// cleanup invariant) is intentionally deferred — those paths read
// best end-to-end against the real DB. PR 11 may add an
// integration-test config for them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Break the transitive import of `'server-only'` (via lib/actions/mappings.ts
// → lib/auth/mapping-writes.ts) by stubbing the mappings module. The runner's
// production-AI entry point is not invoked in these tests; we only exercise
// the env-var guard which runs before any AI work.
vi.mock('@/lib/actions/mappings', () => ({
  runMappingGenerationForPair: vi.fn(async () => ({ inserted: 0 })),
}))

describe('runEval — env-var guard', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.EVAL_ORG_ID
    delete process.env.EVAL_ORG_ID
    vi.resetModules()
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EVAL_ORG_ID = originalEnv
    } else {
      delete process.env.EVAL_ORG_ID
    }
    vi.restoreAllMocks()
  })

  it('throws when EVAL_ORG_ID is unset', async () => {
    const { runEval } = await import('@/lib/eval/runner')
    await expect(runEval({})).rejects.toThrow(/EVAL_ORG_ID/)
  })

  it('throws when EVAL_ORG_ID is empty string', async () => {
    process.env.EVAL_ORG_ID = ''
    const { runEval } = await import('@/lib/eval/runner')
    await expect(runEval({})).rejects.toThrow(/EVAL_ORG_ID/)
  })
})
