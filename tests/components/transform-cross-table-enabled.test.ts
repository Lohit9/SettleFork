import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Phase 4a-6 — Transform tab Apply / Test cross-table apply ENABLED.
 *
 * Inverse-pinned counterpart to the now-deleted
 * `transform-cross-table-disabled.test.ts`. Phase 4a-3 disabled the
 * Apply / Test buttons whenever the selected row was cross-table and
 * surfaced a "future release" tooltip. Phase 4a-6 wired the
 * cross-table branch of `dq_apply_field_transform_joined` (migration
 * 076), so those guards came down. This test exists to STAY UP — if a
 * future refactor accidentally re-introduces a cross-table disable
 * gate, the assertions below will fail and call attention to the
 * regression.
 *
 * Same source-text strategy as the deleted disabled test: mocking the
 * 3k+ LOC TransformContent for a negative invariant is strictly worse
 * than grepping for the disable patterns directly.
 */

const PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/transform/TransformContent.tsx',
)
const SRC = readFileSync(PATH, 'utf8')

describe('[transform 4a-6] cross-table Apply/Test enabled', () => {
  it('Test Transform button does NOT gate on selectedContext.field.isCrossTable', () => {
    // Phase 4a-3 line:
    //   disabled={isTesting || !canEdit || !!selectedContext?.field.isCrossTable}
    // Phase 4a-6 must not reference `isCrossTable` in any disabled
    // expression on the Test button.
    expect(SRC).not.toMatch(
      /disabled=\{[^}]*selectedContext\?\.field\.isCrossTable[^}]*\}/,
    )
  })

  it('Apply Transform button does NOT gate on selectedContext.field.isCrossTable', () => {
    // The Apply button's `disabled` expression is more complex (folds
    // in isApplying / isCheckingIssues / selection state); the
    // negative invariant simply forbids the field reference anywhere
    // inside a `disabled={...}` block.
    const disabledExpressions = SRC.matchAll(/disabled=\{([^}]*)\}/g)
    for (const m of disabledExpressions) {
      expect(m[1]).not.toMatch(/isCrossTable/)
    }
  })

  it('No "future release" tooltip copy remains in the file', () => {
    // The user-facing copy "Transform application for cross-table
    // mappings ships in a future release." was the public face of
    // the transparency stack. Once the apply path ships, the copy
    // becomes a lie and must be removed.
    expect(SRC).not.toMatch(/cross-table mappings ships in a future release/i)
  })

  it('No `hasCrossTableMappings` prop remains on the legacy TransformContent', () => {
    // The legacy server-page (`transform/page.tsx`) used to fetch the
    // `projectHasCrossTableMappings` flag and thread it through. With
    // the helper removed and the prop dropped, the legacy component's
    // type signature should be free of it.
    expect(SRC).not.toMatch(/hasCrossTableMappings/)
  })
})
