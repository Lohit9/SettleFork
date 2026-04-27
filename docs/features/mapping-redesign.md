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
  
  -- Overall mapping confidence.
  -- For mapped targets (has mapping_sources): derived as 
  --   min(mapping_sources.confidence) at insert/update time
  -- For value assignments (no mapping_sources): stored directly 
  --   as AI-produced confidence for the custom SQL
  -- For acknowledged targets: NULL
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
  
  -- Per-source confidence: how certain the AI is that this source field 
  -- correctly contributes to the target, considering any join relationship.
  -- LLM produces per-source confidences; target-level confidence on 
  -- target_field_mappings is derived as min() of all source confidences.
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

### Confidence semantics

Confidence is tracked at two levels with distinct roles:

**Per-source confidence** (`mapping_sources.confidence`): how confident the AI is that a specific source field correctly contributes to the target. Considers the field's semantic match, type compatibility, and any required join relationship. Produced by the AI per source in the LLM output.

**Target-level confidence** (`target_field_mappings.confidence`): the overall confidence in the mapping. Computed deterministically:

- **Mapped targets**: `MIN(mapping_sources.confidence)` across all contributing sources. Captures the weakest link — if any source or join is uncertain, the mapping is uncertain.
- **Value assignments**: stored directly from the LLM's assessment of the custom SQL expression.
- **Acknowledged targets**: NULL.

**Recomputation rule**: whenever `mapping_sources` rows are inserted, updated, or deleted for a given `target_field_mapping_id`, the parent `target_field_mappings.confidence` recomputes via trigger or in the server action that performs the write. Cleanest implementation is a trigger:

```sql
CREATE FUNCTION recompute_target_field_mapping_confidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE target_field_mappings tfm
  SET confidence = (
    SELECT MIN(confidence) 
    FROM mapping_sources 
    WHERE target_field_mapping_id = tfm.id
  )
  WHERE tfm.id = COALESCE(NEW.target_field_mapping_id, OLD.target_field_mapping_id)
    AND NOT tfm.is_acknowledged
    AND tfm.combination_type <> 'custom_sql';  -- preserve value-assignment direct value
  RETURN NULL;
END $$;

CREATE TRIGGER mapping_sources_confidence_recompute
AFTER INSERT OR UPDATE OR DELETE ON mapping_sources
FOR EACH ROW EXECUTE FUNCTION recompute_target_field_mapping_confidence();
```

**UI display rules**:

- Main page row confidence column: `target_field_mappings.confidence` (single number per row)
- Expanded row per-source lines: `mapping_sources.confidence` (one per contributing source)
- Drawer Details tab: `target_field_mappings.confidence` prominently displayed
- Drawer Source tab per-source cards: `mapping_sources.confidence` on each source

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

## Source schema sidebar

Persistent left-edge browser for the project's source schema. Shipped in two
gaps: 11a (shell + drawer overlay refactor + persistence) and 11b (content +
interactions). Lives in
`app/app/projects/[projectId]/mapping/redesign/components/SourceSchemaSidebar.tsx`.

### Layout & states

- **Collapsed (28 px)** — vertical "Source fields" rail label + total count,
  top-anchored. Click anywhere on the rail to expand. This is the default for
  first-time users (founder decision, Gap 11a).
- **Expanded (200 px)** — header with title + total count + close chevron,
  search input, filter pills (`All` / `Mapped` / `Unmapped`), and a scrollable
  fields list grouped by source table.

The sidebar **always overlays alongside the main view**; it is not modal.
Above 1024 px the sidebar coexists with the drawer. At/below 1024 px the
sidebar auto-collapses while the drawer is open (ephemeral override —
not persisted), then restores to the user's persisted state when the
drawer closes or the viewport widens.

### Persistence

`localStorage` keys:

- `mapping-sidebar-state` — `'collapsed' | 'expanded'`. Default `'collapsed'`.
- `mapping-sidebar-filter` — `'all' | 'mapped' | 'unmapped'`. Default
  `'unmapped'` (most actionable view when expanded). Persisted even while the
  sidebar is collapsed.

### Field rendering

Server emits `MappingsForRedesignResult.sourceFields:
SourceFieldWithState[]` in canonical order (`sourceTable.name ASC,
ordinalPosition ASC, name ASC`). The sidebar groups by `sourceTable.id`
preserving server order — Gap 11b renders groups always-expanded; collapsible
groups are deferred to Gap 11c.

Each field row shows:

- **Status dot** — green for `mapped`, slate for `unmapped`. No third
  amber/partial state (founder decision 1, Gap 11b).
- **Field name** — truncated single line, mono.
- **Hover/focus tooltip** — anchored to the row, reveals the field's
  `dataType` and sample values (formatted via `formatSampleValues`,
  the same helper the drawer uses).

`isAcknowledged` is delivered on the contract (forward-compatible with Gap
11c) but Gap 11b does NOT visually differentiate acknowledged fields — they
render identically to other unmapped fields under the Unmapped pill. Gap 11c
will design the dedicated treatment (strike-through vs muted opacity vs
separate sub-section) — see the inline TODO in `SourceSchemaSidebar.tsx`.

### Filter pills

`All` / `Mapped` / `Unmapped` with inline counts derived client-side via
`useMemo` over `sourceFields` (no extra contract surface). Active pill writes
through to `localStorage` so the user's preference survives across sessions.

`mappingStatus` semantics: `'mapped'` iff the source field appears in
`mapping_sources` for at least one TFM with `status !== 'rejected'`. Founder-
locked exclusion (Gap 11b decision 2) — rejected TFMs do not claim sources as
mapped. Post-Gap-9 rejects = deletes, so this matters only for the legacy
SimpleLegal rejected row in production; the exclusion is defensive against
that legacy row plus any future write path that retains rejected TFMs.

### Search

Search input above the filter pills. Substring match (case-insensitive,
trimmed) across `field.name` and `sourceTable.name`. Sample values are NOT
searched — they're a hover-only affordance, not a primary identifier.

Search input is debounced ~200 ms before filter application; the visible
input value is immediate. Empty/whitespace-only input is the pass-through
sentinel.

Empty states:

- No source schema ingested for the project at all → "No source schema
  ingested for this project." (sidebar still mounts so users can see the
  shell.)
- Filter + search yield zero matches → "No source fields match the current
  filter." inside the list area.

### Click-to-highlight (founder decision 4, Gap 11)

Clicking a field row highlights every main-view row that consumes that
source field. Highlight visual: 2 px blue left border (matches the existing
drawer-active `bg-slate-50` cue but distinguishable). Single-select — clicking
another field replaces the highlight; clicking outside the sidebar, pressing
Esc, or completing a drawer Approve/Reject all clear it.

The highlight does NOT:

- Open the drawer.
- Narrow the main view's filters.
- Auto-scroll the first match into view.

The sibling click-outside listener for highlight clearing lives at the
`MappingContent` level, separate from the drawer's existing click-outside
listener (separation of concerns — each tested in isolation).

`contributingTfmIds` is derived client-side via `useMemo` over `data.rows`
into a `Map<sourceFieldId, Set<rowId>>` (founder decision 6, Gap 11b) — no
new server-computed map.

Stale-highlight guard: when a drawer Approve or Reject action completes
(`handleDrawerActionComplete`), the highlight is cleared. Approve case is
mild over-clearing; Reject case is necessary because the highlighted TFM is
deleted on the server.

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

### Purpose — scanning, not deep review

The expanded view is explicitly a **scanning** surface. It exists so the user can verify at a glance which source fields contribute to a multi-source row, their per-source confidence, and any cross-table joins — nothing more. Deep per-source review (sample values, AI reasoning text, per-source edit controls, approve/reject actions) is the drawer's job; see §Drawer design and Gaps 7-10 for that work.

This division is deliberate. Inlining sample values and reasoning on the expanded view was tried on 2026-04-24 (Gap 6 attempt) and reverted after the founder smoke test: the added density overwhelmed the mapping page's scanning use case. Data-layer plumbing for those fields (`MappingSourceRef.sampleValues`, `MappingSourceRef.aiReasoning`) survived on the wire because the drawer will consume them; the frontend rendering was confined to the drawer as originally intended.

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

- **Sample values from the source field** — lives in the drawer Source tab card (Gaps 7-10). `MappingSourceRef.sampleValues` carries up to 10 values on the wire for drawer consumption; the expanded view never renders them.
- **AI reasoning text** (both per-source and row-level) — lives in the drawer. `MappingSourceRef.aiReasoning` (per-source) and `MappedRow.aiReasoning` (row-level) both flow through to the drawer; the expanded view never renders them.
- **Combination SQL** — lives in the drawer Source tab / Transform tab.
- **Edit controls** (approve, reject, remove, per-source add/remove) — live in the drawer footer.
- **Example output** — lives in the drawer Transform tab preview.

Explicitly: if a future gap is tempted to add any of the above to the expanded view "just this once", stop and re-read this section. The scanning-vs-review split is the governing principle of the mapping page; violating it produced a measurable UX regression on 2026-04-24 and must not be re-litigated without a founder-approved re-scoping.

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
```

```json
{
  "mappings": [
    {
      "target_field": "full_customer_profile",
      "target_table": "accounts",
      "sources": [
        {
          "source_field": "Name",
          "source_table": "CustomerMaster",
          "confidence": 95,
          "reasoning": "Direct name match to target's primary identifier component"
        },
        {
          "source_field": "FirstName",
          "source_table": "Contact",
          "confidence": 88,
          "reasoning": "Contact.FirstName contributes to full customer name via join",
          "join": {
            "via_source_table": "CustomerMaster",
            "via_fk_field":     "PrimaryContactID",
            "to_fk_field":      "ContactID"
          }
        }
      ],
      "combination_type": "concat_space",
      "combination_sql": null,
      "reasoning": "..."
    },
    {
      "target_field": "migrated_at",
      "target_table": "accounts",
      "sources": [],
      "combination_type": "custom_sql",
      "combination_sql": "CURRENT_TIMESTAMP",
      "confidence": 95,
      "reasoning": "Target requires a migration timestamp; CURRENT_TIMESTAMP is the canonical value"
    },
    {
      "target_field": "legacy_notes",
      "target_table": "accounts",
      "sources": [],
      "is_acknowledged": true,
      "acknowledgment_reason": "No equivalent in source; intentionally unmapped",
      "reasoning": "..."
    }
  ]
}
```

**Notes on format**:

- **Mapped targets**: `confidence` on each `sources[i]`, no top-level `confidence`
- **Value assignments**: top-level `confidence` (no sources)
- **Acknowledgments**: no `confidence` (null in DB)
- Target-level confidence for mapped targets is computed server-side as `min(sources[*].confidence)`

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
| 0 | Founder decisions (complete 2026-04-21) | Complete | — | — |
| 1a | Feature flag infrastructure + test harness setup | 2 days | Phase 0 | LOW |
| 1b | Data model migration (new tables, RLS, data migration with verification, confidence trigger) + new RPCs | 2 days | Phase 1a | HIGH — post-commit rollback requires PITR |
| 2 | Server actions rewrite: `mappings.ts`, `transformations.ts`, `fk-cascade.ts`, `outputs.ts`, `execution-package.ts`, `lib/quality/*`, `field-acknowledgments.ts`. Includes LLM prompt update for new format, but cross-table remains flag-gated. Ships atomically with Phase 1b. | 5 days | Phase 1b | MEDIUM |
| 2a | Back-compat shim. Ships with Phase 2. | 0.5 days | Phase 2 | LOW |
| 3a | UI: filter row redesign (remove Type, add Source Table, rename Tables → Target Tables) + URL param updates | 1 day | Phase 2a live | LOW |
| 3b+3c | UI: main page row redesign + drawer redesign (shipped together to avoid inconsistent intermediate state). Includes monochrome `TableBadge` primitive, new `FieldMappingRow`, persistent drawer footer, three tabs. Ships behind feature flag. | 4 days | Phase 3a | MEDIUM |
| 3-A11y | Minimum accessibility baseline: `aria-label` on icon buttons, `aria-labelledby` on drawer, sr-only text on status indicators, `focus-visible` rings. Shipped as part of Phase 3b+3c. | 0.5 days | Phase 3b+3c | LOW |
| 4-LLM-Validation | A/B validation of new LLM prompt against Heritage Core. Threshold: 90%+ match rate on non-cross-table mappings. | 1 day | Phase 3b+3c | MEDIUM — quality gate |
| 4a | LLM prompt update for cross-table awareness + parser for new output format. Feature flag enables cross-table generation on canary project. | 1.5 days | Phase 4-LLM-Validation | MEDIUM |
| 4b | Cross-table authoring in Source tab: cross-table field picker, join editor, live preview with joins | 1.5 days | Phase 4a | MEDIUM |
| 5-Cleanup | Remove shim, delete `UnmappedView`, `UnmappedTargetIndicator`, legacy localStorage keys. Drop feature flag column once all projects migrated. | 0.5 days | Phase 4b stable | LOW |

> **Gap 12 no-op (2026-04-24).** The Phase 3 roadmap originally scoped a
> "Gap 12 — delete unused legacy stubs" cleanup between Gap 6 and Gap 13.
> Investigation on 2026-04-24 found no standalone legacy components
> eligible for deletion: `UnmappedView` and `UnmappedTargetIndicator`
> are **inline functions inside `MappingContent.tsx`** (lines 2488 and
> 2482), not standalone files. Because `MappingContent.tsx` is reserved
> for Gap 13 (full shim deletion, folded into Phase 5-Cleanup above),
> the inline stubs will be removed naturally when the legacy file is
> retired. Gap 12 was therefore closed as a no-op — no code changed,
> no tests changed. Rule 6 (unmapped row) rendering in the redesign is
> covered by `tests/components/field-mapping-row.test.tsx`
> (`describe('FieldMappingRow — Rule 6 (unmapped)')`, plus chevron-
> absence and a11y assertions). See commit message for the full audit.

**Total**: ~19 focused engineering days including cleanup and A11y baseline.

## Phase 3 closure — 2026-04-25

Phase 3 (mapping page redesign UI) is implementation-complete. The redesign is feature-flag gated behind `projects.use_mapping_redesign`; only Heritage Core (project `6622ddf1-47bd-4e48-ac2a-5b109a25bc13`) currently runs on it. Production users on every other project see no change — the legacy `app/app/projects/[projectId]/mapping/MappingContent.tsx` continues to render via the back-compat shim until Phase 5-Cleanup retires it.

### Shipped gaps

| Gap | Scope | Status |
|---|---|---|
| 1 | Feature flag dispatch | ✅ shipped |
| 3 | Filter row + counter pills (Total / Approved / Needs Review / [Rejected] / [Unmapped]) | ✅ shipped (Unmapped chip added in Gap 13 closeout) |
| 4a | Read-path data contract design (`getMappingsForRedesign`, `MappingsForRedesignResult`) | ✅ shipped |
| 4b | Read-path implementation | ✅ shipped |
| 4c | Render target-table groups | ✅ shipped |
| 5a | Row Rules 1, 5, 6 + dark-mode regression hotfix | ✅ shipped |
| 5b | Row Rules 2, 3, 4 with chevron expansion | ✅ shipped |
| 6 (partial) | Frontend rendering of expanded sample values + AI reasoning | ⚠️ **reverted on smoke test 2026-04-24**; data layer (`MappingSourceRef.sampleValues`, `MappingSourceRef.aiReasoning`) retained on the contract because the drawer consumes it (Gap 8b) |
| 7 | Drawer shell with row-click trigger + URL `?drawer=` sync | ✅ shipped |
| 8a | Drawer body for acknowledged, unmapped, value_assignment rows | ✅ shipped |
| 8b | Drawer body for mapped rows with per-source roster | ✅ shipped |
| 9 | Drawer footer Approve / Reject actions | ✅ shipped |
| 10 (reduced) | Drawer focus restore polish (URL deep-link + post-Reject detached node) | ✅ shipped (closeout 2026-04-25) |
| 11a | Source schema sidebar shell + drawer overlay refactor (drawer width 520→480, removed `xl:pr-[…]` reflow) | ✅ shipped |
| 11b | Sidebar content + filter / search / click-to-highlight interactions | ✅ shipped |
| 12 | Legacy stub deletion | ✅ closed as **no-op** (2026-04-24) — `UnmappedView` and `UnmappedTargetIndicator` are inline functions inside the legacy `MappingContent.tsx`, not standalone files; cannot be deleted independently of the parent file (which retires in Phase 5-Cleanup) |
| 13 (reduced) | Project-level unmapped target visibility — Unmapped counter chip on `CountersRow` | ✅ shipped (closeout 2026-04-25) |
| 15 | Transform URL param back-compat (`?fieldMappingId=` → `?targetFieldMappingId=`) | ✅ shipped |

### Closed as no-op (no code, no spec text)

- **Gap 14, 16, 17** — unscoped placeholder slots reserved during the Phase 3 prompt sequence to leave headroom for unknown work that never materialized. Zero spec text, zero code references, zero TODO claims. Closed without action; the slot numbers can be re-used by future polish work if convenient.

### Future polish (post-Phase-3, pre-Phase-4)

- **Gap 11c** — sidebar polish, deferred from Gap 11b at founder's call:
  1. **Acknowledged source field visual treatment** — `SourceFieldWithState.isAcknowledged` is plumbed through the contract since Gap 11b, but acknowledged fields render identically to other unmapped fields under the Unmapped pill. A future visual treatment (strike-through, muted opacity, separate sub-section, etc.) is pending design discussion. TODO marker lives in `app/app/projects/[projectId]/mapping/redesign/components/SourceSchemaSidebar.tsx`.
  2. **Collapsible source-table groups** — sidebar currently renders all source-table groups always-expanded. With Heritage's ~10 tables and 99 fields it's fine; pilot customers with 200-500 fields may benefit from per-group collapsibility (default-expanded, persisted in localStorage).
  3. **Per-value tooltip truncation** — sidebar hover tooltips reuse `formatSampleValues` from the drawer with no per-value cap. If real customer data surfaces unwieldy long values, fix in the shared `formatSampleValues` helper (drawer benefits too).

Gap 11c is not blocking; it's incremental polish that can ship as a single small gap when needed.

### Reduced-scope deferrals (documented decisions, not gaps)

The Phase 3 closeout investigation surfaced three smaller items that were deliberately *not* shipped:

- **Per-target-table "M of N mapped" header annotation** (Gap 13 candidate) — adds visual clutter to a header already showing `X of Y fields` when filtered. Phase 4 candidate if user feedback requests it.
- **Status filter dropdown "Unmapped" option** (Gap 13 candidate) — would conflate `MappingStatusFilter` (TFM status union) with `row.kind` (which is a separate axis). Belongs with the broader "remap unmapped fields" Phase 4 mutation work.
- **Drawer animation refinement, post-Approve focus on disabled button** (Gap 10 candidates) — animation is working as designed with reduced-motion already wired; post-Approve focus on a disabled button is cosmetic-only and self-resolves on the next user interaction.
- **Drawer mobile / <768px responsive** — explicit spec non-goal per "Platform scope" §line 1582 ("Mobile access is not a validated use case…").

### Next workstream — Phase 4 (mutation completeness)

The redesign UI today supports two mutations: drawer Approve and drawer Reject (Gap 9). Phase 4 fills in the rest of the write surface:

- **Manual mapping creation** from Rule 6 unmapped rows — the inline-add-field affordance the legacy UI calls "Map to →"
- **Edit existing mapping sources** — add, remove, or relocate `mapping_sources` on an existing TFM
- **Edit combination strategy** — change `combination_type` / `combination_sql` on a mapped TFM
- **Un-acknowledge** previously acknowledged target fields (today the redesign treats acknowledgment as terminal; Reject is disabled on acknowledged rows)
- **Bulk operations** — approve all (high confidence threshold), reject all, generate AI suggestions for a TM
- **AI Suggest per-row** in the redesign UI (currently only available via the legacy MappingContent's "Suggest mappings" affordance)

Phase 4 is gated behind the same `use_mapping_redesign` flag and ships incrementally — each mutation as its own gap, behind the same feature flag, smoke-tested on Heritage Core before flipping.

## Manual mapping creation (Phase 4a-2)

The first mutation surface added under Phase 4. Same-table only — cross-table support arrives in Phase 4a-3 (founder decisions on the 4a investigation, 2026-04-25).

### Affordance

A primary `[Create mapping]` button appears in the drawer footer whenever the open row is `kind: 'unmapped'` (Rule 6). Click → the drawer body morphs from the empty-state prose into an inline `CreateMappingForm`; the footer mode-switches to `[Cancel]` `[Save mapping]`.

### Form layout (top to bottom)

1. **Source field picker** — searchable group→field list reusing the canonical server order. Shows the same field metadata as the sidebar (name, type, mapping status indicator, sample values via hover tooltip). Multi-select; selected fields render as removable chips above the picker. Same-table constraint is enforced live: once a source is picked, the other source-table groups are hidden and a muted footer note reads "Cross-table mappings ship in Phase 4a-3" (founder decision §2-OQ-1).
2. **Combination strategy** — a radio group surfaces only when 2+ sources are selected. Three radios visible:
   - `concat_space` (default) — values joined by a single space.
   - `concat_dash` — values joined by `-`.
   - `concat_pipe` — values joined by `|`.
   - Plus a disabled `custom_sql` radio with a `title` attribute educating the user that custom SQL composition arrives later (founder decision §6-OQ-2).
   The example text inside each radio is dynamic — derived from the actual sample values of the selected sources. Falls back to a canned `"Smith John"` example when samples are empty (founder decision §6-OQ-1).
3. **Sample preview** — up to 3 sample rows showing what the combined value will look like across the selected sources. `computeSamplePreview` (in `lib/utils/mapping-preview.ts`) is the pure helper; it pads unequal sample arrays and degrades gracefully when every selected source has zero samples.

### Save flow

- `[Save mapping]` is disabled when no source is selected (founder decision §4-OQ-1).
- Saving routes through the redesign-only wrapper `createFieldMapping` (`lib/actions/mappings-for-redesign.ts`), which delegates to the legacy core mutation but adds:
  - Same-table guard (returns `VALIDATION` with `errorCode: 'CROSS_TABLE_NOT_YET_SUPPORTED'` for cross-table input)
  - `findOrCreateTableMapping` so the form does not need to pass `tableMappingId` (founder decision §3-OQ-2)
  - Permission + maintenance-mode gates inherited from the existing approve/reject wrappers
- On success, the page-level handler swaps `?drawer=unmapped::<targetFieldId>` to `?drawer=<newTfmId>` and calls `router.refresh()`. The drawer body re-mounts from `UnmappedBody` to `MappedBody` naturally on the row.kind flip (founder decision §9-OQ-2).
- A `pendingDrawerRowId` sentinel keeps the drawer rendered with the previous row content during the URL→refresh window so the user does not see a flicker (founder decision §9-OQ-1). Released as soon as the new TFM materializes in `data.rows`.

### Error handling

`CreateFieldMappingErrorCode` → user copy is mapped in `CreateMappingForm.tsx`. The `EXISTING_TFM` case (the target field was mapped while the user was editing) renders an inline `[Refresh]` affordance next to the error message; clicking it calls `router.refresh()` and dismisses the form (founder decision §3-OQ-1).

### Close behavior

Four close paths route through a `requestClose()` helper on the form's imperative handle (`useImperativeHandle`):

- `[Cancel]` button
- `✕` close button in the drawer header
- Esc key (drawer-level listener)
- Click outside the drawer

When the form is dirty (any source selected), `requestClose()` opens an inline discard confirmation dialog. `[Discard]` deactivates the form; `[Keep editing]` returns to the form intact. Esc on the dialog dismisses the dialog only — it does not bubble to the drawer's own close path (founder decision §1-OQ-1, enforced by an `[role="alertdialog"]` guard in the drawer's keydown / mousedown listeners).

The fifth path — switching to a different row by clicking another field on the page — is intentionally silent (founder decision §8-OQ-1). A toast informing the user "your draft was discarded" with `[Undo]` ships in Phase 4a-4 (see ["AI Suggest UI integration (Phase 4a-4)"](#ai-suggest-ui-integration-phase-4a-4)).

### Custom SQL transitions

The disabled `custom_sql` radio is a deliberate signal that custom-SQL composition is supported by the data model but not the create flow. Editing an existing TFM's combination strategy `from custom_sql` back to a concat will be allowed in a later gap; transitioning `to custom_sql` is blocked from the redesign drawer for the foreseeable future (founder decision on the Phase 4 investigation, 2026-04-25).

## Cross-table mapping creation (Phase 4a-3)

Phase 4a-3 lifts the same-table guard introduced in 4a-2. Users can now select source fields from multiple source tables in the same form; the wrapper runs an FK precheck against the dominant table's foreign keys and either auto-infers the join or asks the user to pick the FK column when the choice is ambiguous (founder decisions on the 4a-3 investigation, 2026-04-25).

### Picker behavior

- The same-table constraint is gone. All source-table groups remain visible at all times; the muted "Cross-table mappings ship in Phase 4a-3" footer note has been removed.
- Selected chips visually group by source table when 2+ tables are involved. The first-picked source table becomes the **dominant** group (no re-anchor on later picks — founder decision §3-OQ-1) and renders under a subtle small-caps `DOMINANT` header. Every other source table renders under a `JOINED` header in selection order. When all selected fields share one table, the layout collapses to the legacy flat chip strip.

### FK inference contract

`createFieldMapping` runs `inferFkCandidates` (extracted to `lib/utils/fk-inference.ts`) per joined table. Three branches:

1. **Single candidate** — wrapper auto-infers the join. `mapping_sources.join_spec` is persisted as `null` for the joined source; the read path re-derives the annotation on demand from the dominant table's `fk_reference` metadata.
2. **Zero candidates** — wrapper returns `errorCode: 'CROSS_TABLE_AMBIGUOUS'` with `candidateFkFields: []` and `ambiguousJoinedTableId` / `ambiguousJoinedTableName` / `dominantTableName` on the result. The form surfaces this as a zero-FK banner ("No FK from `<dominant>` to `<joined>` exists. Add one in the source schema first.") with no dropdown — no refresh affordance (founder decision §8-OQ-2).
3. **Multiple candidates** — wrapper returns `CROSS_TABLE_AMBIGUOUS` with the FK candidate list. The form renders a native `<select>` (founder decision §4-OQ-1) under the picker. After the user picks, the form re-saves with `joinAnnotations[<joinedTableId>] = <fkColumn>`; the wrapper validates the override is in the candidate list (defense-in-depth — founder decision §2-OQ-4) and persists `join_spec.from_fk_field = <fkColumn>` on the joined source.

Resolved disambiguation rows render as read-only with a `Change` link that re-opens the dropdown. Both shapes (resolved + active) coexist when there are several joined tables (founder decision §4-OQ-2). Removing a chip silently clears the matching `joinAnnotations` and `ambiguousCandidates` entries (founder decision §4-OQ-3); state never persists across form re-opens (founder decision §5-OQ-2).

### Apply RPC transparency stack — retired by Phase 4a-6 (2026-04-26)

> **Historical narrative.** 4a-3 (2026-04-25) shipped cross-table mapping **creation** with a three-layer transparency stack so users were never surprised when downstream apply was stubbed. 4a-6 (2026-04-26) wired the apply path end-to-end via migration 076 and retired the entire stack. The original disposition is preserved here for context; current behaviour is documented in **Phase 4a-6 — cross-table apply** below.
>
> Original three-layer stack (now removed):
> - **Action-layer guard (Part A)** — `applyTransform` short-circuited cross-table TFMs with `errorCode: 'CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED'`.
> - **Transform-tab disabled buttons (Part B)** — `Test Transform` / `Apply Transform` disabled when `selectedContext.field.isCrossTable`, tooltip pointing to a "future release".
> - **Drawer Sources badge (Part C)** — small muted "Transform: cross-table not yet applicable" badge on the drawer's `Sources` section header.
>
> Companion plumbing also retired in 4a-6: the `projectHasCrossTableMappings(projectId)` server helper, the `hasCrossTableMappings` prop threaded through `transform/page.tsx` → `TransformContent.tsx` → `transform/redesign/TransformContent.tsx`, the placeholder `transform-redesign-cross-table-note` line, and the `isCrossTableTfm` private helper in `lib/actions/transformations.ts`. Source-level invariants pinning the absence of this stack live in `tests/actions/transforms-cross-table-apply.test.ts` (X4 block) and `tests/components/transform-cross-table-enabled.test.ts`.

### Phase 5-Cleanup (deferred)

After Phase 4 stabilizes and the canary expands beyond Heritage Core to additional pilot projects (~30 days of stable use), Phase 5-Cleanup retires the legacy code path:

- Delete `app/app/projects/[projectId]/mapping/MappingContent.tsx` (which retires the inline `UnmappedView`, `UnmappedTargetIndicator`, `InlineAddFieldRow` placeholders by extension — see "Cleanup items" below)
- Delete `lib/compat/mapping-shim.ts` (no longer needed once UI reads new model directly)
- Drop `projects.use_mapping_redesign` column from the database
- Drop `projects.maintenance_mode` column once migration window is confirmed complete

## AI Suggest UI integration (Phase 4a-4)

Phase 4a-4 wires the existing `suggestMappingForTarget` server-action wrapper (Phase 4a-1) into the redesign drawer. It ships in two atomic commits — 4a-4a (toast primitive) and 4a-4b (AI Suggest UI integration).

### 4a-4a — Row-switch toast primitive

The toast primitive that surfaces "Draft discarded" with `[Undo]` when a user clicks another field row while a `CreateMappingForm` is dirty. The previously-silent fifth discard path (founder decision §8-OQ-1 of 4a-2) now has a non-blocking, undoable affordance.

- `ToastProvider` + `useToast` (`components/ui/Toast.tsx`) — single-instance, ARIA `role="status"`, 5-second auto-dismiss, single-action button slot for `[Undo]`. No new dependencies; no `dark:` modifiers.
- `MappingContent` snapshots the dirty form state (`CreateMappingFormSnapshot { targetFieldId, selectedIds, combinationType, joinAnnotations, ambiguousCandidates }`) the moment the row changes, fires the toast, and threads the snapshot back via the drawer's `restoreFormState` prop on Undo. Restoration replays the URL drawer change, auto-activates the form on mount, and re-hydrates source selection in one render.
- The toast is the *only* surface that introduces non-blocking UX in the drawer. The four prior discard paths (Cancel, X, Esc, click-outside) keep their blocking discard dialog.

### 4a-4b — AI Suggest UI integration

The redesign drawer surfaces `suggestMappingForTarget` through two entry points on a Rule 6 unmapped row:

1. **Footer auto-trigger** — `[Suggest with AI]` lives next to `[Create mapping]` on the inactive footer. Clicking it activates the form with `autoSuggest=true`, which fires `invokeSuggest` on first render. The footer collapses to a single `[Cancel suggestion]` button while the call is in flight.
2. **In-form pill** — once the form is active (either via `[Create mapping]` or after a successful auto-trigger), an inline `Suggest with AI` pill at the top of the form re-invokes the wrapper. The pill becomes a `Re-suggest` chip alongside a `ConfidencePill` and `Why?` toggle once a suggestion has loaded.

#### State machine

```
SuggestState =
  | { kind: 'idle' }
  | { kind: 'pending';  abortController: AbortController }
  | { kind: 'loaded';   suggestion: AISuggestion }
  | { kind: 'error';    code: SuggestErrorCode; message: string }
```

`SuggestErrorCode` is the union of `SuggestMappingErrorCode` (from the wrapper) plus a client-only `'NETWORK'` for thrown exceptions. Race resolution is "abort prior + fire new" (founder decision §1-OQ-1) — every `requestSuggest` call aborts any in-flight `AbortController` before transitioning to a fresh `pending`. The form's `cancelSuggest` imperative handle is what the drawer footer's `[Cancel suggestion]` button reaches.

#### Same-table-only limitation

The wrapper hard-strips cross-table tails to `AI_INVALID_RESPONSE` (`lib/actions/mappings-for-redesign.ts` lines 1473-1497). 4a-4b does not introduce cross-table AI: the LLM prompt explicitly steers same-table suggestions, and any cross-table tail surfaces as `AI_INVALID_RESPONSE` with the "Please pick sources manually" copy. Pre-fill therefore never threads `joinAnnotations` from the AI — that is the user's job in the cross-table flow (Phase 4a-3). Cross-table AI is a substantively harder LLM prompt problem and is deferred to a future phase.

#### Server action AbortSignal not threaded

`suggestMappingForTarget` does not accept a `signal` parameter, so `AbortController` is purely client-side discard. The server completes the LLM call regardless of whether the user clicked Cancel. This is intentional and aligned with founder decision §7-OQ-2 ("tokens are sunk cost") — adding signal threading is a non-breaking future change and tracked as deferred work in `docs/features/phase-4-plan.md`.

#### Provenance laundering prevention

`aiSuggested=true` is persisted only when at least one originally-suggested source survives in the final selected IDs:

```ts
const stillHasOriginal =
  originalSuggestedIds !== null &&
  originalSuggestedIds.some((id) => selectedIds.includes(id))

aiSuggested = stillHasOriginal
confidence  = stillHasOriginal ? suggestState.suggestion.confidence : undefined
aiReasoning = stillHasOriginal ? suggestState.suggestion.rationale  : undefined
```

`originalSuggestedIds: string[] | null` is form state captured by `applyLoadedSuggestion` (after the present-id filter) and overwritten on every re-suggest. The user can edit the chip set freely after a suggestion lands; provenance flips automatically based on whether *any* AI-picked source remains. Net effect:

- **User keeps any AI source** → `ai_suggested=true`, `confidence` and `ai_reasoning` persisted (the common case).
- **User removes ALL AI sources, picks unrelated ones** → `ai_suggested=false`, `confidence` and `ai_reasoning` dropped (laundering prevented — the audit trail correctly reflects that the final mapping is manual).

#### Replace-warning gate

When the user has manually edited a loaded suggestion (chip change, combination-type change, or joinAnnotation change tracked via `userEditedAfterSuggest`), the `Re-suggest` pill opens a `DiscardChangesDialog` with `variant="replace-ai"` instead of firing immediately. The dialog reuses the existing component and is parameterized via the new `variant: 'discard' | 'replace-ai'` prop (founder decision §3-OQ-2 — no extraction). On confirm the form proceeds with the suggestion replace; on `[Keep editing]` the form is left intact.

The replace-warning is suppressed when:
- The form is empty (no chips, no annotations, default combination type).
- The current loaded suggestion has not been edited since `applyLoadedSuggestion`.
- The state is `idle` or `error` (nothing to lose).

#### Confidence pill bands

`ConfidencePill` is the only consumer of the new threshold logic in `lib/utils/confidence-format.ts`:

- **High** (≥70) — green dot, `Confident (NN%)` label.
- **Possible** (40-69) — amber dot, `Possible match (NN%)` label.
- **Uncertain** (<40) — red dot, `Low confidence (NN%)` label.

The pre-existing `ConfidenceCell` / `RowConfidenceSection` / `SourceBullet` cells stay muted slate (no color band). Founder decision: colored bands are gated behind AI provenance only.

The lift to `lib/utils/confidence-format.ts` (`formatConfidencePercent`, `formatConfidenceLabel`, `classifyConfidence`) replaces three inline `formatConfidence` helpers in `FieldMappingRow.tsx`, `MappingDrawer.tsx`, and `ExpandedSourceList.tsx`. Output is byte-identical for all pre-existing call sites; `tests/utils/confidence-format.test.ts` pins parity. Output formatting in `lib/actions/_outputs-translators.ts` and `tests/outputs/confidence-formatting.test.ts` is intentionally not touched (export precision is a separate concern — founder decision §12-OQ-1).

#### Error surface

Errors share the existing `ErrorBanner` (founder decision §7-OQ-1, generalized to take `actionLabel` + `onAction` props). The `SUGGEST_ERROR_COPY` map drives the affordance per code:

| Error code | Affordance | Persistence |
|---|---|---|
| `RATE_LIMITED` | `Refresh` (full reload) | Persists until next selection change; pill stays disabled |
| `AI_INVALID_RESPONSE` | `Try again` (re-fires `invokeSuggest`) | Cleared on next selection change or save |
| `NOT_FOUND` / `PERMISSION_DENIED` / `MAINTENANCE_MODE` / `INTERNAL` | `Try again` | Cleared on next selection change or save |
| `NETWORK` (client-thrown) | `Try again` | Cleared on next selection change or save |
| `VALIDATION` | (no action) | Cleared on next selection change or save |

`RATE_LIMITED` is the only persistent affordance — `suggestRateLimited` state stays `true` until the user changes selection, at which point both the banner and the pill-disabled state release together.

During Phase 2a, a shim translates the new data model back into the old `RichFieldMapping` shape so the unchanged `MappingContent.tsx` and `TransformContent.tsx` continue to render. The shim is removed after Phase 3 ships.

### What the shim handles gracefully

- **Simple 1:1 mappings**: one `mapping_source` row → one `RichFieldMapping` row with `is_contributing=false`
- **Many-to-one within one source table**: N `mapping_sources` → N `RichFieldMapping` rows, one with `is_contributing=false`, others with `is_contributing=true`. Rendering identical to current UI.
- **Value assignments** (zero-source `custom_sql`): one `RichFieldMapping` row with `source_field_id=null`. Rendering identical to current UI.
- **Target-side acknowledgments**: preserved via `FieldAcknowledgmentRow` synthesis from `target_field_mappings.is_acknowledged=true` rows.
- **Source-side acknowledgments**: synthesized from `source_field_acknowledgments` table.
- **Approval state**: `target_field_mappings.status` copied to every generated `RichFieldMapping` row.

### What the shim cannot represent (blocked by feature flag)

**Cross-table mappings**: a target whose `mapping_sources` span multiple source tables cannot be faithfully rendered in the old UI's table-centric structure. The shim would have to either hide some sources (data loss visually) or emit phantom `table_mapping` groupings (visually broken).

Mitigation: cross-table mapping creation is gated behind `projects.use_mapping_redesign = true`. The shim only runs when the flag is false, and in that state cross-table mappings do not exist. The shim never encounters a case it cannot handle.

**Per-source confidence variation**: the old UI only displays one confidence per row. The shim exposes target-level confidence (min of sources) on every generated row. Users lose visibility into per-source confidence during Phase 2a, but the old UI never showed it anyway.

**Join annotations**: the old UI has no place to display join information. Acceptable because cross-table is flag-gated off.

### Shim implementation contract

Single adapter module: `lib/compat/mapping-shim.ts`. Exports functions that convert new-model query results into `RichFieldMapping` and `RichTableMapping` shapes:

```ts
export function shimTargetFieldMappingToRichFieldMappings(
  tfm: TargetFieldMappingRow,
  sources: MappingSourceRow[],
  transformation: TransformationRow | null,
  fields: Record<string, FieldRow>
): RichFieldMapping[]

export function shimToMappingsResult(
  targetFieldMappings: TargetFieldMappingRow[],
  mappingSources: MappingSourceRow[],
  sourceAcks: SourceFieldAcknowledgmentRow[],
  // ...other inputs
): MappingsResult
```

The shim is pure translation; no business logic. Unit-tested as part of Phase 2 test harness.

### Removal

Phase 3c completion removes the shim. `MappingContent.tsx` and `TransformContent.tsx` read the new model directly. `lib/compat/mapping-shim.ts` is deleted.

## Phase 4a complete — Mapping authoring loop (2026-04-26)

Phase 4a is implementation-complete. The redesign UI now supports the full mapping authoring loop end-to-end on Heritage Core: a user can create, AI-suggest, edit, save, approve, reject, and recover from accidental discards entirely within the new drawer + form surface, without falling back to the legacy `MappingContent.tsx`. Non-flag projects continue to render the legacy UI unchanged until Phase 5-Cleanup retires it.

### What shipped — sub-phase recap

| Sub-phase | Date | Scope | Anchor section |
|---|---|---|---|
| Pre-prep | 2026-04-25 | `ActionType` enum widening for new mapping log codes | n/a |
| 4a-1 | 2026-04-25 | `createFieldMapping` + `suggestMappingForTarget` server-action wrappers + tests | `phase-4-plan.md` §2 |
| 4a-2 | 2026-04-25 | `CreateMappingForm` shell + drawer integration (W1, manual same-table creation) | "Manual mapping creation (Phase 4a-2)" above |
| 4a-3 | 2026-04-25 | Cross-table picker + Apply-RPC three-layer transparency stack | "Cross-table mapping creation (Phase 4a-3)" above |
| 4a-4a | 2026-04-25 | `ToastProvider` + switch-row-while-dirty Undo affordance | "AI Suggest UI integration" §4a-4a above |
| 4a-4b | 2026-04-26 | AI Suggest UI integration (footer + in-form pill, ConfidencePill, replace-warning, laundering prevention, strict-mode-resistant consumption guard) | "AI Suggest UI integration" §4a-4b above |
| 4a-5 | 2026-04-26 | Closure docs + code cleanup pass (this section) | this section |

### Capabilities now available in the redesign UI

For Heritage users (the only flag-on project today):

- **Manual mapping creation, same-table** — pick one or more source fields from the same source table as the target's TM, optionally choose a combination strategy when 2+ sources are picked, save with audit-correct manual provenance.
- **Manual mapping creation, cross-table** — pick a source field from a *different* source table whose schema participates in an FK chain reaching the target's TM. The form auto-infers the join path and surfaces the Apply-RPC three-layer transparency stack (founder decision §10-OQ-1 of 4a-3).
- **AI Suggest** — invoke `suggestMappingForTarget` per row from two surfaces (Rule 6 footer auto-trigger or in-form pill), pre-fill the form with suggested sources + combination + confidence + rationale, review and optionally edit before save. ConfidencePill renders threshold-banded color coding (≥70 high, 40-69 possible, <40 uncertain), `Why?` toggle exposes rationale on demand.
- **Audit-correct provenance** — `aiSuggested=true` only persists when at least one originally-suggested source survives in the final selection. Removing every AI source and picking unrelated ones flips the mapping to manual provenance. Prevents laundering manual mappings under AI authorship.
- **Toast-with-Undo for accidental discards** — clicking another row while a `CreateMappingForm` is dirty silently discards the draft and surfaces a 5-second toast with `[Undo]`. Restoration replays the URL drawer change, auto-activates the form, and re-hydrates source selection in one render.
- **All four close paths handled coherently** — Cancel button, Esc, click-outside, and the X button all route through `formRef.current.requestClose()`, which pops the discard dialog when dirty and short-circuits when clean. The fifth path (row-switch-while-dirty) gets the toast-with-Undo affordance instead of a dialog (founder decision §8-OQ-1 of 4a-2).
- **Approve / Reject** — unchanged from Phase 3 Gap 9; continues to work on freshly-saved Phase 4a mappings without modification.

For non-Heritage projects: zero user-facing change. The flag is off; the legacy `MappingContent.tsx` continues to render via the back-compat shim.

### Known limitations carried forward

These are intentional Phase 4a deferrals, not bugs. Each is documented inline at its source and surfaced here for forward-look visibility.

1. **AI Suggest is same-table only.** The wrapper (`lib/actions/mappings-for-redesign.ts` lines 1473-1497) hard-strips cross-table tails to `AI_INVALID_RESPONSE`. The LLM prompt explicitly steers same-table suggestions; cross-table AI requires a substantively harder prompt design that proposes joined-source mappings reliably enough to be useful. Deferred to a future LLM-prompt phase. See "AI Suggest UI integration" §"Same-table-only limitation" above.
2. **AbortController for Suggest is client-side only.** `suggestMappingForTarget` does not accept a `signal` parameter; canceling a pending suggestion discards the response client-side but the server-side LLM call completes. Tokens are sunk cost (founder decision §7-OQ-2). Adding signal threading is a non-breaking future change. See "AI Suggest UI integration" §"Server action AbortSignal not threaded" above.
3. **Cross-table Transform apply** ✅ closed by Phase 4a-6 (2026-04-26). Migration 076 wired the cross-table branch of `dq_apply_field_transform_joined`; `applyTransform` derives `p_join_spec` per apply via `buildJoinSpec` and the three-layer transparency stack is retired. See "Phase 4a-6 — cross-table apply" below for the full disposition.
4. **Edit-existing-mapping mutations not yet wired.** Phase 4b covers W2 (add/remove `mapping_sources` on a mapped TFM), W3 (combination_type change), and W4 (un-acknowledge). Until 4b ships, mapped-row drawer bodies remain read-only — the user must Reject + recreate to fix a mistaken mapping.
5. **Bulk operations not yet wired.** Phase 4c covers W5 (Approve all / Reject all per TM, Approve high-confidence project-wide). Until 4c ships, every approval/rejection is a per-row drawer action.
6. **Empty-state prose on Rule 6 unmapped rows is stale on Heritage.** `UNMAPPED_BODY_PROSE` ("Remapping unmapped fields is coming soon. For now, use the legacy Mapping view to create a new mapping.") was authored pre-Phase-4a as an empty-state placeholder. Heritage now has both `[Suggest with AI]` and `[Create mapping]` footer buttons on the same drawer, making the prose contradictory. The prose stays for non-flag projects (where the legacy view IS the answer) and a copy revisit is queued for Phase 5-Cleanup once the flag comes off and the legacy file retires. Code-comment annotated at `MappingDrawer.tsx` `UnmappedBody` JSDoc.
7. **Legacy `MappingContent.tsx` still in tree.** The 4,008-LOC legacy file plus the `lib/compat/mapping-shim.ts` translation layer continue to power non-flag projects. Removal is Phase 5-Cleanup, after the flag has been on globally for 30+ days canary.

### Patterns established in Phase 4a (vs legacy)

For future maintainers and agents working on Phase 4b / 4c / 5: these are the patterns Phase 4a established that should be followed by subsequent mutation gaps. Each replaces or extends a legacy pattern.

| Concern | Phase 4a-established pattern | Legacy pattern (do not reuse) |
|---|---|---|
| Server-side write surface | Thin wrappers in `lib/actions/mappings-for-redesign.ts` that decode redesign `rowId` shim format → resolved TFM/source ids, defend pre-flight, identity-snapshot, delegate to legacy action, race-handle `alreadyDeleted`, emit activity log, return redesign-shaped result | Direct calls to `lib/actions/mappings.ts` (which owns auth/perm/guardWrites but does not log most mutations) |
| Form state | Hand-rolled `useState` + `useTransition` + `forwardRef`/`useImperativeHandle` for parent-controlled close. Founder decision §7 — no react-hook-form, no Zod | Inline-add-field-row idiom (`MappingContent.tsx:523`) |
| Source picker | `SourceFieldPicker` (Radix-free, server-order-preserved, multi-select with chips, same-table + cross-table modes, no client `.sort()`) | Legacy inline picker on the legacy mapping page |
| Combination strategy | Inline radio group surfaced only when 2+ sources selected; example text dynamic from sample values; `concat_space` default; `custom_sql` disabled in 4a (transform-tab concern) | Legacy combination dropdown on the legacy mapping page |
| Discard guard | `formRef.current.requestClose()` routed from all four close paths (Cancel/Esc/click-outside/X). Pops `DiscardChangesDialog` when dirty; short-circuits when clean. The fifth path (row-switch-while-dirty) gets toast-with-Undo, not the dialog | Legacy mapping page has no dirty guard |
| Toast surface | Single `ToastProvider` at `MappingContent` root + `useToast` consumer hook. ARIA `role="status"`, 5-second auto-dismiss, single action slot. Used for "Draft discarded" + Undo today; reusable for any non-blocking mutation feedback in Phase 4b/4c | Legacy uses inline error banners and `confirm()` dialogs |
| Confidence formatting | Single source of truth in `lib/utils/confidence-format.ts` (`formatConfidencePercent`, `classifyConfidence`, `formatConfidenceLabel`). ConfidencePill is the only consumer of color bands; pre-existing `ConfidenceCell` / `RowConfidenceSection` / `SourceBullet` cells stay muted slate | Three inline `formatConfidence` helpers, now consolidated |
| AI Suggest invocation | `requestSuggest` race-resolution: abort prior + fire new (founder decision §1-OQ-1). `AbortController` is client-side discard only; server tokens are sunk cost. `originalSuggestedIds` tracks initial source set for laundering prevention at save time | Legacy `suggestRemainingMappings` is per-TM bulk only |
| Strict-mode resistance | Parent-owned `useRef<Set<string>>` consumption guards in components that survive child remounts. The 4a-4b auto-suggest guard lives in `MappingDrawer` (does not remount) keyed by `targetField.id`, with `tryConsumeAutoSuggest` callback exposed to the form | n/a (legacy did not have strict-mode-sensitive effects) |
| Error surface | Single generalized `ErrorBanner` (founder decision §7-OQ-1 of 4a-4b) parameterized via `actionLabel` + `onAction` props. `SUGGEST_ERROR_COPY` map drives affordance per error code. RATE_LIMITED is the only persistent affordance | Legacy uses ad-hoc inline error spans |
| Discard dialog | Single `DiscardChangesDialog` parameterized via `variant: 'discard' \| 'replace-ai'` prop (founder decision §3-OQ-2 of 4a-4b) — no extraction, single component handles both cases | Legacy uses `confirm()` |
| Audit log | Wrapper-side after successful delegate; one event per user action (`mapping_created`, `mapping_approved`, etc.). Phase 4a's wrappers carry the logging burden because the legacy actions do not (eight of eighteen are silent — see `phase-4-plan.md` §2.2) | Legacy emits `mapping_approved` and `mapping_rejected` from `updateFieldMappingStatus` only |
| Provenance metadata | `aiSuggested` boolean on TFM rows persists only when the saved source set retains overlap with the most recent loaded suggestion's `sourceFieldIds`. `confidence` and `aiReasoning` ride along when `aiSuggested=true` and drop otherwise | Legacy persists AI metadata unconditionally on suggested mappings |
| Cross-table apply transparency | Three-layer stack: (1) wrapper short-circuits with structured error code, (2) Transform tab disables Apply / Test, (3) drawer surfaces transparency badge. All three layers must move together when the RPC branch lands | Legacy never supported cross-table apply |

### Smoke-test sign-off

Heritage smoke test verified all 13 layers across 4a-4b's commit: Path B (footer) single-POST in dev (strict-mode fix confirmed live), auto-trigger from Rule 6 footer, in-form pill on empty manual form, cancel mid-pending (forwardRef path), replace warning when manually edited / suppressed when AI-pre-filled-and-untouched / fired when AI-pre-filled-then-edited, laundering prevention (both branches), race resolution (rapid Suggest+Cancel+Suggest), confidence pill colors at threshold boundaries, network error flow with Try again, refactor parity preserved on existing rows, dark/light mode parity preserved.

End-to-end Phase 4a flow on Heritage (Reject → Suggest with AI → Save / Create cross-table → Save / row-switch Undo / Approve) is the recommended Phase 4b kickoff smoke check before any Phase 4b code lands.

### Forward look — what remains in Phase 4

| Sub-phase | Workstreams | Wrappers | Status |
|---|---|---|---|
| 4a-5 | Closure docs + code cleanup | n/a | ✅ shipped 2026-04-26 |
| 4a-6 | Cross-table Transform apply — RPC branch + transparency stack retirement | migration 076 + `buildJoinSpec` in action layer | ✅ shipped 2026-04-26 |
| 4b | W2 + W3 + W4 (edit sources, edit combination, un-acknowledge) | wraps `editFieldMapping`, `deleteFieldMapping`, `removeAcknowledgment` + new `updateMappingCombination` | ⏳ pending |
| 4c | W5 (bulk approve / reject / approve-high-confidence) | wraps `approveAllFieldMappings`, `rejectAllFieldMappings`, `approveHighConfidenceMappings` | ⏳ pending |
| 4-extras | Cross-table AI Suggest, AbortSignal threading on Suggest, source-side acknowledgment toggle | new LLM prompt design + wrapper signature widen | ⏳ pending — only if Heritage smoke-test demands |
| 5-Cleanup | Legacy file retirement, feature-flag removal, shim deletion, stale prose copy revisit | n/a | ⏳ pending — gated on 30-day canary |

See `docs/features/phase-4-plan.md` for the detailed Phase 4b/4c partition plan.

## Phase 4a-6 — cross-table apply (2026-04-26)

Phase 4a-6 closes the cross-table loop opened by 4a-3: cross-table TFMs that previously had to be authored, then short-circuited at apply time, now run through `dq_apply_field_transform_joined` end-to-end. The same RPC handles both branches; the action layer routes them by deriving `p_join_spec` per apply.

This is a **single atomic commit** spanning a migration, a new utility module, an overload extension, action-layer routing, retirement of the three-layer transparency stack, and a documentation pass — paired with `tests/integration/transform-apply-cross-table-heritage.test.ts` for end-to-end verification on Heritage. Founder decisions §1-OQ-A through §10-OQ-B (locked 2026-04-26) plus the additional `CROSS_TABLE_FK_INFERENCE_FAILED` error code drove the scope.

### Migration 076 — `dq_apply_field_transform_joined` cross-table branch

`supabase/migrations/076_dq_apply_field_transform_joined_cross_table.sql` is a `CREATE OR REPLACE` (idempotent — re-running against an already-migrated DB is a no-op). The function gains a four-arg signature: `(p_target_field_mapping_id UUID, p_target_field_name TEXT, p_transform_sql TEXT, p_join_spec JSONB DEFAULT NULL)`.

**Same-table branch (preserved byte-for-byte from migration 074):** when `p_join_spec IS NULL`, the function executes the existing single-`data_rows`-partition `UPDATE staged_data_rows ... FROM data_rows d` shape. No changes to row semantics, side effects, or error surface — the proven path is left untouched (§5-OQ-A: pure function update + grant + comment, no fixture gates).

**Cross-table branch (new):** when `p_join_spec IS NOT NULL`, the function:

1. Validates `p_join_spec` shape on entry. Required keys: `dominant_table_id` (UUID-text), `joins` (array). Each `joins[i]` element requires `joined_table_id`, `via_fk_field`, `to_fk_field`, `alias`. Missing or wrong-typed keys raise an `EXCEPTION` with a structured message — the caller (action layer) is responsible for sending well-formed JSONB; runtime raise is defense-in-depth.
2. Builds dynamic SQL with one `LEFT JOIN LATERAL ( SELECT * FROM data_rows ... ORDER BY row_number LIMIT 1 ) <alias> ON TRUE` per joined-table entry (§3-OQ-A). The `LIMIT 1` + `ORDER BY row_number` tiebreak (§3-OQ-B) makes 1:N relationships deterministic — when multiple joined-side rows match a given dominant row, the lowest `row_number` wins. `LEFT JOIN` (not `INNER`) preserves dominant-row cardinality so an FK miss does not drop the row from the apply set.
3. The `UPDATE staged_data_rows` body executes the user's `p_transform_sql` (already alias-qualified by the action layer's `wrapFieldRefsInJsonb` cross-table overload — see below) over the dominant projection plus the joined LATERAL aliases. FK-missed joined cells resolve to `NULL`; the SQL operator that consumes the NULL produces the same result as same-table apply on a NULL source field — typically a NULL output, which `staged_data_rows.transformed_row_data` then preserves the prior value for (§8a-OQ matches same-table behaviour).
4. Emits `RAISE NOTICE clock_timestamp()` deltas at three checkpoints (entry, each LATERAL added, final UPDATE complete) — §9-OQ-B timing instrumentation. Real-data performance is observable from Supabase logs without functional indexes; index revisits are deferred until measured cost forces optimization (§9-OQ-A: no special ingestion-side index strategy planned).
5. Re-grants `EXECUTE` (idempotent), updates `COMMENT ON FUNCTION` to reflect cross-table support.

The legacy `dq_apply_field_transform` (single-TM, used by the value-assignment loop) is untouched and not deprecated — that's a Phase 5-Cleanup concern (§5-OQ-B).

### `p_join_spec` JSONB contract

The on-disk shape consumed by the RPC (snake_case, mirrors `migrations/076` parameter parsing):

```json
{
  "dominant_table_id": "<uuid>",
  "joins": [
    {
      "joined_table_id": "<uuid>",
      "via_fk_field": "<dominant-side FK column name>",
      "to_fk_field":  "<joined-side referenced column name>",
      "alias":        "j0"
    }
  ]
}
```

Distinct from the camelCase `JoinSpec` interface in `lib/types/mappings-for-redesign.ts`, which describes the per-row `mapping_sources.join_spec` storage shape. The action layer translates between the two; this is intentional separation between storage (per-source-row) and RPC contract (per-table).

`alias` is purely positional: the dominant projection always uses `'d'`; joined contributors use `'j0'`, `'j1'`, etc., assigned in input order. The aliases match what the RPC's dynamic SQL expects in the LATERAL clauses, AND what the cross-table `wrapFieldRefsInJsonb` overload emits in the rewritten transform SQL.

### `buildJoinSpec` — action-layer derivation

`lib/utils/transform-cross-table.ts` exports two helpers, paired with unit tests in `tests/utils/transform-cross-table.test.ts`:

- **`deriveJoinSpec(input)`** — pure function. Given pre-fetched dominant + per-table contributor metadata, produces `{ ok: true, spec, fieldMap }` or `{ ok: false, errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED', error }`. Same-table TFMs (zero contributors) return `{ ok: true, spec: null, fieldMap: null }` — the caller short-circuits to the same-table apply path.
- **`buildJoinSpec(tfmId, supabase)`** — async wrapper. Pulls `mapping_sources`, the parent TFM's `project_id`, the project's `tables`, and the involved tables' `fields` in four queries, dedupes per-source rows to per-table joins, then delegates to `deriveJoinSpec`.

**Per-source → per-table dedupe (§1-OQ-A).** `mapping_sources.join_spec` is recorded *per row* (one per contributing source field). The RPC consumes *per table* — one LATERAL clause per distinct joined source table, regardless of how many fields from that table contribute. A 4-field cross-table TFM with two fields from `LOAN_MASTER` (dominant) and two fields from `CIF_MASTER` (joined) collapses to exactly one LATERAL clause for `CIF_MASTER`. The first non-null `join_spec` observed per joined table wins; null rows fall through to FK re-derivation. Pinned in `tests/utils/transform-cross-table.test.ts` "per-row → per-table dedupe".

**FK re-derivation when stored is null (§8f-OQ).** `createFieldMapping` writes `mapping_sources.join_spec=null` when a single FK candidate was found at write time (the read path re-derives the annotation via `inferFkCandidates`). At apply time we re-derive again — schema may have shifted since the mapping was authored. If `inferFkCandidates` now returns 0 or 2+ candidates, `buildJoinSpec` returns `{ ok: false, errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED', error: '<copy>' }` *before* invoking the RPC. The action layer surfaces both `error` and `errorCode` so the UI can render the user-facing copy ("FK relationship changed since this mapping was authored. Please re-author the mapping.") and downstream callers can branch on the structured code. Auto-persisting a re-derived spec is intentionally NOT done — parity with the read path, and it would mask schema drift.

**No TFM-level join_spec column (§2-OQ-A).** The per-row `mapping_sources.join_spec` storage shape is unchanged. We did not add a denormalized TFM-level column; the per-apply derivation is cheap (four queries, all keyed on indexes), and a denormalized cache would have to be invalidated on every schema change.

### `wrapFieldRefsInJsonb` cross-table overload

`lib/utils/transform-helpers.ts` gains a second overload signature:

```ts
function wrapFieldRefsInJsonb(sql: string, fieldNames: string[]): string                                // same-table (preserved)
function wrapFieldRefsInJsonb(sql: string, fieldsByTableName: Map<string, CrossTableFieldEntry>): string // cross-table (new)
```

Same-table call sites (single-source mapped TFMs and value assignments) are zero-change — the `string[]` signature preserves migration 074 semantics byte-for-byte (§4-OQ-B).

**Field reference qualification (§4-OQ-A).** Cross-table transforms must use table-qualified field references (`Table.Field`). Bare or singly-quoted unqualified references in cross-table TFMs throw `Cross-table transforms must use table-qualified field references.` because two same-named columns in different tables would otherwise resolve to whichever happens to win.

The cross-table overload accepts three input shapes for qualified references:
- `"LOAN_MASTER.LOAN_TYPE"` — single quoted-identifier with the dot inside the quotes
- `LOAN_MASTER.LOAN_TYPE` — two adjacent bare identifiers separated by a dot
- `LOAN_MASTER . LOAN_TYPE` — same with whitespace around the dot (SQL convention)

All three rewrite to `(<alias>.row_data->>'Field')` using the alias from the input map (`'d'` for dominant, `'j0'` / `'j1'` / … for joined contributors). Single-quoted SQL string literals are passed through untouched in both same-table and cross-table modes — value strings like `'Active'` or `'CIF_TYPE'` (as a literal) are never rewritten.

The action layer's `applyTransform` and `testTransformation` invoke the cross-table overload only on the cross-table branch (when `buildJoinSpec` returns a populated `spec`); the same-table branch keeps the `string[]` signature. Pinned in `tests/actions/transforms-cross-table-apply.test.ts` X3 block.

### `applyTransform` and `testTransformation` routing

`lib/actions/transformations.ts:applyTransform` flow for mapped TFMs (Phase 4a-6 shape):

1. `resolveTfmId` + `loadTfmContext` + `requireProjectPermission(..., 'editor')` — unchanged.
2. **`buildJoinSpec(ctx.tfm.id, supabaseAdmin)`** — runs *before* the maintenance guard. Returns `{ ok: true, spec, fieldMap }` for both same-table (`spec=null`) and cross-table TFMs, or `{ ok: false, errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED' }`. Failure short-circuits with the structured envelope.
3. Inside `guardWrites`: for the cross-table branch, wrap the user SQL with the cross-table overload (using `okSpec.fieldMap`) and pass `p_join_spec = okSpec.spec` to the RPC. For the same-table branch, the existing flat-field-name list path runs unchanged (`p_join_spec = null`). Wrap-time errors (bare-ref violations) are caught and converted to `{ success: false, error }` rather than propagating as exceptions.
4. RPC call passes the four-arg payload `(p_target_field_mapping_id, p_target_field_name, p_transform_sql, p_join_spec)`. Pinned in `tests/actions/transforms-cross-table-apply.test.ts` X2 block.

`testTransformation` mirrors the routing logic so FK ambiguity surfaces consistently across Apply and Test (X5 block). Cross-table SQL is qualified-aware-rewritten then alias-stripped (`<alias>.row_data->>'Field'` → `row_data->>'Field'`) before handoff to the single-partition `execute_transform_test` RPC, which doesn't accept aliases. The dominant-table portion previews; joined-table refs collapse to NULL until a join-aware test RPC ships in Phase 4-extras.

The previous `CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED` short-circuit is **removed** (§6-OQ-A). The `TransformWriteErrorCode` union member is also removed and replaced with `CROSS_TABLE_FK_INFERENCE_FAILED`. Source-level invariant pins this in `tests/actions/transforms-cross-table-apply.test.ts` X4 + X6 blocks.

### Transparency stack retirement (§6-OQ-A + §6-OQ-B)

The Phase 4a-3 three-layer transparency stack is fully retired. Surfaces touched (19 enumerated touch points, paraphrased here):

**Action layer:**
- `lib/actions/transformations.ts` — `isCrossTableTfm` private helper deleted; `projectHasCrossTableMappings` exported helper deleted; `CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED` union member removed; header-comment narrative updated to reference 4a-6 wiring.
- `lib/actions/mappings-for-redesign.ts` — JSDoc on `createFieldMapping` updated to point at the working apply path and document `CROSS_TABLE_FK_INFERENCE_FAILED`.

**Legacy Transform UI:**
- `app/app/projects/[projectId]/transform/page.tsx` — `projectHasCrossTableMappings` server-fetch removed; `hasCrossTableMappings` prop dropped from the `TransformContent` invocation.
- `app/app/projects/[projectId]/transform/TransformContent.tsx` — `hasCrossTableMappings` prop deleted; `disabled` clauses on `Test Transform` and `Apply Transform` no longer reference `selectedContext?.field.isCrossTable`; the "future release" tooltip copy is removed.

**Redesign Transform UI placeholder:**
- `app/app/projects/[projectId]/transform/redesign/TransformContent.tsx` — `hasCrossTableMappings` prop deleted; the `transform-redesign-cross-table-note` informational line is removed.

**Drawer Sources badge:**
- `app/app/projects/[projectId]/mapping/redesign/components/MappingDrawer.tsx` — `CrossTableApplyBadge` component deleted; `headerAside` plumbing on `SourcesSection` no longer threads the badge.

**Tests:**
- `tests/components/transform-cross-table-disabled.test.ts` deleted; replaced by `tests/components/transform-cross-table-enabled.test.ts` (negative invariant — pins that no `disabled={...}` expression references `isCrossTable`, no "future release" copy remains, no `hasCrossTableMappings` prop remains).
- `tests/actions/transforms-refinements.test.ts` — R2c block removed (it pinned the retired short-circuit + `isCrossTableTfm` helper). R2 updated to assert the new payload shape (`p_join_spec` derived via `buildJoinSpec`, defaults to null for same-table).
- `tests/components/mapping-drawer.test.tsx` — assertion flipped to "badge no longer rendered".
- `tests/components/transform-redesign-placeholder.test.tsx` — assertion flipped to "cross-table note no longer rendered".

### Test coverage (§7-OQ-A + §8d-OQ)

| Layer | File | What it pins |
|---|---|---|
| Pure derivation | `tests/utils/transform-cross-table.test.ts` | Same-table short-circuit, stored-spec honour, FK re-derivation (1/0/2+ candidates, unparseable `fk_reference`), 3-table aliasing (`d`/`j0`/`j1`), per-row → per-table dedupe via `buildJoinSpec` async stub, ambiguous-FK schema-drift case |
| SQL rewriting | `tests/utils/transform-helpers.test.ts` | Same-table overload BCC (bare/quoted/`"Table.Field"` forms, literal preservation), cross-table overload (quoted + 2-token + whitespace-tolerant dot, bare-ref throw, literal preservation, unknown qualifier passthrough) |
| Action routing | `tests/actions/transforms-cross-table-apply.test.ts` | `buildJoinSpec` gates the RPC call (X1), four-arg payload shape (X2), overload routing per branch (X3), transparency stack retirement (X4), `testTransformation` routing parity (X5), `TransformWriteErrorCode` union member (X6) |
| Component | `tests/components/transform-cross-table-enabled.test.ts` | No `disabled={...}` references `isCrossTable`; no "future release" copy; no `hasCrossTableMappings` prop |
| Integration (on-demand) | `tests/integration/transform-apply-cross-table-heritage.test.ts` | End-to-end seed → apply → assert composite shape on `staged_data_rows` → cleanup against Heritage; gated by `RUN_TRANSFORM_APPLY_CROSS_TABLE_HERITAGE_INTEGRATION=1`. Covers 2-table cases (§8d-OQ); 3-table SQL generation pinned via the unit + source-level layers above. |

### Deferrals carried forward to Phase 4-extras

- **`join_strict` semantics (§8b-OQ).** Today every join is `LEFT JOIN LATERAL` (preserve prior on FK miss). A future toggle to opt into `INNER JOIN` semantics (drop dominant rows on FK miss) is deferred — Heritage hasn't surfaced a need.
- **Cross-table preview parity in `testTransformation`.** The single-partition `execute_transform_test` RPC doesn't accept aliases, so cross-table previews currently strip aliases and resolve joined refs to NULL. A join-aware test RPC is queued for Phase 4-extras; the alias-stripping comment in `lib/actions/transformations.ts` is the explicit handoff.
- **JSONB functional indexes on `data_rows.row_data`.** Not needed at Heritage scale; revisit if real-data timing instrumentation surfaces measurable cost (§9-OQ-A + §9-OQ-B).

## Phase 4b-1 — edit mapping sources / combination (2026-04-26)

Phase 4b-1 closes the W2 + W3 workstreams from `phase-4-plan.md`: a user with an existing mapped TFM can now edit its source set and/or combination type without rejecting and recreating. W4 (un-acknowledge) ships as 4b-2 fast-follow within the same week (founder §9.1).

This is a **single atomic commit** spanning three new server actions, a parameterized form component, an updated drawer state machine, a new invalidation-warn dialog, ~75 source-level invariant tests, three on-demand Heritage integration tests, and this documentation pass. Founder decisions §1 through §22 (locked 2026-04-26 — see commit history) drove the scope.

### Server-side wrappers

`lib/actions/mappings-for-redesign.ts` gains three new exports:

- **`editMappingSources(input)`** — atomic source-set replacement. Routes through the new `dq_replace_mapping_sources` RPC (idempotent DELETE + INSERT in one transaction) plus a `target_field_mappings` UPDATE for combination + status. Reverts status to `needs_review` on any source/combination change (§3.2). When sources change, also calls `resetFieldTransform` to delete the `transformations` row and revert staged data — combination-only edits do NOT reset the transform (§1.3). Cross-table FK precheck mirrors `createFieldMapping` (§5.1 — ambiguity is cleared on the cross/same toggle so users can correct it inline). Dominant-table swaps surface as a `DOMINANT_TABLE_CHANGED` validation error (§4 — no auto-rewrite of transform SQL on cross-table demotion). The full error code union is the 9-member `EditMappingErrorCode` (`VALIDATION`, `NOT_FOUND`, `PERMISSION_DENIED`, `MAINTENANCE_MODE`, `TFM_REJECTED`, `TFM_ACKNOWLEDGED`, `DOMINANT_TABLE_CHANGED`, `CROSS_TABLE_AMBIGUOUS`, `INTERNAL`) — §22.
- **`updateMappingCombination(tfmId, combinationType)`** — combination-only edit. Cheaper than `editMappingSources` because no RPC call is needed (sources unchanged). Status reverts to `needs_review`; transform is NOT reset (§1.3). Provenance laundering does not apply (§1f — no source touched). No-op short-circuit when the combination is unchanged AND status is already `needs_review` (avoids activity-log spam).
- **`previewEditInvalidation(tfmId)`** — read-only pre-save query for the dialog. Returns `{ hasTransform, stagedRowCount, capped }` where `stagedRowCount` is capped at 101 (`PREVIEW_INVALIDATION_COUNT_CAP`) — anything ≥ 100 renders qualitative copy ("Staged data will be invalidated") rather than a misleading exact number (§2.1). The drawer uses this to decide whether to pop the EditInvalidationDialog before invoking `editMappingSources`.

#### Provenance laundering rule (4a–4b parity)

`editMappingSources` reads the current `mapping_sources` rows' `ai_reasoning` flags before deletion. If at least one **surviving** source row carried non-null AI provenance, the resulting TFM keeps `ai_suggested=true` and the existing `ai_reasoning` text. Otherwise both flags drop. The rule mirrors create-mode laundering established in 4a-4b — manual edits that strip every AI-contributing source flip the TFM to manual provenance, preventing audit-trail drift. The form does NOT thread provenance flags over the wire (§7.1 — laundering is server-side only).

#### Activity logging

Two activity-log entries fire per edit:

- `mapping_sources_changed` — always emitted on any edit (even no-op edits log so the audit trail captures explicit user intent). Metadata carries `target_field`, `source_fields`, `combination_type`, `sources_changed`, `cross_table`, `transform_reset`.
- `transformation_reset` — emitted when `sourcesChanged === true` AND a transform existed. Metadata: `{ reason: 'mapping_edited', target_field_mapping_id, target_field, rows_reverted }` (§8.1).

`mapping_combination_changed` is emitted by `updateMappingCombination` for combination-only edits (carries `previous_combination_type` + `combination_type`).

### Form parameterization — `CreateMappingForm` (mode='create' | 'edit')

`CreateMappingForm.tsx` is reused for both create and edit flows. The component gains two new props:

- **`mode?: 'create' | 'edit'`** — defaults to `'create'`, so all 4a-* call sites continue to work without changes.
- **`editInitialState?: EditMappingInitialState`** — `{ tfmId, selectedIds, combinationType, joinAnnotations }`. Required when `mode === 'edit'`. Provenance flags (`aiSuggested`, `originalSuggestedIds`) are intentionally absent — laundering is server-side (founder §1.f).

Edit-mode behaviors:

- **State hydration** — `selectedIds`, `combinationType`, and `joinAnnotations` initialize from `editInitialState` when in edit mode (§5.2 — pre-populate `joinAnnotations` from existing unchanged joined tables so the user only re-disambiguates if they actually changed a cross-table source).
- **`isDirty` semantics** — in edit mode, the form compares the live picker state against `editInitialState`, not against an empty selection. A no-op edit reports `isDirty=false` and the Save button is disabled (§7 — `canSave` requires `isDirty` in edit mode).
- **Submit handler routing** — `handleSave` dispatches to `handleEditSave` when `isEditMode`, calling `editMappingSources` instead of `createFieldMapping`. Server-side error codes are mapped via `EDIT_ERROR_CODE_COPY` with refresh affordances on TFM_NOT_FOUND/REJECTED/ACKNOWLEDGED (the page state is stale).
- **AI Suggest hidden** — the Suggest pill and footer auto-trigger are gated behind `!isEditMode`; AI Suggest in edit mode is queued for 4-extras (founder §3 — same call as 4a's manual-only Suggest scope).
- **Discard guard** — `DiscardChangesDialog` is now extracted to `app/app/projects/[projectId]/mapping/redesign/components/DiscardChangesDialog.tsx` (separate concern, reused across create + edit flows). The 'discard' variant is reused for both modes; 'replace-ai' remains create-mode-only.

The post-Phase-4b-1 form weighs in at ~2,340 LOC — under the 2,400-LOC emergency stop threshold (founder Refinement 2). Further growth in 4b-2 / 4-extras may force the `useMappingFormState` hook extraction queued in `phase-4-plan.md`.

### Drawer state machine — `MappingDrawer` edit mode

`MappingDrawer.tsx` adds a new edit mode keyed off `editFormActive: boolean`:

1. **Edit affordance.** The `ApproveRejectButtons` footer renders an `[Edit]` button rightmost when `row.kind === 'mapped' && (row.status === 'needs_review' || row.status === 'approved') && row.combinationType !== 'custom_sql'` (founder §3.2 — hidden on rejected, target_acknowledged, unmapped, custom_sql; §3.3 — rightmost). Click invokes `handleEditClick`, which builds `editInitialState` from `row.sources` (selectedIds in ordinal order, `joinAnnotations` recovered from each cross-table source's `joinSpec.viaFkField`) and flips `editFormActive=true`.
2. **Body switch.** When `editFormActive`, `MappedBody` renders `<CreateMappingForm mode='edit' editInitialState={editInitialState} />` instead of the read-only mapping detail view.
3. **Footer switch.** The footer collapses to `[Cancel] [Save changes]` (`EditFooterButtons` component). Both buttons are disabled while either the preview round-trip OR the actual save is in flight, so a user cannot double-fire.
4. **Cancel flow.** Routes through `formRef.current.requestClose()` — the form's existing dirty guard pops `DiscardChangesDialog` (variant `'discard'`) when dirty, short-circuits when clean. Confirmed discard calls back to `handleEditFormCancel` which clears all edit state.
5. **Save flow.** `handleEditSavePrecheck` calls `previewEditInvalidation(editInitialState.tfmId)` first. If the preview reports `hasTransform === true && stagedRowCount > 0`, populates `editInvalidationPreview` so the EditInvalidationDialog renders — the user must explicitly confirm. Otherwise calls `formRef.current.triggerSave()` directly. On confirm, the dialog clears the preview and forwards to `triggerSave()` which routes through the form's `handleEditSave` and the `editMappingSources` server action.

### EditInvalidationDialog — apply-invalidation warn flow

`app/app/projects/[projectId]/mapping/redesign/components/EditInvalidationDialog.tsx` is the new dialog component. Copy:

> **Reset transform for this field?**
>
> Editing sources will reset the transform for `<targetFieldName>`. You'll need to re-author the transform SQL after saving (the current SQL references fields you may have removed).
>
> `<N> staged rows will be invalidated.` *(or "Staged data will be invalidated." when capped)*
>
> [Cancel] [Save and reset transform]

The confirm action is styled red-destructive to match the irreversibility (the current transform SQL will be deleted). The `<N>` interpolation respects the 101-row cap from `previewEditInvalidation` — exact count when ≤ 100, qualitative when larger (founder §2.1).

### Post-save toast with re-author deep-link

`MappingContent.tsx`'s `handleDrawerSaveSuccess` callback now branches on the `EditSaveMeta` payload:

- **`mode === 'edit'` AND `transformReset === true`** — pushes a toast with copy `"Mapping updated. <N> staged rows invalidated."` (or `"Staged data invalidated."` when ≥ 100) plus `[Re-author transform]` action. Click navigates to `/app/projects/[projectId]/transform?targetFieldMappingId=<tfmId>` (the existing Transform tab supports the URL param) — the user can immediately re-author the SQL against the new source set (founder §3.1 + §2.2).
- **`mode === 'edit'` AND `transformReset === false`** — minimal "Mapping updated." toast, no action.
- **`mode === undefined`** — create-mode path, unchanged from 4a-2.

### Test coverage

| Layer | File | Tests |
|---|---|---|
| Action — editMappingSources | `tests/actions/edit-mapping-sources.test.ts` | E1-E25: validation, auth, permission, defensive guards, dominant-table-swap, cross-table FK precheck, provenance laundering, source set-diff, RPC invocation, status update, `resetFieldTransform` call, activity logging, revalidation |
| Action — updateMappingCombination | `tests/actions/update-mapping-combination.test.ts` | C1-C5: wrapper exports, validation, auth/permission/state guards, status revert without transform reset, activity logging + revalidation |
| Component — CreateMappingForm edit mode | `tests/components/edit-mapping-form.test.ts` | F1-F12: type-level prop shape, hydration, dirty/save semantics, save-handler routing, error code mapping, AI-suggest hiding, `onSaveSuccess` threading |
| Component — MappingDrawer edit state | `tests/components/mapping-drawer-edit.test.ts` | D1-D6: Edit-button presence + visibility gate, `handleEditClick` payload, body+footer mode switch, `EditFooterButtons` rendering, preview-then-save flow + dialog wiring |
| Integration (on-demand) | `tests/integration/edit-mapping-heritage.test.ts` | I1-I3: edit-with-no-transform, edit-with-applied-transform (transform reset + staged data revert), combination-only edit (no transform reset). Gated by `RUN_EDIT_MAPPING_HERITAGE_INTEGRATION=1` |

Tests follow the source-level invariant pattern established in 4a-* (read action source as a string, assert regex patterns for key invariants) — fast, deterministic, no DB dependency. Integration tests self-seed and self-clean (the action-layer mocks bypass the two `auth.uid()`-gated SECURITY DEFINER RPCs `dq_create_target_field_mapping` and `dq_replace_mapping_sources`, mirroring the 4a-6 fixture shape).

### Known limitations carried forward

These are intentional Phase 4b-1 deferrals, not bugs (4b-2 closed item 1 below; the rest carry forward):

1. **Un-acknowledge (W4)** — ✓ shipped as Phase 4b-2 (2026-04-26). See "Phase 4b-2 — un-acknowledge field" below.
2. **Quiet edit mode rejected.** No "Save without status revert" admin path — every edit reverts to `needs_review` (founder §4.1 + §4.2 — admin nextStatus override deferred).
3. **No "don't show again" preference for the invalidation warn.** Every edit that would reset a transform pops the dialog; muting is queued for 4-extras (founder §6.1).
4. **No `'stale' flag on transformations.** When sources change, the transform is deleted (`resetFieldTransform`), not flagged stale (founder §6.2 — preserves the 4a-6 transformation contract).
5. **Cross-table edit requires `joinAnnotations` re-disambiguation only when ambiguity is fresh.** Unchanged joined tables retain pre-populated annotations across the edit (founder §5.2). Toggling cross/same-table on a source clears ambiguity for the affected joined table only.

## Phase 4b-2 — un-acknowledge field (2026-04-26)

Phase 4b-2 closes the W4 workstream from `phase-4-plan.md` and completes Phase 4b: a user with a target field that was acknowledged ("intentionally unmapped") can now reverse that decision in-place via the drawer footer, returning the field to Rule 6 (unmapped) so it becomes mappable again. Ships as a same-week fast-follow on top of 4b-1 (founder §9.1).

### Server-side wrapper

`unacknowledgeField(input: { projectId, targetFieldId })` lives in `lib/actions/mappings-for-redesign.ts` alongside the 4b-1 edit wrappers. Returns the `UnacknowledgeFieldResult` discriminated union with five error codes (`PERMISSION_DENIED`, `NOT_FOUND`, `VALIDATION`, `MAINTENANCE_MODE`, `INTERNAL`).

Sequence (matches the wrapper's inline doc):

1. Validation — empty `projectId` / `targetFieldId` → `VALIDATION`.
2. Auth — `supabase.auth.getUser()`; missing user → `PERMISSION_DENIED`.
3. Permission — `requireProjectPermission(projectId, 'editor')`; not editor → `PERMISSION_DENIED`.
4. Maintenance gate — `assertMappingWritesEnabled(projectId)`; on flag-off → `MAINTENANCE_MODE`.
5. Identity read — find the TFM via `(project_id, target_field_id)`. NOT filtered by `is_acknowledged` so we can distinguish two surfaces:
   - No row → `NOT_FOUND` (stale drawer click after another user un-acknowledged).
   - Row exists with `is_acknowledged=false` → `VALIDATION` with copy directing the user to Edit / Reject (the right surface for non-acknowledged TFMs).
6. Delegate to `removeAcknowledgment(projectId, targetFieldId)` from `lib/actions/field-acknowledgments.ts` — already does the actual delete + table-mapping recompute. Wrapped in try/catch that translates unexpected throws to `INTERNAL`.
7. Activity log — emits `acknowledgment_removed` with metadata `{ tfm_id, target_field_id, target_field, previous_acknowledgment_reason }`.
8. Revalidate `/app/projects/<id>/mapping`.

§3.k locked the status semantics: delete the TFM row, no new status enum value. The field re-renders as Rule 6 unmapped on the next read. No new RPC needed (founder §1: delegate to existing `removeAcknowledgment`).

### UI surface

Founder §3.j locked the affordance to the **drawer footer** (NOT inline). Matches the verb-action pattern of Approve / Reject / Edit. Specifically:

- `target_acknowledged` rows show a three-button footer: `[Reject (disabled)] [Approve (disabled)] [Un-acknowledge]`.
- Click → `UnacknowledgeConfirmDialog` (AlertDialog, neutral default styling — un-acknowledge is reversible by re-acknowledging, not destructive). Copy:
  > Un-acknowledge this field?
  > This will return `<field_name>` to unmapped (Rule 6) and clear the acknowledgment reason.
  > [Cancel] [Un-acknowledge]
- Confirm → `unacknowledgeField` server call → on success, drawer closes + URL clears + sidebar refreshes (mirrors reject's drawer-close path).
- Failure surfaces uniform copy "Couldn't un-acknowledge this field. Please try again." with full errorCode in the console for ops triage.

The disabled Approve/Reject tooltips ("un-acknowledge first") still apply — un-acknowledge is now the explicit way to follow that guidance.

### Activity log

Uses the existing `acknowledgment_removed` action type (added in the Phase 4 mutation-completeness widening, see `lib/actions/activity-log.ts:31`). No new action type needed.

### Test coverage

| Layer | File | Coverage |
| ----- | ---- | -------- |
| Action — server-level invariants | `tests/actions/unacknowledge-field.test.ts` | U1-U7 + sequencing: auth/permission/maintenance gates, NOT_FOUND vs VALIDATION distinction, removeAcknowledgment delegation, activity log + revalidate, ordered checks (validate-before-auth, auth-before-permission, permission-before-DB-read) |
| Component — MappingDrawer un-ack state | `tests/components/mapping-drawer-unacknowledge.test.ts` | UN1-UN6: button presence + position (rightmost in `AcknowledgedFooterButtons`), visibility gate (only inside `target_acknowledged` branch), click-opens-dialog flow, dialog cancel does NOT call wrapper, confirm wires `unacknowledgeField({ projectId, targetFieldId })` and threads `onActionComplete?.('unacknowledge', ...)`, drawer-close + error-copy semantics |
| Integration (on-demand) | `tests/integration/edit-mapping-heritage.test.ts` (extended) | I4: seed bare-acknowledged TFM via `supabaseAdmin`, invoke `unacknowledgeField`, verify TFM row is gone (field returns to Rule 6 unmapped). Gated by `RUN_EDIT_MAPPING_HERITAGE_INTEGRATION=1` |

Same source-level invariant testing strategy as 4a-* / 4b-1 — fast, deterministic, no DB dependency for the unit layer; integration test self-seeds via direct admin insert (the `dq_acknowledge_target` RPC is also `auth.uid()`-gated and would require the same bypass pattern).

### Known limitations carried forward (Phase 4b-2)

1. **Source-side un-acknowledge.** The `removeAcknowledgment` helper handles both target-side (deletes the bare-ack TFM) and source-side (deletes the `source_field_acknowledgments` row). The drawer un-acknowledge surface is target-side ONLY — source-side acknowledgments are still managed via the legacy field-acknowledgment surface (the redesign drawer renders source rows differently). This is not a regression; source-side ack management was always out of scope for the drawer.
2. **No re-acknowledge shortcut after un-acknowledge.** Once un-acknowledged, the field returns to Rule 6 unmapped; the user reaches the standard W1 form to re-ack. No "undo" button (mirrors reject's no-undo policy).

## Phase 4c-1 — bulk approve (2026-04-26)

Phase 4c-1 ships the first half of W5 (bulk operations). Reviewers facing N×M mapping projects (Mitratech-class: ~1000 TFMs across 30+ tables) get two new affordances on the redesign Mapping page:

1. **Per-target-table approve.** A kebab menu (`⋯`) on each `TargetTableGroup` header surfaces "Approve all needs-review" — flips every needs-review TFM in that table to `approved` in one click.
2. **Project-wide high-confidence approve.** A small text-button in the `FilterRow`'s right-aligned region: "Approve high-confidence (N)" — flips every needs-review TFM whose `confidence ≥ 85` to `approved`, project-wide.

The reject side ships in 4c-2 as a fast-follow (founder §10.1 split: complexity asymmetry around `resetFieldTransform` per-row + staged-data revert pre-DELETE makes reject the larger lift).

### Server-side wrapper surface

Three new exports in `lib/actions/mappings-for-redesign.ts`:

- `bulkApproveFieldMappingsForTargetTable(input: { projectId, targetTableId })` — write path. Returns `BulkApproveResult` discriminated union with `rowsAffected` + `tfmIds[]` on success, or `error` + `errorCode` on failure.
- `approveHighConfidenceMappings(input: { projectId, threshold? })` — write path. Same result shape; threshold defaults to 85, validated to `[0, 100]`.
- `previewBulkApprove(input: { projectId, targetTableId })` — read-only helper. Returns `{ count, preview[] }` capped at 5 preview rows. Used by `BulkConfirmDialog` to render the confirmation count + first-five-rows preview without a TOCTOU window between client-side derivation and server-side write.

All three pass the standard gate stack (auth → `requireProjectPermission(projectId, 'editor')` → `assertMappingWritesEnabled`). Preview's permission gate is `viewer`-level.

### Scope hard-coding

The bulk wrappers DELIBERATELY do NOT consult the user's live filter state. Scope is hard-coded at the wrapper boundary:

| Wrapper | Filter |
|---|---|
| `bulkApproveFieldMappingsForTargetTable` | `status='needs_review'` AND `is_acknowledged=false` AND `target_field` belongs to `targetTableId` |
| `approveHighConfidenceMappings` | `status='needs_review'` AND `is_acknowledged=false` AND `confidence >= threshold` |

Founder §6.3 — coupling bulk scope to the user's transient filter dropdown would mean two different users with the same project state could see different "Approve all" semantics depending on what they had typed into Search. The hard-coded scope reads identically from any UI surface.

The `is_acknowledged=false` clause is critical: a bare-acknowledged TFM (the W1 product of "intentionally unmapped") is NOT a needs-review mapping, even though its `status` is sometimes `needs_review` in legacy data. Bulk approve never auto-acknowledges (founder §2.2) — that legacy behavior in `approveAllFieldMappings` is intentionally NOT inherited.

### Idempotency

The hard-coded `status='needs_review'` filter makes both wrappers idempotent under re-run: a re-fired click after partial failure simply skips the already-flipped rows. No transactional wrapping; no progress-bar UI.

### Activity-log strategy

Single bulk entry per click (founder §7.1 — N+1 per-row entries would create log spam at Mitratech scale). The pre-staged `mapping_bulk_approved` ActionType carries:

```ts
metadata: {
  scope: 'target_table_needs_review' | 'project_high_confidence',
  count: number,
  tfm_ids: string[],
  fields_affected: string[],         // human-readable target-field names
  target_table_id?: string,          // per-table only
  target_table_name?: string,        // per-table only
  threshold?: number,                // high-confidence only
}
```

The `tfm_ids` array preserves the granular audit trail without exploding the log row count.

### Preview pattern

`BulkConfirmDialog` opens before any write, populated by:

- **Per-table path**: server-side `previewBulkApprove(projectId, targetTableId)` — authoritative count + first 5 preview rows (each = `{ tfmId, targetField, primarySource }`). Renders a "Loading preview…" indicator while the call is in flight.
- **High-confidence path**: client-side derivation from already-loaded `data.rows` (every row carries `confidence` already; the preview is a pure pass over the existing collection — no new round-trip). Same `BulkPreviewRow` shape.

When `count > preview.length`, the dialog renders an "and N more…" line. The 5-row cap mirrors founder §3.2.

### UI surfaces

- `BulkConfirmDialog.tsx` — new shared confirmation primitive. Parameterised for `mode: 'approve' | 'reject'` ahead of 4c-2 (only approve callers ship in 4c-1; reject styling is wired but unreached).
- `TargetTableGroup.tsx` — adds a kebab menu to the header. Single item in 4c-1: "Approve all needs-review". Disabled with subtitle "No needs-review mappings" when count=0. Founder refinement (2026-04-26): we do NOT ship a disabled "Reject" placeholder — that lands alongside its wiring in 4c-2.
- `FilterRow.tsx` — adds "Approve high-confidence (N)" text-button in the right-aligned region. Hidden when N=0.

The redesign already lacks a `DropdownMenu` shadcn primitive (intentional — see `components/ui/`). The kebab uses a bespoke click-outside-closing menu inlined in `TargetTableGroup.tsx`. ~70 LOC; promotes to a shared primitive only if 4c-2 or beyond grows a third caller.

### Known limitations carried forward (Phase 4c-1)

1. **No bulk reject.** Ships in 4c-2 (founder §10.1 split). Per-table kebab has only Approve in 4c-1.
2. **No multi-select / checkbox model.** Filter-scoped bulk only (founder §1.3). Adding row checkboxes is a separate W5b investigation if needed.
3. **No undo for bulk approve.** Per-row Approve is reversible via the drawer; bulk approve has no atomic undo (the user can re-author each row individually). Founder §5.2 — "This cannot be undone" copy makes that explicit at confirm time.
4. **High-confidence preview is client-derived.** The per-table path uses `previewBulkApprove`; the high-confidence path derives count + preview from already-loaded `data.rows`. Both are authoritative at dialog-open time; the wrapper's idempotent scope filter handles any divergence at write time.

## Phase 4c-2 — bulk reject (2026-04-26)

Phase 4c-2 closes Phase 4c by shipping the second half of W5: per-target-table bulk reject. The kebab menu in `TargetTableGroup` now has two items — Approve all needs-review (4c-1) and Reject all needs-review (4c-2) — sharing the lifted-dialog state machine in `MappingContent` and the `BulkConfirmDialog` primitive.

### Wrapper surface

- `bulkRejectFieldMappingsForTargetTable({ projectId, targetTableId })` returns a `BulkRejectResult` discriminated union. Success variant carries `rowsAffected`, `transformsReset`, `stagedRowsReverted`, `tfmIds`, and an optional `failedTfmIds` (only present on partial-success). Failure variant uses the same five-code `BulkRejectErrorCode` union as the approve wrapper (`PERMISSION_DENIED | NOT_FOUND | VALIDATION | MAINTENANCE_MODE | INTERNAL`).
- `previewBulkReject({ projectId, targetTableId })` is the read-only companion. Same shape as `previewBulkApprove` plus a per-row `hasTransform: boolean` flag that surfaces in the dialog as a transform-reset indicator.

The wrapper does NOT reuse the legacy `rejectAllFieldMappings` (Phase 4c investigation §2.1) — the legacy path flips `status='rejected'` whereas the redesign UI deletes the row outright (founder amendment 2026-04-21; per-row reject already DELETEs). Reusing the legacy action would silently desync the audit trail and the visible state.

### Scope (hard-coded, NOT user-filter-state aware)

Same scope filter as bulk approve (§6.1, §6.3):

- `status === 'needs_review'`
- `is_acknowledged === false`
- `target_field`'s table === input `targetTableId`

Acknowledged TFMs are bare-acks ("intentionally unmapped") and surface "Un-acknowledge" instead (Phase 4b-2). Approved TFMs are out of scope; the user reaches them via per-row reject if they want to delete a previously-approved row.

### Partial-success handling (forward-progress)

Reject is destructive — failing the whole batch on a single transform-reset error is hostile UX when the user just wants those rows gone. The wrapper takes the forward-progress path (locked decision §5.3):

1. Identity-read the in-scope TFM set.
2. Per-TFM `resetFieldTransform(tfmId)` loop. The helper is no-op-safe for TFMs without a transformations row (returns `success: true, hadTransform: false`); failures populate `failedTfmIds` and exclude the TFM from the rejectable set.
3. Single bulk `DELETE.in('id', rejectableIds)` on `target_field_mappings`. CASCADE removes `mapping_sources` and any residual `transformations` rows automatically.
4. TM recompute pass for affected `table_mappings`.
5. Single `mapping_bulk_rejected` activity-log entry. Metadata: `{ scope: 'target_table_needs_review', count, tfm_ids, failed_tfm_ids?, fields_affected, target_table_id, target_table_name, transforms_reset }`. The `failed_tfm_ids` key is only present on partial-success (object-spread pattern keeps the metadata blob clean on full success).
6. `revalidatePath('/app/projects/[id]/mapping')`.

When every TFM's transform reset fails (rejectable.length === 0 after the loop), the wrapper returns `INTERNAL` rather than `VALIDATION` — the empty-scope VALIDATION case is reserved for "nothing to reject in the first place" (caught before the loop).

### UI surfaces

- `BulkConfirmDialog.tsx` — reject mode wires the locked §5.2 copy: "Each rejected mapping is deleted permanently. The target fields will appear as unmapped (Rule 6). This cannot be undone." Action button uses red destructive styling (`bg-red-600 hover:bg-red-700`). Loading-state label is "Rejecting…". Preview rows render a small `transform` badge when `row.hasTransform` is true and the dialog is in reject mode.
- `TargetTableGroup.tsx` — kebab menu grows a second item: "Reject all needs-review", with red text (`text-red-600 hover:bg-red-50`), separator above, same disabled contract as approve. Optional `onRejectAllClick` prop — legacy fixtures / storybook can opt out.
- `MappingContent.tsx` — `bulkAction` discriminated union extends with `'reject_table'`. New `handleRejectAllForTableClick` mirrors the approve handler shape (open dialog → fire `previewBulkReject` in the background → guard against stale resolves). Submit dispatches on `bulkAction.kind`. Toast copy distinguishes full success from partial success:
  - Full: `Rejected N mappings on <Table>.` (with `M transforms reset.` appended when `transformsReset > 0`)
  - Partial: `Rejected N of M mappings on <Table>; K could not be rejected (transform reset failed)` (toast variant is `info`, not `error`, since real progress was made — the dialog's red banner path is reserved for outright failure)

### `hasTransform` preview indicator

`previewBulkReject` runs an extra batched query (`SELECT target_field_mapping_id FROM transformations WHERE target_field_mapping_id IN (...)`) against the first 5 preview TFMs and threads `hasTransform: boolean` onto each preview row. The dialog renders a subdued amber `transform` badge next to those rows so users see at a glance which mappings will trigger a transform-reset side effect before they confirm. The flag is only computed for the preview slice (cap-of-5) — the wrapper itself doesn't need a pre-pass since `resetFieldTransform` is no-op-safe for TFMs without a transformation row.

### Phase 4c is now complete

With 4c-2 shipped, both halves of W5 (bulk approve + bulk reject) are live on the redesigned Mapping page. The remaining Phase 4 work is the rolling Phase 5-Cleanup list (legacy code retirement, RLS hardening, docs consolidation).

## Phase 4-polish-1 — visual restoration (2026-04-26)

Phase 4-polish-1 is the first of three polish sub-phases that restore the legacy Mapping page's tighter, more scannable aesthetic on top of the redesign's structural foundation. This sub-phase is **visual-only** — no backend changes, no new wrappers, no migrations, no behavior changes to mutation paths. The redesign's data model, server actions, and feature-flag gating are all untouched.

The other two polish sub-phases ship separately:

- **4-polish-2** — group collapse/expand state with per-project `localStorage` keying, auto-expand-on-filter-match (founder Q3.x).
- **4-polish-3** — inline approve/reject affordances in the row's actions cell with full Heritage MCP smoke verification (founder Q10.1, Q12.2).

### Block A — row layout refactor (`FieldMappingRow.tsx`)

The row's CSS Grid template moves from a 6-column `[20px_2fr_2fr_5rem_4rem_1rem]` shape to a 7-column `[0.75rem_minmax(7rem,12rem)_minmax(8rem,14rem)_1fr_5rem_5rem_1rem]` shape, isolating the source table badge into its own column so it never pushes the field name and capping the source-field column so source table + source field sit together as a visual unit. Column ownership:

1. **Status dot** (0.75rem) — `StatusDot`, dot only, no text label. ARIA label preserved (`aria-label="status: <Status>"`).
2. **Source table badge** (`minmax(7rem, 12rem)`) — `SourceTableCell`. Single `TableBadge` for Rule 1, two `TableBadge`s side-by-side for Rule 3 (multi-table), an `EmDashCell` for VA / Rule 5 / Rule 6, an empty span for Rule 4 (3+ tables — the summary phrase lives in column 3 and the badge column is intentionally blank).
3. **Source field name(s)** (`minmax(8rem, 14rem)`) — `SourceFieldCell`. Rule 1: single name. Rule 2 (multi-source same table): comma-list. Rule 3 (multi-source cross-table): inline middle-dot list. Rule 4 (3+ tables): summary phrase. VA: "No source mapped". Rule 5 / Rule 6: `EmDashCell`. The cap (Refinement 4 / 2026-04-26) keeps the source-table badge and source-field name visually adjacent at wide viewports — without it, the spread between cols 2 and 3 broke the source-side / target-side mental grouping.
4. **Target field name** (`1fr`) — `TargetCell`. The legacy `AcknowledgedSubtitle` is dropped; acknowledged TFMs render an inline `(acknowledged)` suffix after the target name with the reason in a `title=` tooltip (founder Q6.1). Absorbs the bulk of the remaining horizontal space; whitespace between the source group (cols 2-3) and the target column conveys source→target flow without per-row arrows.
5. **Confidence** (5rem, right-aligned) — `ConfidenceCell` with the Block B color-grading (see below). Em-dash for null and acknowledged (founder Q6.2 — no number, no color).
6. **Actions cell** (5rem, right-aligned) — `ActionsCell`. Carries the existing transform indicator dot (relocated from its previous spot), positioned `justify-end`. The 4-polish-3 inline approve/reject buttons land here.
7. **Chevron** (1rem) — `ChevronSlot`, unchanged from Phase 3.

Vertical density compresses from `py-2.5` to `py-1.5` (founder Q1.3) — the legacy 32-row-per-screen feel returns without sacrificing tap target affordance because the chevron and (in 4-polish-3) inline action buttons live in their own end-aligned columns rather than competing with row chrome.

Cross-table truncation: `TableBadge` accepts an optional `maxWidth` prop that the `SourceTableCell` Rule 3 path threads through, applying `max-width: 6rem; text-overflow: ellipsis` plus a `title=` tooltip with the full table name. Single-badge rows (Rule 1) leave the prop unset and render at natural width — only the multi-badge cross-table case truncates.

### Block B — confidence color-grading (`lib/utils/confidence-format.ts`)

Two new threshold constants and a 3-band classifier ship without modifying the existing `CONFIDENCE_THRESHOLD_HIGH` (70) used by `ConfidencePill`:

- `CONFIDENCE_THRESHOLD_ROW_HIGH = 85`
- `CONFIDENCE_THRESHOLD_ROW_AMBER = 40`
- `classifyRowConfidence(c: number): 'high' | 'amber' | 'low'`

The classifier accepts confidence in either fraction (`0.92`) or percent (`92`) form; values >1 are treated as percent, otherwise scaled by 100. The two consumers — `ConfidenceCell` in the collapsed row and `ExpandedSourceList`'s per-source line — apply the same map:

- `'high'` → `text-green-600 font-medium` (size `text-[11px]`)
- `'amber'` → `text-amber-600` (size `text-[11px]`)
- `'low'` → `text-red-600` (size `text-[11px]`)

`ConfidencePill` (used by the Drawer header and the AI Suggest in-form pill) keeps its existing 70/50 thresholds — those are summary indicators in larger UI surfaces with a different visual budget. The row-level thresholds run hotter (85 / 40) because the row body is dense and the user is scanning hundreds of values; a tighter band makes the green rows pop and the red rows demand attention without needing per-row hover affordance.

A slightly heavier weight on the green band (`font-medium` vs. amber/low's `font-normal`, founder Q9.1) is the only typographic differentiation v1 ships — additional pairings (e.g. amber italic, low underline) are deferred until polish-3 lands and we can see how the inline action buttons interact with the row's visual rhythm.

**Refinement 3 (2026-04-26).** The number itself is de-emphasized in favor of the color-band signal: text size dropped from `text-xs` to `text-[11px]` (one custom step below the default Tailwind ladder) and high-band weight from `font-semibold` to `font-medium`. The row reads calmer and the digits sit in the secondary visual layer — color-band still carries the actionable signal, the number remains reference precision.

### Block C — header restoration (`MappingSummaryStrip.tsx`, `MappingContent.tsx`)

A new `MappingSummaryStrip.tsx` replaces both the experimental `WipBanner` (dropped per Q2.1) and the structural `CountersRow`. It renders a single horizontal strip directly below the page header with:

- **Breadcrumb** (left, behind a vertical divider): `<sourceSystem> → <targetSystem>`. Hidden entirely when EITHER side is null (founder Q2.2 — a one-sided breadcrumb is more confusing than no breadcrumb).
- **Always-visible chips** (right of breadcrumb): Total, Approved (green dot), Needs Review (amber dot), separated by middle-dot dividers.
- **Conditional chips**: Rejected (red dot, count > 0), Unmapped (slate-300 dot, count > 0). The slate-300 hue is shared with the unmapped + acknowledged status dots in the row body (founder Q7.2 unification).

Styling: white background, `border-b border-gray-100`, no shadow (founder Q2.3 — reads as a structural divider, not a floating bar). The strip is **non-sticky** (founder Q8.1) and scrolls away naturally when the user dives into the row body, leaving the (now sticky) `FilterRow` as the persistent toolbar.

`MappingContent.tsx` drops both the `<WipBanner />` import + render and the `<CountersRow />` import + render, mounting `<MappingSummaryStrip />` in their place and threading `projectInfo.sourceSystem` and `projectInfo.targetSystem` through (already on props — only the call site changes). The Phase 3 Gap 13 unmapped counter chip behavior is preserved by the strip's conditional Unmapped chip path; the `mapping-redesign-counters` test ID is retired and a regression guard test now asserts its absence.

### Block D — sticky filter row (`FilterRow.tsx`)

`FilterRow` becomes sticky at the top of the scroll container with `sticky top-0 z-10`. The negative horizontal margin (`-mx-6`) plus matching padding (`px-6`) extends the slate-50 background full-width inside its column container so the sticky bar reads as a unified toolbar rather than a floating pill. `border-b border-gray-100` matches the summary strip's bottom border for visual continuity once the strip scrolls past.

Group headers are intentionally NOT sticky in 4-polish-1 (founder Q8.2 — defer). The current 1-target-table-per-screen reading pattern doesn't demand them, and adding a second sticky layer would require careful z-index choreography that's better paired with the 4-polish-2 group collapse work.

### Block E — tests

Updated:

- `tests/components/field-mapping-row.test.tsx` — ~30 cases updated for the new column template, `StatusDot` (label-text → ARIA-label assertion), `target-acknowledged-suffix` `data-testid` (replacing `target-subtitle`), color-graded confidence assertions. New suites cover (a) the 3-band confidence classifier with boundary values, (b) a regex-based column-template invariant test that reads `FieldMappingRow.tsx` from disk and asserts the exact 7-column grid string + `py-1.5` density (mirroring the 4c-2 `.delete()` count guard pattern, founder Q10.2), (c) the `ActionsCell` shape and right-alignment, and (d) the split source columns (table badge in column 2, field name(s) in column 3) for VA / Rule 5/6 / Rule 4.
- `tests/components/mapping-redesign-content.test.tsx` — ~10 cases updated to query `mapping-summary-strip` instead of `mapping-redesign-counters`. Two new regression guard tests assert that `mapping-redesign-counters` and `mapping-redesign-placeholder` (the retired `WipBanner`) are NOT in the rendered DOM.

New:

- `tests/components/mapping-summary-strip.test.tsx` (~13 cases) — breadcrumb conditional render (both / null source / null target / both null), chip rendering and ordering, conditional Rejected/Unmapped chips, dot color assertions, Q2.3 styling invariants (white bg + slate-100 border + no shadow), and the per-component dark-prefix invariant.

The column-template invariant test is the structural equivalent of the 4c-2 `.delete()` count guard: a compile-time invariant that the source file has exactly the expected shape, raising before any visual review can catch it. Without it, an editor who reflows the grid string into a multi-line `cn()` call would silently break the layout.

### Block F — docs

This document gains the Phase 4-polish-1 section. `docs/features/phase-4-plan.md` gains a sub-phase row in the implementation status table and a header status update.

### What's deliberately NOT in 4-polish-1

- **Inline approve / reject buttons in the actions cell.** The actions cell ships in 4-polish-1 as a structural slot (currently holding only the transform dot) so 4-polish-3 can drop the buttons in without touching the grid template. The buttons ship behind the full Heritage MCP smoke gate (founder Q10.1, Q12.2).
- **Group collapse/expand state.** The current per-target-table groups remain always-expanded. 4-polish-2 ships per-project `localStorage` keying with auto-expand on filter match (founder Q3.x).
- **Reject popover, deep-link to drawer for un-acknowledge, source swap toast.** All three are 4-polish-3 (founder Q5.1, Q5.2, Q4.1) — they require either backend behavior the polish-1 quality gate forbids or UI surfaces (popover machinery) that pair more naturally with the inline-action work.
- **Sticky group headers.** Deferred (Q8.2) — see Block D.

### Quality gates exercised

- `tsc --noEmit` clean (no new types fight existing ones; the `RowConfidenceBand` union ships pure-additively).
- `vitest run --exclude='tests/integration/**'` green at the polish-1 commit.
- `npm run build` green.
- All grep invariants pass: no `dark:` modifiers under the redesign path, no client-side `.sort()` in redesign components, no legacy mappings imports under the redesign UI.
- No backend changes — no migrations, no new wrappers, no RPC changes. The wrapper count and the migration count both stay flat from 4c-2 to 4-polish-1.

### Refinements (2026-04-26 — bundled into the same commit)

After the initial Phase 4-polish-1 visual review, four refinements landed on top of the same uncommitted changeset before commit. All four are visual-only; no test count regression, no new wrappers, no new dependencies.

1. **Smaller status dots.** `StatusDot` shrunk from `h-2 w-2` (8px) to `h-1.5 w-1.5` (6px). The 0.75rem (12px) grid column is unchanged so the dot still centers cleanly. The label was already gone in the Phase 4-polish-1 baseline; the larger dot read as visual noise without it. ARIA label preserved verbatim.
2. **Transform indicator polish.** The col-6 `TransformationIndicator` unifies all status colors to `bg-slate-400` (was `bg-green-500` for applied, `bg-red-500` for stale, `bg-amber-400` for draft / tested / saved). Size pinned at `h-1.5 w-1.5` to match the new status-dot rhythm. The `title=` tooltip stays dynamic ("Transformation applied" / "Transformation stale" / etc.) so power users keep the per-status detail one hover away; the dot itself drops the saturated semantic color to read as "subtle marker, not feature highlight". `TRANSFORM_INDICATOR_CONFIG` retains the `className` field for future use by other surfaces (e.g., the drawer header) — the row indicator deliberately ignores it.
3. **Smaller, lighter confidence text.** `ConfidenceCell` text dropped from `text-xs` (12px) to `text-[11px]` (one custom step below the default Tailwind ladder) and high-band weight from `font-semibold` to `font-medium`. The high band's color-plus-weight Q9.1 second channel for color-blind users is preserved (medium > amber/low's normal); the row reads calmer overall. Em-dash for null / acknowledged stays neutral via `EmDashCell`.
4. **Tighter source group via constrained col 3.** Grid template col 3 changed from `1fr` to `minmax(8rem, 14rem)` — the source-table badge (col 2, 7-12rem) and source-field name (col 3, now 8-14rem) sit together as one visual unit; the target column (col 4) absorbs the freed flex. The visual result reads `[dot] [SRC_TABLE src_field]   →   [target]   [conf]   [actions]` — whitespace between the source group and the target conveys flow without per-row arrows. The column-template invariant test was re-anchored on the new template literal at the same time (founder Q10.2 — the regex guard pattern is unchanged in shape, only the expected literal moved).



Items to remove during Phase 5-Cleanup:

### Code deletions

- `UnmappedView` component (`app/app/projects/[projectId]/mapping/MappingContent.tsx:2488`) — unreferenced inline function; removed with `MappingContent.tsx` in Gap 13 (Phase 5-Cleanup). A 2026-04-24 investigation (Gap 12) confirmed it is **inline**, not a standalone file, so it cannot be deleted independently of the shim — Gap 12 closed as a no-op.
- `UnmappedTargetIndicator` component (same file, line 2482) — stub returning null; same story as above (inline; removed with `MappingContent.tsx` in Gap 13).
- `InlineAddFieldRow` component (same file, line 523) — replaced by drawer Source tab; also inline, removed with `MappingContent.tsx` in Gap 13.
- `lib/compat/mapping-shim.ts` — no longer needed after Phase 3 UI reads new model directly
- `SUPPRESS_MULTI_TARGET_KEY` and `SUPPRESS_MULTI_TARGET_KEY_LEGACY` localStorage keys (lines 518-519) — orphaned after `InlineAddFieldRow` retires

### Database cleanup

- `projects.use_mapping_redesign` column — dropped after all projects stable on new UI for 30+ days
- `projects.maintenance_mode` column — dropped after migration window confirmed complete
- `fm_to_tfm_map` temp table — dropped automatically at end of migration transaction

### URL parameter compatibility

- Transform page reads both `?fieldMappingId=` (old) and `?targetFieldMappingId=` (new) during Phase 3+4. Old param support removed in Phase 5-Cleanup after 30+ days of new URL usage.

### Migration file blocklist updates

The following migrations contain user-SQL safety blocklists that should be extended to include `target_field_mappings|mapping_sources` defensively:

- `supabase/migrations/006_data_quality.sql:339`
- `supabase/migrations/011_transform_test_rpc.sql:37`
- `supabase/migrations/014_transform_apply.sql:123`
- `supabase/migrations/019_transform_full_test_rpc.sql:41`
- `supabase/migrations/026_execute_data_fix_allow_cte.sql:43`
- `supabase/migrations/035_transform_preview_multi_field.sql:51`
- `supabase/migrations/040_transform_test_multi_field.sql:38`
- `supabase/migrations/043_null_safe_apply_and_window_guard.sql:147`
- `supabase/migrations/061_fix_distinct_preview_groupby.sql:48`

These are low-severity — current regex uses word boundaries so `target_field_mappings` doesn't accidentally match `field_mappings`. Update as part of migration 073 or as a separate defensive-pass migration 074.

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

## Feature flag infrastructure

A per-project feature flag gates both the migration deployment safety and the redesigned UI rollout. Single flag serves three purposes:

### Schema

Add column to existing `projects` table:

```sql
ALTER TABLE public.projects 
  ADD COLUMN use_mapping_redesign BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_projects_use_mapping_redesign 
  ON projects(use_mapping_redesign) 
  WHERE use_mapping_redesign = true;
```

Partial index is optimized for the common case (most projects off, few on during canary).

### Three uses of the flag

**Use 1: Deployment write-block.** During the migration window, all mapping write-path server actions check `projects.use_mapping_redesign = false` AND return a maintenance-mode error. After migration completes and backend is deployed, flag remains `false` (no change to user experience; old UI on new backend via shim).

**Use 2: UI redesign rollout.** When flag flips to `true` for a project, that project's users see the redesigned mapping page. Flag off: users see the shimmed old UI on the new backend.

**Use 3: Cross-table gating.** Cross-table mapping generation and authoring are disabled when flag is `false`. This prevents the shim from ever encountering cross-table mappings it cannot render correctly. When flag flips to `true`, the new UI can render cross-table; when flag is `false`, AI generation proposes same-table mappings only.

### Client access pattern

```ts
// lib/hooks/useMappingRedesignEnabled.ts
export function useMappingRedesignEnabled(projectInfo: ProjectInfo): boolean {
  return projectInfo.use_mapping_redesign === true
}
```

Flag propagates from `projects` row through `getProject` server action into `ProjectInfo` already passed as prop to client components. No separate fetch needed.

### Server-side check

Write-path server actions include a guard:

```ts
async function assertMappingWritesEnabled(projectId: string) {
  const { data } = await supabase
    .from('projects')
    .select('use_mapping_redesign, maintenance_mode')
    .eq('id', projectId)
    .single()
  if (data?.maintenance_mode) {
    throw new Error('Mapping writes are temporarily disabled for scheduled maintenance')
  }
}
```

(Note: `maintenance_mode` is a separate transient column for the deployment window; distinct from `use_mapping_redesign` which is the redesign toggle.)

### Canary rollout sequence

1. Migration runs with `maintenance_mode=true` on all projects; `use_mapping_redesign=false`
2. Backend deploys; `maintenance_mode` flipped to `false`
3. Old UI continues to work via shim
4. Heritage Core project: `use_mapping_redesign=true` manually
5. 72-hour observation period
6. Remaining projects enabled in batches of 10
7. After all projects enabled and stable, flag column can eventually be dropped (post-cleanup)

## Platform scope

**Supported**: desktop browsers at viewport width ≥1024px.

**Not supported for v1**: mobile and tablet viewports (<1024px). A static banner appears below 1024px width directing users to use a desktop browser. No mobile-responsive layouts are shipped.

**Rationale**: Settle is a data engineering tool used during structured migration work. Users are engineers, data migration specialists, or project managers operating on laptops or larger displays. Mobile access is not a validated use case and adding responsive layouts would add several days to Phase 3 implementation for speculative value.

**Future consideration**: if a pilot customer demonstrates a mobile use case (e.g., a manager reviewing mappings during a standup), responsive layouts become a v2 scope item.

## Accessibility scope

Phase 3 ships with minimum baseline accessibility. Comprehensive WCAG AA compliance is deferred to a later sprint, scoped when a pilot customer's procurement review requires it.

### Minimum baseline (Phase 3 required scope)

- `aria-label` on every icon-only button (close buttons, chevrons, overflow menus, status indicators)
- `aria-labelledby` on drawer and modal containers
- Screen-reader text (`sr-only` span) accompanying status dots explaining the status ("Approved", "Needs Review", "Rejected")
- `:focus-visible` ring styling on all interactive elements using a consistent focus indicator
- Semantic HTML: `<button>` for actions, `<nav>` where appropriate, `<table>` or `role="grid"` considered for the mapping list
- Escape key closes drawers and modals (already works via `FixDrawer` — preserve)

### Deferred to post-Phase 4 A11y sprint

- Focus trap inside drawer (Tab key cycles within drawer, not page behind)
- Keyboard navigation between rows (j/k, arrow keys)
- Comprehensive screen reader testing across JAWS, NVDA, VoiceOver
- Color contrast audit and remediation
- Full ARIA live region support for toast notifications
- Reduced motion support (`prefers-reduced-motion`)

### Testing approach

No automated A11y testing in Phase 3. Manual smoke test of keyboard navigation (Tab through page, Escape closes drawer, focus ring visible) as part of QA pass.

Future: add `@axe-core/react` or equivalent to CI for automated regression detection once Vitest harness is established.

## Keyboard shortcuts

**v1 scope**: no new keyboard shortcuts beyond what exists today (Escape closes drawer and pickers). Net-new keyboard navigation patterns are deferred.

**Existing shortcuts preserved**:

- Escape closes drawer (`FixDrawer`)
- Escape closes `FieldPicker` and `TableFieldFilter` portals
- Tab navigates interactive elements in default DOM order

**Deferred to v2** (documented but not implemented):

- `/` to focus search input
- `j`/`k` or arrow keys to navigate between rows
- `a` to approve selected row, `r` to reject
- `e` to expand/collapse selected row
- `o` or Enter to open drawer for selected row

These are nice-to-haves that enterprise users may eventually request. Deferred to keep Phase 3 scope focused on core redesign.

## Virtualization

**Decision**: defer. Render via naive `.map()` in Phase 3.

**Rationale**: current production projects have manageable row counts:

- Heritage Core: 19 fields per target table (116 total)
- Rootstock-scale estimate: ~30 tables × ~30 fields = 900 rows (spread across tables)

Virtualization adds complexity (library integration, scroll-position state management, focus restoration during scroll) and risks introducing bugs in a Phase 3 that's already touching a large surface.

**Trigger for revisiting**: if profiling shows a measurable rendering problem — expanded target table with 100+ fields taking >200ms to render, or noticeable scroll jank — add `@tanstack/react-virtual` scoped to the expanded body of `TableMappingCard` only. No whole-page virtualization.

**Measurement approach**: add React DevTools Profiler measurements on the canary project during Phase 3 QA. If render times are acceptable, skip virtualization. If not, add as a focused follow-up.

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

## Open questions — resolved

All implementation open questions resolved via Investigation 1 and 2:

| Question | Resolution |
|---|---|
| Source-side acknowledgments | Separate `source_field_acknowledgments` table (D-1) |
| Value assignments | Zero-source `target_field_mappings` with `custom_sql` combination (D-2) |
| Deployment strategy | Scheduled downtime window, 24h notice (D-3) |
| Test harness | Vitest + 2 days setup + integration tests in Phase 2 (D-4) |
| LLM prompt transition | Atomic flip, no dual-format period (D-5) |
| Canary project | Heritage Core → Nymbus Core first (D-6) |
| `transformations.field_mapping_id` rename | Atomic in-place rename via add-backfill-drop pattern (D-7) |
| Feature flag mechanism | Per-project boolean `projects.use_mapping_redesign` |
| Mobile responsiveness | Desktop-only for v1 (≥1024px) |
| Virtualization | Defer, profile-first if needed |
| Keyboard shortcuts | Defer to v2, Escape preserved |
| Accessibility scope | Minimum baseline in Phase 3, comprehensive deferred |
| Badge styling | Monochrome `<TableBadge>` primitive; border + `bg-white` + slate text |
| Confidence scoring | Per-source stored, target-level derived as `min(sources)` for mapped targets, stored directly for value assignments |
| LLM output format | Per-source confidences only on mapped targets; top-level confidence on value assignments only |
| Cross-table during shim period | Gated behind feature flag; shim never encounters cross-table |
| Remove Mapping location | Three-dot overflow menu next to footer buttons |
| Transform page URL param | Read both old and new during transition; write new only |

No outstanding open questions. Implementation can proceed.

## Non-goals

Explicit out-of-scope items for v1:

- Multi-hop joins (A → B → C)
- Transposition/pivot operations
- Aggregations across source rows (GROUP BY semantics)
- Conditional source selection (if X then source A else source B)
- Automatic relationship inference beyond existing FK pipeline
- Per-row source field metadata on the main page (lives in drawer)

These are candidate v2 features but not part of this redesign.