// @vitest-environment node
//
// Source-level invariants for the CSV direct-to-Supabase-Storage upload
// refactor. Pins the structural commitment that:
//   (a) the new two-action API exists (getCsvUploadSlot + processUploadedCsv)
//   (b) the legacy uploadCSV is gone (clean break, not a fallback)
//   (c) the signed-URL flow targets the correct bucket + path convention
//   (d) the synchronous data_rows → field_profiles ordering is preserved
//       (PR 3.3 / PR 3.4b coupling — A's Touchpoint 2)
//
// Invariants:
//   CSV1.  lib/actions/csv.ts exports getCsvUploadSlot.
//   CSV2.  lib/actions/csv.ts exports processUploadedCsv.
//   CSV3.  lib/actions/csv.ts does NOT export uploadCSV (clean removal).
//   CSV4.  getCsvUploadSlot calls supabase.storage.from('project-files')
//          .createSignedUploadUrl.
//   CSV5.  processUploadedCsv calls supabase.storage.from('project-files')
//          .download (reads the uploaded file from Storage).
//   CSV6.  processUploadedCsv preserves the synchronous order:
//          data_rows.insert → compute profiles → field_profiles.insert
//          (regex pin on source order — PR 3.3 / PR 3.4b depend on
//          field_profiles existing as soon as the action returns success).
//   CSV7.  getCsvUploadSlot uses the 'pending/' subprefix in storagePath
//          so post-processing move + cron cleanup can distinguish
//          in-flight from settled uploads.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const SRC = readFileSync(resolve(ROOT, 'lib/actions/csv.ts'), 'utf8')

// Slice each function body so we can pin per-function ordering without
// false positives from the other function or top-level helpers. Same
// pattern as tests/components/decisions-log-identity.test.ts and
// tests/components/reject-no-flash.test.ts.
function sliceFunction(source: string, declStart: string): string {
  const a = source.indexOf(declStart)
  if (a < 0) throw new Error(`function declaration not found: ${declStart}`)
  // Each top-level function ends before the next `export ` declaration
  // OR the start of the helpers section. Scan forward to the next top-
  // level closing brace at column 0 followed by a blank line + a top-
  // level construct.
  const end = source.indexOf('\n}\n', a + declStart.length)
  if (end < 0) return source.slice(a)
  return source.slice(a, end + 2) // include the closing `}\n`
}

describe('[csv direct-to-storage] CSV1-CSV7 source-level invariants', () => {
  it('CSV1: lib/actions/csv.ts exports getCsvUploadSlot', () => {
    expect(SRC).toMatch(/export\s+async\s+function\s+getCsvUploadSlot\b/)
  })

  it('CSV2: lib/actions/csv.ts exports processUploadedCsv', () => {
    expect(SRC).toMatch(/export\s+async\s+function\s+processUploadedCsv\b/)
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

  it("CSV5: processUploadedCsv calls supabase.storage.from('project-files').download", () => {
    const fn = sliceFunction(SRC, 'export async function processUploadedCsv')
    expect(fn).toMatch(
      /supabase\.storage\s*\.from\(\s*['"]project-files['"]\s*\)\s*\.download/,
    )
  })

  it('CSV6: processUploadedCsv preserves data_rows.insert → field_profiles.insert order (synchronous contract — PR 3.3 / PR 3.4b)', () => {
    const fn = sliceFunction(SRC, 'export async function processUploadedCsv')
    // data_rows insert site
    const dataRowsIdx = fn.indexOf("from('data_rows').insert")
    // field_profiles insert site
    const profilesIdx = fn.indexOf("from('field_profiles').insert")
    expect(dataRowsIdx, 'data_rows.insert call missing').toBeGreaterThan(-1)
    expect(profilesIdx, 'field_profiles.insert call missing').toBeGreaterThan(-1)
    expect(
      dataRowsIdx,
      'data_rows must be inserted BEFORE field_profiles (synchronous contract for PR 3.3 + PR 3.4b)',
    ).toBeLessThan(profilesIdx)
  })

  it("CSV7: getCsvUploadSlot uses 'pending/' subprefix in storagePath", () => {
    const fn = sliceFunction(SRC, 'export async function getCsvUploadSlot')
    // The literal 'pending' must appear in the path-construction
    // template. We allow it as a constant or interpolated value, so
    // pin on either the literal 'pending/' subpath or a constant whose
    // declared value contains 'pending'.
    const hasInlinePending = /\$\{[^}]*PENDING[^}]*\}\/|\/['"]pending['"]\/|\/pending\//i.test(fn)
    const hasConstantPending =
      /const\s+PENDING_PREFIX\s*=\s*['"]pending['"]/.test(SRC) &&
      /PENDING_PREFIX/.test(fn)
    expect(
      hasInlinePending || hasConstantPending,
      "expected getCsvUploadSlot to compose storagePath with a 'pending' subprefix (literal or constant)",
    ).toBe(true)
  })
})
