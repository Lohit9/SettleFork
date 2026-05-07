/**
 * Pure helpers for combination-hint resolution on target_field_mapping rows.
 *
 * Path B (legacy) embeds `[Combination: X]` markers inside `ai_reasoning`.
 * Writers:
 *   - lib/ai/mapping-engine.ts:1387                         (AI-generated mappings)
 *   - app/.../mapping/MappingContent.tsx:648                (manually-created mappings)
 *
 * Path D (Sub-PR 4, migration 093) writes the structured `transformation_intent`
 * column directly, bypassing the embedded marker.
 *
 * Single regex consumer in production: lib/actions/transformations.ts:generateTransform.
 * Resolved hint is interpolated into the transform-suggest prompt's
 * `<contributing_source_fields>` block (no persistence, no UI display).
 *
 * ── Why two functions, not one widened signature ──────────────────────────
 * `extractCombinationHint` is intentionally single-arg + immutable. Sub-PR 2
 * pins its behavior with 10 test cases in `tests/utils/transformation-intent.test.ts`
 * to lock the Path B regex semantics forever. New Path-D-aware logic lives
 * in `resolveTransformationIntent`, which delegates to extractCombinationHint
 * for the fallback branch. Splitting keeps the heritage tests pinned against
 * a stable signature and gives the new logic a self-describing name.
 */

/**
 * Extract the combination hint from Path B records' `ai_reasoning` text.
 *
 * Pinned signature — DO NOT widen. New logic goes in
 * `resolveTransformationIntent` below.
 *
 * Behavior pinned by 10 test cases in tests/utils/transformation-intent.test.ts:
 *   - Lazy capture finds the FIRST `[Combination: ...]` match.
 *   - Empty bracket `[Combination: ]` returns `''` (empty string, not null) —
 *     pinned for backward compat with existing Path B records.
 *   - `null` / `undefined` / `''` input returns `null`.
 *   - Whitespace inside the bracket is preserved as captured (not trimmed).
 */
export function extractCombinationHint(
  aiReasoning: string | null | undefined,
): string | null {
  if (!aiReasoning) return null;
  const m = aiReasoning.match(/\[Combination:\s*(.*?)\]/);
  return m ? m[1] : null;
}

/**
 * Path D-aware combination-hint resolver. Prefers the structured
 * `transformation_intent` column (migration 093) when populated; falls
 * back to `extractCombinationHint()` for Path B legacy records.
 *
 *   Priority:
 *     1. `transformationIntent` non-null AND non-empty after trim → return trimmed value
 *     2. else → delegate to extractCombinationHint(aiReasoning)
 *     3. neither populated → null
 *
 * Empty-string and whitespace-only `transformationIntent` count as absent
 * — they trigger the regex fallback rather than returning empty.
 */
export function resolveTransformationIntent(
  transformationIntent: string | null | undefined,
  aiReasoning: string | null | undefined,
): string | null {
  if (transformationIntent && transformationIntent.trim()) {
    return transformationIntent.trim();
  }
  return extractCombinationHint(aiReasoning);
}
