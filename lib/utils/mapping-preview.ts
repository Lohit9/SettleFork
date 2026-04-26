// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — pure sample-value preview for the manual mapping creation
// form (W1).
// ─────────────────────────────────────────────────────────────────────────────
//
// `CreateMappingForm` shows a real-time preview of what the new mapping
// will look like at apply-time, computed client-side from the selected
// sources' `sampleValues` arrays. This module contains the pure helper
// only — no React, no DOM, no formatters — so it stays trivial to
// fixture-test.
//
// Apply-time semantics for `concat_*` are zip-by-min-length (per Phase 4
// plan investigation §5d): with sources of unequal sample counts the
// shortest array wins, longer tails are dropped. This is the same
// behaviour the Transform-tab apply RPC produces; if that ever drifts,
// this helper drifts too — keep them aligned.
//
// `'single'` returns the first source's samples verbatim regardless of
// `selectedFields.length`. This is intentionally defensive (founder
// decision §5-OQ-2): the form layer guarantees that `'single'` is only
// emitted when `selectedFields.length === 1`, but a robust pure helper
// should not blow up on malformed input.

import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

/**
 * Default cap on preview rows shown in the form. Three rows is enough
 * to communicate the shape ("looks like first/last/email") without
 * dominating the form's vertical real estate. Server caps
 * `sampleValues` at 10 anyway (`MAX_SAMPLE_VALUES` in
 * `_mappings-for-redesign-core.ts`), so overflow above 10 is
 * unreachable for honest data.
 */
export const SAMPLE_PREVIEW_DEFAULT_MAX = 3

/**
 * Combination types the form can emit. Subset of the wrapper's
 * `CreateFieldMappingCombinationType` (which itself is the DB enum
 * minus `'custom_sql'`). Authored separately to keep this module from
 * importing the server-action surface.
 */
export type SamplePreviewCombinationType =
  | 'single'
  | 'concat_space'
  | 'concat_comma'

/**
 * Result shape: the first `<= max` zipped (or single-source) preview
 * rows, plus an `overflow` count for the "+N more" indicator the form
 * renders below the preview list.
 *
 * Empty inputs yield `{ preview: [], overflow: 0 }` — callers branch
 * on `preview.length === 0` and render a "No sample values available"
 * placeholder.
 */
export interface SamplePreview {
  preview: string[]
  overflow: number
}

/**
 * Compute the apply-time preview for a candidate mapping.
 *
 * Behavior:
 *   • Empty `selectedFields` → empty preview.
 *   • `'single'` → first selected field's `sampleValues`, head-capped
 *     at `max`. Subsequent selected fields (if any) are ignored — the
 *     'single' contract is "use sources[0] verbatim" (defensive — see
 *     module header).
 *   • `'concat_space'` / `'concat_comma'` → zip-by-min-length across
 *     all selected fields, joined with the appropriate separator,
 *     head-capped at `max`. If ANY field has an empty `sampleValues`,
 *     the zip degenerates and the preview is empty.
 *
 * `overflow` counts how many additional preview rows would have
 * existed beyond `max` (clamped to ≥0). Callers render
 * `+{overflow} more` only when `overflow > 0`.
 */
export function computeSamplePreview(
  selectedFields: Pick<SourceFieldWithState, 'id' | 'sampleValues'>[],
  combinationType: SamplePreviewCombinationType,
  max: number = SAMPLE_PREVIEW_DEFAULT_MAX,
): SamplePreview {
  if (selectedFields.length === 0) {
    return { preview: [], overflow: 0 }
  }

  if (combinationType === 'single') {
    const samples = selectedFields[0]!.sampleValues
    const head = samples.slice(0, max)
    return {
      preview: head,
      overflow: Math.max(0, samples.length - head.length),
    }
  }

  // concat_*: zip-by-min-length across all selected fields.
  const minLen = Math.min(
    ...selectedFields.map((f) => f.sampleValues.length),
  )
  if (minLen === 0) {
    return { preview: [], overflow: 0 }
  }

  const separator = combinationType === 'concat_space' ? ' ' : ', '
  const zipCount = Math.min(minLen, max)
  const zipped: string[] = []
  for (let i = 0; i < zipCount; i++) {
    zipped.push(selectedFields.map((f) => f.sampleValues[i]).join(separator))
  }
  return {
    preview: zipped,
    overflow: Math.max(0, minLen - zipCount),
  }
}
