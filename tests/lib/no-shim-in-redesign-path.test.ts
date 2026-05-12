import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 4b — redesign-path shim guard.
// ─────────────────────────────────────────────────────────────────────────────
//
// Invariant under test
// --------------------
// Nothing under `app/app/projects/[projectId]/mapping/redesign/**` may
// import from the legacy mapping shim (`@/lib/compat/mapping-shim`) OR
// the legacy UI types re-exported from `@/lib/actions/mappings`
// (`MappingsResult`, `RichFieldMapping`, `RichTableMapping`, etc.).
//
// The redesign tree is the canonical Phase 3+ home — it MUST consume the
// new `MappingsForRedesignResult` contract directly. Any stray shim
// import means we're silently poisoning the new code path with the
// legacy data shape and losing the invariant that lets Phase 5 delete
// the shim in one shot.
//
// Companion tests:
//   • tests/lib/url-params-guard.test.ts — URL-param back-compat guard
//     (Gap 15). Style-matched here.
//   • tests/compat/mapping-shim.test.ts — verifies the shim itself
//     is still correct; unrelated invariant.

const REPO_ROOT = resolve(__dirname, '../..')

const SCAN_ROOT = 'app/app/projects/[projectId]/mapping/redesign'

const SKIP_DIRS = new Set(['node_modules', '.next', '.git'])

// Forbidden import specifiers. Any import statement that references
// ANY of these tokens under SCAN_ROOT is a violation.
const FORBIDDEN_SPECIFIERS: Array<{ token: string; rationale: string }> = [
  {
    token: '@/lib/compat/mapping-shim',
    rationale:
      'Legacy shim. Redesign consumes MappingsForRedesignResult directly.',
  },
  {
    token: '@/lib/actions/mappings',
    rationale:
      'Legacy server actions module. Redesign uses @/lib/actions/mappings-for-redesign.',
  },
]

// Forbidden legacy UI types. Even if imported from the types module,
// the redesign tree must not reference them — the new contract is
// the canonical shape.
const FORBIDDEN_LEGACY_TYPES: string[] = [
  'MappingsResult',
  'RichFieldMapping',
  'RichTableMapping',
  'UnmappedField',
  'FieldAcknowledgmentRow',
]

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

describe('[redesign guard] no legacy shim or UI types in the redesign path', () => {
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

  it('contains zero imports from forbidden specifiers', () => {
    const violations: Array<{ file: string; token: string; line: string }> = []
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      for (const { token } of FORBIDDEN_SPECIFIERS) {
        // `from '<token>'` or `from "<token>"` or dynamic import('…')
        const pattern = new RegExp(
          `(?:from|import)\\s*\\(?\\s*['"\`]${escapeRegex(token)}['"\`]`,
          'g',
        )
        const matches = code.match(pattern) ?? []
        for (const m of matches) {
          violations.push({
            file: abs.replace(REPO_ROOT + '/', ''),
            token,
            line: m,
          })
        }
      }
    }
    expect(
      violations,
      `Forbidden shim/legacy imports found in redesign path:\n` +
        violations.map((v) => `  ${v.file}: ${v.line}`).join('\n'),
    ).toEqual([])
  })

  it('contains zero references to forbidden legacy UI type names', () => {
    const violations: Array<{ file: string; token: string }> = []
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      for (const token of FORBIDDEN_LEGACY_TYPES) {
        // Word-boundary match so e.g. "MappingsResult" does not collide
        // with "MappingsForRedesignResult".
        const pattern = new RegExp(`\\b${escapeRegex(token)}\\b`, 'g')
        if (pattern.test(code)) {
          violations.push({
            file: abs.replace(REPO_ROOT + '/', ''),
            token,
          })
        }
      }
    }
    expect(
      violations,
      `Forbidden legacy-type references found in redesign path:\n` +
        violations.map((v) => `  ${v.file}: ${v.token}`).join('\n'),
    ).toEqual([])
  })

  it('positive-control: the new MappingsForRedesignResult contract IS referenced (regression guard)', () => {
    // If a refactor accidentally removes every reference to the new
    // contract, the two negative assertions would still pass. This
    // positive control ensures the redesign tree actually consumes
    // the new shape.
    let found = false
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      if (/\bMappingsForRedesignResult\b/.test(code)) {
        found = true
        break
      }
    }
    expect(
      found,
      'MappingsForRedesignResult is not referenced anywhere under the redesign path — data contract is not wired in.',
    ).toBe(true)
  })

  // ─── Gap 3 — no client-side .sort() on rows ────────────────────────────────
  //
  // Design §4 / §5 pin the contract: the SERVER guarantees row order
  // `(targetTable.name ASC, targetField.ordinalPosition ASC, targetField.name
  // ASC)` and consumers MUST NOT re-sort. Any `.sort(` call under the
  // redesign path is a contract violation — either the client is second-
  // guessing server order, or the filter pipeline grew a re-sort step that
  // would silently desync from the server contract.
  //
  // False positives to watch for:
  //   • `Array.prototype.toSorted` — allowed (non-mutating; still a re-sort
  //     of a local snapshot). This guard catches both `.sort(` and
  //     `.toSorted(` so we stay conservative. If a legitimate need emerges,
  //     update the rationale here instead of silently silencing.
  //   • String methods like `.sortBy` — out of scope; regex is word-anchored
  //     on `.sort(` exactly.
  it('contains no client-side .sort() or .toSorted() on rows', () => {
    const violations: Array<{ file: string; snippet: string }> = []
    // Allowlist — files under the redesign path that legitimately sort
    // a non-rows local structure. Each entry MUST carry a documented
    // rationale below; do NOT add a file here just to silence the guard.
    //
    //   • `MappingListView.tsx` — Mapping list view (flat spreadsheet)
    //     exposes user-controlled column-header sort, per the Big-4
    //     audit workflow. The `.sort()` call operates on a derived
    //     groups array built from the already-sorted server rows —
    //     ordering is a user-facing UI concern, NOT a re-derivation of
    //     server contract. Target-led view (which IS server-ordered)
    //     continues to be checked by this guard.
    const SORT_ALLOWED_FILES = new Set<string>([
      'app/app/projects/[projectId]/mapping/redesign/components/MappingListView.tsx',
    ])
    for (const abs of files) {
      const relPath = abs.replace(REPO_ROOT + '/', '')
      if (SORT_ALLOWED_FILES.has(relPath)) continue
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      // Match `.sort(` or `.toSorted(` as a method call. We intentionally
      // ignore prefix context (any variable name) — the redesign path is
      // small enough that a bare client-side `.sort(` is always a
      // contract concern worth flagging. If a utility helper ever legit-
      // imately sorts a non-rows array under this path, relax the guard
      // by adding the file to `SORT_ALLOWED_FILES` above with a
      // documented rationale.
      const pattern = /\.(?:sort|toSorted)\s*\(/g
      const matches = code.match(pattern) ?? []
      for (const m of matches) {
        violations.push({
          file: relPath,
          snippet: m,
        })
      }
    }
    expect(
      violations,
      `Client-side .sort() or .toSorted() call found under the redesign path:\n` +
        violations.map((v) => `  ${v.file}: ${v.snippet}`).join('\n') +
        `\n\nThe server guarantees row ordering; consumers must preserve it verbatim.` +
        `\nIf you have a legitimate non-rows sort, relax the guard in ` +
        `tests/lib/no-shim-in-redesign-path.test.ts and document the rationale.`,
    ).toEqual([])
  })

  // ─── Gap 5a hotfix — no Tailwind dark-prefix modifiers ─────────────────────
  //
  // Tailwind's default `darkMode` is `'media'` (see `tailwind.config.ts` —
  // no explicit key). Under `'media'`, every dark-prefix class fires
  // automatically when the user's OS reports `prefers-color-scheme: dark`,
  // without any `.dark` gate.
  //
  // The rest of the app does NOT support dark mode: legacy UI uses zero
  // dark-prefix modifiers, and redesign surfaces hardcode light-mode
  // backgrounds (`bg-white`, `bg-gray-50`) with no dark counterpart.
  //
  // Result of mixing: dark-prefix text classes (near-white) render over
  // hardcoded `bg-white` rows — near-white-on-white ghosted text. Gap 4c
  // introduced the regression; Gap 5a propagated it to more sites; the
  // 2026-04-23 smoke test surfaced it. This invariant prevents a repeat.
  //
  // If/when the app adopts dark mode app-wide, revisit this guard together
  // with every sibling light-only surface — not in isolation.
  //
  // Comments are stripped before the regex runs, so module-level
  // explanations of this invariant (which naturally reference the
  // forbidden token) do NOT trip the guard.
  it('contains no Tailwind dark-prefix class modifiers', () => {
    const violations: Array<{ file: string; snippet: string }> = []
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      // Match the literal dark-prefix token with a word character after
      // the colon — this catches dark:bg-*, dark:text-*, etc. but avoids
      // incidental substrings like `dark:` inside a URL or at end-of-line.
      const pattern = /\bdark:[a-z0-9_\-[\]/.]+/gi
      const matches = code.match(pattern) ?? []
      for (const m of matches) {
        violations.push({
          file: abs.replace(REPO_ROOT + '/', ''),
          snippet: m,
        })
      }
    }
    expect(
      violations,
      `Tailwind dark-prefix modifier found under the redesign path:\n` +
        violations.map((v) => `  ${v.file}: ${v.snippet}`).join('\n') +
        `\n\nThe surrounding redesign UI hardcodes light backgrounds; ` +
        `dark-prefix text classes produce ghosted text in OS dark mode.` +
        `\nIf the app adopts dark mode app-wide, revisit this guard holistically.`,
    ).toEqual([])
  })
})

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
