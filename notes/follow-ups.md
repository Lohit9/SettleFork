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

## Orphan server action: previewEditInvalidation

**Surfaced by:** `feat/drawer-body-redesign` PR 3b (2026-05-12)

**Shape:** Server action `previewEditInvalidation` lives in
[lib/actions/mappings-for-redesign.ts:2211](lib/actions/mappings-for-redesign.ts#L2211).
Its only consumer was the drawer's `EditInvalidationDialog` —
which the drawer dispatched between the user's "Save changes" click
in the legacy inline `CreateMappingForm` (mode='edit') and the
actual `editMappingSources` call. The dialog warned the user when
the edit would invalidate N staged transformation rows.

**Why it's orphan now:** PR 3b retires `CreateMappingForm` +
`EditInvalidationDialog` entirely. Source edits now route through
the header's per-source ✏ → `InlineSourcePicker` → direct
`updateMappingSourceField` / `editMappingSources` calls. No preview
step intervenes; the server actions still emit `transformReset` +
`stagedRowsReverted` in their result for downstream toasts, but no
UI consumer reads them today.

**Why not dropped in PR 3b:** Single-territory rule — PR 3b stays
in `app/.../mapping/redesign/` + `tests/components/`. Touching
`lib/actions/` for a deletion is a separate cross-territory PR.
The action sits as orphan compiled-but-unused export.

**Drop in a future server-side cleanup PR.** Verify no consumers
remain (`grep -rn previewEditInvalidation app/ lib/ tests/`),
remove the action + its error-code union + result type. No
migration impact — the action is pure-read.
