/**
 * Rootstock target-field description extractor (PR Ω.3.7.5 commit 1/3).
 *
 * Pure function — no DB, no fixtures. The loader's Phase 6.25 invokes
 * this once per (target_table, target_field) group and writes the
 * result to `fields.description` (gated on description IS NULL).
 *
 * Covers:
 *  - core extraction (single mapped, single VA, mapped + VA)
 *  - null on missing prefix → UI falls back to data_type tier
 *  - highest-confidence selection
 *  - deterministic tiebreaker (mapped > VA, then lexicographic source)
 *  - real-data shapes (commas inside type sig, trailing parentheticals,
 *    additional modifiers like "External ID")
 *  - idempotency: same input → same output across invocations
 */

import { describe, it, expect } from 'vitest'
import {
  extractTargetFieldDescription,
  type DescriptionEntry,
} from '@/scripts/rootstock-descriptions'

const mapped = (overrides: Partial<DescriptionEntry> = {}): DescriptionEntry => ({
  source_table: 'Engineering BOM Masters',
  source_field: 'Item Type',
  explanation: 'Field type: Text(50), Required.\n\nProduct SKU description.',
  confidence: 90,
  ...overrides,
})

const va = (overrides: Partial<DescriptionEntry> = {}): DescriptionEntry => ({
  source_table: 'Unmapped',
  source_field: 'Unmapped',
  explanation:
    'Field type: Lookup(Division Master), External ID, Required.\n\nAssigns the Engineering Item Master to a division.',
  confidence: 85,
  ...overrides,
})

describe('extractTargetFieldDescription', () => {
  it('returns null on empty input', () => {
    expect(extractTargetFieldDescription([])).toBeNull()
  })

  it('extracts the prefix + body from a single mapped entry', () => {
    expect(extractTargetFieldDescription([mapped()])).toBe(
      'Field type: Text(50), Required. Product SKU description.',
    )
  })

  it('mapped-only group includes the mapped body (Status field shape)', () => {
    // Mirrors the Rootstock `Status` field: a single mapped entry with
    // no VA sibling. Pin: the body paragraph IS included, even with no
    // VA in the group. Pre-Ω.3.7.6 this returned the prefix sentence
    // only, producing prefix-only descriptions on Status-like fields
    // while VA fields rendered prefix + body — visible inconsistency
    // on empty-slot rows.
    const status = mapped({
      source_table: 'Engineering BOM Masters',
      source_field: 'Item Status Code',
      explanation:
        'Field type: Picklist {Active, Inactive}, Required.\n\nDrives Active/Inactive lifecycle on the Engineering Item Master.',
      confidence: 93,
    })
    expect(extractTargetFieldDescription([status])).toBe(
      'Field type: Picklist {Active, Inactive}, Required. Drives Active/Inactive lifecycle on the Engineering Item Master.',
    )
  })

  it("uses the highest-confidence entry's body even when a lower-confidence VA exists", () => {
    // Cross-kind: mapped (conf 90) outranks VA (conf 85), so the
    // body tracks the mapped entry — not the VA. (Pre-Ω.3.7.6 the
    // body was VA-locked whenever a VA existed in the group.)
    expect(extractTargetFieldDescription([mapped(), va()])).toBe(
      'Field type: Text(50), Required. Product SKU description.',
    )
  })

  it('uses the VA entry alone when no mapped entry exists', () => {
    expect(extractTargetFieldDescription([va()])).toBe(
      'Field type: Lookup(Division Master), External ID, Required. Assigns the Engineering Item Master to a division.',
    )
  })

  it('returns null when no entry carries the Field type prefix', () => {
    const noPrefix = mapped({ explanation: 'No machine-readable prefix.' })
    expect(extractTargetFieldDescription([noPrefix])).toBeNull()
  })

  it('selects the highest-confidence entry for the prefix AND the body', () => {
    const low = mapped({
      source_field: 'A',
      explanation: 'Field type: Text(10), Required.\n\nold',
      confidence: 50,
    })
    const high = mapped({
      source_field: 'B',
      explanation: 'Field type: Text(80), Required.\n\nnew',
      confidence: 95,
    })
    expect(extractTargetFieldDescription([low, high])).toBe(
      'Field type: Text(80), Required. new',
    )
  })

  it('on equal confidence, prefers mapped over VA', () => {
    const m = mapped({
      confidence: 80,
      explanation: 'Field type: Text(50), Required.\n\nmapped-body',
    })
    const v = va({
      confidence: 80,
      explanation: 'Field type: Lookup(Y), Required.\n\nva-body',
    })
    // Input order intentionally puts VA first to prove sort wins, not order.
    expect(extractTargetFieldDescription([v, m])).toContain(
      'Field type: Text(50), Required.',
    )
  })

  it('on equal confidence (same kind), tiebreaks lexicographically by source', () => {
    const beta = mapped({
      source_table: 'Beta',
      source_field: 'B',
      explanation: 'Field type: Text(B), Required.',
      confidence: 80,
    })
    const alpha = mapped({
      source_table: 'Alpha',
      source_field: 'A',
      explanation: 'Field type: Text(A), Required.',
      confidence: 80,
    })
    expect(extractTargetFieldDescription([beta, alpha])).toBe(
      'Field type: Text(A), Required.',
    )
  })

  it('handles additional modifiers between type signature and indicator', () => {
    const entry = mapped({
      explanation:
        'Field type: Lookup(Inventory Commodity Code), External ID, Required.\n\nbody',
    })
    expect(extractTargetFieldDescription([entry])).toBe(
      'Field type: Lookup(Inventory Commodity Code), External ID, Required. body',
    )
  })

  it('handles commas inside type signatures and strips trailing parentheticals', () => {
    const picklist = mapped({
      explanation:
        'Field type: Picklist {Yes, No}, Optional (inherits from commodity code if blank).',
    })
    expect(extractTargetFieldDescription([picklist])).toBe(
      'Field type: Picklist {Yes, No}, Optional.',
    )
    const number = mapped({
      explanation:
        'Field type: Number(10,6), Conditionally Required (only when Item Type = Service).',
    })
    expect(extractTargetFieldDescription([number])).toBe(
      'Field type: Number(10,6), Conditionally Required.',
    )
  })

  it('omits the body when the explanation has no blank-line section', () => {
    expect(
      extractTargetFieldDescription([mapped({ explanation: 'Field type: Lookup(X), Required.' })]),
    ).toBe('Field type: Lookup(X), Required.')
  })

  it('is deterministic across repeated invocations (idempotency)', () => {
    const input = [mapped(), va()]
    expect(extractTargetFieldDescription(input)).toEqual(
      extractTargetFieldDescription(input),
    )
  })
})
