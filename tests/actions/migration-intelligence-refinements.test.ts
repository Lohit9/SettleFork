import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-9) rewrite of
 * `lib/actions/migration-intelligence.ts`.
 *
 * Scope (per Gate 2 §1.8):
 *   - Single site (was line 499) inside `extractMigrationIntelligence`:
 *     the per-TM `.from('field_mappings')` fetch is replaced with a
 *     project-scoped `.from('target_field_mappings')` fetch that nests
 *     `mapping_sources` (with their own `source_field` embed) and
 *     `target_field`.
 *   - Column renames on all `transformations` queries:
 *     `field_mapping_id` → `target_field_mapping_id`.
 *
 * Q3 decision (preserve legacy primary+contributor iteration):
 *   - Legacy: N field_mappings rows per multi-source mapping → N lines
 *     in the Claude prompt.
 *   - New: flatten TFM+MS into FM-shaped rows, one per primary MS and
 *     one per contributor MS (ordinal ascending). Value assignments
 *     (no MS, combination_type='custom_sql') produce one row each.
 *     Bare-ack TFMs (no MS, not VA) produce zero rows.
 *   - Contributor flat-rows carry a SENTINEL id (not the real TFM id)
 *     so `transformsByTfmId.get(flat.id)` returns undefined for them —
 *     legacy: only the primary FM had a transformation, so the
 *     "Transform:" line rendered exactly once per multi-source mapping.
 *
 * Confidence formatter (3c fix): MUST remain `Math.round(fm.confidence)`
 * — NOT `Math.round(fm.confidence * 100)`. Per the directive this
 * cannot regress.
 *
 * Guard wiring: NONE. `extractMigrationIntelligence` writes only to
 * `migration_intelligence` (a KB table), not to any mapping-shape
 * surface. A comment block above the function documents this.
 *
 * Tests are source-text-based for the same reasons as the other
 * `*-refinements.test.ts` files — see `docs/prompt-3a-remaining-work.md`.
 */

const PATH = resolve(__dirname, '../../lib/actions/migration-intelligence.ts')
const SRC = readFileSync(PATH, 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function extractBody(): string {
  const start = SRC.indexOf('export async function extractMigrationIntelligence')
  const end = SRC.indexOf('// ── Query Helper')
  if (start < 0 || end < 0) throw new Error('extractMigrationIntelligence body markers not found')
  return SRC.slice(start, end)
}

function tfmFetchSlice(): string {
  const start = SRC.indexOf('// ── Parallel data fetch (hop 2)')
  const end = SRC.indexOf('// ── Parallel data fetch (hop 3)')
  if (start < 0 || end < 0) throw new Error('TFM fetch slice markers not found')
  return SRC.slice(start, end)
}

function hop3Slice(): string {
  const start = SRC.indexOf('// ── Parallel data fetch (hop 3)')
  const end = SRC.indexOf('// ── Fetch existing patterns')
  if (start < 0 || end < 0) throw new Error('hop3 slice markers not found')
  return SRC.slice(start, end)
}

function mappingsSectionSlice(): string {
  const start = SRC.indexOf('// Mappings section')
  const end = SRC.indexOf('// Transformations section', start)
  if (start < 0 || end < 0) throw new Error('mappings section markers not found')
  return SRC.slice(start, end)
}

function transformsSectionSlice(): string {
  const start = SRC.indexOf('// Transformations section')
  const end = SRC.indexOf('// Quality issues section', start)
  if (start < 0 || end < 0) throw new Error('transforms section markers not found')
  return SRC.slice(start, end)
}

function feedbackLoopSlice(): string {
  const start = SRC.indexOf('// Build ProjectOutcomes from already-fetched data')
  const end = SRC.indexOf('const detectedIssues: DetectedIssue[]')
  if (start < 0 || end < 0) throw new Error('feedback loop markers not found')
  return SRC.slice(start, end)
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[migration-intelligence refinements] zero legacy refs', () => {
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

  it('no legacy table_mapping_id column filter on TFMs (TFMs are project-scoped)', () => {
    // Ensure the per-TM `.in('table_mapping_id', tableMappingIds)` filter
    // from the legacy FM query was NOT carried forward.
    const code = stripComments(tfmFetchSlice())
    expect(code).not.toMatch(/\.in\(\s*['"]table_mapping_id['"]/)
  })
})

// ── New-model TFM query shape ────────────────────────────────────────────────

describe('[migration-intelligence refinements] new-model TFM+MS query', () => {
  const body = tfmFetchSlice()
  const code = stripComments(body)

  it('fetches .from(target_field_mappings) (not field_mappings)', () => {
    expect(code).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
  })

  it('scopes by project_id (TFMs are project-scoped, not per-TM)', () => {
    expect(code).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/)
  })

  it('filters out rejected TFMs (preserves legacy "don\'t include rejected" semantics)', () => {
    expect(code).toMatch(/\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]\s*\)/)
  })

  it('selects TFM-level confidence + needs_transformation + combination_type', () => {
    expect(code).toMatch(/\bconfidence\b/)
    expect(code).toMatch(/\bneeds_transformation\b/)
    expect(code).toMatch(/\bcombination_type\b/)
  })

  it('nests target_field (name, data_type, is_nullable, PK/FK, table_id) via embed', () => {
    expect(body).toMatch(
      /target_field:\s*fields!target_field_id\s*\([\s\S]*?\bname\b[\s\S]*?\bdata_type\b[\s\S]*?\bis_nullable\b[\s\S]*?\bis_primary_key\b[\s\S]*?\bis_foreign_key\b[\s\S]*?\btable_id\b/
    )
  })

  it('nests mapping_sources with per-MS confidence + source_table_id + ordinal', () => {
    expect(body).toMatch(
      /mapping_sources\s*\([\s\S]*?\bordinal\b[\s\S]*?\bsource_field_id\b[\s\S]*?\bsource_table_id\b[\s\S]*?\bconfidence\b/
    )
  })

  it('nests mapping_sources.source_field (name, data_type, inferred_type) via embed', () => {
    expect(body).toMatch(
      /source_field:\s*fields!source_field_id\s*\([\s\S]*?\bname\b[\s\S]*?\bdata_type\b[\s\S]*?\binferred_type\b/
    )
  })
})

// ── Flattening + Q3 preservation ─────────────────────────────────────────────

describe('[migration-intelligence refinements] TFM→FM flattening (Q3)', () => {
  const body = tfmFetchSlice()
  const code = stripComments(body)

  it('sorts mapping_sources by ordinal ascending so primary comes first', () => {
    expect(code).toMatch(/sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*a\.ordinal\s*-\s*b\.ordinal\s*\)/)
  })

  it('emits one flat row per MS (primary + each contributor) for mapped TFMs', () => {
    expect(code).toMatch(/for\s*\(\s*const\s+ms\s+of\s+msAll\s*\)/)
    expect(code).toMatch(/fieldMappings\.push\(/)
  })

  it('handles VA case (combination_type=custom_sql, zero sources) as one row with source_field_id=null', () => {
    expect(code).toMatch(/combination_type\s*===\s*['"]custom_sql['"]/)
    expect(code).toMatch(/source_field_id:\s*null/)
    expect(code).toMatch(/source_field:\s*null/)
  })

  it('skips bare-ack TFMs (no MS, not VA) — they never emitted legacy prompt lines', () => {
    expect(code).toMatch(/isBareAck/)
    expect(code).toMatch(/if\s*\(\s*isBareAck\s*\)\s*continue/)
  })

  // Migration 077: dismissed VAs ("no value needed") drop out of the
  // intelligence rollup so the migration plan / risk surface matches
  // execution-package and migration-runbook semantics.
  it('SELECT includes va_dismissed (migration 077)', () => {
    expect(code).toMatch(/\bva_dismissed\b/)
  })

  it('skips dismissed VAs during flattening (migration 077)', () => {
    expect(code).toMatch(/isVA\s*&&\s*tfm\.va_dismissed\s*===\s*true/)
  })

  it('derives owning table_mapping via target_field.table_id + primary.source_table_id match', () => {
    expect(code).toMatch(/owningTm/)
    expect(code).toMatch(/tm\.target_table_id\s*!==\s*tgt\.table_id/)
    expect(code).toMatch(/primary\.source_table_id\s*===\s*tm\.source_table_id/)
  })

  it('contributor flat-rows carry a SENTINEL id so transformsByTfmId.get() returns undefined', () => {
    // Sentinel pattern like `${tfm.id}:contrib:${ms.ordinal}` (not a UUID).
    expect(code).toMatch(/\$\{\s*tfm\.id\s*\}\s*:contrib:\s*\$\{\s*ms\.ordinal\s*\}/)
    expect(code).toMatch(/isPrimary\s*\?\s*tfm\.id\s*:/)
  })

  it('primary flat-row uses the real TFM id (needed by .find(f.id === t.target_field_mapping_id))', () => {
    // VA push: id: tfm.id. Mapped primary: isPrimary ? tfm.id : sentinel.
    expect(code).toMatch(/id:\s*tfm\.id,/)
  })

  it('surfaces TFM-level needs_transformation on every flat row (migration 075: lives on TFM)', () => {
    expect(code).toMatch(/needs_transformation:\s*tfm\.needs_transformation/)
  })

  it('surfaces per-MS confidence on mapped flat rows (preserves per-FM confidence attribution)', () => {
    expect(code).toMatch(/confidence:\s*ms\.confidence/)
  })

  it('uses TFM.confidence on VA rows (VAs store direct confidence, not MIN(MS))', () => {
    // VA push block carries: confidence: tfm.confidence.
    expect(code).toMatch(/confidence:\s*tfm\.confidence,/)
  })

  it('documents the Q3 preserve-legacy-iteration decision inline', () => {
    expect(body).toMatch(/Q3/)
    expect(body).toMatch(/primary[\s\S]*?contributor/i)
  })
})

// ── Hop 3: transformations query + map (column rename) ───────────────────────

describe('[migration-intelligence refinements] transformations query rename', () => {
  const body = hop3Slice()
  const code = stripComments(body)

  it('selects transformations by target_field_mapping_id (NOT field_mapping_id)', () => {
    expect(code).toMatch(/\.in\(\s*['"]target_field_mapping_id['"]\s*,\s*tfmIds\s*\)/)
  })

  it('includes target_field_mapping_id in the select projection', () => {
    expect(code).toMatch(
      /\.select\(\s*['"]id,\s*target_field_mapping_id,\s*description,\s*generated_sql,\s*status['"]\s*\)/
    )
  })

  it('map is keyed by t.target_field_mapping_id (not t.field_mapping_id)', () => {
    expect(code).toMatch(/\[\s*t\.target_field_mapping_id\s*,\s*t\s*\]/)
    expect(code).toMatch(/transformsByTfmId/)
  })
})

// ── Feedback loop (column renames downstream) ────────────────────────────────

describe('[migration-intelligence refinements] feedback loop rename', () => {
  const body = feedbackLoopSlice()
  const code = stripComments(body)

  it('resolves each transformation against its TFM via t.target_field_mapping_id', () => {
    expect(code).toMatch(/f\.id\s*===\s*t\.target_field_mapping_id/)
  })

  it('still skips VAs (source_field_id == null) in applied-transforms projection', () => {
    expect(code).toMatch(/fm\.source_field_id\s*==\s*null/)
  })

  it('no legacy t.field_mapping_id references in the feedback loop', () => {
    expect(code).not.toMatch(/t\.field_mapping_id/)
  })
})

// ── Mappings section: confidence formatter MUST PRESERVE 3c fix ──────────────

describe('[migration-intelligence refinements] mappings section: confidence formatter', () => {
  const body = mappingsSectionSlice()
  const code = stripComments(body)

  it('renders Math.round(fm.confidence) — NOT Math.round(fm.confidence * 100) (3c fix)', () => {
    expect(code).toMatch(/Math\.round\(\s*fm\.confidence\s*\)/)
    expect(code).not.toMatch(/Math\.round\(\s*fm\.confidence\s*\*\s*100\s*\)/)
  })

  it('documents the 3c confidence-formatter fix inline (regression guard)', () => {
    expect(body).toMatch(/Prompt 3c|3c fix|9500%/)
  })

  it('renders " | Needs transform: yes/no" column from fm.needs_transformation', () => {
    expect(code).toMatch(/fm\.needs_transformation\s*\?\s*['"]yes['"]\s*:\s*['"]no['"]/)
  })

  it('looks up transforms via transformsByTfmId.get(fm.id) (contributors → undefined by design)', () => {
    expect(code).toMatch(/transformsByTfmId\.get\(\s*fm\.id\s*\)/)
  })

  it('emits "[Value Assignment]" when source_field_id is null', () => {
    expect(body).toMatch(/\[Value Assignment\]/)
    expect(code).toMatch(/fm\.source_field_id\s*==\s*null/)
  })

  it('filters flat rows per-TM via fm.table_mapping_id === tm.id (owning-TM group)', () => {
    expect(code).toMatch(/fm\.table_mapping_id\s*===\s*tm\.id/)
  })
})

// ── Transforms section: column rename ────────────────────────────────────────

describe('[migration-intelligence refinements] transforms section', () => {
  const body = transformsSectionSlice()
  const code = stripComments(body)

  it('resolves each transformation against its TFM via t.target_field_mapping_id', () => {
    expect(code).toMatch(/f\.id\s*===\s*t\.target_field_mapping_id/)
  })

  it('no legacy t.field_mapping_id references in the transforms render loop', () => {
    expect(code).not.toMatch(/t\.field_mapping_id/)
  })
})

// ── Guard-wiring decision (NONE) ─────────────────────────────────────────────

describe('[migration-intelligence refinements] guard-wiring decision', () => {
  const body = extractBody()

  it('no assertMappingWritesEnabled import or call (migration_intelligence is not a mapping-shape surface)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('documents the Guard-wiring decision above extractMigrationIntelligence', () => {
    // Comment block sits between the section header and the function signature.
    const start = SRC.indexOf('// ── Main Extraction Action')
    const end = SRC.indexOf('export async function extractMigrationIntelligence')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const slice = SRC.slice(start, end)
    expect(slice).toMatch(/Guard-wiring decision/i)
    expect(slice).toMatch(/migration_intelligence/)
    expect(slice).toMatch(/mapping-shape/i)
    expect(slice).toMatch(/Prompt 3d,?\s*Step 3D-9/)
  })

  it('feedback-loop and dedupe UPDATE/INSERT both target migration_intelligence only', () => {
    // Walk every `.from('<table>')` usage and assert that any write
    // verb (`.insert(`, `.update(`, `.upsert(`, `.delete(`) on the
    // same chain targets the `migration_intelligence` KB table — never
    // a mapping-shape surface. Non-mapping reads (e.g. `.from('tables')`,
    // `.from('quality_issues')`) may remain untouched.
    const code = stripComments(body)
    const chainRe = /\.from\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)(?=\.from\(|\s*await\s|$)/g
    let m: RegExpExecArray | null
    while ((m = chainRe.exec(code)) !== null) {
      const [, table, rest] = m
      const isMutation = /\.(?:insert|update|upsert|delete)\s*\(/.test(rest)
      if (isMutation) {
        expect(table).toBe('migration_intelligence')
      }
    }
  })
})
