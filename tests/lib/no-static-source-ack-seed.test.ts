/**
 * Codebase guard: the static-mappings provider does not auto-seed
 * `source_field_acknowledgments` rows.
 *
 * Background: the static-provider used to upsert a row into
 * `source_field_acknowledgments` for every "won't migrate" source
 * field in its config. Because migration 103 defaults `decision` to
 * `'acknowledged'` and the flat-view translator paints
 * `decision='acknowledged'` as the emerald "approved" status, every
 * seeded row showed up as a green-dot row at ingestion with no human
 * approval — violating the AI-proposes / human-approves contract.
 *
 * The fix removed both call sites of `persistSourceAcknowledgments`
 * from `lib/mappings/static-provider.ts`. This guard ensures the
 * helper is never re-introduced as a caller anywhere in the codebase
 * — if a future change wires it back in, this test fails loudly.
 *
 * Allowed: the function declaration itself (preserved so the rollback
 * cost is one line, not a re-author). Forbidden: any callable
 * reference outside the declaration.
 *
 * Scope: lib/, app/, components/. Tests/ and supabase/migrations/
 * are excluded — tests reference the symbol name in assertions
 * (including this file), migrations don't touch TypeScript.
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

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('[codebase guard] no static-provider source-ack auto-seed', () => {
  const allFiles: string[] = []
  for (const root of SCAN_ROOTS) {
    allFiles.push(...walkSourceFiles(root))
  }

  it('walks a non-trivial file set (sanity — the walker is not broken)', () => {
    expect(allFiles.length).toBeGreaterThan(50)
  })

  it('contains exactly one reference to persistSourceAcknowledgments — its declaration', () => {
    const hitsByFile: Array<{ file: string; total: number; declarations: number }> = []
    let grandTotal = 0
    let grandDeclarations = 0

    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const total = (code.match(/\bpersistSourceAcknowledgments\b/g) ?? []).length
      const declarations = (code.match(
        /\bfunction\s+persistSourceAcknowledgments\b/g,
      ) ?? []).length
      if (total > 0) {
        hitsByFile.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          total,
          declarations,
        })
        grandTotal += total
        grandDeclarations += declarations
      }
    }

    // Exactly one declaration site, and total references equal that one
    // declaration (no callers).
    expect(
      { grandTotal, grandDeclarations, hitsByFile },
      'expected persistSourceAcknowledgments to appear exactly once (its declaration) ' +
        'and zero times as a caller — if this fails, a call site has been re-introduced',
    ).toEqual({
      grandTotal: 1,
      grandDeclarations: 1,
      hitsByFile: [
        {
          file: 'lib/mappings/static-provider.ts',
          total: 1,
          declarations: 1,
        },
      ],
    })
  })
})
