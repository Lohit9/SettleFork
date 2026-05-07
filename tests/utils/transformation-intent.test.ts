/**
 * Combination-hint resolution — regression net + Path D positive cases.
 *
 * Sub-PR 2 of Phase B Path D core. The 10 `extractCombinationHint` cases
 * below pin the legacy Path B regex behavior at
 * `lib/actions/transformations.ts:generateTransform` so the read-path swap
 * to `resolveTransformationIntent` (this same PR's callsite change) cannot
 * silently regress. The 3 `resolveTransformationIntent` cases lock the
 * Path D priority semantics.
 *
 * Why this regression net matters: the production failure mode is "subtly
 * worse SQL" — a missing combination hint silently produces a transform
 * prompt without the hint, and Claude's resulting SQL is less informed but
 * still runs. The bug ships without alerting anyone. Locking the parsed
 * output across 10 representative inputs is the only way to detect drift.
 */

import { describe, it, expect } from "vitest";
import {
  extractCombinationHint,
  resolveTransformationIntent,
} from "@/lib/utils/transformation-intent";

describe("extractCombinationHint — Path B regex behavior pin (10 cases)", () => {
  it("extracts a standard '[Combination: A + B]' marker", () => {
    expect(
      extractCombinationHint("Map customer_id to id. [Combination: A + B]"),
    ).toBe("A + B");
  });

  it("handles no whitespace after the colon", () => {
    expect(extractCombinationHint("[Combination:A+B]")).toBe("A+B");
  });

  it("handles extra whitespace after the colon (regex \\s* eats it)", () => {
    expect(extractCombinationHint("[Combination:   A+B]")).toBe("A+B");
  });

  it("returns null when the marker is absent", () => {
    expect(
      extractCombinationHint("Reasoning without bracket marker"),
    ).toBeNull();
  });

  it("multi-match: lazy capture returns the FIRST match (greedy bracket-search, lazy capture)", () => {
    expect(
      extractCombinationHint("[Combination: first] [Combination: second]"),
    ).toBe("first");
  });

  it("preserves special chars inside the captured value", () => {
    expect(extractCombinationHint("[Combination: foo.bar + baz.qux]")).toBe(
      "foo.bar + baz.qux",
    );
  });

  it("returns null on null input", () => {
    expect(extractCombinationHint(null)).toBeNull();
  });

  it("returns null on empty-string input", () => {
    expect(extractCombinationHint("")).toBeNull();
  });

  it("returns null on undefined input", () => {
    expect(extractCombinationHint(undefined)).toBeNull();
  });

  it("empty bracket '[Combination: ]' returns '' (empty string), not null", () => {
    // Pinned for backward compat — existing Path B records may carry empty
    // markers and downstream callsite already coerces null/empty to '' via
    // `?? ''`. Changing this to null would break that contract.
    expect(extractCombinationHint("[Combination: ]")).toBe("");
  });
});

describe("resolveTransformationIntent — Path D priority semantics (3 cases)", () => {
  it("populated transformation_intent wins over ai_reasoning marker", () => {
    expect(
      resolveTransformationIntent(
        "first_name + last_name",
        "Map full name. [Combination: legacy_marker]",
      ),
    ).toBe("first_name + last_name");
  });

  it("empty-string transformation_intent falls back to regex on ai_reasoning", () => {
    expect(
      resolveTransformationIntent("", "Map full name. [Combination: fallback]"),
    ).toBe("fallback");
  });

  it("whitespace-only transformation_intent falls back to regex (treated as absent)", () => {
    expect(
      resolveTransformationIntent(
        "   ",
        "Map full name. [Combination: fallback]",
      ),
    ).toBe("fallback");
  });
});
