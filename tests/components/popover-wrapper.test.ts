// @vitest-environment node
//
// Source-level invariants for the components/ui/popover.tsx wrapper —
// the third Radix adopter in components/ui/ (alongside select.tsx and
// dropdown-menu.tsx, both of which have their own wrapper patterns).
//
// Same source-level testing strategy as PR C / PR #30 / PR #31 / PR F:
// readFileSync + regex against the wrapper source. Pins the named
// exports, data-slot conventions, cn() composition, and the canonical
// default Tailwind. Catches drift without rendering.
//
// Invariants:
//
//   WP1. Named exports: Popover, PopoverTrigger, PopoverPortal,
//        PopoverContent.
//   WP2. data-slot attributes per primitive.
//   WP3. cn() composition used in the wrapper file.
//   WP4. "use client" directive at file top.
//   WP5. Imports @radix-ui/react-popover (confirms the dep is used).
//   WP6. PopoverContent has the canonical default Tailwind animation
//        utilities (data-[state=open]:animate-in present).

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const WRAPPER_PATH = resolve(__dirname, "../../components/ui/popover.tsx")
const SRC = readFileSync(WRAPPER_PATH, "utf8")

describe("[components/ui/popover.tsx] wrapper contract", () => {
  it("WP1 — exports the four canonical primitives", () => {
    for (const name of [
      "Popover",
      "PopoverTrigger",
      "PopoverPortal",
      "PopoverContent",
    ]) {
      expect(SRC).toMatch(new RegExp(`function\\s+${name}\\s*\\(`))
    }
    // Single named-export block listing all four
    expect(SRC).toMatch(
      /export\s*\{[\s\S]*?Popover[\s\S]*?PopoverContent[\s\S]*?PopoverPortal[\s\S]*?PopoverTrigger[\s\S]*?\}/,
    )
  })

  it("WP2 — data-slot attributes present per primitive", () => {
    for (const slot of [
      "popover",
      "popover-trigger",
      "popover-content",
      "popover-portal",
    ]) {
      expect(SRC).toMatch(new RegExp(`data-slot="${slot}"`))
    }
  })

  it("WP3 — cn() composition used", () => {
    expect(SRC).toMatch(/import\s*\{\s*cn\s*\}\s*from\s*['"]\.\/utils['"]/)
    expect(SRC).toMatch(/cn\(/)
  })

  it("WP4 — \"use client\" directive at file top", () => {
    expect(SRC.trimStart()).toMatch(/^['"]use client['"]/)
  })

  it("WP5 — imports @radix-ui/react-popover (dep actually used)", () => {
    expect(SRC).toMatch(
      /import\s+\*\s+as\s+PopoverPrimitive\s+from\s+['"]@radix-ui\/react-popover['"]/,
    )
  })

  it("WP6 — PopoverContent has canonical fade+zoom animation utilities", () => {
    expect(SRC).toMatch(/data-\[state=open\]:animate-in/)
    expect(SRC).toMatch(/data-\[state=open\]:fade-in-0/)
    expect(SRC).toMatch(/data-\[state=closed\]:animate-out/)
  })
})
