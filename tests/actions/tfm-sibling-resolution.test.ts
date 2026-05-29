// @vitest-environment node
//
// PR Ω.3.8.1 — Unit tests for the TFM sibling resolver
// (`lib/actions/tfm-sibling-resolution.ts`). Covers the collapse-key
// semantics that drive status-mutation fan-out across partition siblings.
//
// The user-spec'd cases:
//   1. Approve fan-out — collapsed VA / mapped rows return their full
//      sibling set (resolver foundation for the bulk `.in()` update).
//   2. Reject fan-out — symmetric; resolver behavior is status-blind.
//   3. Heritage byte-identity — single-TFM target field returns a
//      length-1 set containing only the canonical → `.in('id', [tfm.id])`
//      is semantically identical to the pre-Ω.3.8.1 `.eq('id', tfm.id)`.
//   6. Concat_* edge case — sources=[A,B] and sources=[A,C] share their
//      dominant (ordinal-0) source but the FULL signature differs, so
//      they must NOT be siblings. Pure SQL would have grouped them
//      incorrectly under dominant-only matching.
//
// Cases 4 (audit row counts) and 5 (counter reconciliation) are locked
// by the mutation-handler source-shape tests in
// `pr-omega-3-8-1-status-fanout.test.ts` — the resolver itself doesn't
// touch audit rows or counters.

import { describe, it, expect, vi } from 'vitest'

import { resolveSiblingTfms } from '@/lib/actions/tfm-sibling-resolution'

// ─── Mock helper ────────────────────────────────────────────────────────
//
// Supabase JS client surface used by the resolver:
//   client.from('target_field_mappings').select(...).eq(...).eq(...)
//   → resolves to { data, error }
//
// We model the chain returning a final `.eq` call whose value is a
// promise. The shape mirrors the actual PostgREST builder.

interface MockTfmCandidate {
  id: string
  status: string
  mapping_sources: Array<{ source_field_id: string | null; ordinal: number }>
}

function makeClient(candidates: MockTfmCandidate[], error: { message: string } | null = null) {
  const eqProjectId = vi.fn().mockImplementation((_col: string, _val: string) => {
    // Second .eq is the terminal — returns the promise-resolved result.
    const eqTargetFieldId = vi
      .fn()
      .mockResolvedValue({ data: candidates, error })
    return { eq: eqTargetFieldId }
  })
  const select = vi.fn().mockReturnValue({ eq: eqProjectId })
  const from = vi.fn().mockReturnValue({ select })
  return { from } as never
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('resolveSiblingTfms — collapse-key semantics', () => {
  it('VA collapse — multiple TFMs with empty source signatures all match', async () => {
    // Three partition TFMs for the same target field; none have
    // mapping_sources rows (the loader writes VAs as combination_type=
    // 'custom_sql' with zero sources). All three share the empty source
    // signature → all three are siblings of any canonical among them.
    const client = makeClient([
      { id: 'tfm-va-a', status: 'needs_review', mapping_sources: [] },
      { id: 'tfm-va-b', status: 'needs_review', mapping_sources: [] },
      { id: 'tfm-va-c', status: 'needs_review', mapping_sources: [] },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-va-a',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    expect(result.map((r) => r.id).sort()).toEqual([
      'tfm-va-a',
      'tfm-va-b',
      'tfm-va-c',
    ])
  })

  it('mapped single-source — siblings sharing the same single source_field_id collapse', async () => {
    const client = makeClient([
      {
        id: 'tfm-mapped-x',
        status: 'needs_review',
        mapping_sources: [{ source_field_id: 'sf-A', ordinal: 0 }],
      },
      {
        id: 'tfm-mapped-y',
        status: 'approved',
        mapping_sources: [{ source_field_id: 'sf-A', ordinal: 0 }],
      },
      // Different source — not a sibling.
      {
        id: 'tfm-other',
        status: 'needs_review',
        mapping_sources: [{ source_field_id: 'sf-Z', ordinal: 0 }],
      },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-mapped-x',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    expect(result.map((r) => r.id).sort()).toEqual(['tfm-mapped-x', 'tfm-mapped-y'])
  })

  it('mapped multi-source — full signature [A,B] matches [A,B]; sources returned out-of-order get sorted by ordinal first', async () => {
    const client = makeClient([
      {
        id: 'tfm-concat-1',
        status: 'needs_review',
        mapping_sources: [
          { source_field_id: 'sf-A', ordinal: 0 },
          { source_field_id: 'sf-B', ordinal: 1 },
        ],
      },
      {
        id: 'tfm-concat-2',
        status: 'needs_review',
        // Intentionally returned out-of-order by the mock to confirm
        // the resolver sorts by ordinal before comparing.
        mapping_sources: [
          { source_field_id: 'sf-B', ordinal: 1 },
          { source_field_id: 'sf-A', ordinal: 0 },
        ],
      },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-concat-1',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    expect(result.map((r) => r.id).sort()).toEqual(['tfm-concat-1', 'tfm-concat-2'])
  })

  it('concat_* edge case — [A,B] and [A,C] share the dominant source but the FULL signature differs → NOT siblings', async () => {
    // Direct user-spec'd test (investigation §7, test 6).
    // Two mapped TFMs with the same target field, both have source A at
    // ordinal 0, but differ at ordinal 1 (B vs C). They are NOT siblings
    // — Ω.3.8 collapses by the full ordered source signature, not
    // dominant-only. Dominant-only matching would group them
    // incorrectly and silently flip C's status when the user approves B.
    const client = makeClient([
      {
        id: 'tfm-AB',
        status: 'needs_review',
        mapping_sources: [
          { source_field_id: 'sf-A', ordinal: 0 },
          { source_field_id: 'sf-B', ordinal: 1 },
        ],
      },
      {
        id: 'tfm-AC',
        status: 'needs_review',
        mapping_sources: [
          { source_field_id: 'sf-A', ordinal: 0 },
          { source_field_id: 'sf-C', ordinal: 1 },
        ],
      },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-AB',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    // Only the canonical itself comes back.
    expect(result.map((r) => r.id)).toEqual(['tfm-AB'])
  })

  it('order matters — [A,B] is NOT a sibling of [B,A] (ordinal-positioned comparison)', async () => {
    const client = makeClient([
      {
        id: 'tfm-AB',
        status: 'needs_review',
        mapping_sources: [
          { source_field_id: 'sf-A', ordinal: 0 },
          { source_field_id: 'sf-B', ordinal: 1 },
        ],
      },
      {
        id: 'tfm-BA',
        status: 'needs_review',
        mapping_sources: [
          // Same source set, different ordinals. Combination_type=concat
          // produces "A_val B_val" vs "B_val A_val" — semantically
          // distinct mappings.
          { source_field_id: 'sf-B', ordinal: 0 },
          { source_field_id: 'sf-A', ordinal: 1 },
        ],
      },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-AB',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    expect(result.map((r) => r.id)).toEqual(['tfm-AB'])
  })

  it('heritage byte-identity — single-TFM target field returns a length-1 sibling set', async () => {
    // The whole point of the additive contract: heritage (no partitions)
    // rows return only the canonical, so `.in('id', [canonical])`
    // collapses to a single-row UPDATE byte-identical to the
    // pre-Ω.3.8.1 `.eq('id', canonical)` semantics.
    const client = makeClient([
      {
        id: 'tfm-only',
        status: 'approved',
        mapping_sources: [{ source_field_id: 'sf-A', ordinal: 0 }],
      },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-only',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('tfm-only')
    expect(result[0]!.status).toBe('approved')
  })

  it('status-blind — siblings flow with their own pre-mutation status for per-TFM audit', async () => {
    // The resolver returns each sibling's CURRENT status so the audit
    // fan-out (`logAIEdit`) can record each row's accurate
    // `oldValue` field. This is the data shape that makes per-TFM
    // ai_edit_history accurate after the bulk update.
    const client = makeClient([
      { id: 'tfm-1', status: 'needs_review', mapping_sources: [] },
      { id: 'tfm-2', status: 'rejected', mapping_sources: [] },
      { id: 'tfm-3', status: 'needs_review', mapping_sources: [] },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-1',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    const byId = new Map(result.map((r) => [r.id, r.status]))
    expect(byId.get('tfm-1')).toBe('needs_review')
    expect(byId.get('tfm-2')).toBe('rejected')
    expect(byId.get('tfm-3')).toBe('needs_review')
  })

  it('race — canonical disappears between caller read and resolver fetch → returns empty', async () => {
    // The caller's earlier `.single()` on the canonical succeeded but
    // the row has since been deleted. The resolver returns [], and
    // mutation handlers translate that to a NOT_FOUND error rather than
    // silently no-oping.
    const client = makeClient([
      { id: 'tfm-other', status: 'needs_review', mapping_sources: [] },
    ])

    const result = await resolveSiblingTfms(client, {
      canonicalTfmId: 'tfm-vanished',
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
    })

    expect(result).toEqual([])
  })

  it('DB error — surfaces as a thrown Error (caller decides retry / report)', async () => {
    const client = makeClient([], { message: 'connection reset by peer' })

    await expect(
      resolveSiblingTfms(client, {
        canonicalTfmId: 'tfm-x',
        projectId: 'proj-1',
        targetFieldId: 'tf-1',
      }),
    ).rejects.toThrow(/connection reset by peer/)
  })
})
