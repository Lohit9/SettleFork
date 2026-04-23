import { describe, it, expect } from 'vitest'
import { readTargetFieldMappingIdFromSearchParams } from '@/lib/url/transform-params'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 15 — URL-param back-compat for the Transform deeplink.
// ─────────────────────────────────────────────────────────────────────────────
//
// Contract under test:
//   - Legacy param `?fieldMappingId=<uuid>` is still accepted (read-only).
//   - New param `?targetFieldMappingId=<uuid>` is the canonical spelling.
//   - When both are present, the new spelling wins.
//   - Neither present → null.
//
// The helper is framework-agnostic (accepts any `{ get(name): string | null }`
// shape), so we exercise it against plain `URLSearchParams` instances.

const SAMPLE_UUID = '11111111-2222-3333-4444-555555555555'
const OTHER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('readTargetFieldMappingIdFromSearchParams', () => {
  it('returns the legacy fieldMappingId when only the legacy param is present', () => {
    const sp = new URLSearchParams(`fieldMappingId=${SAMPLE_UUID}`)
    expect(readTargetFieldMappingIdFromSearchParams(sp)).toBe(SAMPLE_UUID)
  })

  it('returns the new targetFieldMappingId when only the new param is present', () => {
    const sp = new URLSearchParams(`targetFieldMappingId=${SAMPLE_UUID}`)
    expect(readTargetFieldMappingIdFromSearchParams(sp)).toBe(SAMPLE_UUID)
  })

  it('prefers targetFieldMappingId when both params are present', () => {
    // New spelling authoritative; legacy is a fallback only.
    const sp = new URLSearchParams(
      `targetFieldMappingId=${SAMPLE_UUID}&fieldMappingId=${OTHER_UUID}`
    )
    expect(readTargetFieldMappingIdFromSearchParams(sp)).toBe(SAMPLE_UUID)
  })

  it('still prefers targetFieldMappingId regardless of param order in the URL', () => {
    // Guards against naive implementations that read in insertion order.
    const sp = new URLSearchParams(
      `fieldMappingId=${OTHER_UUID}&targetFieldMappingId=${SAMPLE_UUID}`
    )
    expect(readTargetFieldMappingIdFromSearchParams(sp)).toBe(SAMPLE_UUID)
  })

  it('returns null when neither param is present', () => {
    const sp = new URLSearchParams('foo=bar&status=open')
    expect(readTargetFieldMappingIdFromSearchParams(sp)).toBeNull()
  })

  it('returns null for an empty search string', () => {
    const sp = new URLSearchParams('')
    expect(readTargetFieldMappingIdFromSearchParams(sp)).toBeNull()
  })

  it('treats both params as the same TFM UUID — identical resolution', () => {
    // Core back-compat invariant: a link written with the old spelling and a
    // link written with the new spelling must resolve to the same selection.
    const legacy = new URLSearchParams(`fieldMappingId=${SAMPLE_UUID}`)
    const canonical = new URLSearchParams(`targetFieldMappingId=${SAMPLE_UUID}`)
    expect(readTargetFieldMappingIdFromSearchParams(legacy)).toBe(
      readTargetFieldMappingIdFromSearchParams(canonical)
    )
  })

  it('accepts any structural match of SearchParamsLike (e.g. Next ReadonlyURLSearchParams)', () => {
    // The helper must not depend on URLSearchParams specifically — it must
    // accept Next's `ReadonlyURLSearchParams` too. We fake the shape here.
    const fake = {
      get(name: string) {
        if (name === 'targetFieldMappingId') return SAMPLE_UUID
        return null
      },
    }
    expect(readTargetFieldMappingIdFromSearchParams(fake)).toBe(SAMPLE_UUID)
  })
})
