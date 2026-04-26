// @vitest-environment node
//
// Phase 4c-1 — source-level invariant tests for the kebab menu added
// to TargetTableGroup.tsx. Mirrors the source-level pattern used by
// the rest of the redesign component suite.
//
// Four invariants per the Phase 4c-1 task list (TG1-TG4):
//
//   TG1. Kebab button rendered in the header when both
//        `needsReviewCount` and `onApproveAllClick` props are wired.
//        Hidden when either is omitted (legacy fixtures, storybook).
//   TG2. Single menu item in 4c-1: "Approve all needs-review". The
//        founder refinement (2026-04-26) excludes a disabled "Reject"
//        placeholder — that ships in 4c-2 alongside its wiring.
//   TG3. Disabled state with "No needs-review mappings" subtitle
//        when `needsReviewCount === 0`. Otherwise subtitle reads
//        "N mapping(s) pending".
//   TG4. Click on the enabled item closes the menu and invokes
//        `onApproveAllClick(targetTableId)`. Click outside / Escape
//        closes the menu without firing the callback.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMPONENT_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup.tsx',
)
const SRC = readFileSync(COMPONENT_PATH, 'utf8')

// ─────────────────────────────────────────────────────────────────────
// TG1 — Conditional rendering
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab] TG1 conditional rendering', () => {
  it('TG1a: TargetTableGroup accepts needsReviewCount and onApproveAllClick props', () => {
    expect(SRC).toMatch(/needsReviewCount\?:\s*number/)
    expect(SRC).toMatch(/onApproveAllClick\?:\s*\(targetTableId:\s*string\)\s*=>\s*void/)
  })

  it('TG1b: kebab is rendered only when BOTH props are defined (legacy fixtures hide it)', () => {
    expect(SRC).toMatch(
      /needsReviewCount\s*!==\s*undefined\s*&&\s*onApproveAllClick\s*!==\s*undefined/,
    )
  })

  it('TG1c: kebab trigger uses MoreHorizontal icon and exposes data-testid', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*MoreHorizontal\s*\}\s*from\s*['"]@\/components\/icons['"]/,
    )
    expect(SRC).toMatch(/data-testid="target-table-kebab-trigger"/)
    expect(SRC).toMatch(/data-testid="target-table-kebab"/)
  })

  it('TG1d: kebab button has aria attributes for an accessible menu', () => {
    expect(SRC).toMatch(/aria-haspopup="menu"/)
    expect(SRC).toMatch(/aria-expanded=\{open\}/)
    expect(SRC).toMatch(/aria-label=\{`Bulk actions for \$\{targetTableName\}`\}/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TG2 — Menu item composition
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab] TG2 menu items', () => {
  it('TG2a: "Approve all needs-review" item is present (single approve testid)', () => {
    expect(SRC).toMatch(/Approve all needs-review/)
    // Approve testid is unique — there's only ONE approve menu item
    // regardless of the 4c-2 reject extension.
    const matches = SRC.match(/data-testid="target-table-kebab-approve-all"/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('TG2b: 4c-2 ships the Reject item (see target-table-group-kebab-reject.test.ts)', () => {
    // Phase 4c-2 (2026-04-26): the Reject item lands alongside its
    // wiring. Detailed invariants (red styling, separator, click
    // semantics) live in the dedicated reject test file. We pin the
    // invariant here only to flag accidental removal.
    expect(SRC).toMatch(/Reject all needs-review/)
    expect(SRC).toMatch(/data-testid="target-table-kebab-reject-all"/)
  })

  it('TG2c: menu items use role="menuitem" and the container uses role="menu"', () => {
    expect(SRC).toMatch(/role="menu"/)
    expect(SRC).toMatch(/role="menuitem"/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TG3 — Disabled state when needsReviewCount === 0
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab] TG3 disabled state', () => {
  it('TG3a: derives isDisabled = needsReviewCount === 0', () => {
    expect(SRC).toMatch(/const\s+isDisabled\s*=\s*needsReviewCount\s*===\s*0/)
  })

  it('TG3b: button is disabled when isDisabled is true', () => {
    expect(SRC).toMatch(/disabled=\{isDisabled\}/)
  })

  it('TG3c: subtitle reads "No needs-review mappings" when disabled', () => {
    expect(SRC).toMatch(/No needs-review mappings/)
  })

  it('TG3d: subtitle includes "N mapping(s) pending" when enabled', () => {
    expect(SRC).toMatch(/needsReviewCount\}\s*mapping/)
    expect(SRC).toMatch(/pending/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// TG4 — Click semantics + click-outside / Esc close
// ─────────────────────────────────────────────────────────────────────

describe('[target-table-kebab] TG4 click semantics', () => {
  it('TG4a: enabled click closes the menu and fires onApproveAllClick(targetTableId)', () => {
    // The handler shape: setOpen(false) + onApproveAllClick(targetTableId)
    // inside an onClick that early-returns when isDisabled.
    expect(SRC).toMatch(
      /if\s*\(isDisabled\)\s*return[\s\S]{0,200}setOpen\(false\)[\s\S]{0,200}onApproveAllClick\(targetTableId\)/,
    )
  })

  it('TG4b: useEffect registers click-outside + Escape close while open', () => {
    expect(SRC).toMatch(/document\.addEventListener\(\s*['"]mousedown['"]/)
    expect(SRC).toMatch(/document\.addEventListener\(\s*['"]keydown['"]/)
    expect(SRC).toMatch(/e\.key\s*===\s*['"]Escape['"]/)
  })

  it('TG4c: click-outside check uses contains() against the wrapper ref', () => {
    expect(SRC).toMatch(/wrapperRef\.current\.contains\(/)
    expect(SRC).toMatch(/setOpen\(false\)/)
  })

  it('TG4d: aria menu label echoes the target table name for screen readers', () => {
    // Both the button trigger AND the menu container carry the same label.
    expect(SRC).toMatch(/aria-label=\{`Bulk actions for \$\{targetTableName\}`\}/)
  })
})
