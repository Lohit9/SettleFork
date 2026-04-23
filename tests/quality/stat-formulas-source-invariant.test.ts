/**
 * Source-level invariant: every UI surface that reports project stats MUST
 * consume the canonical `computeProjectStats` helper from
 * `lib/quality/stat-formulas.ts`. If a future contributor hand-rolls the
 * mapping/transform/quality formulas in a new call site (or forks the
 * existing logic back into `_outputs-core.ts` / `readiness-score.ts`), the
 * three UI surfaces will drift again — the exact regression this module was
 * extracted to prevent.
 *
 * This test is source-text based (not behavioral) on purpose:
 *   1. Behavioral tests require wiring up Supabase and full DB fixtures.
 *      The existing Heritage snapshot tests already do that end-to-end.
 *      Re-doing it here would be slow, flaky, and redundant.
 *   2. The invariant we actually care about is structural: "don't fork the
 *      formula". Grepping the source is the cheapest, most exhaustive way
 *      to prove that.
 *
 * Mirrors the style of `tests/actions/transforms-guard-sweep.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OUTPUTS_CORE_PATH = resolve(__dirname, '../../lib/actions/_outputs-core.ts')
const READINESS_SCORE_PATH = resolve(__dirname, '../../lib/quality/readiness-score.ts')

const OUTPUTS_CORE_SOURCE = readFileSync(OUTPUTS_CORE_PATH, 'utf8')
const READINESS_SCORE_SOURCE = readFileSync(READINESS_SCORE_PATH, 'utf8')

/**
 * Matches both `import { computeProjectStats } from '@/lib/quality/stat-formulas'`
 * and the multi-line / alias variants a future contributor might write.
 * The key invariant is: the symbol is imported FROM the canonical module.
 */
const IMPORT_PATTERN = /\bcomputeProjectStats\b[\s\S]*?from\s+['"]@\/lib\/quality\/stat-formulas['"]/

/**
 * Matches a bare `computeProjectStats(` invocation anywhere in the file.
 * Pinning that the function is CALLED (not merely imported) guards against
 * the "imported but ignored while keeping the inline formula below" slip.
 */
const CALL_PATTERN = /\bcomputeProjectStats\s*\(/

describe('stat-formulas source-level invariant', () => {
  describe('lib/actions/_outputs-core.ts', () => {
    it('imports computeProjectStats from the canonical module', () => {
      expect(OUTPUTS_CORE_SOURCE).toMatch(IMPORT_PATTERN)
    })

    it('invokes computeProjectStats to derive its stats', () => {
      expect(OUTPUTS_CORE_SOURCE).toMatch(CALL_PATTERN)
    })

    it('does not re-import fieldNeedsTransform directly (delegated through the helper)', () => {
      // The helper now owns the fieldNeedsTransform call. If _outputs-core.ts
      // re-imports it, that's a strong signal someone is about to re-fork
      // the formula locally. Flag at review time.
      expect(OUTPUTS_CORE_SOURCE).not.toMatch(
        /import\s*\{[^}]*\bfieldNeedsTransform\b[^}]*\}\s*from\s*['"]@\/lib\/utils\/transform-helpers['"]/,
      )
    })
  })

  describe('lib/quality/readiness-score.ts', () => {
    it('imports computeProjectStats from the canonical module', () => {
      expect(READINESS_SCORE_SOURCE).toMatch(IMPORT_PATTERN)
    })

    it('invokes computeProjectStats to derive its stats', () => {
      expect(READINESS_SCORE_SOURCE).toMatch(CALL_PATTERN)
    })

    it('does not re-import fieldNeedsTransform directly (delegated through the helper)', () => {
      expect(READINESS_SCORE_SOURCE).not.toMatch(
        /import\s*\{[^}]*\bfieldNeedsTransform\b[^}]*\}\s*from\s*['"]@\/lib\/utils\/transform-helpers['"]/,
      )
    })
  })
})
