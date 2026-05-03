// @vitest-environment node
//
// Source-level invariants for PR E.1 popover migrations.
//
// Three files migrate from hand-rolled createPortal + position math +
// click-outside / Escape listeners to the Radix Popover wrapper:
//   - components/app/Navigation.tsx (avatar popover)
//   - components/app/SidebarShell.tsx (avatar popover + org switcher)
//   - app/app/projects/[projectId]/data-overview/DataProfiling.tsx
//     (quality-issues popover)
//
// Per file, positive invariants pin Radix wrapper adoption; negative
// invariants pin the absence of the hand-rolled machinery the migration
// removes.
//
// FOUR deferral-lock invariants pin the architectural decisions to NOT
// migrate other popover-class components in this PR:
//
//   - RejectConfirmPopover (parent-owns-trigger architecture mismatch
//     with Radix's Trigger-inside-Root model; deferred to a separate
//     PR alongside FieldMappingRow.tsx restructure + test
//     modernization from fireEvent.mouseDown -> fireEvent.pointerDown).
//   - FieldPicker (search-input picker; E.2 territory).
//   - InlineSourcePicker (search-input + multi-select chips +
//     in-flight save semantics; E.2 territory).
//   - TableFieldFilter (multi-select + commit-on-close; E.2
//     territory).
//
// If any future PR migrates these without the corresponding architectural
// work, these tests fail loudly in CI before the regression ships.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const NAV_PATH = resolve(__dirname, "../../components/app/Navigation.tsx")
const SIDEBAR_PATH = resolve(__dirname, "../../components/app/SidebarShell.tsx")
const DATA_PROFILING_PATH = resolve(
  __dirname,
  "../../app/app/projects/[projectId]/data-overview/DataProfiling.tsx",
)
const REJECT_PATH = resolve(
  __dirname,
  "../../app/app/projects/[projectId]/mapping/redesign/components/RejectConfirmPopover.tsx",
)
const FIELD_PICKER_PATH = resolve(
  __dirname,
  "../../components/app/FieldPicker.tsx",
)
const INLINE_SRC_PICKER_PATH = resolve(
  __dirname,
  "../../app/app/projects/[projectId]/mapping/redesign/components/InlineSourcePicker.tsx",
)
const TABLE_FIELD_FILTER_PATH = resolve(
  __dirname,
  "../../components/app/TableFieldFilter.tsx",
)

const NAV_SRC = readFileSync(NAV_PATH, "utf8")
const SIDEBAR_SRC = readFileSync(SIDEBAR_PATH, "utf8")
const DATA_PROFILING_SRC = readFileSync(DATA_PROFILING_PATH, "utf8")
const REJECT_SRC = readFileSync(REJECT_PATH, "utf8")
const FIELD_PICKER_SRC = readFileSync(FIELD_PICKER_PATH, "utf8")
const INLINE_SRC_PICKER_SRC = readFileSync(INLINE_SRC_PICKER_PATH, "utf8")
const TABLE_FIELD_FILTER_SRC = readFileSync(TABLE_FIELD_FILTER_PATH, "utf8")

const POPOVER_IMPORT = /import\s*\{[^}]*\bPopoverContent\b[^}]*\}\s*from\s*['"]@\/components\/ui\/popover['"]/

// ─────────────────────────────────────────────────────────────────────────────
// Migrated: Navigation.tsx avatar popover
// ─────────────────────────────────────────────────────────────────────────────
describe("[Navigation] avatar popover migrated to Radix", () => {
  it("N1 — imports Popover/Trigger/Content from @/components/ui/popover", () => {
    expect(NAV_SRC).toMatch(POPOVER_IMPORT)
  })

  it("N2 — renders <Popover> with <PopoverContent>", () => {
    expect(NAV_SRC).toMatch(/<Popover(\s|>)/)
    expect(NAV_SRC).toMatch(/<PopoverContent(\s|>)/)
  })

  it("N3 — uses asChild on PopoverTrigger (wraps existing button)", () => {
    expect(NAV_SRC).toMatch(/<PopoverTrigger\s+asChild/)
  })

  it("N4 — createPortal NOT imported (Radix Portal replaces it)", () => {
    expect(NAV_SRC).not.toMatch(/\bcreatePortal\b/)
    expect(NAV_SRC).not.toMatch(/from\s*['"]react-dom['"]/)
  })

  it("N5 — manual isPopoverOpen useState is removed (Radix manages open)", () => {
    expect(NAV_SRC).not.toMatch(/\bisPopoverOpen\b/)
    expect(NAV_SRC).not.toMatch(/\bsetIsPopoverOpen\b/)
  })

  it("N6 — getBoundingClientRect not called (Radix manages positioning)", () => {
    expect(NAV_SRC).not.toMatch(/getBoundingClientRect/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Migrated: SidebarShell.tsx (avatar popover + org switcher — both)
// ─────────────────────────────────────────────────────────────────────────────
describe("[SidebarShell] avatar + org switcher popovers migrated to Radix", () => {
  it("S1 — imports Popover/Trigger/Content from @/components/ui/popover", () => {
    expect(SIDEBAR_SRC).toMatch(POPOVER_IMPORT)
  })

  it("S2 — renders at least 2 <Popover> roots (avatar + org switcher)", () => {
    const matches = SIDEBAR_SRC.match(/<Popover(\s|>)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it("S3 — at least 2 <PopoverContent> blocks", () => {
    const matches = SIDEBAR_SRC.match(/<PopoverContent(\s|>)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it("S4 — createPortal NOT imported", () => {
    expect(SIDEBAR_SRC).not.toMatch(/\bcreatePortal\b/)
    expect(SIDEBAR_SRC).not.toMatch(/from\s*['"]react-dom['"]/)
  })

  it("S5 — manual isPopoverOpen / isOrgPopoverOpen useState removed", () => {
    expect(SIDEBAR_SRC).not.toMatch(/\bisPopoverOpen\b/)
    expect(SIDEBAR_SRC).not.toMatch(/\bisOrgPopoverOpen\b/)
  })

  it("S6 — getBoundingClientRect not called", () => {
    expect(SIDEBAR_SRC).not.toMatch(/getBoundingClientRect/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Migrated: DataProfiling.tsx quality-issues popover
// ─────────────────────────────────────────────────────────────────────────────
describe("[DataProfiling] quality-issues popover migrated to Radix", () => {
  it("D1 — imports Popover/Trigger/Content from @/components/ui/popover", () => {
    expect(DATA_PROFILING_SRC).toMatch(POPOVER_IMPORT)
  })

  it("D2 — renders <Popover> with <PopoverContent>", () => {
    expect(DATA_PROFILING_SRC).toMatch(/<Popover(\s|>)/)
    expect(DATA_PROFILING_SRC).toMatch(/<PopoverContent(\s|>)/)
  })

  it("D3 — manual openQualityPopover state replaced (no setOpenQualityPopover from outside-click handler — Radix manages dismiss)", () => {
    // The state variable can stay (it tracks WHICH field's popover is open),
    // but the manual document-mousedown click-outside listener must be gone.
    expect(DATA_PROFILING_SRC).not.toMatch(/document\.addEventListener\(\s*['"]mousedown['"]/)
  })

  it("D4 — getBoundingClientRect for popover-position-flip not called (Radix collisionPadding handles flip)", () => {
    // Radix Popover auto-flips above when there's no room below via
    // the avoidCollisions default. The manual spaceBelow/getBoundingClientRect
    // logic is gone.
    expect(DATA_PROFILING_SRC).not.toMatch(/getBoundingClientRect/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DEFERRAL LOCKS — these four files MUST NOT import the popover wrapper.
// If a future PR migrates one without the corresponding architectural work,
// these tests fail in CI.
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEFERRAL LOCKS] popover wrapper not adopted by complex / structurally-mismatched candidates", () => {
  it("X1 — RejectConfirmPopover does NOT import @/components/ui/popover (parent-owns-trigger architecture mismatch with Radix Trigger-inside-Root; deferred to PR E.1.5 which restructures FieldMappingRow + modernizes the existing test from fireEvent.mouseDown -> fireEvent.pointerDown)", () => {
    expect(REJECT_SRC).not.toMatch(/from\s*['"]@\/components\/ui\/popover['"]/)
  })

  it("X2 — FieldPicker does NOT import @/components/ui/popover (search-input picker; deferred to PR E.2)", () => {
    expect(FIELD_PICKER_SRC).not.toMatch(/from\s*['"]@\/components\/ui\/popover['"]/)
  })

  it("X3 — InlineSourcePicker does NOT import @/components/ui/popover (search + multi-select chips + in-flight save semantics; deferred to PR E.2)", () => {
    expect(INLINE_SRC_PICKER_SRC).not.toMatch(/from\s*['"]@\/components\/ui\/popover['"]/)
  })

  it("X4 — TableFieldFilter does NOT import @/components/ui/popover (multi-select + commit-on-close; deferred to PR E.2)", () => {
    expect(TABLE_FIELD_FILTER_SRC).not.toMatch(/from\s*['"]@\/components\/ui\/popover['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper-not-orphaned: at least one migrated file consumes PopoverContent.
// (Sanity check — the wrapper only exists if it has a real consumer.)
// ─────────────────────────────────────────────────────────────────────────────
describe("[wrapper consumer check]", () => {
  it("ORPH — at least one migrated file imports PopoverContent (wrapper has a real consumer)", () => {
    const consumers = [NAV_SRC, SIDEBAR_SRC, DATA_PROFILING_SRC]
    const importCount = consumers.filter((s) => POPOVER_IMPORT.test(s)).length
    expect(importCount).toBeGreaterThanOrEqual(1)
  })
})
