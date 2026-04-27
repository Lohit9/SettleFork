import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-10) rewrite of
 * `lib/actions/migration-runbook.ts`.
 *
 * Scope (per Gate 2 §1.9):
 *   - Single legacy FM fetch site (was lines 168-174) replaced with a
 *     project-scoped `target_field_mappings` fetch that nests
 *     `mapping_sources` and `target_field`.
 *   - Column renames on all `transformations` queries and lookups:
 *     `field_mapping_id` → `target_field_mapping_id`.
 *
 * Q3 decision (preserve legacy primary+contributor iteration):
 *   - Legacy: each multi-source mapping was N FM rows → N lines in the
 *     runbook mappingBlock AND counted N times in `${fms.length} field
 *     mappings` and `totalFieldMappings`.
 *   - New: flatten TFM+MS into FM-shaped rows — one per primary MS,
 *     one per contributor MS, one per VA, zero for bare-ack TFMs.
 *     Counts and per-line rendering both preserved byte-for-byte.
 *
 * DESIGN PATTERN — contributor sentinel ids:
 *   Contributor flat-rows carry `${tfm.id}:contrib:${ordinal}` as their
 *   `id` (not a real TFM id). Downstream `transformByTfmId.get(flat.id)`
 *   therefore misses for contributors, so the "| Transform: ..." tag
 *   still renders exactly once per multi-source mapping (on the primary
 *   line) — legacy parity. Same pattern as 3D-9.
 *
 * Legacy did NOT filter FM.status, so we DO NOT add a
 *   `.neq('status', 'rejected')` filter on the TFM query — matches
 *   legacy byte-for-byte for counts and mapping lines.
 *
 * Guard wiring: NONE. `generateMigrationRunbook` writes only to
 *   `outputs` + Supabase storage; not a mapping-shape surface.
 */

const PATH = resolve(__dirname, '../../lib/actions/migration-runbook.ts')
const SRC = readFileSync(PATH, 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function generateBody(): string {
  const start = SRC.indexOf('export async function generateMigrationRunbook')
  const end = SRC.indexOf('// ── getMigrationRunbookUrl')
  if (start < 0 || end < 0) throw new Error('generateMigrationRunbook body markers not found')
  return SRC.slice(start, end)
}

function hop2Slice(): string {
  const start = SRC.indexOf('// ── Parallel data fetch (hop 2)')
  const end = SRC.indexOf('// ── Parallel data fetch (hop 3)')
  if (start < 0 || end < 0) throw new Error('hop2 slice markers not found')
  return SRC.slice(start, end)
}

function hop3Slice(): string {
  const start = SRC.indexOf('// ── Parallel data fetch (hop 3)')
  const end = SRC.indexOf('// ── Compute stats')
  if (start < 0 || end < 0) throw new Error('hop3 slice markers not found')
  return SRC.slice(start, end)
}

function mappingBlockSlice(): string {
  const start = SRC.indexOf('// Mapping summary')
  const end = SRC.indexOf('// Transforms summary', start)
  if (start < 0 || end < 0) throw new Error('mapping block markers not found')
  return SRC.slice(start, end)
}

function transformBlockSlice(): string {
  const start = SRC.indexOf('// Transforms summary')
  const end = SRC.indexOf('// Open blocking issues', start)
  if (start < 0 || end < 0) throw new Error('transform block markers not found')
  return SRC.slice(start, end)
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[migration-runbook refinements] zero legacy refs', () => {
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

  it('no legacy transformByFMId variable name remains', () => {
    expect(stripComments(SRC)).not.toMatch(/transformByFMId/)
  })

  it('no legacy table_mapping_id filter on the TFM query (TFMs are project-scoped)', () => {
    const code = stripComments(hop2Slice())
    expect(code).not.toMatch(/\.in\(\s*['"]table_mapping_id['"]/)
  })
})

// ── New-model TFM query shape ────────────────────────────────────────────────

describe('[migration-runbook refinements] new-model TFM+MS query', () => {
  const body = hop2Slice()
  const code = stripComments(body)

  it('fetches .from(target_field_mappings) (not field_mappings)', () => {
    expect(code).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
  })

  it('scopes by project_id (TFMs are project-scoped, not per-TM)', () => {
    expect(code).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/)
  })

  it('does NOT add a status filter (legacy parity: rejected FMs were included)', () => {
    expect(code).not.toMatch(/\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]\s*\)/)
  })

  it('selects TFM-level needs_transformation + combination_type', () => {
    expect(code).toMatch(/\bneeds_transformation\b/)
    expect(code).toMatch(/\bcombination_type\b/)
  })

  it('nests target_field (name, data_type, is_foreign_key, fk_reference, table_id)', () => {
    expect(body).toMatch(
      /target_field:\s*fields!target_field_id\s*\([\s\S]*?\bname\b[\s\S]*?\bdata_type\b[\s\S]*?\bis_foreign_key\b[\s\S]*?\bfk_reference\b[\s\S]*?\btable_id\b/
    )
  })

  it('nests mapping_sources with ordinal + source_table_id', () => {
    expect(body).toMatch(
      /mapping_sources\s*\([\s\S]*?\bordinal\b[\s\S]*?\bsource_field_id\b[\s\S]*?\bsource_table_id\b/
    )
  })

  it('nests mapping_sources.source_field (name, data_type) via embed', () => {
    expect(body).toMatch(
      /source_field:\s*fields!source_field_id\s*\([\s\S]*?\bname\b[\s\S]*?\bdata_type\b/
    )
  })
})

// ── Flattening + Q3 preservation ─────────────────────────────────────────────

describe('[migration-runbook refinements] TFM→FM flattening (Q3)', () => {
  const body = hop2Slice()
  const code = stripComments(body)

  it('sorts mapping_sources by ordinal ascending so primary comes first', () => {
    expect(code).toMatch(/sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*a\.ordinal\s*-\s*b\.ordinal\s*\)/)
  })

  it('emits one flat row per MS (primary + each contributor) for mapped TFMs', () => {
    expect(code).toMatch(/for\s*\(\s*const\s+ms\s+of\s+msAll\s*\)/)
    expect(code).toMatch(/fms\.push\(/)
  })

  it('handles VA case (combination_type=custom_sql, zero sources) as one row with source_field_id=null', () => {
    expect(code).toMatch(/combination_type\s*===\s*['"]custom_sql['"]/)
    expect(code).toMatch(/source_field_id:\s*null/)
    expect(code).toMatch(/source_field:\s*null/)
  })

  it('skips bare-ack TFMs (no MS, not VA) — they never emitted legacy runbook lines', () => {
    expect(code).toMatch(/isBareAck/)
    expect(code).toMatch(/if\s*\(\s*isBareAck\s*\)\s*continue/)
  })

  // Migration 077: dismissed VAs ("no value needed") must drop out of the
  // generated runbook so the document accurately reports the rows it will
  // load. The SELECT list must include `va_dismissed` and the flattening
  // loop must skip TFMs where `isVA && va_dismissed === true`.
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

  it('surfaces TFM-level needs_transformation on every flat row (migration 075: lives on TFM)', () => {
    expect(code).toMatch(/needs_transformation:\s*tfm\.needs_transformation/)
  })
})

// ── Sentinel-id design pattern ───────────────────────────────────────────────

describe('[migration-runbook refinements] contributor sentinel id pattern', () => {
  const body = hop2Slice()
  const code = stripComments(body)

  it('contributor flat-rows carry sentinel ids `${tfm.id}:contrib:${ordinal}`', () => {
    expect(code).toMatch(/\$\{\s*tfm\.id\s*\}\s*:contrib:\s*\$\{\s*ms\.ordinal\s*\}/)
  })

  it('primary flat-row uses the real TFM id (lookups resolve to primary only)', () => {
    expect(code).toMatch(/isPrimary\s*\?\s*tfm\.id\s*:/)
  })

  it('documents the sentinel id pattern in the flattener header as a reusable DESIGN PATTERN', () => {
    expect(body).toMatch(/DESIGN PATTERN/i)
    expect(body).toMatch(/CONTRIBUTOR SENTINEL ID/i)
    expect(body).toMatch(/sentinel/i)
    // Explains WHY the pattern exists (transform-tag single-render).
    expect(body).toMatch(/exactly once per multi-source mapping/i)
  })
})

// ── Legacy count preservation ────────────────────────────────────────────────

describe('[migration-runbook refinements] fms.length count preservation', () => {
  const body = generateBody()

  it('user prompt renders `${fms.length} field mappings` (primary+contributor count, byte-for-byte)', () => {
    expect(body).toMatch(/\$\{\s*fms\.length\s*\}\s*field mappings/)
  })

  it('totalFieldMappings persisted to runbook uses fms.length', () => {
    expect(body).toMatch(/totalFieldMappings:\s*fms\.length/)
  })

  it('mappingBlock iterates fms.filter(fm => fm.table_mapping_id === tm.id) (owning-TM group)', () => {
    const code = stripComments(mappingBlockSlice())
    expect(code).toMatch(/fms\.filter\(\s*\(\s*fm\s*\)\s*=>\s*fm\.table_mapping_id\s*===\s*tm\.id\s*\)/)
  })

  it('per-TM field-count in the header line uses fields.length (flat rows; incl contributors)', () => {
    const body = mappingBlockSlice()
    expect(body).toMatch(/\$\{\s*fields\.length\s*\}\s*fields/)
  })
})

// ── Hop 3: transformations column rename ─────────────────────────────────────

describe('[migration-runbook refinements] transformations query rename', () => {
  const body = hop3Slice()
  const code = stripComments(body)

  it('fetches by target_field_mapping_id (NOT field_mapping_id)', () => {
    expect(code).toMatch(/\.in\(\s*['"]target_field_mapping_id['"]\s*,\s*tfmIds\s*\)/)
  })

  it('includes target_field_mapping_id in the select projection', () => {
    expect(code).toMatch(
      /\.select\(\s*['"]target_field_mapping_id,\s*description,\s*generated_sql,\s*status['"]\s*\)/
    )
  })

  it('guards the query on tfmIds.length > 0 (preserved from legacy fmIds.length > 0)', () => {
    expect(code).toMatch(/tfmIds\.length\s*>\s*0/)
  })

  it('transformByTfmId map is keyed by t.target_field_mapping_id', () => {
    expect(code).toMatch(/\[\s*t\.target_field_mapping_id\s*,\s*t\s*\]/)
    expect(code).toMatch(/transformByTfmId/)
  })
})

// ── Mapping block: transform-tag single-render via sentinel ──────────────────

describe('[migration-runbook refinements] mapping block transform tag', () => {
  const body = mappingBlockSlice()
  const code = stripComments(body)

  it('looks up transform via transformByTfmId.get(fm.id) (contributors miss by design)', () => {
    expect(code).toMatch(/transformByTfmId\.get\(\s*fm\.id\s*\)/)
  })

  it('emits "[Value Assignment]" when source_field_id is null', () => {
    expect(body).toMatch(/\[Value Assignment\]/)
    expect(code).toMatch(/fm\.source_field_id\s*==\s*null/)
  })

  it('preserves the `src (type) → tgt (type)` line shape (byte-for-byte)', () => {
    expect(body).toMatch(
      /\$\{srcLabel\}\s*→\s*\$\{tgtF\.name\}\s*\(\$\{tgtF\.data_type\}\)/
    )
  })

  it('preserves the " | Transform: ..." tag format', () => {
    expect(body).toMatch(/\|\s*Transform:\s*\$\{t\.description\s*\?\?\s*t\.generated_sql\?\.slice\(0,\s*60\)\s*\?\?\s*['"]yes['"]\}/)
  })

  it('preserves the per-TM slice(0, 20) cap on field rendering', () => {
    expect(body).toMatch(/fields\.slice\(0,\s*20\)/)
  })

  it('documents the sentinel-driven single-render contract at the transform tag lookup', () => {
    expect(body).toMatch(/sentinel/i)
    expect(body).toMatch(/exactly once per multi-source mapping/i)
  })
})

// ── Transforms summary: column rename ────────────────────────────────────────

describe('[migration-runbook refinements] transforms summary', () => {
  const body = transformBlockSlice()
  const code = stripComments(body)

  it('resolves each transformation against its TFM via t.target_field_mapping_id', () => {
    expect(code).toMatch(/f\.id\s*===\s*t\.target_field_mapping_id/)
  })

  it('no legacy t.field_mapping_id references in the transforms summary', () => {
    expect(code).not.toMatch(/t\.field_mapping_id/)
  })

  it('preserves the slice(0, 30) cap on transform rendering', () => {
    expect(code).toMatch(/\.slice\(0,\s*30\)/)
  })

  it('preserves the "[Value Assignment]" fallback when source_field_id is null', () => {
    expect(body).toMatch(/\[Value Assignment\]/)
  })
})

// ── Guard-wiring decision (NONE) ─────────────────────────────────────────────

describe('[migration-runbook refinements] guard-wiring decision', () => {
  it('no assertMappingWritesEnabled import or call (outputs/storage is not a mapping-shape surface)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('documents the Guard-wiring decision above generateMigrationRunbook', () => {
    const start = SRC.indexOf('// ── generateMigrationRunbook')
    const end = SRC.indexOf('export async function generateMigrationRunbook')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const slice = SRC.slice(start, end)
    expect(slice).toMatch(/Guard-wiring decision/i)
    expect(slice).toMatch(/outputs/)
    expect(slice).toMatch(/storage/)
    expect(slice).toMatch(/mapping-shape/i)
    expect(slice).toMatch(/Prompt 3d,?\s*Step 3D-10/)
  })

  it('every mutating `.from(<table>).<verb>(` chain in generateMigrationRunbook targets outputs only', () => {
    const body = generateBody()
    const code = stripComments(body)
    const chainRe = /\.from\(\s*['"]([^'"]+)['"]\s*\)([\s\S]*?)(?=\.from\(|\s*await\s|$)/g
    let m: RegExpExecArray | null
    while ((m = chainRe.exec(code)) !== null) {
      const [, table, rest] = m
      const isMutation = /\.(?:insert|update|upsert|delete)\s*\(/.test(rest)
      if (isMutation) {
        expect(table).toBe('outputs')
      }
    }
  })
})
