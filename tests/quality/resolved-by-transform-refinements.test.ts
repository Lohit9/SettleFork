import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d rewrite of
 * `lib/quality/resolved-by-transform.ts`.
 *
 * Gate 2 decisions pinned:
 *
 *   Q1 — Preserve legacy primary-source-only semantics: the query
 *        filters mapping_sources by ordinal=0. Contributor sources
 *        (ordinal >= 1) are NOT surfaced as "resolved by transform".
 *   Zero legacy-table references remain.
 *   Status + acknowledgment filters match legacy: approved +
 *   is_acknowledged=false.
 *
 * Source-level (not mocked-Supabase) for the same reason as every
 * other *-refinements test in this repo: mocking the chainable
 * query builder is strictly worse than pinning the exact call
 * pattern.
 */

const PATH = resolve(__dirname, '../../lib/quality/resolved-by-transform.ts')
const SRC = readFileSync(PATH, 'utf8')

describe('[resolved-by-transform refinements] Q1 — primary-source-only semantics', () => {
  it('query filters mapping_sources.ordinal = 0', () => {
    expect(SRC).toMatch(/\.eq\(\s*['"]mapping_sources\.ordinal['"]\s*,\s*0\s*\)/)
  })

  it('iteration picks ms with ordinal === 0 explicitly', () => {
    expect(SRC).toMatch(/\.find\(\s*\(m\)\s*=>\s*m\.ordinal\s*===\s*0\s*\)/)
  })

  it('documents the primary-only decision with a dated Prompt 3d comment', () => {
    expect(SRC).toMatch(/Prompt 3d decision \(2026-04-22\)/)
    expect(SRC).toMatch(/primary-source-only[\s*]+semantics/)
  })
})

describe('[resolved-by-transform refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no references to legacy is_contributing column as an eq/select filter', () => {
    // Note: the doc-comment header may mention `is_contributing` when
    // explaining the legacy → new-model translation. We only care that
    // no runtime query uses the column.
    expect(SRC).not.toMatch(/\.eq\(\s*['"]is_contributing['"]/)
    expect(SRC).not.toMatch(/select\([^)]*is_contributing/)
  })
})

describe('[resolved-by-transform refinements] new-model query shape', () => {
  it('queries target_field_mappings directly (no table_mappings pre-fetch)', () => {
    expect(SRC).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    expect(SRC).not.toMatch(/\.from\(\s*['"]table_mappings['"]/)
  })

  it('preserves status=approved + is_acknowledged=false filters', () => {
    expect(SRC).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]approved['"]/)
    expect(SRC).toMatch(/\.eq\(\s*['"]is_acknowledged['"]\s*,\s*false\s*\)/)
  })

  it('joins transformations via the new-model relationship (no field_mapping_id)', () => {
    const selectClause = SRC.match(/\.select\(\s*`[\s\S]*?`/)?.[0] ?? ''
    expect(selectClause).toContain('transformations')
    expect(selectClause).not.toContain('field_mapping_id')
  })

  it('joins mapping_sources with !inner to ensure at-least-one primary source', () => {
    const selectClause = SRC.match(/\.select\(\s*`[\s\S]*?`/)?.[0] ?? ''
    expect(selectClause).toMatch(/mapping_sources\s*!inner/)
  })
})

describe('[resolved-by-transform refinements] hasTransform signal', () => {
  it('preserves dual OR signal — hasTransform || noTransformNeeded', () => {
    expect(SRC).toMatch(/hasTransform\s*\|\|\s*noTransformNeeded/)
  })

  it('noTransformNeeded signal uses needs_transformation === false', () => {
    expect(SRC).toMatch(/needs_transformation\s*===\s*false/)
  })
})
