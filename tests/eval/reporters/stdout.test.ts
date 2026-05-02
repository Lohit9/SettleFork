// @vitest-environment node
//
// Phase 1 PR 10.4 — stdout reporter tests.
//
// Format checks only (no LLM calls). Each test constructs a synthetic
// RunOutput and pins specific lines / substrings of the rendered
// string. Snapshot-style would also work but explicit substring
// assertions surface format regressions more meaningfully.

import { describe, it, expect } from 'vitest'
import { reportStdout } from '@/lib/eval/reporters/stdout'
import type { RunOutput } from '@/lib/eval/runner'

function baseOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    runId: '2026-05-02T15:30:00.000Z',
    branch: 'feat/phase1-pr10-eval-scaffold',
    commitSha: 'abc1234',
    model: 'claude-sonnet-4-20250514',
    smoke: true,
    task: 'mapping',
    datasets: [],
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalCachedCount: 0,
    preflightPassed: true,
    cleanupOk: true,
    ...overrides,
  }
}

describe('reportStdout', () => {
  it('renders the header with runId, commit, model', () => {
    const out = reportStdout(baseOutput())
    expect(out).toContain('Eval run @ 2026-05-02T15:30:00.000Z')
    expect(out).toContain('commit abc1234')
    expect(out).toContain('model claude-sonnet-4-20250514')
  })

  it('renders pre-flight + cleanup with check marks when both passed', () => {
    const out = reportStdout(baseOutput())
    expect(out).toMatch(/Pre-flight: ✅/)
    expect(out).toMatch(/Cleanup:\s+✅/)
  })

  it('renders pre-flight + cleanup with X marks when failed', () => {
    const out = reportStdout(
      baseOutput({ preflightPassed: false, cleanupOk: false }),
    )
    expect(out).toMatch(/Pre-flight: ❌/)
  })

  it('short-circuits the body when preflight failed', () => {
    const out = reportStdout(baseOutput({ preflightPassed: false }))
    expect(out).toContain('Pre-flight failed; no examples were run.')
  })

  it('renders a dataset block with mean/min/max + cost/duration', () => {
    const out = reportStdout(
      baseOutput({
        datasets: [
          {
            dataset: '_fixture',
            task: 'mapping',
            examples: 1,
            scorers: {
              scoreMappingFieldPair: {
                mean: 0.78,
                count: 1,
                min: 0.78,
                max: 0.78,
                errorCount: 0,
              },
            },
            costUsd: 0.0432,
            durationMs: 4123,
            cachedCount: 0,
          },
        ],
        totalCostUsd: 0.0432,
        totalDurationMs: 4123,
      }),
    )
    expect(out).toContain('_fixture / mapping (1 example)')
    expect(out).toContain('scoreMappingFieldPair: mean=0.780')
    expect(out).toContain('cost: $0.0432')
    expect(out).toContain('duration: 4.1s')
    expect(out).toContain('Totals: $0.0432')
  })

  it('renders error counts when scorer had failures', () => {
    const out = reportStdout(
      baseOutput({
        datasets: [
          {
            dataset: '_fixture',
            task: 'mapping',
            examples: 2,
            scorers: {
              scoreMappingFieldPair: {
                mean: 0.5,
                count: 1,
                min: 0.5,
                max: 0.5,
                errorCount: 1,
              },
            },
            costUsd: 0.05,
            durationMs: 2000,
            cachedCount: 0,
          },
        ],
      }),
    )
    expect(out).toContain('errors=1')
  })
})
