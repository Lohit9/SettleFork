// @vitest-environment node
//
// Path 2 PR 2 B-1 — synthetic-context-builder extension tests.
//
// Verifies the two new parameters added in B-1:
//   - withFieldProfiles?: boolean — inserts per-field hand-crafted profiles
//   - seedQualityIssue?: { fieldName, severity, title, description } — inserts
//     one quality_issues row, returns its id via BuiltMappingContext
//
// Mirrors the structural-test pattern of tests/actions/*-refinements.test.ts:
// pure source-text reads, no DB calls, fast + deterministic. Real-DB
// behavior is exercised via the eval runner's flag-OFF pre-flights and
// (in B-2) the flag-ON smoke tests.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import type {
  BuildMappingContextInput,
  BuiltMappingContext,
} from '@/lib/eval/synthetic-context-builder'

const SRC_PATH = resolve(__dirname, '../../lib/eval/synthetic-context-builder.ts')
const SRC = readFileSync(SRC_PATH, 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

// ─── Type-level checks ────────────────────────────────────────────────────────

describe('[synthetic-context-builder extension] types', () => {
  it('BuildMappingContextInput accepts optional withFieldProfiles', () => {
    // Type-level assertion: this expression compiles iff the type allows the
    // new field. If the field is missing, tsc fails at the test-file level.
    const input: BuildMappingContextInput = {
      projectId: 'p',
      schema: { source: { tables: [] }, target: { tables: [] } },
      sourceTableName: 's',
      targetTableName: 't',
      withFieldProfiles: true,
    }
    expect(input.withFieldProfiles).toBe(true)
  })

  it('BuildMappingContextInput accepts optional seedQualityIssue', () => {
    const input: BuildMappingContextInput = {
      projectId: 'p',
      schema: { source: { tables: [] }, target: { tables: [] } },
      sourceTableName: 's',
      targetTableName: 't',
      seedQualityIssue: {
        fieldName: 'name',
        severity: 'warning',
        title: 'Test',
        description: 'Test description',
      },
    }
    expect(input.seedQualityIssue?.fieldName).toBe('name')
  })

  it('BuiltMappingContext exposes optional qualityIssueId', () => {
    // Type-level: the field must be present (and optional) on the return
    // shape. Construct a minimal BuiltMappingContext to confirm the type.
    const ctx: BuiltMappingContext = {
      projectId: 'p',
      sourceDatasetId: 'sd',
      targetDatasetId: 'td',
      sourceTableId: 'st',
      targetTableId: 'tt',
      tableMappingId: 'tm',
      sourceFieldsByName: new Map(),
      targetFieldsByName: new Map(),
      qualityIssueId: 'qi',
    }
    expect(ctx.qualityIssueId).toBe('qi')
  })

  it('BuiltMappingContext.qualityIssueId is optional (omittable)', () => {
    const ctx: BuiltMappingContext = {
      projectId: 'p',
      sourceDatasetId: 'sd',
      targetDatasetId: 'td',
      sourceTableId: 'st',
      targetTableId: 'tt',
      tableMappingId: 'tm',
      sourceFieldsByName: new Map(),
      targetFieldsByName: new Map(),
    }
    expect(ctx.qualityIssueId).toBeUndefined()
  })
})

// ─── Structural source-code checks ────────────────────────────────────────────

describe('[synthetic-context-builder extension] withFieldProfiles branch', () => {
  const code = stripComments(SRC)

  it('gates the field_profiles INSERT on input.withFieldProfiles', () => {
    expect(code).toMatch(/if\s*\(\s*input\.withFieldProfiles\s*\)/)
  })

  it('inserts into field_profiles when the flag is set', () => {
    // Walk: inside the withFieldProfiles branch, INSERT into field_profiles
    expect(code).toMatch(/from\(\s*['"]field_profiles['"]\s*\)/)
    expect(code).toMatch(
      /from\(\s*['"]field_profiles['"]\s*\)[\s\S]{0,200}\.insert\(/,
    )
  })

  it('declares a fieldProfileRow helper that builds per-field stats', () => {
    expect(code).toMatch(/function\s+fieldProfileRow\s*\(/)
  })

  it('fieldProfileRow includes the field_profiles table columns', () => {
    // Per migration 002:58-71: total_rows, null_count, null_percentage,
    // cardinality, unique_percentage, sample_values, min_value, max_value.
    // Match either explicit `column: value` or shorthand-property
    // `column,` (when a same-named local variable is in scope).
    expect(code).toMatch(/\btotal_rows\b/)
    expect(code).toMatch(/\bnull_count\b/)
    expect(code).toMatch(/\bnull_percentage\b/)
    expect(code).toMatch(/\bcardinality\b/)
    expect(code).toMatch(/\bunique_percentage\b/)
    expect(code).toMatch(/\bsample_values\b/)
    expect(code).toMatch(/\bmin_value\b/)
    expect(code).toMatch(/\bmax_value\b/)
  })

  it('hand-crafted name-field profile carries plausible human-name samples', () => {
    // Per locked decision B1: hand-crafted stats per field-name dispatch.
    // The 'name' branch should produce realistic samples.
    expect(code).toMatch(/['"]Alice['"]/)
    expect(code).toMatch(/['"]Bob['"]/)
  })

  it('default profile path produces non-zero null_count (imperfections surface AI behavior)', () => {
    // Per R8 risk note: profiles must NOT show "perfect data" — otherwise
    // the AI sees nothing to flag. The default branch hand-codes a
    // non-zero null_count so SOME imperfection is always present.
    // The local variable holding the count uses camelCase (nullCount).
    expect(code).toMatch(/let\s+nullCount\s*=\s*[1-9]/)
  })
})

describe('[synthetic-context-builder extension] seedQualityIssue branch', () => {
  const code = stripComments(SRC)

  it('gates the quality_issues INSERT on input.seedQualityIssue', () => {
    expect(code).toMatch(/if\s*\(\s*input\.seedQualityIssue\s*\)/)
  })

  it('looks up the named source field via sourceFieldsByName', () => {
    // The fieldName param is a name; we resolve to a field UUID via the
    // existing name-keyed map.
    expect(code).toMatch(/sourceFieldsByName\.get\(\s*seed\.fieldName\s*\)/)
  })

  it('fails loudly when fieldName is unknown', () => {
    expect(code).toMatch(
      /seedQualityIssue references unknown source field/,
    )
  })

  it('inserts into quality_issues with the seed values', () => {
    expect(code).toMatch(/from\(\s*['"]quality_issues['"]\s*\)/)
    expect(code).toMatch(
      /from\(\s*['"]quality_issues['"]\s*\)[\s\S]{0,400}\.insert\(/,
    )
  })

  it('inserts the required quality_issues columns from the seed', () => {
    // Schema (migration 002:116-131): project_id, table_id, field_id,
    // stage, severity, title, description, status. The seed branch must
    // populate all of these.
    expect(code).toMatch(/project_id:\s*input\.projectId/)
    expect(code).toMatch(/table_id:\s*srcTbl\.id/)
    expect(code).toMatch(/field_id:\s*fieldId/)
    expect(code).toMatch(/stage:\s*['"]source['"]/)
    expect(code).toMatch(/severity:\s*seed\.severity/)
    expect(code).toMatch(/title:\s*seed\.title/)
    expect(code).toMatch(/description:\s*seed\.description/)
    expect(code).toMatch(/status:\s*['"]open['"]/)
  })

  it('returns the inserted row id via BuiltMappingContext.qualityIssueId', () => {
    // Path: read .id from .select('id').single() result, assign to a
    // local, spread into the return object via conditional spread.
    expect(code).toMatch(/qualityIssueId\s*=\s*qiRow\.id/)
    expect(code).toMatch(/qualityIssueId\s*!==\s*undefined/)
  })
})
