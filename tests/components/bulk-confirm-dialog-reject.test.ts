// @vitest-environment node
//
// Phase 4c-2 — source-level invariant tests for BulkConfirmDialog's
// reject-mode wiring. Extends the 4c-1 dialog tests
// (`tests/components/bulk-confirm-dialog.test.ts`) with reject-specific
// invariants that ship in 4c-2:
//
//   BDR1. Reject-mode title format ("Unmap all needs-review on <Table>").
//   BDR2. Reject-mode body / consequence copy matches the locked spec
//         from §5.2 ("Unmapping deletes each mapping permanently…").
//   BDR3. Reject-mode action button label ("Unmap N mappings") and
//         loading-state copy ("Unmapping…").
//
// feat/reject-to-unmap renamed the user-facing verb "Reject" → "Unmap".
// The `mode: 'reject'` enum value is internal API and is unchanged, so
// the `mode === 'reject'` regexes below still match.
//   BDR4. Red destructive styling on the confirm button only in reject
//         mode (approve keeps the default).
//   BDR5. `hasTransform` indicator surfaces in preview rows in reject
//         mode and is suppressed in approve mode.
//   BDR6. `BulkPreviewRow` type carries the optional `hasTransform`
//         field threaded by `previewBulkReject`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMPONENT_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/components/BulkConfirmDialog.tsx',
)
const SRC = readFileSync(COMPONENT_PATH, 'utf8')

// ─────────────────────────────────────────────────────────────────────
// BDR1 — Title copy
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog-reject] BDR1 title copy', () => {
  it('BDR1a: reject + table scope title includes "Unmap" verb and target table name', () => {
    // Title template uses a `verb` derived from `mode`. Verify the
    // template substitutes "Unmap" through the same path as
    // "Approve" (covered by 4c-1 BD2a).
    expect(SRC).toMatch(/mode\s*===\s*['"]approve['"]\s*\?\s*['"]Approve['"]\s*:\s*['"]Unmap['"]/)
    expect(SRC).toMatch(/all needs-review on\s*\$\{targetTableName/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BDR2 — Consequence copy (§5.2 locked spec)
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog-reject] BDR2 consequence copy', () => {
  it('BDR2a: reject mode renders the explicit "deletes each mapping permanently" copy from §5.2', () => {
    expect(SRC).toMatch(
      /Unmapping deletes each mapping permanently\. The target fields will appear as unmapped \(Rule 6\)\. This cannot be undone\./,
    )
  })

  it('BDR2b: approve mode keeps the generic "This cannot be undone" line', () => {
    // The approve branch falls back to the bare line; the reject
    // branch has its own block. Verify both code paths exist.
    expect(SRC).toMatch(/return\s*'This cannot be undone\.'/)
  })

  it('BDR2c: consequence copy is selected via mode === "reject" branch', () => {
    expect(SRC).toMatch(
      /props\.mode\s*===\s*['"]reject['"][\s\S]{0,300}deletes each mapping permanently/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BDR3 — Action button label + loading state
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog-reject] BDR3 action button copy', () => {
  it('BDR3a: action label uses "Unmap" verb when mode === "reject"', () => {
    // buildActionLabel branches on `mode === 'approve'` for verb.
    expect(SRC).toMatch(
      /const\s+verb\s*=\s*mode\s*===\s*['"]approve['"]\s*\?\s*['"]Approve['"]\s*:\s*['"]Unmap['"]/,
    )
  })

  it('BDR3b: loading-state action label is "Unmapping…" in reject mode', () => {
    // Single quote U+2026 ellipsis matches the source.
    expect(SRC).toMatch(/['"]Unmapping\u2026['"]/)
  })

  it('BDR3c: action label includes the count verbatim ("Reject N mappings")', () => {
    // Shared with approve — buildActionLabel's `${verb} ${n} ${noun}`
    // path covers both modes uniformly.
    expect(SRC).toMatch(/`\$\{verb\}\s*\$\{n\}\s*\$\{pluralise\(n,\s*'mapping'\)\}`/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BDR4 — Destructive styling
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog-reject] BDR4 destructive styling', () => {
  it('BDR4a: reject mode applies bg-red-600 className to AlertDialogAction', () => {
    expect(SRC).toMatch(
      /mode\s*===\s*['"]reject['"][\s\S]{0,250}bg-red-600\s+hover:bg-red-700/,
    )
  })

  it('BDR4b: focus ring uses red tone in reject mode', () => {
    expect(SRC).toMatch(/focus-visible:ring-red-500/)
  })

  it('BDR4c: approve mode confirm button keeps default (no red override)', () => {
    // The ternary defaults to '' for approve so the AlertDialogAction
    // primitive's built-in styling carries through.
    expect(SRC).toMatch(/mode\s*===\s*['"]reject['"][\s\S]{0,200}:\s*['"]['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BDR5 — hasTransform indicator in preview rows
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog-reject] BDR5 hasTransform indicator', () => {
  it('BDR5a: preview row renders a "transform" badge when row.hasTransform is true AND mode is reject', () => {
    expect(SRC).toMatch(
      /mode\s*===\s*['"]reject['"]\s*&&\s*row\.hasTransform[\s\S]{0,400}transform/,
    )
  })

  it('BDR5b: indicator carries dedicated test-id for assertion', () => {
    expect(SRC).toMatch(/data-testid="bulk-confirm-dialog-preview-row-transform"/)
  })

  it('BDR5c: row data-attribute exposes hasTransform for outer queries', () => {
    expect(SRC).toMatch(
      /data-has-transform=\{[\s\S]{0,150}row\.hasTransform[\s\S]{0,80}\}/,
    )
  })

  it('BDR5d: indicator suppressed in approve mode regardless of hasTransform', () => {
    // The mode === 'reject' guard short-circuits the badge for approve.
    // Defensive check: there is NO unconditional `row.hasTransform &&`
    // path that would render the badge for approve.
    const matches = SRC.match(/row\.hasTransform/g) ?? []
    // Used only inside the data-has-transform attribute and inside the
    // badge guard — both behind a `mode === 'reject'` check.
    expect(matches.length).toBeGreaterThanOrEqual(2)
    // No standalone `hasTransform &&` outside the reject guard.
    const standalone = SRC.match(/[^d]row\.hasTransform\s*\?\s*<span/g)
    expect(standalone).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// BDR6 — BulkPreviewRow type carries hasTransform
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-confirm-dialog-reject] BDR6 preview row type', () => {
  it('BDR6a: BulkPreviewRow exposes optional hasTransform field', () => {
    expect(SRC).toMatch(
      /export interface BulkPreviewRow[\s\S]{0,1500}hasTransform\?:\s*boolean/,
    )
  })

  it('BDR6b: hasTransform is documented as reject-only / optional', () => {
    // Defensive — the JSDoc comment preceding the field notes it's
    // only meaningful in reject mode. Catches accidental drift to a
    // required field.
    expect(SRC).toMatch(
      /meaningful when[\s\S]{0,80}reject[\s\S]{0,400}hasTransform\?:\s*boolean/i,
    )
  })
})
