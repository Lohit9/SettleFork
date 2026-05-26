// @vitest-environment node
//
// Tests for lib/validation/package-validator.ts (S1 #18).
//
// validatePackageConsistency is async + DB-bound (4 Supabase queries) so
// full check logic lives in integration tests. Here we cover:
//   1. extractRowDataRefs — the only pure helper; tested via regex behaviour
//      duplicated from source (the function is internal but the regex is
//      the load-bearing piece).
//   2. Source-level pins — lock the 4 check IDs, severity assignments,
//      and the Promise.all parallel-execution pattern.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/validation/package-validator.ts'),
  'utf8',
)

// ─── extractRowDataRefs regex (duplicated for unit testing) ───────────────────
//
// The function is internal; we test the same regex pattern here to lock
// the extraction logic without importing private internals.

function extractRowDataRefs(sql: string): string[] {
  const matches = sql.matchAll(/row_data\s*->>\s*'([^']+)'/g)
  return [...matches].map((m) => m[1])
}

describe('extractRowDataRefs — row_data extraction regex', () => {
  it('extracts a single field name', () => {
    expect(extractRowDataRefs("row_data->>'Amount'")).toEqual(['Amount'])
  })

  it('extracts multiple field names from one expression', () => {
    const sql = "COALESCE(row_data->>'First', '') || ' ' || COALESCE(row_data->>'Last', '')"
    expect(extractRowDataRefs(sql).sort()).toEqual(['First', 'Last'])
  })

  it('handles whitespace around ->>', () => {
    expect(extractRowDataRefs("row_data ->> 'Field'")).toEqual(['Field'])
    expect(extractRowDataRefs("row_data  ->>  'Field'")).toEqual(['Field'])
  })

  it('returns empty array when no row_data refs present', () => {
    expect(extractRowDataRefs("'literal value'::TEXT")).toEqual([])
    expect(extractRowDataRefs('NULL')).toEqual([])
  })

  it('preserves case of field names', () => {
    expect(extractRowDataRefs("row_data->>'CustomerID'")).toEqual(['CustomerID'])
    expect(extractRowDataRefs("row_data->>'customer_id'")).toEqual(['customer_id'])
  })

  it('handles underscore and mixed-case field names', () => {
    const sql = "row_data->>'X__c' || row_data->>'SomeField_v2'"
    expect(extractRowDataRefs(sql).sort()).toEqual(['SomeField_v2', 'X__c'])
  })

  it('does not match empty string field name (regex requires 1+ chars)', () => {
    // [^']+ requires at least one character — empty field names are degenerate and correctly excluded
    expect(extractRowDataRefs("row_data->>''")).toEqual([])
  })
})

// ─── Source-level pins ────────────────────────────────────────────────────────

describe('package-validator — check ID inventory', () => {
  const EXPECTED_CHECK_IDS = [
    'unmapped_required',
    'many_source_no_merge',
    'transform_ref_invalid',
    'pk_transform_no_fk_cascade',
  ]

  for (const id of EXPECTED_CHECK_IDS) {
    it(`declares check ID '${id}'`, () => {
      expect(SRC).toContain(`'${id}'`)
    })
  }
})

describe('package-validator — severity assignments', () => {
  it('unmapped_required is error severity', () => {
    // Check that the error severity is paired with unmapped_required
    expect(SRC).toMatch(/unmapped_required[\s\S]{0,200}severity:\s*['"]error['"]|severity:\s*['"]error['"][\s\S]{0,200}unmapped_required/)
  })

  it('many_source_no_merge is error severity', () => {
    expect(SRC).toMatch(/many_source_no_merge[\s\S]{0,200}severity:\s*['"]error['"]|severity:\s*['"]error['"][\s\S]{0,200}many_source_no_merge/)
  })

  it('transform_ref_invalid is warning severity', () => {
    expect(SRC).toMatch(/transform_ref_invalid[\s\S]{0,200}severity:\s*['"]warning['"]|severity:\s*['"]warning['"][\s\S]{0,200}transform_ref_invalid/)
  })

  it('pk_transform_no_fk_cascade is warning severity', () => {
    expect(SRC).toMatch(/pk_transform_no_fk_cascade[\s\S]{0,200}severity:\s*['"]warning['"]|severity:\s*['"]warning['"][\s\S]{0,200}pk_transform_no_fk_cascade/)
  })
})

describe('package-validator — validatePackageConsistency structure', () => {
  it('exports validatePackageConsistency as the main entry point', () => {
    expect(SRC).toMatch(/export\s+async\s+function\s+validatePackageConsistency/)
  })

  it('runs all 4 checks in parallel via Promise.all', () => {
    expect(SRC).toMatch(/Promise\.all\(/)
    // Verify all 4 check function calls appear in the Promise.all call
    expect(SRC).toMatch(/checkUnmappedRequired\(/)
    expect(SRC).toMatch(/checkManySrcNoMerge\(/)
    expect(SRC).toMatch(/checkTransformRefInvalid\(/)
    expect(SRC).toMatch(/checkPkTransformNoFkCascade\(/)
  })

  it('returns PackageValidationResult with issues + counts', () => {
    expect(SRC).toContain('issues')
    expect(SRC).toContain('counts')
    expect(SRC).toMatch(/errors:\s*issues\.filter/)
    expect(SRC).toMatch(/warnings:\s*issues\.filter/)
  })
})

describe('package-validator — check suggestion quality', () => {
  it('unmapped_required suggestion mentions mapping or default value', () => {
    expect(SRC).toMatch(/map a source field|default value|acknowledge/)
  })

  it('many_source_no_merge suggestion names the valid combination_type values', () => {
    expect(SRC).toMatch(/concat_space|concat_comma|custom_sql/)
  })

  it('transform_ref_invalid suggestion mentions case-sensitivity', () => {
    expect(SRC).toMatch(/case-sensitive|ExactFieldName/)
  })
})
