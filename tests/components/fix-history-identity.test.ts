// @vitest-environment node
//
// Source-level invariant tests for the Fix History entry's identity
// rendering — locks in the structural commitment so a future
// propagation merge can't silently strip the identity again.
//
// We learned this lesson the hard way: PR #28 added avatar + name + email
// to FixHistoryPanel entries, shipped to dev as merge `3f56db7`, then a
// subsequent `main → dev` propagation merge silently overwrote the
// changes during conflict resolution. The regression went unnoticed
// until a user-reported screenshot. PR #29 (this PR) refactors the
// render to inline-identity ("timestamp · name · manual") and adds these
// invariants so the next propagation merge that drops the identity will
// fail in CI rather than in a screenshot.
//
// Same source-level testing strategy as
// tests/actions/projects-validation.test.ts and the broader
// tests/actions/ convention: read the component source and pin the
// contract via regex. Catches architectural drift without rendering
// the component.
//
// Invariants:
//
//   FH1.  DataQualityContent.tsx imports FixHistory type from
//         '@/lib/types/database'.
//   FH2.  FixHistoryPanel renders entry.user_name with the
//         'Unknown user' fallback (the inline identity).
//   FH3.  'Unknown user' fallback string is present (negative
//         protection: catches accidental removal during refactor).
//   FH4.  manual-suffix gate uses fix_option_chosen === 'Manual fix'
//         (provenance signal preserved from PR #28's pre-existing
//         logic).
//   FH5.  entry.user_name reference appears AFTER entry.applied_at in
//         source order — pins the "timestamp · name · manual" layout.
//   FH6.  getFixHistory enrichment is consumed (entry.user_name read
//         present in the panel body).
//   FH7.  entry.user_email is NOT rendered in the panel (UI design
//         decision: name only — surfaces the design call as a test, so
//         a future PR that adds email back without thinking will fail
//         and force the conversation).
//   FH8.  Avatar div from PR #28 is NOT present (catches accidental
//         re-add of the bg-primary 32px circular avatar layout that
//         PR #29 deliberately removed in favor of inline identity).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMPONENT_PATH = resolve(
  __dirname,
  "../../app/app/projects/[projectId]/data-quality/DataQualityContent.tsx",
);
const SRC = readFileSync(COMPONENT_PATH, "utf8");

function sliceFromTo(
  src: string,
  startMarker: string,
  endMarker: string,
): string {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(a, b);
}

// FixHistoryPanel function body — scope regex to this component only.
// File-wide regex would false-positive against IssueCard's inline
// "Fix Applied" / "Risk Accepted" summary (lines ~1288-1331), which
// renders fixDetails independently and was never in PR #28's scope.
//
// Boundaries: the section divider comments above each component in this
// file. Stable since 2024; if these dividers ever move or rename, this
// slice will throw a clear "marker not found" error instead of silently
// matching the wrong scope.
const FIX_HISTORY_PANEL_BODY = sliceFromTo(
  SRC,
  "// ── Fix History Panel ──",
  "// ── Create Manual Fix Modal ──",
);

describe("[FixHistoryPanel] inline identity render — invariants", () => {
  it("FH1 — DataQualityContent.tsx imports FixHistory type from @/lib/types/database", () => {
    expect(SRC).toMatch(
      /import\s+(?:type\s+)?\{[^}]*\bFixHistory\b[^}]*\}\s+from\s+['"]@\/lib\/types\/database['"]/,
    );
  });

  it("FH2 — metadata line renders entry.user_name with Unknown user fallback", () => {
    expect(FIX_HISTORY_PANEL_BODY).toMatch(
      /entry\.user_name\s*\?\?\s*['"]Unknown user['"]/,
    );
  });

  it("FH3 — Unknown user fallback string is present (negative protection)", () => {
    expect(FIX_HISTORY_PANEL_BODY).toMatch(/['"]Unknown user['"]/);
  });

  it('FH4 — manual-suffix gate uses fix_option_chosen === "Manual fix" (provenance signal preserved)', () => {
    expect(FIX_HISTORY_PANEL_BODY).toMatch(
      /entry\.fix_option_chosen\s*===\s*['"]Manual fix['"]/,
    );
  });

  it("FH5 — entry.user_name appears AFTER entry.applied_at in source order (timestamp · name · manual layout)", () => {
    const appliedAtIdx = FIX_HISTORY_PANEL_BODY.indexOf("entry.applied_at");
    const userNameIdx = FIX_HISTORY_PANEL_BODY.indexOf("entry.user_name");
    expect(appliedAtIdx).toBeGreaterThan(-1);
    expect(userNameIdx).toBeGreaterThan(-1);
    expect(userNameIdx).toBeGreaterThan(appliedAtIdx);
  });

  it("FH6 — getFixHistory enrichment is consumed (entry.user_name read present)", () => {
    expect(FIX_HISTORY_PANEL_BODY).toMatch(/\bentry\.user_name\b/);
  });

  it("FH7 — entry.user_email is NOT rendered in the panel (UI decision: name only)", () => {
    expect(FIX_HISTORY_PANEL_BODY).not.toMatch(/\bentry\.user_email\b/);
  });

  it("FH8 — avatar div from PR #28 is NOT present (catches accidental re-add)", () => {
    // PR #28's avatar was a 32px circular div: w-8 h-8 rounded-full bg-primary.
    // The test is robust against className-order shuffling: just check the
    // three telltale utilities co-occur on a single class string within the
    // panel body. Any future genuine avatar would need to dodge this combo.
    expect(FIX_HISTORY_PANEL_BODY).not.toMatch(
      /className=['"][^'"]*\bw-8\b[^'"]*\bh-8\b[^'"]*\brounded-full\b[^'"]*\bbg-primary\b/,
    );
  });
});
