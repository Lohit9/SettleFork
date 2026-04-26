# Phase 4 plan — mutation completeness

**Status:** implementation in progress (Phase 4a underway). Created 2026-04-25.
**Predecessor:** Phase 3 closed at `b900538` on `main`. The
redesign UI is feature-flag gated (`projects.use_mapping_redesign`)
and currently active only on Heritage Core in production.

### Implementation status

| Sub-phase | Scope | Status |
|---|---|---|
| Pre-prep | `ActionType` enum widening for new mapping log codes | ✅ shipped 2026-04-25 |
| 4a-1 | `createFieldMapping` + `suggestMappingForTarget` server wrappers (same-table only) | ✅ shipped 2026-04-25 |
| 4a-2 | `CreateMappingForm` + drawer integration (W1, manual mapping creation, same-table only) | ✅ shipped 2026-04-25 |
| 4a-3 | Cross-table picker + cross-table create flow (W1 cross-table) | ⏳ pending |
| 4a-4 | "Draft discarded" toast on row switch + UX polish | ⏳ pending |
| 4a-5 | W6 — AI Suggest per-row in W1's form | ⏳ pending |
| 4b | W2 + W3 + W4 (edit sources, combination, un-acknowledge) | ⏳ pending |
| 4c | W5 (bulk operations) | ⏳ pending |

This document is the design artefact we work through together
before firing each Phase 4 implementation prompt. Decisions
in §10 were locked at the start of 4a-1; nothing further locks
without explicit founder approval.

> **Cross-references:**
> - Design contract: `docs/features/phase-3-gap-4a-design.md`
> - Phase 3 closure: `docs/features/mapping-redesign.md` →
>   "Phase 3 closure — 2026-04-25"
> - Phase 3 read path: `lib/actions/_mappings-for-redesign-core.ts`
> - Phase 3 write path: `lib/actions/mappings-for-redesign.ts`
>   (Approve/Reject only)
> - Legacy actions: `lib/actions/mappings.ts` (2,943 LOC, 18 exports)
> - Legacy UI consumer: `app/app/projects/[projectId]/mapping/MappingContent.tsx` (4,008 LOC, retired in Phase 5-Cleanup)

---

## 1. Phase 4 scope overview

Phase 3 shipped the **read path + a 2-action mutation surface**
(`approveFieldMapping`, `rejectFieldMapping`). Phase 4 closes the
mutation gap so a customer-facing migration engineer can run a real
Heritage-style migration end-to-end without touching the legacy
`?mapping` page.

**Six workstreams** (priority order TBD; see §6 partitioning):

| # | Workstream | One-line scope |
|---|---|---|
| W1 | Manual mapping creation | Promote a Rule 6 unmapped target field into a Rule 1/2 mapped TFM by picking source(s) |
| W2 | Edit existing mapping sources | Add / remove `mapping_sources` rows on an existing TFM (Rule 1↔2 transitions) |
| W3 | Edit combination strategy | Change `combination_type` (single / concat_space / concat_comma / custom_sql) on a mapped TFM |
| W4 | Un-acknowledge target field | Delete the `is_acknowledged=true` TFM row, returning the field to Rule 6 |
| W5 | Bulk operations | Approve all / Reject all (project-wide and/or per target table) |
| W6 | AI Suggest per-row | Trigger LLM-suggested mapping(s) for an unmapped target field from inside the drawer |

Mutations **out of scope** for Phase 4 (deferred to either
Phase 4-extras or Phase 5):
- Source-side acknowledgment toggle (`acknowledgeField` /
  `removeAcknowledgment` for source side) — already supported by
  the legacy action; surfaces in the sidebar Unmapped pill but no
  redesign UI affordance shipped or planned for Phase 4
- Inline value-assignment SQL editing (lives on the Transform tab,
  not the Mapping page)
- Manual table-mapping creation (`addManualTableMapping`) — Phase 5
  workflow only after `MigrationCenter` redesign
- Regenerate all mappings on a TM (`regenerateFieldMappings`) —
  destructive, used during initial setup; legacy CTA stays in
  legacy UI

---

## 2. Investigation summary — legacy mutation surface

### 2.1 Mutation actions inventory (lib/actions/mappings.ts)

Eighteen exports. The seven that Phase 4 wraps are bolded:

| Action | LOC | Activity log? | Role-perm? | guardWrites? | Phase 4 use |
|---|---|---|---|---|---|
| `getMappings` | 851-1111 | — | implicit | — | (read; superseded) |
| `recomputeTableMappingStatus` | 1112-1210 | no | inherited | inherited | helper |
| `handleTargetFieldConflict` | 1211-1284 | no | inherited | inherited | helper |
| `cleanupOrphanedContributors` | 1285-1299 | no | inherited | inherited | helper |
| **`updateFieldMappingStatus`** | 1300-1398 | yes | yes | yes | wrapped (Gap 9) |
| `updateTableMappingStatus` | 1399-1442 | no | yes | yes | not in Phase 4 |
| **`editFieldMapping`** | 1443-1609 | **NO** | yes | yes | **W2 + W3** |
| **`addManualFieldMapping`** | 1630-1785 | **NO** | yes | yes | **W1** |
| `addManualTableMapping` | 1800-1856 | no | yes | yes | not in Phase 4 |
| **`deleteFieldMapping`** | 1867-1995 | no (caller logs) | yes | yes | wrapped (Gap 9), reused by W2 |
| `deleteTableMapping` | 1996-2089 | no | yes | yes | not in Phase 4 |
| **`mapUnmappedField`** | 2090-2140 | **NO** | yes | yes | **W1 alt path** (find-or-create TM + `addManualFieldMapping`) |
| `replaceValueAssignment` | 2155-2181 | no | inherited | inherited | helper inside W1 |
| `createValueAssignment` | 2203-2267 | **NO** | yes | yes | not in Phase 4 (Transform-tab work) |
| `regenerateFieldMappings` | 2277-2437 | no | yes | yes | not in Phase 4 |
| **`approveAllFieldMappings`** | 2438-2598 | **NO** | yes | yes | **W5 (per-TM)** |
| **`rejectAllFieldMappings`** | 2602-2665 | **NO** | yes | yes | **W5 (per-TM)** |
| **`approveHighConfidenceMappings`** | 2669-2713 | **NO** | yes | yes | **W5 (project-wide)** |
| **`suggestRemainingMappings`** | 2717-2943 | no (LLM cost) | yes | yes | **W6 (per-TM)** |

And in `lib/actions/field-acknowledgments.ts`:

| Action | LOC | Activity log? | Phase 4 use |
|---|---|---|---|
| `acknowledgeField` | 117-203 | no | — (already covered by Phase 3 read path; only un-ack needs a write affordance) |
| **`removeAcknowledgment`** | 204-249 | **NO** | **W4** |

### 2.2 Activity-log gap

The current `ActionType` enum (`lib/actions/activity-log.ts:6-25`)
contains exactly two mapping-write events: `mapping_approved`,
`mapping_rejected`. Today only `updateFieldMappingStatus` (legacy)
and `rejectFieldMapping` (Gap 9 wrapper) emit log entries.

**Eight legacy mutation actions emit zero audit-trail events.**
Manual creation, edit, mapUnmapped, removeAcknowledgment, all
bulk variants, suggestRemaining — silent. The Gap 9 wrapper
already establishes the pattern of layering audit logging *on top
of* the legacy action when the legacy doesn't log itself.

**Recommendation:** Phase 4 wrappers carry the logging
responsibility for every mutation they expose. Each W1–W5 wrapper
emits exactly one event using a new (or reused) `ActionType`.
W6 logs zero (LLM rate-limited; logging it would dwarf the rest of
the audit trail with low-signal noise).

**New `ActionType` values needed** (one DB schema addition; the
column is `TEXT` so this is just an enum widening, no migration
beyond updating the discriminated union):

| New value | Emitted by | Reuse? |
|---|---|---|
| `mapping_created` | W1 (manual creation), W6 (each suggested mapping persisted) | new |
| `mapping_sources_changed` | W2 (add/remove a source on a TFM) | new |
| `mapping_combination_changed` | W3 (combination_type change) | new |
| `acknowledgment_removed` | W4 (un-acknowledge target) | new |
| `mapping_bulk_approved` | W5 (`approveAllFieldMappings`, `approveHighConfidenceMappings`) | new |
| `mapping_bulk_rejected` | W5 (`rejectAllFieldMappings`) | new |

Alternative: reuse `mapping_approved` for W1 (manual creates are
auto-approved per `addManualFieldMapping` line 1773-1777) — but
this conflates "user manually authored a new mapping" with "user
clicked Approve on an AI-generated mapping" in the audit trail,
which loses signal. Recommend distinct event types.

### 2.3 Wrapper pattern (carried forward from Gap 9)

`lib/actions/mappings-for-redesign.ts` establishes the pattern:

1. Decode redesign `rowId` shim format → resolved TFM/source ids
2. Pre-flight defenses (sentinel rejection, acknowledged-row guard)
3. Identity snapshot for activity-log payload (BEFORE delete)
4. Delegate to legacy action (it owns auth, perm, guardWrites,
   coverage recompute)
5. Race-condition handling (return `alreadyDeleted: true` on
   already-gone TFMs)
6. Emit activity log AFTER successful delegate
7. Return redesign-shaped result (typed, error-coded)

Phase 4 wrappers follow this same shape. Translation pieces
(steps 1, 2, 3, 6, 7) are wrapper-side; the actual write
(step 4) stays in legacy land. **No code is moved from
`lib/actions/mappings.ts` to `lib/actions/mappings-for-redesign.ts`
during Phase 4** — the duplication risk is zero, and Phase 5
retires the *legacy UI consumers*, not the legacy actions
themselves (the actions stay; only `MappingContent.tsx` and
`TransformContent.tsx` get deleted).

### 2.4 UI-coupled return shapes

`addManualFieldMapping` returns
`{ data?: { id: string; is_contributing: boolean }, ... }` —
where the `id` is either a bare TFM uuid (primary path) or
`<tfmId>::<mappingSourceId>` (contributor path). This format is
the legacy *shim row id*, and is identical to the redesign's
`tfm-primary` / `tfm-contributor` decode keys (see
`lib/compat/mapping-shim.ts:decodeShimmedRowId`). So the wrapper's
returned id is directly usable as a redesign `rowId` — no
translation needed.

`editFieldMapping` returns a richer shape (`transformReset`,
`stagedRowsReverted`, `valueAssignmentReplaced`, etc.). The Gap 9
`RejectMappingResult` already plumbed `transformReset` and
`stagedRowsReverted` through. Phase 4 W2/W3 wrappers can pass the
full shape through unchanged.

### 2.5 Form library landscape

**No form library is installed.** `package.json` audit:

- ❌ `react-hook-form`, `@hookform/resolvers`
- ❌ `zod`, `yup`, `joi`, `valibot`
- ❌ `formik`
- ✅ `@radix-ui/react-select` (only Radix package)
- ✅ `class-variance-authority`, `tailwind-merge`, `lucide-react`

Existing forms in the codebase (drawer footer, legacy
`InlineAddFieldRow`, validation rule editor) all use the same
hand-rolled idiom:

```tsx
const [field, setField] = useState('')
const [pending, startTransition] = useTransition()
const [error, setError] = useState<string | null>(null)
```

Plus optional `useState` for confirm-dialog / dirty-state where
needed. Validation is inline (`if (!srcId) return`) — no schema
layer.

**Recommendation:** stay with hand-rolled forms. See §7 for
detailed reasoning.

---

## 3. UX flow — W1 (manual mapping creation)

### 3.1 Today's affordances vs Phase 4 target

Today the redesign drawer body for a Rule 6 (unmapped) target
field renders the prose:

> Remapping unmapped fields is coming soon. For now, use the
> legacy Mapping view to create a new mapping.

This was the Gap 9 amendment (`UnmappedBody`,
`MappingDrawer.tsx:927-957`). Phase 4 W1 replaces this prose with
a real source picker + create CTA.

### 3.2 Recommended flow — in-drawer inline form

**Why in-drawer, not a modal:**

1. The drawer is already the focused write surface. Opening a
   modal *on top of* the drawer = two stacked overlays = poor a11y
   focus management and visual hierarchy.
2. The drawer is wide enough (480px) to fit a single-column form.
3. The drawer already owns the "selected target field" context
   (`row.targetField`); a modal would have to receive it as a prop
   and re-display it.
4. Symmetry with W2 (edit-in-place on mapped row drawer) — both
   workstreams use the same drawer-as-form pattern.

**Wireframe (Rule 6 unmapped drawer body, post-W1):**

```
┌─ Drawer header ────────────────────────────────────────┐
│  Unmapped target field                                 │
│  customers.email_address                               │
└────────────────────────────────────────────────────────┘
┌─ Body ─────────────────────────────────────────────────┐
│                                                        │
│  Target field                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │ customers.email_address  (TEXT)                  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  Create mapping                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Source field          [select source field…  ▾] │  │ ← Radix Select
│  │                                                  │  │   filtered to
│  │ + Add another source  (appears after first       │  │   matching
│  │                        selection)                │  │   source-table
│  │                                                  │  │   only when 1+
│  │ [ Suggest with AI  ]   ← optional W6 affordance  │  │
│  │                                                  │  │
│  │ ┌─ Preview ─────────────────────────────────────┐│  │
│  │ │ Source samples: "alice@x.com", "bob@y.com"    ││  │ ← reuses
│  │ │ Type: TEXT → TEXT  (compatible)               ││  │   formatSampleValues
│  │ └───────────────────────────────────────────────┘│  │   from drawer
│  │                                                  │  │
│  │ [Cancel]                       [ Create mapping ]│  │ ← primary action
│  └──────────────────────────────────────────────────┘  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**State machine:**

```
idle ─(user picks source)→ ready
ready ─(user clicks "+ add another")→ ready (multi-source)
ready ─(user clicks "Create mapping")→ saving
saving ─(success)→ closed (drawer body morphs to mapped row)
saving ─(failure)→ ready + inline error banner
```

**Source picker scope:**

The picker shows source fields from the **same source table** as
the target's parent table mapping. Reasoning: today's data model
treats cross-table mapping as a separate concept (multiple TMs
with the same target table), and the drawer already knows the
target's TM context (`row.targetTable`, `row.tableMappingId`). To
add a source from a *different* source table, the user creates a
separate TM first (legacy `addManualTableMapping`, out of W1
scope) — same flow as today's legacy `InlineAddFieldRow`.

Multi-source mappings (concat_space / concat_comma) are supported
by W1 from day one: the "+ Add another source" affordance appears
after the first source is picked, and on submit, the wrapper calls
`addManualFieldMapping` once for the primary, then once per
contributor (with `isContributing=true`). Identical pattern to
legacy `MappingContent.tsx:655-660`. Combination strategy at
creation time defaults to `concat_space` (legacy default); the
user can edit it later via W3.

**Error states:**

- `TARGET_CONFLICT` — race condition (another caller created a
  mapping at this target between drawer open and submit).
  Response: show inline error "Target field already has a mapping
  — refresh and try again." with refresh CTA.
- `VALIDATION` — at least one source field is required. Caught
  client-side; submit button disabled until first source picked.
- `INTERNAL` — generic "Couldn't create mapping. Please try
  again." (Gap 9 copy convention).
- `PERMISSION_DENIED` — should not occur in practice (drawer is
  gated by row-click which is gated by `useProjectRole`); fall
  back to generic error.

**Post-create behavior:**

On success the drawer transitions from Rule 6 body to Rule 1/2
mapped body via the existing `router.refresh()` + drawer remount
path (Gap 9 `handleDrawerActionComplete`). The drawer stays open
(symmetric with Approve, asymmetric with Reject which closes —
mapping creation preserves row identity, like Approve).

**Activity log payload:**

```ts
// Single-source (Rule 1)
{
  action_type: 'mapping_created',
  description: 'Mapping created: customers.email → customers.email_address',
  metadata: {
    target_field_mapping_id: <tfmId>,
    target_field: 'email_address',
    source_fields: ['email'],
    combination_type: 'single',
    source: 'manual',  // distinguishes from W6 'ai_suggested'
  }
}

// Multi-source (Rule 2)
{
  action_type: 'mapping_created',
  description: 'Mapping created: customers.[fname, lname] → customers.full_name',
  metadata: {
    target_field_mapping_id: <tfmId>,
    target_field: 'full_name',
    source_fields: ['fname', 'lname'],
    combination_type: 'concat_space',
    source: 'manual',
  }
}
```

### 3.3 Wrapper signature

```ts
// lib/actions/mappings-for-redesign.ts
export interface CreateMappingRequest {
  /** Sentinel rowId from a Rule 6 row: 'unmapped::<targetFieldId>'. */
  unmappedRowId: string
  /** Ordered: ordinal[0]=primary, ordinal[1+]=contributors. */
  sourceFieldIds: string[]
  /** Defaults to 'single' for 1 source, 'concat_space' for 2+. */
  combinationType?: 'single' | 'concat_space' | 'concat_comma'
  /** User-supplied if any. Defaults to "Manually mapped by user". */
  aiReasoning?: string
}

export interface CreateMappingResult extends MappingActionResult {
  /** The new TFM's redesign rowId for drawer remount. */
  newRowId?: string
  /** Contributor rowIds (only when sourceFieldIds.length > 1). */
  contributorRowIds?: string[]
}

export async function createMapping(
  req: CreateMappingRequest,
): Promise<CreateMappingResult>
```

Internally: decode `unmappedRowId` to extract `targetFieldId` →
look up the project's TM for `(sourceTable.id, targetField.tableId)`
→ delegate to `addManualFieldMapping(tmId, primaryId, targetId)`
→ if more sources, loop with `isContributing=true` for each →
emit one `mapping_created` activity-log entry with the full
source roster.

If the TM doesn't exist (rare for in-source-table mappings;
common only when manually creating a mapping for a target field
whose source-side counterpart hasn't been ingested yet), delegate
to `mapUnmappedField` instead — it find-or-creates the TM
automatically.

---

## 4. UX flow — W2 + W3 (edit existing mapping)

### 4.1 Combined or separate?

**Recommendation: combined.** W2 (sources) and W3 (combination)
share the same drawer surface (the `MappedBody` Sources +
Combination sections) and the same wrapper backing
(`editFieldMapping` and `deleteFieldMapping` for individual
mapping_sources rows). Splitting them adds wrapper churn without
clean UX boundaries. Treat them as a single "edit mapping" gap.

### 4.2 Wireframe — mapped row drawer body, post-W2/W3

The current `MappedBody` (Phase 3 Gap 8b) renders Sources and
Combination as read-only sections. W2/W3 adds inline editability:

```
┌─ Body — MappedBody (Rule 1 example, single source) ────┐
│                                                        │
│  Target field                                          │
│  customers.full_name (TEXT)                            │
│                                                        │
│  Sources                                               │
│  ┌──── SourceCard ─────────────────────────────────┐   │
│  │ customers.first_name      [TEXT]                │   │
│  │ Confidence: 92%                                 │   │
│  │ Reasoning: "Direct semantic match for first…"   │   │
│  │ Samples: "Alice", "Bob", "Carol"                │   │
│  │                                          [⋯ ▾ ] │   │ ← actions menu
│  │                                                 │   │   { Edit source,
│  │                                                 │   │     Remove source }
│  └─────────────────────────────────────────────────┘   │
│                                                        │
│  + Add another source                                  │ ← shown when
│                                                        │   row.kind = 'mapped'
│                                                        │
│  Combination                                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Strategy: [ Single source           ▾ ]   [Edit]│   │ ← inline edit
│  │   Single source / Concat (space) /              │   │   on click → enables
│  │   Concat (comma) / Custom SQL                   │   │   the dropdown
│  └─────────────────────────────────────────────────┘   │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**Per-source actions menu (… on each SourceCard):**

- **Edit source** → swaps the SourceCard into an inline form with
  a Radix Select for source field replacement. Save triggers
  `editFieldMapping(rowId, { source_field_id: <newId> })`.
- **Remove source** → confirmation dialog ("Remove this source?
  The mapping's combination strategy will be re-evaluated.").
  - If TFM has 1 source remaining: "Remove this source? The
    mapping will be deleted." → `deleteFieldMapping(<tfm-primary id>)`
  - If TFM has 2+ sources and removing the contributor: delete the
    `mapping_sources` row only via
    `deleteFieldMapping(<tfm-contributor id>)` (legacy already
    handles the demotion to `combination_type='single'` when the
    last contributor is removed — see `mappings.ts:1860-1995`).
  - If removing the **primary** (ordinal=0) of a multi-source
    TFM: legacy `deleteFieldMapping` returns
    `{ success: false, error: 'Cannot delete the primary source…' }`
    (see line 1862-1864). UX defense: hide the Remove option on
    the primary card when contributors exist, surface "Remove
    primary by promoting a contributor first" tooltip.

**Combination strategy edit:**

Inline edit: click the [Edit] button → the Strategy field becomes
an editable Radix Select. Save calls a new wrapper
`updateCombination(rowId, combinationType)` which delegates to
`editFieldMapping(rowId, { /* not currently a field */ })` — but
combination_type is **not** a field on legacy `editFieldMapping`'s
update interface. **This is the one piece that requires extending
the legacy action** (or alternatively, a new
`updateMappingCombination` action that goes direct to the DB).

**Recommendation:** add a new server action
`updateMappingCombination(rowId, combinationType)` in
`lib/actions/mappings-for-redesign.ts` that does the
`UPDATE target_field_mappings SET combination_type = $1 WHERE id = $2`
directly (with auth, perm, guardWrites, and activity log around
it). The legacy `editFieldMapping` is left untouched. This avoids
risky surgery in a 4,000-LOC legacy action and keeps the redesign-
side write path narrow.

For `combination_type='custom_sql'` transitions: this is a
significant operation (the TFM's combination_sql column becomes
relevant, the Transform tab takes over evaluation). For Phase 4,
**block** the transition into / out of `custom_sql` from the
redesign drawer with a tooltip "To convert this mapping to custom
SQL, use the Transform tab." Custom-SQL mappings are a Transform-
tab concern; the redesign drawer should not handle that lifecycle.

### 4.3 Cancel / dirty-state handling

The drawer already has a click-outside dismiss handler. With
in-place edits this becomes "what about unsaved changes?":

**Recommendation:** trust the user to tap Save / Cancel
explicitly; do not block dismissal. Each field's edit is local
state — closing the drawer discards uncommitted edits silently.
This matches the legacy UI's behavior (it has no "unsaved changes"
guard rail either) and keeps drawer dismissal cheap.

If users complain in Heritage smoke-test, add a single optimistic-
lock strategy: a debounced auto-save 1.5s after last keystroke,
with a "Saving…" indicator. (Defer until after smoke-test
feedback.)

### 4.4 Optimistic vs request-response

- **W2 add source** → request-response (the new SourceCard needs
  a real id from the server).
- **W2 remove source** → request-response (deletion is destructive;
  optimistic adds rollback complexity).
- **W2 change source field** → optimistic (cheap, the visual
  changes are bounded to the SourceCard's own labels).
- **W3 change combination** → optimistic (a single field flip).

This matches the Gap 9 pattern: Approve = optimistic, Reject =
request-response.

---

## 5. UX flow — W4 (un-acknowledge), W5 (bulk), W6 (AI suggest)

### 5.1 W4 — un-acknowledge target field

Smallest surface in Phase 4. The acknowledged-row drawer (Rule 5)
currently has **no footer actions** — both Approve and Reject
are disabled with tooltips (`AcknowledgedFooterButtons`,
`MappingDrawer.tsx:1470-1502`). W4 adds an **"Un-acknowledge"**
button to the footer for acknowledged rows.

**Wireframe — acknowledged row drawer footer (post-W4):**

```
┌─ Drawer footer ────────────────────────────────────────┐
│  This field is acknowledged as intentionally unmapped. │
│                                                        │
│                              [ Un-acknowledge ]        │ ← new
└────────────────────────────────────────────────────────┘
```

**Confirmation:** "This will remove the acknowledgment and the
field will return to the unmapped list. Continue?" → on confirm,
call new wrapper `unacknowledgeField(rowId)` which delegates to
`removeAcknowledgment(projectId, fieldId)`.

**Post-action behavior:** drawer closes, parent calls
`router.refresh()`, the field reappears as Rule 6 in the main
view. (Same shape as Reject — destructive, dissolves row identity.)

**Activity log:**
```
'acknowledgment_removed': 'Acknowledgment removed: customers.middle_name'
```

### 5.2 W5 — bulk operations

Three discrete bulk actions exist in legacy:

1. `approveAllFieldMappings(tableMappingId)` — per-TM approve
2. `rejectAllFieldMappings(tableMappingId)` — per-TM reject
3. `approveHighConfidenceMappings(projectId, threshold)` — project-
   wide, opinionated (status='needs_review' AND confidence ≥ 85)

**Recommended UI placement:**

- **Per-TM Approve all / Reject all:** add to the TargetTableGroup
  header, next to the existing chevron and "M of N" counter.
  ```
  ┌─ TargetTableGroup header ────────────────────────────┐
  │  ▾  customers (table)         [ ⋯ ▾ ]    8 of 12     │
  │                                  ↑                   │
  │                                  Approve all         │ ← new
  │                                  Reject all          │ ← new
  └──────────────────────────────────────────────────────┘
  ```
- **Project-wide Approve high-confidence:** add to the FilterRow
  next to the search box, gated to admin-role users only (the
  threshold knob can stay defaulted to 85 — the legacy UI
  hardcodes it too).

**Confirmation dialogs:**

Reject-all is high-blast-radius (deletes potentially dozens of
TFMs in one click). Strong confirmation:
- "Reject all 12 mappings on customers? Each rejected mapping is
  deleted; the target fields will appear as unmapped. This cannot
  be undone."
- Confirm button copy: "Reject all 12"

Approve-all is reversible (each user can re-Reject individually):
- "Approve all 12 needs-review mappings on customers?"
- Confirm button copy: "Approve all 12"

Approve-high-confidence is the most impactful project-wide:
- "Approve all needs-review mappings with confidence ≥ 85% across
  this project? This will affect approximately N mappings."
  (N computed by a pre-flight count query.)

**Optimistic vs request-response:**

All three: request-response. Bulk actions can affect dozens of
rows; optimistic UI for that scale tends to either jank or
silently desync if anything fails partway. The drawer's Approve
optimistic pattern doesn't generalize.

**Activity log:**

One entry per bulk operation, summarizing the count:
```
'mapping_bulk_approved':
  'Bulk approve: 12 mappings on customers'
  metadata: { table_mapping_id, count: 12, scope: 'table_mapping' }

'mapping_bulk_approved':
  'Bulk approve: 27 high-confidence mappings (≥85%) project-wide'
  metadata: { project_id, count: 27, scope: 'project_high_confidence', threshold: 85 }
```

### 5.3 W6 — AI Suggest per-row

**Tension:** legacy's `suggestRemainingMappings` is **per-TM**, not
per-row. It enumerates all unmapped source/target pairs in a TM,
sends them to the LLM, and persists every suggestion. There is no
existing per-row LLM call.

Two options for W6:

**Option A: per-row from drawer (recommended)** — when the user
opens the drawer on a Rule 6 unmapped target field, surface an
"AI suggest" button next to the W1 source picker:

```
Create mapping
  Source field          [select source field…  ▾]
  + Add another source

  ─ or ─

  [ ✨ Suggest with AI ]   ← new W6 affordance
```

Click → spinner → LLM returns a single suggestion (best match for
this specific target field) → form pre-fills with the suggested
source(s) and combination → user reviews and clicks "Create
mapping" (which is the W1 path; the LLM is just pre-filling the
form).

**Implementation:** new server action `suggestMappingForTarget(targetFieldId)`
that's a single-target subset of `suggestRemainingMappings`. It
runs the same context-builder + Claude call but for one target
only, with a minimal source-field shortlist. Returns the proposal
shape:
```ts
{
  source_fields: { id: string; name: string; reasoning: string }[]
  combination_type: 'single' | 'concat_space' | ...
  confidence: number
}
```

The redesign UI just renders this as a fillable form — the user
explicitly clicks Create to persist (no auto-save). This keeps W6
as a **W1 sub-affordance**, not a separate write path.

**Option B: bulk legacy reuse** — surface the legacy
`suggestRemainingMappings` as a per-TM bulk action (similar to
W5 placement on TargetTableGroup header). Less surgical, fires
the LLM for every unmapped target in the TM in one click.

**Recommendation: Option A first.** It's the more useful primitive
(per-row), forces good UX (review before commit), and the per-TM
legacy bulk variant can ship as a fast-follow if Heritage smoke-
test reveals a need.

**Rate limiting:** legacy already uses `checkAIRateLimit(user.id)`
inside `suggestRemainingMappings`. The new per-row action calls
the same check. UI surfaces rate-limit errors as inline banners
("AI Suggest is rate-limited. Try again in N seconds.").

**Activity log:** none. LLM cost telemetry already lives in the
rate-limiter; activity log is a user-action audit trail, and
"clicked Suggest" is too granular to be useful at audit-trail
scale.

---

## 6. Phase 4 partitioning proposal

### 6.1 Recommended partition

Three sub-phases, ordered by user-facing value × risk × pre-req
chain:

**Phase 4a — manual mapping creation (W1 + W6)**
- Wraps `addManualFieldMapping`, `mapUnmappedField`,
  new `suggestMappingForTarget`
- Replaces the Rule 6 drawer body's "coming soon" prose with a
  real source picker + W6 affordance
- New `mapping_created` ActionType
- **Founder value:** high — turns the redesign UI from
  "view-only with limited mutations" into "actually usable for
  fresh migrations"
- **Risk:** medium — first multi-source UX pattern in the redesign
- **Estimate:** 3-4 sessions
  - 1 session: wrapper + types + activity-log enum widening +
    server tests
  - 1-2 sessions: W1 inline form UX (Radix Select wiring,
    multi-source affordance, error states, drawer body refactor)
  - 1 session: W6 AI suggest integration + per-row LLM action +
    smoke test

**Phase 4b — edit existing mapping (W2 + W3 + W4)**
- Wraps `editFieldMapping`, `deleteFieldMapping` (already wrapped),
  `removeAcknowledgment`, new `updateMappingCombination`
- Adds inline-edit affordances to MappedBody Sources +
  Combination sections; adds Un-acknowledge footer button to
  AcknowledgedBody
- New ActionTypes: `mapping_sources_changed`,
  `mapping_combination_changed`, `acknowledgment_removed`
- **Founder value:** medium-high — closes the "I have to drop
  back to legacy to fix a wrong mapping" gap
- **Risk:** low-medium — heavy reuse of W1's Radix Select source
  picker + Gap 9 confirmation-dialog pattern
- **Estimate:** 2-3 sessions
  - 1 session: wrappers + new `updateMappingCombination` action +
    server tests
  - 1-2 sessions: SourceCard ⋯ menu + inline-edit transitions +
    confirmation dialog reuse + smoke test

**Phase 4c — bulk operations (W5)**
- Wraps `approveAllFieldMappings`, `rejectAllFieldMappings`,
  `approveHighConfidenceMappings`
- Adds CTAs to TargetTableGroup header + FilterRow
- New ActionTypes: `mapping_bulk_approved`, `mapping_bulk_rejected`
- **Founder value:** medium — high blast-radius operations,
  benefits power users on Heritage-scale projects (99 fields × 9
  TMs); marginal benefit on smaller projects
- **Risk:** medium — confirmation dialog copy is high-stakes, edge
  cases (race conditions on concurrent edits during a bulk
  approve) need design
- **Estimate:** 2 sessions
  - 1 session: wrappers + activity-log enum + server tests
  - 1 session: TargetTableGroup header CTAs + FilterRow project-
    wide CTA + confirmation dialogs + smoke test

**Total Phase 4 estimate: 7-9 sessions.**

### 6.2 Why this partition

- **4a is the single biggest user-value unlock.** Heritage Core
  cannot run a fresh migration through the redesign UI today
  because there's no way to create a mapping. Shipping 4a removes
  the last "must use legacy" gate.
- **4b builds on 4a's primitives.** The Radix Select source
  picker, the inline form pattern, and the error-banner copy
  conventions all carry over. Implementing 4b after 4a maximizes
  reuse.
- **4c is the most independent.** It touches different surface
  area (TargetTableGroup header, FilterRow) and reuses zero of
  4a/4b's UX primitives. Could ship before 4b if priorities shift.

### 6.3 Alternative partitions considered

- **Single-prompt Phase 4** (all six workstreams in one commit):
  rejected. Too large for QA / smoke-test surface. ~15-day risk
  blob with no intermediate value milestones.
- **Per-workstream partitioning** (six gaps, one per workstream):
  rejected. W2/W3 are too small individually; W6 makes more sense
  bundled with W1; W4 is 1/2 day on its own. Six gaps adds commit
  noise without adding QA confidence.
- **Mutation-shape partitioning** (W1 alone; W2/W3/W4 together;
  W5/W6 together): considered but inferior to the recommended
  partition. W6 belongs adjacent to W1 because they share the
  drawer Rule 6 body.

---

## 7. Form library / state management

### 7.1 Recommendation

**Stay with hand-rolled forms.** No new dependencies. Justification:

- Phase 4 forms are small: W1 has 1-3 fields (source picker[s] +
  optional combination override); W2/W3 are 1-field inline edits;
  W4 is a single button + confirm; W5 is buttons + confirm; W6 is
  a single button.
- The redesign codebase already has a robust idiom: `useState` +
  `useTransition` + manual error/dirty state. Drawer footer
  (Approve/Reject), legacy InlineAddFieldRow, validation rule
  editor — all use this idiom successfully.
- React-hook-form + Zod is ~30 KB gzipped + a learning curve. For
  6 small forms across three sub-phases, it's net negative.
- Validation is so simple that schema-based is overkill: "at least
  one source field selected" (W1), "combination_type is one of 4
  literals" (W3), etc. Inline `if` guards suffice.

If a future workstream introduces a complex form (e.g., custom-SQL
editor with syntax validation), revisit this decision. Phase 4
doesn't trigger that revisit.

### 7.2 Standardized idiom for Phase 4 forms

Codify the existing idiom as a Phase 4 convention:

```tsx
function W1CreateMappingForm({ row, onComplete }: ...) {
  const router = useRouter()
  const [sourceFieldIds, setSourceFieldIds] = useState<string[]>([])
  const [combinationType, setCombinationType] = useState<...>('single')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const canSubmit = sourceFieldIds.length > 0 && !pending

  function handleSubmit() {
    if (!canSubmit) return
    setError(null)
    startTransition(async () => {
      const result = await createMapping({
        unmappedRowId: row.id,
        sourceFieldIds,
        combinationType,
      })
      if (!result.success) {
        setError(result.error ?? GENERIC_CREATE_ERROR)
        return
      }
      onComplete(result.newRowId)
      router.refresh()
    })
  }

  return ( /* JSX */ )
}
```

Reused across W1, W2 (sources edit), W3 (combination edit), W4
(un-ack), W5 (bulk), W6 (suggest).

### 7.3 Confirm-dialog idiom

Reuse the Gap 9 `RejectConfirmDialog` pattern (`MappingDrawer.tsx:1526`).
Each Phase 4 confirm-required action gets its own dialog component
following the same shape: aria-modal, focus-trap, locked copy,
loading state on confirm button.

For Phase 4c bulk dialogs (the highest-blast-radius), add a typed
preflight count to the dialog body so users see "Reject all 12
mappings" not "Reject all". The wrapper computes the count
client-side from the existing `MappingsForRedesignResult` rows
array — no extra round-trip.

---

## 8. Pre-Phase-4 dependencies

### 8.1 Activity-log enum widening (1 session, prerequisite)

The `ActionType` discriminated union in
`lib/actions/activity-log.ts` needs to add the six new event types
listed in §2.2 *before* any Phase 4 wrapper can ship. The
underlying `activity_log.action_type` column is `TEXT` so no DB
migration is needed; just a TypeScript union widening + a brief
audit of existing call sites to ensure exhaustive switch
statements stay healthy.

**Recommendation:** ship this as a tiny standalone commit
("Phase 4 prep — widen ActionType for mapping mutations") right
before 4a starts. Keeps the 4a commit focused on the user-facing
work.

### 8.2 No other pre-reqs identified

- Database schema: no migrations needed for any Phase 4 workstream.
  All mutations operate on existing tables (`target_field_mappings`,
  `mapping_sources`, `source_field_acknowledgments`,
  `table_mappings`).
- Legacy actions: the seven actions Phase 4 wraps are all stable
  (no recent churn, well-tested in legacy UI). Zero refactor risk.
- Read-path contract: no changes needed.
  `MappingsForRedesignResult` already carries everything Phase 4
  surfaces need (target field metadata, source field metadata,
  sample values, mapping_sources roster).
- Permissions: `requireProjectPermission(projectId, 'editor')`
  already gates all seven legacy actions. The redesign drawer is
  already gated by `useProjectRole` for affordance visibility.
  No new permission rules required.
- Feature flag: Phase 4 ships behind the same
  `projects.use_mapping_redesign` flag. Heritage Core tests every
  workstream end-to-end before any other project sees it.

### 8.3 Smoke-test prerequisites

Heritage Core (`6622ddf1-47bd-4e48-ac2a-5b109a25bc13`) is the only
flag-enabled project today and remains the canary throughout
Phase 4. Each sub-phase smoke-tests:
- 4a: create a new mapping for a Rule 6 unmapped field; verify
  drawer body morphs, activity log entry written, AI Suggest
  pre-fills sensibly
- 4b: edit a mapped row's sources (add, remove), change combination;
  un-acknowledge an acknowledged row
- 4c: approve all on a TM; reject all on a TM; approve high-
  confidence project-wide

Pre-Heritage smoke-test, dev seeds may need refreshing. Worth a
quick check at the start of 4a that Heritage's Rule 6 inventory
is non-zero (if everything's already mapped, W1 has nothing to
demo on).

---

## 9. Estimated sessions per partition + total

| Sub-phase | Workstreams | Sessions | Cumulative |
|---|---|---|---|
| Pre-prep | ActionType enum widening | 1 | 1 |
| 4a | W1 + W6 | 3-4 | 4-5 |
| 4b | W2 + W3 + W4 | 2-3 | 6-8 |
| 4c | W5 | 2 | 8-10 |
| **Total** | All six workstreams | **8-10 sessions** | |

A "session" here = one investigation+implementation+QA+commit
sequence at the per-gap rhythm of Phase 3 (typical wall-clock
~3-6 hours of agent-time per session). Phase 3 ran 19 sessions
across 18 gaps; Phase 4 is materially smaller because the read
contract is fixed, the drawer architecture is set, and most of
the wrapper pattern is precedent from Gap 9.

Bound estimates:
- **Best case** (all wrappers slot cleanly into Gap 9 patterns,
  no Heritage smoke-test surprises): 8 sessions.
- **Worst case** (W1 multi-source UX needs a third iteration, or
  W3 custom_sql edge cases need design): 11 sessions.
- **Likely**: 9 sessions over ~3 weeks calendar time at typical
  ship cadence.

---

## 10. Open decisions for founder lock

Before firing the 4a implementation prompt:

1. **W1 picker scope** — same source-table only (recommendation),
   or allow cross-table source from the start? Cross-table requires
   either creating a new TM on-the-fly (legacy `addManualTableMapping`
   path) or a "split this target across TMs" UX that doesn't exist
   today. Recommend: same-source-table only for 4a; cross-table is
   Phase 4-extra if Heritage demands it.

2. **W3 combination_type='custom_sql' transitions** — recommendation
   is to block these from the redesign drawer (tooltip directs to
   Transform tab). Confirm the block is acceptable, or do we need a
   "Convert to custom SQL" affordance in 4b?

3. **W5 project-wide CTA placement** — recommendation is FilterRow,
   admin-only. Alternative is a dedicated project-level toolbar
   above the CountersRow. Confirm placement.

4. **W5 confirmation copy** — recommended copy in §5.2 needs
   founder review (counts in heading, locked-copy patterns).

5. **W6 — Option A (per-row pre-fill, recommended) vs Option B
   (per-TM bulk legacy passthrough)** vs both. If both, which ships
   in 4a vs deferred?

6. **ActionType enum widening** — six new values listed in §2.2.
   Confirm naming (`mapping_created` not `mapping_added` /
   `mapping_authored`; `mapping_sources_changed` vs
   `mapping_source_added`/`mapping_source_removed` as separate
   verbs).

7. **Per-source LLM "Suggest" in W2** — should the per-source
   edit affordance also offer "Suggest replacement source" via
   LLM? Symmetric with W6's W1 affordance, but expands LLM cost
   surface. Recommend defer to Phase 4-extras unless founder wants
   it bundled with 4b.

8. **Bulk operation scope ladder** — current legacy supports
   per-TM (`approveAllFieldMappings`) and project-wide-by-confidence
   (`approveHighConfidenceMappings`). Are these the only two
   needed, or do we want intermediate (per target table, regardless
   of confidence)? Recommend: ship the two existing variants only;
   add intermediates if smoke-test feedback demands.

9. **Phase 4-extras backlog** — items currently listed in §1
   (out-of-scope) are: source-side acknowledgment toggle, inline
   value-assignment SQL editing, manual table-mapping creation,
   regenerate. Confirm these stay deferred; if any are actually
   wanted in Phase 4, slot them now.

10. **Phase 4-extras vs Phase 5-Cleanup ordering** — once Phase 4
    ships, do we run a Phase 4-extras pass for any additional
    mutations Heritage smoke-test surfaces, or jump straight to
    Phase 5-Cleanup (legacy file removal)? Recommend: Phase 4 →
    pause for ~30 days canary on Heritage → Phase 4-extras *only
    if* user feedback demands it → Phase 5-Cleanup.

---

## 11. Out-of-scope for Phase 4

Recap (locked):

- Source-side acknowledgment toggle in the redesign sidebar
- Inline value-assignment SQL editing (Transform tab concern)
- Manual table-mapping creation (`addManualTableMapping`)
- Regenerate all mappings on a TM (`regenerateFieldMappings`)
- Drawer responsive design <768px (Phase 3 closeout decision —
  spec non-goal per `mapping-redesign.md` line 1582)
- Legacy file removal (Phase 5-Cleanup workstream)
- Feature flag removal (Phase 5-Cleanup workstream)
- `_mappings-for-redesign-core.ts` shim layer audit / consolidation

---

*End of Phase 4 plan.*
