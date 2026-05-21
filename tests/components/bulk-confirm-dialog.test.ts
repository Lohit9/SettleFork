// @vitest-environment node
//
// Phase 4c-1 — source-level invariant tests for BulkConfirmDialog.
//
// Same source-level testing strategy as the other 4b/4c component
// tests: read the file as a string and pin the contract via regex.
// We verify the parameterisation, copy strings, preview-list cap,
// loading state, error banner, and submission gating without booting
// React Testing Library.
//
// Six invariants per the Phase 4c-1 task list (BD1-BD6):
//
//   BD1. Component is parameterised for `mode: 'approve' | 'reject'`
//        and `scope: 'table' | 'high_confidence'` (reject path lands
//        ahead of 4c-2 even though no caller uses it yet).
//   BD2. Title copy distinguishes scope (per-table includes the table
//        name; high-confidence includes the threshold).
//   BD3. Action button label includes the count verbatim
//        ("Approve N mappings"). Loading state replaces the label.
//   BD4. Preview list renders the `preview` prop with target field
//        and primary source. The "and N more…" line shows when
//        `count > preview.length`.
//   BD5. Loading state surfaces an explicit indicator while
//        `count === null`. Empty state surfaces when `count === 0`.
//   BD6. Error banner renders when `errorMessage !== null`. Cancel +
//        Confirm are gated on `isSubmitting`; Confirm additionally
//        gated on `count === 0` and `count === null`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMPONENT_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/components/BulkConfirmDialog.tsx',
)
const SRC = readFileSync(COMPONENT_PATH, 'utf8')

// ─────────────────────────────────────────────────────────────────────
// BD1 — Parameterisation: mode + scope
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog] BD1 parameterisation', () => {
  it("BD1a: prop type accepts mode: 'approve' | 'reject'", () => {
    expect(SRC).toMatch(/mode:\s*['"]approve['"]\s*\|\s*['"]reject['"]/)
  })

  it("BD1b: prop type accepts scope: 'table' | 'high_confidence'", () => {
    expect(SRC).toMatch(/scope:\s*['"]table['"]\s*\|\s*['"]high_confidence['"]/)
  })

  it('BD1c: reject mode swaps confirm button to red destructive styling', () => {
    expect(SRC).toMatch(/mode\s*===\s*['"]reject['"]/)
    expect(SRC).toMatch(/bg-red-600/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BD2 — Title copy distinguishes scope
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog] BD2 title copy', () => {
  it('BD2a: per-table title includes "all needs-review on" + targetTableName interpolated', () => {
    expect(SRC).toMatch(/all needs-review on\s*\$\{targetTableName/)
  })

  it('BD2b: high-confidence title surfaces the threshold (≥85%)', () => {
    expect(SRC).toMatch(/high-confidence/)
    // \u2265 is the >= unicode glyph used in the title.
    expect(SRC).toMatch(/\\u2265|≥/)
    expect(SRC).toMatch(/threshold/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BD3 — Action button label + loading
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog] BD3 action button copy', () => {
  it('BD3a: action label uses the count verbatim — "Approve N mappings"', () => {
    expect(SRC).toMatch(/\$\{verb\}\s*\$\{n\}\s*\$\{pluralise\(n,\s*['"]mapping['"]/)
  })

  it("BD3b: loading state replaces the label with 'Approving…' / 'Unmapping…'", () => {
    expect(SRC).toMatch(/'Approving…'/)
    expect(SRC).toMatch(/'Unmapping…'/)
  })

  it('BD3c: pluralise helper covers the "1 mapping" vs. "N mappings" case', () => {
    expect(SRC).toMatch(/function pluralise\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BD4 — Preview list renders + "and N more"
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog] BD4 preview list', () => {
  it('BD4a: preview list maps the preview prop and keys by tfmId', () => {
    expect(SRC).toMatch(/preview\.map\(\s*\(row\)/)
    expect(SRC).toMatch(/key=\{row\.tfmId\}/)
  })

  it('BD4b: each preview row renders targetField and primarySource', () => {
    expect(SRC).toMatch(/row\.targetField/)
    expect(SRC).toMatch(/row\.primarySource/)
  })

  it('BD4c: shows "and N more…" when count > preview.length', () => {
    expect(SRC).toMatch(/count\s*-\s*preview\.length/)
    expect(SRC).toMatch(/and\s*\{remaining\}\s*more/)
  })

  it('BD4d: dialog does NOT slice the preview again client-side (server caps at 5)', () => {
    // The wrapper on the server enforces the cap; the dialog must
    // render whatever was handed to it.
    expect(SRC).not.toMatch(/preview\.slice\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BD5 — Loading + empty states
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog] BD5 loading + empty states', () => {
  it('BD5a: shows a loading indicator when count === null', () => {
    expect(SRC).toMatch(/count\s*===\s*null/)
    expect(SRC).toMatch(/Loading preview/)
  })

  it('BD5b: shows an empty-state message when count === 0', () => {
    expect(SRC).toMatch(/count\s*===\s*0/)
    expect(SRC).toMatch(/No mappings match the bulk-action scope/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BD6 — Error banner + submission gating
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog] BD6 error + gating', () => {
  it('BD6a: renders an error banner when errorMessage !== null', () => {
    expect(SRC).toMatch(/errorMessage\s*\?/)
    expect(SRC).toMatch(/data-testid="bulk-confirm-dialog-error"/)
    expect(SRC).toMatch(/role="alert"/)
  })

  it('BD6b: cancel button disabled while isSubmitting', () => {
    expect(SRC).toMatch(/data-testid="bulk-confirm-dialog-cancel"/)
    expect(SRC).toMatch(
      /data-testid="bulk-confirm-dialog-cancel"[\s\S]{0,400}disabled=\{isSubmitting\}/,
    )
  })

  it('BD6c: confirm button disabled while isSubmitting OR count === 0 OR count === null', () => {
    expect(SRC).toMatch(/data-testid="bulk-confirm-dialog-confirm"/)
    expect(SRC).toMatch(
      /disabled=\{isSubmitting\s*\|\|\s*count\s*===\s*0\s*\|\|\s*count\s*===\s*null\}/,
    )
  })

  it('BD6d: cancel only fires when not submitting (Esc + click-outside paths)', () => {
    expect(SRC).toMatch(/!next\s*&&\s*!isSubmitting[\s\S]{0,40}onCancel\(\)/)
  })
})
