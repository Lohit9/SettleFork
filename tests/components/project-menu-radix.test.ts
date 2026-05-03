// @vitest-environment node
//
// Source-level invariant tests for PR D's ProjectMenu Radix migration.
//
// Same source-level testing strategy as
// tests/components/fix-history-identity.test.ts (PR #30) and
// tests/actions/projects-validation.test.ts (PR C). Read the component
// source as a string and pin the contract via regex. Catches
// architectural drift without rendering the component (Radix's runtime
// behavior is library-tested upstream).
//
// Positive invariants pin presence of the Radix primitives + the wrapper
// import path. Negative invariants pin absence of the hand-rolled
// machinery PR D removed (useState(isOpen), createPortal,
// useState(dropCoords), getBoundingClientRect). If a future propagation
// merge regresses the migration to the pre-D state, these tests fail
// loudly in CI before a user reports it.
//
// Invariants:
//
//   PM1.  ProjectMenu.tsx imports DropdownMenu from
//         '@/components/ui/dropdown-menu' (uses wrapper, not raw Radix).
//   PM2.  Renders the four core Radix primitives: Root, Trigger, Portal,
//         Content.
//   PM3.  Renders DropdownMenuItem at least three times (Project settings,
//         Mark/Reactivate, Archive, Delete — at least 3 across active state).
//   PM4.  Renders DropdownMenuSeparator (the divider).
//   PM5.  Negative — useState(isOpen) and setIsOpen are NOT present
//         (Radix manages open state).
//   PM6.  Negative — createPortal is NOT imported/used (Radix Portal
//         replaces it).
//   PM7.  Negative — dropCoords is NOT present (Radix manages positioning).
//   PM8.  Negative — getBoundingClientRect is NOT called (Radix uses
//         @floating-ui/dom internally).
//   PM9.  Viewer short-circuit preserved: returns null when
//         !canEdit && !canManage.
//   PM10. "Project settings" item navigates via router.push to
//         /app/projects/${id}/settings?tab=info.
//   PM11. Delete item is gated on canManage.
//   PM12. components/ui/dropdown-menu.tsx exports the six named functions.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const PROJECT_MENU_PATH = resolve(
  __dirname,
  "../../components/app/ProjectMenu.tsx",
)
const DROPDOWN_MENU_PATH = resolve(
  __dirname,
  "../../components/ui/dropdown-menu.tsx",
)

const PROJECT_MENU_SRC = readFileSync(PROJECT_MENU_PATH, "utf8")
const DROPDOWN_MENU_SRC = readFileSync(DROPDOWN_MENU_PATH, "utf8")

describe("[ProjectMenu] Radix migration — invariants", () => {
  it("PM1 — imports DropdownMenu from @/components/ui/dropdown-menu (uses wrapper, not raw Radix)", () => {
    expect(PROJECT_MENU_SRC).toMatch(
      /import\s*\{[^}]*\bDropdownMenu\b[^}]*\}\s*from\s*['"]@\/components\/ui\/dropdown-menu['"]/,
    )
    // Negative: must NOT import raw @radix-ui/react-dropdown-menu directly
    expect(PROJECT_MENU_SRC).not.toMatch(
      /from\s*['"]@radix-ui\/react-dropdown-menu['"]/,
    )
  })

  it("PM2 — renders the four core Radix primitives (Root, Trigger, Portal, Content)", () => {
    expect(PROJECT_MENU_SRC).toMatch(/<DropdownMenu(\s|>)/)
    expect(PROJECT_MENU_SRC).toMatch(/<DropdownMenuTrigger(\s|>)/)
    expect(PROJECT_MENU_SRC).toMatch(/<DropdownMenuPortal(\s|>)/)
    expect(PROJECT_MENU_SRC).toMatch(/<DropdownMenuContent(\s|>)/)
  })

  it("PM3 — renders DropdownMenuItem at least 3 times", () => {
    const matches = PROJECT_MENU_SRC.match(/<DropdownMenuItem(\s|>)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  it("PM4 — renders DropdownMenuSeparator", () => {
    expect(PROJECT_MENU_SRC).toMatch(/<DropdownMenuSeparator(\s|\/|>)/)
  })

  it("PM5 — useState(isOpen) and setIsOpen are NOT present (Radix manages open state)", () => {
    expect(PROJECT_MENU_SRC).not.toMatch(/useState[^)]*isOpen/)
    expect(PROJECT_MENU_SRC).not.toMatch(/\bsetIsOpen\b/)
  })

  it("PM6 — createPortal is NOT imported/used (Radix Portal replaces it)", () => {
    expect(PROJECT_MENU_SRC).not.toMatch(/\bcreatePortal\b/)
    expect(PROJECT_MENU_SRC).not.toMatch(/from\s*['"]react-dom['"]/)
  })

  it("PM7 — dropCoords is NOT present (Radix manages positioning)", () => {
    expect(PROJECT_MENU_SRC).not.toMatch(/\bdropCoords\b/)
  })

  it("PM8 — getBoundingClientRect is NOT called (Radix uses @floating-ui/dom internally)", () => {
    expect(PROJECT_MENU_SRC).not.toMatch(/getBoundingClientRect/)
  })

  it("PM9 — viewer short-circuit preserved (returns null when !canEdit && !canManage)", () => {
    expect(PROJECT_MENU_SRC).toMatch(
      /!canEdit\s*&&\s*!canManage[\s\S]{0,80}return\s+null/,
    )
  })

  it("PM10 — Project settings item navigates via router.push to /settings?tab=info", () => {
    expect(PROJECT_MENU_SRC).toMatch(
      /router\.push\(\s*[`'"]\/app\/projects\/\$\{[^}]+\}\/settings\?tab=info[`'"]/,
    )
  })

  it("PM11 — Delete item is gated on canManage", () => {
    // Match: canManage && ... DropdownMenuItem ... Delete project
    expect(PROJECT_MENU_SRC).toMatch(
      /canManage\s*&&[\s\S]{0,500}Delete\s+project/,
    )
  })
})

describe("[components/ui/dropdown-menu.tsx] wrapper exports", () => {
  it("PM12 — exports the six named functions per the shadcn-style wrapper convention", () => {
    // All six primitives must appear in the export block
    for (const name of [
      "DropdownMenu",
      "DropdownMenuContent",
      "DropdownMenuItem",
      "DropdownMenuPortal",
      "DropdownMenuSeparator",
      "DropdownMenuTrigger",
    ]) {
      expect(DROPDOWN_MENU_SRC).toMatch(
        new RegExp(`function\\s+${name}\\s*\\(`),
      )
    }
    // Verify they're in the export statement (single named export block)
    expect(DROPDOWN_MENU_SRC).toMatch(
      /export\s*\{[\s\S]*?DropdownMenu[\s\S]*?DropdownMenuContent[\s\S]*?DropdownMenuItem[\s\S]*?DropdownMenuPortal[\s\S]*?DropdownMenuSeparator[\s\S]*?DropdownMenuTrigger[\s\S]*?\}/,
    )
  })
})
