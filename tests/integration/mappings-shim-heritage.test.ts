import { describe, it, expect } from 'vitest'

/**
 * Integration test for the Phase 2 mapping shim, run against the
 * "Heritage Core" canary project (the canonical data-shape fixture for
 * this codebase — see `docs/features/mapping-redesign.md` §Canary).
 *
 * This suite is **env-gated**: it only runs when:
 *
 *   HERITAGE_PROJECT_ID       — uuid of the canary project
 *   NEXT_PUBLIC_SUPABASE_URL  — supabase project URL (user-scoped client)
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (admin client)
 *
 * Without these, every `it.skip(...)` no-ops so CI stays green on machines
 * that don't have production credentials. Run locally with:
 *
 *   HERITAGE_PROJECT_ID=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/mappings-shim-heritage.test.ts
 *
 * The assertions are deliberately high-level shape checks — deep equality
 * against live data is brittle because the project evolves. What we DO
 * check:
 *
 *   1. `getMappings` returns a non-null `MappingsResult`.
 *   2. Every rendered `RichFieldMapping` has a non-empty `id` that
 *      round-trips through `decodeShimmedRowId`.
 *   3. Every TFM's primary row (is_contributing=false) decodes to
 *      `kind: 'tfm-primary'`.
 *   4. Every contributor decodes to `kind: 'tfm-contributor'` with the
 *      same tfmId as its primary sibling.
 *   5. Every `FieldAcknowledgmentRow.id` decodes to a target-ack or
 *      source-ack kind.
 *   6. Totals match row counts in the backing tables (TFMs + VAs +
 *      target-acks = RichFieldMappings + target-acks surfaced).
 */

const HERITAGE_PROJECT_ID = process.env.HERITAGE_PROJECT_ID ?? ''
const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

describeFn('[integration] mapping shim against Heritage Core', () => {
  it('getMappings returns a well-formed MappingsResult', async () => {
    const { getMappings } = await import('@/lib/actions/mappings')
    const result = await getMappings(HERITAGE_PROJECT_ID)

    expect(result).not.toBeNull()
    if (!result) return

    expect(result.tableMappings).toBeInstanceOf(Array)
    expect(result.acknowledgments).toBeInstanceOf(Array)
    expect(result.allFieldsByTable).toBeTypeOf('object')
    expect(result.allSourceTables).toBeInstanceOf(Array)
    expect(result.allTargetTables).toBeInstanceOf(Array)
  })

  it('every RichFieldMapping id decodes via the shim codec', async () => {
    const { getMappings } = await import('@/lib/actions/mappings')
    const { decodeShimmedRowId } = await import('@/lib/compat/mapping-shim')
    const result = await getMappings(HERITAGE_PROJECT_ID)
    if (!result) throw new Error('getMappings returned null')

    const primaryTfmIds = new Set<string>()
    const contributorTfmIds = new Set<string>()

    for (const tm of result.tableMappings) {
      for (const fm of tm.fieldMappings) {
        const decoded = decodeShimmedRowId(fm.id)
        expect(decoded.kind).not.toBe('unknown')
        if (fm.is_contributing) {
          expect(decoded.kind).toBe('tfm-contributor')
          if (decoded.kind === 'tfm-contributor') {
            contributorTfmIds.add(decoded.tfmId)
          }
        } else {
          expect(decoded.kind).toBe('tfm-primary')
          if (decoded.kind === 'tfm-primary') {
            primaryTfmIds.add(decoded.tfmId)
          }
        }
      }
    }

    // Every contributor must have a primary sibling in the same result set
    // (the shim guarantees this — a contributor can't exist without a
    // corresponding primary TFM).
    for (const tfmId of contributorTfmIds) {
      expect(primaryTfmIds.has(tfmId)).toBe(true)
    }
  })

  it('every FieldAcknowledgmentRow id decodes to a target- or source-ack', async () => {
    const { getMappings } = await import('@/lib/actions/mappings')
    const { decodeShimmedRowId } = await import('@/lib/compat/mapping-shim')
    const result = await getMappings(HERITAGE_PROJECT_ID)
    if (!result) throw new Error('getMappings returned null')

    for (const ack of result.acknowledgments) {
      const decoded = decodeShimmedRowId(ack.id)
      if (ack.side === 'target') expect(decoded.kind).toBe('target-ack')
      else if (ack.side === 'source') expect(decoded.kind).toBe('source-ack')
    }
  })

  it('totals match backing-table row counts', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { getMappings } = await import('@/lib/actions/mappings')
    const result = await getMappings(HERITAGE_PROJECT_ID)
    if (!result) throw new Error('getMappings returned null')

    const { count: tfmCount } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)

    const { count: ackSourceCount } = await supabaseAdmin
      .from('source_field_acknowledgments')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)

    // Aggregates from the shimmed result. Note: VAs are rendered under
    // EVERY matching TM per the shim's VA spreading rule, so a simple
    // RichFieldMapping count will be inflated. We collapse by id to
    // match the TFM count.
    const uniqueTfmIds = new Set<string>()
    for (const tm of result.tableMappings) {
      for (const fm of tm.fieldMappings) {
        if (fm.is_contributing) continue
        const ampIdx = fm.id.indexOf('::')
        uniqueTfmIds.add(ampIdx >= 0 ? fm.id.slice(0, ampIdx) : fm.id)
      }
    }
    // Target-side acks are TFMs with is_acknowledged=true — they don't
    // appear as RichFieldMappings but are counted against tfmCount. Add
    // the target-ack rows to the shimmed unique count to compare.
    const targetAckCount = result.acknowledgments.filter((a) => a.side === 'target').length
    const sourceAckCount = result.acknowledgments.filter((a) => a.side === 'source').length

    // uniqueTfmIds is non-ack TFMs. targetAckCount is is_acknowledged TFMs.
    // Sum must equal tfmCount.
    expect(uniqueTfmIds.size + targetAckCount).toBe(tfmCount ?? -1)
    expect(sourceAckCount).toBe(ackSourceCount ?? -1)
  })
})
