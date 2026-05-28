/**
 * Empty-slot rationale fallback (PR Ω.3.7.5 commit 3/3, updated by Ω.3.8).
 *
 * Pure function; no DOM, no React. Locks down the 2-tier fallback rendered
 * on `unmapped-target` flat rows when the live `aiReasoning` is null —
 * i.e. the actual empty-slot case the loader's Phase 6.25 was built to
 * address.
 *
 * PR Ω.3.8 — collapsed empty-slot rows now span N partitions, so the
 * `partitionLabel` parameter and the `in <partition>` suffix variation
 * were dropped. The suffix is always `· Not mapped`. Tests that
 * previously asserted partition-specific suffixes consolidated here.
 *
 * Covers:
 *  - Tier 1 (description present): uses description verbatim
 *  - Tier 2 (description null/empty/whitespace): Required + Optional flavors
 *  - Description is rendered verbatim — the "Field type:" lead is NOT
 *    stripped here (unlike `summarizeRationale`), since the lead is the
 *    intended schema signal on empty slots
 */

import { describe, it, expect } from 'vitest'
import { formatEmptySlotRationale } from '@/lib/utils/empty-slot-rationale'

describe('formatEmptySlotRationale', () => {
  it('tier 1 — uses fields.description verbatim with the "· Not mapped" suffix', () => {
    const out = formatEmptySlotRationale({
      description:
        'Field type: Text(50), Required. Product SKU description.',
      dataType: 'Text(50)',
      isNullable: false,
    })
    expect(out).toBe(
      'Field type: Text(50), Required. Product SKU description. · Not mapped',
    )
  })

  it('tier 1 — preserves the "Field type:" lead (distinct from summarizeRationale)', () => {
    const out = formatEmptySlotRationale({
      description: 'Field type: Lookup(Division Master), Required. Engineering division FK.',
      dataType: 'Lookup',
      isNullable: false,
    })
    expect(out.startsWith('Field type:')).toBe(true)
  })

  it('tier 1 — falls through to tier 2 when description is whitespace-only', () => {
    const out = formatEmptySlotRationale({
      description: '   \n  ',
      dataType: 'Number(10,2)',
      isNullable: true,
    })
    expect(out).toBe('Number(10,2), Optional · Not mapped')
  })

  it('tier 2 — synthesizes from dataType + isNullable (Required)', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Text(50)',
      isNullable: false,
    })
    expect(out).toBe('Text(50), Required · Not mapped')
  })

  it('tier 2 — synthesizes from dataType + isNullable (Optional)', () => {
    const out = formatEmptySlotRationale({
      description: null,
      dataType: 'Checkbox',
      isNullable: true,
    })
    expect(out).toBe('Checkbox, Optional · Not mapped')
  })
})
