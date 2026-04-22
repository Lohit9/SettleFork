/**
 * Test 14 — Source-level guard: D8 (no maintenance-mode wiring in output
 * generation).
 *
 * Gate 2 decision D8 locks: `outputs.ts`, `execution-package.ts`, and
 * `readiness-score.ts` do NOT call `assertMappingWritesEnabled()`. Output
 * generation is a READ of the mapping model plus a write to the outputs
 * artifact store — it is not a mapping write. Wiring the guard here
 * would break customer downloads the instant a founder flips
 * maintenance_mode for an unrelated reason.
 *
 * If this test fails, a well-meaning refactor "helpfully" added the guard
 * and the next maintenance window will break customer-facing report
 * downloads. The file-header comment in `outputs.ts` explains the rule;
 * this test enforces it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(__dirname, '../..')

const FILES = [
  'lib/actions/outputs.ts',
  'lib/actions/execution-package.ts',
  'lib/quality/readiness-score.ts',
] as const

/**
 * Strip block comments (`/* ... *\/`) and line comments (`// ...`) from TS
 * source so the guard pattern matches only live code, not documentation
 * mentioning the guard name. Avoids both string-literal false-positives and
 * comment false-positives.
 */
function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (two === '/*') {
      i += 2
      while (i < n && src.slice(i, i + 2) !== '*/') i++
      i += 2
      continue
    }
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string literal (respect escapes).
      const quote = ch
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 2
        else i++
      }
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

const GUARD_CALL_PATTERN = /assertMappingWritesEnabled\s*\(/

describe('Test 14 — assertMappingWritesEnabled absent in output-generation files', () => {
  for (const relPath of FILES) {
    it(`${relPath} contains zero assertMappingWritesEnabled() call sites in live code`, () => {
      const raw = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
      const stripped = stripCommentsAndStrings(raw)
      const matches = stripped.match(new RegExp(GUARD_CALL_PATTERN, 'g')) ?? []
      expect(
        matches,
        `assertMappingWritesEnabled() call found in ${relPath} — violates D8 (see file-header comment)`,
      ).toHaveLength(0)
    })
  }
})
