# Mapping Redesign — Feature Specification

**Status**: Design locked, pending implementation
**Owner**: Kaan Dincer
**Created**: 2026-04-21
**Last updated**: 2026-04-21

## Purpose

This document specifies the redesign of Settle's mapping system to support cross-table field mappings, eliminate the `is_contributing` abstraction, and align the UI with a field-first data model.

The existing mapping system supports one source table mapping to one target table, with many-to-one and one-to-many relationships expressed within a single table pair. This limits real-world data migrations where a target field's source data lives across multiple source tables joined by foreign keys. This redesign removes that limitation and refines the surrounding UX.

## Scope

**In scope**:
- Data model redesign eliminating the primary/contributing hierarchy
- Cross-table field mapping support (a target field can pull from fields across multiple source tables via explicit joins)
- UI redesign of the main mapping page
- Drawer redesign (three tabs, persistent action footer)
- Filter and search behavior changes
- LLM prompt updates for cross-table mapping suggestions
- Data migration of existing `field_mappings` rows

**Out of scope (deferred)**:
- Multi-hop joins (source A joined to B joined to C). Cap at one cross-table join per mapping in v1.
- Table-level relationship editing UI (ingestion flow continues to capture FK metadata; this feature consumes it but does not add authoring UI for relationships)
- Broader architecture documentation (tracked separately)

## Core principles

1. **Field-first data model.** A mapping is a specification for how one target field gets populated. Target tables are navigation groupings, not structural containers.

2. **Target is stable, source is configured.** Target fields come from an ingested target schema and are read-only. Source fields are what the user composes and edits.

3. **No hierarchy among contributing sources.** When multiple source fields contribute to one target field, all contributors have equal weight. No primary, no secondary.

4. **Progressive disclosure.** Simple mappings (1:1) render simply. Complex mappings (multi-source, cross-table) render with just enough inline context to understand, with detail accessible on demand.

5. **Defense in depth for the user's work.** AI proposes mappings; the UI gives the user clear paths to inspect, edit, approve, or reject. Automation never substitutes for human approval.

6. **Zero regression on existing behavior.** Users with existing projects continue to see their data. Migration transforms the data structure without losing information or breaking approval state.

## Data model

### New tables

#### `target_field_mappings`

The primary entity. One row per mapping. A mapping has exactly one target field and zero or more contributing source fields.

```sql
CREATE TABLE target_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  
  -- Overall mapping metadata
  confidence NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review', 'approved', 'rejected')),
  ai_reasoning TEXT,
  
  -- Acknowledged-no-source state (replaces field_acknowledgments)
  is_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledgment_reason TEXT,
  
  -- Combination strategy
  combination_type TEXT
    CHECK (combination_type IN ('single', 'concat_space', 'concat_comma', 'custom_sql')),
  combination_sql TEXT,  -- present only when combination_type = 'custom_sql'
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- One mapping per target field per project
  UNIQUE (project_id, target_field_id)
);

CREATE INDEX idx_target_field_mappings_project_id 
  ON target_field_mappings(project_id);
CREATE INDEX idx_target_field_mappings_target_field_id 
  ON target_field_mappings(target_field_id);
CREATE INDEX idx_target_field_mappings_status 
  ON target_field_mappings(status);
```

#### `mapping_sources`

Child of `target_field_mappings`. Represents one source field contributing to a target field mapping. Multiple rows per parent when the mapping is many-to-one.

```sql
CREATE TABLE mapping_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_field_mapping_id UUID NOT NULL 
    REFERENCES target_field_mappings(id) ON DELETE CASCADE,
  
  -- NULLable: preserves current value-assignment semantics.
  -- A value assignment is a target_field_mapping with zero mapping_sources
  -- and combination_type='custom_sql', combination_sql='CURRENT_TIMESTAMP'
  -- or similar. Normal mappings have one or more mapping_sources rows.
  source_field_id UUID 
    REFERENCES fields(id) ON DELETE CASCADE,
  source_table_id UUID 
    REFERENCES tables(id) ON DELETE CASCADE,
  
  -- Per-source metadata
  confidence NUMERIC(5,2),
  ai_reasoning TEXT,
  similar_fields_considered JSONB,
  type_compatibility TEXT,
  
  -- Join specification (NULL when source is from the dominant table)
  join_spec JSONB,
  
  -- Ordinal for predictable concatenation order (0 = dominant source)
  ordinal INTEGER NOT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE (target_field_mapping_id, source_field_id)
);

CREATE INDEX idx_mapping_sources_target_field_mapping_id 
  ON mapping_sources(target_field_mapping_id);
CREATE INDEX idx_mapping_sources_source_field_id 
  ON mapping_sources(source_field_id) 
  WHERE source_field_id IS NOT NULL;
CREATE INDEX idx_mapping_sources_source_table_id 
  ON mapping_sources(source_table_id)
  WHERE source_table_id IS NOT NULL;
```

**Key changes**:
- `source_field_id` and `source_table_id` are nullable (both required together or both null)
- Partial indexes exclude null rows for efficiency (there should be no null-source rows in the new model, but the column allows it defensively)
- Unique constraint still applies — a target mapping can't have the same source field contributing twice

#### `source_field_acknowledgments`

```sql
-- Source-side acknowledgments: user declares a source field will not be migrated.
-- Used by recomputeTableMappingStatus to determine if a table_mapping can
-- auto-approve despite having uncovered source fields.
CREATE TABLE source_field_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  notes TEXT,
  acknowledged_by UUID REFERENCES auth.users(id),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE (project_id, source_field_id)
);

CREATE INDEX idx_source_field_acknowledgments_project_id 
  ON source_field_acknowledgments(project_id);
CREATE INDEX idx_source_field_acknowledgments_source_field_id 
  ON source_field_acknowledgments(source_field_id);
```

### Mapping shape reference

The new model supports four distinct mapping shapes, distinguishable by their `target_field_mappings` row state and `mapping_sources` count:

| Shape | `is_acknowledged` | `combination_type` | `combination_sql` | `mapping_sources` count |
|---|---|---|---|---|
| Simple 1:1 | false | `'single'` | null | 1 |
| Multi-source same-table | false | `'concat_*'` or `'custom_sql'` | null or expression | 2+ (all same `source_table_id`) |
| Cross-table | false | `'concat_*'` or `'custom_sql'` | null or expression | 2+ (mixed `source_table_ids`) |
| Value assignment | false | `'custom_sql'` | computed expression | 0 |
| Target acknowledgment | true | null | null | 0 |

**Value assignment example**: `target.migrated_at` populated from `CURRENT_TIMESTAMP` has `combination_type='custom_sql'`, `combination_sql='CURRENT_TIMESTAMP'`, and zero `mapping_sources` rows.

**Target acknowledgment example**: `target.legacy_field_x` acknowledged as unmapped has `is_acknowledged=true`, `combination_type=null`, `combination_sql=null`, and zero `mapping_sources` rows.

The two are semantically distinct: the value assignment produces a computed value per row; the acknowledgment produces no output at all.

### Tables that remain

- `tables` — unchanged
- `fields` — unchanged (FK inference from migration 063 still applies)
- `table_mappings` — **preserved for navigation metadata but no longer structural**. Continues to exist as optional grouping data. Field mappings no longer reference it.
- `transformations` — updated to reference `target_field_mapping_id` instead of `field_mapping_id`
- `field_profiles`, `data_rows`, `staged_data_rows`, `schema_documents`, `outputs` — unchanged

### Tables that are removed or superseded

- `field_mappings` — replaced by `target_field_mappings` + `mapping_sources`. All 778 production rows migrated.
- `field_acknowledgments` — split into:
  - Target-side rows (49 in production) → migrated to `target_field_mappings` with `is_acknowledged=true`
  - Source-side rows (11 in production) → migrated to new `source_field_acknowledgments` table

The `field_acknowledgments` table is dropped after migration.

### Data migration

Executed as a single PostgreSQL transaction via migration `073_mapping_redesign.sql`. All DDL is transactional; migration either succeeds fully or rolls back automatically.

#### Preconditions — data integrity gates

Before any DDL, the migration runs assertions that fail the transaction if violated:

```sql
-- Assertion 1: No target fields with multiple non-rejected primary mappings
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT target_field_id, table_mapping_id, 
             COUNT(*) FILTER (WHERE NOT is_contributing) AS primaries
      FROM public.field_mappings
      WHERE status <> 'rejected'
      GROUP BY target_field_id, table_mapping_id
    ) x WHERE primaries > 1
  ) THEN
    RAISE EXCEPTION 'Data integrity: target fields with >1 non-rejected primary mapping detected';
  END IF;
END $$;

-- Assertion 2: No orphan contributing rows (contributing with no primary)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_mappings fm
    WHERE fm.is_contributing = true
      AND NOT EXISTS (
        SELECT 1 FROM public.field_mappings fm2
        WHERE fm2.target_field_id = fm.target_field_id
          AND fm2.table_mapping_id = fm.table_mapping_id
          AND fm2.is_contributing = false
      )
  ) THEN
    RAISE EXCEPTION 'Data integrity: contributing rows without primary detected';
  END IF;
END $$;
```

Production data as of 2026-04-21 passes both assertions (verified via pre-migration query).

#### Step 1: Create new tables

Create `target_field_mappings`, `mapping_sources`, and `source_field_acknowledgments` with indexes and RLS policies (see RLS section below).

#### Step 2: Add nullable `target_field_mapping_id` to `transformations`

```sql
ALTER TABLE public.transformations
  ADD COLUMN target_field_mapping_id UUID 
    REFERENCES public.target_field_mappings(id) ON DELETE CASCADE;
CREATE INDEX idx_transformations_target_field_mapping_id 
  ON public.transformations(target_field_mapping_id);
```

Kept alongside `field_mapping_id` temporarily to enable backfill.

#### Step 3: Migrate `field_mappings`

**Step 3a**: Create `target_field_mappings` rows, one per unique `(project_id, target_field_id)`:

```sql
-- Use a mapping table to preserve FK linkage for Step 4
CREATE TEMP TABLE fm_to_tfm_map (
  old_field_mapping_id UUID NOT NULL,
  new_target_field_mapping_id UUID NOT NULL,
  PRIMARY KEY (old_field_mapping_id)
);

WITH primary_fms AS (
  SELECT DISTINCT ON (tm.project_id, fm.target_field_id)
    fm.id AS first_fm_id,
    tm.project_id,
    fm.target_field_id,
    fm.confidence,
    fm.status,
    fm.ai_reasoning,
    fm.source_field_id,
    fm.created_at
  FROM public.field_mappings fm
  JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
  WHERE fm.is_contributing = false
  ORDER BY tm.project_id, fm.target_field_id, fm.created_at
),
inserted AS (
  INSERT INTO public.target_field_mappings (
    project_id, target_field_id, confidence, status, ai_reasoning,
    is_acknowledged, combination_type, combination_sql,
    created_at, updated_at
  )
  SELECT
    pf.project_id, pf.target_field_id, pf.confidence, pf.status, pf.ai_reasoning,
    FALSE,
    -- Combination type derivation:
    -- - source_field_id IS NULL → 'custom_sql' (value assignment)
    -- - has contributing siblings → 'concat_space' (best guess; user can edit)
    -- - otherwise → 'single'
    CASE
      WHEN pf.source_field_id IS NULL THEN 'custom_sql'
      WHEN EXISTS (
        SELECT 1 FROM public.field_mappings sib
        WHERE sib.target_field_id = pf.target_field_id
          AND sib.table_mapping_id IN (
            SELECT tm2.id FROM public.table_mappings tm2 
            WHERE tm2.project_id = pf.project_id
          )
          AND sib.is_contributing = true
      ) THEN 'concat_space'
      ELSE 'single'
    END,
    -- combination_sql: for value assignments, derive from transformations
    CASE
      WHEN pf.source_field_id IS NULL THEN (
        SELECT t.generated_sql 
        FROM public.transformations t 
        WHERE t.field_mapping_id = pf.first_fm_id 
        LIMIT 1
      )
      ELSE NULL
    END,
    pf.created_at, pf.created_at
  FROM primary_fms pf
  RETURNING id, target_field_id, project_id
)
INSERT INTO fm_to_tfm_map (old_field_mapping_id, new_target_field_mapping_id)
SELECT pf.first_fm_id, i.id
FROM primary_fms pf
JOIN inserted i 
  ON i.project_id = pf.project_id 
  AND i.target_field_id = pf.target_field_id;
```

**Step 3b**: Create `mapping_sources` rows for all non-value-assignment `field_mappings`:

```sql
WITH ranked_fms AS (
  SELECT
    fm.id AS fm_id,
    fm.source_field_id,
    f.table_id AS source_table_id,
    fm.confidence, fm.ai_reasoning, 
    fm.similar_fields_considered, fm.type_compatibility,
    tfm.id AS tfm_id,
    fm.is_contributing,
    ROW_NUMBER() OVER (
      PARTITION BY tfm.id
      ORDER BY fm.is_contributing ASC, fm.created_at ASC
    ) - 1 AS ordinal
  FROM public.field_mappings fm
  JOIN public.table_mappings tm ON tm.id = fm.table_mapping_id
  JOIN public.target_field_mappings tfm
    ON tfm.project_id = tm.project_id 
    AND tfm.target_field_id = fm.target_field_id
  JOIN public.fields f ON f.id = fm.source_field_id
  WHERE fm.source_field_id IS NOT NULL  -- exclude value assignments
)
INSERT INTO public.mapping_sources (
  target_field_mapping_id, source_field_id, source_table_id,
  confidence, ai_reasoning, similar_fields_considered, 
  type_compatibility, join_spec, ordinal
)
SELECT
  tfm_id, source_field_id, source_table_id,
  confidence, ai_reasoning, similar_fields_considered,
  type_compatibility, NULL, ordinal
FROM ranked_fms;
```

**Step 3c**: Migrate target-side acknowledgments (49 rows):

```sql
INSERT INTO public.target_field_mappings (
  project_id, target_field_id, is_acknowledged, 
  acknowledgment_reason, status, combination_type,
  created_at, updated_at
)
SELECT
  fa.project_id, fa.field_id, TRUE,
  fa.reason || COALESCE(' — ' || fa.notes, ''),
  'approved',
  NULL,
  fa.acknowledged_at, fa.acknowledged_at
FROM public.field_acknowledgments fa
WHERE fa.side = 'target'
ON CONFLICT (project_id, target_field_id) DO NOTHING;
```

The `ON CONFLICT DO NOTHING` handles the edge case where a target field has both a `field_mapping` and an acknowledgment — the mapping takes precedence.

**Step 3d**: Migrate source-side acknowledgments (11 rows):

```sql
INSERT INTO public.source_field_acknowledgments (
  project_id, source_field_id, reason, notes, 
  acknowledged_by, acknowledged_at
)
SELECT
  project_id, field_id, reason, notes,
  acknowledged_by, acknowledged_at
FROM public.field_acknowledgments
WHERE side = 'source';
```

#### Step 4: Backfill `transformations.target_field_mapping_id`

```sql
UPDATE public.transformations t
SET target_field_mapping_id = m.new_target_field_mapping_id
FROM fm_to_tfm_map m
WHERE t.field_mapping_id = m.old_field_mapping_id;
```

#### Step 5: Verification gates

Expected counts from production data (2026-04-21):

```sql
DO $$
DECLARE
  expected_tfm_non_ack   INT := 765;  -- 756 simple + 9 many-to-one primaries
  expected_tfm_ack       INT := 49;
  expected_sources       INT := 776;  -- 778 total fm - 2 value assignments
  expected_source_acks   INT := 11;
  actual_tfm_non_ack     INT;
  actual_tfm_ack         INT;
  actual_sources         INT;
  actual_source_acks     INT;
BEGIN
  SELECT COUNT(*) INTO actual_tfm_non_ack 
    FROM target_field_mappings WHERE NOT is_acknowledged;
  SELECT COUNT(*) INTO actual_tfm_ack 
    FROM target_field_mappings WHERE is_acknowledged;
  SELECT COUNT(*) INTO actual_sources 
    FROM mapping_sources;
  SELECT COUNT(*) INTO actual_source_acks 
    FROM source_field_acknowledgments;
  
  IF actual_tfm_non_ack <> expected_tfm_non_ack THEN
    RAISE EXCEPTION 'target_field_mappings (non-ack) count: expected %, got %',
      expected_tfm_non_ack, actual_tfm_non_ack;
  END IF;
  IF actual_tfm_ack <> expected_tfm_ack THEN
    RAISE EXCEPTION 'target_field_mappings (ack) count: expected %, got %',
      expected_tfm_ack, actual_tfm_ack;
  END IF;
  IF actual_sources <> expected_sources THEN
    RAISE EXCEPTION 'mapping_sources count: expected %, got %',
      expected_sources, actual_sources;
  END IF;
  IF actual_source_acks <> expected_source_acks THEN
    RAISE EXCEPTION 'source_field_acknowledgments count: expected %, got %',
      expected_source_acks, actual_source_acks;
  END IF;
END $$;
```

Hardcoded expected counts must be updated immediately before migration deploy based on a fresh count query (in case new mappings are created between spec-writing and deployment).

#### Step 6: Drop old tables

```sql
-- Drop FK column from transformations (must happen before field_mappings is dropped)
ALTER TABLE public.transformations 
  DROP CONSTRAINT transformations_field_mapping_id_fkey;
ALTER TABLE public.transformations 
  DROP COLUMN field_mapping_id;
ALTER TABLE public.transformations 
  ALTER COLUMN target_field_mapping_id SET NOT NULL;

DROP TABLE public.field_mappings CASCADE;
DROP TABLE public.field_acknowledgments CASCADE;

DROP TABLE fm_to_tfm_map;  -- cleanup temp table
```

### Row-Level Security Policies

Policies use the org-based model from migration 050. All new tables enforce the same `user_can_access_project` / `user_has_project_role` gates as the tables they replace.

```sql
-- target_field_mappings: project_id on row, direct check
ALTER TABLE public.target_field_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_target_field_mappings" ON public.target_field_mappings 
  FOR SELECT USING (public.user_can_access_project(project_id));
CREATE POLICY "editors_insert_target_field_mappings" ON public.target_field_mappings 
  FOR INSERT WITH CHECK (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_update_target_field_mappings" ON public.target_field_mappings 
  FOR UPDATE USING (public.user_has_project_role(project_id, 'editor'));
CREATE POLICY "editors_delete_target_field_mappings" ON public.target_field_mappings 
  FOR DELETE USING (public.user_has_project_role(project_id, 'editor'));

-- mapping_sources: join through target_field_mappings to get project_id
ALTER TABLE public.mapping_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_mapping_sources" ON public.mapping_sources 
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_can_access_project(tfm.project_id)
  ));
CREATE POLICY "editors_insert_mapping_sources" ON public.mapping_sources 
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_has_project_role(tfm.project_id, 'editor')
  ));
-- UPDATE and DELETE analogous

-- source_field_acknowledgments: project_id direct
ALTER TABLE public.source_field_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_source_field_acknowledgments" ON public.source_field_acknowledgments 
  FOR SELECT USING (public.user_can_access_project(project_id));
-- INSERT, UPDATE, DELETE with editor check, analogous

-- transformations: drop old FM-based policies, create TFM-based
DROP POLICY IF EXISTS "org_access_transformations" ON public.transformations;
DROP POLICY IF EXISTS "editors_insert_transformations" ON public.transformations;
DROP POLICY IF EXISTS "editors_update_transformations" ON public.transformations;
DROP POLICY IF EXISTS "editors_delete_transformations" ON public.transformations;

CREATE POLICY "org_access_transformations" ON public.transformations 
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.target_field_mappings tfm
    WHERE tfm.id = target_field_mapping_id
      AND public.user_can_access_project(tfm.project_id)
  ));
-- INSERT, UPDATE, DELETE analogous with editor check
```

Security parity maintained — every new policy enforces the same org-based access rules as the policies it replaces.

### Server action impact

The migration affects approximately 20 code files. Grouped by subsystem:

**Primary mapping layer** (heavy rewrite, ~2000 lines):

- `lib/actions/mappings.ts` — entire file rewrites against new model. 29 exports, 64 call sites to `field_mappings`.
- `lib/actions/transformations.ts` — 16 exports, 26 call sites. FK column rename + adapt to read from `mapping_sources`.
- `lib/actions/fk-cascade.ts` — 5 exports, 9 call sites. Cleaner queries (one FK hop fewer).

**SQL generation** (moderate rewrite, ~300 lines):

- `lib/actions/outputs.ts` — 7 call sites. Must handle joined SELECT for cross-table mappings.
- `lib/actions/execution-package.ts` — 2 call sites. Schema fetches.
- `lib/utils/transform-helpers.ts` — extend `wrapFieldRefsInJsonb` with optional alias map.

**Acknowledgments** (~100 lines):

- `lib/actions/field-acknowledgments.ts` — entire file replaced. Target-side methods move to `target_field_mappings` operations; source-side methods operate on new `source_field_acknowledgments` table.

**Quality subsystem** (light updates, ~120 lines):

- `lib/quality/detection-engine.ts` — 2 sites
- `lib/quality/readiness-score.ts` — 2 sites
- `lib/quality/resolved-by-transform.ts` — 1 site
- `lib/quality/fix-engine.ts` — 1 site
- `lib/quality/fix-sql-validator.ts` — 1 site
- `lib/quality/fix-target.ts` — 1 site

**Other server actions** (light updates, ~180 lines):

- `lib/actions/migration-intelligence.ts` — 3 sites
- `lib/actions/migration-runbook.ts` — 3 sites
- `lib/actions/ai-quality-detection.ts` — 1 site
- `lib/actions/staged-row-flags.ts` — 2 sites
- `lib/actions/staging.ts` — 3 sites
- `lib/actions/validation-rules.ts` — 3 sites
- `lib/actions/projects.ts` — 3 sites

**Client components** (updates in Phase 3):

- `app/app/projects/[projectId]/mapping/MappingContent.tsx` — ~3900 lines, 4 type references to `field_mappings`. Full redesign in Phase 3.
- `app/app/projects/[projectId]/mapping/page.tsx` — server component, imports `getMappings`
- `app/app/projects/[projectId]/transform/TransformContent.tsx` — uses `fieldMappingId` identifier throughout; parameter rename required
- `app/app/projects/[projectId]/transform/page.tsx` — server component
- `components/app/FKCascadePrompt.tsx` — `FKDependent` type consumer only

**Migration SQL safety blocklists** (defensive updates in 9 migration files):

- `006_data_quality.sql`, `011_transform_test_rpc.sql`, `014_transform_apply.sql`, `019_transform_full_test_rpc.sql`, `026_execute_data_fix_allow_cte.sql`, `035_transform_preview_multi_field.sql`, `040_transform_test_multi_field.sql`, `043_null_safe_apply_and_window_guard.sql`, `061_fix_distinct_preview_groupby.sql` — user-SQL blocklists should be extended to include `target_field_mappings|mapping_sources` for defense-in-depth (low severity; word-boundary regex currently excludes `target_field_mappings` from matching `field_mappings`).

**Total estimated LOC**: ~2700 lines of changes across ~23 files. Revised effort estimate: 5-8 focused days for Phase 2 (see Implementation phases).

## Information architecture

### Page structure

The mapping page maintains its existing URL (`/app/projects/[projectId]/mapping`) and position in the app navigation.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Mapping   Heritage Core to Nymbus Core Migration                          ℹ   │
│                                                                                │
│  Heritage Core → Nymbus Core   Total 116 · Approved 116 · Needs Review 0      │
│                                                                                │
│  Target: [All ▼]  Source: [All ▼]  Status: [All ▼]  [🔍 Search...]  8 tables  │
│                                                                                │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  [Expandable target table groups, each containing field mapping rows]          │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

Preserved from current UI:
- Page title, project subtitle
- Overall progress counters (Total, Approved, Needs Review)
- Info icon for help
- Migration arrow header (`Heritage Core → Nymbus Core`)
- Table count indicator (`8 tables`)

Changed:
- Filter row: replace `Tables` with `Target`, add `Source`, remove `Type`. `Status` remains.
- Group headers: display target table name only, not the `source → target` pairing
- Row layout: new source column rendering (badges, annotations)

### Filter behavior

Three independent filter dropdowns:

**Target** (replaces `Tables`): narrows view to rows whose target field belongs to a specific target table. Options: `All` + each target table name.

**Source**: narrows view to rows whose mapping involves a specific source table (as dominant source or as a contributing cross-table source). Options: `All` + each source table name.

**Status**: narrows view to rows with a specific approval status. Options: `All`, `Needs Review`, `Approved`, `Rejected`.

Filters combine as AND. Filter state is URL-synchronized for shareable views.

### Search behavior

Single search input. Case-insensitive substring matching across:
- Source field names (exact field or qualified `Table.Field`)
- Target field names
- Source table names
- Target table names

Search applies on top of active filters. Empty search returns all rows matching filters.

Placeholder: `Search fields, tables, and mappings...`

When filters or search are active, target table groups with zero matching rows are hidden from the view. Groups with matching rows remain visible with a subtle count indicator showing how many rows match (e.g., `accounts · 3 of 19 fields match`).

## Row design

Each row represents one mapping — one target field and its configured source(s). The row's visual presentation adapts to mapping complexity.

### Rule 1: Single source field (1:1)

```
[TableBadge] FieldName                          Conf.    target_field_name
```

One line. No chevron. Clicking opens the drawer on the Details tab.

Example:
```
[ACCT_MASTER] ACCT_NO                           98%      account_id
```

### Rule 2: Multiple source fields, same table (same-table concat)

```
[TableBadge] Field1, Field2, Field3             Conf.    target_field_name    ▸
```

One line with chevron. Fields comma-separated. Clicking chevron expands in-place. Clicking row body opens drawer on Source tab.

Example:
```
[ACCT_MASTER] Addr1, Addr2, City                87%      mailing_address      ▸
```

### Rule 3: Multiple source fields, two tables (one cross-table join)

```
[TableBadge] Field1, Field2                     Conf.    target_field_name    ▸
```

One line with chevron. The table badge represents the table these fields come from (not the "dominant" source). Clicking chevron expands to show field-level detail including join annotation.

Example:
```
[CIF_MASTER] FirstName, LastName                82%      customer_full_name   ▸
```

Note: there is no join annotation on the collapsed row. The badge divergence from the target table's dominant source is sufficient visual signal that cross-table is happening.

### Rule 4: Multi-table complex (three or more source tables, or more than five source fields)

```
N fields across M tables                        Conf.    target_field_name    ▸
```

Summary line with chevron. Always expandable. Collapsed view shows count summary; expanded view shows full source detail.

Thresholds:
- Activate when source tables count is 3 or more
- OR when total source fields count is more than 5

Example:
```
4 fields across 3 tables                        78%      full_customer_profile  ▸
```

### Rule 5: Acknowledged no-source

```
—                                               —        target_field_name
  (acknowledged: reason_text)
```

Two lines. No chevron. Em-dash in source column and confidence column. Acknowledgment reason below in secondary text. Clicking opens drawer on Details tab (where the reason can be edited).

Example:
```
—                                               —        created_at
  (acknowledged: system default)
```

### Rule 6: Unmapped (new or rejected)

```
—                                               —        target_field_name
```

One line. Em-dash in source and confidence. No subtitle. Clicking opens drawer on Source tab (where the user can configure a source or acknowledge as intentional).

Example:
```
—                                               —        new_unmapped_field
```

## Source column rendering details

### Table badge

Visual: neutral-colored pill or rectangle containing the source table name. Consistent monochrome treatment across all tables (no color coding).

Text: full source table name as imported. Tables with long names may be abbreviated with an ellipsis in the collapsed view; the full name is available on hover and in the expanded view.

Example:
```
[ACCT_MASTER]    [CIF_MASTER]    [ADDR_MASTER]
```

### Field name(s)

Text: field name as defined in the source schema. Monospace preferred for field names to distinguish them from surrounding UI text.

Multi-field display: comma-separated, no trailing comma. Example: `Addr1, Addr2, City`.

When a row has 5+ fields from the same table, truncate the display with an ellipsis and a count: `Addr1, Addr2, City, State, ...+3`. The full list is available in the expanded view.

### Summary line for Rule 4

Text format: `N fields across M tables`. Count of unique source fields and unique source tables.

## Expanded view

When the user clicks a row's chevron, the row expands in place to show per-source detail. The expansion is contained within the row — no separate panel or modal.

### Structure

```
[TableBadge] Field1, Field2, Field3             Conf.    target_field_name    ▾
    ● [TableBadge] Field1               Conf.
    ● [TableBadge] Field2               Conf.  (join: ForeignKeyName)
    ● [TableBadge] Field3               Conf.
```

Each source field gets one line in the expanded view:
- Bullet marker
- Source table badge
- Source field name
- Confidence percentage
- Optional join annotation for cross-table sources

Join annotation format: `(join: ForeignKeyName)` where `ForeignKeyName` is the FK field in the dominant source table that references the joined table. For multiple sources sharing the same join, the annotation appears on each.

### Interaction

- Clicking the chevron again collapses the row
- Clicking anywhere else in the row opens the drawer on the Source tab
- Per-source lines in the expanded view are read-only (no per-source inline edit)
- Keyboard: arrow down/up navigates between expanded lines; Enter on a source line opens the drawer

### Expanded view for Rule 4 (multi-table complex)

```
4 fields across 3 tables                        78%      full_customer_profile  ▾
    ● [ACCT_MASTER] Name                98%
    ● [CIF_MASTER] FirstName            85%    (join: PrimaryContactID)
    ● [CIF_MASTER] LastName             80%    (join: PrimaryContactID)
    ● [ADDR_MASTER] City                72%    (join: PrimaryAddressID)
```

Same structure as Rule 2/3 expansion. The collapsed summary line is replaced with the summary phrase; the per-source lines appear identically.

### Expanded view does NOT include

- Combination SQL
- Example output
- AI reasoning (beyond the per-field confidence)
- Edit controls

All of those live in the drawer. The expanded view is a read-only inspection surface.

## Drawer design

The drawer opens to the right when the user interacts with a row. It contains three tabs (Details, Source, Transform) and a persistent action footer.

### Drawer header

```
┌──────────────────────────────────────────────────────────┐
│  Target field                                         ✕  │
│                                                          │
│  target_field_name                                       │
│  DATA_TYPE · in parent_table · required                  │
│                                                          │
│  Details  │  Source  │  Transform                        │
│                                                          │
│  [Tab content]                                           │
│                                                          │
│  ───────────────────────────────────────────────────     │
│                                                          │
│  [ ✓ Approve ]     [ ✗ Reject ]     [ 🗑 Remove ]        │
└──────────────────────────────────────────────────────────┘
```

The header shows target field only. No source expression in the header (that's in the Source tab). The header answers "which target field am I configuring?" and nothing else.

Metadata displayed:
- Target field name (prominent)
- Target type (e.g., `VARCHAR(200)`)
- Parent target table (e.g., `in accounts`)
- Required/nullable indicator (e.g., `required` or `nullable`)

### Drawer opens on which tab

Default opening behavior based on mapping state:
- Mapping status is `needs_review`: open on Source tab (user is configuring or reviewing)
- Mapping status is `approved`: open on Details tab (summary view)
- Mapping status is `rejected`: open on Details tab (summary view)
- Clicking an unmapped row (Rule 6): open on Source tab

Clicking the chevron does NOT open the drawer. Drawer opens only on row-body click.

### Tab: Details

Read-only tab. Shows mapping metadata.

```
Status                          ● Approved
Confidence                      ████████████░░░░  82%
AI Reasoning                    [expandable collapsible]
Type compatibility              VARCHAR(50) + VARCHAR(50) → VARCHAR(200)
                                Concatenation fits within target length
```

Content:
- **Status**: current approval state with indicator
- **Confidence**: visual bar plus numeric percentage (overall mapping confidence)
- **AI Reasoning**: collapsible block, expandable to show full reasoning text
- **Type compatibility**: text description of how source types combine to produce target type

No edit controls on this tab. All edits happen in Source or Transform tabs.

### Tab: Source

Editable tab. This is the authoring surface for the mapping.

```
Source fields

┌──────────────────────────────────────────────────┐
│ ● [TableBadge] FieldName              ✕         │
│   DATA_TYPE · N% confidence                     │
│   Example: "sample value"                       │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ ● [TableBadge] FieldName              ✕         │
│   DATA_TYPE · N% confidence                     │
│   Example: "sample value"                       │
│   From a different table — join below           │
└──────────────────────────────────────────────────┘

[+ Add source field]

─────────────────────────────────────────────────

Join (shown only when cross-table)

DominantTable.ForeignKeyField = JoinedTable.PrimaryKeyField
[ Edit join ]

─────────────────────────────────────────────────

Combination (shown only when 2+ sources)

○ Concatenate with space
● Concatenate with comma
○ Concatenate: custom order [reorder UI]
○ Custom SQL [SQL expression input]

─────────────────────────────────────────────────

Preview (row 1)

target_field_name = "example output"

─────────────────────────────────────────────────

Alternative: [ No source — acknowledge as intentional ]
```

Content sections (progressive disclosure):

**Source fields**: list of currently configured contributing sources. Each appears as a card with:
- Table badge and field name (prominent)
- Data type and confidence (secondary)
- Example value from sample data
- Remove control (`✕`)
- Optional annotation if cross-table ("From a different table — join below" on first; "Uses same join as above" on subsequent)

**Add source field**: button that opens a field picker. The picker is a searchable autocomplete across all source fields in the project (qualified by table). Selecting a field from a different table than existing sources triggers the join configuration to appear.

**Join**: appears only when the mapping has sources from 2+ tables. Shows the inferred join and allows editing. The join is inferred from FK metadata; the user can override (e.g., select a different FK if multiple exist between the two tables).

**Combination**: appears only when 2+ sources are configured. Radio buttons for common patterns (space-concat, comma-concat, custom-ordered concat) plus a custom SQL escape hatch.

**Preview**: always visible when source is configured. Shows what the computed target value would be for the first row of the primary source table. Updates live as the user changes source fields or combination.

**Alternative no-source**: bottom of the tab, visually separated. Clicking converts the mapping to an acknowledged state (clears source fields, sets `is_acknowledged = true`, prompts for reason).

### Tab: Transform

Primarily read-only. Shows the generated SQL expression and test results.

```
Generated SQL expression
┌──────────────────────────────────────────────────┐
│  FirstName || ', ' || LastName                   │
└──────────────────────────────────────────────────┘

Test results
Row 1:   "John, Smith"
Row 2:   "Jane, Doe"
Row 3:   "Michael, Johnson"

[ 🔄 Regenerate with AI ]    [ ✏️ Override manually ]
```

Content:
- **Generated SQL expression**: the SQL string that will be applied to source rows to produce the target value. Read-only unless "Override manually" is clicked.
- **Test results**: sample output from running the SQL against source data.
- **Regenerate with AI**: triggers AI to regenerate the SQL given the current source configuration.
- **Override manually**: unlocks the SQL input, decoupling it from the Source tab's configuration. When overridden, changes to Source tab do not auto-update the SQL.

### Action footer

Persistent across all tabs. Contains three actions:

- **Approve** (primary): sets mapping status to `approved`. Cascades to all `mapping_sources` rows.
- **Reject**: sets mapping status to `rejected`.
- **Remove**: deletes the mapping entirely. Target field becomes unmapped. Confirmation prompt before action.

Button states:
- If mapping is already approved, "Approve" shows as checked with label "Approved"
- If mapping is rejected, "Reject" shows as active
- Buttons remain enabled so the user can change status at any time

### Drawer close behavior

- `✕` in header: closes drawer immediately
- Click outside drawer on main page: closes drawer
- Escape key: closes drawer
- Approve/Reject: drawer may stay open or close (UX decision: stay open to allow user to continue reviewing; close only on explicit `✕`)

Unsaved edits on the Source tab trigger a confirmation prompt if the user tries to close without saving.

## Edit model

### Main page

- **Source column**: clicking a row body opens the drawer on the Source tab. No inline editing on the main page.
- **Target field column**: read-only on main page. Clicking the target area does not open an edit flow (it opens the same drawer). Target field values cannot be edited via the mapping UI — they come from the ingested target schema.
- **Confidence column**: read-only display.
- **Chevron (when present)**: expands/collapses the row in place. Does not open drawer.

### Drawer

- **Details tab**: entirely read-only.
- **Source tab**: editable. Source fields added/removed, join edited, combination chosen, acknowledgment toggled.
- **Transform tab**: SQL is read-only by default (auto-generated from Source tab). Can be manually overridden, which decouples it from Source tab.

### Implications for existing UX

Current UI allows changing the target field of a mapping (which target the source maps to). In the new model, that operation is not supported — target fields are fixed. The equivalent is: remove the old mapping (target becomes unmapped), then create a new mapping targeting the different field.

This is a deliberate shift. It honors the target-first mental model and eliminates the current "demote-primary / promote-contributing" complexity in the server actions.

## LLM integration

### Prompt changes

The existing mapping generation prompt (`MAPPING_GENERATION_SYSTEM_PROMPT` in `lib/actions/mappings.ts`) instructs the model to emit mappings scoped within one source table. For cross-table, the prompt must:

1. Receive full source schema context including FK relationships between source tables
2. Be explicitly allowed to emit cross-table mappings with join specifications
3. Be instructed to prefer direct single-table mappings when they work; use cross-table only when necessary to populate the target field correctly

New prompt structure (pseudo):

```
You are mapping source schema → target schema.

Source schema:
  [all source tables with fields, types, FK graph]

Target schema:
  [all target tables with fields, types, constraints]

For each target field, propose a mapping:
  - If a direct source field is a good match, propose it
  - If multiple source fields need to combine (concat, etc.), list them
  - If the needed data lives in a different source table than the dominant
    one, specify the join using the source FK graph
  - If no reasonable source exists, propose acknowledgment

Output format (JSON):
{
  "mappings": [
    {
      "target_field": "accounts.full_customer_profile",
      "sources": [
        { "table": "CustomerMaster", "field": "Name" },
        { "table": "Contact", "field": "FirstName",
          "join": { "via_field": "CustomerMaster.PrimaryContactID",
                    "to_field": "Contact.ContactID" } },
        ...
      ],
      "combination": "concat_space",
      "confidence": 82,
      "reasoning": "..."
    },
    ...
  ]
}
```

### Context window management

The existing per-source-table batching strategy changes:

- For cross-table awareness, the model needs FK metadata across ALL source tables in one prompt
- Fields are still batched by source table for detailed profiling, but the cross-table context is included in every batch
- Output continues to be parsed and resolved to IDs post-hoc

Batch strategy:
- Per call: send full source schema (all tables, field names, types, FK graph) + one source table's detailed profiles + full target schema
- Per call output: mappings that have this source table as dominant source (may include cross-table mappings to other source tables)
- Cross-table mappings where two different source tables are both "dominant" candidates (rare but possible) are handled by deduplication post-parse

### Join inference

The AI proposes joins based on the FK graph stored in `fields.fk_reference`. When the target requires data from table B but the mapping's dominant source is table A, the AI picks the FK that links A to B. The user can override in the Source tab drawer.

If no FK exists between two tables, the AI does not propose a cross-table mapping between them. The user would have to either: manually annotate an FK on the `fields` table first, or compose the mapping via a custom SQL override.

## Edge cases

### No target schema ingested

If the project has source data but no target schema, the mapping page shows an empty state prompting the user to ingest a target schema. No mappings can be created until both sides exist.

### Target schema has more fields than the UI can display

For very large target schemas (200+ fields), the target table groups remain, but within a group fields are paginated or virtualized. Initial render is limited to the first N per group (e.g., 50) with "Load more" affordance.

### Circular FK relationships in source schema

The FK graph can contain cycles (e.g., employees.manager_id → employees.id). The join UI shows the cycle but limits depth to one hop. Multi-hop joins are out of scope for v1.

### Large combination SQL

When the Transform tab SQL exceeds a reasonable length (e.g., 2000 chars), the display uses a collapsible code block. The SQL remains fully functional; only the display collapses.

### User edits Source tab but closes drawer without saving

A confirmation prompt appears when attempting to close. Options: "Save and close", "Discard and close", "Cancel".

### Concurrent edits to the same mapping

If two users edit the same mapping simultaneously (rare but possible in team projects), the second save surfaces a conflict warning. Current behavior likely does not handle this; new behavior should follow whatever pattern the rest of the app uses for concurrency (investigate during implementation).

### Empty state — no mappings at all

For a freshly ingested project with no AI-generated mappings yet, the page shows the target schema with all rows as "unmapped" (Rule 6). A prominent "Generate mappings" CTA kicks off the AI mapping generation.

## States and transitions

### Mapping status lifecycle

```
              ┌──────────────┐
              │ needs_review │
              └──────┬───────┘
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
     ┌─────────┐ ┌────────┐ ┌────────┐
     │approved │ │rejected│ │removed │
     └────┬────┘ └────┬───┘ └────────┘
          │           │
          └───┬───────┘
              │
              ▼
         (editable)
```

- New mappings start as `needs_review`
- User can transition to `approved` or `rejected` from any state (including back from approved to needs_review)
- `removed` deletes the mapping entirely (target becomes unmapped, row shows Rule 6)
- `is_acknowledged = true` is a separate orthogonal flag — acknowledgments are a form of approval (the user confirms no source is correct)

### Cross-table mapping lifecycle

Same as single-source, with additional validation:
- On approve: verify the join_spec references valid FK fields
- On AI regenerate: respect any user-locked joins (if user edited, don't overwrite)

## Implementation phases

| Phase | Scope | Effort | Dependencies | Risk |
|---|---|---|---|---|
| 0 | Founder decisions (all resolved 2026-04-21) | Complete | — | — |
| 1 | Data model migration: new tables, RLS, data migration, new RPCs (`dq_create_target_field_mapping`, `dq_replace_mapping_sources`, `dq_acknowledge_target`, `dq_apply_field_transform_joined`) | 2 days | Phase 0 | HIGH — post-commit rollback requires PITR |
| 2 | Server actions rewrite + test harness setup: ~23 files, ~2700 LOC. Ships with Phase 1 atomically. | 5 days | Phase 1 | MEDIUM — comprehensive rewrite |
| 2a | Back-compat shim in `MappingContent.tsx` | 0.5 days | Phase 2 | LOW |
| 3 | UI: filter row + row layout (Rules 1-6) + expand-in-place | 2 days | Phase 2a | LOW |
| 3b | UI: drawer redesign (3 tabs, persistent footer) | 2 days | Phase 3 | LOW |
| 4a | LLM prompt update + A/B validation + new output parsing | 1.5 days | Phase 3b | MEDIUM — AI quality risk |
| 4b | Cross-table authoring in Source tab | 1.5 days | Phase 4a | MEDIUM — new user-facing capability |

**Total**: ~14-15 focused engineering days plus deployment overhead.

## Deployment strategy

The migration executes during a scheduled maintenance window to eliminate in-flight edit risk.

### Pre-deployment (T-24 hours)

- Email all users on affected organizations notifying of scheduled 30-minute maintenance window
- Banner added to `/app` routes showing maintenance countdown
- Re-run data integrity assertion queries against production; abort if results have drifted

### Pre-migration (T-5 minutes)

- Feature flag `mapping_writes_disabled` set to `true`
- All mapping-related server actions check the flag and return a maintenance-mode error response
- `/mapping` and `/transform` pages display maintenance banner

### Migration execution (T=0)

- Run migration `073_mapping_redesign.sql` via Supabase SQL editor
- Integrity assertions run first — abort if they fail
- All DDL executes in a single transaction — automatic rollback on any step failure
- Step 5 verification gates raise EXCEPTION if row counts diverge from expected

### Post-migration (T+5 minutes)

- Deploy new code containing rewritten server actions
- Flip `mapping_writes_disabled` feature flag to `false`
- Monitor Sentry/logs for errors for first 2 hours

### Post-migration (T+24 hours)

- Daily sanity queries: `SELECT COUNT(*) FROM target_field_mappings`, `FROM mapping_sources`, `FROM source_field_acknowledgments`
- Compare against expected post-migration counts
- Verify canary project (Heritage Core) functions correctly

### Rollback procedure

**In-transaction failure**: automatic, no action needed.

**Post-commit data issue** (discovered after deploy): Supabase point-in-time recovery (PITR) is the only rollback mechanism. Coordinates with Supabase support. Scheduled maintenance window window should include PITR turnaround buffer.

### Canary approach

First migration targets Kaan's internal "Heritage Core → Nymbus Core" project only. The migration SQL accepts an optional `p_project_id` parameter; when provided, data migration steps scope with `WHERE project_id = p_project_id`. After 72 hours of clean operation on the canary project, run the full migration for remaining projects.

## Test harness

A minimal Vitest harness ships as part of Phase 2. Testing is non-optional for this feature given the scope of changes and the zero-regression bar.

### Scope

**RPC smoke tests** (~5 tests):

- `dq_create_target_field_mapping` — creates mapping with single source, verifies row insertion
- `dq_replace_mapping_sources` — updates sources, verifies DELETE+INSERT atomicity
- `dq_acknowledge_target` — creates acknowledged mapping, verifies state
- Permission checks — non-editor cannot invoke these RPCs

**Server action integration tests** (~8 tests):

- `approveTargetFieldMapping` — approves, verifies status change, verifies no source-row mutation
- `editTargetFieldMapping` with new sources — verifies old sources removed, new sources added, transform reset
- `removeTargetFieldMapping` — verifies target becomes unmapped
- `acknowledgeTargetField` — verifies acknowledgment state + source clearing
- `generateMappings` — verifies new-format LLM output correctly creates `target_field_mappings` + `mapping_sources`
- `findFKDependents` — verifies cross-table dependents found
- `cascadeTransformToFKs` — verifies SQL copied to dependents without `join_spec` pollution
- Value assignment round-trip — creates value assignment, reads it back, verifies shape

### Setup

- Vitest + `@supabase/supabase-js` configured as dev dependencies
- Test database: separate Supabase project (not production, not local dev)
- Test fixture: one seeded project with diverse mapping shapes (1:1, many-to-one, value assignment, acknowledgment)
- Tests clean up after themselves (`DELETE` test-project data in `afterEach`)

### Integration into CI/CD

Tests run on every PR via GitHub Actions (to be configured as part of Phase 2). No PR merges without passing tests once harness lands.

**Effort**: ~2 days (1 setup + 1 initial tests). Ongoing: every new mapping feature adds tests.

## LLM transition mitigations

The new output format is a breaking change to Claude's mapping-generation contract. To avoid quality regression:

### Mitigation 1: Conservative cross-table instructions

The new system prompt explicitly states:

> Propose cross-table joins ONLY when the needed target field data cannot be populated from the dominant source table. Strongly prefer single-table mappings when possible. Cross-table joins add complexity to the migration and should be a last resort.

Biases the model toward existing same-table behavior; cross-table is opt-in.

### Mitigation 2: A/B validation before ship

Before the LLM prompt change ships, run both prompts (old format + new format) on the Heritage Core project schema. Compare:

- Mapping count match rate (same target fields proposed)
- Confidence score correlation
- Specifically for cross-table: do new-prompt proposals look correct?

If match rate is below 90% on non-cross-table cases, investigate prompt drift before shipping. This is a 1-hour validation, runs in Phase 4a.

### Mitigation 3: Elevated UI treatment for cross-table mappings

The UI flags AI-proposed cross-table mappings with lower confidence thresholds than single-table:

- Single-table mapping with confidence ≥80%: standard "needs review" state
- Cross-table mapping regardless of confidence: enhanced review indicator suggesting join verification

Gives users explicit opportunity to catch AI over-reach on cross-table cases.

### Mitigation 4: Manual authoring escape hatch from day one

The Source tab supports manual cross-table authoring independent of AI. If the AI performs poorly on a specific cross-table pattern, users have an always-available fallback.

## Success criteria

**Functional**:
- Existing projects' mappings continue to display correctly after migration
- Approval states are preserved across migration
- AI can propose cross-table mappings for Epicor → Rootstock–style schemas
- User can manually create cross-table mappings via the drawer Source tab
- Generated SQL correctly handles joins for cross-table mappings
- Migration package SQL output correctly produces target data from source data with joins

**Non-functional**:
- No regression in mapping approval performance (p95 < 500ms)
- Main page renders 200+ rows without noticeable lag
- Drawer opens within 100ms of row click
- AI mapping generation completes within existing time budget (no regression)

**UX**:
- Users can distinguish simple vs complex mappings at a glance
- Users can approve a simple 1:1 mapping in under 3 seconds from page load
- Users can configure a cross-table mapping in under 60 seconds (including AI join inference)
- Filter and search respond within 100ms

## Design decisions reference

This spec is the result of 23 locked design decisions (numbers 45-67 in the project's decision log). Key decisions:

- **D45**: Target table only in group header; source tables indicated per row
- **D46**: Source rendering uses `[TableBadge] field-names` with `⊕` annotations for complex cases
- **D47**: Drawer has 3 tabs (Details, Source, Transform); Actions merged into persistent footer
- **D48**: Source tab uses progressive disclosure
- **D49**: Target read-only everywhere; source editable on main page (via drawer) and Source tab
- **D53**: Three filter dropdowns (Target, Source, Status) + unified search
- **D54**: Monochrome badges, no color coding
- **D55**: One row per target field; source column compresses contributors
- **D57**: Main page confidence = target-level; per-source confidences in drawer
- **D58**: Remove Type filter
- **D62**: Hybrid A+C — rows adapt presentation to complexity
- **D63**: Chevron expands in-place; row body opens drawer
- **D65**: Drawer header shows target only
- **D66**: Path A — full data model refactor eliminating `is_contributing`
- **D67**: No join annotation on collapsed rows; badge divergence is sufficient signal
- **D68**: Expanded rows show per-source + confidence + join annotation only

Full decision history maintained separately in project conversation context.

## Open questions for implementation

These surfaced during design and need resolution during the Cursor investigation phase:

1. **Existing approval data**: how many projects in production have approved mappings that the migration will transform? (Informs migration testing approach.)

2. **Concurrent edit handling**: does the existing app have a pattern for concurrent edits to shared resources, or is this new territory?

3. **Large schema performance**: does the current page render 200+ field mappings without performance issues? Should we add virtualization?

4. **Test coverage**: confirmed no test infrastructure exists. Should we add minimal test harness as part of this feature, or defer?

5. **FK inference quality**: how reliable is the current FK inference pipeline in practice? Cross-table mapping quality depends on it.

6. **LLM prompt size**: do full source schemas fit within the per-call token budget with the existing batching strategy?

These are investigation targets for the next phase.

## Non-goals

Explicit out-of-scope items for v1:

- Multi-hop joins (A → B → C)
- Transposition/pivot operations
- Aggregations across source rows (GROUP BY semantics)
- Conditional source selection (if X then source A else source B)
- Automatic relationship inference beyond existing FK pipeline
- Per-row source field metadata on the main page (lives in drawer)

These are candidate v2 features but not part of this redesign.