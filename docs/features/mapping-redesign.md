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
  source_field_id UUID NOT NULL 
    REFERENCES fields(id) ON DELETE CASCADE,
  source_table_id UUID NOT NULL 
    REFERENCES tables(id) ON DELETE CASCADE,
  
  -- Per-source metadata
  confidence NUMERIC(5,2),
  ai_reasoning TEXT,
  similar_fields_considered JSONB,
  type_compatibility TEXT,
  
  -- Join specification (NULL when source is from the dominant table)
  join_spec JSONB,
  -- Shape when non-null:
  -- { "via_source_table_id": UUID,
  --   "via_fk_field_id": UUID,
  --   "to_fk_field_id": UUID }
  
  -- Ordinal for predictable concatenation order
  ordinal INTEGER NOT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Each source field can contribute to a given target only once
  UNIQUE (target_field_mapping_id, source_field_id)
);

CREATE INDEX idx_mapping_sources_target_field_mapping_id 
  ON mapping_sources(target_field_mapping_id);
CREATE INDEX idx_mapping_sources_source_field_id 
  ON mapping_sources(source_field_id);
CREATE INDEX idx_mapping_sources_source_table_id 
  ON mapping_sources(source_table_id);
```

### Tables that remain

- `tables` — unchanged
- `fields` — unchanged (FK inference from migration 063 still applies)
- `table_mappings` — **preserved for navigation metadata but no longer structural**. Continues to exist as optional grouping data. Field mappings no longer reference it.
- `transformations` — updated to reference `target_field_mapping_id` instead of `field_mapping_id`
- `field_profiles`, `data_rows`, `staged_data_rows`, `schema_documents`, `outputs` — unchanged

### Tables that are removed or superseded

- `field_mappings` — replaced by `target_field_mappings` + `mapping_sources`. Data migrated.
- `field_acknowledgments` — replaced by `target_field_mappings.is_acknowledged` flag. Data migrated.

### Data migration

For each project, transform existing rows:

**Step 1**: For each unique `target_field_id` in `field_mappings` (scoped by project), create one `target_field_mappings` row:
- `confidence`: take from the `is_contributing = false` row (the canonical primary)
- `status`: take from the canonical primary
- `ai_reasoning`: take from the canonical primary
- `combination_type`: derive from existing transformation SQL
  - Single source and no transformation → `'single'`
  - `CONCAT(...)` or `||` with spaces → `'concat_space'`
  - `CONCAT_WS(',', ...)` → `'concat_comma'`
  - Anything else → `'custom_sql'` with `combination_sql` copied from `transformations.generated_sql`

**Step 2**: For each original `field_mappings` row (regardless of `is_contributing` flag), create one `mapping_sources` row under the corresponding `target_field_mappings` parent:
- Preserve `source_field_id`
- Derive `source_table_id` from the source field's parent table
- Copy `confidence`, `ai_reasoning`, `similar_fields_considered`, `type_compatibility`
- `join_spec`: NULL (legacy data has no cross-table joins)
- `ordinal`: sequential within a parent, starting from 0, ordered by `created_at` of the original row

**Step 3**: For each row in `field_acknowledgments`, create a `target_field_mappings` row with `is_acknowledged = TRUE` and appropriate `acknowledgment_reason`. No `mapping_sources` rows.

**Step 4**: Update `transformations.field_mapping_id` to reference `target_field_mappings.id` (rename column to `target_field_mapping_id`).

**Step 5**: After verification, drop `field_mappings` and `field_acknowledgments` tables.

**Migration executes as a single transaction** where possible. If data volume requires batching, wrap each project's migration in its own transaction.

### Server action impact

Files that reference `field_mappings` will need rewriting. Non-exhaustive list based on prior investigation:

- `lib/actions/mappings.ts` — entire file rewrites against the new model
- `lib/actions/transformations.ts` — update FK reference, adapt to read source config from `mapping_sources`
- `lib/actions/fk-cascade.ts` — update to operate on `target_field_mappings`
- `lib/actions/execution-package.ts` — SQL generation must handle joins
- `lib/actions/outputs.ts` — SQL generation must handle joins
- `lib/ai/context-builder.ts` — may need updates if prompt context changes

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

This feature will be implemented in four phases. Each ships as a separate commit or set of commits.

### Phase 1: Data model + migration

- New tables: `target_field_mappings`, `mapping_sources`
- Data migration from `field_mappings` + `field_acknowledgments`
- Update `transformations` table FK references
- Drop old tables after verification

Estimated effort: 2-3 days. High risk due to data migration.

### Phase 2: Server actions + SQL generation

- Rewrite `lib/actions/mappings.ts` against new model
- Update `lib/actions/transformations.ts`, `lib/actions/fk-cascade.ts`, etc.
- SQL generation handles joins for cross-table mappings
- LLM prompt updated for cross-table awareness

Estimated effort: 3-5 days. Medium risk; extensive testing needed.

### Phase 3: UI redesign

- Filter row changes (Target, Source, Status; remove Type)
- Row layout changes (badges, annotations, chevron)
- Expanded view
- Drawer redesign (three tabs, persistent footer)

Estimated effort: 3-5 days. Lower risk; UI work with clear spec.

### Phase 4: Cross-table authoring in drawer Source tab

- Progressive disclosure field picker
- Cross-table detection and join config
- Combination options
- Live preview

Estimated effort: 2-3 days. Lower risk.

Total estimated effort: 10-16 days of focused work.

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