'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// ─────────────────────────────────────────────────────────────────────────────
// useCollapsedGroups — Phase 4-polish-2 group-collapsibility URL hook.
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth for which target-table groups on the mapping page
// are currently collapsed. State persists in the URL via `?collapsed=` so
// browser back/forward, page refresh, and link sharing all preserve the
// disclosure state. Filter params (`?target=`, `?source=`, `?status=`,
// `?confidence=`, `?q=`, `?drawer=`) coexist — toggling a group never
// mutates filter params and vice-versa.
//
// Wire format (`?collapsed=` value):
//   • Comma-separated list of target-table names. Empty string ⇒ all groups
//     expanded (the param itself is then absent from the URL).
//   • Each name is `encodeURIComponent`-ed so reserved chars (slash, hash,
//     ampersand, equals, etc.) survive the round-trip.
//   • Comma is the separator and is therefore reserved — table names that
//     literally contain a comma are unsupported in v1. Heritage Core has
//     none; if a future schema does, we'd switch the separator (e.g. `|`)
//     or move to repeated-key form (`?collapsed=foo&collapsed=bar`). The
//     stop-condition in the spec calls this out.
//
// Browser history hygiene:
//   • `router.replace` (not `push`) so toggling does not pollute history
//     with one entry per click. Back/forward then traverses real navigation
//     events, not disclosure flips. Matches the existing filter-write
//     convention in `MappingContent.tsx`.
//   • `{ scroll: false }` so toggles do not jump the viewport to the top
//     of the page — the user's scroll position is preserved across
//     collapse/expand interactions.
//
// Coexistence with filter params:
//   • The hook reads `useSearchParams()` and produces a fresh
//     `URLSearchParams` clone before each mutation. Other params are
//     preserved verbatim.
//   • The hook does NOT depend on the filter shape — anything in the URL
//     stays in the URL on toggle, matching the `MappingContent.writeUrl`
//     convention.

const COLLAPSED_PARAM = 'collapsed'

export interface UseCollapsedGroupsResult {
  /** Set of target-table names currently collapsed. Stable per URL state. */
  collapsedGroups: ReadonlySet<string>
  /** O(1) membership check for a single table name. */
  isCollapsed: (tableName: string) => boolean
  /** Flip a single table's collapsed state, then `router.replace`. */
  toggleCollapsed: (tableName: string) => void
  /**
   * Clear `?collapsed=` entirely, then `router.replace`. Used when the
   * caller wants to expand everything regardless of current state.
   */
  expandAll: () => void
}

/**
 * Read + write `?collapsed=` group-collapsibility state.
 *
 * The hook is pure with respect to URL state — it never holds a local
 * copy of the collapsed set. Each render parses the current URL afresh
 * (memoised by the search-param string), so external URL changes (browser
 * back, an explicit `router.replace` from elsewhere, a deep link) are
 * reflected without manual sync.
 */
export function useCollapsedGroups(): UseCollapsedGroupsResult {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // The raw query-string suffix is the dependency for the memoised Set.
  // Using `searchParams.toString()` (or `''` when null) guarantees a
  // primitive identity that React can compare cheaply between renders.
  const searchKey = searchParams ? searchParams.toString() : ''

  const collapsedGroups = useMemo(
    () => parseCollapsedParam(searchParams?.get(COLLAPSED_PARAM) ?? ''),
    // The Set is derived purely from `searchKey`; depending on the
    // param string keeps the memo stable across unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchKey],
  )

  const isCollapsed = useCallback(
    (tableName: string) => collapsedGroups.has(tableName),
    [collapsedGroups],
  )

  const writeCollapsed = useCallback(
    (next: ReadonlySet<string>) => {
      // We bypass `URLSearchParams.set` for our param to avoid double-
      // encoding: each name is already pre-encoded via
      // `encodeURIComponent` (so reserved chars like `/` survive), but
      // `URLSearchParams.toString` would then encode the resulting `%`
      // again into `%25`, producing ugly URLs like `?collapsed=
      // foo%252Fbar`. Strip our param, let URLSearchParams encode the
      // rest, then append our segment with literal commas + already-
      // encoded names.
      const params = new URLSearchParams(searchKey)
      params.delete(COLLAPSED_PARAM)
      const otherQs = params.toString()
      const collapsedQs =
        next.size === 0 ? '' : `${COLLAPSED_PARAM}=${serializeCollapsedSet(next)}`
      const qs = [otherQs, collapsedQs].filter(Boolean).join('&')
      const target = `${pathname ?? ''}${qs ? `?${qs}` : ''}`
      router.replace(target, { scroll: false })
    },
    [router, pathname, searchKey],
  )

  const toggleCollapsed = useCallback(
    (tableName: string) => {
      const next = new Set(collapsedGroups)
      if (next.has(tableName)) {
        next.delete(tableName)
      } else {
        next.add(tableName)
      }
      writeCollapsed(next)
    },
    [collapsedGroups, writeCollapsed],
  )

  const expandAll = useCallback(() => {
    if (collapsedGroups.size === 0) return
    writeCollapsed(new Set())
  }, [collapsedGroups, writeCollapsed])

  return { collapsedGroups, isCollapsed, toggleCollapsed, expandAll }
}

// ── Internal serializers (exported for the hook's unit tests) ─────────────

/**
 * Parse a `?collapsed=` value into a Set of target-table names.
 *
 * Empty / missing input → empty Set. Each comma-separated segment is
 * `decodeURIComponent`-ed; segments that decode to the empty string after
 * trimming are dropped (defensive — guards against `?collapsed=foo,,bar`
 * tolerating a stray comma without breaking the parser).
 *
 * Decode errors (malformed `%xx` sequences) are caught per-segment so a
 * single bad segment never throws and the rest survive.
 */
export function parseCollapsedParam(raw: string): ReadonlySet<string> {
  if (raw.length === 0) return new Set()
  const out = new Set<string>()
  for (const segment of raw.split(',')) {
    if (segment.length === 0) continue
    try {
      const decoded = decodeURIComponent(segment).trim()
      if (decoded.length > 0) out.add(decoded)
    } catch {
      // Malformed segment — skip silently. The URL is user-provided
      // (could be a hand-edited deep link), so robustness beats
      // crashing the page.
    }
  }
  return out
}

/**
 * Serialize a Set of target-table names into a `?collapsed=` value.
 *
 * Names are `encodeURIComponent`-ed so reserved characters (including
 * the comma separator) survive. The output preserves the iteration order
 * of the input Set — callers that care about determinism (e.g. tests)
 * should construct the Set in the desired order.
 */
export function serializeCollapsedSet(set: ReadonlySet<string>): string {
  const parts: string[] = []
  for (const name of set) {
    parts.push(encodeURIComponent(name))
  }
  return parts.join(',')
}
