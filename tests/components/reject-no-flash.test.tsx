// @vitest-environment node
//
// Source-level invariant tests for the Mapping page reject-flash fix.
// The fix introduces an optimistic-data override pattern that pre-
// applies the post-reject UnmappedRow shape BEFORE `router.refresh()`
// lands, masking the React unmount/remount that otherwise produced a
// 200-500ms blank flash on the inline path (and a sub-perceptual blip
// on bulk + drawer paths).
//
// Same readFileSync + regex strategy as
// tests/components/fix-history-identity.test.ts (PR #30) and
// tests/components/decisions-log-identity.test.ts (Item 2.2). Pins the
// data-flow extension at three call sites + the consumer in
// FieldMappingRow + the prop pass-through in TargetTableGroup.
//
// Invariants:
//   RF1.  MappingContent declares an `optimisticData` Map<string,
//         MappingRow> state slot.
//   RF2.  MappingContent declares a `buildUnmappedOverride` helper that
//         returns an UnmappedRow shape (kind: 'unmapped', status:
//         'unmapped', confidence: null).
//   RF3.  `handleRejectConfirm` (inline) calls `writeOptimisticData`
//         BEFORE `setOptimistic(rowId, 'rejecting')` — pin the
//         pre-fade-out ordering.
//   RF4.  `handleBulkConfirm` reject branch iterates `data.rows` and
//         calls `writeOptimisticData` for every mapped/value-assignment
//         row on the target table BEFORE `bulkRejectFieldMappingsForTargetTable`.
//   RF5.  `handleDrawerActionComplete` calls `writeOptimisticData`
//         when `action === 'reject'` BEFORE `router.refresh()` — pin
//         drawer-reject parity.
//   RF6.  Cleanup useEffect on `data.rows` change drops overrides
//         whose rowId is no longer present in the new rows.
//   RF7.  TargetTableGroup accepts `optimisticData?: Map<string,
//         MappingRow>` and threads it to FieldMappingRow.
//   RF8.  FieldMappingRow consumes the override via
//         `optimisticData?.get(providedRow.id) ?? providedRow`.
//   RF9.  Negative invariant — `handleRejectConfirm` still has
//         `setTimeout(() => router.refresh(), 200)` (the fade-out
//         duration is unchanged; only the data-shape override is new).
//   RF10. Negative invariant — the `isRejecting` className branch in
//         FieldMappingRow.tsx must NOT include `opacity-0`. This is
//         the test that would have caught the PR #58 failure mode:
//         opacity-0 made the optimisticData override invisible during
//         the rejection round-trip, reproducing the original blank
//         flash. Dropping opacity-0 (hotfix on PR #58) lets the
//         override actually render. Preserved: pointer-events-none +
//         -translate-x-1 (subtle slide cue + double-click guard).
//   RF11. Cleanup useEffect drops overrides where the row exists but
//         its `kind` disagrees with the override's `unmapped` claim.
//         Locks the Fix 2 hardening from the bulk-scope hotfix:
//         partial-bulk-failure rows + scope-mismatch rows must
//         self-heal on the next data.rows update.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const MAPPING_CONTENT = read(
  "app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx",
);
const TARGET_TABLE_GROUP = read(
  "app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup.tsx",
);
const FIELD_MAPPING_ROW = read(
  "app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow.tsx",
);

// Slice the body of a top-level `const <name> = useCallback(...)` so we
// can assert ordering inside a single handler without the body of an
// adjacent handler false-matching.
function sliceCallback(src: string, declStart: string): string {
  const a = src.indexOf(declStart);
  if (a < 0) throw new Error(`callback decl not found: ${declStart}`);
  // Find the matching `}, [...])` close — track brace depth crudely.
  // Each handler ends with `\n  ], )` or `\n  )` after the dep array.
  // Easiest stable boundary: the next `\n  const ` line at top-level
  // indentation.
  const b = src.indexOf("\n  const ", a + declStart.length);
  if (b < 0) return src.slice(a);
  return src.slice(a, b);
}

const HANDLE_REJECT_CONFIRM = sliceCallback(
  MAPPING_CONTENT,
  "  const handleRejectConfirm = useCallback",
);
const HANDLE_BULK_CONFIRM = sliceCallback(
  MAPPING_CONTENT,
  "  const handleBulkConfirm = useCallback",
);
const HANDLE_DRAWER_ACTION_COMPLETE = sliceCallback(
  MAPPING_CONTENT,
  "  const handleDrawerActionComplete = useCallback",
);

describe("[Mapping reject-flash fix] optimistic-data override — invariants", () => {
  it("RF1 — MappingContent declares optimisticData Map<string, MappingRow> state", () => {
    expect(MAPPING_CONTENT).toMatch(
      /const\s+\[optimisticData,\s*setOptimisticData\]\s*=\s*useState<\s*Map<string,\s*MappingRow>\s*>/,
    );
  });

  it("RF2 — buildUnmappedOverride returns UnmappedRow shape (kind/status pinned)", () => {
    expect(MAPPING_CONTENT).toMatch(
      /const\s+buildUnmappedOverride\s*=\s*useCallback/,
    );
    const overrideBody = sliceCallback(
      MAPPING_CONTENT,
      "  const buildUnmappedOverride = useCallback",
    );
    // The returned object literal must carry kind='unmapped' (the wire
    // shape the translator produces when no TFM points at the target)
    // and status='needs_review'. Post-PR-#157, reject is reject-as-reset:
    // `neutralizeCoverageForReject` lands the rejected target on a
    // neutral `needs_review`, with no distinct persisted `rejected`
    // state — so the override pre-applies that same end state.
    expect(overrideBody).toMatch(/kind:\s*['"]unmapped['"]/);
    expect(overrideBody).toMatch(/status:\s*['"]needs_review['"]/);
    // Negative — the stale 'rejected' literal must NOT reappear. Pre-fix
    // it mirrored a `coverage.status='rejected'` wire shape the server no
    // longer produces; left in place it re-surfaced as the reject→approve
    // revert bug (a leaked override masking the post-approve read).
    expect(overrideBody).not.toMatch(/status:\s*['"]rejected['"]/);
  });

  it("RF12 — buildUnmappedOverride short-circuits (returns null) for already-unmapped rows", () => {
    // fix/unmapped-reject-revert — the override masks the mapped /
    // value-assignment → unmapped *shape transition* during a reject. A
    // row that is already kind='unmapped' has no transition to mask, and
    // its row id (`unmapped::<targetFieldId>`) is stable across the
    // reject — so an override written for it never satisfies the cleanup
    // useEffect's drop conditions (RF6 / RF11: id-gone / kind-changed)
    // and leaks permanently, masking later server reads including a
    // subsequent approve. The helper must early-return before building
    // the override object when the source row is already unmapped.
    const overrideBody = sliceCallback(
      MAPPING_CONTENT,
      "  const buildUnmappedOverride = useCallback",
    );
    expect(overrideBody).toMatch(
      /if\s*\(\s*row\.kind\s*===\s*['"]unmapped['"]\s*\)\s*return null/,
    );
  });

  it("RF3 — handleRejectConfirm calls writeOptimisticData BEFORE setOptimistic('rejecting')", () => {
    const writeIdx = HANDLE_REJECT_CONFIRM.indexOf("writeOptimisticData(");
    const setOptIdx = HANDLE_REJECT_CONFIRM.indexOf(
      "setOptimistic(rowId, 'rejecting')",
    );
    expect(writeIdx).toBeGreaterThan(-1);
    expect(setOptIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeLessThan(setOptIdx);
  });

  it("RF4 — handleBulkConfirm reject branch writes overrides BEFORE bulkRejectFieldMappingsForTargetTable AND scopes to status === 'needs_review'", () => {
    // The bulk branch must iterate data.rows + call writeOptimisticData
    // before the await of the wrapper, AND its filter must include
    // `r.status === 'needs_review'` so the client-side override scope
    // matches the server's bulkRejectFieldMappingsForTargetTable filter
    // exactly. PR #61's bug was a wider client scope (no status filter)
    // that caused approved mappings to render as unmapped even though
    // the server didn't reject them.
    // Use `(` suffix on writeOptimisticData and \`({\` suffix on the
    // wrapper to anchor against actual call sites — comment-text
    // occurrences inside the bulk loop's prose (which mentions both
    // names) would otherwise return earlier indices.
    const writeIdx = HANDLE_BULK_CONFIRM.indexOf("writeOptimisticData(r");
    const wrapperIdx = HANDLE_BULK_CONFIRM.indexOf(
      "bulkRejectFieldMappingsForTargetTable({",
    );
    expect(writeIdx).toBeGreaterThan(-1);
    expect(wrapperIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeLessThan(wrapperIdx);
    // Status filter must appear in the bulk loop's row filter. Match
    // a relaxed pattern: `status` and `'needs_review'` adjacent within
    // a small window to allow whitespace/quoting variations.
    expect(HANDLE_BULK_CONFIRM).toMatch(
      /r\.status\s*===\s*['"]needs_review['"]/,
    );
  });

  it("RF5 — handleDrawerActionComplete writes override on action === 'reject' BEFORE router.refresh()", () => {
    // Single regex pins both the if-block + post-block ordering. Lazy
    // matchers keep the match scoped tightly. Searching with two
    // separate indexOf calls picks up `router.refresh()` mentions
    // inside the JSDoc-style comment block above the if; this regex
    // ignores those because it requires the literal call AFTER the
    // closing `}` of the if-block.
    expect(HANDLE_DRAWER_ACTION_COMPLETE).toMatch(
      /if\s*\(\s*action\s*===\s*['"]reject['"]\s*\)\s*\{[\s\S]*?writeOptimisticData\(rowId,\s*override\)[\s\S]*?\}\s*\n\s*router\.refresh\(\)/,
    );
  });

  it("RF6 — cleanup useEffect on data.rows reconciles overrides against settled server data", () => {
    // The cleanup useEffect: setOptimisticData((prev) => {...}) inside a
    // useEffect with [data.rows] deps. Pin existence + the
    // next.delete(rowId) reconciliation call. The specific predicate
    // (\`!row\` alone, vs the post-hotfix \`!row || row.kind !== 'unmapped'\`
    // disjunction) is locked separately by RF11.
    expect(MAPPING_CONTENT).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?setOptimisticData[\s\S]*?next\.delete\(rowId\)[\s\S]*?\},\s*\[data\.rows\]\s*\)/,
    );
  });

  it("RF7 — TargetTableGroup accepts optimisticData prop and threads it to FieldMappingRow", () => {
    expect(TARGET_TABLE_GROUP).toMatch(
      /optimisticData\?\s*:\s*Map<string,\s*MappingRow>/,
    );
    // Destructured from props.
    expect(TARGET_TABLE_GROUP).toMatch(/^\s*optimisticData,\s*$/m);
    // Forwarded to FieldMappingRow.
    expect(TARGET_TABLE_GROUP).toMatch(
      /optimisticData=\{optimisticData\}/,
    );
  });

  it("RF8 — FieldMappingRow consumes override via optimisticData?.get(providedRow.id) ?? providedRow", () => {
    expect(FIELD_MAPPING_ROW).toMatch(
      /optimisticData\?\s*:\s*Map<string,\s*MappingRow>/,
    );
    // The resolution line.
    expect(FIELD_MAPPING_ROW).toMatch(
      /const\s+row\s*=\s*optimisticData\?\.get\(providedRow\.id\)\s*\?\?\s*providedRow/,
    );
  });

  it("RF9 — handleRejectConfirm still uses setTimeout(() => router.refresh(), 200) for fade-out timing", () => {
    expect(HANDLE_REJECT_CONFIRM).toMatch(
      /setTimeout\(\(\)\s*=>\s*router\.refresh\(\)\s*,\s*200\s*\)/,
    );
  });

  it("RF10 — isRejecting className branch does NOT include opacity-0 (override must be visible)", () => {
    // The class branch keyed on `isRejecting` must not apply opacity-0
    // (or any opacity zeroing) — that hid the optimisticData override
    // throughout the rejection round-trip in PR #58. We allow
    // pointer-events-none + -translate-x-1 (slide cue + double-click
    // guard) but not anything that drives the row's opacity to 0.
    //
    // Strategy: locate the `isRejecting && '...'` className segment
    // and assert it does not contain the substring `opacity-0`. The
    // segment is a single string literal so a substring check is
    // sufficient and resists arbitrary class reordering.
    const m = FIELD_MAPPING_ROW.match(/isRejecting\s*&&\s*'([^']*)'/);
    expect(m, "isRejecting className branch not found").not.toBeNull();
    const classNames = m![1];
    expect(
      classNames,
      "isRejecting className branch contains opacity-0; got: '" + classNames + "'",
    ).not.toContain("opacity-0");
  });

  it("RF11 — cleanup useEffect drops overrides where row exists but kind !== 'unmapped' (Fix 2 self-heal)", () => {
    // The data.rows-keyed cleanup useEffect must drop overrides under
    // TWO conditions, not just absence:
    //   (a) `!row` — rowId no longer in data.rows (post-reject success)
    //   (b) `row.kind !== 'unmapped'` — rowId present but server didn't
    //       follow through (partial bulk failure, scope mismatch). The
    //       override claims unmapped; server says otherwise; defer to
    //       server.
    // Without (b), stale overrides linger until the next user action.
    // The bulk-scope hotfix (PR #61) added (b) as defense-in-depth so
    // future scope mismatches self-heal.
    //
    // Scope the regex to MappingContent.tsx since this is a single
    // useEffect with a known shape.
    const MAPPING_CONTENT = readFileSync(
      resolve(ROOT, "app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx"),
      "utf8",
    );
    // Match the cleanup useEffect block: must contain both
    // `if (!row || row.kind !== 'unmapped')` (or equivalent disjunction)
    // AND `[data.rows]` deps.
    expect(MAPPING_CONTENT).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?setOptimisticData[\s\S]*?if\s*\(\s*!row\s*\|\|\s*row\.kind\s*!==\s*['"]unmapped['"]\s*\)[\s\S]*?next\.delete\(rowId\)[\s\S]*?\},\s*\[data\.rows\]\s*\)/,
    );
  });
});
