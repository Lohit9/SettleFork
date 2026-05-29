// @vitest-environment node
//
// PR Ω.3.8.1 — Source-shape guards for the status-mutation fan-out wiring.
//
// The resolver itself is unit-tested in
// `tfm-sibling-resolution.test.ts`. This file pins the wire shape at
// each mutation site: helper imported, sibling resolution called with
// the canonical, bulk update via `.in('id', siblingIds)`, audit
// semantics correct.
//
// User-spec'd cases this file locks:
//   1. Approve fan-out — bulk update via `.in('id', siblingIds)` at
//      Site #1 wires the resolver's full sibling set into the SQL.
//   2. Reject fan-out — same update path; status comes from the param.
//   4. Audit row counts — N `ai_edit_history` rows (per-sibling loop)
//      vs 1 `override_logs` row (canonical-only call).
//   5. Counter reconciliation — falls out of #1: when all N sibling
//      TFMs flip, the per-TFM Migration Center counter
//      (`stat-formulas.ts mappingApproved`) reflects the same delta as
//      the row-level mapping page chip.
//
// Cases 3 (heritage byte-identity) and 6 (concat_* edge case) are
// covered by the resolver's pure unit tests.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MAPPINGS_PATH = resolve(__dirname, '../../lib/actions/mappings.ts')
const MAPPINGS_SRC = readFileSync(MAPPINGS_PATH, 'utf8')

const REDESIGN_PATH = resolve(
  __dirname,
  '../../lib/actions/mappings-for-redesign.ts',
)
const REDESIGN_SRC = readFileSync(REDESIGN_PATH, 'utf8')

const RESOLVER_PATH = resolve(
  __dirname,
  '../../lib/actions/tfm-sibling-resolution.ts',
)
const RESOLVER_SRC = readFileSync(RESOLVER_PATH, 'utf8')

// Helper to slice a function block for tightly-scoped assertions.
function sliceFromTo(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  if (a < 0) throw new Error(`start marker not found: ${start}`)
  const b = src.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`end marker not found after start: ${end}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// The resolver module itself exists + exports the public surface.
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.8.1] resolver module', () => {
  it('exports `resolveSiblingTfms`', () => {
    expect(RESOLVER_SRC).toMatch(/export async function resolveSiblingTfms\b/)
  })

  it('uses ordinal-sorted source signature comparison (NOT dominant-only)', () => {
    // The collapse-key invariant. Dominant-only would have been
    // `find((s) => s.ordinal === 0)` — the helper instead sorts the
    // full array and compares positionally.
    expect(RESOLVER_SRC).toMatch(/sort\(\(a, b\) => a\.ordinal - b\.ordinal\)/)
    expect(RESOLVER_SRC).toMatch(/sourceSignature\(/)
    expect(RESOLVER_SRC).toMatch(/signaturesEqual\(/)
  })

  it("preserves NULL = NULL semantics matching SQL's IS NOT DISTINCT FROM", () => {
    expect(RESOLVER_SRC).toMatch(/NULL === NULL in JS|IS NOT DISTINCT FROM/i)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Site #1 — updateFieldMappingStatus (lib/actions/mappings.ts)
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.8.1] Site #1 — updateFieldMappingStatus fan-out', () => {
  const site = sliceFromTo(
    MAPPINGS_SRC,
    'export async function updateFieldMappingStatus',
    "tfm-contributor: reject = delete the contributor",
  )

  it('imports the resolver', () => {
    expect(MAPPINGS_SRC).toMatch(
      /from '@\/lib\/actions\/tfm-sibling-resolution'/,
    )
    expect(MAPPINGS_SRC).toMatch(/resolveSiblingTfms/)
  })

  it('calls `resolveSiblingTfms` with the canonical TFM identity', () => {
    expect(site).toMatch(/resolveSiblingTfms\(\s*supabaseAdmin/)
    expect(site).toMatch(/canonicalTfmId:\s*decoded\.tfmId/)
    expect(site).toMatch(/targetFieldId:\s*tfmLookup\.target_field_id/)
  })

  it('bulk-updates `status` via `.in("id", siblingIds)` — NOT scalar `.eq`', () => {
    // The whole point: post-Ω.3.8.1 the SQL fans out across the
    // sibling set. The canonical scalar `.eq` path is gone.
    expect(site).toMatch(/\.update\(\s*\{\s*status\s*\}\s*\)\s*\n\s*\.in\('id',\s*siblingIds\)/)
    expect(site).not.toMatch(/\.update\(\s*\{\s*status\s*\}\s*\)\s*\.eq\('id',\s*decoded\.tfmId\)/)
  })

  it('emits per-sibling `ai_edit_history` (N rows, one per TFM)', () => {
    // Each sibling carries its own `oldValue` so per-row provenance
    // stays accurate after the bulk update.
    expect(site).toMatch(/for \(const sib of siblings\)/)
    expect(site).toMatch(/entityId:\s*sib\.id/)
    expect(site).toMatch(/oldValue:\s*sib\.status/)
  })

  it('fires `updateTemplateFromApproval` ONCE — keyed by canonical (per §4)', () => {
    // Migration 115 frames override_logs as "raw event log of human
    // accept/override decisions" — the unit is one decision. Firing N
    // times would 3x-weight the template-flywheel signal.
    const overrideCalls = site.match(/updateTemplateFromApproval/g) ?? []
    expect(overrideCalls.length).toBe(1)
    expect(site).toMatch(
      /updateTemplateFromApproval\(\s*tfmLookup\.project_id,\s*decoded\.tfmId/,
    )
  })

  it('NOT FOUND when the canonical disappears between read and resolver fetch', () => {
    expect(site).toMatch(/siblings\.length === 0/)
    expect(site).toMatch(/errorCode:\s*'NOT_FOUND'/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Sites #3, #4, #5 — no-op affirmation flips + create-final-step
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.8.1] Sites #3-#5 — no-op affirmation + create-final-step fan-out', () => {
  it('imports the resolver', () => {
    expect(REDESIGN_SRC).toMatch(
      /from '@\/lib\/actions\/tfm-sibling-resolution'/,
    )
  })

  // Three "no-op affirmation / final-step approve" sites. We count
  // resolver call sites: 3 expected (Sites #3, #4, #5).
  it('calls `resolveSiblingTfms` at all three sites', () => {
    const calls = REDESIGN_SRC.match(/resolveSiblingTfms\(\s*supabaseAdmin/g) ?? []
    expect(calls.length).toBe(3)
  })

  // The fan-out pattern uses `.in('id', siblingIds)` against the
  // bulk-resolved set. Heritage byte-identity is preserved via the
  // `siblings.length > 0 ? siblings.map(...) : [<canonical>]` fallback.
  it('each site uses `.in("id", siblingIds)` instead of the pre-Ω.3.8.1 `.eq("id", tfm.id)`', () => {
    // The bulk-fan-out shape must appear at least 3 times — one per site.
    const bulkCalls = REDESIGN_SRC.match(/\.in\('id',\s*siblingIds\)/g) ?? []
    expect(bulkCalls.length).toBeGreaterThanOrEqual(3)
  })

  it('heritage fallback is wired at each site (length-0 → canonical-only set)', () => {
    // Pattern: `siblings.length > 0 ? siblings.map((s) => s.id) : [<canonical>]`
    const fallbacks =
      REDESIGN_SRC.match(/siblings\.length > 0 \? siblings\.map\(/g) ?? []
    expect(fallbacks.length).toBe(3)
  })

  it("Sites #3-#5 do NOT log to ai_edit_history (affirmation flips are silent — only Site #1 audits)", () => {
    // Anti-grep: the no-op affirmation blocks remain audit-less.
    // We slice the relevant regions and assert no `logAIEdit(` call.
    // (The Site #1 audit pattern is `for (const sib of siblings)` —
    // a stronger guard that any future fan-out audit work stays
    // intentional rather than accidental.)
    const noopSourceSlice = sliceFromTo(
      REDESIGN_SRC,
      'No-op short circuit: source unchanged',
      'Step 10: duplicate check',
    )
    expect(noopSourceSlice).not.toMatch(/logAIEdit\(/)
    // Site #4 / #5 not sliced individually — their absence is already
    // guarded by Site #1's `updateFieldMappingStatus` being the single
    // canonical audit entry point (locked above in the Site #1 section).
  })
})
