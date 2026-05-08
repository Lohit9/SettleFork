// @vitest-environment node
//
// Path D eval runner — REAL Anthropic against the 3 starter fixtures,
// env-gated, opt-in only.
//
// Cost: ~$1.70 per full run (3 fixtures × 1 trial × ~$0.40-0.80 each).
// NOT default vitest. NOT CI.
//
// What this verifies:
//   1. The runner loads all 3 fixtures from disk and runs Path D
//      against each.
//   2. The scorer produces an aggregate score per fixture and overall.
//   3. The v0 prompt clears a generous baseline threshold (overall mean
//      ≥ 0.6) — the goal is to anchor Phase C iteration against this
//      baseline, not to assert a high bar.
//   4. The report structure is well-formed and console-formatable.
//   5. Optional JSON dump to PATH_D_EVAL_JSON_OUT for trend tracking.
//
// Env required:
//   RUN_PATH_D_EVAL=1
//   ANTHROPIC_API_KEY
//   NEXT_PUBLIC_SUPABASE_URL          (for llm_calls writes; optional —
//   SUPABASE_SERVICE_ROLE_KEY          eval calls write best-effort with
//                                      synthetic project_id; FK errors
//                                      are swallowed by writeLogAsync)
//
// Optional env knobs:
//   PATH_D_EVAL_TRIALS=N               default 1; bump to 3 for
//                                      variance-aware comparison (~$5)
//   PATH_D_EVAL_FIXTURE=<name>         run only the named fixture
//   PATH_D_EVAL_JSON_OUT=<path>        dump full report JSON to path
//
// Usage:
//   RUN_PATH_D_EVAL=1 pnpm test:integration path-d-eval-runner
//   RUN_PATH_D_EVAL=1 PATH_D_EVAL_TRIALS=3 pnpm test:integration path-d-eval-runner
//   RUN_PATH_D_EVAL=1 PATH_D_EVAL_FIXTURE=crm-sf-to-hubspot pnpm test:integration path-d-eval-runner

import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'

const RUN = process.env.RUN_PATH_D_EVAL === '1'
const HAS_API_KEY = Boolean(process.env.ANTHROPIC_API_KEY)
const describeIf = RUN && HAS_API_KEY ? describe : describe.skip

describeIf('Path D eval runner — full eval against 3 starter fixtures', () => {
  it('runs the suite, scores all fixtures, clears baseline threshold', async () => {
    const { runEvalSuite, formatReportStdout } = await import(
      '@/lib/ai/path-d-eval/runner'
    )

    const trialsPerFixture = parseInt(process.env.PATH_D_EVAL_TRIALS ?? '1', 10)
    const fixtureFilter = process.env.PATH_D_EVAL_FIXTURE

    const report = await runEvalSuite({ trialsPerFixture, fixtureFilter })

    // Always print the full stdout report — this is the integration's
    // primary deliverable (humans read it for trend tracking).
    // eslint-disable-next-line no-console
    console.log(formatReportStdout(report))

    // Optional JSON dump for trend analysis / Phase C iteration tooling.
    if (process.env.PATH_D_EVAL_JSON_OUT) {
      writeFileSync(
        process.env.PATH_D_EVAL_JSON_OUT,
        JSON.stringify(report, null, 2),
      )
      // eslint-disable-next-line no-console
      console.log(
        `[path-d-eval] wrote full JSON report to ${process.env.PATH_D_EVAL_JSON_OUT}`,
      )
    }

    // Assertion 1: All fixtures completed (or only the filtered one).
    const expectedFixtureCount = fixtureFilter ? 1 : 3
    expect(report.fixtureSummaries).toHaveLength(expectedFixtureCount)

    // Assertion 2: Each fixture ran at least one trial.
    for (const fs of report.fixtureSummaries) {
      expect(fs.trials.length).toBeGreaterThanOrEqual(1)
    }

    // Assertion 3: At least one trial per fixture succeeded (errored=false).
    // We tolerate flaky LLM failures here — Phase C iteration cycles need
    // to complete even if a single trial fails. A fixture with ALL trials
    // errored is a real failure.
    for (const fs of report.fixtureSummaries) {
      const succeeded = fs.trials.filter((t) => !t.errored).length
      expect(succeeded).toBeGreaterThanOrEqual(1)
    }

    // Assertion 4: Aggregate score crosses the v0 baseline threshold.
    // 0.6 is generous; the v0 prompt should clear it on every fixture.
    // Phase C will iterate to push these higher; this assertion gates
    // "the prompt isn't catastrophically broken."
    for (const fs of report.fixtureSummaries) {
      expect(fs.aggregateMean).toBeGreaterThanOrEqual(0.6)
    }

    // Assertion 5: Overall mean across fixtures clears the same threshold.
    expect(report.overallMean).toBeGreaterThanOrEqual(0.6)

    // Assertion 6: Report structure invariants.
    expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(report.trialsPerFixture).toBe(trialsPerFixture)
    expect(typeof report.totalDurationMs).toBe('number')
    expect(report.totalDurationMs).toBeGreaterThan(0)
    expect(Object.keys(report.weights)).toHaveLength(8)
  }, 30 * 60 * 1000) // 30-minute timeout — 3 fixtures × ~5 min each at N=1
})
