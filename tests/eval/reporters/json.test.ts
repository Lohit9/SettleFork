// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { reportJson } from '@/lib/eval/reporters/json'
import type { RunOutput } from '@/lib/eval/runner'

const SAMPLE: RunOutput = {
  runId: '2026-05-02T15:30:00.000Z',
  branch: 'feat/phase1-pr10-eval-scaffold',
  commitSha: 'abc1234',
  model: 'claude-sonnet-4-20250514',
  smoke: true,
  task: 'mapping',
  datasets: [
    {
      dataset: '_fixture',
      task: 'mapping',
      examples: 1,
      scorers: {
        scoreMappingFieldPair: { mean: 0.78, count: 1, min: 0.78, max: 0.78, errorCount: 0 },
      },
      costUsd: 0.04,
      durationMs: 4000,
      cachedCount: 0,
    },
  ],
  totalCostUsd: 0.04,
  totalDurationMs: 4000,
  totalCachedCount: 0,
  preflightPassed: true,
  cleanupOk: true,
}

describe('reportJson', () => {
  it('round-trips through JSON.parse', () => {
    const rendered = reportJson(SAMPLE)
    const parsed = JSON.parse(rendered) as RunOutput
    expect(parsed).toEqual(SAMPLE)
  })

  it('produces pretty-printed output (multiline)', () => {
    const rendered = reportJson(SAMPLE)
    expect(rendered.split('\n').length).toBeGreaterThan(5)
  })
})
