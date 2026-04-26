import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Phase 4a-3 — Transform tab Apply / Test cross-table transparency.
 *
 * Source-level invariants pinning the §10-OQ-1 disposition:
 *
 *   B. Apply / Test buttons are server-disabled when the selected
 *      row is cross-table (`selectedContext.field.isCrossTable`).
 *      Tooltip surfaces the future-release copy.
 *
 * Mocking the full `TransformContent` (3k+ LOC) for a single
 * disabled-state assertion is strictly worse than a focused source
 * grep — same pattern used elsewhere for transform refinements.
 */

const PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/transform/TransformContent.tsx',
)
const SRC = readFileSync(PATH, 'utf8')

describe('[transform 4a-3] cross-table Apply/Test disabled state', () => {
  it('Test Transform button consults selectedContext.field.isCrossTable in disabled', () => {
    // Match the disabled prop on the Test Transform button. We grep
    // for the unique combination `isTesting || !canEdit` to anchor.
    expect(SRC).toMatch(
      /disabled=\{isTesting \|\| !canEdit \|\| !!selectedContext\?\.field\.isCrossTable\}/,
    )
  })

  it('Apply Transform button consults selectedContext.field.isCrossTable in disabled', () => {
    expect(SRC).toMatch(
      /disabled=\{isApplying \|\| isCheckingIssues[\s\S]{0,200}!!selectedContext\?\.field\.isCrossTable\}/,
    )
  })

  it('Both buttons surface the future-release tooltip copy when cross-table', () => {
    const occurrences = SRC.match(
      /Transform application for cross-table mappings ships in a future release\./g,
    )
    // One occurrence per button + (optionally) the action error
    // string. We require AT LEAST 2 (Test + Apply).
    expect(occurrences).not.toBeNull()
    expect((occurrences ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
