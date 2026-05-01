import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping-engine carve-out — redesign-UI layering guard.
// ─────────────────────────────────────────────────────────────────────────────
//
// Invariant under test
// --------------------
// Nothing under `app/app/projects/[projectId]/mapping/redesign/**` may
// import from the mapping engine (`@/lib/ai/mapping-engine`) directly.
//
// The engine is auth-bypassed: it exports pure logic and a 4-round read
// path that takes a Supabase client as a parameter. UI must go through
// the server-action wrappers in `lib/actions/mappings-for-redesign.ts`,
// which gate every entry on `requireProjectPermission` (or `createClient`
// for read paths) before delegating to the engine.
//
// A direct UI → engine import would silently bypass auth and RLS context
// management, which is exactly the boundary the action layer protects.
//
// Companion guard:
//   • tests/lib/no-shim-in-redesign-path.test.ts — forbids legacy shim
//     imports under the same scan root. Style-matched here.

const REPO_ROOT = resolve(__dirname, '../..')

const SCAN_ROOT = 'app/app/projects/[projectId]/mapping/redesign'

const SKIP_DIRS = new Set(['node_modules', '.next', '.git'])

// Forbidden import specifier. Any import statement that references this
// token under SCAN_ROOT is a violation.
const FORBIDDEN_SPECIFIER = '@/lib/ai/mapping-engine'

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

describe('[redesign guard] no mapping-engine imports in the redesign UI path', () => {
  const files = walkSourceFiles(SCAN_ROOT)

  it('walker picks up the redesign placeholder (sanity)', () => {
    expect(files.length).toBeGreaterThanOrEqual(1)
    const rels = files.map((f) => f.replace(REPO_ROOT + '/', ''))
    expect(rels).toEqual(
      expect.arrayContaining([
        'app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx',
      ]),
    )
  })

  it('contains zero imports from the mapping engine', () => {
    const violations: Array<{ file: string; line: string }> = []
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      // `from '<token>'` or `from "<token>"` or dynamic import('…')
      const pattern = new RegExp(
        `(?:from|import)\\s*\\(?\\s*['"\`]${escapeRegex(FORBIDDEN_SPECIFIER)}['"\`]`,
        'g',
      )
      const matches = code.match(pattern) ?? []
      for (const m of matches) {
        violations.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          line: m,
        })
      }
    }
    expect(
      violations,
      `Forbidden mapping-engine imports found in the redesign UI path:\n` +
        violations.map((v) => `  ${v.file}: ${v.line}`).join('\n') +
        `\n\nThe engine is auth-bypassed; UI must go through ` +
        `lib/actions/mappings-for-redesign.ts which gates auth and RLS context.`,
    ).toEqual([])
  })
})

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
