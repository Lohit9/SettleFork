# Follow-ups

Tracked items that surfaced during PR work but are out-of-scope for the PR
that surfaced them.

---

## Path D: VA-only target tables produce no TM, breaks Transform page for those tables

**Surfaced by:** `feat/path-d-write-table-mappings` (2026-05-12)

**Shape:** Pass 2.6 (`persistTableMappings` in `lib/ai/path-d-persistence.ts`)
derives table_mappings rows from `MappingPayload.source_field_ids ×
target_field_id`. Mappings with empty `source_field_ids` (value
assignments / orphan target fields) contribute no pair and therefore
no TM row. This matches legacy semantics — in the pre-redesign flow,
VAs lived under TMs the AI table-pair generator had already created.

**The hole:** A hypothetical future Path D project where some target
table receives ONLY VA TFMs (no source-having TFM landing on the same
target table) will have no TM for that target table. The Transform page
filters non-rejected TMs and groups by target table, so that target
table will not appear in the Transform tree.

**Why not fixed in PR:** Test #7 doesn't exhibit this — its VAs
concentrate in Engineering Item Master, which already gets TMs from
source-having TFMs (Engineering BOM Masters and Products both map into
it). Punting until a real project surfaces the shape.

**Server-side fix sketch (when needed):** For each target table that
hosts a Path D TFM but has no source-having TFM, synthesize a TM with
a placeholder `source_table_id`. Two options:
 - Pick an arbitrary source table from the project's source datasets
   (LCD: first source table the AI surfaced anywhere).
 - Make `source_table_id` nullable (migration) — but that breaks the
   schema invariant every downstream consumer relies on.

Likely the first. Lives in `persistTableMappings` as a second pass
after the source-having pair derivation.

---

## Audit: 2 unattributed `table_mappings` rows pre-existed in Test #7

**Surfaced by:** `feat/path-d-write-table-mappings` backfill (2026-05-12)

**Shape:** STOP 1's read-only preview against settle-prod showed
`table_mappings` empty for project `0f2a95bb-1e80-4a8b-8e59-ae5559277730`
(0 rows). When the backfill INSERT ran later the same day, the `NOT
EXISTS` clause correctly skipped 2 of the 3 expected pairs and inserted
only 1 (`INSERT 0 1`). Post-COMMIT state shows 3 rows for the project,
2 of them created between the preview and the backfill run — outside
any documented persistence path:

- `a4aac30a-…` Engineering BOM Masters → Engineering Item Master
- `d45508d3-…` Products → Engineering Item Master
- `0eec1e57-…` Products → Inventory Commodity Code (← the 1 the backfill inserted)

**Functional impact:** None. End state is the same 3 TMs the backfill
would have produced. Transform page renders correctly. Founder confirmed
on localhost.

**Audit gap:** Two TM rows for a customer project were created outside
the documented Path D / legacy mapping-engine / backfill paths in the
~hour between STOP 1 preview and backfill execution. Possibilities:
 - A concurrent legacy `createTableMapping` action somewhere in
   `lib/actions/mappings.ts` that triggered between preview and backfill
   (a user click in the Mapping page on a different worktree).
 - A scheduled task or cron we don't track.
 - A platform-admin debug action.

**Why not chased now:** Demo timeline. Audit-only — no data integrity
issue.

**Post-demo:** Grep `activity_log` for the project around 2026-05-12
11:34-11:35 UTC and identify the actor + action. If user-triggered via
the UI, no further work. If from an unattributed path, surface that
path for explicit governance.

---

## Path D POC answer-key inlining duplicates `formatPocAnswerKeyBlock`

**Surfaced by:** `feat/transform-agent-context-blocks` (PR 1, 2026-05-12)

Path D uses bespoke POC answer-key inlining at
[`lib/ai/path-d-system-prompt.ts:672-684`](../lib/ai/path-d-system-prompt.ts#L672-L684)
(predates the shared `formatPocAnswerKeyBlock` helper added to
`lib/ai/context-builder.ts` in PR 1). Migrate Path D to call the shared
helper for consistency. Byte content is currently identical — the
poc-answer-key-block snapshot test pins the shared helper's bytes
against the inlining shape so any drift will be caught at test-time.

**Why not in PR 1:** Path D's user-message builder positions the POC
block last (immediately before `TASK`); moving the emission into
`formatDocumentsForPrompt` (the obvious "universal helper") would
relocate the block inside `<documentation>` and break Path D's
intentional positional-authority semantic. The shared-helper approach
preserves both call sites' positional control while still
deduplicating the byte content.

**Server-side fix sketch:** Replace the bespoke `pocBlock` construction
in `buildPathDUserMessage` with `formatPocAnswerKeyBlock(pocAnswerKey)`.
One-line change. Update or remove the Path-D-specific snapshot bytes
that exercise the inlining path.

---

## TransformContent toast does not surface VA-skip count

**Surfaced by:** `feat/transform-agent-context-blocks` (PR 1, 2026-05-12)

`autoGenerateAllTransforms` now returns
`{ success, generated, failed, skipped? }`, but
[`TransformContent.tsx`](../app/app/projects/%5BprojectId%5D/transform/TransformContent.tsx)'s
"Generating transforms..." toast reads only `generated` / `failed`.
Update the toast copy to include `"N skipped (already populated)"` when
`skipped > 0` so users understand why the count doesn't match TFM
total. Single-file UI tweak; separate PR per single-territory rule.
