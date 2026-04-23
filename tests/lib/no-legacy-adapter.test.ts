/**
 * Codebase-wide guard against the retired legacy-adapter surface
 * (Prompt 3d, Step 3D-13, Gate 2 §3.2).
 *
 * Prompt 3d Step 3D-12 deleted:
 *   - `toLegacyTransformation` adapter (lib/actions/transformations.ts)
 *   - `export interface Transformation` (lib/types/database.ts)
 *
 * Migration 074 dropped the `transformations.field_mapping_id` column
 * in favor of `target_field_mapping_id`. Any `.from('transformations')`
 * chain that selects or filters on the old column name will fail at
 * runtime with a PostgREST column-not-found error (this is exactly
 * the latent bug uncovered in `TransformContent.tsx:1607` during
 * Step 3D-12; see `docs/prompt-3a-remaining-work.md :: Bugs fixed in
 * Phase 2`).
 *
 * This test enforces two invariants codebase-wide (lib/, app/,
 * components/):
 *
 *   1. Zero runtime references to the retired adapter symbol
 *      `toLegacyTransformation`. Comments that narrate its deletion
 *      are permitted (strip-before-grep).
 *
 *   2. No `.from('transformations')` chain mentions the dropped
 *      column identifier `field_mapping_id`. Activity-log metadata
 *      payloads that happen to use `field_mapping_id` as a jsonb key
 *      (e.g. in `logActivity({ field_mapping_id: tfmId })`) are NOT
 *      flagged — the test looks specifically at `.from('transformations')`
 *      CHAINS, not every occurrence of the string.
 *
 * Intentionally NOT scoped: tests/ and supabase/migrations/. Tests
 * reference the adapter name in assertion strings; migrations
 * reference the column because they ran the rename. Both are
 * out-of-band.
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

/**
 * Extract the "chain body" that follows a `.from('transformations')`
 * call — i.e. everything from the `.from(` token up to the end of
 * the enclosing statement (`;`, `}`, or two consecutive newlines).
 * Returns the start index (for error reporting) and the extracted
 * chain text.
 *
 * Runs on comment-stripped source; bounds are deliberately generous
 * (1200 chars) to capture multi-line `.select(…).eq(…).in(…)` chains.
 */
function extractTransformationChains(
  code: string,
): Array<{ start: number; body: string }> {
  const re = /\.from\s*\(\s*['"`]transformations['"`]\s*\)/g
  const out: Array<{ start: number; body: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const start = m.index
    const tail = code.slice(start, start + 1200)
    // Trim at the first statement terminator. Statement boundaries
    // inside Supabase chains are the semicolon closing the `await
    // supabase.from(…).select(…)` expression or (rarely) a closing
    // brace on the same line — neither overlaps with chained .select /
    // .eq / .in / .order / .maybeSingle tokens.
    const terminator = tail.search(/(;|\n\s*\n)/)
    const body = terminator >= 0 ? tail.slice(0, terminator) : tail
    out.push({ start, body })
  }
  return out
}

describe('[codebase guard] no legacy-adapter references', () => {
  const allFiles: string[] = []
  for (const root of SCAN_ROOTS) {
    allFiles.push(...walkSourceFiles(root))
  }

  it('walks a non-trivial file set (sanity — the walker isnt broken)', () => {
    expect(allFiles.length).toBeGreaterThan(50)
  })

  it('contains zero runtime references to toLegacyTransformation (comments permitted)', () => {
    const violations: Array<{ file: string; hits: number }> = []
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const hits = (code.match(/\btoLegacyTransformation\b/g) ?? []).length
      if (hits > 0) {
        violations.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          hits,
        })
      }
    }
    expect(
      violations,
      `toLegacyTransformation references found (outside comments):\n` +
        violations.map((v) => `  ${v.file}: ${v.hits} hit(s)`).join('\n'),
    ).toEqual([])
  })

  it('contains zero .from("transformations") chains that mention field_mapping_id', () => {
    const violations: Array<{ file: string; snippet: string }> = []
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const chains = extractTransformationChains(code)
      for (const { body } of chains) {
        // Negative-lookbehind on `target_` eliminates the valid
        // `target_field_mapping_id` spelling.
        if (/(?<!target_)field_mapping_id/.test(body)) {
          violations.push({
            file: abs.replace(REPO_ROOT + '/', ''),
            snippet: body.slice(0, 200).replace(/\s+/g, ' '),
          })
        }
      }
    }
    expect(
      violations,
      `Legacy transformations.field_mapping_id column references found:\n` +
        violations.map((v) => `  ${v.file}: ${v.snippet}`).join('\n'),
    ).toEqual([])
  })

  it('scans more than zero .from("transformations") chains (sanity — the extractor isnt broken)', () => {
    let total = 0
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      total += extractTransformationChains(code).length
    }
    // Conservative floor: there are known callers in
    // lib/actions/transformations.ts, migration-intelligence.ts,
    // migration-runbook.ts, projects.ts, staging.ts,
    // validation-rules.ts, readiness-score.ts, etc. Five is a safe
    // lower bound that still catches an extractor regression.
    expect(total).toBeGreaterThan(5)
  })

  it('allows the activity_log jsonb payload key field_mapping_id (NOT a .from(transformations) ref)', () => {
    // Regression sentinel: `lib/actions/transformations.ts::applyTransform`
    // writes `{ field_mapping_id: ctx.tfm.id }` into the
    // activity_log.metadata jsonb blob. That key is a free-form
    // metadata label (external analytics callers still read it by
    // that name) and must NOT be flagged by the chain scanner.
    const abs = resolve(REPO_ROOT, 'lib/actions/transformations.ts')
    const raw = readFileSync(abs, 'utf-8')
    const code = stripComments(raw)

    // The jsonb key exists in the source …
    expect(code).toMatch(/field_mapping_id:\s*ctx\.tfm\.id/)

    // … and it appears inside a logActivity call, NOT inside any
    // `.from('transformations')` chain body. Programmatic check:
    const chains = extractTransformationChains(code)
    const insideChain = chains.some((c) =>
      /(?<!target_)field_mapping_id/.test(c.body),
    )
    expect(insideChain).toBe(false)
  })
})
