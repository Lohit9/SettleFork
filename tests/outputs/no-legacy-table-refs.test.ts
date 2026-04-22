/**
 * Test 13 — Source-level guard against legacy table references.
 *
 * After the Prompt 3a/3c rewrites, these three files must not reference
 * the legacy `field_mappings` or `field_acknowledgments` tables directly.
 * The shim layer (`lib/actions/_mapping-shim.ts`) and the legacy-adapter
 * callers are the only places those names should still appear.
 *
 * If this test fails, a rewrite missed a query and the runtime will
 * attempt to hit a table that migration 074 left in place for legacy
 * callers — silently producing stale data instead of honoring the new
 * model. Catching it at the source level is much faster than catching
 * it via a heritage integration assertion.
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

// Match: .from('field_mappings'), .from("field_acknowledgments"), etc.
// Permissive on whitespace; strict on the two legacy table names.
const LEGACY_TABLE_PATTERN = /\.from\s*\(\s*['"`](field_mappings|field_acknowledgments)['"`]\s*\)/

describe('Test 13 — no legacy table references in rewritten files', () => {
  for (const relPath of FILES) {
    it(`${relPath} contains zero .from('field_mappings' | 'field_acknowledgments') references`, () => {
      const contents = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
      const matches = contents.match(new RegExp(LEGACY_TABLE_PATTERN, 'g')) ?? []
      expect(matches, `Legacy-table reference found in ${relPath}: ${matches.join(', ')}`).toHaveLength(0)
    })
  }
})
