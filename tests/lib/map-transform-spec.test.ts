// @vitest-environment node
//
// Unit tests for the Map & Transform spec shaping core (stage ③ output).
// Pure — exercises buildSpecRows directly with in-memory inputs, no DB.

import { describe, it, expect } from 'vitest'
import { buildSpecRows, confidenceBand, type SpecTfm, type SpecSource } from '@/lib/actions/map-transform-spec'

describe('confidenceBand — Kaan thresholds (≥90 green / 40–89 amber / <40 red)', () => {
  it('classifies by threshold; null confidence → null band', () => {
    expect(confidenceBand(100)).toBe('green')
    expect(confidenceBand(90)).toBe('green')
    expect(confidenceBand(89)).toBe('amber')
    expect(confidenceBand(40)).toBe('amber')
    expect(confidenceBand(39)).toBe('red')
    expect(confidenceBand(null)).toBeNull()
  })
})

const tableNameById = new Map<string, string>([
  ['tt', 'Engineering Item Master'],
  ['st1', 'Products'],
  ['st2', 'BOM Masters'],
])
const fieldNameById = new Map<string, string>([
  ['tf1', 'Item Number'], ['tf2', 'Item Description'], ['tf3', 'Unmapped FK'],
  ['sf1', 'ProductSKU'], ['sf2', 'Assy Item'], ['sf3', 'ProductName'],
])

const targetFields = [
  { id: 'tf1', table_id: 'tt', name: 'Item Number', ordinal_position: 1 },
  { id: 'tf2', table_id: 'tt', name: 'Item Description', ordinal_position: 2 },
  { id: 'tf3', table_id: 'tt', name: 'Unmapped FK', ordinal_position: 3 },
]

function tfm(over: Partial<SpecTfm> & { id: string; target_field_id: string }): SpecTfm {
  return {
    confidence: null, ai_reasoning: null, is_acknowledged: false, acknowledgment_reason: null,
    combination_type: 'single', combination_sql: null, needs_transformation: false, ...over,
  }
}
function src(o: Partial<SpecSource> & { target_field_mapping_id: string; source_field_id: string; source_table_id: string }): SpecSource {
  return { ordinal: 0, ...o }
}

function run(tfms: SpecTfm[], sources: SpecSource[]) {
  return buildSpecRows({
    targetTables: [{ id: 'tt', name: 'Engineering Item Master' }],
    targetFields, tfms, sources, tableNameById, fieldNameById,
  })
}

describe('Map & Transform spec — buildSpecRows', () => {
  it('emits one row per target field, ordered by ordinal_position', () => {
    const rows = run([], [])
    expect(rows.map((r) => r.targetField)).toEqual(['Item Number', 'Item Description', 'Unmapped FK'])
    expect(rows.every((r) => r.targetTable === 'Engineering Item Master')).toBe(true)
  })

  it('coalesce (custom_sql, multi-source) → one row, combined source, Coalesce transformation', () => {
    const t = tfm({ id: 'm1', target_field_id: 'tf1', combination_type: 'custom_sql',
      combination_sql: 'COALESCE(a,b)', needs_transformation: true, confidence: 88, ai_reasoning: 'SKU is primary id' })
    const rows = run([t], [
      src({ target_field_mapping_id: 'm1', source_field_id: 'sf1', source_table_id: 'st1', ordinal: 0 }),
      src({ target_field_mapping_id: 'm1', source_field_id: 'sf2', source_table_id: 'st2', ordinal: 1 }),
    ])
    const r = rows.find((x) => x.targetField === 'Item Number')!
    expect(r.kind).toBe('mapped')
    expect(r.sourceField).toBe('Products.ProductSKU | BOM Masters.Assy Item')
    expect(r.sourceTable).toBe('Products')
    expect(r.transformation).toMatch(/Coalesce/)
    expect(r.confidence).toBe(88)
    expect(r.explanation).toMatch(/SKU is primary id/)
    expect(r.transformSql).toBe('COALESCE(a,b)')
  })

  it('single source, no transform → Direct copy', () => {
    const t = tfm({ id: 'm2', target_field_id: 'tf2', confidence: 93, ai_reasoning: 'name match' })
    const rows = run([t], [src({ target_field_mapping_id: 'm2', source_field_id: 'sf3', source_table_id: 'st1' })])
    const r = rows.find((x) => x.targetField === 'Item Description')!
    expect(r.transformation).toBe('Direct copy')
    expect(r.sourceField).toBe('Products.ProductName')
    expect(r.kind).toBe('mapped')
  })

  it('target with no mapping → unmapped row', () => {
    const rows = run([], [])
    const r = rows.find((x) => x.targetField === 'Unmapped FK')!
    expect(r.kind).toBe('unmapped')
    expect(r.sourceField).toBeNull()
    expect(r.transformation).toBe('—')
    expect(r.confidence).toBeNull()
  })

  it('acknowledged (no source) → acknowledged kind + constant transformation', () => {
    const t = tfm({ id: 'm3', target_field_id: 'tf3', is_acknowledged: true, acknowledgment_reason: 'constant 2' })
    const rows = run([t], [])
    const r = rows.find((x) => x.targetField === 'Unmapped FK')!
    expect(r.kind).toBe('acknowledged')
    expect(r.transformation).toMatch(/Acknowledged/)
  })

  it('concat_space → human-readable concat with both sources', () => {
    const t = tfm({ id: 'm4', target_field_id: 'tf1', combination_type: 'concat_space', needs_transformation: true })
    const rows = run([t], [
      src({ target_field_mapping_id: 'm4', source_field_id: 'sf1', source_table_id: 'st1', ordinal: 0 }),
      src({ target_field_mapping_id: 'm4', source_field_id: 'sf2', source_table_id: 'st2', ordinal: 1 }),
    ])
    const r = rows.find((x) => x.targetField === 'Item Number')!
    expect(r.transformation).toMatch(/Concatenate \(space\)/)
    expect(r.transformation).toContain('Products.ProductSKU')
    expect(r.transformation).toContain('BOM Masters.Assy Item')
  })
})
