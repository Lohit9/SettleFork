'use client'

/**
 * Strict boolean check for the Phase 3+ mapping redesign feature flag.
 *
 * Server pages (mapping/page.tsx) own the dispatch — they read
 * `projects.use_mapping_redesign` and render `<MappingRedesignContent>`
 * vs the legacy `<MappingContent>` accordingly. This hook remains
 * exported for any future client-side consumer that needs the same
 * strict-check semantics: only literal `true` enables; falsy / null /
 * non-boolean values disable. The strict equality check guards against
 * silent data-shape drift (e.g. a stringly-typed `"1"` from Supabase).
 *
 * Pure, synchronous, no React state.
 */
export function useMappingRedesignEnabled(
  flag: boolean | undefined | null
): boolean {
  return flag === true
}
