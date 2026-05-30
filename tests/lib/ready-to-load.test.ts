// @vitest-environment node
//
// Unit tests for the Ready-to-Load header assembly (stage ⑤).
// Pure — exercises buildHeaderRows; the data fetch is I/O and untested here.

import { describe, it, expect } from 'vitest'
import { buildHeaderRows } from '@/lib/actions/ready-to-load'
import type { MapTransformSpecRow } from '@/lib/actions/map-transform-spec'

function row(over: Partial<MapTransformSpecRow> & { targetField: string }): MapTransformSpecRow {
  return {
    sourceTable: null, sourceField: null, targetTable: 'T', transformation: 'Direct copy',
    explanation: '', confidence: null, band: null, kind: 'mapped', transformSql: null, ...over,
  }
}

describe('Ready-to-Load — buildHeaderRows', () => {
  it('row 1 = target fields, in order', () => {
    const { targetFields } = buildHeaderRows([
      row({ targetField: 'Item Number' }),
      row({ targetField: 'Item Description' }),
    ])
    expect(targetFields).toEqual(['Item Number', 'Item Description'])
  })

  it('row 2 = source mapping per kind (mapped shows source, others show labels)', () => {
    const { sourceMapping } = buildHeaderRows([
      row({ targetField: 'a', kind: 'mapped', sourceField: 'Products.ProductSKU | BOM.Assy Item' }),
      row({ targetField: 'b', kind: 'acknowledged' }),
      row({ targetField: 'c', kind: 'value_assignment' }),
      row({ targetField: 'd', kind: 'unmapped' }),
    ])
    expect(sourceMapping).toEqual([
      'Products.ProductSKU | BOM.Assy Item',
      '(constant)',
      '(value assignment)',
      '(unmapped)',
    ])
  })
})
