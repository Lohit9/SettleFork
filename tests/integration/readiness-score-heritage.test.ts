import { describe, it, expect } from 'vitest'

/**
 * Test 15 — Integration smoke test for `computeReadinessScore` against the
 * Heritage Core canary project (see `docs/features/mapping-redesign.md`
 * §Canary and Prompt 3c Gate 2 test plan).
 *
 * Scope: READ-ONLY verification that the rewritten readiness-score wrapper
 * still returns a well-formed `ReadinessScore` shape against a real,
 * post-migration-074/075 project. The goal is to catch shape regressions
 * (e.g. a missing field in the returned object, a count that becomes
 * negative, a score that falls outside [0, 100]) without pinning exact
 * numeric values against live data that evolves as manual operations
 * happen on the canary.
 *
 * The numeric plausibility bounds asserted below are intentionally wide.
 * Heritage Core data volumes:
 *   - ~763 target_field_mappings rows (of which ~47 bare-ack, ~716 active)
 *   - ~774 mapping_sources rows
 *   - ~776 transformations rows
 *
 * A companion gray-box heritage test for `getOutputsPageData` lives in
 * `tests/integration/outputs-heritage.test.ts` and pins exact numeric
 * values (per Prompt 3c Gate 3 Flag 1). THIS test is the shape-only
 * counterpart for the narrower `computeReadinessScore` entry point.
 *
 * Env-gated:
 *   HERITAGE_PROJECT_ID       — uuid of the canary project
 *   NEXT_PUBLIC_SUPABASE_URL  — user-scoped client
 *   SUPABASE_SERVICE_ROLE_KEY — admin client
 *
 * Run locally:
 *   HERITAGE_PROJECT_ID=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/readiness-score-heritage.test.ts
 */

const HERITAGE_PROJECT_ID = process.env.HERITAGE_PROJECT_ID ?? ''
const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

describeFn('[integration] computeReadinessScore against Heritage Core', () => {
  it('returns a well-formed ReadinessScore shape', async () => {
    const { computeReadinessScore } = await import('@/lib/quality/readiness-score')
    const result = await computeReadinessScore(HERITAGE_PROJECT_ID)

    expect(result).not.toBeNull()
    expect(result.score).toBeTypeOf('number')
    expect(result.status).toMatch(/^(ready|at_risk|not_ready)$/)
    expect(result.blocking_count).toBeTypeOf('number')
    expect(result.warning_count).toBeTypeOf('number')
    expect(result.ready_field_count).toBeTypeOf('number')
    expect(result.total_fields_checked).toBeTypeOf('number')
    expect(result.unmapped_required_count).toBeTypeOf('number')
    expect(result.top_issues).toBeInstanceOf(Array)

    // Components object must have the five weighted inputs.
    expect(result.components).toBeDefined()
    const components = result.components!
    expect(components.mapping).toBeTypeOf('number')
    expect(components.transform).toBeTypeOf('number')
    expect(components.blocking).toBeTypeOf('number')
    expect(components.warnings).toBeTypeOf('number')
    expect(components.staging).toBeTypeOf('number')
  })

  it('score is within [0, 100]', async () => {
    const { computeReadinessScore } = await import('@/lib/quality/readiness-score')
    const { score } = await computeReadinessScore(HERITAGE_PROJECT_ID)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('count fields are non-negative', async () => {
    const { computeReadinessScore } = await import('@/lib/quality/readiness-score')
    const result = await computeReadinessScore(HERITAGE_PROJECT_ID)

    expect(result.blocking_count).toBeGreaterThanOrEqual(0)
    expect(result.warning_count).toBeGreaterThanOrEqual(0)
    expect(result.ready_field_count).toBeGreaterThanOrEqual(0)
    expect(result.total_fields_checked).toBeGreaterThanOrEqual(0)
    expect(result.unmapped_required_count).toBeGreaterThanOrEqual(0)
    expect(result.top_issues.length).toBeLessThanOrEqual(5)

    // ready_field_count can never exceed total_fields_checked by definition.
    expect(result.ready_field_count).toBeLessThanOrEqual(result.total_fields_checked)
  })

  it('top_issues are sorted with blocking severity first', async () => {
    const { computeReadinessScore } = await import('@/lib/quality/readiness-score')
    const { top_issues } = await computeReadinessScore(HERITAGE_PROJECT_ID)

    let sawNonBlocking = false
    for (const issue of top_issues) {
      if (issue.severity === 'blocking' && sawNonBlocking) {
        throw new Error('top_issues mis-sorted: blocking issue after a non-blocking one')
      }
      if (issue.severity !== 'blocking') sawNonBlocking = true
    }
  })
})
