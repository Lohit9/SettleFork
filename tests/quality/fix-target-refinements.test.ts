import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d rewrite of
 * `lib/quality/fix-target.ts`.
 *
 * Preserved semantics:
 *   - In-flight target → source routing still works (routedToSource=true).
 *   - A TFM is unique per (project_id, target_field_id); the legacy
 *     (target_field_id, table_mapping_id) composite key is reconstructed
 *     by requiring MS[ordinal=0].source_table_id === tm.source_table_id.
 *   - Rejected + acknowledged TFMs are filtered out (matches legacy).
 *   - Fallback reasons preserved byte-for-byte.
 */

const PATH = resolve(__dirname, '../../lib/quality/fix-target.ts')
const SRC = readFileSync(PATH, 'utf8')

describe('[fix-target refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no .eq(table_mapping_id) filter (legacy column on field_mappings)', () => {
    expect(SRC).not.toMatch(/\.eq\(\s*['"]table_mapping_id['"]/)
  })
})

describe('[fix-target refinements] new-model query shape', () => {
  it('resolves source via target_field_mappings + mapping_sources', () => {
    expect(SRC).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    const selectClause = SRC.match(/\.select\(\s*`[\s\S]*?`/)?.[0] ?? ''
    expect(selectClause).toMatch(/mapping_sources/)
    expect(selectClause).toMatch(/source_field_id/)
    expect(selectClause).toMatch(/source_table_id/)
    expect(selectClause).toMatch(/ordinal/)
  })

  it('scopes TFM lookup to (project_id, target_field_id)', () => {
    expect(SRC).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*issue\.project_id/)
    expect(SRC).toMatch(/\.eq\(\s*['"]target_field_id['"]\s*,\s*issue\.field_id/)
  })

  it('filters out rejected + acknowledged TFMs', () => {
    expect(SRC).toMatch(/\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]/)
    expect(SRC).toMatch(/\.eq\(\s*['"]is_acknowledged['"]\s*,\s*false\s*\)/)
  })

  it('selects primary MS (ordinal === 0) in-memory', () => {
    expect(SRC).toMatch(/\.find\(\s*\(m\)\s*=>\s*m\.ordinal\s*===\s*0\s*\)/)
  })

  it('requires primary MS source_table_id to match tm.source_table_id', () => {
    expect(SRC).toMatch(/primary\.source_table_id\s*!==\s*tm\.source_table_id/)
  })
})

describe('[fix-target refinements] preserved fallback reasons', () => {
  it('preserves "no table_mapping for target" fallback', () => {
    expect(SRC).toContain('no table_mapping for target')
  })

  it('preserves "no field_mapping for target field" fallback', () => {
    expect(SRC).toContain('no field_mapping for target field')
  })

  it('preserves "source field name not found" fallback', () => {
    expect(SRC).toContain('source field name not found')
  })
})
