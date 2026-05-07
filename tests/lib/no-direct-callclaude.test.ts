import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0b PR 7 — direct-Anthropic-SDK-call guard.
// ─────────────────────────────────────────────────────────────────────────────
//
// Invariant under test
// --------------------
// After PR 7, every Anthropic API call in the codebase MUST go through
// `lib/ai/llm-client.ts` so it gets logged to `public.llm_calls`.
//
// This test forbids three patterns under `lib/`, `app/`, and
// `components/` (production code only — tests are exempt):
//
//   1. Importing from `@/lib/ai/claude` (the file is deleted; any
//      remaining import is dead and should be cleaned up)
//   2. Calling `anthropic.messages.create(...)` or
//      `anthropic.messages.stream(...)` directly (bypasses logging)
//   3. Importing `Anthropic` from `@anthropic-ai/sdk` outside the
//      single allowed file (`lib/ai/llm-client.ts`)
//
// If a test file ever needs to mock the SDK, it can still do so via
// `vi.mock('@anthropic-ai/sdk', ...)` — the test directory is excluded
// from the scan.
//
// Companion guards:
//   • tests/lib/no-shim-in-redesign-path.test.ts
//   • tests/lib/no-engine-in-redesign-ui.test.ts

const REPO_ROOT = resolve(__dirname, '../..')

const SCAN_ROOTS = ['lib', 'app', 'components']

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '__tests__',
  'tests',
])

const ALLOWED_FILES_FOR_SDK_IMPORT = new Set([
  // The single legitimate consumer of the Anthropic SDK
  'lib/ai/llm-client.ts',
  // Path D orchestrator (Sub-PR 4b). The shared `callLLMStreaming` wrapper
  // blocks on `await stream.finalMessage()` and cannot expose mid-stream
  // chunks for cost-ceiling abort. Path D iterates raw events so it can
  // call `stream.controller.abort()` when cumulative output cost exceeds
  // PER_PROJECT_MAX_COST_USD. The orchestrator writes its OWN llm_calls
  // row via `writePathDLlmCallLog` (carrying `pathDExperimentMetadata`),
  // so the audit-trail invariant ("every AI call must log to llm_calls")
  // is satisfied. Phase C may extract a shared streaming-with-abort
  // helper into llm-client.ts; until then this is the second legitimate
  // SDK consumer.
  'lib/ai/path-d-mapping.ts',
])

function walkSourceFiles(roots: string[]): string[] {
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
      if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
      if (name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        recurse(full)
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(full)
      }
    }
  }
  for (const root of roots) {
    recurse(resolve(REPO_ROOT, root))
  }
  return out
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('[no direct Anthropic SDK calls] every AI call must go through callLLM', () => {
  const files = walkSourceFiles(SCAN_ROOTS)

  it('walker picks up production files (sanity)', () => {
    expect(files.length).toBeGreaterThan(50)
    const rels = files.map((f) => f.replace(REPO_ROOT + '/', ''))
    expect(rels).toContain('lib/ai/llm-client.ts')
    expect(rels).toContain('lib/ai/mapping-engine.ts')
  })

  it('no production file imports from @/lib/ai/claude (file is deleted)', () => {
    const violations: Array<{ file: string; line: string }> = []
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const pattern = /(?:from|import)\s*\(?\s*['"`]@\/lib\/ai\/claude['"`]/g
      const matches = code.match(pattern) ?? []
      for (const m of matches) {
        violations.push({ file: abs.replace(REPO_ROOT + '/', ''), line: m })
      }
    }
    expect(
      violations,
      `Imports of @/lib/ai/claude found in production code:\n` +
        violations.map((v) => `  ${v.file}: ${v.line}`).join('\n') +
        `\n\nlib/ai/claude.ts was deleted in PR 7. Use callLLM from lib/ai/llm-client.ts instead.`,
    ).toEqual([])
  })

  it('no production file calls anthropic.messages.create or .stream outside lib/ai/llm-client.ts', () => {
    const violations: Array<{ file: string; pattern: string }> = []
    for (const abs of files) {
      const rel = abs.replace(REPO_ROOT + '/', '')
      if (ALLOWED_FILES_FOR_SDK_IMPORT.has(rel)) continue
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const pattern = /\.messages\.(create|stream)\s*\(/g
      const matches = code.match(pattern) ?? []
      for (const m of matches) {
        violations.push({ file: rel, pattern: m })
      }
    }
    expect(
      violations,
      `Direct Anthropic SDK calls found outside lib/ai/llm-client.ts:\n` +
        violations.map((v) => `  ${v.file}: ${v.pattern}`).join('\n') +
        `\n\nEvery AI call must go through callLLM/callLLMStreaming so it logs to llm_calls.`,
    ).toEqual([])
  })

  it('no production file imports the Anthropic SDK directly outside lib/ai/llm-client.ts', () => {
    const violations: Array<{ file: string; line: string }> = []
    for (const abs of files) {
      const rel = abs.replace(REPO_ROOT + '/', '')
      if (ALLOWED_FILES_FOR_SDK_IMPORT.has(rel)) continue
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const pattern = /(?:from|import)\s*\(?\s*['"`]@anthropic-ai\/sdk['"`]/g
      const matches = code.match(pattern) ?? []
      for (const m of matches) {
        violations.push({ file: rel, line: m })
      }
    }
    expect(
      violations,
      `Direct @anthropic-ai/sdk imports found outside lib/ai/llm-client.ts:\n` +
        violations.map((v) => `  ${v.file}: ${v.line}`).join('\n'),
    ).toEqual([])
  })
})
