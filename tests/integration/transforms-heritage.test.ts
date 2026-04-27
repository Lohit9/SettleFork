import { describe, it, expect } from 'vitest'

/**
 * Integration smoke test for the Phase 2 transformations module, run
 * against the "Heritage Core" canary project (see
 * `docs/features/mapping-redesign.md` §Canary).
 *
 * Scope: READ-ONLY verification that `getTransformData` returns the shape
 * the Transform page consumes and that every emitted `FieldItem.transformation`
 * row keys correctly on `target_field_mapping_id` in the new model.
 *
 * The transform-lifecycle write paths (`generateTransform` /
 * `applyTransform` / `revertTransform`) are verified by:
 *   - unit source-level invariants in `transforms-refinements.test.ts`
 *   - the global uniqueness invariant in
 *     `transformations-unique-invariant.test.ts`
 *   - manual smoke-testing in the canary UI before each release
 *
 * We deliberately do NOT run the write cycle against live data here — a
 * rollback path that runs in CI against production is worse than no
 * automation at all.
 *
 * Env-gated:
 *   HERITAGE_PROJECT_ID       — uuid of the canary project
 *   NEXT_PUBLIC_SUPABASE_URL  — user-scoped client
 *   SUPABASE_SERVICE_ROLE_KEY — admin client
 *
 * Run locally:
 *   HERITAGE_PROJECT_ID=...  NEXT_PUBLIC_SUPABASE_URL=... \
 *     SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/transforms-heritage.test.ts
 */

const HERITAGE_PROJECT_ID = process.env.HERITAGE_PROJECT_ID ?? ''
const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

describeFn('[integration] getTransformData against Heritage Core', () => {
  it('returns a well-formed TransformPageData shape', async () => {
    const { getTransformData } = await import('@/lib/actions/transformations')
    const result = await getTransformData(HERITAGE_PROJECT_ID)

    expect(result.datasets).toBeInstanceOf(Array)
    expect(result.hasMappings).toBeTypeOf('boolean')
    expect(result.unmappedNotNullTargetFields).toBeInstanceOf(Array)
    expect(result.unmappedNullableTargetFields).toBeInstanceOf(Array)
  })

  it('every emitted FieldItem has a legal shape', async () => {
    const { getTransformData } = await import('@/lib/actions/transformations')
    const result = await getTransformData(HERITAGE_PROJECT_ID)

    for (const ds of result.datasets) {
      for (const tg of ds.tables) {
        expect(tg.tableMappingId).toBeTypeOf('string')
        for (const f of tg.fields) {
          expect(f.fieldMappingId).toBeTypeOf('string')
          expect(f.targetFieldId).toBeTypeOf('string')
          expect(f.targetFieldName).toBeTypeOf('string')
          // `isContributing` is always false in the new model (contributors
          // are folded into `contributingSourceFields`).
          expect(f.isContributing).toBe(false)
          if (f.transformation) {
            // Transformations key on target_field_mapping_id — which is the
            // FieldItem.fieldMappingId when the item is a primary/VA.
            expect(f.transformation.id).toBeTypeOf('string')
            expect(f.transformation.target_field_mapping_id).toBeTypeOf('string')
          }
        }
      }
    }
  })

  it('FieldItem.fieldMappingId values are unique within the result', async () => {
    // Each primary/VA TFM surfaces exactly once across the datasets (mapped
    // under its primary source's TM; VAs under the first matching TM per
    // target table — the routing is deterministic).
    const { getTransformData } = await import('@/lib/actions/transformations')
    const result = await getTransformData(HERITAGE_PROJECT_ID)

    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const ds of result.datasets) {
      for (const tg of ds.tables) {
        for (const f of tg.fields) {
          if (seen.has(f.fieldMappingId)) duplicates.push(f.fieldMappingId)
          seen.add(f.fieldMappingId)
        }
      }
    }
    expect(duplicates, `duplicate fieldMappingIds: ${duplicates.slice(0, 10).join(', ')}`).toEqual([])
  })

  it('unmapped target fields do not overlap with mapped FieldItems', async () => {
    const { getTransformData } = await import('@/lib/actions/transformations')
    const result = await getTransformData(HERITAGE_PROJECT_ID)

    const mappedTargetFieldIds = new Set<string>()
    for (const ds of result.datasets) {
      for (const tg of ds.tables) {
        for (const f of tg.fields) {
          mappedTargetFieldIds.add(f.targetFieldId)
        }
      }
    }

    for (const u of result.unmappedNotNullTargetFields) {
      expect(mappedTargetFieldIds.has(u.id)).toBe(false)
    }
    for (const u of result.unmappedNullableTargetFields) {
      expect(mappedTargetFieldIds.has(u.id)).toBe(false)
    }
  })

  // ── Counter-unification (feat/transform-counter-unification, 2026-04-27) ──
  //
  // After the Transform tab joined the canonical `computeProjectStats` path,
  // its four pill scalars MUST match what the Projects List card and
  // Migration Center display for the same project. We verify this two ways:
  //   1. Internal consistency:
  //        transformInProgress === transformScope - transformApplied - transformNeedsWork
  //      and each scalar is a non-negative integer no larger than `transformScope`.
  //   2. Cross-surface consistency: the Heritage canary's Projects List
  //      already pins these same numbers in
  //      `tests/integration/projects-heritage.test.ts:194-201` (and the
  //      Migration Center pins them in `outputs-heritage.test.ts:135-140`).
  //      A drift here without a matching update there immediately surfaces
  //      the regression.
  it('returns the four canonical pill scalars as a self-consistent quartet', async () => {
    const { getTransformData } = await import('@/lib/actions/transformations')
    const result = await getTransformData(HERITAGE_PROJECT_ID)

    expect(result.transformScope).toBeTypeOf('number')
    expect(result.transformApplied).toBeTypeOf('number')
    expect(result.transformNeedsWork).toBeTypeOf('number')
    expect(result.transformInProgress).toBeTypeOf('number')

    expect(Number.isInteger(result.transformScope)).toBe(true)
    expect(Number.isInteger(result.transformApplied)).toBe(true)
    expect(Number.isInteger(result.transformNeedsWork)).toBe(true)
    expect(Number.isInteger(result.transformInProgress)).toBe(true)

    expect(result.transformScope).toBeGreaterThanOrEqual(0)
    expect(result.transformApplied).toBeGreaterThanOrEqual(0)
    expect(result.transformNeedsWork).toBeGreaterThanOrEqual(0)
    expect(result.transformInProgress).toBeGreaterThanOrEqual(0)

    expect(result.transformApplied).toBeLessThanOrEqual(result.transformScope)
    expect(result.transformNeedsWork).toBeLessThanOrEqual(result.transformScope)
    expect(result.transformInProgress).toBeLessThanOrEqual(result.transformScope)

    // The arithmetic identity that makes the four pills add up to the whole.
    expect(result.transformInProgress).toBe(
      result.transformScope - result.transformApplied - result.transformNeedsWork,
    )
  })
})
