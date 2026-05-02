// @vitest-environment node
//
// Phase 2 PR 11 — unit tests for `resolveDefaultModel` + `resolveEffort`.
//
// Pure functions reading process.env per-request. No mocks needed.
// Each test sets the env var, calls the helper, asserts; afterEach
// restores the original env value.

import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveDefaultModel,
  resolveEffort,
  type LLMFeature,
} from '@/lib/ai/llm-client'

// ─── resolveDefaultModel — flag respect ──────────────────────────────────────

describe('resolveDefaultModel — feature flag respect', () => {
  const originalEnv = process.env.AI_PHASE_2_ENABLED

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AI_PHASE_2_ENABLED
    else process.env.AI_PHASE_2_ENABLED = originalEnv
  })

  it('returns claude-sonnet-4-6 when flag is unset', () => {
    delete process.env.AI_PHASE_2_ENABLED
    expect(resolveDefaultModel()).toBe('claude-sonnet-4-6')
  })

  it('returns claude-sonnet-4-6 when flag is empty string', () => {
    process.env.AI_PHASE_2_ENABLED = ''
    expect(resolveDefaultModel()).toBe('claude-sonnet-4-6')
  })

  it('returns claude-sonnet-4-6 when flag is "0"', () => {
    process.env.AI_PHASE_2_ENABLED = '0'
    expect(resolveDefaultModel()).toBe('claude-sonnet-4-6')
  })

  it('returns claude-sonnet-4-6 when flag is "true" (only literal "1" enables)', () => {
    process.env.AI_PHASE_2_ENABLED = 'true'
    expect(resolveDefaultModel()).toBe('claude-sonnet-4-6')
  })

  it('returns claude-opus-4-7 when flag is exactly "1"', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveDefaultModel()).toBe('claude-opus-4-7')
  })
})

// ─── resolveEffort — flag + exception list ───────────────────────────────────

describe('resolveEffort — feature flag + LOW_EFFORT_FEATURES', () => {
  const originalEnv = process.env.AI_PHASE_2_ENABLED

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AI_PHASE_2_ENABLED
    else process.env.AI_PHASE_2_ENABLED = originalEnv
  })

  // Sample of LLMFeature values pulled from the union in llm-client.ts.
  // Cast through unknown so we can pass them by string literal in tests
  // without re-exporting the union here.
  const FEATURE = (s: string): LLMFeature => s as unknown as LLMFeature

  it('returns undefined when flag is OFF (preserves Sonnet default)', () => {
    delete process.env.AI_PHASE_2_ENABLED
    expect(resolveEffort(FEATURE('mapping_generate'))).toBeUndefined()
    expect(resolveEffort(FEATURE('transform_describe'))).toBeUndefined()
    expect(resolveEffort(FEATURE('nl_suggest_queries'))).toBeUndefined()
  })

  it('returns "high" for reasoning-heavy features when flag is ON', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveEffort(FEATURE('mapping_generate'))).toBe('high')
    expect(resolveEffort(FEATURE('mapping_suggest'))).toBe('high')
    expect(resolveEffort(FEATURE('transform_generate'))).toBe('high')
    expect(resolveEffort(FEATURE('validation_rule_from_nl'))).toBe('high')
    expect(resolveEffort(FEATURE('outputs_execution_package_monolithic'))).toBe('high')
    expect(resolveEffort(FEATURE('outputs_execution_package_compartmentalized'))).toBe('high')
    expect(resolveEffort(FEATURE('outputs_execution_package_fallback'))).toBe('high')
    expect(resolveEffort(FEATURE('ddl_parsing'))).toBe('high')
    expect(resolveEffort(FEATURE('ddl_conversion'))).toBe('high')
    expect(resolveEffort(FEATURE('outputs_migration_runbook'))).toBe('high')
    expect(resolveEffort(FEATURE('outputs_readiness_report'))).toBe('high')
  })

  it('returns undefined for transform_describe when flag is ON (low-effort exception)', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveEffort(FEATURE('transform_describe'))).toBeUndefined()
  })

  it('returns undefined for nl_suggest_queries when flag is ON (low-effort exception)', () => {
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveEffort(FEATURE('nl_suggest_queries'))).toBeUndefined()
  })

  it('returns "high" for retry features when flag is ON', () => {
    // Repair / retry features inherit effort='high' because they're
    // chained off reasoning calls; eliminating their effort would
    // produce a quality cliff between primary and retry.
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveEffort(FEATURE('mapping_generate_repair'))).toBe('high')
    expect(resolveEffort(FEATURE('mapping_generate_legacy_pair_repair'))).toBe('high')
    expect(resolveEffort(FEATURE('nl_to_sql_retry'))).toBe('high')
  })

  it('returns "high" for eval_* features when flag is ON', () => {
    // The eval harness uses the SAME production code path, so eval
    // calls inherit effort='high' too. This is intentional — the
    // eval measures production behavior including extended thinking.
    process.env.AI_PHASE_2_ENABLED = '1'
    expect(resolveEffort(FEATURE('eval_mapping'))).toBe('high')
    expect(resolveEffort(FEATURE('eval_validation_rule'))).toBe('high')
  })
})
