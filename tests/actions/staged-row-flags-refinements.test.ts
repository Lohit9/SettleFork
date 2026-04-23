import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-5) rewrite of
 * `lib/actions/staged-row-flags.ts`.
 *
 * Preserved semantics:
 *   - Source→target name map is built from TFM + mapping_sources, scoped
 *     to the given table_mapping (tm.source_table_id + target_field.table_id
 *     == tm.target_table_id).
 *   - No ordinal filter — primary AND contributor MS rows both contribute,
 *     matching legacy which included is_contributing=true FMs.
 *   - `.neq('status', 'rejected')` preserved from the legacy field_mappings
 *     query.
 *   - No `is_acknowledged` filter — legacy never joined
 *     field_acknowledgments in this path.
 *   - Map.set last-wins semantics preserved for source fields that map to
 *     multiple target fields.
 *   - try/catch outer wrapper preserved (P2): best-effort flagging; apply
 *     itself must never fail because row_issues flagging failed.
 *
 * These tests are source-text based for the same reason as
 * `tests/actions/transforms-refinements.test.ts`: mocking Supabase's
 * chainable builder is strictly worse than grepping for the exact
 * call-shape we care about. See `docs/prompt-3a-remaining-work.md`
 * §Test coverage debt.
 */

const PATH = resolve(__dirname, '../../lib/actions/staged-row-flags.ts')
const SRC = readFileSync(PATH, 'utf8')

const TFX_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const TFX_SRC = readFileSync(TFX_PATH, 'utf8')

/**
 * Extract Step 5's CODE (comments stripped) so grep assertions only
 * hit actual query/filter expressions, not the inline docblock that
 * describes what the step does.
 */
function extractStep5Code(): string {
  const start = SRC.indexOf('// ── Step 5')
  const end = SRC.indexOf('// ── Step 6', start)
  if (start < 0 || end < 0) throw new Error('Step 5 slice markers not found')
  const slice = SRC.slice(start, end)
  return slice
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[staged-row-flags refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls', () => {
    expect(SRC).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no legacy field_mapping_id column reference', () => {
    expect(SRC).not.toMatch(/field_mapping_id/)
  })

  it('no legacy field_mappings_target_field_id_fkey disambiguator', () => {
    // If this string appears, we forgot to swap the legacy PostgREST
    // disambiguator when rewriting the join.
    expect(SRC).not.toMatch(/field_mappings_target_field_id_fkey/)
  })
})

// ── New-model query shape ────────────────────────────────────────────────────

describe('[staged-row-flags refinements] new-model source→target map query', () => {
  it('queries target_field_mappings with an inner mapping_sources join', () => {
    expect(SRC).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    expect(SRC).toMatch(/mapping_sources!inner/)
  })

  it('scopes MS rows to the TM via source_table_id + source_field_id filters', () => {
    expect(SRC).toMatch(/\.eq\(\s*['"]mapping_sources\.source_table_id['"]/)
    expect(SRC).toMatch(/\.in\(\s*['"]mapping_sources\.source_field_id['"]/)
  })

  it('selects target_field name + table_id (needed for the target-table scope check)', () => {
    expect(SRC).toMatch(/target_field:\s*fields!target_field_id\s*\(\s*name,\s*table_id\s*\)/)
  })

  it('preserves the legacy `.neq(status, rejected)` filter', () => {
    expect(SRC).toMatch(/\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]\s*\)/)
  })

  it('does NOT add an is_acknowledged filter (preserves legacy source→target map surface)', () => {
    const step5CodeOnly = extractStep5Code()
    expect(step5CodeOnly).not.toMatch(/is_acknowledged/)
  })

  it('does NOT add an ordinal filter (primary + contributors both contribute)', () => {
    const step5CodeOnly = extractStep5Code()
    expect(step5CodeOnly).not.toMatch(/\bordinal\b/)
  })

  it('guards against an empty .in([]) by checking fieldIds.length > 0', () => {
    expect(SRC).toMatch(/if\s*\(\s*fieldIds\.length\s*>\s*0\s*\)/)
  })

  it('in-memory filter scopes to tm.target_table_id (target-side TM scope)', () => {
    expect(SRC).toMatch(/table_id\s*!==\s*tm\.target_table_id/)
  })

  it('documents the Prompt 3d rewrite + preserved-legacy decisions inline', () => {
    expect(SRC).toMatch(/Prompt 3d/)
    expect(SRC).toMatch(/Preserved-legacy/i)
  })
})

// ── Outer try/catch preserved (P2) ───────────────────────────────────────────

describe('[staged-row-flags refinements] outer try/catch preserved', () => {
  it('main export is wrapped in a top-level try/catch', () => {
    // Guard against accidental removal of the outer try/catch in a future
    // refactor — callers rely on the graceful-error return shape.
    expect(SRC).toMatch(/export async function flagStagedRowIssues[\s\S]*?try\s*\{/)
    expect(SRC).toMatch(/\}\s*catch\s*\(\s*err[\s\S]*?return\s*\{\s*flaggedRows:\s*0/)
  })
})

// ── P2 comment wiring on the transformations.ts call site ────────────────────

describe('[staged-row-flags refinements] P2 call-site comment in transformations.ts', () => {
  it('comment above the applyTransform call matches the Gate 2 approved text', () => {
    expect(TFX_SRC).toMatch(
      /Call into staged-row-flags best-effort\. Function is functional[\s\S]*?as of Prompt 3d commit; try\/catch retained as defense against[\s\S]*?unexpected runtime errors \(network, DB, RPC failures\)\./
    )
  })

  it('try/catch wrapper is still there (P2: defense-in-depth, not removed)', () => {
    const commentIdx = TFX_SRC.indexOf('Call into staged-row-flags best-effort')
    expect(commentIdx).toBeGreaterThan(0)
    // Slice must span from the comment through the end of the catch block.
    // The try body includes an embedded Supabase query chain, so we need
    // a generous window (~2000 chars).
    const slice = TFX_SRC.slice(commentIdx, commentIdx + 2000)
    expect(slice).toMatch(/try\s*\{/)
    expect(slice).toMatch(/flagStagedRowIssues/)
    // The catch has no binding in the current code (`} catch {`); the regex
    // below tolerates optional `(err)` if a future refactor adds one.
    expect(slice).toMatch(/\}\s*catch(?:\s*\([^)]*\))?\s*\{/)
  })

  it('OUT-OF-SCOPE header block is updated to reflect the 3D-5 rewrite', () => {
    expect(TFX_SRC).toMatch(/Rewritten in Prompt 3d \(Step 3D-5\)/)
    // And the stale "still queries legacy `field_mappings`" claim is gone.
    expect(TFX_SRC).not.toMatch(/Still queries legacy ['`]?field_mappings['`]?/)
  })
})
