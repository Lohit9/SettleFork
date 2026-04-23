import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-7) rewrite of
 * `lib/actions/validation-rules.ts`.
 *
 * Scope (per Gate 2 §1.5):
 *   - Sites 496 + 501 (old line numbers, inside executeCustomRules):
 *     collapse the two legacy `.from('field_mappings')` queries into:
 *       (a) mapping_sources scoped by source_field_id IN ruleFieldIds,
 *           with inner-joined target_field_mappings for project scoping +
 *           status filter
 *       (b) target_field_mappings scoped by target_field_id IN ruleFieldIds
 *     Flatten both into `fmByFieldId` keyed by TFM id. Preserves downstream
 *     attribution (source_data / transform_error / missing_transform).
 *
 *   - Column rename at old 521-525: transformations.field_mapping_id →
 *     transformations.target_field_mapping_id. `txByFmId` → `txByTfmId`.
 *
 *   - Guard wiring: NONE. executeCustomRules writes quality_issues and
 *     validation_rules — not mapping-shape surfaces. A comment block
 *     documents the decision.
 *
 * Tests are source-text-based for the same reasons as the other
 * `*-refinements.test.ts` files. See `docs/prompt-3a-remaining-work.md`
 * §Test coverage debt.
 */

const PATH = resolve(__dirname, '../../lib/actions/validation-rules.ts')
const SRC = readFileSync(PATH, 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function executeCustomRulesBody(): string {
  const start = SRC.indexOf('export async function executeCustomRules')
  if (start < 0) throw new Error('executeCustomRules start not found')
  const end = SRC.indexOf('export async function deleteValidationRule', start)
  if (end < 0) throw new Error('executeCustomRules end not found')
  return SRC.slice(start, end)
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[validation-rules refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls anywhere', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls anywhere', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no legacy field_mapping_id column reference in code (distinct from target_field_mapping_id)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/(?<!target_)field_mapping_id/)
  })

  it('no stale txByFmId identifier (renamed to txByTfmId)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/\btxByFmId\b/)
    expect(code).toMatch(/\btxByTfmId\b/)
  })

  it('no stale FmRow type alias (replaced with TfmRef)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/\btype\s+FmRow\b/)
  })
})

// ── New-model dual-query shape ───────────────────────────────────────────────

describe('[validation-rules refinements] new-model flatten queries', () => {
  const body = executeCustomRulesBody()
  const code = stripComments(body)

  it('query (a) fetches mapping_sources scoped by source_field_id IN ruleFieldIds', () => {
    expect(code).toMatch(/\.from\(\s*['"]mapping_sources['"]/)
    expect(code).toMatch(/\.in\(\s*['"]source_field_id['"]\s*,\s*ruleFieldIds/)
  })

  it('query (a) inner-joins target_field_mappings for project + status scope', () => {
    expect(body).toMatch(
      /target_field_mapping:\s*target_field_mappings!inner\s*\(\s*[\s\S]*?id,\s*project_id,\s*status/
    )
    expect(code).toMatch(
      /\.eq\(\s*['"]target_field_mapping\.project_id['"]\s*,\s*projectId\s*\)/
    )
    expect(code).toMatch(
      /\.neq\(\s*['"]target_field_mapping\.status['"]\s*,\s*['"]rejected['"]\s*\)/
    )
  })

  it('query (b) fetches target_field_mappings scoped by target_field_id IN ruleFieldIds', () => {
    expect(code).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    expect(code).toMatch(/\.in\(\s*['"]target_field_id['"]\s*,\s*ruleFieldIds/)
  })

  it('query (b) applies project_id + rejected-status scoping directly on TFM', () => {
    // The TFM-target query uses direct `.eq('project_id', projectId)` + `.neq('status', 'rejected')`
    // (not via embedded filter). Ensure both filters are on the TFM block.
    expect(code).toMatch(
      /\.from\(\s*['"]target_field_mappings['"][\s\S]*?\.eq\(\s*['"]project_id['"]\s*,\s*projectId[\s\S]*?\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]/
    )
  })
})

// ── Flattening semantics (keyed by field_id, valued by TFM ref) ─────────────

describe('[validation-rules refinements] flatten semantics', () => {
  const body = executeCustomRulesBody()
  const code = stripComments(body)

  it('fmByFieldId values carry { id: tfm.id } (keyed by TFM id for downstream tx lookup)', () => {
    expect(code).toMatch(/fmByFieldId\.set\(\s*row\.source_field_id\s*,\s*\{\s*id:\s*tfm\.id\s*\}/)
    expect(code).toMatch(
      /fmByFieldId\.set\(\s*tfm\.target_field_id[\s\S]*?\{\s*id:\s*tfm\.id/
    )
  })

  it('tfmIds is deduped across both query results', () => {
    expect(code).toMatch(/tfmIds\s*=\s*\[\s*\.{3}new Set\(/)
  })

  it('ruleFieldIds membership is re-checked in-memory (belt-and-braces vs. embedded filter gaps)', () => {
    // Preserves legacy guard: don't set for a row whose matched field_id
    // falls outside the current ruleFieldIds set (e.g. if a query picks up
    // an extra row for some reason).
    expect(code).toMatch(/ruleFieldIds\.includes\(\s*row\.source_field_id\s*\)/)
    expect(code).toMatch(/ruleFieldIds\.includes\(\s*tfm\.target_field_id\s*\)/)
  })
})

// ── Transformations fetch uses new-model column ─────────────────────────────

describe('[validation-rules refinements] transformations column rename', () => {
  const body = executeCustomRulesBody()
  const code = stripComments(body)

  it('transformations are fetched by target_field_mapping_id (not field_mapping_id)', () => {
    expect(code).toMatch(
      /\.from\(\s*['"]transformations['"][\s\S]*?\.select\(\s*['"]target_field_mapping_id,\s*status['"]\s*\)[\s\S]*?\.in\(\s*['"]target_field_mapping_id['"]\s*,\s*tfmIds/
    )
  })

  it('txByTfmId is populated from target_field_mapping_id on each tx row', () => {
    expect(code).toMatch(/txByTfmId\.set\(\s*tx\.target_field_mapping_id/)
  })

  it('downstream attribution reads via txByTfmId.get(fm.id) (fm.id is a TFM id)', () => {
    expect(code).toMatch(/txByTfmId\.get\(\s*fm\.id\s*\)\s*\?\.status\s*===\s*['"]applied['"]/)
  })
})

// ── Guard-wiring decision (NONE, per Gate 2 §1.5) ───────────────────────────

describe('[validation-rules refinements] guard-wiring decision', () => {
  const body = executeCustomRulesBody()

  it('no assertMappingWritesEnabled import or call (quality_issues + validation_rules are not mapping-shape surfaces)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('documents the Guard-wiring decision in an inline comment block', () => {
    expect(body).toMatch(/Guard-wiring decision/i)
    expect(body).toMatch(/quality_issues/)
    expect(body).toMatch(/validation_rules/)
    expect(body).toMatch(/mapping-shape/i)
  })

  it('comment block is anchored to Prompt 3d Step 3D-7', () => {
    expect(body).toMatch(/Prompt 3d,?\s*Step 3D-7/)
  })
})
