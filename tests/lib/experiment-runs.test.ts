/**
 * Unit tests for `lib/ai/experiment-runs.ts`.
 *
 * Pure-function tests; no DB, no env gate, runs in default vitest. Pins the
 * JSONB metadata shape that callsites spread into `llm_calls.metadata` —
 * the analyst-facing `mapping_experiments` view (migration 091) reads these
 * fields via JSONB `->>` extraction, so a regression in shape silently
 * breaks the view's projections without a SQL error.
 */

import { describe, it, expect } from 'vitest'
import {
  mintExperimentRunId,
  pathBExperimentMetadata,
  pathDExperimentMetadata,
  type ExperimentLabel,
} from '@/lib/ai/experiment-runs'
import {
  PATH_D_MAX_OUTPUT_TOKENS,
  PATH_D_MONOLITHIC_THRESHOLD,
  PER_PROJECT_MAX_COST_USD,
} from '@/lib/ai/path-d-config'

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('mintExperimentRunId', () => {
  it('returns a UUID v4 string', () => {
    const id = mintExperimentRunId()

    expect(typeof id).toBe('string')
    expect(id).toMatch(UUID_V4_REGEX)
  })

  it('returns a fresh UUID on each call (no module-level memoization)', () => {
    // Mint 50 IDs and verify they're all distinct. UUID v4 collision
    // probability is astronomically low; any duplicate would indicate
    // a bug like accidental memoization or constant return.
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) ids.add(mintExperimentRunId())

    expect(ids.size).toBe(50)
  })
})

describe('pathBExperimentMetadata', () => {
  it('returns the canonical Path B JSONB fragment shape', () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const fragment = pathBExperimentMetadata(runId)

    expect(fragment).toEqual({
      experiment_label: 'path_b',
      experiment_run_id: runId,
    })
  })

  it('returns the runId verbatim (no transformation)', () => {
    const runId = mintExperimentRunId()
    const fragment = pathBExperimentMetadata(runId)

    expect(fragment.experiment_run_id).toBe(runId)
  })

  it('experiment_label is the literal string "path_b" (not coerced or wrapped)', () => {
    const fragment = pathBExperimentMetadata('any-id')

    // Pin the literal string — analyst SQL filters on this exact value.
    // Drift to 'pathB' / 'PATH_B' / 'b' would silently exclude rows
    // from the mapping_experiments view.
    expect(fragment.experiment_label).toBe('path_b')
  })
})

describe('pathDExperimentMetadata', () => {
  it('returns the Path D JSONB fragment with run ID + config snapshot', () => {
    const runId = '00000000-0000-4000-8000-000000000002'
    const fragment = pathDExperimentMetadata(runId)

    expect(fragment).toEqual({
      experiment_label: 'path_d',
      experiment_run_id: runId,
      max_output_tokens: PATH_D_MAX_OUTPUT_TOKENS,
      monolithic_threshold: PATH_D_MONOLITHIC_THRESHOLD,
      max_cost_usd: PER_PROJECT_MAX_COST_USD,
    })
  })

  it('config snapshot pulls live values from path-d-config exports', () => {
    // Pins the contract that Path D metadata reflects current env-resolved
    // config rather than hardcoded literals. If a future change introduces
    // a hardcoded literal here, the assertion would still pass for the
    // default config, so we additionally assert the values are sensible
    // numbers (sanity check the wiring).
    const fragment = pathDExperimentMetadata('any-id')

    expect(typeof fragment.max_output_tokens).toBe('number')
    expect(fragment.max_output_tokens).toBeGreaterThan(0)
    expect(typeof fragment.monolithic_threshold).toBe('number')
    expect(fragment.monolithic_threshold).toBeGreaterThan(0)
    expect(typeof fragment.max_cost_usd).toBe('number')
    expect(fragment.max_cost_usd).toBeGreaterThan(0)

    // And the snapshot values match the imported constants exactly.
    expect(fragment.max_output_tokens).toBe(PATH_D_MAX_OUTPUT_TOKENS)
    expect(fragment.monolithic_threshold).toBe(PATH_D_MONOLITHIC_THRESHOLD)
    expect(fragment.max_cost_usd).toBe(PER_PROJECT_MAX_COST_USD)
  })

  it('experiment_label is the literal string "path_d"', () => {
    const fragment = pathDExperimentMetadata('any-id')

    // Same drift-detection rationale as the path_b test above. The
    // mapping_experiments view comment in migration 091 explicitly
    // anticipates this label: "experiment_label is text (not enum)
    // so adding path_d_* for a future variant is a writer-side change
    // with no migration." This assertion pins the actual writer-side
    // value.
    expect(fragment.experiment_label).toBe('path_d')
  })
})

describe('ExperimentLabel type', () => {
  it("type-level: 'path_b' and 'path_d' are valid ExperimentLabel values", () => {
    // Compile-time check — if the type union ever loses 'path_b' or
    // 'path_d', this file fails tsc. Runtime assertions are sanity
    // checks on the literal values.
    const b: ExperimentLabel = 'path_b'
    const d: ExperimentLabel = 'path_d'

    expect(b).toBe('path_b')
    expect(d).toBe('path_d')
  })
})
