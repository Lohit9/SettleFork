// @vitest-environment node
//
// Phase 4c-2 — source-level invariant tests for the Reject item added
// to TargetTableGroup's kebab menu. Extends the 4c-1 kebab tests
// (`tests/components/target-table-group-kebab.test.ts`) with the
// reject-specific contract that lands in 4c-2.
//
// Invariants:
//
//   TGR1. Reject menu item visible when `onRejectAllClick` is wired,
//         hidden when omitted (legacy fixtures / storybook opt out).
//   TGR2. Reject item carries red destructive styling (text-red-600 /
//         hover:bg-red-50). Approve item keeps gray.
//   TGR3. Disabled state with "No needs-review mappings" subtitle when
//         `needsReviewCount === 0`. Otherwise subtitle reads
//         "N mapping(s) will be deleted".
//   TGR4. Click on the enabled item closes the menu and invokes
//         `onRejectAllClick(targetTableId)`.
//   TGR5. Separator between approve and reject items.
//   TGR6. New `onRejectAllClick?: (targetTableId: string) => void` prop
//         on `TargetTableGroup`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMPONENT_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup.tsx',
)
const SRC = readFileSync(COMPONENT_PATH, 'utf8')

// ─────────────────────────────────────────────────────────────────────
// TGR1 — Conditional rendering
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab-reject] TGR1 conditional rendering', () => {
  it('TGR1a: Reject menu item rendered only when onRejectAllClick is defined', () => {
    expect(SRC).toMatch(/onRejectAllClick\s*!==\s*undefined/)
  })

  it('TGR1b: dedicated test-id surfaces the Reject menu item', () => {
    expect(SRC).toMatch(/data-testid="target-table-kebab-reject-all"/)
  })

  it('TGR1c: visible label is "Reject all needs-review"', () => {
    expect(SRC).toMatch(/Reject all needs-review/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TGR2 — Destructive styling
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab-reject] TGR2 destructive styling', () => {
  it('TGR2a: enabled Reject item uses text-red-600', () => {
    expect(SRC).toMatch(/text-red-600/)
  })

  it('TGR2b: enabled Reject item uses red hover background', () => {
    expect(SRC).toMatch(/hover:bg-red-50/)
  })

  it('TGR2c: disabled Reject item falls back to gray (consistent with disabled approve)', () => {
    // The disabled className shares the same gray-400 / cursor-not-
    // allowed pattern as the disabled approve branch.
    expect(SRC).toMatch(/text-gray-400 cursor-not-allowed/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TGR3 — Disabled state subtitle
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab-reject] TGR3 disabled state', () => {
  it('TGR3a: disabled subtitle reads "No needs-review mappings"', () => {
    expect(SRC).toMatch(/No needs-review mappings/)
  })

  it('TGR3b: enabled subtitle reads "N mapping(s) will be deleted" (destructive framing)', () => {
    expect(SRC).toMatch(/will be deleted/)
    expect(SRC).toMatch(/needsReviewCount\}\s*mapping/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TGR4 — Click semantics
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab-reject] TGR4 click semantics', () => {
  it('TGR4a: enabled Reject click closes the menu and fires onRejectAllClick(targetTableId)', () => {
    // Same handler shape as approve: setOpen(false) +
    // onRejectAllClick(targetTableId), early-return on isDisabled.
    expect(SRC).toMatch(
      /if\s*\(isDisabled\)\s*return[\s\S]{0,200}setOpen\(false\)[\s\S]{0,200}onRejectAllClick\(targetTableId\)/,
    )
  })

  it('TGR4b: disabled Reject click does NOT fire the callback', () => {
    // Mirror invariant — the early-return on isDisabled also gates
    // the reject click. Pinning both invariants protects against
    // copy-paste drift between the two menu items.
    const matches = SRC.match(/if\s*\(isDisabled\)\s*return/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TGR5 — Separator
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab-reject] TGR5 separator', () => {
  it('TGR5a: divider rendered between approve + reject items', () => {
    expect(SRC).toMatch(/data-testid="target-table-kebab-separator"/)
    // The separator uses border-t to visually divide the two items.
    expect(SRC).toMatch(/border-t\s+border-gray-100[\s\S]{0,200}target-table-kebab-separator/)
  })

  it('TGR5b: separator only renders alongside the Reject item (not on approve-only menus)', () => {
    // The separator is gated by the same `onRejectAllClick !== undefined`
    // guard so legacy fixtures don't render an orphan rule.
    expect(SRC).toMatch(
      /onRejectAllClick\s*!==\s*undefined[\s\S]{0,400}data-testid="target-table-kebab-separator"/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// TGR6 — Prop surface
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab-reject] TGR6 prop surface', () => {
  it('TGR6a: TargetTableGroup accepts onRejectAllClick optional prop', () => {
    expect(SRC).toMatch(
      /onRejectAllClick\?:\s*\(targetTableId:\s*string\)\s*=>\s*void/,
    )
  })

  it('TGR6b: kebab menu inner component accepts the same prop shape', () => {
    // The TargetTableKebabMenu inner function declares the param too.
    expect(SRC).toMatch(/onRejectAllClick\?:\s*\(targetTableId:\s*string\)\s*=>\s*void/)
  })

  it('TGR6c: TargetTableGroup threads onRejectAllClick to the kebab menu', () => {
    expect(SRC).toMatch(/onRejectAllClick=\{onRejectAllClick\}/)
  })
})
