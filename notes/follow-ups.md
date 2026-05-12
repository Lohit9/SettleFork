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
