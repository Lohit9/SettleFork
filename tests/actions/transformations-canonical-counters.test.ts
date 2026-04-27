import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Transform-tab counter unification
 * (`feat/transform-counter-unification`, 2026-04-27).
 *
 * The Transform tab used to load its own TFM set with a stricter SQL filter
 * (`is_acknowledged=false`) and compute the four pill values inline, which
 * caused two latent bugs:
 *
 *   1. SQL over-filter — bare-ack TFMs were excluded from the loader, so
 *      `mappingApproved` / `acknowledgedCount` were never visible to the
 *      pills (would have under-reported once the helper ran here).
 *   2. "Applied" pill counted ALL applied transformations regardless of
 *      whether the parent TFM was in-scope (`needsTransform=true`).
 *
 * Both regressions are now structurally impossible because the four scalars
 * (`transformScope`, `transformApplied`, `transformNeedsWork`,
 * `transformInProgress`) are returned by `computeProjectStats` directly. This
 * test pins the structural choices so a future contributor can't quietly
 * un-do the unification.
 *
 * Source-text rather than behavioral, mirroring the convention already
 * established in `transforms-refinements.test.ts` and the broader
 * `stat-formulas-source-invariant.test.ts`. Behavioral verification against
 * Heritage lives in `tests/integration/transforms-heritage.test.ts` (the
 * "self-consistent quartet" test).
 */

const TRANSFORMATIONS_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const TRANSFORMATIONS_SRC = readFileSync(TRANSFORMATIONS_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─── C1: TransformPageData declares the four canonical scalars ───────────────

describe('[counter unification] C1 — TransformPageData canonical scalars', () => {
  const IFACE = sliceBetween(
    TRANSFORMATIONS_SRC,
    'export interface TransformPageData {',
    '\n}\n',
  )

  it('declares transformScope as a number field', () => {
    expect(IFACE).toMatch(/\btransformScope\s*:\s*number\b/)
  })

  it('declares transformApplied as a number field', () => {
    expect(IFACE).toMatch(/\btransformApplied\s*:\s*number\b/)
  })

  it('declares transformNeedsWork as a number field', () => {
    expect(IFACE).toMatch(/\btransformNeedsWork\s*:\s*number\b/)
  })

  it('declares transformInProgress as a number field', () => {
    expect(IFACE).toMatch(/\btransformInProgress\s*:\s*number\b/)
  })
})

// ─── C2: getTransformData routes through computeProjectStats ────────────────

describe('[counter unification] C2 — getTransformData routes through computeProjectStats', () => {
  const BODY = sliceBetween(
    TRANSFORMATIONS_SRC,
    'export async function getTransformData(',
    '\n}\n',
  )

  it('imports computeProjectStats from the canonical helper module', () => {
    expect(TRANSFORMATIONS_SRC).toMatch(
      /import\s*\{\s*computeProjectStats\s*\}\s*from\s+['"]@\/lib\/quality\/stat-formulas['"]/,
    )
  })

  it('invokes computeProjectStats inside getTransformData', () => {
    expect(BODY).toMatch(/\bcomputeProjectStats\s*\(/)
  })

  it('returns the four canonical scalars from the helper output', () => {
    expect(BODY).toMatch(/transformScope\s*:\s*stats\.transformScope\b/)
    expect(BODY).toMatch(/transformApplied\s*:\s*stats\.transformApplied\b/)
    expect(BODY).toMatch(/transformNeedsWork\s*:\s*stats\.transformNeedsWork\b/)
    // transformInProgress is derived from the trio above; the locked formula
    // matches the JSDoc on TransformPageData and the canonical helper.
    expect(BODY).toMatch(
      /transformInProgress[\s\S]{0,160}stats\.transformScope\s*-\s*stats\.transformApplied\s*-\s*stats\.transformNeedsWork/,
    )
  })
})

// ─── C3: SQL filter no longer over-filters bare-ack TFMs ────────────────────

describe('[counter unification] C3 — TFM SQL filter matches canonical scope', () => {
  const TFM_QUERY = sliceBetween(
    TRANSFORMATIONS_SRC,
    "from('target_field_mappings')\n        .select('*')",
    'TargetFieldMappingRow[]>',
  )

  it("does not narrow the TFM fetch via `.eq('is_acknowledged', false)`", () => {
    // The canonical scope keeps bare-acks in the helper input so they count
    // toward `mappingApproved`/`acknowledgedCount`. A future contributor
    // re-adding this filter would silently return the Transform tab to its
    // pre-unification under-count behavior.
    expect(TFM_QUERY).not.toMatch(/\.eq\(\s*['"]is_acknowledged['"]\s*,\s*false\s*\)/)
  })

  it("still rejects soft-deleted TFMs via `.neq('status', 'rejected')`", () => {
    expect(TFM_QUERY).toMatch(/\.neq\(\s*['"]status['"]\s*,\s*['"]rejected['"]\s*\)/)
  })
})

// ─── C4: Bare-ack TFMs are filtered from the FieldItem tree ─────────────────

describe('[counter unification] C4 — bare-ack TFMs do not surface as FieldItems', () => {
  it('the FieldItem-construction loop skips bare-ack TFMs explicitly', () => {
    // Bare-acks (is_acknowledged=true AND combination_type IS NULL) belong in
    // the helper input but have no mapping_sources row and would otherwise be
    // misclassified as VAs. Pin the in-loop guard so the visual UI keeps its
    // pre-unification "no bare-ack rows in the tree" behavior.
    expect(TRANSFORMATIONS_SRC).toMatch(
      /if\s*\(\s*tfm\.is_acknowledged\s*&&\s*tfm\.combination_type\s*===\s*null\s*\)\s*continue/,
    )
  })
})
