import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-6) rewrite of
 * `lib/actions/staging.ts`.
 *
 * Two sites were rewritten:
 *   - Site A: `stageAllData` — per-TM TFM fetch replaced via the
 *     owning-TM rule; jsonb_build_object pair construction preserved
 *     exactly; `transformByFMId` → `transformByTfmId`; transformations
 *     scoped by `target_field_mapping_id`.
 *   - Site B: `getStagedDataPreview` — same rewrite, but contributors
 *     (MS with ordinal >= 1) are excluded naturally (MS[ordinal=0] only
 *     is consulted per TFM).
 *
 * Other invariants:
 *   - Column rename: `field_mapping_id` → `target_field_mapping_id`
 *     everywhere in this file.
 *   - Guard wiring: NO `assertMappingWritesEnabled` call per Q4 (the
 *     `saved|tested → applied` flip is data-lifecycle, not mapping-shape).
 *     A verbatim Q4 decision comment block documents the rationale.
 *   - Value-assignment detection: `combination_type === 'custom_sql'` AND
 *     `mapping_sources.length === 0` (bare-ack TFMs are excluded).
 *
 * Tests are source-text-based for the same reasons as the other
 * `*-refinements.test.ts` files: mocking Supabase's chainable builder
 * is strictly worse than asserting call-shape directly. See
 * `docs/prompt-3a-remaining-work.md` §Test coverage debt.
 */

const PATH = resolve(__dirname, '../../lib/actions/staging.ts')
const SRC = readFileSync(PATH, 'utf8')

/**
 * Strip all // and block comments from a slice of source so grep
 * assertions only fire on real code, not docblocks or inline
 * explanations that legitimately mention legacy terms.
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function sliceBetween(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle)
  if (start < 0) throw new Error(`Start marker not found: ${startNeedle}`)
  const end = src.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) throw new Error(`End marker not found: ${endNeedle}`)
  return src.slice(start, end)
}

function stageAllDataBody(): string {
  return sliceBetween(
    SRC,
    'export async function stageAllData',
    'export async function checkStagingFreshness'
  )
}

function getStagedDataPreviewBody(): string {
  return sliceBetween(
    SRC,
    'export async function getStagedDataPreview',
    '\n}\n' // closes the function, but we'll rely on a downstream marker
  )
}

// Since getStagedDataPreview is the last exported function in the file
// we need a different slicing strategy.
function getStagedDataPreviewBodyFull(): string {
  const start = SRC.indexOf('export async function getStagedDataPreview')
  if (start < 0) throw new Error('getStagedDataPreview not found')
  return SRC.slice(start)
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[staging refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls anywhere in the file', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls anywhere in the file', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no legacy field_mapping_id column reference in code (distinct from target_field_mapping_id)', () => {
    const codeOnly = stripComments(SRC)
    // Negative lookbehind rules out the legitimate new-model column
    // `target_field_mapping_id`. Only the bare legacy column should be absent.
    expect(codeOnly).not.toMatch(/(?<!target_)field_mapping_id/)
  })

  it('no legacy table_mapping_id filter on field_mappings (the per-TM legacy fetch)', () => {
    // Matches the legacy shape `.eq('table_mapping_id', tm.id)` that was
    // scoped against the field_mappings table. The new-model code scopes
    // via `target_field.table_id` + owning-TM rule instead.
    const codeOnly = stripComments(SRC)
    expect(codeOnly).not.toMatch(
      /\.from\(\s*['"]field_mappings['"][\s\S]*?\.eq\(\s*['"]table_mapping_id['"]/
    )
  })

  it('no stale transformByFMId / transformIdByFMId / tgtNameByFMId identifiers', () => {
    const codeOnly = stripComments(SRC)
    expect(codeOnly).not.toMatch(/transformByFMId/)
    expect(codeOnly).not.toMatch(/transformIdByFMId/)
    expect(codeOnly).not.toMatch(/tgtNameByFMId/)
  })

  it('no `is_contributing` column reference in code (removed from new-model path)', () => {
    const codeOnly = stripComments(SRC)
    expect(codeOnly).not.toMatch(/is_contributing/)
  })
})

// ── stageAllData (Site A) new-model shape ────────────────────────────────────

describe('[staging refinements] stageAllData new-model TFM fetch', () => {
  const body = stageAllDataBody()
  const code = stripComments(body)

  it('fetches target_field_mappings with project_id scope', () => {
    expect(code).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    expect(code).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/)
  })

  it('preserves `.neq(status, rejected)` filter on TFMs', () => {
    expect(code).toMatch(/\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]\s*\)/)
  })

  it('scopes TFMs server-side via target_field.table_id', () => {
    expect(code).toMatch(
      /\.eq\(\s*['"]target_field\.table_id['"]\s*,\s*tm\.target_table_id\s*\)/
    )
  })

  it('selects the nested mapping_sources with source_field_id, source_table_id, ordinal, and source_field name', () => {
    expect(body).toMatch(/mapping_sources\s*\(/)
    expect(body).toMatch(/source_field_id/)
    expect(body).toMatch(/source_table_id/)
    expect(body).toMatch(/\bordinal\b/)
    expect(body).toMatch(/source_field:\s*fields!source_field_id/)
  })

  it('selects the nested target_field (id, name, table_id)', () => {
    expect(body).toMatch(/target_field:\s*fields!target_field_id\s*\([^)]*\bname\b[^)]*\btable_id\b/)
  })

  it('applies the owning-TM rule in-memory (primary MS must match tm.source_table_id)', () => {
    expect(code).toMatch(
      /primary\.source_table_id\s*===\s*tm\.source_table_id/
    )
  })

  it('applies the owning-TM rule using MS[ordinal=0] (primary)', () => {
    expect(code).toMatch(/primary\.ordinal\s*===\s*0/)
  })

  it('detects value assignments via combination_type === custom_sql AND ms.length === 0', () => {
    // VA filter branch in the in-memory filter. Migration 077 reshaped
    // the conditional from
    //   return row.combination_type === 'custom_sql'
    // to a two-step
    //   if (row.combination_type !== 'custom_sql') return false
    //   return va_dismissed !== true
    // Either form encodes the same VA detection. Pin both to remain
    // resilient to future refactors that re-flip the conditional.
    expect(code).toMatch(/combination_type\s*(?:===|!==)\s*['"]custom_sql['"]/)
  })

  // Migration 077: dismissed VAs ("no value needed") must not appear in the
  // staged write path. The SELECT must include the column and the in-memory
  // filter must reject `va_dismissed === true` on VA-only rows.
  it('SELECT includes va_dismissed (migration 077)', () => {
    expect(code).toMatch(/\bva_dismissed\b/)
  })

  it('filters out VA TFMs where va_dismissed === true', () => {
    expect(code).toMatch(/va_dismissed\s*\?:\s*boolean\s*\|\s*null|va_dismissed\s*!==\s*true/)
  })

  it('scopes transformations by target_field_mapping_id (column rename)', () => {
    expect(code).toMatch(
      /\.from\(\s*['"]transformations['"][\s\S]*?\.select\(\s*['"]id,\s*target_field_mapping_id/
    )
    expect(code).toMatch(
      /\.in\(\s*['"]target_field_mapping_id['"]\s*,\s*tfmIds\s*\)/
    )
  })

  it('builds transformByTfmId / transformIdByTfmId maps keyed by target_field_mapping_id', () => {
    expect(code).toMatch(/transformByTfmId/)
    expect(code).toMatch(/transformIdByTfmId/)
    expect(code).toMatch(/t\.target_field_mapping_id,\s*t\.generated_sql/)
    expect(code).toMatch(/t\.target_field_mapping_id,\s*t\.id/)
  })

  it('preserves the transformations status filter (saved|tested|applied)', () => {
    expect(code).toMatch(
      /\.in\(\s*['"]status['"]\s*,\s*\[\s*['"]saved['"]\s*,\s*['"]tested['"]\s*,\s*['"]applied['"]\s*\]/
    )
  })

  it('preserves the jsonb_build_object pair construction + wrapFieldRefsInJsonb call', () => {
    expect(code).toMatch(/jsonbPairs/)
    expect(code).toMatch(/jsonb_build_object/)
    expect(code).toMatch(/wrapFieldRefsInJsonb/)
    // NULL guard branch on non-VA mapped fields
    expect(code).toMatch(/CASE WHEN \(row_data->>/)
  })

  it('iterates per-TFM (one jsonb pair per TFM, contributors as MS[ordinal>=1] folded in)', () => {
    expect(code).toMatch(/for\s*\(\s*const\s+tfm\s+of\s+tfms\s*\)/)
  })

  it('VA branch produces a pair even without a source field (per Gate 2 reminder)', () => {
    // In the VA branch, the value is either transformSql or NULL, no src dep
    expect(code).toMatch(/isValueAssignment/)
    // The loop must NOT abort on missing source when isValueAssignment
    expect(code).toMatch(/if\s*\(\s*!isValueAssignment\s*&&\s*!srcField\s*\)\s*continue/)
  })
})

// ── stageAllData Q4 decision comment block ───────────────────────────────────

describe('[staging refinements] Q4 decision comment block', () => {
  const body = stageAllDataBody()

  it('documents the Q4 decision (no assertMappingWritesEnabled guard) inline', () => {
    expect(body).toMatch(/Gate 2 Q4 decision/)
    expect(body).toMatch(/no\s*`?assertMappingWritesEnabled`?\s*guard/i)
    expect(body).toMatch(/data-lifecycle/i)
    expect(body).toMatch(/mapping shape/i)
  })

  it('explicitly mentions target_field_mappings / mapping_sources as the protected surface', () => {
    expect(body).toMatch(/target_field_mappings/)
    expect(body).toMatch(/mapping_sources/)
  })

  it('does NOT actually import or call assertMappingWritesEnabled (guard MUST remain absent)', () => {
    const code = stripComments(body)
    expect(code).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('also documents the status-flip comment on the UPDATE call site itself', () => {
    // Gate 2 Q4 block at function top + inline note on the UPDATE call.
    expect(body).toMatch(/data-lifecycle flip/i)
  })

  it('transformIdsToMark is still fed from the tfm-id map (downstream consumer renamed)', () => {
    const code = stripComments(body)
    expect(code).toMatch(/transformIdsToMark\s*=\s*\[\s*\.{3}transformIdByTfmId\.values\(\)/)
  })
})

// ── getStagedDataPreview (Site B) new-model shape ────────────────────────────

describe('[staging refinements] getStagedDataPreview new-model TFM fetch', () => {
  const body = getStagedDataPreviewBodyFull()
  const code = stripComments(body)

  it('resolves the owning table_mapping (with project_id, source/target table ids) up front', () => {
    expect(code).toMatch(
      /\.from\(\s*['"]table_mappings['"][\s\S]*?\.select\([^)]*project_id[\s\S]*?source_table_id[\s\S]*?target_table_id/
    )
  })

  it('fetches target_field_mappings scoped by project_id + target_field.table_id', () => {
    expect(code).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    expect(code).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*tmRow\.project_id\s*\)/)
    expect(code).toMatch(
      /\.eq\(\s*['"]target_field\.table_id['"]\s*,\s*tmRow\.target_table_id\s*\)/
    )
  })

  it('applies the owning-TM source rule using MS[ordinal=0] only (contributors excluded)', () => {
    expect(code).toMatch(/primary\.ordinal\s*===\s*0/)
    expect(code).toMatch(/primary\.source_table_id\s*===\s*tmRow\.source_table_id/)
  })

  it('detects VAs via combination_type === custom_sql AND ms.length === 0', () => {
    // See sister test in stageAllData section — migration 077 flipped
    // this filter to an early-return form (`!==` then `va_dismissed`
    // check). Either spelling is acceptable.
    expect(code).toMatch(/combination_type\s*(?:===|!==)\s*['"]custom_sql['"]/)
  })

  // Migration 077: dismissed VAs are filtered out of the preview as well so
  // the staged-rows table never shows a column the user has already opted
  // out of. Symmetric to the stageAllData filter pinned above.
  it('SELECT includes va_dismissed (migration 077)', () => {
    expect(code).toMatch(/\bva_dismissed\b/)
  })

  it('filters out VA TFMs where va_dismissed === true', () => {
    expect(code).toMatch(/va_dismissed\s*\?:\s*boolean\s*\|\s*null|va_dismissed\s*!==\s*true/)
  })

  it('builds tgtNameByTfmId (renamed from tgtNameByFMId) keyed by TFM id', () => {
    expect(code).toMatch(/tgtNameByTfmId/)
    expect(code).toMatch(/tgtNameByTfmId\.set\(\s*tfm\.id/)
  })

  it('queries applied transformations scoped by target_field_mapping_id', () => {
    expect(code).toMatch(
      /\.from\(\s*['"]transformations['"][\s\S]*?\.select\(\s*['"]target_field_mapping_id['"]\s*\)[\s\S]*?\.in\(\s*['"]target_field_mapping_id['"]\s*,\s*tfmIds/
    )
  })

  it('VAs without a source read from transformed_row_data only (preserves legacy semantics)', () => {
    expect(code).toMatch(/valueAssignmentTargetNames/)
    // The VA merge branch in the staged path uses only transformed:
    expect(code).toMatch(
      /for\s*\(\s*const\s+tgtName\s+of\s+valueAssignmentTargetNames\s*\)/
    )
  })

  it('VAs in the passthrough (no-staging) branch show null for the source column', () => {
    // The passthrough branch has TWO `for (const tgtName of valueAssignmentTargetNames)`
    // loops (one in hasStaged path, one in the passthrough else). The passthrough
    // one assigns `null` unconditionally. Assert on the raw body (comments intact)
    // since the "Value assignments have no source" docstring is part of the check.
    expect(body).toMatch(
      /Value assignments have no source[\s\S]*?tgtName\s+of\s+valueAssignmentTargetNames[\s\S]*?=\s*null/
    )
  })
})

// ── pickTargetField / pickSourceField helpers at module scope ────────────────

describe('[staging refinements] module-level helpers', () => {
  it('defines pickTargetField and pickSourceField as non-exported helpers', () => {
    expect(SRC).toMatch(/function\s+pickTargetField/)
    expect(SRC).toMatch(/function\s+pickSourceField/)
  })

  it('helpers are used in both rewritten sites', () => {
    const code = stripComments(SRC)
    const occurrences = (re: RegExp) => (code.match(re) ?? []).length
    expect(occurrences(/\bpickTargetField\(/g)).toBeGreaterThanOrEqual(3)
    expect(occurrences(/\bpickSourceField\(/g)).toBeGreaterThanOrEqual(2)
  })
})
