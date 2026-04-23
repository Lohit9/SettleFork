'use client'

import type { ProjectInfo } from '@/components/app/ProjectInfoPopover'

/**
 * Client-side feature gate for the Phase 3+ mapping redesign UI.
 *
 * Consumes the flag from `ProjectInfo` (server-rendered into the page) rather
 * than fetching — the value is baked into the initial HTML payload, so the
 * hook is pure/synchronous and has no loading state.
 *
 * Back-compat: `useMappingRedesign` is optional on `ProjectInfo` for call sites
 * that haven't been updated yet. Returns `false` (old UI) in that case.
 *
 * See docs/features/mapping-redesign.md §"Feature flag infrastructure".
 */
export function useMappingRedesignEnabled(
  projectInfo: ProjectInfo | undefined | null
): boolean {
  return projectInfo?.useMappingRedesign === true
}
