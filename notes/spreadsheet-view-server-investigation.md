# Spreadsheet (flat) Mapping view — server-side investigation

Date: 2026-05-11
Scope: read-only investigation; no code changes.
Time budget: ~55 min.

---

## 0. Prerequisite note — B's investigation not found

The prompt referenced [notes/spreadsheet-view-investigation.md](notes/spreadsheet-view-investigation.md) (B's prior UI investigation). That file does **not exist** in the repo (only `fr-3-*.md` and `poc-flag-investigation.md` are under [notes/](notes/)). This report therefore relies on the prompt body for B's design intent. Confirm with B that this report's assumptions about row id shape, edit semantics, and the unmapped-row UX match before any implementation prompt lands.

---

## 1. Critical finding up front — coverage row, not synthesized TFM

The task spec proposes Option (a): "synthesize a rejected TFM (target_field_id set, sources empty, is_acknowledged=false, status='rejected')" for the rejected-unmapped-target case. **The codebase already has the correct mechanism and it is NOT TFM-based.**

- Migration 095 added `target_field_coverage.status` (`needs_review | approved | rejected`) and `status_set_by` (`ai_auto | user | system_default`). See [supabase/migrations/095_target_field_coverage_status.sql:80-84](supabase/migrations/095_target_field_coverage_status.sql#L80-L84).
- Helper [`setCoverageStatus`](lib/actions/mappings-for-redesign.ts#L209-L237) in [lib/actions/mappings-for-redesign.ts:209-237](lib/actions/mappings-for-redesign.ts#L209-L237) is the canonical writer.
- [`approveFieldMapping`](lib/actions/mappings-for-redesign.ts#L353-L425) and [`rejectFieldMapping`](lib/actions/mappings-for-redesign.ts#L457-L631) already use `setCoverageStatus` for the synthetic `unmapped::<targetFieldId>` rowId path.
- Founder reject-as-delete invariant: post Gap-9 a `status='rejected'` TFM is unreachable (reject means DELETE). Synthesizing one would resurrect a state the redesign explicitly retired. See the comment at [mappings-for-redesign.ts:1029-1034](lib/actions/mappings-for-redesign.ts#L1029-L1034).

**Recommendation:** the flat view's `setUnmappedRowRejected(targetFieldId)` should write `target_field_coverage.status='rejected'`, mirroring `rejectFieldMapping`'s `unmapped::` branch. Migration 103 does **not** need any change for the target-side rejection — the column already exists. The migration is only needed for **source-side** rejection (§4 below).

---

## 2. Existing server-action inventory

All references below are in [lib/actions/mappings-for-redesign.ts](lib/actions/mappings-for-redesign.ts) unless noted.

| Action | Lines | Shape | Notes |
|---|---|---|---|
| `getMappingsForRedesign` | [112-120](lib/actions/mappings-for-redesign.ts#L112-L120) | read | Thin wrapper over `getMappingsForRedesignCore` |
| `generateMappings` | [345-351](lib/actions/mappings-for-redesign.ts#L345-L351) | write | Pass-through to legacy `generateMappings` |
| `approveFieldMapping` | [353-425](lib/actions/mappings-for-redesign.ts#L353-L425) | write | Branches on `unmapped::` prefix → coverage; else → legacy `updateFieldMappingStatus(rowId, 'approved')` |
| `rejectFieldMapping` | [457-631](lib/actions/mappings-for-redesign.ts#L457-L631) | write | Branches: `unmapped::` → coverage reject. TFM-id → `deleteFieldMapping` ([lib/actions/mappings.ts:1632-1729](lib/actions/mappings.ts#L1632-L1729)) + coverage write best-effort. |
| `createFieldMapping` | [718-1187](lib/actions/mappings-for-redesign.ts#L718-L1187) | write | Atomic TFM+sources create via `dq_create_target_field_mapping`. Allows cross-table sources. Status `needs_review` on creation. |
| `suggestMappingForTarget` | [1291-1349](lib/actions/mappings-for-redesign.ts#L1291-L1349) | read-AI | Ephemeral; no DB writes |
| `editMappingSources` | [1526-2023](lib/actions/mappings-for-redesign.ts#L1526-L2023) | write | Full source-set replacement. Always reverts status→`needs_review`, resets transform when sourcesChanged. Uses `dq_replace_mapping_sources`. |
| `updateMappingCombination` | [2035-2208](lib/actions/mappings-for-redesign.ts#L2035-L2208) | write | Combination-only edit. Reverts status→`needs_review`. No transform reset. |
| `previewEditInvalidation` | [2223-2337](lib/actions/mappings-for-redesign.ts#L2223-L2337) | read | Read-only pre-save query for the EditInvalidationDialog |
| `unacknowledgeField` | [2407-2546](lib/actions/mappings-for-redesign.ts#L2407-L2546) | write | Deletes bare-ack TFM |
| `resetMappingStatus` | [2593-2867](lib/actions/mappings-for-redesign.ts#L2593-L2867) | write | "Reset to needs_review" — three branches: coverage-only / TFM mapped or VA / legacy bare-ack |
| `previewBulkApprove` / `bulkApproveFieldMappingsForTargetTable` / `approveHighConfidenceMappings` | [2962-3431](lib/actions/mappings-for-redesign.ts#L2962-L3431) | write | Bulk approve set |
| `previewBulkReject` / `bulkRejectFieldMappingsForTargetTable` | [3515-3866](lib/actions/mappings-for-redesign.ts#L3515-L3866) | write | Bulk reject set |

Legacy support in [lib/actions/mappings.ts](lib/actions/mappings.ts):
- `updateFieldMappingStatus` [lib/actions/mappings.ts:1021-1160](lib/actions/mappings.ts#L1021-L1160) — TFM-status flip; for `tfm-contributor` rejection it **deletes the mapping_source row directly** (no demotion handling). For approve+contributor it is a no-op (contributors inherit parent status).
- `deleteFieldMapping` [lib/actions/mappings.ts:1632-1729](lib/actions/mappings.ts#L1632-L1729) — DELETEs TFM for `tfm-primary`; for `tfm-contributor` deletes the source and demotes `combination_type` to `'single'` when only one source remains, **refuses** to delete the `ordinal=0` row with VALIDATION error.
- `editFieldMapping` [lib/actions/mappings.ts:1208-1374](lib/actions/mappings.ts#L1208-L1374) — single-id edit. Handles `target_field_id` change with TARGET_CONFLICT guard, VA replacement, and `source_field_id` change against the correct mapping_source row (primary or contributor). Always flips status→`needs_review` after edit. This is the closest cousin to what the spreadsheet `update*Field` actions need but it lacks the auto-approve cascade.

Shim id decoder: [`decodeShimmedRowId`](lib/compat/mapping-shim.ts#L147-L188) at [lib/compat/mapping-shim.ts:147-188](lib/compat/mapping-shim.ts#L147-L188). Format spec at [lib/compat/mapping-shim.ts:25-43](lib/compat/mapping-shim.ts#L25-L43).

Common write-path conventions every new action MUST follow:
1. `'use server'` at file top (already true in `mappings-for-redesign.ts`).
2. `const supabase = await createClient()` → `supabase.auth.getUser()` (PERMISSION_DENIED if absent).
3. `requireProjectPermission(projectId, 'editor')` from [lib/actions/role-resolution.ts](lib/actions/role-resolution.ts).
4. `assertMappingWritesEnabled(projectId)` from [lib/auth/mapping-writes.ts](lib/auth/mapping-writes.ts) — catch and translate the maintenance-mode error string verbatim.
5. Identity reads via `supabaseAdmin` (RLS-bypassing) AFTER the explicit project-permission gate.
6. Write via `supabase.rpc(...)` (RLS-honoring) when an RPC exists; admin-client direct writes when not.
7. `revalidatePath(`/app/projects/${projectId}/mapping`)` at minimum; also `/transform` when mapping_sources change; also `/app/projects` (PR-4 dashboard tile).
8. `logActivity(projectId, action_type, description, 'mapping', metadata)` — see [lib/actions/activity-log.ts](lib/actions/activity-log.ts) for the allowed `action_type` enum.
9. Return discriminated-union `{ success: true, ...} | { success: false, error, errorCode }`. Error codes from the standard set: `PERMISSION_DENIED | NOT_FOUND | VALIDATION | MAINTENANCE_MODE | INTERNAL`.

---

## 3. Schema verification (per affected table)

### 3.1 `target_field_mappings` — [074:136-180](supabase/migrations/074_mapping_redesign_data_migration.sql#L136-L180)

- PK `id UUID`. UNIQUE `(project_id, target_field_id)` — relevant for the `updateMappingTargetField` TARGET_CONFLICT case.
- `status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'approved', 'rejected'))`. The `'rejected'` value exists but is **unreachable** post Gap-9 (reject = delete). Migration 103 does not need to widen this.
- `is_acknowledged BOOLEAN`, `acknowledgment_reason TEXT`, `combination_type` ∈ `{single, concat_space, concat_comma, custom_sql}` with no DB-level cross-column CHECK (the shim re-asserts the invariant `is_acknowledged=true ⇒ combination_type IS NULL`).
- `confidence NUMERIC(5,2)` — derived as `MIN(mapping_sources.confidence)` via trigger `mapping_sources_confidence_recompute` ([074:356-388](supabase/migrations/074_mapping_redesign_data_migration.sql#L356-L388)). Only fires when `combination_type <> 'custom_sql' AND NOT is_acknowledged`. ⚠ This is the lever the spec's "propagate confidence to TFM aggregate" relies on — see §6.3.

### 3.2 `mapping_sources` — [074:186-230](supabase/migrations/074_mapping_redesign_data_migration.sql#L186-L230)

- PK `id UUID`. UNIQUE `(target_field_mapping_id, source_field_id)` — natural duplicate-prevention when editing a source field to one already in the mapping.
- `source_field_id`, `source_table_id` nullable (legacy VA accommodation).
- `confidence NUMERIC(5,2)`, `ai_reasoning TEXT`, `ordinal INTEGER NOT NULL`.
- `join_spec JSONB` — always null on the write path per Cycle 1.
- ON DELETE CASCADE from `target_field_mappings.id`.

### 3.3 `source_field_acknowledgments` — [074:237-255](supabase/migrations/074_mapping_redesign_data_migration.sql#L237-L255)

- PK `id UUID`. UNIQUE `(project_id, source_field_id)`.
- Columns: `project_id`, `source_field_id`, `reason TEXT NOT NULL`, `notes TEXT`, `acknowledged_by`, `acknowledged_at`.
- **No status column** today. Reason is "user declared source field will not be migrated" — implicitly "acknowledged" (≈ approved-as-unmapped). Migration 103 needs to either add a status column or stand up a sibling table for source-side rejection.

### 3.4 `target_field_coverage` — [093:53-68](supabase/migrations/093_path_d_foundation.sql#L53-L68) + [095:80-84](supabase/migrations/095_target_field_coverage_status.sql#L80-L84)

- UNIQUE `(project_id, target_field_id)`.
- `status` and `status_set_by` columns from migration 095 — already covers the rejected-unmapped-target case. **No schema change needed**.

---

## 4. Migration 103 — minimum-viable spec

Single concern: enable persisting "user rejected this unmapped-source row in the flat view". Three designs considered in §10; the recommended one is **Design B**.

### 4.1 Recommended SQL (Design B — `decision` column with relaxed `reason` NULLability)

```sql
-- Migration 103: source-side rejection persistence
-- Adds a `decision` column to source_field_acknowledgments so the flat
-- (spreadsheet) Mapping view can persist the user-rejected state for an
-- unmapped source row. Existing rows backfill to 'acknowledged'.
--
-- WHY a column on the existing table instead of a sibling table:
--   - UNIQUE (project_id, source_field_id) already enforces "one decision
--     per source field" — adding a sibling table would risk drift if a row
--     accidentally lands in both.
--   - The recompute-table-mapping pipeline already scans this table for
--     "source field will not be migrated" semantics; a column lets us
--     widen the predicate to `decision IN ('acknowledged', 'rejected')`
--     without changing the join shape.
--   - Source-side "acknowledged" and "rejected" are categorically the same
--     downstream concept (this source field is not contributing to a
--     mapping). The label is what differs in the UI, not the persistence.

ALTER TABLE public.source_field_acknowledgments
  ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'acknowledged'
    CHECK (decision IN ('acknowledged', 'rejected'));

-- The existing `reason TEXT NOT NULL` constraint is fine for 'acknowledged'
-- (the modal collects a reason). Rejection in the flat view is a one-click
-- action with no reason prompt — relax NOT NULL so rejection writes can
-- omit it, and default to an empty string for explicitness.
ALTER TABLE public.source_field_acknowledgments
  ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE public.source_field_acknowledgments
  ALTER COLUMN reason SET DEFAULT '';

COMMENT ON COLUMN public.source_field_acknowledgments.decision IS
  'User decision on this source field. ''acknowledged'' (default) means '
  'the user accepts the field will not be migrated. ''rejected'' is the '
  'flat-view "no" verb — semantically equivalent downstream but tracked '
  'separately so the UI can render the explicit rejection state and the '
  'activity log can distinguish the two intents.';

CREATE INDEX IF NOT EXISTS idx_source_field_acknowledgments_decision
  ON public.source_field_acknowledgments (project_id, decision);

-- RLS: the existing project-membership policies (074 STEP 3c) cover the new
-- column transparently. No additional grants required.
```

### 4.2 Data migration step

None required. The `DEFAULT 'acknowledged'` clause backfills existing rows in a single statement; the `IF NOT EXISTS` guards make the migration idempotent.

### 4.3 Rollback plan

```sql
ALTER TABLE public.source_field_acknowledgments
  ALTER COLUMN reason SET NOT NULL;          -- only safe after re-asserting non-empty values
ALTER TABLE public.source_field_acknowledgments
  ALTER COLUMN reason DROP DEFAULT;
ALTER TABLE public.source_field_acknowledgments
  DROP COLUMN IF EXISTS decision;
DROP INDEX IF EXISTS public.idx_source_field_acknowledgments_decision;
```

Caveat: rollback only safe if no `decision='rejected'` rows exist with `reason=''` at rollback time — the `SET NOT NULL` will fail otherwise. Mitigation: backfill `reason='Rejected via flat view'` for those rows before rollback. Document this in the migration header.

### 4.4 Downstream consumers to audit (search-only — DO NOT MODIFY in this investigation)

- [`recomputeTableMappingStatus`](lib/actions/mappings.ts) — queries `source_field_acknowledgments` to determine TM auto-approval eligibility. Widen the predicate to include both decisions OR leave as-is if rejection should NOT count as "decided" for TM rollup (founder call — see §8).
- [`field-acknowledgments.ts`](lib/actions/field-acknowledgments.ts) — `acknowledgeField(side='source')` upserts with `onConflict: 'project_id,source_field_id'`. If a flat-view rejection lands before the modal-driven acknowledgment, the upsert will overwrite the decision — that may or may not be desired. Flag for founder.
- [`getAcknowledgmentsForProject`](lib/actions/field-acknowledgments.ts#L271) — projects `source_field_acknowledgments` into the legacy `FieldAcknowledgment[]` shape; new `decision` column is silently ignored unless the projection is widened.
- Path D / readiness-score / `lib/quality/` aggregations — search for `source_field_acknowledgments` in [lib/quality/](lib/quality/) before shipping.

---

## 5. New action specifications

All actions live in [lib/actions/mappings-for-redesign.ts](lib/actions/mappings-for-redesign.ts), following the conventions in §2. Suggested ordering after `bulkRejectFieldMappingsForTargetTable` (end-of-file).

### 5.1 `updateMappingSourceField(rowId, newSourceFieldId)`

```ts
export type UpdateSourceFieldErrorCode =
  | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'VALIDATION'
  | 'MAINTENANCE_MODE' | 'DUPLICATE_SOURCE' | 'INTERNAL'

export type UpdateMappingSourceFieldResult =
  | { success: true; tfmId: string; mappingSourceId: string; transformReset: boolean }
  | { success: false; error: string; errorCode: UpdateSourceFieldErrorCode }

export async function updateMappingSourceField(input: {
  rowId: string                  // shim format: either `<tfmId>` (primary) or `<tfmId>::<msId>` (contributor)
  newSourceFieldId: string
  newConfidence?: number         // default 100
}): Promise<UpdateMappingSourceFieldResult>
```

**Sequence:**
1. Decode `rowId` via `decodeShimmedRowId`. Reject anything other than `tfm-primary` or `tfm-contributor` (VALIDATION).
2. Auth + identity read on TFM (project_id, target_field_id, status, is_acknowledged, combination_type).
3. Refuse if TFM is acknowledged or rejected (VALIDATION + descriptive copy).
4. `requireProjectPermission('editor')` + maintenance gate.
5. Identity read on the target `newSourceFieldId` — verify it exists, belongs to this project (walk fields→tables→datasets→project_id like createFieldMapping does at [718:860-892](lib/actions/mappings-for-redesign.ts#L860-L892)).
6. Defensive check: `(target_field_mapping_id, newSourceFieldId)` must not already exist in `mapping_sources` (DUPLICATE_SOURCE) — the UNIQUE constraint at [074:213](supabase/migrations/074_mapping_redesign_data_migration.sql#L213) would surface a generic INTERNAL error otherwise.
7. Resolve the target `mapping_sources.id`:
   - `tfm-primary` → query the `ordinal=0` row.
   - `tfm-contributor` → the decoded `mappingSourceId`.
8. Reset transform via `resetFieldTransform(tfmId)` (source-field change invalidates SQL — same rule as `editMappingSources`).
9. UPDATE the resolved mapping_source: `source_field_id = newSourceFieldId`, `source_table_id = <fresh lookup>`, `confidence = newConfidence ?? 100`, `ai_reasoning = 'Manually selected by user (flat view)'`. The confidence-recompute trigger fires and refreshes TFM.confidence to the new MIN.
10. UPDATE target_field_mapping: `status='approved'`, `updated_at=now()`.
11. Fan out `recomputeTableMappingStatus` across every distinct source-table id in the post-edit source set (parallels [editMappingSources:1944-1972](lib/actions/mappings-for-redesign.ts#L1944-L1972)). `findOrCreateTableMapping` for any newly-anchored source table.
12. `revalidatePath` `/mapping`, `/transform`, `/app/projects`.
13. `logActivity(projectId, 'mapping_sources_changed', ...)` with `{ surface: 'flat_view', ... }` metadata. Plus `mapping_approved` since status flipped (or fold into a single new `mapping_inline_edited` action_type — see §8).

**LOC estimate:** ~180 LOC including JSDoc + error-code union.

### 5.2 `updateMappingTargetField(tfmId, newTargetFieldId)`

```ts
export type UpdateTargetFieldErrorCode =
  | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'VALIDATION'
  | 'MAINTENANCE_MODE' | 'TARGET_CONFLICT' | 'INTERNAL'

export type UpdateMappingTargetFieldResult =
  | { success: true; tfmId: string; transformReset: boolean }
  | { success: false; error: string; errorCode: UpdateTargetFieldErrorCode }

export async function updateMappingTargetField(input: {
  tfmId: string                  // bare TFM uuid — TFM-level operation, not a contributor
  newTargetFieldId: string
  newConfidence?: number         // default 100
}): Promise<UpdateMappingTargetFieldResult>
```

**Sequence:**
1. Validate `tfmId` matches UUID_REGEX (VALIDATION).
2. Auth + identity read on TFM (project_id, current target_field_id, status, is_acknowledged).
3. Refuse if acknowledged or rejected (VALIDATION).
4. `requireProjectPermission('editor')` + maintenance gate.
5. Identity read on `newTargetFieldId` — exists, belongs to this project.
6. TARGET_CONFLICT check (mirrors [editFieldMapping:1277-1301](lib/actions/mappings.ts#L1277-L1301)): if a *different* live TFM already exists at `(project_id, newTargetFieldId)` and is non-rejected, return TARGET_CONFLICT. VA at the target → mirror legacy auto-resolve (delete VA first) OR refuse — recommended **refuse** to keep flat-view semantics simple; user can reject the VA explicitly.
7. Reset transform via `resetFieldTransform(tfmId)` (target-field change invalidates SQL).
8. UPDATE target_field_mapping: `target_field_id=newTargetFieldId`, `status='approved'`, `updated_at=now()`. Per-source `confidence` is NOT touched (sources keep their attribution; the trigger keeps the recomputed MIN). If the spec really wants TFM.confidence=100, see §6.3.
9. Coverage recompute on TMs whose `target_table_id` matches the *old* target field's table AND the new target field's table (the target table may have changed across tables — re-anchor by walking new target's table_id).
10. `revalidatePath` `/mapping`, `/transform`, `/app/projects`.
11. `logActivity(projectId, 'mapping_target_changed', ...)` (new action_type — see §8) plus `mapping_approved`. Existing action types do not include "target field changed" cleanly.

**LOC estimate:** ~150 LOC.

### 5.3 `createMappingFromUnmapped(sourceFieldId, targetFieldId)`

Two cases the action detects automatically:

- (a) **Unmapped target row** (target_field has no TFM, or only a coverage row). Create new TFM via `dq_create_target_field_mapping` with `status='approved'` (override the RPC's hardcoded `'needs_review'`), confidence=100, one mapping_source. Wipe the coverage row's `status` back to `'needs_review' + status_set_by='ai_auto'` so the row vacates the synthesized-unmapped state (mirror `resetMappingStatus` legacy_bare_ack branch's coverage write).
- (b) **Unmapped source row** (source field is acknowledged, has no current mapping). Remove the matching `source_field_acknowledgments` row first if present (decision='acknowledged' or 'rejected'), then create the TFM.

```ts
export type CreateFromUnmappedErrorCode =
  | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'VALIDATION'
  | 'MAINTENANCE_MODE' | 'TARGET_CONFLICT' | 'INTERNAL'

export type CreateMappingFromUnmappedResult =
  | { success: true; tfmId: string; tableMappingId: string; resolvedCase: 'unmapped_target' | 'unmapped_source' | 'both' }
  | { success: false; error: string; errorCode: CreateFromUnmappedErrorCode }

export async function createMappingFromUnmapped(input: {
  projectId: string
  sourceFieldId: string
  targetFieldId: string
}): Promise<CreateMappingFromUnmappedResult>
```

**Sequence:**
1. Auth + identity reads.
2. `requireProjectPermission('editor')` + maintenance gate.
3. Detect case:
   - Check `target_field_mappings.exists((project_id, targetFieldId))` → if exists and non-acknowledged, return TARGET_CONFLICT (defer to existing `createFieldMapping` for the merge story). If acknowledged, return VALIDATION "un-acknowledge first".
   - Check `source_field_acknowledgments.exists((project_id, sourceFieldId))` → tracks "unmapped source" case.
4. Delegate to `createFieldMapping({ projectId, sourceFieldIds: [sourceFieldId], targetFieldId, combinationType: 'single', confidence: 100 })`. Pass `aiSuggested: false`. The wrapper handles atomic creation, TM find-or-create, recompute, revalidate, and activity log.
5. After successful create, flip TFM `status='approved'` and update timestamps. (Alternative: extend `createFieldMapping` with an `initialStatus` parameter — see §10 alt 3.)
6. If unmapped-source case: DELETE the `source_field_acknowledgments` row so the source no longer shows as acknowledged-unmapped.
7. If unmapped-target case: UPDATE `target_field_coverage` SET `status='needs_review', status_set_by='ai_auto'` for the target — the TFM now drives the row's effective status, but a stale `status='rejected' or status_set_by='user'` would leak through the read translator's resolution order.
8. Activity log: a single `mapping_created` entry (already emitted by `createFieldMapping`) is sufficient. The `setUnmappedRowRejected`-reversal cleanup is metadata-only.

**LOC estimate:** ~120 LOC (mostly orchestration; the heavy lifting is in `createFieldMapping`).

### 5.4 `setUnmappedRowRejected(input)` — handles both target-side and source-side

```ts
export type SetUnmappedRowRejectedErrorCode =
  | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'VALIDATION'
  | 'MAINTENANCE_MODE' | 'INTERNAL'

export type SetUnmappedRowRejectedResult =
  | { success: true; side: 'target' | 'source' }
  | { success: false; error: string; errorCode: SetUnmappedRowRejectedErrorCode }

export async function setUnmappedRowRejected(input: {
  projectId: string
  // Discriminated union — exactly one must be set.
  targetFieldId?: string
  sourceFieldId?: string
}): Promise<SetUnmappedRowRejectedResult>
```

**Sequence:**
1. Auth + permission + maintenance.
2. Reject if both or neither are set (VALIDATION).
3. **Target branch:** Look up the field's project ownership; if any TFM exists for `(project_id, targetFieldId)`, refuse with VALIDATION "this target has a mapping — use Reject from the row instead" (mirror existing reject path). Otherwise call `setCoverageStatus(projectId, targetFieldId, 'rejected')` directly — already exists at [mappings-for-redesign.ts:209](lib/actions/mappings-for-redesign.ts#L209). Log `mapping_rejected` with `no_source: true` metadata (parity with the existing unmapped-target reject branch at [469-513](lib/actions/mappings-for-redesign.ts#L469-L513)).
4. **Source branch:** UPSERT into `source_field_acknowledgments` with `decision='rejected'`, `reason=''`. Use `onConflict: 'project_id,source_field_id'` so a previously-acknowledged source flips to rejected cleanly. Mirror the upsert at [field-acknowledgments.ts:171-186](lib/actions/field-acknowledgments.ts#L171-L186). Recompute TMs that touch the source table. Log `source_field_rejected` (new action_type — see §8).

**LOC estimate:** ~100 LOC.

### 5.5 Existing `rejectFieldMapping` — verified

See §7 for the formal verification narrative. Summary: behavior already matches the desired contract for the spreadsheet view, with one minor wart documented as risk R3.

---

## 6. Confirmation flags from the prompt — verified

### 6.1 Shim id format parses cleanly

YES — `decodeShimmedRowId` ([lib/compat/mapping-shim.ts:147-188](lib/compat/mapping-shim.ts#L147-L188)) handles `<tfmId>` (primary), `<tfmId>::<mappingSourceId>` (contributor), `ack::target::<tfmId>`, `ack::source::<sourceAckId>`, plus a synthetic `unmapped::<targetFieldId>` (which lives only inside the redesign translator and not in the shim). For the flat view's `<tfmId>::<mappingSourceId>` ids the decoder returns `{ kind: 'tfm-contributor', tfmId, mappingSourceId }`. Both halves are validated against `UUID_REGEX`. Any malformed id returns `{ kind: 'unknown' }` which actions must treat as NOT_FOUND.

### 6.2 Auto-approve cascade consistent with existing rules

Partial consistency. `approveFieldMapping` at [353-425](lib/actions/mappings-for-redesign.ts#L353-L425) flips the TFM status to `'approved'` and does NOT touch confidence — confidence remains AI-authored MIN(sources). The flat view's "edit one source → approve whole TFM" plan is **consistent in direction** (TFM-wide status) but **diverges on confidence** (the prompt wants confidence=1.0 propagated, the existing approve path leaves confidence alone).

Recommendation: keep the existing approve semantics — set `status='approved'` only, leave `confidence` to the trigger. Inline-editing source fields is a manual override; the user has implicitly overridden the AI's confidence by re-selecting, but elevating TFM-wide confidence to 100 misrepresents the AI's contribution and would clobber any high-confidence contribution from other sources on the TFM. The "confidence" the user sees in the flat view should reflect the AI's signal even after manual approval.

### 6.3 The "confidence to 1.0" sub-question

The spec uses `1.0` but the codebase uses 100-scale (NUMERIC(5,2), 0-100). `1.0` would round-trip as a 1% confidence, which is the opposite of what the spec intends. Treat the spec's `1.0` as **100**.

If the spec REALLY wants TFM.confidence=100 (overriding the MIN trigger), the implementation must:
1. Either UPDATE every mapping_source on the TFM to confidence=100 — heavy-handed but trigger-friendly.
2. Or temporarily disable the trigger / use `pg_trigger_depth()` guards — fragile, not recommended.
3. Or store the user-override confidence elsewhere (a `target_field_mappings.user_confidence` column) — net-new schema, out of scope.

**My recommendation:** do NOT propagate confidence to TFM aggregate. Set ONLY the edited source's confidence to 100; let the trigger keep TFM.confidence as the MIN signal. Flag this for founder confirmation as open question Q1.

### 6.4 Source field validation — cross-table or same-table?

Cross-table is allowed by every existing write path. `createFieldMapping` explicitly supports cross-table since Phase 4a-3 (see [createFieldMapping:680-697](lib/actions/mappings-for-redesign.ts#L680-L697)). `editMappingSources` lifted the same-table guard in Cycle 1 ([1801-1809](lib/actions/mappings-for-redesign.ts#L1801-L1809)). `editFieldMapping` (legacy) is unrestricted. The flat-view picker should mirror — allow cross-table source selection. The wrapper validates project ownership only.

### 6.5 Target field validation — multi-source TFMs

Confirmed safe. `mapping_sources.target_field_mapping_id` is the FK; no source row references the target field directly. UPDATEing `target_field_mappings.target_field_id` leaves every existing source row attached to the same TFM, now pointing at the new target. The only constraint to watch is UNIQUE `(project_id, target_field_id)` — handled by TARGET_CONFLICT in §5.2.

---

## 7. `rejectFieldMapping` existing-behavior verification

### 7.1 Behavior matrix (verified)

| RowId shape | Path | Result |
|---|---|---|
| `unmapped::<uuid>` | Synthetic unmapped target | Writes `target_field_coverage.status='rejected'`. No TFM touched. Activity log: `mapping_rejected` with `no_source: true`. ([457-514](lib/actions/mappings-for-redesign.ts#L457-L514)) |
| `<tfm-uuid>` (primary) | TFM-primary | Calls `deleteFieldMapping` which DELETEs the TFM (CASCADE removes mapping_sources + transformations). Also writes `target_field_coverage.status='rejected'` best-effort so subsequent reads stick. ([577-624](lib/actions/mappings-for-redesign.ts#L577-L624)) |
| `<tfm-uuid>::<ms-uuid>` (contributor) | TFM-contributor | Calls `deleteFieldMapping` → for `ordinal=0` returns VALIDATION "Cannot delete the primary source"; for ordinal>0 deletes just the mapping_source and demotes `combination_type→'single'` if only one source remains. ([1670-1703](lib/actions/mappings.ts#L1670-L1703)) |
| `<tfm-uuid>` for acknowledged TFM | Bare-ack TFM | Returns VALIDATION "Acknowledged rows do not support reject". ([552-558](lib/actions/mappings-for-redesign.ts#L552-L558)) |
| `<tfm-uuid>` already deleted | Race condition | Returns `{ success: true, alreadyDeleted: true }`. No activity-log entry (project_id unrecoverable). ([542-550](lib/actions/mappings-for-redesign.ts#L542-L550)) |

### 7.2 Last-source-rejected case

**This case does not arise via `rejectFieldMapping`** as the prompt feared. Here's why:

- A TFM with exactly ONE source is represented in the flat view by a `tfm-primary` rowId (no contributor row needed because `ordinal=0` is the only source). Rejecting that row → `deleteFieldMapping(tfm-primary)` → entire TFM is DELETEd. The target field becomes a Rule 6 unmapped row on next read. ✅ Matches the prompt's "TFM becomes unmapped target state" desired behavior.
- A TFM with N>1 sources surfaces as a `tfm-primary` row PLUS (N-1) `tfm-contributor` rows in the flat view. Rejecting any `tfm-contributor` row → `deleteFieldMapping(tfm-contributor)` deletes that source, demotes combination if needed. ✅ Other sources stay attached.
- Rejecting the `tfm-primary` row of an N>1 TFM → `deleteFieldMapping` short-circuits at `decoded.kind === 'tfm-primary'` and DELETEs the ENTIRE TFM (CASCADE clears all sources). This is a known but acceptable behavior — the user clicked reject on the "primary" row which represents the mapping as a whole, and the cascade is intentional. ⚠ Risk R3 below if this surprises flat-view users.

### 7.3 TFM status revert on rejection of a non-primary source

When the prompt says "the TFM remains approved or needs_review based on prior state" — this is the **current behavior**: deleting a `tfm-contributor` row triggers the confidence-recompute trigger and updates `updated_at`, but does NOT touch `status`. So a previously-approved TFM with a contributor rejected stays `approved`. **Verify with founder whether this is intended for the flat view** — it may feel surprising that rejecting a contributor doesn't revert the row to needs_review (open question Q3).

---

## 8. Edge-case enumeration

### 8.1 Last-source rejected → TFM survives with zero sources?

**Cannot happen** via `deleteFieldMapping` because deleting the ordinal=0 source is refused with VALIDATION. The only way a TFM ends up with zero non-VA sources is direct SQL or a bug. The flat view can't trigger this.

### 8.2 Editing creates a duplicate source-target on a TFM

UNIQUE `(target_field_mapping_id, source_field_id)` at [074:213](supabase/migrations/074_mapping_redesign_data_migration.sql#L213) blocks the duplicate. `updateMappingSourceField` should pre-check (step 6) and return DUPLICATE_SOURCE rather than letting the constraint surface as INTERNAL.

### 8.3 Editing target field to one with an existing TFM

TARGET_CONFLICT error code in `updateMappingTargetField`. Mirrors [editFieldMapping](lib/actions/mappings.ts#L1284-L1300). The user must reject the existing TFM first.

### 8.4 Manual mapping creation against an acknowledged target

`createFieldMapping` already handles this (the "bare-acknowledgment exception" at [996-1016](lib/actions/mappings-for-redesign.ts#L996-L1016)): if `is_acknowledged=true AND combination_type IS NULL`, delete the bare-ack TFM and proceed with creation. Same applies to `createMappingFromUnmapped` since it delegates.

### 8.5 Reject-then-re-create

After `rejectFieldMapping` deletes a TFM, `target_field_coverage.status='rejected'` and `status_set_by='user'` are written. A subsequent `createMappingFromUnmapped` (or `createFieldMapping`) on the same target must reset the coverage status — otherwise the read translator's resolution priority will resurface the row as rejected. Handled in §5.3 step 7.

### 8.6 Source field already acknowledged (modal path) being inline-rejected

`source_field_acknowledgments` UNIQUE `(project_id, source_field_id)` plus the upsert pattern means the flat-view rejection overwrites the modal acknowledgment. **Founder confirmation needed** on whether this is desired (Q4). Conservative alternative: refuse VALIDATION "field is already acknowledged".

### 8.7 Concurrent edits

No transactional guarantees across the wrapper — typical concurrent-write race: user A approves while user B inline-edits source. Final state depends on commit order; both writes succeed independently. Existing redesign actions accept this; the flat view inherits the same model.

### 8.8 Editing a source on a `tfm-primary` row when other contributors exist

The action must resolve "which mapping_source row to update" — pick `ordinal=0`. Documented in §5.1 step 7. The remaining contributors are untouched. The TFM auto-approve cascade affects all of them indirectly (status only).

### 8.9 Cross-table edit causing the anchor source table to change

Already handled by `editMappingSources`'s find-or-create fan-out pattern. `updateMappingSourceField` reuses the same shape: re-derive the anchor (ordinal=0's table_id post-edit), find-or-create a TM row, recompute statuses.

### 8.10 New action_types vs reusing existing ones

The flat view introduces new write surfaces that don't cleanly fit existing action_types in [lib/actions/activity-log.ts](lib/actions/activity-log.ts). Recommended additions (defer to founder):

- `mapping_inline_edited` — single inline cell edit, with metadata `{ surface: 'flat_view', field_kind: 'source' | 'target', ... }`.
- `mapping_target_changed` — target field change specifically (distinct from sources_changed because it has different downstream invalidation).
- `source_field_rejected` — to distinguish from `source_field_acknowledged`.

Alternative: reuse `mapping_sources_changed` + `mapping_approved` (since the cascade flips status). Cleaner audit, more verbose log. **Recommend the alternative** — keeps action_type catalogue tight.

---

## 9. LOC estimate per file

| File | Lines added | Notes |
|---|---|---|
| [supabase/migrations/103_source_field_rejection.sql](supabase/migrations/103_source_field_rejection.sql) (new) | ~40 | Schema + comments + index |
| [lib/actions/mappings-for-redesign.ts](lib/actions/mappings-for-redesign.ts) | ~600 | 4 new actions + types (5.1 + 5.2 + 5.3 + 5.4) |
| [lib/types/mappings-for-redesign.ts](lib/types/mappings-for-redesign.ts) | ~40 | New result/error-code unions if extracted out |
| [lib/compat/mapping-shim.ts](lib/compat/mapping-shim.ts) | 0 | No changes — decoder already handles every shape |
| [lib/ai/mapping-engine.ts](lib/ai/mapping-engine.ts) (read translator) | ~30 | Surface the `decision='rejected'` source acks as a new row kind (depends on UI scope) |
| [lib/actions/field-acknowledgments.ts](lib/actions/field-acknowledgments.ts) | ~20 | Widen `getAcknowledgmentsForProject` projection to include `decision` |
| Test files | ~400 | New `tests/actions/mappings-flat-view.test.ts` covering the 4 new actions + edge cases from §8 |

Total net new: ~1100 LOC + tests. Realistically a ~2-day implementation broken into 4 PRs (one per action) with shared types/migration as PR 0.

---

## 10. Three alternative designs for rejected-source persistence

### Design A — separate `source_field_rejections` table

```sql
CREATE TABLE source_field_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  rejected_by UUID REFERENCES auth.users(id),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_field_id)
);
```

**Pros:** clean semantic separation (acknowledged ≠ rejected); doesn't perturb existing acknowledgment downstream consumers; easy to drop without affecting acks.

**Cons:** two tables to JOIN for "is this source decided?"; UNIQUE only within each table — a source could end up acknowledged AND rejected (data integrity bug); read translator complicated.

### Design B — `decision` column on `source_field_acknowledgments` (RECOMMENDED, §4.1)

**Pros:** one table = one decision per source (single UNIQUE constraint); downstream consumers can opt-in to widen predicates; activity log distinguishes intents via metadata.

**Cons:** the name "acknowledgments" no longer matches all the semantics (some rows are rejections). Could rename to `source_field_decisions` in a future migration if the table grows additional decision kinds.

### Design C — minimal: store rejection as `acknowledgment` with `reason='__flat_view_reject__'`

No schema change; the flat view writes a normal acknowledgment with a sentinel `reason` string and renders that as "rejected" in the UI.

**Pros:** zero migration; instant ship.

**Cons:** brittle (string sentinels are bug magnets); doesn't distinguish intents in the activity log; downstream `recomputeTableMappingStatus` treats it identically to an acknowledgment (which might actually be correct, but the user-facing semantic is lost).

**Pick Design B.** It's the smallest schema change that preserves both the UI distinction and downstream simplicity. Design A is a viable fallback if founder objects to overloading the acknowledgment table.

---

## 11. Risks & open questions for human review

### Risks

- **R1 (data-model):** Spec proposes synthesizing a "rejected TFM" for unmapped target rejection. This is incorrect — the codebase uses `target_field_coverage.status='rejected'` for that purpose. Using a TFM-status sentinel would resurrect the post-Gap-9 unreachable state. (§1)
- **R2 (semantic):** "Confidence to 1.0" in the spec conflicts with the 100-scale codebase. Assume the spec means 100; flag if disagreed. (§6.3)
- **R3 (UX):** Rejecting the `tfm-primary` row of a multi-source TFM in the flat view deletes ALL sources via CASCADE. Users may expect "reject this primary source only, keep contributors" — but the existing `deleteFieldMapping` shape doesn't support source-promotion. (§7.2)
- **R4 (audit-log noise):** Inline cell edits could fire 2 activity-log entries each (sources_changed + approved). Either fold into a single new action_type or accept the duplication. (§8.10)
- **R5 (rollback safety):** Migration 103's `reason` nullability change is sticky — rollback requires backfilling rejected rows with non-empty reasons first. Document this. (§4.3)
- **R6 (recompute cost):** Each inline edit fans out `recomputeTableMappingStatus` across every affected TM. For projects with many sibling source tables (cross-table mappings) this could surface as latency. Cycle-1 mappings already do this; the flat view inherits the same hot path.

### Open questions for founder

- **Q1:** Should TFM-aggregate confidence be forcibly elevated to 100 on inline edit (overriding the MIN trigger), or should only the edited source's confidence change? (§6.3 — my recommendation: only the edited source.)
- **Q2:** Should rejecting a contributor source revert the parent TFM's status from `approved` → `needs_review`? Current behavior preserves status; flat-view UX might expect a revert. (§7.3)
- **Q3:** Should `createMappingFromUnmapped` remove the existing `source_field_acknowledgments` row, or refuse to map an acknowledged source? (§5.3, §8.6)
- **Q4:** Should the flat view introduce new activity_log action_types (`mapping_inline_edited`, `mapping_target_changed`, `source_field_rejected`) or reuse existing ones (`mapping_sources_changed`, `mapping_approved`, `mapping_rejected`)? (§8.10)
- **Q5:** For `updateMappingTargetField`, should a VA at the new target be auto-deleted (legacy `editFieldMapping` behavior) or refused (TARGET_CONFLICT)? Recommendation: refuse for simplicity. (§5.2)
- **Q6:** Does B's UI investigation actually exist somewhere outside the repo (e.g. a draft branch)? Coordinate scope before implementation. (§0)

---

## 12. Items NOT covered in this investigation (explicit scope-out)

- UI-side flat-view component design (B's parallel investigation).
- Type updates in `lib/types/mappings-ui.ts` to surface `RichFieldMapping` rows in the flat shape — depends on B's UI.
- Read translator changes to project `decision='rejected'` source acks into the flat-row stream — depends on UI scope.
- Performance/index profiling for `decision` column queries at Mitratech-scale.
- Test fixtures in [tests/fixtures/outputs/seed.ts](tests/fixtures/outputs/seed.ts) — adding `decision` to existing source_field_acknowledgment seeds.
- Tightening up `MappingActionResult` errorCode unions across the existing actions — out of scope.
