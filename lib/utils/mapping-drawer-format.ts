// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 8b — pure formatters for the mapping drawer body.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure, fixture-friendly helpers consumed by `MappingDrawer.tsx`. Kept off
// the React component so they are unit-testable without mounting React and
// so future formatters (per-source labels, combination strategy phrases) can
// land here without bloating the drawer file.
//
// All exports MUST stay pure functions — no side effects, no React imports,
// no DOM access.

/**
 * Default truncation threshold for `formatSampleValues`. Eight values is
 * generous enough that 99% of real source profiles render in full (the wire
 * cap is 10 — see `MappingSourceRef.sampleValues` JSDoc and
 * `_mappings-for-redesign-core.ts` `MAX_SAMPLE_VALUES`), while still short
 * enough to keep the drawer card visually compact when a long-tail field
 * happens to surface its full 10-sample payload.
 */
export const SAMPLE_VALUES_DEFAULT_MAX = 8

/**
 * Format a source field's sample values for inline display in the drawer's
 * per-source card.
 *
 * Behavior:
 *
 *   • `null` or `[]` → empty string. Caller should branch on `result === ''`
 *     and omit the "Sample values" label entirely (founder decision: don't
 *     show a "no samples" row — silent omission keeps cards uncluttered).
 *   • length ≤ `max` → comma-joined values verbatim, no quoting, no escaping.
 *   • length > `max` → first `max` values comma-joined, then
 *     `... (+N more)` where N is `length - max`.
 *
 * Defensive null acceptance
 * -------------------------
 * The live wire contract for `MappingSourceRef.sampleValues` is `string[]`
 * (always-array, capped at 10, empty when absent). This function still
 * accepts `string[] | null` so callers can short-circuit without an extra
 * null guard at the call site, AND so a future contract drift toward
 * nullability is handled gracefully without a follow-up patch.
 *
 * Values containing commas are NOT escaped or quoted. The drawer card is a
 * preview surface, not a CSV export — overhead of CSV-style quoting would
 * obscure the actual sample text users want to see at a glance.
 */
export function formatSampleValues(
  samples: string[] | null,
  max: number = SAMPLE_VALUES_DEFAULT_MAX,
): string {
  if (samples === null || samples.length === 0) return ''

  if (samples.length <= max) {
    return samples.join(', ')
  }

  const head = samples.slice(0, max).join(', ')
  const overflow = samples.length - max
  return `${head}, ... (+${overflow} more)`
}
