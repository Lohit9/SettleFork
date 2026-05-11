/**
 * View-mode URL helpers for the Mapping page.
 *
 * The Mapping page exposes two top-of-page views:
 *
 *   • 'target-led' (default) — the existing per-target-table card layout.
 *   • 'flat'                  — the spreadsheet-style list view.
 *
 * The choice is mirrored to `?view=flat` so links are shareable. The
 * default ('target-led') is encoded by OMITTING the param entirely so
 * the URL stays clean for the most common case (matches the
 * MappingFilterState convention from `mapping-filters.ts`).
 *
 * Kept deliberately separate from `MappingFilterState`: view-mode is
 * orthogonal to filter axes, so threading it through the filter state
 * would force every `filterRows()` caller to know about a dimension
 * it does not care about. Two small helpers here keep the concerns
 * isolated.
 */

export type MappingViewMode = 'target-led' | 'flat'

export const DEFAULT_VIEW_MODE: MappingViewMode = 'target-led'

const VIEW_MODE_PARAM = 'view'
const VIEW_MODE_FLAT = 'flat'

/**
 * Parse a URL search-params bag into the active view mode. Unknown /
 * missing values resolve to the default ('target-led').
 *
 * Accepts both `URLSearchParams` and Next's `ReadonlyURLSearchParams`
 * via the minimal structural interface `{ get(key): string | null }`,
 * matching `parseFilterStateFromParams` in `mapping-filters.ts`.
 */
export function parseViewModeFromParams(params: {
  get(key: string): string | null
}): MappingViewMode {
  const raw = params.get(VIEW_MODE_PARAM)
  if (raw === VIEW_MODE_FLAT) return 'flat'
  return DEFAULT_VIEW_MODE
}

/**
 * Apply a view mode to an existing URLSearchParams bag, mutating it.
 * The default mode (`'target-led'`) is encoded by REMOVING the param;
 * non-default modes set it explicitly.
 *
 * Callers compose this with the filter serialization to build the
 * final query string in one pass.
 */
export function applyViewModeToParams(
  params: URLSearchParams,
  mode: MappingViewMode,
): void {
  if (mode === DEFAULT_VIEW_MODE) {
    params.delete(VIEW_MODE_PARAM)
    return
  }
  params.set(VIEW_MODE_PARAM, VIEW_MODE_FLAT)
}
