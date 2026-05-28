/**
 * Empty-slot rationale fallback (PR Ω.3.7.5 commit 3/3).
 *
 * Pure function; no DOM, no React. Locks down the 2-tier fallback
 * rendered on `unmapped-target` flat rows when the live `aiReasoning`
 * is null — i.e. the actual empty-slot case the loader's Phase 6.25
 * was built to address.
 *
 * Covers:
 *  - Tier 1 (description present): both partitioned and heritage suffixes
 *  - Tier 2 (description null/empty/whitespace): Required + Optional flavors
 *  - Suffix normalization across null / undefined partition labels
 *  - Description is rendered verbatim — the "Field type:" lead is NOT
 *    stripped here (unlike `summarizeRationale`), since the lead is the
 *    intended schema signal on empty slots
 */

import { describe, it, expect } from 'vitest'
import { formatEmptySlotRationale } from '@/lib/utils/empty-slot-rationale'

describe('formatEmptySlotRationale', () => {
  it('tier 1 — uses fields.description verbatim with the partition suffix', () => {
    const out = formatEmptySlotRationale({
      description:
        'Field type: Text(50), Required. Product SKU description.',
      dataType: 'Text(50)',
      isNullable: false,
      partitionLabel: 'Engineering Components',
    })
    expect(out).toBe(
      'Field type: Text(50), Required. Product SKU description. · Not mapped in Engineering Components',
    )
  })

  it('tier 1 — preserves the "Field type:" lead (distinct from summarizeRationale)', () => {
    const out = formatEmptySlotRationale({
      description: 'Field type: Lookup(Division Master), Required. Engineering division FK.',
      dataType: 'Lookup',
      isNullable: false,
      partitionLabel: null,
    })
    expect(out.startsWith('Field type:')).toBe(true)
  })

  it('tier 1 — falls through to tier 2 when description is whitespace-only', () => {
    const out = formatEmptySlotRationale({
      description: '   \n  ',
      dataType: 'Number(10,2)',
      isNullable: true,
      partitionLabel: 'Engineering Parents',
    })
    expect(out).toBe('Number(10,2), Optional · Not mapped in Engineering Parents')
  })

  it('tier 2 — synthesizes from dataType + isNullable (Required)', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Text(50)',
      isNullable: false,
      partitionLabel: 'Engineering Components',
    })
    expect(out).toBe('Text(50), Required · Not mapped in Engineering Components')
  })

  it('tier 2 — synthesizes from dataType + isNullable (Optional)', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Checkbox',
      isNullable: true,
      partitionLabel: 'Engineering Parents',
    })
    expect(out).toBe('Checkbox, Optional · Not mapped in Engineering Parents')
  })

  it('suffix — heritage projects (partitionLabel null) emit "· Not mapped" without partition name', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Text(50)',
      isNullable: false,
      partitionLabel: null,
    })
    expect(out).toBe('Text(50), Required · Not mapped')
  })

  it('suffix — undefined partitionLabel behaves like null (heritage suffix)', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Text(50)',
      isNullable: false,
      partitionLabel: undefined,
    })
    expect(out).toBe('Text(50), Required · Not mapped')
  })

  it('suffix — empty-string partitionLabel falls back to heritage suffix (no "in " name)', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Text(50)',
      isNullable: false,
      partitionLabel: '',
    })
    expect(out).toBe('Text(50), Required · Not mapped')
  })
})
