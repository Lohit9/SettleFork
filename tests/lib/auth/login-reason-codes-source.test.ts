// @vitest-environment node
//
// Source-level invariant tests for `lib/auth/login-reason-codes.ts`.
//
// Pins the bidirectional invariant between the closed `ReasonCode`
// taxonomy and the emitter sites that append `?reason=…` / `?error=…`
// to `/login` redirects:
//
//   1. Every emitted code in the codebase must appear in
//      `LOGIN_REASONS`. If a future commit adds a new redirect with a
//      novel code (e.g., `/login?reason=sso_assertion_replay`) but
//      forgets to add a copy entry, this test fails — preventing the
//      "silently dropped reason code" regression that B-2-b fixed.
//
//   2. Every code in `LOGIN_REASONS` must be emitted from at least one
//      file. Catches dead entries — copy that no caller can ever
//      surface.
//
// Why source-level (not runtime / not module-import-driven): the same
// pattern as `tests/api/auth/callback-sso-source.test.ts` and
// `tests/sso/start-source.test.ts`. We want a regression in any
// emitter file (route, middleware, component) to fail this test
// without first touching the codes module — the test reads the source
// strings directly so refactoring the emitter does not silently drift.
//
// The hardcoded EXPECTED_EMITTED_CODES list mirrors the audit table
// from the B-2-b investigation report. If a future emitter introduces
// a new code, BOTH the regex scan AND the EXPECTED_EMITTED_CODES list
// catch it; the failure messages tell you exactly where to update.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOGIN_REASONS } from '@/lib/auth/login-reason-codes'

const REPO_ROOT = resolve(__dirname, '../../..')

// Files that emit /login redirects with `?reason=` or `?error=`. If
// you add a new emitter, add it here and the regex scan picks it up.
// Order matters only for diagnostic output.
const EMITTER_FILES = [
  'middleware.ts',
  'app/sso/start/route.ts',
  'app/api/auth/callback/route.ts',
  'components/app/SidebarShell.tsx',
] as const

// Allow-list of codes the team has explicitly catalogued. Mirrors the
// PART E table from the B-2-b investigation report. Must equal
// `Object.keys(LOGIN_REASONS)` exactly — no extras, no omissions.
const EXPECTED_EMITTED_CODES = [
  'timeout',
  'sso_required',
  'sso_bad_request',
  'sso_rate_limited',
  'sso_unavailable',
  'sso_unknown_org',
  'sso_not_configured',
  'sso_callback_error',
  'sso_attempted_org_missing',
  'sso_cross_tenant',
  'sso_domain_mismatch',
  'sso_duplicate_account',
  'sso_jit_failed',
  'auth_callback_error',
] as const

// THREE distinct emitter patterns the scanner must catch:
//
//   1. URL-literal:                 new URL('/login?reason=sso_unavailable', ...)
//      Used by:                     app/sso/start/route.ts (every redirect)
//
//   2. searchParams.set:            url.searchParams.set('reason', 'sso_required')
//      Used by:                     middleware.ts:100
//
//   3. failAndAbort positional:     failAndAbort('label', {...}, 'code', orgId)
//                                   ^ 3rd positional arg is the redirect-reason code
//      Used by:                     app/api/auth/callback/route.ts:144 (via the
//                                   `failAndAbort` helper that interpolates
//                                   `?reason=${redirectReason}`)
//
// All three regexes scan the same files; a code that surfaces in any
// of them counts as "emitted". Code chars: alphanumerics + underscore,
// the slug shape used by every emitter today.
const DIRECT_LITERAL_RE =
  /[?&](?:reason|error)=([a-z0-9_]+)/g

const SEARCH_PARAMS_SET_RE =
  /searchParams\.set\(\s*['"](?:reason|error)['"]\s*,\s*['"]([a-z0-9_]+)['"]\s*\)/g

// Calls of the form: failAndAbort('reason_label', { ... }, 'code', orgId)
// The third positional argument (after the metadata object) is the
// redirect-reason code that ends up in `?reason=…`. We don't depend on
// arg names — just position.
//
// A more robust approach would be a TS AST walk, but at the scale of
// one file with ~10 calls this regex is sufficient and keeps the test
// dependency-free.
const FAIL_AND_ABORT_RE =
  /failAndAbort\(\s*['"][a-z0-9_]+['"]\s*,\s*\{[\s\S]*?\}\s*,\s*['"]([a-z0-9_]+)['"]/g

function readEmitter(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
}

function extractCodes(): { codes: Set<string>; perFile: Record<string, Set<string>> } {
  const codes = new Set<string>()
  const perFile: Record<string, Set<string>> = {}

  for (const rel of EMITTER_FILES) {
    const src = readEmitter(rel)
    const fileCodes = new Set<string>()

    for (const m of src.matchAll(DIRECT_LITERAL_RE)) {
      fileCodes.add(m[1])
    }
    for (const m of src.matchAll(SEARCH_PARAMS_SET_RE)) {
      fileCodes.add(m[1])
    }
    for (const m of src.matchAll(FAIL_AND_ABORT_RE)) {
      fileCodes.add(m[1])
    }

    perFile[rel] = fileCodes
    for (const c of fileCodes) codes.add(c)
  }

  return { codes, perFile }
}

// ─────────────────────────────────────────────────────────────────────
// LOGIN_REASONS module shape
// ─────────────────────────────────────────────────────────────────────

describe('[login-reason-codes / module] taxonomy invariants', () => {
  it('LOGIN_REASONS keys match EXPECTED_EMITTED_CODES exactly', () => {
    const moduleKeys = Object.keys(LOGIN_REASONS).sort()
    const expected = [...EXPECTED_EMITTED_CODES].sort()
    expect(moduleKeys).toEqual(expected)
  })

  it('every entry has non-empty copy and a valid severity', () => {
    for (const [code, entry] of Object.entries(LOGIN_REASONS)) {
      expect(entry.copy, `${code} copy must be a non-empty string`).toMatch(/\S/)
      expect(['info', 'error']).toContain(entry.severity)
    }
  })

  it('copy strings end with a period (UI consistency)', () => {
    // The reason banner is a single sentence. Trailing periods are a
    // UI consistency rule — strict-typed copy gives reviewers a tiny
    // signal that a string is "done" rather than mid-edit.
    for (const [code, entry] of Object.entries(LOGIN_REASONS)) {
      expect(
        entry.copy.endsWith('.'),
        `copy for ${code} should end with '.': "${entry.copy}"`,
      ).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Source-level emitter scan
// ─────────────────────────────────────────────────────────────────────

describe('[login-reason-codes / emitters] every emitted code has a copy entry', () => {
  it('regex scan finds at least one emitted code per non-component file', () => {
    // SidebarShell.tsx emits `timeout`; the route + middleware files
    // emit several. Sanity check that the scanner is not silently
    // returning empty.
    const { perFile } = extractCodes()
    for (const file of EMITTER_FILES) {
      expect(
        perFile[file].size,
        `expected ${file} to emit at least one reason code`,
      ).toBeGreaterThan(0)
    }
  })

  it('every code emitted in source code is a key of LOGIN_REASONS', () => {
    const { codes, perFile } = extractCodes()
    const moduleKeys = new Set(Object.keys(LOGIN_REASONS))

    const orphans: Array<{ code: string; files: string[] }> = []
    for (const code of codes) {
      if (!moduleKeys.has(code)) {
        const files = EMITTER_FILES.filter((f) => perFile[f].has(code))
        orphans.push({ code, files })
      }
    }

    expect(
      orphans,
      `These reason codes are emitted but missing from LOGIN_REASONS:\n` +
        orphans
          .map((o) => `  - "${o.code}" (in ${o.files.join(', ')})`)
          .join('\n') +
        `\n\nAdd them to lib/auth/login-reason-codes.ts.`,
    ).toEqual([])
  })

  it('every code in LOGIN_REASONS is emitted from at least one file', () => {
    const { codes } = extractCodes()
    const dead: string[] = []
    for (const code of Object.keys(LOGIN_REASONS)) {
      if (!codes.has(code)) {
        dead.push(code)
      }
    }
    expect(
      dead,
      `These reason codes have copy but no emitter — dead entries:\n` +
        dead.map((c) => `  - "${c}"`).join('\n') +
        `\n\nEither remove from lib/auth/login-reason-codes.ts or add an emitter.`,
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Hardcoded allow-list cross-check (catches scanner false negatives)
// ─────────────────────────────────────────────────────────────────────

describe('[login-reason-codes / allow-list] EXPECTED_EMITTED_CODES is in sync', () => {
  it('every EXPECTED_EMITTED_CODES entry is found by the source scanner', () => {
    const { codes } = extractCodes()
    const missing = EXPECTED_EMITTED_CODES.filter((c) => !codes.has(c))
    expect(
      missing,
      `These codes are in EXPECTED_EMITTED_CODES but the scanner did not find them.\n` +
        `Either the scanner regex is broken, or the emitter was removed without\n` +
        `updating EXPECTED_EMITTED_CODES.\n\n  Missing: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('every EXPECTED_EMITTED_CODES entry has a copy entry in LOGIN_REASONS', () => {
    const moduleKeys = new Set(Object.keys(LOGIN_REASONS))
    const missing = EXPECTED_EMITTED_CODES.filter((c) => !moduleKeys.has(c))
    expect(missing).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────
// getReasonCopy behavior
// ─────────────────────────────────────────────────────────────────────

describe('[login-reason-codes / getReasonCopy] lookup behavior', () => {
  it('returns null for null input', async () => {
    const { getReasonCopy } = await import('@/lib/auth/login-reason-codes')
    expect(getReasonCopy(null)).toBeNull()
  })

  it('returns null for undefined input', async () => {
    const { getReasonCopy } = await import('@/lib/auth/login-reason-codes')
    expect(getReasonCopy(undefined)).toBeNull()
  })

  it('returns null for empty string', async () => {
    const { getReasonCopy } = await import('@/lib/auth/login-reason-codes')
    expect(getReasonCopy('')).toBeNull()
  })

  it('returns null for an unknown code (silent ignore — security)', async () => {
    const { getReasonCopy } = await import('@/lib/auth/login-reason-codes')
    expect(getReasonCopy('definitely_not_a_real_code')).toBeNull()
  })

  it('returns the entry for a known code', async () => {
    const { getReasonCopy } = await import('@/lib/auth/login-reason-codes')
    const entry = getReasonCopy('sso_required')
    expect(entry).not.toBeNull()
    expect(entry!.copy).toMatch(/single sign-on/i)
    expect(entry!.severity).toBe('info')
  })

  it('does not return a value for the prototype-pollution probes (__proto__, constructor)', async () => {
    const { getReasonCopy } = await import('@/lib/auth/login-reason-codes')
    expect(getReasonCopy('__proto__')).toBeNull()
    expect(getReasonCopy('constructor')).toBeNull()
    expect(getReasonCopy('toString')).toBeNull()
  })
})
