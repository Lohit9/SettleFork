// @vitest-environment node
//
// PR-A — unit coverage for the AGENT_PROVENANCE_GUIDANCE shared block,
// the schema_source flag mapper, and the env-flag-gated wrapper.
//
// Source-text invariants on the constant content protect against silent
// re-wording of the priority hierarchy. Behaviour tests on the helpers
// pin the exact-match `'1'` flag semantics + the byte-identical
// flag-OFF passthrough that heritage tests rely on.

import { afterEach, beforeEach, describe, it, expect } from 'vitest'

import {
  AGENT_PROVENANCE_GUIDANCE,
  provenanceFlagFor,
  provenanceLabelsEnabled,
  withProvenanceGuidance,
} from '@/lib/ai/agent-provenance-guidance'

// ─── AGENT_PROVENANCE_GUIDANCE — content invariants ─────────────────────────

describe('AGENT_PROVENANCE_GUIDANCE — content invariants', () => {
  it('declares all 4 priority tiers explicitly', () => {
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\bP1\b/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\bP2\b/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\bP3\b/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\bP4\b/)
  })

  it('labels the priority axis (HIGHEST / LOWEST)', () => {
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/HIGHEST/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/LOWEST/)
  })

  it('mentions each provenance flag value the formatter will emit', () => {
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\[manual\]/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\[ddl_parsed\]/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\[doc_enriched\]/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/\[cross_table_inferred\]/)
  })

  it('names the four input-source kinds (user edits / schema docs / business docs / raw data)', () => {
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/User schema overview edits/i)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/Schema documents/i)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/Business documents/i)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/Raw data/i)
  })

  it('declares user edits authoritative over schema documentation', () => {
    // The principal-locked rule: P1 wins over P2 for structural conflicts.
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/do NOT propose[\s\S]{0,80}contradicts/i)
  })

  it('declares raw data the lowest authority (must not override higher tiers)', () => {
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(
      /Do NOT use raw data to override higher-authority sources/i,
    )
  })

  it('references the live data-scanning tools as P4 surface (consistent with AGENT_TOOL_GUIDANCE)', () => {
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/query_field_data/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/count_distinct_patterns/)
    expect(AGENT_PROVENANCE_GUIDANCE).toMatch(/cross_field_correlation/)
  })
})

// ─── provenanceFlagFor — schema_source → flag-text mapping ──────────────────

describe('provenanceFlagFor — schema_source → flag text', () => {
  it('returns "manual" for user edits (P1 authoritative)', () => {
    expect(provenanceFlagFor('manual')).toBe('manual')
  })

  it('returns "ddl_parsed" for direct DDL parses (P2 structural)', () => {
    expect(provenanceFlagFor('ddl_parsed')).toBe('ddl_parsed')
  })

  it('returns "doc_enriched" for AI-enriched docs (P2 AI-mediated)', () => {
    expect(provenanceFlagFor('doc_enriched')).toBe('doc_enriched')
  })

  it('returns "cross_table_inferred" for cross-table corroboration (P4)', () => {
    expect(provenanceFlagFor('cross_table_inferred')).toBe('cross_table_inferred')
  })

  it('returns empty string for the default "inferred" case (cleaner prompts)', () => {
    expect(provenanceFlagFor('inferred')).toBe('')
  })

  it('returns empty string for null / undefined (defensive — legacy rows)', () => {
    expect(provenanceFlagFor(null)).toBe('')
    expect(provenanceFlagFor(undefined)).toBe('')
  })

  it('returns empty string for unknown labels (forward-compat — never throws)', () => {
    expect(provenanceFlagFor('future_label_v2')).toBe('')
    expect(provenanceFlagFor('')).toBe('')
  })
})

// ─── provenanceLabelsEnabled — env-flag exact-match semantics ───────────────

describe('provenanceLabelsEnabled — env-flag exact-match semantics', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.AI_PROVENANCE_LABELS_ENABLED
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AI_PROVENANCE_LABELS_ENABLED
    else process.env.AI_PROVENANCE_LABELS_ENABLED = originalEnv
  })

  it('returns true ONLY when env var is exactly "1"', () => {
    process.env.AI_PROVENANCE_LABELS_ENABLED = '1'
    expect(provenanceLabelsEnabled()).toBe(true)
  })

  it('returns false when env var is unset', () => {
    delete process.env.AI_PROVENANCE_LABELS_ENABLED
    expect(provenanceLabelsEnabled()).toBe(false)
  })

  it('returns false for "0" (off)', () => {
    process.env.AI_PROVENANCE_LABELS_ENABLED = '0'
    expect(provenanceLabelsEnabled()).toBe(false)
  })

  it('returns false for "true" (string lookalike — exact-match semantics)', () => {
    process.env.AI_PROVENANCE_LABELS_ENABLED = 'true'
    expect(provenanceLabelsEnabled()).toBe(false)
  })

  it('returns false for empty string (does not coerce to truthy)', () => {
    process.env.AI_PROVENANCE_LABELS_ENABLED = ''
    expect(provenanceLabelsEnabled()).toBe(false)
  })

  it('reads fresh per call (toggling env between calls is observed)', () => {
    delete process.env.AI_PROVENANCE_LABELS_ENABLED
    expect(provenanceLabelsEnabled()).toBe(false)
    process.env.AI_PROVENANCE_LABELS_ENABLED = '1'
    expect(provenanceLabelsEnabled()).toBe(true)
    process.env.AI_PROVENANCE_LABELS_ENABLED = '0'
    expect(provenanceLabelsEnabled()).toBe(false)
  })
})

// ─── withProvenanceGuidance — flag-OFF byte-identical, flag-ON prepends ─────

describe('withProvenanceGuidance — wrapper semantics', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.AI_PROVENANCE_LABELS_ENABLED
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AI_PROVENANCE_LABELS_ENABLED
    else process.env.AI_PROVENANCE_LABELS_ENABLED = originalEnv
  })

  const SAMPLE_PROMPT = 'You are an enterprise data migration expert. Do the thing.'

  it('flag-OFF: returns the prompt verbatim (===, byte-identical)', () => {
    delete process.env.AI_PROVENANCE_LABELS_ENABLED
    const result = withProvenanceGuidance(SAMPLE_PROMPT)
    expect(result).toBe(SAMPLE_PROMPT)
    // Reference equality — no string concat/copy when flag is OFF.
    expect(result === SAMPLE_PROMPT).toBe(true)
  })

  it('flag-ON: prepends AGENT_PROVENANCE_GUIDANCE + blank-line separator', () => {
    process.env.AI_PROVENANCE_LABELS_ENABLED = '1'
    const result = withProvenanceGuidance(SAMPLE_PROMPT)
    expect(result.startsWith(AGENT_PROVENANCE_GUIDANCE)).toBe(true)
    expect(result.endsWith(SAMPLE_PROMPT)).toBe(true)
    expect(result).toContain(`\n\n${SAMPLE_PROMPT}`)
  })

  it('flag-ON with empty input prompt: still emits the guidance block', () => {
    process.env.AI_PROVENANCE_LABELS_ENABLED = '1'
    const result = withProvenanceGuidance('')
    expect(result).toBe(`${AGENT_PROVENANCE_GUIDANCE}\n\n`)
  })

  it('flag-OFF with falsy env values does not modify the prompt', () => {
    for (const v of ['0', 'true', '', 'false', 'yes']) {
      process.env.AI_PROVENANCE_LABELS_ENABLED = v
      expect(withProvenanceGuidance(SAMPLE_PROMPT)).toBe(SAMPLE_PROMPT)
    }
  })
})
