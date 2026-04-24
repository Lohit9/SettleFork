// ─────────────────────────────────────────────────────────────────────────────
// Transform page URL-param helpers.
// ─────────────────────────────────────────────────────────────────────────────
//
// Phase 3+4 back-compat contract
// ------------------------------
// The legacy UI (and any bookmarks / cross-app deeplinks predating the
// redesign) use `?fieldMappingId=<uuid>` to deep-link into the Transform
// editor. The Phase 3 redesign uses the canonical new-model spelling
// `?targetFieldMappingId=<uuid>`.
//
// Post-Phase-2 both values are target-field-mapping UUIDs — the same pointer,
// different name — so readers accept either, preferring the new name when
// both are present. All new writers emit the new name only.
//
// Lifecycle
//   Phase 3 (now):  read either; new writers use the new name.
//   Phase 4:        migrate remaining legacy writers (N/A inside the repo
//                   once Gap 15 lands; external deeplinks persist).
//   Phase 5:        drop the `fieldMappingId` fallback entirely.
//
// See docs/features/mapping-redesign.md §Cleanup items (lines 1311–1313).

/**
 * Structural type that matches both the platform `URLSearchParams` and
 * Next.js's `ReadonlyURLSearchParams`. Keeping the shape narrow lets us
 * accept either without pulling in a framework dependency (important for
 * unit-test fixtures, which can use plain `URLSearchParams`).
 */
export interface SearchParamsLike {
  get(name: string): string | null
}

/**
 * Returns the target-field-mapping UUID encoded in the given search params,
 * or `null` if neither the new (`targetFieldMappingId`) nor the legacy
 * (`fieldMappingId`) param is present.
 *
 * Precedence: `targetFieldMappingId` wins when both are set. This matches the
 * Phase 3+4 contract — the new spelling is authoritative while the old one
 * is a read-only fallback for stale deeplinks and bookmarks.
 */
export function readTargetFieldMappingIdFromSearchParams(
  searchParams: SearchParamsLike
): string | null {
  return (
    searchParams.get('targetFieldMappingId') ??
    searchParams.get('fieldMappingId')
  )
}
