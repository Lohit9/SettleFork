/**
 * Unit tests for `lib/ai/path-d-parser.ts`.
 *
 * Fixture-driven (tests/fixtures/path-d/*.xml). Pure-function tests;
 * no DB, no LLM. Covers: happy path, partial output / per-section recovery,
 * malformed JSON / per-section recovery, empty sections (Zod default-array
 * behavior), cross-section index references preserved verbatim (UUID
 * resolution is persistence's job, NOT parser's).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parsePathDOutput,
  createPathDStreamParser,
  type PathDParsedOutput,
} from '@/lib/ai/path-d-parser'

const FIXTURES_DIR = resolve(__dirname, '../fixtures/path-d')

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf8')
}

describe('parsePathDOutput — happy path (all 7 sections clean)', () => {
  let parsed: PathDParsedOutput
  beforeEach(loadHappy)
  function loadHappy() {
    parsed = parsePathDOutput(loadFixture('happy-path.xml'))
  }

  it('parses all 7 sections successfully', () => {
    expect(parsed.mappings.status).toBe('parsed_ok')
    expect(parsed.coverage.status).toBe('parsed_ok')
    expect(parsed.decisions.status).toBe('parsed_ok')
    expect(parsed.lookup_tables.status).toBe('parsed_ok')
    expect(parsed.data_quality.status).toBe('parsed_ok')
    expect(parsed.inferred_targets.status).toBe('parsed_ok')
    expect(parsed.project_notes.status).toBe('parsed_ok')
  })

  it('mappings: 3 entries with correct shapes', () => {
    if (parsed.mappings.status !== 'parsed_ok') throw new Error('expected parsed_ok')
    expect(parsed.mappings.data).toHaveLength(3)
    expect(parsed.mappings.data[0].combination_type).toBe('single')
    expect(parsed.mappings.data[1].combination_type).toBe('concat_space')
    expect(parsed.mappings.data[1].source_field_ids).toHaveLength(2)
    expect(parsed.mappings.data[1].mapping_cardinality).toBe('many_to_one')
    expect(parsed.mappings.data[2].combination_type).toBe('custom_sql')
    expect(parsed.mappings.data[2].combination_sql).toBe("'ACTIVE'::text")
  })

  it('cross-references: data_quality_flag_indices preserved as INDICES (not UUIDs)', () => {
    if (parsed.mappings.status !== 'parsed_ok') throw new Error('expected parsed_ok')
    // Mapping #1 references DQ #0. Parser MUST preserve the integer index
    // verbatim — UUID resolution lives in the persistence layer.
    expect(parsed.mappings.data[1].data_quality_flag_indices).toEqual([0])
  })

  it('coverage: 3 entries including a gap', () => {
    if (parsed.coverage.status !== 'parsed_ok') throw new Error('expected parsed_ok')
    expect(parsed.coverage.data).toHaveLength(3)
    const gap = parsed.coverage.data.find((c) => c.coverage_status === 'gap')
    expect(gap).toBeDefined()
    expect(gap!.default_value_recommendation).toEqual({ strategy: 'static', value: 'UNKNOWN' })
  })

  it('decisions: applies_to.tfm_indices preserved as INDICES (not UUIDs)', () => {
    if (parsed.decisions.status !== 'parsed_ok') throw new Error('expected parsed_ok')
    expect(parsed.decisions.data).toHaveLength(1)
    expect(parsed.decisions.data[0].applies_to?.tfm_indices).toEqual([0])
  })

  it('project_notes: markdown body preserved verbatim', () => {
    if (parsed.project_notes.status !== 'parsed_ok') throw new Error('expected parsed_ok')
    expect(parsed.project_notes.data).toContain('Project-wide observations')
    expect(parsed.project_notes.data).toContain('inferred Contact entity')
  })
})

describe('parsePathDOutput — per-section recovery on truncated stream', () => {
  it('partial output (lookup_tables truncated) does NOT abort whole parse', () => {
    const parsed = parsePathDOutput(loadFixture('partial-output.xml'))

    // Sections that completed parse cleanly
    expect(parsed.mappings.status).toBe('parsed_ok')
    expect(parsed.coverage.status).toBe('parsed_ok')
    expect(parsed.decisions.status).toBe('parsed_ok')

    // lookup_tables onward: open tag exists but close tag missing → 'missing'
    expect(parsed.lookup_tables.status).toBe('missing')
    expect(parsed.data_quality.status).toBe('missing')
    expect(parsed.inferred_targets.status).toBe('missing')
    expect(parsed.project_notes.status).toBe('missing')
  })
})

describe('parsePathDOutput — per-section recovery on malformed JSON', () => {
  it('malformed JSON in lookup_tables does NOT abort whole parse', () => {
    const parsed = parsePathDOutput(loadFixture('malformed-json-in-lookup-tables.xml'))

    // Sections before lookup_tables: clean
    expect(parsed.mappings.status).toBe('parsed_ok')
    expect(parsed.coverage.status).toBe('parsed_ok')
    expect(parsed.decisions.status).toBe('parsed_ok')

    // lookup_tables: parse_error with descriptive message
    expect(parsed.lookup_tables.status).toBe('parse_error')
    if (parsed.lookup_tables.status === 'parse_error') {
      expect(parsed.lookup_tables.error).toContain('lookup_tables')
      expect(parsed.lookup_tables.error.toLowerCase()).toMatch(/json|parse/)
    }

    // Sections AFTER the malformed one: still parse cleanly (per-section recovery)
    expect(parsed.data_quality.status).toBe('parsed_ok')
    expect(parsed.inferred_targets.status).toBe('parsed_ok')
    expect(parsed.project_notes.status).toBe('parsed_ok')
  })
})

describe('parsePathDOutput — empty sections', () => {
  it('all sections present with empty arrays parse to empty arrays', () => {
    const parsed = parsePathDOutput(loadFixture('empty-sections.xml'))

    if (parsed.mappings.status !== 'parsed_ok') throw new Error('mappings should parse')
    expect(parsed.mappings.data).toEqual([])
    if (parsed.data_quality.status !== 'parsed_ok') throw new Error('data_quality should parse')
    expect(parsed.data_quality.data).toEqual([])
  })

  it('empty project_notes preserved as empty/whitespace string', () => {
    const parsed = parsePathDOutput(loadFixture('empty-sections.xml'))
    expect(parsed.project_notes.status).toBe('parsed_ok')
  })
})

describe('parsePathDOutput — cross-references preserved as indices', () => {
  it('mappings carry data_quality_flag_indices as integer arrays', () => {
    const parsed = parsePathDOutput(loadFixture('cross-references.xml'))
    if (parsed.mappings.status !== 'parsed_ok') throw new Error('mappings should parse')

    // Mapping #0 references DQ #[0, 1]; mapping #1 references DQ #[2]
    expect(parsed.mappings.data[0].data_quality_flag_indices).toEqual([0, 1])
    expect(parsed.mappings.data[1].data_quality_flag_indices).toEqual([2])

    // Verify indices are integers (NOT strings, NOT UUID-shaped)
    for (const idx of parsed.mappings.data[0].data_quality_flag_indices) {
      expect(typeof idx).toBe('number')
      expect(Number.isInteger(idx)).toBe(true)
    }
  })

  it('decisions carry applies_to.tfm_indices as integer arrays', () => {
    const parsed = parsePathDOutput(loadFixture('cross-references.xml'))
    if (parsed.decisions.status !== 'parsed_ok') throw new Error('decisions should parse')

    expect(parsed.decisions.data[0].applies_to?.tfm_indices).toEqual([0])
    expect(parsed.decisions.data[1].applies_to?.tfm_indices).toEqual([1])
  })
})

describe('createPathDStreamParser — streaming detection', () => {
  it('feed() detects close tags as they arrive, returns newly-completed sections', () => {
    const parser = createPathDStreamParser()
    const fixture = loadFixture('happy-path.xml')

    // Split fixture into 4 chunks at arbitrary points to simulate streaming
    const split1 = fixture.indexOf('</mappings>') + '</mappings>'.length
    const split2 = fixture.indexOf('</decisions>') + '</decisions>'.length
    const split3 = fixture.indexOf('</data_quality>') + '</data_quality>'.length

    const r1 = parser.feed(fixture.slice(0, split1))
    expect(r1.completedSections).toContain('mappings')

    const r2 = parser.feed(fixture.slice(split1, split2))
    expect(r2.completedSections).toContain('coverage')
    expect(r2.completedSections).toContain('decisions')

    const r3 = parser.feed(fixture.slice(split2, split3))
    expect(r3.completedSections).toContain('lookup_tables')
    expect(r3.completedSections).toContain('data_quality')

    const r4 = parser.feed(fixture.slice(split3))
    expect(r4.completedSections).toContain('inferred_targets')
    expect(r4.completedSections).toContain('project_notes')

    const final = parser.finish()
    expect(final.mappings.status).toBe('parsed_ok')
    expect(final.project_notes.status).toBe('parsed_ok')
  })

  it('completed sections are reported only once (not on subsequent feeds)', () => {
    const parser = createPathDStreamParser()
    const fixture = loadFixture('happy-path.xml')
    const split1 = fixture.indexOf('</mappings>') + '</mappings>'.length

    const r1 = parser.feed(fixture.slice(0, split1))
    expect(r1.completedSections).toContain('mappings')

    // Feed the same chunk-end again with no new content; mappings should NOT
    // re-fire (already-completed dedup).
    const r2 = parser.feed('')
    expect(r2.completedSections).not.toContain('mappings')
  })
})
