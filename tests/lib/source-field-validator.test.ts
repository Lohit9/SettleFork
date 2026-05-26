// @vitest-environment node
//
// Unit tests for lib/validation/source-field-validator.ts (S1 #16).
// All checks are pure functions over FieldContext — no DB, no network.

import { describe, it, expect } from 'vitest'
import {
  validateSourceField,
  validateSourceFields,
} from '@/lib/validation/source-field-validator'
import type { FieldContext } from '@/lib/ai/context-builder'

// ─── Fixture ─────────────────────────────────────────────────────────────────

function field(overrides: Partial<FieldContext> = {}): FieldContext {
  return {
    field_id: 'f-1',
    name: 'test_field',
    data_type: 'text',
    inferred_type: null,
    is_nullable: true,
    is_primary_key: false,
    is_foreign_key: false,
    fk_reference: null,
    check_constraint: null,
    schema_source: 'inferred',
    default_value: null,
    description: null,
    null_percentage: 0,
    cardinality: 100,
    unique_percentage: 50,
    format_issues_count: 0,
    min_value: null,
    max_value: null,
    value_distribution: [],
    sample_values: [],
    ...overrides,
  }
}

// ─── Clean field ──────────────────────────────────────────────────────────────

describe('validateSourceField — clean field', () => {
  it('returns empty issues for a healthy field', () => {
    expect(validateSourceField(field())).toEqual([])
  })

  it('returns empty issues when null_percentage is exactly at threshold (80)', () => {
    expect(validateSourceField(field({ null_percentage: 80 }))).toEqual([])
  })
})

// ─── high_null_rate ───────────────────────────────────────────────────────────

describe('validateSourceField — high_null_rate', () => {
  it('fires when null_percentage > 80', () => {
    const issues = validateSourceField(field({ null_percentage: 85.3 }))
    expect(issues).toHaveLength(1)
    expect(issues[0].check).toBe('high_null_rate')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].message).toContain('85.3%')
  })

  it('fires at 100% null', () => {
    const issues = validateSourceField(field({ null_percentage: 100 }))
    const checks = issues.map((i) => i.check)
    expect(checks).toContain('high_null_rate')
  })

  it('does not fire at 79.9%', () => {
    const issues = validateSourceField(field({ null_percentage: 79.9 }))
    expect(issues.every((i) => i.check !== 'high_null_rate')).toBe(true)
  })
})

// ─── type_mismatch ────────────────────────────────────────────────────────────

describe('validateSourceField — type_mismatch', () => {
  it('fires when inferred_type differs from data_type', () => {
    const issues = validateSourceField(
      field({ data_type: 'text', inferred_type: 'date' }),
    )
    const tm = issues.find((i) => i.check === 'type_mismatch')
    expect(tm).toBeDefined()
    expect(tm?.severity).toBe('warning')
    expect(tm?.message).toContain('date')
  })

  it('does not fire when inferred_type is null', () => {
    const issues = validateSourceField(field({ data_type: 'text', inferred_type: null }))
    expect(issues.every((i) => i.check !== 'type_mismatch')).toBe(true)
  })

  it('does not fire for text / character varying equivalence', () => {
    const issues = validateSourceField(
      field({ data_type: 'character varying', inferred_type: 'text' }),
    )
    expect(issues.every((i) => i.check !== 'type_mismatch')).toBe(true)
  })

  it('does not fire for varchar / text equivalence', () => {
    const issues = validateSourceField(
      field({ data_type: 'varchar', inferred_type: 'text' }),
    )
    expect(issues.every((i) => i.check !== 'type_mismatch')).toBe(true)
  })

  it('does not fire for integer / int equivalence', () => {
    const issues = validateSourceField(
      field({ data_type: 'integer', inferred_type: 'int' }),
    )
    expect(issues.every((i) => i.check !== 'type_mismatch')).toBe(true)
  })

  it('does not fire for numeric / decimal equivalence', () => {
    const issues = validateSourceField(
      field({ data_type: 'numeric', inferred_type: 'decimal' }),
    )
    expect(issues.every((i) => i.check !== 'type_mismatch')).toBe(true)
  })

  it('strips type precision before comparing — varchar(255) vs varchar', () => {
    const issues = validateSourceField(
      field({ data_type: 'character varying(255)', inferred_type: 'character varying' }),
    )
    expect(issues.every((i) => i.check !== 'type_mismatch')).toBe(true)
  })
})

// ─── format_issues_present ────────────────────────────────────────────────────

describe('validateSourceField — format_issues_present', () => {
  it('fires when format_issues_count > 0', () => {
    const issues = validateSourceField(field({ format_issues_count: 42 }))
    const fi = issues.find((i) => i.check === 'format_issues_present')
    expect(fi).toBeDefined()
    expect(fi?.severity).toBe('warning')
    expect(fi?.message).toContain('42')
  })

  it('does not fire when format_issues_count is 0', () => {
    const issues = validateSourceField(field({ format_issues_count: 0 }))
    expect(issues.every((i) => i.check !== 'format_issues_present')).toBe(true)
  })
})

// ─── low_cardinality_pk ───────────────────────────────────────────────────────

describe('validateSourceField — low_cardinality_pk', () => {
  it('fires when PK has fewer than 10 distinct values', () => {
    const issues = validateSourceField(
      field({ is_primary_key: true, cardinality: 5 }),
    )
    const lc = issues.find((i) => i.check === 'low_cardinality_pk')
    expect(lc).toBeDefined()
    expect(lc?.severity).toBe('warning')
    expect(lc?.message).toContain('5')
  })

  it('does not fire for non-PK fields with low cardinality', () => {
    const issues = validateSourceField(
      field({ is_primary_key: false, cardinality: 3 }),
    )
    expect(issues.every((i) => i.check !== 'low_cardinality_pk')).toBe(true)
  })

  it('does not fire when PK cardinality is exactly 10', () => {
    const issues = validateSourceField(
      field({ is_primary_key: true, cardinality: 10 }),
    )
    expect(issues.every((i) => i.check !== 'low_cardinality_pk')).toBe(true)
  })

  it('does not fire when cardinality is 0 (unprofiled)', () => {
    const issues = validateSourceField(
      field({ is_primary_key: true, cardinality: 0 }),
    )
    expect(issues.every((i) => i.check !== 'low_cardinality_pk')).toBe(true)
  })
})

// ─── constant_field ───────────────────────────────────────────────────────────

describe('validateSourceField — constant_field', () => {
  it('fires when cardinality=1 and null_percentage=0 on non-PK field', () => {
    const issues = validateSourceField(
      field({ cardinality: 1, null_percentage: 0, is_primary_key: false }),
    )
    const cf = issues.find((i) => i.check === 'constant_field')
    expect(cf).toBeDefined()
    expect(cf?.severity).toBe('info')
  })

  it('does not fire for PK with cardinality=1 (low_cardinality_pk takes over)', () => {
    const issues = validateSourceField(
      field({ cardinality: 1, null_percentage: 0, is_primary_key: true }),
    )
    expect(issues.every((i) => i.check !== 'constant_field')).toBe(true)
  })

  it('does not fire when null_percentage > 0', () => {
    const issues = validateSourceField(
      field({ cardinality: 1, null_percentage: 5 }),
    )
    expect(issues.every((i) => i.check !== 'constant_field')).toBe(true)
  })

  it('does not fire when cardinality > 1', () => {
    const issues = validateSourceField(
      field({ cardinality: 2, null_percentage: 0 }),
    )
    expect(issues.every((i) => i.check !== 'constant_field')).toBe(true)
  })
})

// ─── multiple issues ──────────────────────────────────────────────────────────

describe('validateSourceField — multiple issues can co-occur', () => {
  it('reports high_null_rate + format_issues_present together', () => {
    const issues = validateSourceField(
      field({ null_percentage: 90, format_issues_count: 10 }),
    )
    const checks = issues.map((i) => i.check)
    expect(checks).toContain('high_null_rate')
    expect(checks).toContain('format_issues_present')
  })
})

// ─── validateSourceFields (batch) ────────────────────────────────────────────

describe('validateSourceFields — batch', () => {
  it('returns empty map when all fields are clean', () => {
    const result = validateSourceFields([field({ field_id: 'f-1' }), field({ field_id: 'f-2' })])
    expect(result.size).toBe(0)
  })

  it('omits clean fields; includes only fields with issues', () => {
    const f1 = field({ field_id: 'f-1', null_percentage: 0 })
    const f2 = field({ field_id: 'f-2', null_percentage: 95 })
    const result = validateSourceFields([f1, f2])
    expect(result.has('f-1')).toBe(false)
    expect(result.has('f-2')).toBe(true)
    expect(result.get('f-2')?.some((i) => i.check === 'high_null_rate')).toBe(true)
  })

  it('keys by field_id', () => {
    const f = field({ field_id: 'specific-uuid', null_percentage: 99 })
    const result = validateSourceFields([f])
    expect(result.has('specific-uuid')).toBe(true)
  })

  it('handles empty input', () => {
    expect(validateSourceFields([])).toEqual(new Map())
  })
})
