import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-8) rewrite of
 * `lib/actions/ai-quality-detection.ts`.
 *
 * Scope (per Gate 2 §1.10):
 *   - Single site inside `runAIAugmentedChecks` (was line 194): the
 *     `.from('field_mappings')` fetch that builds the <target_mappings>
 *     prompt block is replaced with a `mapping_sources` fetch that
 *     inner-joins `target_field_mappings` (for status filtering) and
 *     pulls `type_compatibility` directly from mapping_sources (where
 *     it lives in the new model — one value per source contributor).
 *
 * Q3 decision (preserve N-rows-per-multi-source-mapping shape):
 *   - Legacy: N field_mappings rows per multi-source mapping → N lines.
 *   - New: iterate `mapping_sources` DIRECTLY (not per-TFM). Each MS row
 *     emits one "src → tgt (type_compat)" line, so a multi-source TFM
 *     with 1 primary + 2 contributors still emits 3 lines.
 *   - Order: `ordinal` ascending so primaries precede contributors.
 *
 * Guard wiring: NONE (quality_issues insert only; not a mapping-shape
 * mutation). An inline comment documents the decision.
 *
 * Output format preserved exactly:
 *   `  src (data_type) → tgt (data_type, nullable|NOT NULL) — type_compat`
 *
 * Tests are source-text-based for the same reasons as the other
 * `*-refinements.test.ts` files. See `docs/prompt-3a-remaining-work.md`
 * §Test coverage debt.
 */

const PATH = resolve(__dirname, '../../lib/actions/ai-quality-detection.ts')
const SRC = readFileSync(PATH, 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function runAIBody(): string {
  const start = SRC.indexOf('export async function runAIAugmentedChecks')
  if (start < 0) throw new Error('runAIAugmentedChecks start not found')
  return SRC.slice(start)
}

function mappingFetchSlice(): string {
  const start = SRC.indexOf('Get field mappings to this table')
  const end = SRC.indexOf('Format the table context for the prompt', start)
  if (start < 0 || end < 0) throw new Error('mapping-fetch slice markers not found')
  return SRC.slice(start, end)
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[ai-quality-detection refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls anywhere in code', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls anywhere', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no legacy field_mapping_id column reference in code (distinct from target_field_mapping_id)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/(?<!target_)field_mapping_id/)
  })
})

// ── New-model query shape ────────────────────────────────────────────────────

describe('[ai-quality-detection refinements] new-model mapping_sources query', () => {
  const body = mappingFetchSlice()
  const code = stripComments(body)

  it('fetches .from(mapping_sources) (not field_mappings)', () => {
    expect(code).toMatch(/\.from\(\s*['"]mapping_sources['"]/)
  })

  it('scopes by source_field_id IN fieldIdList (preserves legacy scope semantics)', () => {
    expect(code).toMatch(/\.in\(\s*['"]source_field_id['"]\s*,\s*fieldIdList\s*\)/)
  })

  it('selects type_compatibility from mapping_sources (per-source attribution, not per-TFM)', () => {
    // type_compatibility lives on mapping_sources in the new model.
    expect(body).toMatch(/type_compatibility/)
    // And it's selected at the top-level of the select() — NOT nested
    // inside the target_field_mapping embed.
    expect(code).toMatch(/select\(\s*`[^`]*\bordinal\b[^`]*\btype_compatibility\b/)
  })

  it('inner-joins target_field_mappings for status filtering', () => {
    expect(body).toMatch(/target_field_mapping:\s*target_field_mappings!inner\s*\(/)
    expect(code).toMatch(
      /\.neq\(\s*['"]target_field_mapping\.status['"]\s*,\s*['"]rejected['"]\s*\)/
    )
  })

  it('nested select pulls target_field (name, data_type, is_nullable) via the TFM embed', () => {
    expect(body).toMatch(
      /target_field:\s*fields!target_field_id\s*\([^)]*\bname\b[^)]*\bdata_type\b[^)]*\bis_nullable\b/
    )
  })

  it('top-level source_field select pulls (name, data_type)', () => {
    expect(body).toMatch(
      /source_field:\s*fields!source_field_id\s*\(\s*name,\s*data_type\s*\)/
    )
  })
})

// ── Q3 decision: preserve N-rows-per-multi-source-mapping ───────────────────

describe('[ai-quality-detection refinements] Q3 N-rows preservation', () => {
  const body = mappingFetchSlice()
  const code = stripComments(body)

  it('iterates mapping_sources directly (not per-TFM) to emit N lines per multi-source TFM', () => {
    // Each MS row → one output line, so contributors are not folded
    // into their primary. Test via: the output map iterates the
    // mapping_sources array, not a grouped-by-TFM structure.
    expect(code).toMatch(/mappings as unknown as MsRow\[\]/)
    expect(code).toMatch(/\.map\(\s*\(\s*m\s*\)\s*=>/)
  })

  it('orders by ordinal ascending so primaries precede contributors within a TFM', () => {
    expect(code).toMatch(
      /\.order\(\s*['"]ordinal['"]\s*,\s*\{\s*ascending:\s*true\s*\}\s*\)/
    )
  })

  it('documents the Q3 preserve-N-rows decision inline', () => {
    expect(body).toMatch(/Q3 decision/i)
    expect(body).toMatch(/N[- ]?rows?[\s\S]*?multi[- ]?source/i)
    expect(body).toMatch(/ordinal ascending/)
  })
})

// ── Output format preserved ──────────────────────────────────────────────────

describe('[ai-quality-detection refinements] output format preserved', () => {
  const body = mappingFetchSlice()

  it('emits one line per MS row in the "src (type) → tgt (type, null|NOT NULL) — tc" shape', () => {
    // Exact template-literal preserved — if any of these changes the
    // Claude prompt drifts.
    expect(body).toMatch(
      /\$\{src\.name\}\s*\(\$\{src\.data_type\}\)\s*→\s*\$\{tgt\.name\}\s*\(\$\{tgt\.data_type\},\s*\$\{tgt\.is_nullable\s*\?\s*['"]nullable['"]\s*:\s*['"]NOT NULL['"]\}\)/
    )
  })

  it('appends " — type_compat" only when type_compatibility is truthy', () => {
    expect(body).toMatch(/\$\{tc\s*\?\s*`\s*—\s*\$\{tc\}`\s*:\s*['"]['"]\s*\}/)
  })

  it('joins all lines with \\n (one mapping per line, matching legacy)', () => {
    expect(body).toMatch(/\.join\(\s*['"]\\n['"]\s*\)/)
  })

  it('filters out rows where src or tgt is missing (preserves legacy safety)', () => {
    expect(body).toMatch(/!!row\.src\s*&&\s*!!row\.tgt/)
  })
})

// ── Guard-wiring decision (NONE) ─────────────────────────────────────────────

describe('[ai-quality-detection refinements] guard-wiring decision', () => {
  const body = runAIBody()

  it('no assertMappingWritesEnabled import or call (quality_issues is not a mapping-shape surface)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('documents the Guard-wiring decision above the quality_issues insert', () => {
    expect(body).toMatch(/Guard-wiring decision/i)
    expect(body).toMatch(/quality_issues/)
    expect(body).toMatch(/mapping-shape/i)
  })

  it('guard comment is anchored to Prompt 3d Step 3D-8', () => {
    expect(body).toMatch(/Prompt 3d,?\s*Step 3D-8/)
  })
})
