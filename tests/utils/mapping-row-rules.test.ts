import { describe, it, expect } from 'vitest'
import {
  classifyMappedRow,
  countDistinctSourceTables,
  RULE_4_SOURCE_COUNT_THRESHOLD,
  RULE_4_TABLE_COUNT_THRESHOLD,
} from '@/lib/utils/mapping-row-rules'
import type { MappingSourceRef } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 5b — classifier unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers every cell of the decision matrix locked by founder 2026-04-24
// (§Scope item 4). Thresholds are exported as constants for defense-in-
// depth: if a future prompt raises/lowers the Rule 4 threshold, a single
// test asserts the constant matches, then every case is re-derivable from
// the constant.

function source(
  overrides: Partial<MappingSourceRef> & {
    tableId?: string
    fieldName?: string
  } = {},
): MappingSourceRef {
  const { tableId = 'st-1', fieldName = 'FIELD', ...rest } = overrides
  return {
    id: `ms-${Math.random()}`,
    ordinal: 0,
    confidence: 90,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: { id: `sf-${fieldName}`, name: fieldName, dataType: 'VARCHAR', isNullable: false },
    sourceTable: { id: tableId, name: tableId.toUpperCase() },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
    ...rest,
  }
}

describe('classifyMappedRow', () => {
  describe('Rule 1 — single source', () => {
    it('1 source → rule_1', () => {
      expect(classifyMappedRow([source()])).toBe('rule_1')
    })
  })

  describe('Rule 2 — multi-source, same table', () => {
    it('2 sources, same table → rule_2', () => {
      const sources = [
        source({ tableId: 'st-1', fieldName: 'A' }),
        source({ tableId: 'st-1', fieldName: 'B' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_2')
    })

    it('3 sources, same table → rule_2', () => {
      const sources = [
        source({ tableId: 'st-1', fieldName: 'A' }),
        source({ tableId: 'st-1', fieldName: 'B' }),
        source({ tableId: 'st-1', fieldName: 'C' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_2')
    })

    it('4 sources, same table → rule_2 (just below Rule 4 field threshold)', () => {
      const sources = [
        source({ tableId: 'st-1', fieldName: 'A' }),
        source({ tableId: 'st-1', fieldName: 'B' }),
        source({ tableId: 'st-1', fieldName: 'C' }),
        source({ tableId: 'st-1', fieldName: 'D' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_2')
    })
  })

  describe('Rule 3 — cross-table, two tables', () => {
    it('2 sources from 2 different tables → rule_3', () => {
      const sources = [
        source({ tableId: 'st-A', fieldName: 'FNAME' }),
        source({ tableId: 'st-B', fieldName: 'CONTACT' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_3')
    })

    it('3 sources from 2 tables → rule_3', () => {
      const sources = [
        source({ tableId: 'st-A', fieldName: 'FNAME' }),
        source({ tableId: 'st-A', fieldName: 'LNAME' }),
        source({ tableId: 'st-B', fieldName: 'CONTACT' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_3')
    })

    it('4 sources from 2 tables → rule_3 (just below Rule 4 field threshold)', () => {
      const sources = [
        source({ tableId: 'st-A', fieldName: 'A1' }),
        source({ tableId: 'st-A', fieldName: 'A2' }),
        source({ tableId: 'st-B', fieldName: 'B1' }),
        source({ tableId: 'st-B', fieldName: 'B2' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_3')
    })
  })

  describe('Rule 4 — multi-table complex (table-count threshold)', () => {
    it('3 sources from 3 tables → rule_4', () => {
      const sources = [
        source({ tableId: 'st-A', fieldName: 'A' }),
        source({ tableId: 'st-B', fieldName: 'B' }),
        source({ tableId: 'st-C', fieldName: 'C' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })

    it('4 sources from 4 tables → rule_4', () => {
      const sources = [
        source({ tableId: 'st-A' }),
        source({ tableId: 'st-B' }),
        source({ tableId: 'st-C' }),
        source({ tableId: 'st-D' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })
  })

  describe('Rule 4 — multi-table complex (field-count threshold)', () => {
    it('5 sources from 1 table → rule_4 (field-count wins over 1 table)', () => {
      const sources = Array.from({ length: 5 }, (_, i) =>
        source({ tableId: 'st-1', fieldName: `F${i}` }),
      )
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })

    it('5 sources from 2 tables → rule_4', () => {
      const sources = [
        source({ tableId: 'st-A', fieldName: 'A1' }),
        source({ tableId: 'st-A', fieldName: 'A2' }),
        source({ tableId: 'st-A', fieldName: 'A3' }),
        source({ tableId: 'st-B', fieldName: 'B1' }),
        source({ tableId: 'st-B', fieldName: 'B2' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })

    it('5 sources from 5 tables → rule_4 (both thresholds met)', () => {
      const sources = Array.from({ length: 5 }, (_, i) =>
        source({ tableId: `st-${i}`, fieldName: `F${i}` }),
      )
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })

    it('6 sources from 2 tables → rule_4', () => {
      const sources = [
        source({ tableId: 'st-A', fieldName: 'A1' }),
        source({ tableId: 'st-A', fieldName: 'A2' }),
        source({ tableId: 'st-A', fieldName: 'A3' }),
        source({ tableId: 'st-B', fieldName: 'B1' }),
        source({ tableId: 'st-B', fieldName: 'B2' }),
        source({ tableId: 'st-B', fieldName: 'B3' }),
      ]
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })
  })

  describe('Threshold boundary — exact match is Rule 4, one below is not', () => {
    it('RULE_4_SOURCE_COUNT_THRESHOLD is 5 (regression guard)', () => {
      expect(RULE_4_SOURCE_COUNT_THRESHOLD).toBe(5)
    })

    it('RULE_4_TABLE_COUNT_THRESHOLD is 3 (regression guard)', () => {
      expect(RULE_4_TABLE_COUNT_THRESHOLD).toBe(3)
    })

    it('exactly at the field-count threshold → rule_4', () => {
      const sources = Array.from(
        { length: RULE_4_SOURCE_COUNT_THRESHOLD },
        (_, i) => source({ tableId: 'st-1', fieldName: `F${i}` }),
      )
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })

    it('one below the field-count threshold (same table) → rule_2', () => {
      const sources = Array.from(
        { length: RULE_4_SOURCE_COUNT_THRESHOLD - 1 },
        (_, i) => source({ tableId: 'st-1', fieldName: `F${i}` }),
      )
      expect(classifyMappedRow(sources)).toBe('rule_2')
    })

    it('exactly at the table-count threshold → rule_4', () => {
      const sources = Array.from(
        { length: RULE_4_TABLE_COUNT_THRESHOLD },
        (_, i) => source({ tableId: `st-${i}`, fieldName: `F${i}` }),
      )
      expect(classifyMappedRow(sources)).toBe('rule_4')
    })
  })

  describe('Defense-in-depth — empty array precondition', () => {
    it('0 sources → rule_1 fallback (should be intercepted by caller; guard against silent misclassification)', () => {
      expect(classifyMappedRow([])).toBe('rule_1')
    })
  })
})

describe('countDistinctSourceTables', () => {
  it('returns 1 for sources all in the same table', () => {
    const sources = [
      source({ tableId: 'st-1' }),
      source({ tableId: 'st-1' }),
      source({ tableId: 'st-1' }),
    ]
    expect(countDistinctSourceTables(sources)).toBe(1)
  })

  it('returns N for sources across N distinct tables', () => {
    const sources = [
      source({ tableId: 'st-A' }),
      source({ tableId: 'st-B' }),
      source({ tableId: 'st-C' }),
      source({ tableId: 'st-A' }), // duplicate — does not inflate count
    ]
    expect(countDistinctSourceTables(sources)).toBe(3)
  })

  it('returns 0 for an empty array', () => {
    expect(countDistinctSourceTables([])).toBe(0)
  })
})
