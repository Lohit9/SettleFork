// @vitest-environment node
//
// Source-level invariant tests for the row-tint → button-pulse migration
// (PR feat/approve-ux-button-pulse). PR #58 / #60 / #62 / #64 history
// demonstrated that source-level invariants alone don't catch animation
// visibility (RF10 in reject-no-flash.test.ts is the specific lesson),
// so these invariants pin the STRUCTURAL change only — manual UX
// verification gates the visual behavior.
//
// What these invariants pin:
//   INVOPT1.  FieldMappingRow.tsx no longer derives the `optimisticBgClass`
//             variable. The row-level tint mechanism (bg-green-50 /
//             bg-slate-100 / bg-blue-50) is gone.
//   INVOPT2.  FieldMappingRow.tsx no longer applies `bg-green-50` based
//             on optimisticState === 'approving'.
//   INVOPT3.  FieldMappingRow.tsx no longer applies `bg-slate-100` based
//             on optimisticState === 'acknowledging'.
//   INVOPT4.  FieldMappingRow.tsx no longer applies `bg-blue-50` based
//             on optimisticState === 'mapping'.
//   INVOPT5.  globals.css contains the `@keyframes button-pulse` and
//             `.animate-button-pulse` utility class with a
//             prefers-reduced-motion fallback.
//   INVOPT6.  FieldMappingRow.tsx applies `animate-button-pulse`
//             conditionally to ActionIconButton based on a `pulse`
//             prop (existence + wiring check; doesn't pin the specific
//             variant↔state mapping in case future re-targeting moves
//             which button gets the pulse).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const FIELD_MAPPING_ROW = read(
  "app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow.tsx",
);
const GLOBALS_CSS = read("app/globals.css");

describe("[Optimistic UX] row-tint → button-pulse migration — invariants", () => {
  it("INVOPT1 — FieldMappingRow no longer derives `optimisticBgClass`", () => {
    // Negative pin. The variable name is gone from the file entirely.
    expect(FIELD_MAPPING_ROW).not.toMatch(/\boptimisticBgClass\b/);
  });

  it("INVOPT2 — FieldMappingRow does not apply `bg-green-50` for optimisticState === 'approving'", () => {
    // Negative pin. The literal `bg-green-50` should not appear inside
    // any cn() / className branch keyed on `'approving'` or
    // `optimisticState`.
    expect(FIELD_MAPPING_ROW).not.toMatch(/['"]bg-green-50['"]/);
  });

  it("INVOPT3 — FieldMappingRow does not apply `bg-slate-100` for optimisticState === 'acknowledging'", () => {
    // Negative pin. `bg-slate-100` is absent from the file.
    expect(FIELD_MAPPING_ROW).not.toMatch(/['"]bg-slate-100['"]/);
  });

  it("INVOPT4 — FieldMappingRow does not apply `bg-blue-50` for optimisticState === 'mapping'", () => {
    // Negative pin. `bg-blue-50` is absent from the file.
    expect(FIELD_MAPPING_ROW).not.toMatch(/['"]bg-blue-50['"]/);
  });

  it("INVOPT5 — globals.css contains `@keyframes button-pulse` + `.animate-button-pulse` utility + reduced-motion fallback", () => {
    // Positive pin: keyframe declaration.
    expect(GLOBALS_CSS).toMatch(/@keyframes\s+button-pulse\s*\{/);
    // Positive pin: utility class binding the keyframe.
    expect(GLOBALS_CSS).toMatch(
      /\.animate-button-pulse\s*\{[\s\S]*?animation:\s*button-pulse\s+/,
    );
    // Positive pin: prefers-reduced-motion suppresses the animation.
    expect(GLOBALS_CSS).toMatch(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.animate-button-pulse\s*\{[\s\S]*?animation:\s*none/,
    );
  });

  it("INVOPT6 — FieldMappingRow's ActionIconButton accepts `pulse` prop and applies `animate-button-pulse` conditionally", () => {
    // 1. ActionIconButton interface declares `pulse?: boolean`.
    expect(FIELD_MAPPING_ROW).toMatch(/\bpulse\?\s*:\s*boolean\b/);
    // 2. The className branch applies `animate-button-pulse` gated on
    //    the `pulse` prop. Doesn't pin specific variant↔state mapping;
    //    just pins the wiring.
    expect(FIELD_MAPPING_ROW).toMatch(
      /pulse\s*&&\s*['"]animate-button-pulse['"]/,
    );
    // 3. Confirm at least one call site passes `pulse={...}` to an
    //    ActionIconButton (existence check; doesn't pin which button).
    expect(FIELD_MAPPING_ROW).toMatch(/pulse=\{[a-zA-Z][a-zA-Z]*\}/);
  });
});
