// @vitest-environment node
//
// Source-level invariants for the CSV direct-to-Supabase-Storage upload
// flow. After the async-ingestion refactor, lib/actions/csv.ts owns ONLY
// the signed-URL slot (getCsvUploadSlot). The synchronous follow-up
// `processUploadedCsv` was removed; ingestion is now handled by the
// queueIngestionJob action + cron worker (see tests/actions/
// ingestion-jobs.test.ts for those invariants).
//
// Invariants:
//   CSV1.  lib/actions/csv.ts exports getCsvUploadSlot.
//   CSV3.  lib/actions/csv.ts does NOT export uploadCSV (clean removal).
//   CSV4.  getCsvUploadSlot calls supabase.storage.from('project-files')
//          .createSignedUploadUrl.
//   CSV7.  getCsvUploadSlot uses the 'pending/' subprefix in storagePath
//          so the cron worker (and a future cleanup cron) can distinguish
//          in-flight from settled uploads.
//   CSV8.  lib/actions/csv.ts does NOT export processUploadedCsv (clean
//          removal — the synchronous ingestion path is gone; replaced by
//          queueIngestionJob + cron worker).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const SRC = readFileSync(resolve(ROOT, 'lib/actions/csv.ts'), 'utf8')

// Slice each function body so we can pin per-function ordering without
// false positives from top-level helpers.
function sliceFunction(source: string, declStart: string): string {
  const a = source.indexOf(declStart)
  if (a < 0) throw new Error(`function declaration not found: ${declStart}`)
  const end = source.indexOf('\n}\n', a + declStart.length)
  if (end < 0) return source.slice(a)
  return source.slice(a, end + 2)
}

describe('[csv direct-to-storage] source-level invariants', () => {
  it('CSV1: lib/actions/csv.ts exports getCsvUploadSlot', () => {
    expect(SRC).toMatch(/export\s+async\s+function\s+getCsvUploadSlot\b/)
  })

  it('CSV3: lib/actions/csv.ts does NOT export uploadCSV (clean removal)', () => {
    expect(SRC).not.toMatch(/export\s+async\s+function\s+uploadCSV\b/)
    expect(SRC).not.toMatch(/export\s+async\s+function\s+uploadCsv\b/)
  })

  it("CSV4: getCsvUploadSlot calls supabase.storage.from('project-files').createSignedUploadUrl", () => {
    const fn = sliceFunction(SRC, 'export async function getCsvUploadSlot')
    expect(fn).toMatch(
      /supabase\.storage\s*\.from\(\s*['"]project-files['"]\s*\)\s*\.createSignedUploadUrl/,
    )
  })

  it("CSV7: getCsvUploadSlot uses 'pending/' subprefix in storagePath", () => {
    const fn = sliceFunction(SRC, 'export async function getCsvUploadSlot')
    const hasInlinePending = /\$\{[^}]*PENDING[^}]*\}\/|\/['"]pending['"]\/|\/pending\//i.test(fn)
    const hasConstantPending =
      /const\s+PENDING_PREFIX\s*=\s*['"]pending['"]/.test(SRC) &&
      /PENDING_PREFIX/.test(fn)
    expect(
      hasInlinePending || hasConstantPending,
      "expected getCsvUploadSlot to compose storagePath with a 'pending' subprefix (literal or constant)",
    ).toBe(true)
  })

  it('CSV8: lib/actions/csv.ts does NOT export processUploadedCsv (clean removal — async ingestion replaces it)', () => {
    expect(SRC).not.toMatch(/export\s+async\s+function\s+processUploadedCsv\b/)
  })
})
