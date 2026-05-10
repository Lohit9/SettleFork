# FR-3 Investigation — Server-side schema field actions

> Investigation only. No production code modified. Output of Stop 0.

---

## 1. Executive summary

The new actions (`createField`, `deleteField`, `previewFieldDeletion`) can be built on top of patterns that already exist in the codebase, with two notable deviations from the canonical "Settle action" template that need a founder decision before Stop 1.

**The good news.** The reference pattern (`updateField` at [lib/actions/fields.ts:69-115](lib/actions/fields.ts#L69-L115)) is small and easy to mirror: auth check → resolve `project_id` via the `fields → tables → datasets` join → `requireProjectPermission(projectId, 'editor')` → write → `revalidatePath('/app/projects/{projectId}/data-overview')`. Every FK that points at `fields.id` (10 of them, mapped in §2) is `ON DELETE CASCADE` or `SET NULL` — there is **no `RESTRICT` or `NO ACTION`** anywhere in the graph, so the database does the structural cleanup atomically the moment we issue `DELETE FROM fields WHERE id = $1`. The activity-log column `action_type` is `TEXT` with **no `CHECK` constraint** ([031_activity_log.sql:9-20](supabase/migrations/031_activity_log.sql#L9-L20)), so adding `field_created` and `field_deleted` is a pure TypeScript widening of the union in [lib/actions/activity-log.ts](lib/actions/activity-log.ts) — **no migration required**.

**The two non-trivial wrinkles.** (a) `staged_data_rows.transformed_row_data` is JSONB **keyed by field name, not field id**. There is no FK from staged rows to fields, so a DB cascade does **not** scrub orphaned keys. The codebase already has a precedent for eager scrubbing — `revert_field_transform(table_mapping_id, target_field_name)` at [054_revert_field_transform.sql](supabase/migrations/054_revert_field_transform.sql) — which is the established "reset transformation" path, called by `resetFieldTransform` ([lib/actions/transformations.ts:3087-3210](lib/actions/transformations.ts#L3087-L3210)) before every TFM deletion or edit. `deleteField` should reuse the same RPC, once per relevant `table_mapping_id`, **before** the `DELETE FROM fields` runs. (b) The `fields` table has **no `UNIQUE (table_id, name)` constraint** — name collisions today are tolerated by the DDL parser. `createField` therefore needs an application-level pre-check (or a partial unique index added in the same migration cohort).

**Recommended approach.** Mirror `updateField` for both `createField` and `previewFieldDeletion` (no RPC; direct table reads/writes, RLS-active client). For `deleteField`, ship a new `SECURITY DEFINER` RPC `delete_field_with_cleanup(p_field_id, p_actor_id)` that wraps (i) the `revert_field_transform` calls, (ii) the `DELETE FROM fields`, and (iii) returns the cascade count summary in a single transaction. This is the only way to keep the JSONB scrub + field delete atomic, and it matches the convention in §4.4 of `CLAUDE.md` ("Every write goes through a `SECURITY DEFINER` RPC that re-asserts RLS context"). `updateField`'s direct-table-write style is a known deviation from that convention; we should not propagate it to a multi-table cascade. `previewFieldDeletion` runs 5 parallel `head:true` count queries against the impacted tables, capped at 101 for the JSONB-key match (mirroring `previewEditInvalidation` at [lib/actions/mappings-for-redesign.ts:2223-2337](lib/actions/mappings-for-redesign.ts#L2223-L2337)).

---

## 2. Findings

### §1 — Existing edit-field action (the reference pattern)

**Location:** [`lib/actions/fields.ts:69-115`](lib/actions/fields.ts#L69-L115) — function `updateField`.

**Signature:**
```ts
export async function updateField(
  fieldId: string,
  updates: FieldUpdates
): Promise<{ success: boolean; data?: Field; error?: string }>
```

`FieldUpdates` is a partial bag of column updates: `name`, `data_type`, `inferred_type`, `is_nullable`, `is_primary_key`, `is_foreign_key`, `fk_reference` ([lib/actions/fields.ts:11-19](lib/actions/fields.ts#L11-L19)).

**Guard pattern, in order:**
1. `await supabase.auth.getUser()` — early-return `{ success: false, error: 'Not authenticated' }`.
2. Resolve `project_id` via `fields → tables → datasets` join using `supabaseAdmin` (RLS-bypassing service role) ([lib/actions/fields.ts:79-85](lib/actions/fields.ts#L79-L85)).
3. `await requireProjectPermission(projectId, 'editor')` — early-return on `!perm.allowed`.
4. **No `assertMappingWritesEnabled` call.** Field schema mutations do not gate on maintenance mode today.

**Write:** direct `supabase.from('fields').update({ ...updates, schema_source: 'manual' }).eq('id', fieldId).select().single()` — no `SECURITY DEFINER` RPC. Note the silent normalisation: `schema_source` is forced to `'manual'` on every successful update so manual edits dominate doc-enriched and inferred values.

**Activity log:** **none.** `updateField` does not call `logActivity`. Field-domain logging does not exist today; FR-3 will introduce it.

**revalidatePath:** `/app/projects/${projectId}/data-overview` (singular).

**Side effects:** fire-and-forget call to `refreshFieldProfiling` ([lib/actions/fields.ts:107-110](lib/actions/fields.ts#L107-L110)) when `data_type` or `inferred_type` changes — recomputes `field_profiles.format_issues_count` only.

**Input validation:** **none.** No Zod parse. `updates` is trusted at runtime; only the TypeScript type guards the shape.

**UI consumption:** `FieldEditModal` at [`app/app/projects/[projectId]/data-overview/SchemaOverview.tsx:36-261`](app/app/projects/[projectId]/data-overview/SchemaOverview.tsx#L36-L261). Result handled as `if (!result.success) setError(result.error || 'Save failed')`.

**Key takeaway for FR-3:** the reference pattern is small but has two known gaps versus the broader Settle conventions — no activity-log emission, no Zod. FR-3 should *not* propagate those gaps. The new actions establish the first activity-log emitters in the field domain (`field_created`, `field_deleted`) and should follow the canonical Zod adopter ([lib/actions/projects.ts](lib/actions/projects.ts)) for input validation, since `createField` accepts free-text input from the user.

---

### §2 — FK inventory: every entity that references `fields.id`

10 direct FKs and 1 indirect chain. **All `ON DELETE CASCADE` or `SET NULL` — no `RESTRICT` or `NO ACTION`**, so a single `DELETE FROM fields WHERE id = $1` is structurally safe.

| # | Table | Column | Migration | ON DELETE | Nullable | Notes |
|---|---|---|---|---|---|---|
| 1 | `field_profiles` | `field_id` | [002_foundation.sql:60](supabase/migrations/002_foundation.sql#L60) | CASCADE | NO | Profiling row; one per field. |
| 2 | `field_mappings` (legacy) | `source_field_id` | [002_foundation.sql:101](supabase/migrations/002_foundation.sql#L101) | CASCADE | NO | Legacy mapping table. Backed up to `field_mappings_backup_074` in migration 074. |
| 3 | `field_mappings` (legacy) | `target_field_id` | [002_foundation.sql:102](supabase/migrations/002_foundation.sql#L102) | CASCADE | NO | Same legacy table. |
| 4 | `quality_issues` | `field_id` | [002_foundation.sql:119](supabase/migrations/002_foundation.sql#L119) | CASCADE | YES | Optional FK; null for table/project-level issues. |
| 5 | `validation_rules` | `field_id` | [006_data_quality.sql:10](supabase/migrations/006_data_quality.sql#L10) | CASCADE | YES | Optional FK. |
| 6 | `field_acknowledgments` (legacy) | `field_id` | [039_field_acknowledgments.sql:7](supabase/migrations/039_field_acknowledgments.sql#L7) | CASCADE | NO | `UNIQUE (project_id, field_id)`. Largely superseded by `target_field_coverage` (migration 098 collapse). |
| 7 | `mapping_sources` (current model) | `source_field_id` | [074_mapping_redesign_data_migration.sql:195](supabase/migrations/074_mapping_redesign_data_migration.sql#L195) | CASCADE | YES | Defensive nullability; in practice always set. |
| 8 | `source_field_acknowledgments` | `source_field_id` | [074_mapping_redesign_data_migration.sql:240](supabase/migrations/074_mapping_redesign_data_migration.sql#L240) | CASCADE | NO | `UNIQUE (project_id, source_field_id)`. |
| 9 | `target_field_coverage` (Path D) | `target_field_id` | [093_path_d_foundation.sql:56](supabase/migrations/093_path_d_foundation.sql#L56) | CASCADE | NO | `UNIQUE (project_id, target_field_id)`. |
| 10 | `project_data_quality_issues` (Path D) | `source_field_id` | [093_path_d_foundation.sql:245](supabase/migrations/093_path_d_foundation.sql#L245) | CASCADE | YES | NULL for project-level findings. |

**Indirect chain:** `target_field_mappings.target_field_id → fields.id` (CASCADE) → `transformations.target_field_mapping_id → target_field_mappings.id` (CASCADE, [074:399](supabase/migrations/074_mapping_redesign_data_migration.sql#L399)). Deleting a field therefore destructively removes the user-authored transform SQL.

**Tables that reference fields *only via JSONB* (no FK, no cascade):**
- `staged_data_rows.transformed_row_data` — keyed by field **name** (see §3).
- `project_decisions`, `project_lookup_tables`, `project_inferred_targets` — Path D entities. Per the FK audit and Agent #3's review, none of these have a typed FK to `fields(id)`; references live inside JSONB blobs (e.g., `applies_to_fields`, `evidence_source_fields`). These will become orphan refs on field deletion. Out of scope for FR-3 MVP unless we add a JSONB scrub pass — flagged as open question.

**RLS:** every dependent table has project-level RLS. Cascade deletes bypass RLS (system-level), so the cascade succeeds even if the user couldn't directly write the dependent row.

---

### §3 — The `staged_data_rows` JSONB problem

**Schema:** [`013_staged_data_rows.sql:8-39`](supabase/migrations/013_staged_data_rows.sql#L8-L39).

`transformed_row_data JSONB NOT NULL` — keyed by **target field name** (e.g. `{"customer_id": "C123", "order_date": "2025-01-15"}`). No FK to `fields`, so a database cascade does not scrub these keys.

**The codebase scrubs eagerly**, not lazily. The pattern:

1. **The RPC**: `revert_field_transform(p_table_mapping_id UUID, p_target_field_name TEXT) RETURNS INTEGER` — [054_revert_field_transform.sql:5-30](supabase/migrations/054_revert_field_transform.sql#L5-L30):
   ```sql
   IF p_target_field_name !~ '^[A-Za-z_][A-Za-z0-9_ ]*$' THEN
     RAISE EXCEPTION 'Invalid target field name: %', p_target_field_name;
   END IF;
   UPDATE public.staged_data_rows
   SET transformed_row_data = transformed_row_data - p_target_field_name
   WHERE table_mapping_id = p_table_mapping_id
     AND transformed_row_data ? p_target_field_name;
   ```
   The JSONB minus operator (`-`) removes the key; the key-exists guard (`?`) skips no-op rows. The `!~` regex check on the name is a SQL-injection guard.

2. **The caller**: `resetFieldTransform` at [lib/actions/transformations.ts:3087-3210](lib/actions/transformations.ts#L3087-L3210). When a transform is in `status='applied'`, it iterates every `table_mapping` whose `target_table_id` matches the field's parent table and calls the RPC for each. Then it deletes the `transformations` row.

3. **The convention** (per Agent #3): "The codebase does NOT leave orphaned JSONB keys to be cleaned up on the next stage run. It actively scrubs them immediately when transforms are modified." Examples of callers:
   - `deleteFieldMapping` at [lib/actions/mappings.ts:1662](lib/actions/mappings.ts#L1662)
   - `editMappingSources` at [lib/actions/mappings-for-redesign.ts:1912](lib/actions/mappings-for-redesign.ts#L1912)
   - `resetAllTransformsForTable` at [lib/actions/transformations.ts:3254-3267](lib/actions/transformations.ts#L3254-L3267)

**Conclusion for `deleteField`:** scrub the JSONB before the field-row delete, by calling `revert_field_transform` once per `table_mapping` whose `target_table_id` equals the field's parent `table_id`. The TFM CASCADE alone is *not* sufficient — TFM CASCADE deletes the transformation row but leaves the JSONB key intact in staged rows.

**Note on ordering:** if we delete the field first, the FK CASCADE removes the TFM and we lose the linkage to find which `table_mapping` rows to scrub. Order must be: (i) compute scrub plan from the still-present field, (ii) run scrub, (iii) DELETE the field. This ordering is precisely why `deleteField` belongs in a `SECURITY DEFINER` RPC (atomic transaction) rather than sequenced TS Supabase calls (no atomicity if the process dies between steps).

---

### §4 — `previewFieldDeletion` query design

**Precedent:** `previewEditInvalidation` at [lib/actions/mappings-for-redesign.ts:2223-2337](lib/actions/mappings-for-redesign.ts#L2223-L2337). Pattern:
- Cap result at `PREVIEW_INVALIDATION_COUNT_CAP = 101` (signals "100+" to the UI without computing exact count).
- 4-5 sequential queries (TFM lookup, transformation existence, field metadata, table-mapping list, staged-row count via PostgREST `cs` filter).
- No RPC; all queries from server action directly.

**No multi-category preview RPC exists.** Searched migrations for `CREATE OR REPLACE FUNCTION.*preview` and `CREATE OR REPLACE FUNCTION.*impact` — zero matches.

**Proposed counts for `previewFieldDeletion(fieldId)`:**

| # | Category | Query | Pattern |
|---|---|---|---|
| 1 | TFMs targeting this field | `SELECT count(*) FROM target_field_mappings WHERE target_field_id = $1` | `head: true` count |
| 2 | Mapping sources contributing | `SELECT count(*) FROM mapping_sources WHERE source_field_id = $1` | `head: true` count |
| 3 | Transformations (via TFM join) | `SELECT count(*) FROM transformations t JOIN target_field_mappings tfm ON t.target_field_mapping_id = tfm.id WHERE tfm.target_field_id = $1` | RPC or two-step: list TFM ids, then `IN (...)` count |
| 4 | Staged rows with field name as JSONB key (capped 101) | `WHERE transformed_row_data ? $fieldname AND table_mapping_id IN (tmIds) LIMIT 101` | requires loading `tmIds` first; PostgREST: `.filter('transformed_row_data', 'cs', JSON.stringify({[name]: null}))` |
| 5 | Acknowledgments | sum of `field_acknowledgments` (legacy) + `source_field_acknowledgments` (new) | two `head: true` counts, summed |
| 6 | Path D coverage | `SELECT count(*) FROM target_field_coverage WHERE target_field_id = $1` | `head: true` count (will be 0 or 1 because of UNIQUE constraint) |

**Feasibility:** all 6 can be fired in parallel via `Promise.all`. Query #3 is the only one that needs either an RPC or a two-step pattern; recommend a small `count_transformations_for_field(p_field_id UUID)` SQL function for clarity. Query #4 has a prerequisite (load `tmIds`), so the action plan is: load field name + table_id + tmIds (1 query), then `Promise.all` the rest (5 queries).

**Out of scope for MVP:** counting `project_decisions` / `project_lookup_tables` / `project_inferred_targets` — these reference fields via JSONB, not FK, and the JSONB shapes aren't stable enough to query cheaply. Flagged as open question.

**Return shape proposal:**
```ts
type FieldDeletionPreview = {
  fieldId: string
  fieldName: string
  tableId: string
  counts: {
    tfms: number               // category 1
    mappingSources: number     // category 2
    transformations: number    // category 3
    stagedRows: number         // category 4 (cap exhibited via stagedRowsCapped)
    acknowledgments: number    // category 5 (legacy + new summed)
    coverageRows: number       // category 6
  }
  stagedRowsCapped: boolean    // true if stagedRows >= 101
  hasAuthoredTransformSQL: boolean  // true if any transformation row exists with non-empty user_sql / generated_sql
}
```

---

### §5 — `createField` shape

**Schema** (assembled from migration 002 + alterations 020, 036, 063, 064, 090):

| Column | Type | NOT NULL | Default | createField requires? |
|---|---|---|---|---|
| `id` | UUID | YES | `gen_random_uuid()` | NO (auto) |
| `table_id` | UUID | YES | — | **YES** |
| `name` | TEXT | YES | — | **YES** |
| `data_type` | TEXT | YES | — | **YES** |
| `inferred_type` | TEXT | NO | NULL | NO (derive via `inferBasicType`) |
| `is_nullable` | BOOLEAN | NO | `true` | NO |
| `is_primary_key` | BOOLEAN | NO | `false` | NO |
| `is_foreign_key` | BOOLEAN | NO | `false` | NO |
| `fk_reference` | TEXT | NO | NULL | NO |
| `ordinal_position` | INT | YES | — | **YES** (compute server-side: max+1 in table) |
| `created_at` | TIMESTAMPTZ | NO | `now()` | NO (auto) |
| `schema_source` | TEXT | YES | `'inferred'` | force `'manual'` (mirrors `updateField`) |
| `check_constraint` | JSONB | NO | NULL | NO |
| `default_value` | TEXT | NO | NULL | NO |
| `description` | TEXT | NO | NULL | NO |

**`schema_source` enum:** `('inferred', 'ddl_parsed', 'cross_table_inferred', 'doc_enriched', 'manual')` — [063_schema_source_expansion.sql:19-20](supabase/migrations/063_schema_source_expansion.sql#L19-L20). Use `'manual'` for user-created fields.

**Uniqueness gap:** **no `UNIQUE (table_id, name)`** in schema. The DDL upload at [lib/actions/ddl-upload.ts:187-202](lib/actions/ddl-upload.ts#L187-L202) tolerates duplicates because parsed DDL is presumed clean. For UI-driven `createField` we need either:
- (a) an application-level pre-check (`SELECT id FROM fields WHERE table_id = $1 AND name = $2 LIMIT 1`) — race-prone but matches existing tolerance.
- (b) a partial unique index added in the same migration cohort: `CREATE UNIQUE INDEX fields_table_id_name_unique ON fields (table_id, name) WHERE deleted_at IS NULL` — not currently present, and would require auditing existing data for collisions.

**Recommendation:** ship (a) for FR-3, file (b) as follow-up after a dataset-wide collision audit.

**`ordinal_position` strategy:** not auto-increment; explicitly set at INSERT. DDL path uses `idx + 1` over the parse order. For UI-driven creation, compute `MAX(ordinal_position) + 1` over the table's existing fields. There is no gap-fill or reordering logic to preserve.

**`field_profiles`:** every read path joins LEFT, not INNER. Confirmed in [lib/actions/mappings.ts:633](lib/actions/mappings.ts#L633), [lib/actions/validation-rules.ts:313](lib/actions/validation-rules.ts#L313), [lib/actions/data-overview.ts:313](lib/actions/data-overview.ts#L313). **Newly created fields without a `field_profiles` row will not break any read path.** No placeholder profile row is needed at create time. Profiles are populated asynchronously by the ingestion worker from real data.

---

### §6 — `deleteField` cascade strategy

**The structural cascade is free:** all 10 FKs in §2 are CASCADE/SET NULL. A bare `DELETE FROM fields WHERE id = $1` issued in a transaction with sufficient privileges removes:
- `field_profiles`, `quality_issues`, `validation_rules`, `field_acknowledgments`, `source_field_acknowledgments`, `target_field_coverage`, `project_data_quality_issues` (direct CASCADE)
- `target_field_mappings` (direct CASCADE) → `transformations`, `mapping_sources`, `target_field_acknowledgments-via-TFM` (transitive CASCADE)
- legacy `field_mappings` rows (direct CASCADE)

**Two things the structural cascade does NOT do:**

1. **Scrub `staged_data_rows.transformed_row_data` JSONB keys.** Must be done explicitly by calling `revert_field_transform(table_mapping_id, target_field_name)` once per relevant `table_mapping` *before* the `DELETE FROM fields`. See §3.

2. **Preserve user-authored transform SQL.** The TFM CASCADE deletes `transformations` rows along with any user-edited `user_sql`. Per the prompt's own guidance ("Resets transformations rather than deleting them when possible (preserves user-authored SQL)"), this is undesirable. **However:** a target field that is being deleted has no future, so its transformations have no future either. The "preserve user SQL" precedent in `resetFieldTransform` exists for cases where the field stays and its mapping is reset — that case doesn't apply here. **Recommendation: accept the destructive cascade for `deleteField`, but include `transformation_count` and `had_authored_sql: boolean` in the activity-log metadata so the audit trail captures what was lost.**

**Atomicity argument for an RPC:**
- The scrub + delete sequence has 2-N steps depending on how many table mappings exist for the field's parent table.
- A failure between scrub and delete leaves staged rows with missing keys but the field still alive — not destructive but inconsistent.
- A failure between delete and activity-log emit leaves the field gone with no audit row — bad for compliance.
- Wrapping both in a `SECURITY DEFINER` RPC `delete_field_with_cleanup(p_field_id UUID, p_actor_id UUID)` returning `JSONB` (cascade counts) gives us a single transaction. The activity-log emit can stay in TypeScript (best-effort, fire-and-forget) since the RPC return value carries the counts.

**Activity log: one parent entry, not N child entries.** Precedent from `resetFieldTransform` ([lib/actions/transformations.ts:3176-3189](lib/actions/transformations.ts#L3176-L3189)) is "one entry per atomic action with cascade counts in metadata". Applying the same shape:

```ts
await logActivity(
  projectId,
  'field_deleted',
  `Field deleted: ${tableName}.${fieldName}`,
  'data',
  {
    field_id: fieldId,
    field_name: fieldName,
    table_id: tableId,
    cascade_counts: {
      target_field_mappings: tfmCount,
      mapping_sources: msCount,
      transformations: txnCount,
      staged_rows_scrubbed: stagedScrubCount,
      acknowledgments: ackCount,
      coverage_rows: coverageCount,
    },
    had_authored_transform_sql: hadAuthoredSql,
  }
)
```

---

### §7 — Activity log additions

[`lib/actions/activity-log.ts:41-86`](lib/actions/activity-log.ts#L41-L86) defines the `ActionType` union. **No `field_*` types exist today.**

Naming convention ([lib/actions/activity-log.ts:12-19](lib/actions/activity-log.ts#L12-L19)): `subject_pastTenseVerb` (singular subject, past-tense verb). Examples: `mapping_approved`, `table_removed`, `acknowledgment_removed`. Counterexamples (legacy, do not extend): `scan_run`, `stage_all`.

**Proposed additions:**
- `'field_created'` — category `'data'`
- `'field_deleted'` — category `'data'`
- `'field_updated'` — category `'data'` — *retroactive: emit from `updateField` to close the existing logging gap*

**Constraint check:** [`031_activity_log.sql:9-20`](supabase/migrations/031_activity_log.sql#L9-L20) defines `action_type TEXT NOT NULL` with **no `CHECK` constraint or enum**. Confirmed by Agent #1 ("widening the union is a pure TypeScript change — no migration required").

**Migration impact:** zero. Pure TS change.

---

### §8 — RLS / permission model

**`requireProjectPermission`** at [`lib/actions/role-resolution.ts:43-52`](lib/actions/role-resolution.ts#L43-L52):
```ts
async function requireProjectPermission(
  projectId: string,
  minRole: 'admin' | 'editor' | 'viewer'
): Promise<{ allowed: boolean; error?: string }>
```
Role hierarchy is numeric: `admin=3, editor=2, viewer=1` ([lib/types/organizations.ts:17-29](lib/types/organizations.ts#L17-L29)). All three new actions require `'editor'` (matches `updateField`).

**`assertMappingWritesEnabled`** at [`lib/auth/mapping-writes.ts:20-37`](lib/auth/mapping-writes.ts#L20-L37):
```ts
async function assertMappingWritesEnabled(projectId: string): Promise<void>
```
Throws (does not return) on either project-not-found or `maintenance_mode === true`.

**The maintenance-mode gate question.** The existing `updateField` does *not* call `assertMappingWritesEnabled`. But `deleteField` cascades into `target_field_mappings` and `transformations`, which is exactly what the maintenance gate is designed to protect. **Proposal: `deleteField` should call `assertMappingWritesEnabled` even though `updateField` doesn't, because the cascade impact crosses the mapping write boundary.** `createField` need not call it (creating a field cannot affect existing mappings). `previewFieldDeletion` is read-only — no gate.

**Action-by-action gate matrix:**

| Action | Auth | requireProjectPermission | assertMappingWritesEnabled | Activity log |
|---|---|---|---|---|
| `createField` | ✓ | `'editor'` | — | `field_created` |
| `previewFieldDeletion` | ✓ | `'viewer'` (read-only preview) | — | — |
| `deleteField` | ✓ | `'editor'` | ✓ (new vs `updateField` precedent) | `field_deleted` |

---

### §9 — Path D coverage interaction

`target_field_coverage` at [`093_path_d_foundation.sql:53-68`](supabase/migrations/093_path_d_foundation.sql#L53-L68). FK on `target_field_id` is `ON DELETE CASCADE`, so the coverage row is removed automatically. No app-level cleanup needed beyond counting it for the preview/log.

**App-level reads/writes** that assume coverage exists or doesn't:
- `setCoverageStatus` in [lib/actions/mappings-for-redesign.ts](lib/actions/mappings-for-redesign.ts) — writes coverage rows.
- `lib/ai/mapping-engine.ts` — translates coverage to row props.
- All consumers tolerate missing coverage rows (nullable treatment in the UI translator).

**RLS:** editor-write, org-read. Cascade delete bypasses RLS. Safe.

**No special handling required for Path D in `deleteField`** beyond including `coverage_rows: 0|1` in the preview/log payload. The `UNIQUE (project_id, target_field_id)` constraint guarantees at most 1.

---

## 3. Proposed implementation plan (Stop 1 outline)

**One concern per branch:** branch name `feat/fr-3-schema-field-actions`.

### File-by-file plan

| # | File | Action | Est. LOC | Notes |
|---|---|---|---|---|
| 1 | `supabase/migrations/099_delete_field_with_cleanup_rpc.sql` | NEW | ~80 | `SECURITY DEFINER` RPC that scrubs JSONB + deletes field + returns cascade counts. |
| 2 | `supabase/migrations/100_count_transformations_for_field_rpc.sql` | NEW | ~20 | Small RPC for preview query #3. (Optional — could inline as two-step query.) |
| 3 | [`lib/actions/activity-log.ts`](lib/actions/activity-log.ts) | EDIT | +3 | Add `'field_created'`, `'field_deleted'`, `'field_updated'` to `ActionType` union. |
| 4 | [`lib/actions/fields.ts`](lib/actions/fields.ts) | EDIT | +160 | Add `createField`, `deleteField`, `previewFieldDeletion`. Retrofit `logActivity('field_updated', ...)` into existing `updateField`. |
| 5 | `lib/validation/fields.ts` | NEW | ~40 | Module-level Zod schemas for `createField` input, mirroring [lib/actions/projects.ts](lib/actions/projects.ts) canonical adopter. |
| 6 | UI integration in `app/app/projects/[projectId]/data-overview/SchemaOverview.tsx` (and child components) | EDIT | ~150 | Add "Add field" affordance; add "Delete field" affordance with confirmation modal driven by `previewFieldDeletion` result. |
| 7 | `tests/integration/fields.test.ts` | NEW | ~200 | Vitest integration tests against scratch Supabase: createField happy path, name collision, deleteField cascade verification (assert all 10 dependent tables emptied + JSONB scrubbed), preview accuracy under varied counts, RLS denial for viewer. |

### Sequence

1. **Land migration 099 first** on a scratch Supabase project; verify the RPC against a populated test project. (Mandatory pause before applying to prod per CLAUDE.md §2.4.)
2. **Then the activity-log union widening** — pure TS, no migration risk.
3. **Then the action implementations** behind the migration. Order within `fields.ts`: `previewFieldDeletion` first (read-only, easiest to verify), then `createField`, then `deleteField`.
4. **Tests in parallel** with action work — test-first for `deleteField` because the cascade is the highest-risk path.
5. **UI integration last**, gated on action stability.

### Stop 1 PR scope

Per CLAUDE.md §2.5 ("one concern per PR"), this is a single PR. UI integration may split into a follow-up PR if the action work + tests already push the diff over a reasonable review threshold.

### `previewFieldDeletion` — concrete query plan

```ts
// Step 1 — load field metadata + table mappings (1 sequential query)
const { data: ctx } = await supabaseAdmin
  .from('fields')
  .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
  .eq('id', fieldId)
  .single()

const { data: tms } = await supabaseAdmin
  .from('table_mappings')
  .select('id')
  .eq('target_table_id', ctx.table_id)

const tmIds = tms?.map(t => t.id) ?? []

// Step 2 — fire 6 counts in parallel
const [tfm, ms, txn, staged, ackLegacy, ackNew, cov] = await Promise.all([
  supabaseAdmin.from('target_field_mappings').select('id', { count: 'exact', head: true }).eq('target_field_id', fieldId),
  supabaseAdmin.from('mapping_sources').select('id', { count: 'exact', head: true }).eq('source_field_id', fieldId),
  supabaseAdmin.rpc('count_transformations_for_field', { p_field_id: fieldId }),
  supabaseAdmin.from('staged_data_rows').select('id', { count: 'exact', head: true })
    .in('table_mapping_id', tmIds)
    .filter('transformed_row_data', 'cs', JSON.stringify({ [ctx.name]: null }))
    .limit(101),
  supabaseAdmin.from('field_acknowledgments').select('id', { count: 'exact', head: true }).eq('field_id', fieldId),
  supabaseAdmin.from('source_field_acknowledgments').select('id', { count: 'exact', head: true }).eq('source_field_id', fieldId),
  supabaseAdmin.from('target_field_coverage').select('id', { count: 'exact', head: true }).eq('target_field_id', fieldId),
])
```

(The `Promise.all` actually has 7 tuples; merge `ackLegacy + ackNew` into the response shape's `acknowledgments` field.)

### `delete_field_with_cleanup` — RPC signature sketch

```sql
CREATE OR REPLACE FUNCTION public.delete_field_with_cleanup(
  p_field_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_field RECORD;
  v_project_id UUID;
  v_tfm_count INT;
  v_ms_count INT;
  v_txn_count INT;
  v_staged_scrubbed INT := 0;
  v_ack_count INT;
  v_coverage_count INT;
  v_had_authored_sql BOOLEAN;
  v_tm RECORD;
BEGIN
  -- 1. Load field + project context (re-asserts caller has access via RLS-aware lookup).
  -- 2. Re-verify caller is editor on the project (RPC re-asserts; do not trust client guard alone).
  -- 3. Compute cascade counts BEFORE delete (for the activity-log payload).
  -- 4. For each table_mapping with target_table_id = field.table_id, call revert_field_transform.
  --    Sum the row-counts into v_staged_scrubbed.
  -- 5. DELETE FROM fields WHERE id = p_field_id  -- DB cascades clean up FK rows.
  -- 6. RETURN JSONB build with all cascade counts + project_id (for caller's revalidatePath).
END;
$$;
```

(Body filled in at Stop 1 — this is shape only.)

---

## 4. Open questions (founder decision required before Stop 1)

1. **Atomicity strategy for `deleteField`: RPC vs. sequenced TS calls?** Recommendation: ship the `SECURITY DEFINER` RPC. The known atomicity gap in `createProject`'s fanout (called out in CLAUDE.md §4.4) is the cautionary example. Confirm before writing SQL.

2. **Maintenance-mode gate for `deleteField`?** `updateField` doesn't call `assertMappingWritesEnabled`, but `deleteField` cascades into mapping-write territory. Recommendation: gate `deleteField` on it; leave `createField` and `previewFieldDeletion` ungated. Confirm.

3. **Path D JSONB references (`project_decisions`, `project_lookup_tables`, `project_inferred_targets`)** — these reference fields by id inside JSONB blobs with no FK and no cascade. On field deletion they become orphan refs. Options: (a) leave as-is for FR-3 MVP (orphan refs are tolerated by Path D readers — verify); (b) add a JSONB scrub pass to the RPC; (c) defer to a follow-up FR. Recommendation: (a) for MVP, (c) as a follow-up. Confirm.

4. **Application-level uniqueness check on `(table_id, name)` vs. partial unique index?** No `UNIQUE` exists today. Recommendation: app-level pre-check now, partial unique index in a follow-up after a collision audit on existing data. Confirm. (If you want the index now, FR-3 needs an extra migration + a data-cleanup migration first.)

5. **Retrofit `field_updated` activity logging into existing `updateField` in the same PR?** It's a small, principled addition to close the existing logging gap. Recommendation: yes, include. Confirm.

6. **Zod input validation on `createField`?** The reference `updateField` has none. Recommendation: yes for `createField` (free-text user input is a trust boundary), follow [lib/actions/projects.ts](lib/actions/projects.ts) canonical adopter pattern. Skip for `deleteField` (input is a UUID only) and `previewFieldDeletion` (same). Confirm.

7. **Soft delete vs. hard delete on fields?** The `fields` table has no `deleted_at` column today. CLAUDE.md §4.4 prefers soft deletes generally. But fields are structural metadata: a soft-deleted field still occupies a column slot, can collide on name with a future field, and would need to be filtered out of every read path. Recommendation: hard delete — fields are not customer data records, they are schema definitions. Confirm.

---

## 5. Contract validation

**The contract at the top of the prompt:** "add `createField`, `deleteField`, and `previewFieldDeletion` actions for the Schema Overview".

**Holds.** All three signatures are achievable on top of the existing pattern. Recommended signatures:

```ts
// createField
type CreateFieldInput = {
  tableId: string
  name: string
  dataType: string
  inferredType?: string | null
  isNullable?: boolean
  isPrimaryKey?: boolean
  isForeignKey?: boolean
  fkReference?: string | null
  description?: string | null
}
export async function createField(
  input: CreateFieldInput
): Promise<{ success: boolean; data?: Field; error?: string }>

// previewFieldDeletion
export async function previewFieldDeletion(
  fieldId: string
): Promise<{ success: boolean; data?: FieldDeletionPreview; error?: string }>

// deleteField
export async function deleteField(
  fieldId: string
): Promise<{ success: boolean; data?: { cascadeCounts: FieldDeletionPreview['counts']; hadAuthoredSql: boolean }; error?: string }>
```

**Signature changes recommended versus the prompt's implied contract:**

- `createField` should return the inserted `Field` row (not just `{success}`) so the UI can append it to its in-memory schema overlay without a refetch — mirrors `updateField`.
- `previewFieldDeletion` returns a typed `FieldDeletionPreview` object (see §4 for shape) including `stagedRowsCapped: boolean` so the UI can render "100+" correctly.
- `deleteField` echoes the cascade counts in its response so the UI can show a post-delete confirmation toast ("Deleted field X — removed 3 mappings, 12 staged-row keys") without a separate read.

**No part of the contract is blocked by the codebase's current state.** All gaps are addressable by additive migrations (RPC, optional small RPC for the count helper) and additive TypeScript.

**Stop 1 cannot start until Open Questions §1, §2, §3 are answered.** §4–§7 have recommended defaults that can proceed without explicit confirmation, but flagging them keeps the implementation aligned with founder intent.
