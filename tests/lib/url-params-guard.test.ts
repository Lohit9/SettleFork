import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 15 — URL-param back-compat guard.
// ─────────────────────────────────────────────────────────────────────────────
//
// Invariant under test
// --------------------
// No file under `app/app/projects/[projectId]/mapping/` or
// `app/app/projects/[projectId]/transform/` may WRITE the legacy
// `fieldMappingId=<value>` spelling into a URL. The canonical new-model
// spelling `targetFieldMappingId` is authoritative for every new writer; the
// legacy spelling is accepted on READ via
// `lib/url/transform-params.ts:readTargetFieldMappingIdFromSearchParams`
// during the Phase 3+4 lifecycle.
//
// The legacy fallback is scoped specifically to READ paths. READ call sites
// (e.g. `searchParams.get('fieldMappingId')`) are intentionally NOT flagged
// by this guard.
//
// Pattern
// -------
// We match URL-embedding shapes that can only appear inside a URL literal:
//
//   ?fieldMappingId=           — first param
//   &fieldMappingId=           — subsequent param
//   params.set('fieldMappingId', …)    — URLSearchParams builder
//   params.set("fieldMappingId", …)
//   params.append('fieldMappingId', …)
//   params.append("fieldMappingId", …)
//
// These are mutually exclusive with any read path, so no exception logic is
// needed for `*.get('fieldMappingId')`.
//
// Style-matched to `tests/lib/no-legacy-table-refs.test.ts` and
// `tests/actions/transforms-guard-sweep.test.ts` — source-text based,
// comment-stripped, walker-seed sanity-checked.

const REPO_ROOT = resolve(__dirname, '../..')

// Scoped: only the two legacy pages covered by Phase 3 Gap 15. The redesign
// subdirectory (`redesign/`) is allowed under the guard too — it is new code,
// so it should never emit the legacy spelling. Including it here doubles as
// forward-protection against a regression landing under redesign/.
const SCAN_ROOTS = [
  'app/app/projects/[projectId]/mapping',
  'app/app/projects/[projectId]/transform',
] as const

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
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

// Strip block comments (/* … */) and line comments (// …). Deliberately
// naive — matches the proven strip in `no-legacy-table-refs.test.ts`. The
// follow-up structural patterns cannot appear in arbitrary strings unless
// deliberately so.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// URL-literal writers: `?fieldMappingId=` or `&fieldMappingId=`.
const URL_LITERAL_PATTERN = /[?&]fieldMappingId=/g

// URLSearchParams builder writers.
const SEARCH_PARAMS_WRITE_PATTERN =
  /\.(?:set|append)\s*\(\s*['"`]fieldMappingId['"`]/g

describe('[url-params guard] no legacy fieldMappingId URL writers in mapping or transform pages', () => {
  const allFiles: string[] = []
  for (const root of SCAN_ROOTS) {
    allFiles.push(...walkSourceFiles(root))
  }

  it('walker picks up at least the two legacy page files (sanity)', () => {
    // If the walker silently returns nothing, a real violation could pass the
    // assertion below. Lower-bound it to guard that scenario.
    expect(allFiles.length).toBeGreaterThanOrEqual(2)
    const rels = allFiles.map((f) => f.replace(REPO_ROOT + '/', ''))
    expect(rels).toEqual(
      expect.arrayContaining([
        'app/app/projects/[projectId]/mapping/MappingContent.tsx',
        'app/app/projects/[projectId]/transform/TransformContent.tsx',
      ])
    )
  })

  it('contains zero URL-literal writers of ?fieldMappingId= or &fieldMappingId=', () => {
    const violations: Array<{ file: string; match: string }> = []
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const matches = code.match(URL_LITERAL_PATTERN) ?? []
      for (const m of matches) {
        violations.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          match: m,
        })
      }
    }
    expect(
      violations,
      `Legacy URL writers found (use targetFieldMappingId instead):\n` +
        violations.map((v) => `  ${v.file}: ${v.match}`).join('\n'),
    ).toEqual([])
  })

  it('contains zero URLSearchParams builder writers of fieldMappingId', () => {
    const violations: Array<{ file: string; match: string }> = []
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const matches = code.match(SEARCH_PARAMS_WRITE_PATTERN) ?? []
      for (const m of matches) {
        violations.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          match: m,
        })
      }
    }
    expect(
      violations,
      `Legacy URLSearchParams writers found (use targetFieldMappingId instead):\n` +
        violations.map((v) => `  ${v.file}: ${v.match}`).join('\n'),
    ).toEqual([])
  })

  it('the new targetFieldMappingId spelling IS present (positive-control sanity)', () => {
    // If a refactor accidentally deletes every writer altogether, the two
    // negative assertions above would still pass — a silent regression where
    // the deeplink breaks entirely. This positive-control ensures at least
    // one writer exists under the scanned scope.
    let found = false
    for (const abs of allFiles) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      if (/[?&]targetFieldMappingId=/.test(code)) {
        found = true
        break
      }
    }
    expect(
      found,
      'No targetFieldMappingId URL writer found under mapping/ or transform/ — deeplink is likely broken.',
    ).toBe(true)
  })
})
