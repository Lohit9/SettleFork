// @vitest-environment node
//
// Source-level invariant tests for the Decisions & Actions Log
// entry's identity rendering — pins the data-flow extension and
// the "timestamp · name" layout so a future merge or refactor that
// silently drops the actor identity will fail in CI rather than
// in a screenshot.
//
// Same readFileSync + regex strategy as
// tests/components/fix-history-identity.test.ts (PR #30) and
// tests/components/popover-migrations-e1.test.ts (PR E.1). Catches
// architectural drift without rendering the component.
//
// Invariants:
//   DL1.  OutputsContent.tsx imports OutputsPageData (which carries
//         DecisionEntry) from '@/lib/actions/outputs'. The
//         entry-render uses entry.user_name, so type continuity
//         flows from this import.
//   DL2.  Decisions Log render references entry.user_name with
//         'Unknown user' fallback (the inline identity).
//   DL3.  'Unknown user' fallback string is present (negative
//         protection: catches accidental removal).
//   DL4.  fmtDateTime(entry.timestamp) is preserved (no regression
//         in the timestamp render).
//   DL5.  entry.user_name appears AFTER fmtDateTime(entry.timestamp)
//         in source order — pins the "timestamp · name" layout.
//   DL6.  _outputs-core.ts activity_log SELECT includes user_id —
//         locks the data-flow extension at the read boundary.
//   DL7.  enrichWithUserIdentity is imported AND invoked in
//         lib/actions/outputs.ts (the new caller).
//   DL8.  All 4 source files that consume the helper actually
//         import it from '@/lib/auth/users' (covers all 6 call
//         sites — project-members.ts and organizations.ts each
//         have 2 callers but a single import line covers both).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8");

const OUTPUTS_CONTENT = read(
  "app/app/projects/[projectId]/outputs/OutputsContent.tsx",
);
const OUTPUTS_CORE = read("lib/actions/_outputs-core.ts");
const OUTPUTS_WRAPPER = read("lib/actions/outputs.ts");
const USERS_HELPER = read("lib/auth/users.ts");

describe("[Decisions & Actions Log] inline identity render — invariants", () => {
  it("DL1 — OutputsContent.tsx imports OutputsPageData from @/lib/actions/outputs", () => {
    expect(OUTPUTS_CONTENT).toMatch(
      /import\s+type\s+\{[^}]*\bOutputsPageData\b[^}]*\}\s+from\s+['"]@\/lib\/actions\/outputs['"]/,
    );
  });

  it("DL2 — entry render references entry.user_name with 'Unknown user' fallback", () => {
    expect(OUTPUTS_CONTENT).toMatch(
      /entry\.user_name\s*\?\?\s*['"]Unknown user['"]/,
    );
  });

  it("DL3 — 'Unknown user' fallback string is present (negative protection)", () => {
    expect(OUTPUTS_CONTENT).toMatch(/['"]Unknown user['"]/);
  });

  it("DL4 — fmtDateTime(entry.timestamp) is preserved in the rendering", () => {
    expect(OUTPUTS_CONTENT).toMatch(/fmtDateTime\(entry\.timestamp\)/);
  });

  it("DL5 — entry.user_name appears AFTER fmtDateTime(entry.timestamp) in source order", () => {
    const tsIdx = OUTPUTS_CONTENT.indexOf("fmtDateTime(entry.timestamp)");
    const nameIdx = OUTPUTS_CONTENT.indexOf("entry.user_name");
    expect(tsIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(tsIdx);
  });

  it("DL6 — _outputs-core.ts activity_log SELECT includes user_id", () => {
    // Match the SELECT column list immediately after .from('activity_log').
    expect(OUTPUTS_CORE).toMatch(
      /\.from\(['"]activity_log['"]\)\s*\.select\(['"][^'"]*\buser_id\b[^'"]*['"]\)/,
    );
  });

  it("DL7 — enrichWithUserIdentity is imported AND invoked in lib/actions/outputs.ts", () => {
    expect(OUTPUTS_WRAPPER).toMatch(
      /import\s+\{[^}]*\benrichWithUserIdentity\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/users['"]/,
    );
    expect(OUTPUTS_WRAPPER).toMatch(/\benrichWithUserIdentity\s*\(/);
  });

  it("DL8 — helper exported AND consumed by 4 source files (covers all 6 call sites)", () => {
    // The helper must be a named export.
    expect(USERS_HELPER).toMatch(
      /export\s+async\s+function\s+enrichWithUserIdentity\b/,
    );

    // Each consumer file must import the helper from @/lib/auth/users.
    const consumers = [
      "lib/actions/project-members.ts",
      "lib/actions/organizations.ts",
      "lib/actions/quality-fixes.ts",
      "lib/actions/outputs.ts",
    ];
    for (const file of consumers) {
      const src = read(file);
      expect(src, `${file} missing enrichWithUserIdentity import`).toMatch(
        /import\s+\{[^}]*\benrichWithUserIdentity\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/users['"]/,
      );
      expect(src, `${file} imports but does not invoke helper`).toMatch(
        /\benrichWithUserIdentity\s*\(/,
      );
    }
  });
});
