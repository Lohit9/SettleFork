# PR Ω — Multi-Partition Target Tables (Design Doc)

> **STATUS:** Investigation only. No files modified. READ-ONLY analysis of HEAD across data model, apply path, AI pipeline, and UI. Citations are file:line throughout — verify before implementing.
>
> **PROBLEM SHAPE.** Today Settle assumes each target table is filled from one source table (with cross-table contributors merged via FK joins for individual fields). Rootstock's Item Master target needs to UNION rows from multiple source tables (Engineering BOM Masters, Products, Inventory Items, …), each producing a non-overlapping subset of the target rows. The "partition" primitive splits a target table into N disjoint subsets, each with its own source table, optional filter SQL, and per-field mappings.
>
> **GOAL OF THIS DOC.** Map the change surface across the 4 layers; identify the minimum-viable cut for the Rootstock pilot; propose a 3-PR breakdown.

---

## Table of contents

1. [Current data model snapshot](#1-current-data-model-snapshot)
2. [Current apply path](#2-current-apply-path)
3. [Current AI mapping pipeline](#3-current-ai-mapping-pipeline)
4. [Current mapping page UI](#4-current-mapping-page-ui)
5. [Required changes per layer](#5-required-changes-per-layer)
6. [Minimum viable cut for Rootstock pilot](#6-minimum-viable-cut-for-rootstock-pilot)
7. [Regression risk in existing single-partition behavior](#7-regression-risk-in-existing-single-partition-behavior)
8. [Recommended PR breakdown](#8-recommended-pr-breakdown)

---

## 1. Current data model snapshot

### 1.1 `table_mappings`

Defined in [`supabase/migrations/002_foundation.sql:86-96`](../dev/settle-platform/supabase/migrations/002_foundation.sql#L86-L96):

```sql
CREATE TABLE table_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  source_table_id UUID REFERENCES tables(id)   ON DELETE CASCADE NOT NULL,
  target_table_id UUID REFERENCES tables(id)   ON DELETE CASCADE NOT NULL,
  confidence      NUMERIC(5,2),
  status          TEXT DEFAULT 'needs_review'
                  CHECK (status IN ('needs_review', 'approved', 'rejected')),
  ai_reasoning    TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

- **No UNIQUE constraint** on `(project_id, source_table_id, target_table_id)`. Multiple TMs can already legally share the same `target_table_id` across different source tables. Indexes (`002:186-188`) are non-unique on each FK.
- RLS: `table_mappings_policy` ([`002:325`](../dev/settle-platform/supabase/migrations/002_foundation.sql#L325)) — direct `project_id` gate.
- No subsequent migration alters this table.

**Implication for partitions.** A `table_mapping` row already corresponds to a `(source_table → target_table)` pair, which is exactly what a partition is. No schema change is structurally required to represent N partitions sharing a target table — N `table_mappings` rows already do it. What is missing is (a) a way to attach a row-filter to each TM, and (b) a way to make TFMs partition-aware.

### 1.2 `target_field_mappings` (TFMs)

Defined in [`supabase/migrations/074_mapping_redesign_data_migration.sql:136-164`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L136-L164):

```sql
CREATE TABLE public.target_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  target_field_id UUID NOT NULL REFERENCES public.fields(id)   ON DELETE CASCADE,
  confidence NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','approved','rejected')),
  ai_reasoning TEXT,
  is_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledgment_reason TEXT,
  combination_type TEXT CHECK (combination_type IN ('single','concat_space','concat_comma','custom_sql')),
  combination_sql TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, target_field_id)
);
```

- **🚨 BLOCKER: `UNIQUE (project_id, target_field_id)`** at [`074:163`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L163). One TFM per target field per project. With partitions, the same target field is populated by N partitions, each potentially needing its own SQL → must hold N TFMs.
- Later alterations: migration 075 adds `needs_transformation`; migration 092 adds `experiment_run_id`. Neither touches the unique constraint.
- RLS policies at [`074:267-284`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L267-L284) hop through `project_id` only — unchanged by adding a partition column.

**App-code cardinality assumptions on `target_field_id`:**
- [`lib/actions/mappings.ts:614`](../dev/settle-platform/lib/actions/mappings.ts#L614) `getMappings` — flat list, no `.single()` on target_field_id but assumed unique downstream.
- Many-to-one / one-to-many detection in [`app/app/projects/[projectId]/mapping/MappingContent.tsx:3062-3068, 3076-3087`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L3062-L3068) uses `.find(f => f.target_field_id === …)` → returns first match, ignoring partitions.
- Stats: [`MappingContent.tsx:2778`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L2778) uses `mappedTargetIds = new Set(primaryFMs.map(fm => fm.target_field_id))` to compute unmapped → treats target_field_id as a single membership token.
- Add-contributing flow: [`MappingContent.tsx:1798`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1798) — `.find(f => f.target_field_id === pendingPair.tgtId && !f.is_contributing)` to locate the primary.

### 1.3 `mapping_sources`

Defined in [`supabase/migrations/074_mapping_redesign_data_migration.sql:186-214`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L186-L214):

```sql
CREATE TABLE public.mapping_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_field_mapping_id UUID NOT NULL REFERENCES public.target_field_mappings(id) ON DELETE CASCADE,
  source_field_id  UUID REFERENCES public.fields(id) ON DELETE CASCADE,
  source_table_id  UUID REFERENCES public.tables(id) ON DELETE CASCADE,
  confidence                NUMERIC(5,2),
  ai_reasoning              TEXT,
  similar_fields_considered JSONB,
  type_compatibility        TEXT,
  join_spec                 JSONB,
  ordinal                   INTEGER NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_field_mapping_id, source_field_id)
);
```

- **UNIQUE (target_field_mapping_id, source_field_id)** at [`074:213`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L213) — fine; partitions add new TFMs, not new source fields under the same TFM.
- `join_spec JSONB` already stores cross-table FK linkage at the per-source level.
- `ordinal` distinguishes dominant (=0) from contributors.

### 1.4 `transformations`

Schema as redesigned by migration 074 ([`074:1276-1277`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L1276-L1277) makes `target_field_mapping_id NOT NULL`). Soft invariant: at most one transformation per TFM, asserted in [`lib/actions/transformations.ts:33`](../dev/settle-platform/lib/actions/transformations.ts#L33) and policed by `tests/integration/transformations-unique-invariant.test.ts`. **Not DB-enforced.** Already partition-friendly: N TFMs → N transformations.

### 1.5 `source_field_acknowledgments`

[`074:237-247`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L237-L247). Keyed `(project_id, source_field_id)`. Unaffected by partition primitive.

### 1.6 Summary table

| Table | UNIQUE on | Partition impact |
|---|---|---|
| `table_mappings` | (none) | **Already supports N TMs per target_table** — natural row for "partition." |
| `target_field_mappings` | `(project_id, target_field_id)` | **Hard blocker.** Must relax to `(project_id, target_field_id, table_mapping_id)` or equivalent. |
| `mapping_sources` | `(tfm_id, source_field_id)` | Unchanged. |
| `transformations` | (none; soft invariant per TFM) | N TFMs → N transformations. App pattern `.maybeSingle()` survives. |
| `source_field_acknowledgments` | `(project_id, source_field_id)` | Unchanged. |

**No existing column for filter SQL / WHERE / discriminator / partition** — verified by grep across migrations + `lib/`. `filter_sql`, `where_clause`, `partition`, `subset`, `discriminator` return zero hits in mapping context.

**There is no FK from TFM → TM today.** TFM is keyed `(project, target_field)` and finds its "table mapping" only by joining through `source_field → source_table → table_mapping`. For partitions to disambiguate "which partition does this TFM belong to?", we need to add `target_field_mappings.table_mapping_id` (or a synthesised `partition_id`).

---

## 2. Current apply path

### 2.1 End-to-end flow

```
User clicks Apply on a TFM (mapping or transform page)
  ↓
applyTransform(tfmId, sql)                  ← lib/actions/transformations.ts:2496-2738
  ├─ Load TFM context + mapping_sources
  ├─ Mapped TFM:     buildJoinSpec(tfmId)   → RpcJoinSpec | null
  │                  wrapFieldRefsInJsonb(sql, fieldMap)
  │                  → RPC dq_apply_field_transform_joined()        [migration 076]
  └─ Value-assign:   → RPC dq_apply_field_transform() (loop per TM) [migration 074]
  ↓
RPC writes to staged_data_rows
  - same-table:     INSERT … FROM data_rows d WHERE d.table_id=$source ORDER BY row_number
  - cross-table:    INSERT … FROM data_rows d <LEFT JOIN LATERAL …>j0 WHERE d.table_id=$source
  ↓
staged_data_rows.transformed_row_data (JSONB keyed by target field name) accumulates per dominant row
```

### 2.2 Server action — `applyTransform`

[`lib/actions/transformations.ts:2496-2738`](../dev/settle-platform/lib/actions/transformations.ts#L2496-L2738).

- **Mapped TFM branch** ([`:2607-2615`](../dev/settle-platform/lib/actions/transformations.ts#L2607-L2615)): single RPC call passing `p_target_field_mapping_id`, `p_target_field_name`, `p_transform_sql`, `p_join_spec`.
- **Value-assignment branch** ([`:2640-2670`](../dev/settle-platform/lib/actions/transformations.ts#L2640-L2670)): loops every `table_mapping` whose `target_table_id` matches the TFM's target field's table, and calls the legacy RPC per (source, target) pair.
- DML pre-flight guard (`assertNoDml`) at [`:2574`](../dev/settle-platform/lib/actions/transformations.ts#L2574) — hot-fix from PR ζ.1 work-in-progress.

### 2.3 RPC — `dq_apply_field_transform_joined`

[`supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql:76-391`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L76-L391).

Three regions:

1. **Validation / blocklist** (lines 154–171). Field name regex + DML/DDL/system-table scan + window-function ban.
2. **Same-table branch** (lines 267–325). Identical byte-shape to migration 074's RPC.
3. **Cross-table branch** (lines 327–391). Builds `v_lateral_clauses` from `p_join_spec.joins[]` (lines 238–253) and substitutes into the FROM template.

**The single multiplex point.** The INSERT template at [`076:361-378`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L361-L378):

```sql
INSERT INTO staged_data_rows (table_mapping_id, source_table_id, target_table_id,
                              row_number, source_row_data, transformed_row_data)
SELECT $1, $2, $3,
       d.row_number,
       d.row_data,
       jsonb_build_object(
         '%s',
         CASE WHEN (%s) IS NOT NULL THEN to_jsonb((%s)::text) ELSE 'null'::jsonb END
       )
FROM data_rows d%s
WHERE d.table_id = $2
ORDER BY d.row_number
```

The `%s` at line 371 is `v_lateral_clauses`. To do `… FROM source_A WHERE filter_A UNION ALL FROM source_B WHERE filter_B`, the SMALLEST change is at this single FROM clause: replace `FROM data_rows d` with a `FROM (<UNION ALL of partition SELECTs>) d` subquery — and drop the `WHERE d.table_id = $2` clause (it'd be scoped inside each branch).

### 2.4 RPC — `dq_apply_field_transform` (legacy/VA)

[`supabase/migrations/074_mapping_redesign_data_migration.sql:1572-1659`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L1572-L1659). Same INSERT shape, no LATERAL. Used for value assignments and pre-PR-ζ same-table TFMs.

### 2.5 Dominant-table selection

In [`lib/utils/transform-cross-table.ts:249-402`](../dev/settle-platform/lib/utils/transform-cross-table.ts#L249-L402), specifically:

```typescript
// :274
const dominantRow = sourceRows.find((r) => r.ordinal === 0) ?? sourceRows[0]
const dominantTableId = dominantRow.source_table_id
```

**Strictly ordinal-based.** Not row-count, not heuristic. With partitions, each partition has its own dominant (its own `table_mapping`); the action layer can drive multiple RPC calls (or one RPC call with multi-partition spec) using the partition's TM as the anchor.

### 2.6 Staging model

- `data_rows`: source partition. Keyed `(table_id, row_number)`. `row_data JSONB` keyed by **source** field name.
- `staged_data_rows`: write sink. Keyed `(table_mapping_id, row_number)`. `transformed_row_data JSONB` keyed by **target** field name. Each TFM apply either INSERTs a new row or UPDATEs the existing row's `transformed_row_data` via `jsonb_set`.

This is naturally partition-friendly: each partition has its own `table_mapping_id`, so its rows land in their own `staged_data_rows` partition without collision.

### 2.7 Answers to apply-path questions

1. **Smallest multiplex point**: 1 line, [`076:371`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L371) (FROM clause). Replace with UNION ALL subquery.
2. **Dominant communicated**: implicit via `p_join_spec.dominant_table_id` (validated against TM's `source_table_id` at [`076:193`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L193)).
3. **Filter SQL today**: **does not exist anywhere.** Needs a new column (proposal: `table_mappings.filter_sql TEXT NULL`).
4. **data_rows vs staging**: both physical, not JSONB stash. data_rows = read source per table_id. staged_data_rows = write sink per table_mapping_id.

---

## 3. Current AI mapping pipeline

### 3.1 Orchestrator

`runMappingGeneration` at [`lib/ai/mapping-engine.ts:1738-2172`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1738-L2172).

Phases:

1. **Schema fetch** ([`:1765-1789`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1765-L1789)) — parallel reads of source/target metadata.
2. **AI context build** ([`:1791-1813`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1791-L1813)) — `buildAIContext()` with per-role sample budgets.
3. **Per-source batch loop** ([`:1840-2029`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1840-L2029)) — for each source table, build prompt and dispatch.
4. **Persistence** ([`:2031-2137`](../dev/settle-platform/lib/ai/mapping-engine.ts#L2031-L2137)) — write `table_mappings`, then per-TFM via RPC `dq_create_target_field_mapping`.
5. **Validation** ([`:2095-2136`](../dev/settle-platform/lib/ai/mapping-engine.ts#L2095-L2136)) — deterministic post-checks.

### 3.2 Output shape

`ClaudeTableMapping` ([`:269-275`](../dev/settle-platform/lib/ai/mapping-engine.ts#L269-L275)) is **per (source_table → target_table) pair**, with field_mappings nested inside. One source → potentially N target pairs in a single call. No notion of "this pair contributes a subset of target rows" — it's all-or-nothing on the target table.

`ClaudeFieldMapping` ([`:255-267`](../dev/settle-platform/lib/ai/mapping-engine.ts#L255-L267)) carries confidence, type_compatibility, mapping_type. No partition/discriminator field.

### 3.3 Prompts

`MAPPING_GENERATION_SYSTEM_PROMPT` ([`:297-396`](../dev/settle-platform/lib/ai/mapping-engine.ts#L297-L396)) — locked content, pinned by `tests/actions/generate-mappings-orchestration.test.ts`. ~4.5K chars. Sections: transformation rules, multi-field patterns, table-level matching, scoring guidelines.

`AGENT_TOOL_GUIDANCE` ([`lib/ai/agent-tool-guidance.ts:51`](../dev/settle-platform/lib/ai/agent-tool-guidance.ts#L51)) — **currently empty string** post-May-2026 incident HOT-FIX 4.

User message ([`:1151-1204`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1151-L1204)) composes: source schema + target schema + business context + intelligence ctx + `<other_source_tables>` peers.

### 3.4 What the AI sees today

- Source/target field names, types, nullability, PK/FK, check constraints.
- Sample values: 5 (heritage) or 50/30 (agent-mode) per field.
- Distinct value distributions: top 15 with counts ([`:1799`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1799)).
- Business context (≤2000 chars from `readBusinessContext()` at [`:1810-1811`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1810-L1811)).
- Peer source tables for cross-source disambiguation ([`:1854-1862`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1854-L1862)).
- **Not seen:** total row counts per table, statistical correlation between fields, explicit cross-source partition hints.

### 3.5 Agent loop adoption

Gated on `AI_PHASE_3_ENABLED === '1'` ([`:1758`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1758)). Single-agent path: `runSingleAgentMappingLoop` ([`lib/ai/single-agent-mapping.ts`](../dev/settle-platform/lib/ai/single-agent-mapping.ts)). Multi-agent path: `lib/ai/multi-agent-orchestrator.ts` — shell only, voting aggregators stubbed.

**Data-scanning tools currently DISABLED** for mapping. Handlers exist in `lib/ai/agent-tools.ts` (`makeQueryFieldDataHandler`, `makeCountDistinctPatternsHandler`, `makeCrossFieldCorrelationHandler`) and underlying RPCs in migration 085, but HOT-FIX 5 removed registration from the mapping_generate callsite. Implication: a partition-detection AI call cannot today rely on the agent loop to scan data — it must rely on profile data pre-loaded into context, or use a server-side scan and feed results in.

### 3.6 No existing partition concept

Grep confirms: `partition`, `subset`, `discriminator`, `disjoint`, `union` all return zero hits in mapping AI prompts or schemas.

### 3.7 Where partition detection slots in

Between [`mapping-engine.ts:1813`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1813) (post-context-build) and [`:1814`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1814) (pre-batch-loop). A Phase-0 step that:

1. For each target table with N candidate source tables, asks: "do these N sources naturally partition the target?"
2. Emits `{ target_table_id, partitions: [{ source_table_id, discriminator?, filter_sql?, justification }] }`.
3. Feeds into the per-source loop as an additional constraint (or rewrites the loop to be per-partition).

This is **one helper call** + a small change to the loop's input. Zero downstream rewrite if the helper returns null (heritage behavior).

### 3.8 Answers to AI-pipeline questions

1. **Table-pair-first then fields**: yes, per-source loop emits `ClaudeTableMapping[]` with nested field_mappings.
2. **Row-count distributions visible**: top-15 distinct value distributions are visible; total row counts and full cardinality histograms are not. Sufficient for proposing discriminators, insufficient for proving disjointness.
3. **Smallest insertion**: between [`:1813-1814`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1813-L1814), one helper call.
4. **Data-scanning tools available**: NO — disabled. Phase-0 partition detection must scan server-side and feed results in, not let the AI scan.

---

## 4. Current mapping page UI

### 4.1 Page entry

[`app/app/projects/[projectId]/mapping/page.tsx:18-66`](../dev/settle-platform/app/app/projects/[projectId]/mapping/page.tsx#L18-L66). Branches on `projects.use_mapping_redesign`:

- **Legacy** (flag off): `getMappings()` → `MappingContent`.
- **Redesign** (flag on): `getMappingsForRedesign()` → `MappingRedesignContent`.

### 4.2 Legacy data shape

[`getMappings`](../dev/settle-platform/lib/actions/mappings.ts#L614) returns `MappingsResult` with `tableMappings: RichTableMapping[]` (per `(source_table, target_table)` pair) and `fieldMappings: RichFieldMapping[]` nested.

`RichTableMapping` ([`lib/types/mappings-ui.ts:59-79`](../dev/settle-platform/lib/types/mappings-ui.ts#L59-L79)): `{ id, source_table_id, target_table_id, fieldMappings[] }`.

`RichFieldMapping` ([`lib/types/mappings-ui.ts:17-57`](../dev/settle-platform/lib/types/mappings-ui.ts#L17-L57)): `{ id, table_mapping_id, source_field_id, target_field_id, confidence, status, is_contributing, transformation }`.

**Note:** `table_mapping_id` is already on every field mapping — partitions can be discriminated client-side without schema change, IF the server stops uniqueing by target_field_id.

### 4.3 Legacy rendering tree

`MappingContent.tsx`:

- `MappingContent` (top-level client)
  - `MappingStatPills` ([`:348-390`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L348-L390)) — totals across all FMs.
  - One `TableMappingCard` per `RichTableMapping` ([`:1496-1906`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1496-L1906)).
    - `FieldMappingRow` per FM ([`:1619-1692`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1619-L1692)).
    - Inline unmapped rows ([`:1698-1772`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1698-L1772)).
  - `MappingDetailsPanel` drawer ([`:1910-2455`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1910-L2455)) — tabs: Details, Transform, Actions.

### 4.4 Hardcoded "one TFM per target field" assumptions

| File:line | Pattern | What breaks under partitions |
|---|---|---|
| [`MappingContent.tsx:1798`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1798) | `.find(f => f.target_field_id === pendingPair.tgtId && !f.is_contributing)` | Returns first match; ambiguous when 2 partitions both map this target field. |
| [`MappingContent.tsx:2353`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L2353) | Transform link `/transform?targetFieldMappingId=${fm.id}` | OK — fm.id is unique per TFM. Drawer just needs partition awareness in label. |
| [`MappingContent.tsx:2778`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L2778) | `mappedTargetIds = new Set(primaryFMs.map(fm => fm.target_field_id))` | Field is "mapped" even if only one partition covers it — partial coverage invisible. |
| [`MappingContent.tsx:3004`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L3004) | Unmapped target computation | Same as above. |
| [`MappingContent.tsx:3062-3068, 3076-3087`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L3062-L3068) | Many-to-one / one-to-many detection via `.find(target_field_id===...)` | False positives across partitions. |
| Approve flow | `updateFieldMappingStatus(fmId, …)` per FM | OK — independent per TFM, no cross-partition coupling needed. |

### 4.5 Redesign UI

[`MappingsForRedesignResult`](../dev/settle-platform/lib/types/mappings-for-redesign.ts#L51-L162) — `rows: MappingRow[]` is a discriminated union pre-grouped server-side by target table. Allows multiple `MappedRow` instances with the same `target_field_id` natively. **Partition-ready by data shape** — needs only a `partition_id` or `table_mapping_id` discriminator on each row.

### 4.6 Answers to UI questions

1. **Flat vs grouped**: legacy = flat (`RichTableMapping[]` w/ nested), client groups by `(source, target)` pair. Redesign = pre-grouped on server.
2. **Hardcoded assumptions**: see table above — five spots in `MappingContent.tsx`.
3. **Smallest tab-strip change**: add `<PartitionTabs>` above `FieldMappingRow` list in `TableMappingCard` (line 1579); modify `filteredMappings` (line 2953) to filter by selected `table_mapping_id`; update `headerStats` (line 2743) to scope per partition.
4. **Reusable empty state**: yes — existing "inline + Map" affordance ([`:1698-1849`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1698-L1849)) works per partition with no new pattern.

---

## 5. Required changes per layer

### 5.1 Data model

**Stays the same.**
- `table_mappings` schema (already supports N TMs per target_table).
- `mapping_sources` schema.
- `transformations` schema.
- `source_field_acknowledgments` schema.

**Net-new.**
- `target_field_mappings.table_mapping_id UUID REFERENCES table_mappings(id) ON DELETE CASCADE` (nullable during backfill; NOT NULL after).
- `table_mappings.filter_sql TEXT NULL` — the WHERE clause applied to that partition's source data. NULL = no filter = whole source.
- (Optional) `table_mappings.partition_label TEXT NULL` — user-facing name like "Engineering items", "Sellable products."
- (Optional) `table_mappings.partition_ordinal INT NULL` — for stable tab ordering.

**Modified.**
- `target_field_mappings`: drop `UNIQUE (project_id, target_field_id)`; replace with `UNIQUE (project_id, target_field_id, table_mapping_id)`. Risk: backfill of `table_mapping_id` on existing TFMs.
- RLS on `target_field_mappings` ([`074:267-284`](../dev/settle-platform/supabase/migrations/074_mapping_redesign_data_migration.sql#L267-L284)): no change — still gated by `project_id`. The new `table_mapping_id` FK transitively binds to the same project.

**Migration sequence.**
1. ADD COLUMN `target_field_mappings.table_mapping_id UUID REFERENCES table_mappings(id)`. Nullable.
2. ADD COLUMN `table_mappings.filter_sql TEXT NULL`. (Optional `partition_label`, `partition_ordinal` together.)
3. Backfill TFM → TM: for each TFM, find the TM matching `(project_id, mapping_sources.source_table_id of ordinal=0, target_field's table_id)`. **One-time:** since every existing project has at most 1 TM per `(source, target_table)`, the backfill is deterministic. Handle edge cases:
   - TFMs with no `mapping_sources` (value assignments, acknowledgments): pick any TM for the target table, or create an implicit "default partition" TM.
   - Same target field referenced via two TMs (cross-table contributors that span TMs): pick the TM matching the dominant source.
4. Verify backfill: no TFM has NULL `table_mapping_id`. Then ALTER COLUMN NOT NULL.
5. DROP CONSTRAINT old UNIQUE `(project_id, target_field_id)`; ADD UNIQUE `(project_id, target_field_id, table_mapping_id)`.

**Risk surface.**
- App code reads of TFM by `(project_id, target_field_id)` must add `table_mapping_id` to the predicate or accept multi-row results. Audit `lib/actions/mappings.ts` and `lib/actions/transformations.ts`.
- ON CONFLICT clauses in inserts (search `'target_field_mappings'` + `on_conflict` / `onConflict`) need to update their conflict target.
- RPC `dq_create_target_field_mapping` (referenced in [`mapping-engine.ts:1691`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1691)) — likely uses the existing UNIQUE for upsert semantics; needs a new parameter `p_table_mapping_id` and updated conflict target.

### 5.2 Apply path

**Stays the same.**
- `dq_apply_field_transform_joined` and `dq_apply_field_transform` RPC signatures (in MVP — see §6).
- Cross-table LATERAL pattern.
- Field-ref rewriting in `lib/utils/transform-helpers.ts`.
- `staged_data_rows` schema and write semantics.

**Net-new (full version).**
- A new RPC variant `dq_apply_field_transform_partitioned(p_target_field_id, …, p_partitions JSONB)` that takes an array of `{ source_table_id, transform_sql, join_spec, filter_sql }` and emits a UNION ALL INSERT — touches the single FROM-clause multiplex at [`076:371`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L371).
- Server action `applyAllPartitionsForField(target_field_id)` that fetches all TFMs sharing the target field, validates each partition's SQL, and dispatches to the new RPC.

**Modified.**
- `applyTransform()` ([`transformations.ts:2496`](../dev/settle-platform/lib/actions/transformations.ts#L2496)): minimal change — when a TFM has `table_mapping_id` set, scope the existing single-RPC apply to that partition's source. Today the action already implicitly does this via `buildJoinSpec`'s ordinal=0 dominant; the change is that the dominant is now derived from `tfm.table_mapping_id → source_table_id`, not from `mapping_sources` ordering.
- `buildJoinSpec()` ([`transform-cross-table.ts:249`](../dev/settle-platform/lib/utils/transform-cross-table.ts#L249)): unchanged for single-partition; the partition's TM identifies the dominant.

**Risk surface.**
- VA branch's loop ([`transformations.ts:2640-2670`](../dev/settle-platform/lib/actions/transformations.ts#L2640-L2670)) iterates "every TM matching target_table." With partitions, all N TMs for that target table now write to the same VA, but each scoped to its own source — which is actually the correct behavior already. **No code change needed for VA under partitions** — the existing loop just becomes more meaningful.
- `staged_data_rows` is keyed `(table_mapping_id, row_number)` — partitions naturally don't collide since each has its own TM. ✓
- The transform SQL written by the AI references field names; if two partitions have different source schemas, the same target field's two TFMs have **different** transform SQL (one per source). The UNION ALL emits both. App code must avoid assuming a target field's transform SQL is canonical.

### 5.3 AI pipeline

**Stays the same.**
- `MAPPING_GENERATION_SYSTEM_PROMPT` body (pinned by tests).
- Per-source batch loop ([`mapping-engine.ts:1840-2029`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1840-L2029)).
- Persistence path (writes to `table_mappings` first, then TFMs).

**Net-new.**
- Phase-0 partition-detection helper (inserted between [`:1813-1814`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1813-L1814)). Single AI call per target table that has multiple candidate sources. Emits `{ target_table_id, partitions: [{ source_table_id, discriminator_field_id?, filter_sql?, justification }] }`.
- New Zod schema for the partition-proposal response.
- Optional: re-enable a narrow `query_field_data` tool just for the partition detector (lets the AI verify that distinct values are indeed disjoint across candidate sources).

**Modified.**
- Persistence: after writing `table_mappings`, also write `filter_sql` / `partition_label` from Phase-0 output. Then write TFMs with `table_mapping_id` populated.
- Prompt for per-pair field mapping: when a target table has multiple partitions, the per-pair prompt should mention that "this source covers partition X of target table Y" so the AI scopes its field mappings correctly.

**Risk surface.**
- AI hallucinates partition discriminators that don't actually disjoint-cover the target. Mitigation: deterministic post-validation that checks the partition filter SQLs are well-formed (use the DML blocklist) and that the union of sources matches the union of target row sources (impossible to validate fully at proposal time — only validatable at apply time).
- Cost increase: Phase-0 is one extra AI call per project (or per target with N candidates). At <$0.50 incremental per project, acceptable.

### 5.4 UI

**Stays the same.**
- `MappingContent` top-level rendering loop.
- `MappingStatPills` aggregate stats.
- Approve / reject per-TFM flow.
- Transform drawer plumbing.

**Net-new.**
- `<PartitionTabs>` component above the `FieldMappingRow` list inside `TableMappingCard`. Renders a horizontal strip of tabs, one per `table_mapping_id` for the target table.
- (Optional) Partition-management UI: "Add partition," "Edit filter SQL," "Rename partition."
- (Optional) Aggregate view across all partitions for a target table — "show me every TFM for Item Master regardless of partition."

**Modified.**
- [`TableMappingCard`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1496) — group `RichTableMapping[]` by `target_table_id`, render one card per target table with internal partition tabs. (Current: one card per `(source, target)` pair.)
- [`MappingContent.tsx:1798`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L1798) — `.find()` for adding-contributing must filter by partition.
- [`MappingContent.tsx:2778`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L2778) — unmapped computation must dimension by partition, not just target_field_id.
- [`MappingContent.tsx:3062-3068, 3076-3087`](../dev/settle-platform/app/app/projects/[projectId]/mapping/MappingContent.tsx#L3062-L3068) — many-to-one detection must scope to a single partition.

**Risk surface.**
- Existing projects (N=1 partition) — partition tabs should auto-hide when there's only one partition. Otherwise existing UX gets a visual regression.
- Stats: when partition A is fully mapped but B is unmapped, the field is "partially mapped." MappingStatPills needs a new state — or aggregate count of `(target_field, partition)` instead of `target_field`.

---

## 6. Minimum viable cut for Rootstock pilot

### 6.1 The hard requirement

Item Master, single target table, populated from 3 source tables with disjoint row subsets. Apply path must produce a single UNION-ALL'd `staged_data_rows` set for Item Master.

### 6.2 Simplifications safe to take

1. **Skip the dedup engine.** Customers write filter SQL by hand for each partition's `filter_sql` column. The system trusts the customer's filter to be disjoint. No auto-generated dedup conditions. Risk: row duplication if filters overlap. Mitigation: a post-apply validation check that asserts COUNT(target rows) ≤ SUM(COUNT(source rows scoped by each filter)) — flag for human review if not equal.
2. **Skip AI partition detection.** Customers manually create partitions via UI (or via the Rootstock loader script for the pilot). AI auto-detection deferred. Justifies a smaller blast radius for PR Ω.1.
3. **Skip the unified single-RPC UNION ALL.** For pilot, each partition is applied independently via the existing `dq_apply_field_transform_joined` RPC — one call per partition. Each writes to `staged_data_rows` keyed by `(table_mapping_id, row_number)` so partition rows don't collide. Downstream consumers (Validate, Migration Center) query staged_data_rows joined to table_mappings and naturally see the UNION.

### 6.3 Minimum DB changes

1. `target_field_mappings.table_mapping_id` (FK, nullable → backfill → NOT NULL).
2. `table_mappings.filter_sql` (TEXT NULL).
3. Replace `UNIQUE (project_id, target_field_id)` with `UNIQUE (project_id, target_field_id, table_mapping_id)`.

**That's it for the data model MVP.** No `partition_label`, no `partition_ordinal` — those are UX nice-to-haves that ship in a follow-up.

### 6.4 Minimum apply path changes

1. **`applyTransform` already routes per-TFM.** With each partition's TFM carrying `table_mapping_id`, the existing single-RPC path applies each partition independently. **Zero RPC changes for MVP.**
2. The action layer must pass the partition's source-table-scoped `mapping_sources` (i.e. for a partition's TFM, the dominant source is the partition's TM source_table). The existing `buildJoinSpec` derives this from `mapping_sources.ordinal=0`. As long as each partition's TFM has `mapping_sources` rows pointing to its own source table, **no code change needed.**
3. A post-apply hook in Validate or Migration Center surfaces "rows added by partition X / Y / Z" for human verification.

**Filter SQL application.** This is the only true new behavior for MVP. Options:

- **A.** Apply filter at RPC call time by injecting it into the WHERE clause of the existing INSERT. Need a new RPC param `p_filter_sql TEXT NULL` and a small change to the WHERE clause at [`076:372`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L372) to AND it in. ~10 LOC RPC change.
- **B.** Apply filter post-hoc by DELETEing rows from `staged_data_rows` that fail the filter. Slower, but no RPC change. Not recommended.

**A is correct.** Tiny diff, easily reversible if the filter has a syntax bug.

### 6.5 Minimum UI changes

1. **Manual partition creation form** — modal/inline form to create a TM with `filter_sql`. Reuses existing TM creation flow + adds a "Filter SQL" textarea.
2. **Tab strip when N≥2 partitions** — show partition tabs above the FM list; default-select the first; auto-hide when N=1.
3. **Apply button per partition** — separate apply for each partition's TFMs.

**Defer:** stats per partition (treat all as one aggregate for now), partition-management UI (rename, reorder), validation feedback.

### 6.6 Minimum AI pipeline changes

**Zero.** Pilot customers manually create partitions. AI continues proposing per-source-table mappings; the system stitches them into partitions client-side / via the loader.

### 6.7 What MVP excludes (deferred to follow-up)

- AI partition detection.
- Auto-generated filter SQL (dedup).
- Partition labels / reordering.
- Cross-partition stats / coverage.
- Single-RPC UNION ALL apply.
- Validation-stage partition-aware diff.

### 6.8 Pilot success criteria

For Rootstock's Item Master:
- Three partitions created (Engineering BOM Masters / Products / Inventory Items).
- Each partition has its own `filter_sql` written by hand.
- Apply runs successfully for each partition.
- `staged_data_rows` contains the union; no duplicates; Validate stage sees the merged set.
- Migration Center packages the UNION as a single Item Master extract.

---

## 7. Regression risk in existing single-partition behavior

### 7.1 The N=1 contract

After PR Ω.1, every existing project must have exactly one `table_mapping` per `(source_table_id, target_table_id)` pair, and every existing TFM must have `table_mapping_id` populated via backfill. The backfill is deterministic because today there is at most one TM per pair (no UNIQUE constraint enforces it, but no app code creates duplicates — verified by [`mapping-engine.ts:2068-2079`](../dev/settle-platform/lib/ai/mapping-engine.ts#L2068-L2079) using `existingPairSet`).

**Edge case.** If any project happens to have two TMs for the same `(source, target)` pair (data drift), the backfill must pick one and merge. Detection query before the migration:

```sql
SELECT project_id, source_table_id, target_table_id, COUNT(*) AS dup_count
FROM table_mappings
GROUP BY project_id, source_table_id, target_table_id
HAVING COUNT(*) > 1;
```

**Mitigation.** Run pre-migration in production to confirm zero rows. If non-zero, write a one-shot fix-up script.

### 7.2 Risks per change

| Change | What could regress | Mitigation |
|---|---|---|
| ADD COLUMN `target_field_mappings.table_mapping_id` (nullable) | None (additive). | None needed. |
| Backfill `table_mapping_id` | Wrong TM picked → TFM bound to wrong partition. | Deterministic SQL: pick the TM whose `source_table_id` matches the TFM's ordinal=0 `mapping_source.source_table_id`. Verify count post-backfill. |
| SET NOT NULL on `table_mapping_id` | If any TFM has no `mapping_sources` (acknowledgments, VAs), backfill leaves NULL → migration fails. | Pre-flight: for VAs/acks, pick any TM matching the target_field's table, OR create a synthetic `table_mapping` per `(NULL source, target_table)`. Decide before migration. |
| DROP old UNIQUE; ADD new UNIQUE | Duplicate rows in app data → ADD UNIQUE fails. | Pre-flight count query. |
| ADD `table_mappings.filter_sql` | None (additive, NULL-default). | None. |
| RPC `dq_create_target_field_mapping` accepts new `p_table_mapping_id` | Callers not passing it → DEFAULT NULL → fails NOT NULL constraint. | Add the param with `DEFAULT NULL` initially; ship in same migration; update callers in the same PR; rename to required-param after one cycle. |
| UI: target_field cardinality changed | `.find(target_field_id===…)` returns wrong TFM. | Audit before merge; switch to `.filter()` + partition scope. |
| UI: `mappedTargetIds` membership | "Field is mapped" misreports partial coverage. | Add a `partiallyMapped` state; default to legacy semantics if N=1. |
| Apply path: existing single-partition TFMs | Backfilled `table_mapping_id` becomes the canonical partition → behavior unchanged. | Verify on smoke test against `699fe032` and one mapped non-Rootstock project. |
| AI generation: existing projects regenerating | `runMappingGeneration` writes new TFMs without `table_mapping_id` → constraint violation. | Update the engine to pass `table_mapping_id` for every TFM write (it already knows the TM since it writes the TM first at [`:2068-2079`](../dev/settle-platform/lib/ai/mapping-engine.ts#L2068-L2079)). |

### 7.3 The "if N=1, hide everything new" rule

UI must default-hide partition tabs when there's only one TM per target table. Apply path must behave byte-identically when `filter_sql` is NULL. Phase-0 AI partition detection must produce a single-partition output for single-source targets.

Tests required:
- Integration test: run apply on a heritage project (single partition); confirm `staged_data_rows` output is byte-identical to pre-PR-Ω.
- E2E test: open mapping page for a heritage project; confirm no partition UI is visible.
- Unit test: `runMappingGeneration` output for single-source target is unchanged.

---

## 8. Recommended PR breakdown

### 8.1 PR Ω.1 — Data model + backward-compat migration (no functional change)

**Single concern.** Adds the columns, backfills, swaps the UNIQUE constraint. Zero observable behavior change.

**Files changed:**
- New `supabase/migrations/106_target_field_mappings_table_mapping_id_and_filter_sql.sql`:
  - ADD `target_field_mappings.table_mapping_id` (FK, nullable).
  - ADD `table_mappings.filter_sql TEXT NULL`.
  - Backfill `table_mapping_id` from `mapping_sources.source_table_id` + target field's `tables.id`.
  - SET NOT NULL `target_field_mapping_id` (after verify-no-nulls).
  - DROP old UNIQUE; ADD new UNIQUE.
- Update `lib/ai/mapping-engine.ts` ([`:1691`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1691), [`:2068-2079`](../dev/settle-platform/lib/ai/mapping-engine.ts#L2068-L2079)) to pass `table_mapping_id` when creating TFMs. This requires the engine to write the TM first (already does) and pass its id forward (small change).
- Update `dq_create_target_field_mapping` RPC to accept `p_table_mapping_id` (new param, ON CONFLICT target updated).
- Update `getMappings` / `getMappingsForRedesign` selects to include `table_mapping_id`.
- Update Zod / TypeScript types (`RichFieldMapping` already has it).
- Pre-flight script in `scripts/preflight-pr-omega-1.ts` that runs the duplicate-detection query.
- Tests:
  - Integration: `tests/integration/transformations-unique-invariant.test.ts` extended to assert new UNIQUE.
  - Migration smoke: apply against scratch Supabase; verify counts; verify a heritage project's TFMs all have non-null `table_mapping_id`.

**Apply procedure.** Pause for "last-minute changes?" per CLAUDE.md §2.4. Run pre-flight. Apply migration via Dashboard. Verify counts. Then merge code changes.

### 8.2 PR Ω.2 — Apply path multi-partition support (still works for N=1)

**Single concern.** Apply path scopes per partition; new `filter_sql` is honored.

**Files changed:**
- New `supabase/migrations/107_dq_apply_field_transform_joined_filter_sql.sql`:
  - CREATE OR REPLACE `dq_apply_field_transform_joined` adding `p_filter_sql TEXT DEFAULT NULL`. When non-null, AND it into the WHERE clause at [`076:372`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L372).
  - Same for `dq_apply_field_transform` (VA path).
  - Filter SQL gets the same DML blocklist (with literal-stripping if PR ζ.2 has shipped — otherwise hot-fix client-side).
- `lib/actions/transformations.ts`: `applyTransform` reads `table_mapping.filter_sql` and passes it to the RPC.
- Tests:
  - Integration: apply a TFM with `filter_sql='ProductCategory = ''SELLABLE'''`; verify `staged_data_rows` row count matches expected.
  - Regression: apply heritage TFMs with `filter_sql=NULL`; verify byte-identical output to PR Ω.1 baseline.

### 8.3 PR Ω.3 — UI partition tabs + AI partition detection

**Bundled because partition tabs without AI is the pilot scope, and AI without tabs is unobservable.** Could split if needed.

**Files changed (UI):**
- `app/app/projects/[projectId]/mapping/MappingContent.tsx`:
  - Group `tableMappings` by `target_table_id`; one `TableMappingCard` per target table.
  - Add `<PartitionTabs>` strip when N≥2.
  - Filter `fieldMappings` by selected partition.
  - Update line-:2778 unmapped logic for per-partition coverage.
  - Update lines 3062-3068, 3076-3087 many-to-one detection to scope per partition.
- New `<PartitionForm>` component for manual partition creation.

**Files changed (AI):**
- `lib/ai/mapping-engine.ts`:
  - Insert Phase-0 partition-detection call between lines 1813-1814.
  - New helper `lib/ai/partition-detection.ts` with system prompt + Zod schema.
  - Persist partition proposals as `table_mappings.filter_sql` before per-source loop.
- (Deferred to follow-up) Re-enable narrow `query_field_data` tool.

**Tests:**
- E2E (Playwright/Storybook): partition tabs visible only for N≥2.
- AI snapshot: Phase-0 output for a 3-source target table.

### 8.4 Why this split

- **Ω.1 is reversible.** Schema additions + backfill, no behavior change. Easy to revert; the only "destructive" piece is the UNIQUE swap, which is forward-only but trivial to recompute.
- **Ω.2 is gated by N=1 default.** With `filter_sql=NULL` and one TM per pair, output is byte-identical to pre-PR-Ω. Safe to ship.
- **Ω.3 is the customer-facing change.** All upstream plumbing is in place; this is purely affordance + AI polish. Can be incrementally rolled out — partition tabs first, AI detection second, even within Ω.3.

### 8.5 Open questions for human

1. **Synthetic TM for VAs / acks?** If a TFM has no `mapping_sources` (value assignment), it doesn't have a natural source table to bind to. Options: (a) require every project to have a "default" TM per target table for VAs, (b) allow `target_field_mappings.table_mapping_id` to remain NULL for VAs only (special-case constraint), (c) require VAs to be re-bound to one of the partition TMs at creation time.
2. **Filter SQL validation strategy.** Pure deterministic regex check + DML blocklist, or RUN-with-LIMIT-0 to verify the SQL parses against actual `data_rows`? The latter is slower but safer.
3. **AI partition detection cost cap.** Phase-0 adds one AI call per project. With Phase 2 caching enabled and a per-project budget, expected cost is <$0.50. Confirm acceptable for pilot scale.
4. **Pilot toggle.** Gate the entire partition feature behind a per-project flag (e.g. `projects.partitions_enabled`) for incremental rollout? Recommended yes; trivial to add now and remove later.
5. **Backfill failure recovery.** What if pre-flight finds duplicate `(project, source, target)` TMs in production? Fix-up script merges; need to know now whether to pre-build it.

---

## §9 — Closing summary

- **Data model**: one column on `target_field_mappings` (`table_mapping_id`), one column on `table_mappings` (`filter_sql`), one UNIQUE swap. ~150 LOC migration plus ~50 LOC backfill.
- **Apply path**: zero RPC changes for pilot if we accept per-partition independent apply. With UNION-ALL RPC (deferred): one FROM-clause multiplex at [`076:371`](../dev/settle-platform/supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql#L371).
- **AI pipeline**: one new Phase-0 helper between [`mapping-engine.ts:1813-1814`](../dev/settle-platform/lib/ai/mapping-engine.ts#L1813-L1814). Deferrable for pilot.
- **UI**: ~200-400 LOC for partition tabs + manual partition form; five known surgery sites in `MappingContent.tsx`.
- **Risk to single-partition flow**: low if backfill is deterministic and N=1 short-circuits hold.
- **Recommended cut**: 3 PRs — Ω.1 (data model), Ω.2 (apply path), Ω.3 (UI + AI). Pilot ships with Ω.1 + Ω.2 + manual partition UI from Ω.3; AI detection can ship after.

---

## Decisions Locked (2026-05-26)

The five open questions in §8.5 are resolved as follows for the pilot scope. Each decision is keyed to its corresponding §8.5 question.

### Q1 — VA handling (§8.5 #1)

**Decision:** Option A — N independent VA TFMs per partition.

- AI proposes the same VA value across all partitions.
- UI provides a "Copy from partition X" bulk action so users don't manually re-enter identical values.
- `va_group_id` linking (a deduplication mechanism that would let one logical VA point to N TFM rows) is **deferred to PR Ω.4**.

### Q2 — Filter SQL validation (§8.5 #2)

**Decision:** Regex + DML blocklist + literal-stripping for pilot.

- Reuses the validation logic from PR ζ.2 (RPC-side DML guard with literal-stripping).
- Adds a RUN-LIMIT-0 "Test filter" affordance in PR Ω.3 — runs the filter against actual `data_rows` with `LIMIT 0` so the customer can confirm SQL parses and column references resolve, without fetching rows.

### Q3 — AI partition detection cost (§8.5 #3)

**Decision:** Deferred. Pilot uses manual partition creation.

- The Phase-0 partition-detection helper described in §3.7 / §5.3 / §8.3 is **not in MVP scope**.
- Customers (and the Rootstock loader script for the pilot) create partitions via UI.
- Cost-cap question revisited once we have pilot signal on whether AI detection is needed at all.

### Q4 — Feature flag (§8.5 #4)

**Decision:** UI-only feature flag `projects.partitions_enabled`.

- Schema migration (PR Ω.1) and apply-path changes (PR Ω.2) ship **unflagged** — they're backward-compatible by design (N=1 short-circuits hold; NULL `filter_sql` is byte-identical to heritage).
- UI partition tabs and the partition-creation form (PR Ω.3) ship **behind the flag**.
- Rollout: enable per-project for the Rootstock pilot; expand based on stability signal.

### Q5 — Backfill duplicates (§8.5 #5)

**Decision:** Pre-flight query first; fix-up script only if needed.

- Run the duplicate-detection query from §7.1 in production *before* applying the PR Ω.1 migration.
- If zero rows: no fix-up script needed; proceed with the backfill as designed.
- If non-zero rows: write a targeted fix-up script that merges duplicate TMs, apply via Dashboard, then re-run the pre-flight to confirm clean before the main migration.

---

### Follow-ups and stale references

- **Migration numbering (2026-05-26):** §8.1 and §8.2 cite `106_target_field_mappings_table_mapping_id_and_filter_sql.sql` and `107_dq_apply_field_transform_joined_filter_sql.sql`. Both slots are now taken (105 reserved for PR ζ.2; 106 used by `106_schema_documents_by_project_policies` shipped 2026-05-25). PR Ω.1 / Ω.2 migrations will use the next free numbers when implemented — treat the numbers in §8 as placeholders.
- **Items deferred to PR Ω.4 (post-pilot):** `va_group_id` linking (Q1), AI partition detection (Q3), unified single-RPC UNION ALL apply (§6.7).
