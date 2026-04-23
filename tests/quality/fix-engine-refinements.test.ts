import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d rewrite of the source-stage
 * target-context lookup in `lib/quality/fix-engine.ts`.
 *
 * Preserved semantics:
 *   - Source-stage issue with field_id → fetch one target field via the
 *     TFM this source feeds into, for <target_context> in Claude prompt.
 *   - .limit(1).maybeSingle() preserved — legacy picked whatever came
 *     first with no status filter. Adding a filter would change which
 *     TFM's target field Claude sees when a source feeds multiple TFMs.
 *   - Target context string format preserved ("Mapped to: ...\nTarget
 *     nullable: ...").
 */

const PATH = resolve(__dirname, '../../lib/quality/fix-engine.ts')
const SRC = readFileSync(PATH, 'utf8')

describe('[fix-engine refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })
})

describe('[fix-engine refinements] new-model target-context query', () => {
  it('queries mapping_sources with an inner TFM join', () => {
    expect(SRC).toMatch(/\.from\(\s*['"]mapping_sources['"]/)
    expect(SRC).toMatch(/target_field_mappings\s*!inner/)
  })

  it('preserves .limit(1).maybeSingle() — no status filter added', () => {
    expect(SRC).toMatch(/\.eq\(\s*['"]source_field_id['"]\s*,\s*issue\.field_id\s*\)[\s\S]*?\.limit\(\s*1\s*\)[\s\S]*?\.maybeSingle\(\)/)
    // The block around this lookup MUST NOT filter by status — that would
    // change which TFM's target field Claude sees for a multi-TFM source.
    const block = SRC.match(/mapping_sources[\s\S]*?maybeSingle\(\)/)?.[0] ?? ''
    expect(block).not.toMatch(/\.eq\(\s*['"]status['"]/)
    expect(block).not.toMatch(/\.neq\(\s*['"]status['"]/)
  })

  it('documents the preserve-legacy decision inline', () => {
    expect(SRC).toMatch(/Prompt 3d \(2026-04-22\)/)
    expect(SRC).toMatch(/Preserved byte-for-byte/i)
  })
})

describe('[fix-engine refinements] target context string preserved', () => {
  it('keeps "Mapped to:" / "Target nullable:" prompt shape', () => {
    expect(SRC).toMatch(/Mapped to:\s*\$\{/)
    expect(SRC).toMatch(/Target nullable:\s*\$\{/)
  })
})
