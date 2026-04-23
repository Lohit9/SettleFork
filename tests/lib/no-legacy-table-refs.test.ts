/**
 * Codebase-wide guard against legacy-table references (Prompt 3d,
 * Step 3D-13, Gate 2 §3.2).
 *
 * Migration 074 renamed the field-mapping data model from
 * `field_mappings` + `field_acknowledgments` to
 * `target_field_mappings` + `mapping_sources` +
 * `source_field_acknowledgments`. The legacy tables are preserved as
 * read-only shim surfaces for external consumers, but the product
 * code must NOT issue Supabase queries against them — doing so would
 * read stale data silently.
 *
 * This test supersedes `tests/outputs/no-legacy-table-refs.test.ts`
 * (which covered only 3 hand-picked files). The new scope walks every
 * `.ts` / `.tsx` file in `lib/`, `app/`, and `components/` and asserts
 * zero runtime references to `.from('field_mappings')` or
 * `.from('field_acknowledgments')` outside of comments.
 *
 * Comments and jsdoc blocks ARE permitted to name these tables in
 * documentation (e.g. retirement notes, rewrite narratives). The
 * check strips all comments before grepping so such narrative is not
 * flagged.
 *
 * Intentionally NOT scoped: tests/ and supabase/migrations/. Tests
 * reference the legacy names in assertion strings; migrations
 * reference them because they ran the rename. Both are out-of-band.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const SCAN_ROOTS = ['lib', 'app', 'components'] as const
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
])

// Enumerate all *.ts / *.tsx files under the given root (recursive).
function walkSourceFiles(root: string): string[] {
  const absRoot = resolve(REPO_ROOT, root)
  const out: string[] = []
  function recurse(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        recurse(full)
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(full)
      }
    }
  }
  recurse(absRoot)
  return out
}

// Strip block comments (/* … */) and line comments (// …). Deliberately
// naive — does not attempt to parse strings that contain comment-like
// substrings. That is acceptable here because we follow up with a
// narrow structural match against `.from('field_mappings')`, which
// cannot appear inside an arbitrary string unless deliberately so.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const LEGACY_TABLE_PATTERN =
  /\.from\s*\(\s*['"`](field_mappings|field_acknowledgments)['"`]\s*\)/g

describe('[codebase guard] no legacy-table .from() references', () => {
  // Build the file list ONCE at suite load — fast and predictable.
  const allFiles: string[] = []
  for (const root of SCAN_ROOTS) {
    allFiles.push(...walkSourceFiles(root))
  }

  it('walks a non-trivial file set (sanity — the walker isnt broken)', () => {
    // Lower-bound the scan so a silent walker regression cannot mask
    // a miss. lib/ alone has >100 .ts files in this repo; 50 is a
    // conservative floor.
    expect(allFiles.length).toBeGreaterThan(50)
  })

  it('covers the three files the superseded outputs-scoped test pinned', () => {
    // Regression guard: the deleted tests/outputs/no-legacy-table-refs.test.ts
    // hand-picked these three files. If a refactor moves or renames
    // any of them, this assertion fails BEFORE the superset coverage
    // silently drops one.
    const expected = [
      'lib/actions/outputs.ts',
      'lib/actions/execution-package.ts',
      'lib/quality/readiness-score.ts',
    ]
    for (const rel of expected) {
      const abs = resolve(REPO_ROOT, rel)
      expect(allFiles, `superset coverage missing ${rel}`).toContain(abs)
    }
  })

  it('contains zero .from("field_mappings" | "field_acknowledgments") references outside comments', () => {
    const violations: Array<{ file: string; match: string }> = []
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const matches = code.match(LEGACY_TABLE_PATTERN) ?? []
      for (const m of matches) {
        violations.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          match: m,
        })
      }
    }
    expect(
      violations,
      `Legacy-table references found:\n` +
        violations.map((v) => `  ${v.file}: ${v.match}`).join('\n'),
    ).toEqual([])
  })
})
