/**
 * View-mode URL helpers for the Mapping page.
 *
 * The Mapping page exposes two top-of-page views:
 *
 *   • 'flat' (default)  — the spreadsheet-style list view.
 *   • 'target-led'      — the per-target-table card layout.
 *
 * The default ('flat') is encoded by OMITTING the `view` param; the
 * non-default ('target-led') uses `?view=target`. The default flipped
 * to flat at the Mapping list toggle PR (`feat/mapping-list-toggle-and-columns`)
 * — buyer feedback consistently steered to the flat view as the
 * primary surface, with target-led as the alternate.
 *
 * Backward-compat reads:
 *   `?view=flat`       → flat (explicit alias for default)
 *   `?view=target`     → target-led (new canonical)
 *   `?view=target-led` → target-led (transitional alias for any link
 *                        that may still carry the old internal form)
 *   any other / missing → flat
 *
 * Writes:
 *   flat       → delete `view` (clean URL for default)
 *   target-led → set `view=target`
 *
 * Kept deliberately separate from `MappingFilterState`: view-mode is
 * orthogonal to filter axes, so threading it through the filter state
 * would force every `filterRows()` caller to know about a dimension
 * it does not care about. Two small helpers here keep the concerns
 * isolated.
 */

export type MappingViewMode = 'target-led' | 'flat'

export const DEFAULT_VIEW_MODE: MappingViewMode = 'flat'

const VIEW_MODE_PARAM = 'view'
const VIEW_MODE_TARGET = 'target'

/**
 * Parse a URL search-params bag into the active view mode. Unknown /
 * missing values resolve to the default ('flat').
 *
 * Accepts both `URLSearchParams` and Next's `ReadonlyURLSearchParams`
 * via the minimal structural interface `{ get(key): string | null }`,
 * matching `parseFilterStateFromParams` in `mapping-filters.ts`.
 */
export function parseViewModeFromParams(params: {
  get(key: string): string | null
}): MappingViewMode {
  const raw = params.get(VIEW_MODE_PARAM)
  if (raw === VIEW_MODE_TARGET || raw === 'target-led') return 'target-led'
  return DEFAULT_VIEW_MODE
}

/**
 * Apply a view mode to an existing URLSearchParams bag, mutating it.
 * The default mode (`'flat'`) is encoded by REMOVING the param;
 * non-default ('target-led') is written as `view=target`.
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
  params.set(VIEW_MODE_PARAM, VIEW_MODE_TARGET)
}
