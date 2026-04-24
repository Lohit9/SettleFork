# Phase 3 Gap 4a — Mapping redesign read path (design)

**Status**: Approved 2026-04-22 — locked, awaiting Gap 4b implementation.
**Owner**: Kaan Dincer
**Created**: 2026-04-21
**Last updated**: 2026-04-22 (founder resolutions + 3 amendments; see §9 decision log)
**Supersedes**: N/A (new document)
**Canonical spec**: [docs/features/mapping-redesign.md](./mapping-redesign.md)
**Implementation target**: Phase 3 Gap 4b (separate prompt)

---

## 1. Scope summary

This document locks the **server → client data contract** for the redesigned
Mapping page (`/app/projects/[projectId]/mapping` when
`projects.use_mapping_redesign = true`). It defines exactly what the new
server action `getMappingsForRedesign(projectId)` returns, how it queries
the database, where filter state is computed, how edge cases are surfaced,
and how this read path coexists with and eventually replaces the legacy
`getMappings` + `lib/compat/mapping-shim.ts` pair.

No implementation code lands in this gap. Gap 4b implements the contract
specified here.

### What this gap is (the deliverables)

1. A TypeScript return type for `getMappingsForRedesign` that supports every
   rendering rule in [mapping-redesign.md §Row design](./mapping-redesign.md#row-design),
   every filter/search behavior in [§Filter behavior](./mapping-redesign.md#filter-behavior),
   and every edge case in [§Edge cases](./mapping-redesign.md#edge-cases).
2. A query plan (Supabase client calls + round-trip count + payload
   estimate) proven out against the Heritage Core volumes.
3. A concrete recommendation on server-side vs client-side filter
   computation, justified for Heritage and for 10k+ target-field
   enterprise workloads.
4. An itemized migration + deprecation strategy so Gap 4b can ship without
   regressing the shim-backed legacy UI.

### What this gap is NOT

- Not the write path. Target-field mutation continues to flow through the
  existing `mappings.ts` write actions (`approveTargetFieldMapping`,
  `editTargetFieldMapping`, etc.) with their current signatures. Phase 5
  cleanup will simplify them to bare-UUID, but that is out of scope here.
- Not the Transform page's data feed. Gap 4a deliberately excludes
  transformation SQL, test results, staging preview, and any editor
  state — those remain scoped to the Transform page's own read path
  (`getTransformData`) per the locked founder decision on the slim
  drawer Transform tab.
- Not drawer modal state, pickers, or any client-side types. Those are
  owned by Gap 4b / Gap 5 (drawer redesign).
- Not UI styling, component layout, or CSS primitives.

---

## 2. Founder decision recap

The following decisions are already locked and are baked into this
contract. They are not reopened here.

1. **URL filter param scheme**:
   `?target=<table-id>&source=<table-id>&status=<value>&q=<search>`.
   Supersedes the legacy `?fields=` and `?type=` vocabulary.
2. **No back-compat for legacy filter params**. The redesign hard-resets
   filter state on first load; users landing from bookmarked legacy URLs
   see the default unfiltered view. See Gap 3's placeholder file header
   comment for the rationale.
3. **Slim drawer Transform tab**. Heavy transform editing stays on the
   standalone Transform page. Implication: this read path does NOT fetch
   `transformations.generated_sql`, test_results, or any staging
   preview payloads.
4. **Value assignments render identically to mapped rows**. No dedicated
   Rule 7, no purple branch. Source column shows a "No source mapped"
   indicator (exact visual TBD in Gap 4b). Confidence is displayed on
   the main row.
5. **VA confidence is displayed on the main row**, same as any other row.
   Value comes directly from `target_field_mappings.confidence` (not
   derived via MIN — the trigger in migration 074 skips
   `combination_type = 'custom_sql'` rows per
   [spec §Confidence semantics](./mapping-redesign.md#confidence-semantics)).

---

## 3. Data contract proposal

### 3.1 Design calls made in this section

Four non-obvious shape questions came up while drafting. Each is
resolved explicitly below so Gap 4b does not re-debate them.

**Call A — Unit of iteration.**
The redesign iterates **target fields**, not table_mappings. The legacy
`RichTableMapping { fieldMappings: RichFieldMapping[] }` tree does not
survive; groups are keyed by `target_table_id` directly and each row
corresponds to exactly one `target_field_mappings` row (or to an
unmapped target field — see Call D below).

**Call B — VA discriminator.**
Include a `kind: 'mapped' | 'value_assignment' | 'target_acknowledged' |
'unmapped'` discriminator on every row. Derived once server-side.

Rationale: per the founder decision, VAs and mapped rows RENDER
identically, but they DIFFER in downstream logic sites that the new UI
must handle:
- Source filter (`?source=<id>`) excludes VAs when a specific source is
  selected (VAs have no source table membership).
- Source-field search (`?q=...`) never matches a VA (no source field name).
- Counter pills treat VAs as Total/Approved/Needs Review (same as mapped).
- Acknowledgment-alternative footer on the drawer Source tab is shown only
  for mapped rows and VAs, not for acknowledgments.
- Unmapped rows (Rule 6) synthesize from target fields with no TFM and
  have no `target_field_mappings.id` — they cannot be represented by a
  derive-at-read-site predicate alone.

A flag paid for once is cheaper and less fragile than four independent
predicates sprinkled across the UI. The [shim's implementation](../../lib/compat/mapping-shim.ts:531)
already pays this cost — it special-cases `combination_type === 'custom_sql'`
at multiple branch points. Moving this to a tagged union server-side
prevents the same sprawl in the new UI.

**Call C — Composite IDs.**
Rows carry bare UUIDs.
- Mapped / VA / target-acknowledged row `id` = `target_field_mappings.id`.
- Unmapped row `id` = synthetic `unmapped::<target_field_id>` sentinel (not a
  UUID; the UI must not persist or send it to write actions — unmapped
  rows have no TFM yet, so they are a pure client concept).

No `tfmId::mappingSourceId` composites. Per-source lines in the expanded
view and drawer Source tab use `mapping_sources.id` directly. This
deletes `SHIMMED_ID_SEPARATOR`, `encodeContributorRowId`, `encodeTargetAckRowId`,
`encodeSourceAckRowId`, and `decodeShimmedRowId` in Phase 5 cleanup.

**Call D — Unmapped target fields.**
Include unmapped target fields as first-class rows in the same
`rows: MappingRow[]` list, distinguished by `kind: 'unmapped'`. A
separate `unmappedTargetFields` side-channel (as in legacy
`MappingsResult`) would force the UI to merge two streams before
grouping, filtering, and counting. One stream, one discriminator.

### 3.2 Full TypeScript interface

```ts
// ────────────────────────────────────────────────────────────────────
// getMappingsForRedesign — return type (Gap 4a contract)
// ────────────────────────────────────────────────────────────────────

/**
 * Top-level return of `getMappingsForRedesign(projectId)`. All data
 * needed to render the Phase 3 Mapping page comes from this shape —
 * no secondary fetches during render, no client-side joins against
 * the DB. Counter pills, filter dropdowns, group headers, row
 * rendering, and empty-state decisions are all derivable from this
 * object alone.
 *
 * Not returned when access is denied or the project does not exist —
 * callers receive `null` and should fall back to `notFound()`.
 */
export interface MappingsForRedesignResult {
  /**
   * Project ID echo. Useful for double-checking RSC round-trips and
   * for downstream filter components that key state by project.
   */
  projectId: string

  /**
   * Every target field in the project, one row per field.
   *
   * ORDERING — server-guaranteed contract (DO NOT re-sort on the client).
   * ─────────────────────────────────────────────────────────────────────
   * Rows are emitted in a deterministic order keyed by:
   *
   *   ORDER BY
   *     targetTable.name         ASC,  -- group scan order
   *     targetField.ordinalPosition ASC,  -- DDL order inside a group
   *     targetField.name         ASC   -- tiebreak for synthetic
   *                                    --  fields w/ identical ordinals
   *
   * This matches the canonical target-schema browse order the user
   * already sees in Data Staging. Consumers (Gap 4b UI, drawer deep-
   * links, test fixtures) MUST NOT re-sort. Filter pipelines and
   * `groupBy(targetField.targetTable.id)` preserve order, so rendering
   * can rely on row index stability across filter changes.
   *
   * Rationale for server-side ordering: (a) the sort depends on
   * server-only context (`ordinalPosition` from `fields`), (b) stable
   * ordering lets clients keep `useMemo`-keyed group arrays referentially
   * stable across re-renders, (c) test fixtures can assert on exact
   * row order without re-sorting boilerplate.
   *
   * A row exists for EVERY target field, even those without a TFM
   * (those appear as `kind: 'unmapped'`). The client groups by
   * `targetTable.id` for rendering; the server emits a flat list so
   * filter pipelines (search, status, source, target) can apply
   * uniformly without re-bucketing.
   *
   * See §9 Q7 resolution (2026-04-22) for the decision log.
   */
  rows: MappingRow[]

  /**
   * Universe of target tables for the Target filter dropdown and
   * for group-header rendering. Includes every target-role-dataset
   * table, whether or not it has any TFMs yet — matches the spec's
   * "empty state shows target schema with all rows unmapped"
   * behavior in §Edge cases.
   */
  targetTables: TargetTableSummary[]

  /**
   * Universe of source tables for the Source filter dropdown.
   * Includes every source-role-dataset table, whether or not any
   * TFM's mapping_sources reference it. A source table with zero
   * incoming mappings is still filterable — selecting it simply
   * yields zero rows (+ "no matches" empty state).
   */
  sourceTables: SourceTableSummary[]

  /**
   * IDs of source fields the user has explicitly acknowledged as
   * not-to-be-migrated. Used by the Source tab's unmapped-source
   * guidance and by future source-side coverage displays. Not tied
   * to any row in `rows` — source-side acks live on source fields,
   * not on target fields.
   *
   * Shape is deliberately minimal (just the field_id + reason). The
   * full acknowledgment row is retrievable on demand via a dedicated
   * server action if the drawer ever surfaces source-ack editing.
   */
  sourceFieldAcknowledgments: SourceFieldAcknowledgmentSummary[]

  /**
   * Pre-computed counter-pill values across all rows, server-side.
   * Client-side filtering does NOT recompute these — they are the
   * PROJECT-level totals visible at the top of the page header
   * (`Total 116 · Approved 116 · Needs Review 0` in the spec
   * mock-up at mapping-redesign.md:646). The per-group
   * "3 of 19 fields match" indicator is computed client-side over
   * the filtered slice of `rows`; see §5 for the split.
   */
  counts: MappingCounts

  /**
   * Absent only when the project has no target schema ingested at
   * all (§Edge cases line 1167). Drives the empty-state banner
   * in the main viewport.
   */
  targetSchemaEmpty: boolean
}

// ── Row shapes ──────────────────────────────────────────────────────

/**
 * Discriminated union over the four row shapes the Mapping UI
 * renders. Derived once server-side from TFM state; the UI pattern-
 * matches on `kind`.
 */
export type MappingRow =
  | MappedRow
  | ValueAssignmentRow
  | TargetAcknowledgedRow
  | UnmappedRow

/** Common fields present on every row shape — split out for clarity. */
interface MappingRowBase {
  /**
   * Stable rendering key.
   *   mapped / value_assignment / target_acknowledged → target_field_mappings.id
   *   unmapped                                        → `unmapped::<target_field_id>`
   *
   * The unmapped sentinel is NEVER sent to a write action. Server
   * actions that accept an id MUST reject the `unmapped::` prefix
   * and require the UI to call the explicit create-TFM path first.
   */
  id: string

  /**
   * Target field — the identity that drives every row. Replaces the
   * legacy `RichFieldMapping.targetField` shape with a richer view
   * that carries enough metadata for the drawer header:
   *   "target_field_name  VARCHAR(200) · in accounts · required"
   * (§Drawer header lines 884-889).
   */
  targetField: TargetFieldRef

  /** Target-level confidence. NULL for unmapped/acknowledged. */
  confidence: number | null

  /**
   * Approval state as stored on target_field_mappings.status. For
   * `kind: 'unmapped'` rows (no TFM), this is the sentinel `'unmapped'`.
   */
  status: 'needs_review' | 'approved' | 'rejected' | 'unmapped'

  /**
   * Whether a transformations row exists for this TFM. Drives the
   * small "has transform" indicator per §1509 of the spec. The
   * transform SQL itself is NOT included — editing lives on the
   * standalone Transform page (founder decision 3 above).
   *
   * False for `kind: 'unmapped'` and `kind: 'target_acknowledged'`
   * (no TFM or an ack-only TFM — neither can carry a transformation).
   */
  hasTransformation: boolean

  /**
   * Transformation status (`draft` / `tested` / `saved` / `applied` /
   * `stale`) when `hasTransformation = true`, else null. Allows the
   * UI to surface a muted `✓ applied` vs `⚠ stale` vs `✎ draft`
   * indicator without an extra round-trip. Read-only view only — does
   * not include the SQL string or test results.
   */
  transformationStatus:
    | 'draft' | 'tested' | 'saved' | 'applied' | 'stale' | null
}

/** Mapped row — 1+ mapping_sources, not acknowledged. Rules 1-4. */
export interface MappedRow extends MappingRowBase {
  kind: 'mapped'
  /**
   * Status here is the TFM's own status, narrowed — unmapped is
   * impossible for a mapped row.
   */
  status: 'needs_review' | 'approved' | 'rejected'

  /**
   * All contributing sources, sorted by `ordinal` ASC (0 first).
   * The UI's rule selector inspects this array:
   *   1 source, single table     → Rule 1
   *   2+ sources, single table   → Rule 2
   *   2+ sources, 2 tables       → Rule 3
   *   3+ tables OR >5 fields     → Rule 4
   */
  sources: MappingSourceRef[]

  /**
   * The combination strategy as stored on target_field_mappings.
   * Included for the drawer Details and Source tabs; the main row
   * does not render it directly.
   *   single       → Rule 1
   *   concat_space → joined with space
   *   concat_comma → joined with comma
   *   custom_sql   → user-supplied SQL for combining sources
   *                  (distinct from zero-source VA — see
   *                  `ValueAssignmentRow`)
   *
   * ENUM EVIDENCE — pinned to migration 074 CHECK constraint as of
   * 2026-04-22. Source:
   * [supabase/migrations/074_mapping_redesign_data_migration.sql:156-157](../../supabase/migrations/074_mapping_redesign_data_migration.sql#L156-L157)
   *
   *   combination_type TEXT
   *     CHECK (combination_type IN ('single', 'concat_space',
   *                                 'concat_comma', 'custom_sql')),
   *
   * The DDL also allows `NULL` (for `is_acknowledged=true` rows —
   * see `TargetAcknowledgedRow` which carries no `combinationType`
   * field). If a future migration widens or narrows this set, update
   * this union, the ValueAssignmentRow constant, and the CHECK at
   * the same time — single source of truth.
   */
  combinationType: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql'

  /**
   * Present only when combinationType='custom_sql' AND this is a
   * multi-source row (not a VA). NULL otherwise. The Source tab
   * surfaces this in its combination selector.
   */
  combinationSql: string | null

  /**
   * AI reasoning text for the TFM overall (drawer Details tab,
   * collapsible). Per-source reasoning lives on `MappingSourceRef`.
   */
  aiReasoning: string | null
}

/** Value assignment — zero sources, not acknowledged, custom_sql. */
export interface ValueAssignmentRow extends MappingRowBase {
  kind: 'value_assignment'
  status: 'needs_review' | 'approved' | 'rejected'

  /**
   * Always 'custom_sql' by DB check constraint (migration 074
   * ckc_tfm_shape). Kept typed as a constant for downstream
   * exhaustiveness checks.
   */
  combinationType: 'custom_sql'

  /**
   * The VA expression as stored on target_field_mappings.
   * combination_sql. Nullable during the brief lifecycle window
   * between createValueAssignment (which writes NULL) and the
   * user authoring SQL on the Transform tab — see
   * [mapping-shim.ts:532-546](../../lib/compat/mapping-shim.ts#L532-L546)
   * for the historical note.
   */
  combinationSql: string | null

  /**
   * AI reasoning for the VA as a whole. No per-source reasoning
   * exists (no sources).
   */
  aiReasoning: string | null
}

/** Target-side acknowledgment. is_acknowledged=true, zero sources. */
export interface TargetAcknowledgedRow extends MappingRowBase {
  kind: 'target_acknowledged'
  status: 'approved' // Migration 074 STEP 3c writes 'approved' for all ack rows.
  confidence: null
  hasTransformation: false
  transformationStatus: null

  /** The reason the user (or AI) gave for acknowledging. */
  acknowledgmentReason: string | null
}

/** Target field with no TFM. Synthesized row for Rule 6. */
export interface UnmappedRow extends MappingRowBase {
  kind: 'unmapped'
  status: 'unmapped'
  confidence: null
  hasTransformation: false
  transformationStatus: null
}

// ── Nested reference shapes ─────────────────────────────────────────

/**
 * Enough target-field metadata for row rendering AND drawer header
 * without a second lookup. All fields are DB-sourced.
 */
export interface TargetFieldRef {
  id: string
  name: string
  dataType: string
  /** True iff the column is declared NULL-able. */
  isNullable: boolean
  /** Raw DDL DEFAULT expression, null when not declared. */
  defaultValue: string | null
  /** Target table name (plain text; no badging logic here). */
  targetTable: { id: string; name: string }
  /**
   * Column ordinal within the parent target table. Used to sort
   * rows inside a table group in canonical schema order.
   */
  ordinalPosition: number
}

/**
 * One source contributing to a mapped row. Shared 1:1 with one
 * `mapping_sources` row. The main Mapping page uses this to render
 * the source column badges; the drawer Source tab uses the full
 * shape to draw the per-source card.
 */
export interface MappingSourceRef {
  /** `mapping_sources.id` — stable key for React lists and writes. */
  id: string
  /**
   * Deterministic concatenation order. 0 = dominant (anchor table
   * for cross-table joins). Shim-era ordinal=0 → legacy primary row;
   * new model retains the same semantic.
   */
  ordinal: number
  /**
   * Per-source confidence, separate from the row-level aggregate.
   * The drawer Source tab shows this on each card; the main row
   * aggregates to target-level confidence via MIN() (for mapped
   * rows — trigger does this in DB, see migration 074 STEP 5).
   */
  confidence: number | null
  /** Per-source AI reasoning; drawer Source tab card collapsible. */
  aiReasoning: string | null
  /**
   * Short type-compat phrase from the AI:
   *   "VARCHAR(50) + VARCHAR(50) → VARCHAR(200) — fits"
   * Rendered in drawer Details tab (§Drawer Details lines 907-910).
   */
  typeCompatibility: string | null
  /**
   * Source field — named here directly to avoid an extra lookup
   * in render code.
   */
  sourceField: {
    id: string
    name: string
    dataType: string
    isNullable: boolean
  }
  /** Source table — drives the badge and the Source filter membership. */
  sourceTable: {
    id: string
    name: string
  }
  /**
   * Pre-computed join annotation for cross-table sources, or null
   * when this source is from the dominant table. Format is the
   * human-readable phrase the spec asks for at §Expanded view
   * line 829: `"(join: PrimaryContactID)"` — the FK field name
   * in the dominant source table pointing at this source's table.
   *
   * Server-side derivation path:
   *   1. Find the dominant (ordinal=0) mapping_source's source_table_id.
   *   2. If this row's source_table_id === dominant's source_table_id
   *      → null (same table; no join needed).
   *   3. Otherwise scan `fields.fk_reference` on fields IN the
   *      dominant table for an FK pointing at this source_table_id.
   *      If exactly one match, use its name. If zero or multiple,
   *      fall back to the raw `mapping_sources.join_spec` JSONB
   *      — the AI-authored join spec is authoritative when FK
   *      inference is ambiguous.
   *
   * The client does not need to do any of this; it renders the
   * string verbatim (or hides the annotation if null).
   */
  joinAnnotation: string | null
  /**
   * Structured join spec for drawer-side editing (§9 Q3 RESOLVED
   * 2026-04-22). Null for same-table sources (ordinal=0 OR same
   * `source_table_id` as ordinal=0). See `JoinSpec` below for the
   * derivation and provenance.
   *
   * `joinAnnotation` is for display (main row / expanded view);
   * `joinSpec` is for editor UIs that need to mutate individual
   * fields without re-parsing the annotation string.
   */
  joinSpec: JoinSpec | null
  /**
   * Up to 3 sample values from field_profiles for the Source tab
   * card's "Example:" line (§Drawer Source card, line 932). Empty
   * array when no profile or no samples.
   */
  sampleValues: string[]
}

/**
 * Structured cross-table join specification, one-for-one with the
 * raw `mapping_sources.join_spec` JSONB column (migration 074 line 206,
 * [DDL reference](../../supabase/migrations/074_mapping_redesign_data_migration.sql#L206)).
 *
 * SHAPE PROVENANCE
 * ────────────────
 * Migration 074 INTENTIONALLY does NOT constrain the JSONB shape —
 * see the column comment at migration 074 line 220 ("Exact JSON shape
 * is finalized in Phase 3; storage-only here.") and the stubbed
 * cross-table apply RPC at line 1069 ("cross-table (join_spec) apply
 * is not yet implemented; will be wired in Phase 3").
 *
 * As of 2026-04-22, production (project `uzfbwmiskqxwixxtlmye`)
 * contains ZERO `mapping_sources` rows with a non-null `join_spec`:
 *
 *   SELECT COUNT(*) FILTER (WHERE join_spec IS NOT NULL)
 *   FROM mapping_sources;                 -- → 0
 *
 * This interface therefore documents the FORWARD-LOOKING shape that
 * will be populated by Phase 4 AI mapping output and by Gap 4b drawer
 * authoring. It matches the canonical LLM output contract specified
 * at [mapping-redesign.md:1100-1110](./mapping-redesign.md#L1100-L1110):
 *
 *   "join": {
 *     "via_source_table": "CustomerMaster",
 *     "via_fk_field":     "PrimaryContactID",
 *     "to_fk_field":      "ContactID"
 *   }
 *
 * The stored JSONB is snake_case (verbatim AI output). The server
 * translator in Gap 4b converts to camelCase at the API boundary
 * to match the rest of the contract — same translation pattern used
 * for `TargetFieldRef.ordinalPosition` et al.
 *
 * NAME-BASED (not UUID-based) because the LLM emits column names.
 * A rename-robustness concern (column renames after mapping creation
 * would invalidate the join) is deferred to Phase 4 — see
 * §9 Q3 resolution follow-up.
 */
export interface JoinSpec {
  /**
   * Name of the DOMINANT source table — the anchor table at
   * `ordinal=0` in this mapping. Redundant given the sibling
   * mapping_sources rows but convenient for editor UIs that
   * want to display the spec without a cross-reference.
   */
  viaSourceTable: string

  /**
   * Field NAME in the dominant source table that carries the FK
   * value. Example: `"PrimaryContactID"` when joining
   * `accounts → contacts`. The expanded-view annotation
   * `(join: PrimaryContactID)` derives directly from this field.
   */
  viaFkField: string

  /**
   * Field NAME in the JOINED source table being referenced.
   * Usually the joined table's primary key. Example: `"ContactID"`.
   */
  toFkField: string
}

// ── Filter-dropdown universe ────────────────────────────────────────

export interface TargetTableSummary {
  id: string
  name: string
  /** Parent dataset name — rendered in the dropdown as a subtitle. */
  datasetName: string
  /**
   * Count of target fields in this table. Used by the group header
   * "19 fields" subtitle and by the per-group "3 of 19" indicator
   * when filters narrow the view.
   */
  fieldCount: number
}

export interface SourceTableSummary {
  id: string
  name: string
  datasetName: string
  /**
   * Count of source fields in this table. Needed by the drawer
   * Source tab's field picker for "7 fields" subtitles and by the
   * unmapped-source coverage guidance.
   */
  fieldCount: number
}

export interface SourceFieldAcknowledgmentSummary {
  /** `source_field_acknowledgments.id` */
  id: string
  sourceFieldId: string
  reason: string
}

// ── Project-level counters ──────────────────────────────────────────

/**
 * Top-of-page counter pills. Totals include EVERY target field in
 * the project, regardless of filter state. Filter-aware "X of Y"
 * sub-counts are computed client-side over the filtered slice of
 * `rows` — see §5.
 */
export interface MappingCounts {
  /** Every target field (mapped + VA + acknowledged + unmapped). */
  total: number
  /** Every TFM with status='approved' (including acknowledged). */
  approved: number
  /** Every TFM with status='needs_review'. */
  needsReview: number
  /** Every TFM with status='rejected'. */
  rejected: number
  /** Target fields with no TFM at all. Matches `rows[].kind='unmapped'`. */
  unmapped: number
}
```

### 3.3 What is deliberately NOT in the contract

Kept OUT to preserve single-responsibility:

- `transformations.generated_sql`, `test_results`, staging preview →
  Transform page's `getTransformData`.
- `field_profiles.null_percentage` on source/target fields →
  the Mapping page's rendering never references null percentages
  (the legacy `sourceFieldNullPercentage` on `RichFieldMapping`
  survives only for drawer chrome the redesign deletes).
- `table_mappings` rows → the redesign walks target tables, not
  pairings. The legacy `RichTableMapping` concept is fully replaced
  by client-side grouping on `targetField.targetTable.id`.
- `ai_quality_flags`, `quality_issues`, blocking issue counts →
  owned by the `MigrationCenter` / quality subsystem.
- Write-path permission info (`canEdit`) → continues to come from
  `useProjectRole(projectId)` on the client, exactly as today.
- Paginated / virtualized row windows → [spec §Virtualization](./mapping-redesign.md#virtualization)
  locks "naive .map() in Phase 3"; revisit only if profiling shows
  a problem.

---

## 4. Query strategy

### 4.1 Pattern chosen

Mirror the established `getOutputsPageDataCore` pattern at
[lib/actions/_outputs-core.ts:948-1002](../../lib/actions/_outputs-core.ts#L948-L1002):
**bulk-fetch-by-project + in-memory aggregation**, with dependent IN-list
queries resolved in successive rounds.

The entire plan is four round-trips to PostgREST.

### 4.2 Round-by-round plan

```
Round 1 — access gate
   GET /rest/v1/projects?id=eq.<projectId>&select=id
   → validates RLS and existence. Returns null on fail.

Round 2 — project-scoped parallel fetch (4 concurrent requests)
   GET /rest/v1/datasets?project_id=eq.<projectId>&select=id,role,name
   GET /rest/v1/target_field_mappings
         ?project_id=eq.<projectId>
         &select=id,target_field_id,confidence,status,ai_reasoning,
                 is_acknowledged,acknowledgment_reason,
                 combination_type,combination_sql,
                 created_at,updated_at
   GET /rest/v1/source_field_acknowledgments
         ?project_id=eq.<projectId>
         &select=id,source_field_id,reason

   (Transformations existence is also fetched here — see Round 4a
    rationale for why it's delayed one hop.)

Round 3 — dependent IN-list fetch (2 concurrent requests)
   GET /rest/v1/tables
         ?dataset_id=in.(<datasetIds>)
         &select=id,name,dataset_id,row_count
   GET /rest/v1/mapping_sources
         ?target_field_mapping_id=in.(<tfmIds>)
         &select=id,target_field_mapping_id,source_field_id,
                 source_table_id,confidence,ai_reasoning,
                 similar_fields_considered,type_compatibility,
                 join_spec,ordinal,created_at
         &order=ordinal.asc

Round 4 — dependent IN-list fetch (2 concurrent requests)
   GET /rest/v1/fields
         ?table_id=in.(<tableIds>)
         &select=id,table_id,name,data_type,is_nullable,
                 is_primary_key,is_foreign_key,fk_reference,
                 default_value,ordinal_position,
                 field_profiles(field_id,sample_values)
   GET /rest/v1/transformations
         ?target_field_mapping_id=in.(<tfmIds>)
         &select=id,target_field_mapping_id,status
         (NO generated_sql, NO test_results, NO description —
          only existence + status, per founder decision 3.)
```

Round 4a rationale: `transformations` is fetched in Round 4 rather than
Round 2 because it keys on `target_field_mapping_id`, not `project_id`
directly. Fetching by project_id requires the embedded filter trick used
in `projects-heritage.test.ts` (2026-04-23 re-baseline note, comment
item 3). To keep this query URL-length-safe and readable, we IN-list on
`tfmIds` once we have them from Round 2 — identical to what
`_outputs-core.ts:1053-1059` already does.

After Round 4, every field required by the contract is in memory. The
server then assembles `MappingRow[]` deterministically (see §4.4).

### 4.3 Index coverage

Every query above already has a supporting index as of migration 074:

| Query predicate | Supporting index | Source |
|---|---|---|
| `target_field_mappings.project_id=eq.X` | `idx_target_field_mappings_project_id` | 074:175 |
| `mapping_sources.target_field_mapping_id=in.(...)` | `idx_mapping_sources_target_field_mapping_id` | 074:223 |
| `source_field_acknowledgments.project_id=eq.X` | `idx_source_field_acknowledgments_project_id` | 074:252 |
| `transformations.target_field_mapping_id=in.(...)` | `idx_transformations_target_field_mapping_id` | 074:402 |
| `datasets.project_id=eq.X` | Existing pre-074 index |  |
| `tables.dataset_id=in.(...)` | Existing pre-074 index |  |
| `fields.table_id=in.(...)` | Existing pre-074 index |  |

**No new indexes are needed for v1.** A composite
`(project_id, status)` on `target_field_mappings` would shave a hundred
µs off the counter-pill aggregation if we ever move pills server-side,
but at current volumes (see §4.4) the in-memory reduce is sub-millisecond
and not a hot spot.

### 4.4 Performance estimate (Heritage Core, project 6622ddf1-47bd-4e48-ac2a-5b109a25bc13)

Baseline volumes captured from
[tests/integration/projects-heritage.test.ts:141-207](../../tests/integration/projects-heritage.test.ts#L141-L207)
on 2026-04-23:

- Target fields: 116 (`mappingTotal: 116`)
- Source fields: 99 (`totalSourceFields: 99`)
- Mapped TFMs (all approved): 116 (`mappingApproved: 116`)
- Transformations total: 7 applied + 29 needing work = 36 scope
- Approximate mapping_sources rows: ≤ 120 (116 TFMs with mostly 1:1)
- Tables: 8 (§Information architecture line 648 — "8 tables")

**Payload budget, Round 2-4 combined:**

| Block | Rows | Bytes/row (post-gzip estimate) | Total |
|---|---|---|---|
| TFMs | 116 | 180 | ~21 KB |
| mapping_sources | 120 | 200 (incl. JSONB join_spec=null) | ~24 KB |
| fields (both sides, w/ profile) | 215 | 180 | ~39 KB |
| tables | 8 | 70 | 0.6 KB |
| datasets | 2 | 80 | 0.2 KB |
| source_field_acknowledgments | 11 | 100 | 1.1 KB |
| transformations (stubs) | 36 | 80 | 2.9 KB |
| **Wire total, uncompressed** |  |  | **~89 KB** |
| **Wire total, gzipped (typical 4-6× ratio on JSON)** |  |  | **~20 KB** |

**Round-trip timing (rough):**

- 4 rounds × 40 ms round-trip (Supabase US-East, intra-AZ) = ~160 ms.
- In-memory assembly (Node 20, V8): ≤ 5 ms. The reduce over 116 TFMs +
  120 MS rows is a handful of Map.set / Array.push calls — dominated
  by GC.
- **End-to-end server action: ≤ 200 ms at p95**, well under the
  500-ms budget in [spec §Success criteria line 1599](./mapping-redesign.md#success-criteria).

### 4.5 Performance projection (10k target fields, enterprise scenario)

Linear extrapolation for the spec's "very large target schemas (200+ fields)"
scenario cap and the founder's 10k stretch target:

| Block | Rows | Bytes/row | Total |
|---|---|---|---|
| TFMs | 10,000 | 180 | 1.8 MB |
| mapping_sources | ~13,000 (assume 1.3 avg) | 200 | 2.6 MB |
| fields (both sides) | 10k target + 10k source | 180 | 3.6 MB |
| tables | ~500 | 70 | 35 KB |
| transformations stubs | ~3,000 | 80 | 240 KB |
| **Wire total, uncompressed** |  |  | **~8.3 MB** |
| **Wire total, gzipped** |  |  | **~1.7 MB** |

On a desktop-only product over a typical corporate connection this is
a 1-2s one-time load — acceptable for a "page load" event given that
it replaces what is currently a full page of interactive data. The
spec's desktop-only stance ([§Platform scope](./mapping-redesign.md#platform-scope))
and the founder's no-pagination-in-v1 stance
([§Virtualization](./mapping-redesign.md#virtualization)) both support this.

If profiling on a real 10k+ project later shows the single-shot load
is a problem, the escape hatch is **target-table chunking**: `rows`
becomes lazy per `targetTableId`, fetched on group expansion. That
retro-fit is additive (the `MappingRow` shape is unchanged), so Gap
4a is not blocking the eventual enterprise scaling work.

### 4.6 Which Supabase client

Use `createClient()` (user-scoped, RLS-enforced) in the server action
wrapper, not `supabaseAdmin`. Rationale:

- This is a read path whose authorization comes from the same
  `user_can_access_project` RLS policy the spec already locks
  ([migration 074 STEP 3 RLS policies](../../supabase/migrations/074_mapping_redesign_data_migration.sql#L267)).
- Using the user-scoped client keeps this action consistent with
  the existing `getMappings` ([lib/actions/mappings.ts:852](../../lib/actions/mappings.ts#L852)).
- `_outputs-core.ts` uses `supabaseAdmin` only because its wrapper
  in `outputs.ts` performs permission checks before invoking the
  core function. The Mapping page does not pre-resolve permissions
  that way; it relies on RLS end-to-end.

---

## 5. Filter-state computation: server-side vs client-side

### 5.1 Recommendation

**Option B — fully client-side.** The server returns the unfiltered
`rows: MappingRow[]` and the unfiltered universe of filter options;
React filters in memory in response to URL-param changes.

### 5.2 Justification

**For Heritage (116 rows):** trivial. Filter pipelines run in <1ms.
Zero round-trips on filter change. No spinner states.

**For the 10k-row enterprise case:** still defensible. The entire
payload (see §4.5) is ~1.7 MB gzipped — one page-load cost, amortized
over every subsequent filter interaction. A 10k-row array through a
three-stage filter pipeline (target → source → status → search) + a
Map reduce for group counts runs in 10-30ms in V8 — well under the
100ms UX budget the spec locks at [§Success criteria line 1608](./mapping-redesign.md#success-criteria).

**Why not server-side:**
1. Every filter change becomes a network round-trip (~40ms + render).
   The spec's "Filter and search respond within 100ms" budget leaves
   almost no margin.
2. Filter-state URL params would have to round-trip through a debounced
   search-change handler to avoid N parallel fetches — complexity.
3. The counter-pill indicator (`3 of 19 fields match` in a group
   header, per [spec line 693](./mapping-redesign.md#search-behavior))
   requires the server to know the full unfiltered view AND the
   filtered view — i.e., always return both, doubling payload. At that
   point you are just refetching the client-side model with extra
   round-trips.

**Why not hybrid (Option C):**
- Hybrid buys nothing at Heritage scale.
- At 10k scale, a useful hybrid split would be: server computes
  project-level totals, client filters `rows` for per-group "X of Y"
  indicators. That's already what §3.2 specifies — `MappingCounts` is
  server-computed totals (unfiltered), per-group indicators are
  client-computed over the filtered slice. So the recommended design
  IS a lightweight hybrid, just labeled "Option B" because the bulk
  of the work lives client-side.

### 5.3 Where filters live (client contract)

Client-side filter pipeline (to be implemented in Gap 4b):

```
rows
  → filter by target URL param (?target=<id>)         // group scoping
  → filter by source URL param (?source=<id>)         // any mapping_source matches
  → filter by status URL param (?status=<v>)          // TFM status
  → filter by search query (?q=<s>)                   // 4-way name match
  → group by targetField.targetTable.id               // rendering shape
```

For the search scope (locked by [spec §Search behavior, lines 681-693](./mapping-redesign.md#search-behavior)):
- Target field name
- Target table name
- Source field names (across every mapping_source)
- Source table names (across every mapping_source)

**Match semantics — contract-level, locked for Gap 4b (2026-04-22):**

- **Case-insensitive** — `q.toLowerCase()` vs each candidate's
  `.toLowerCase()`. No locale-aware collation; plain ASCII lowercase
  is the product-wide convention.
- **Substring** — `String.prototype.includes`, NOT prefix-only, NOT
  fuzzy, NOT token-split. A query `"addr"` matches `"address_line_1"`
  AND `"email_address"` AND `"Addressline"`.
- **4-way union** — a row matches when the (lowercased) query is a
  substring of ANY of the four name fields listed above. Empty
  `q` matches every row (filter is inert).
- **No minimum length** — even 1-character queries run; the spec
  treats search as instant and requires no debounce threshold.
- **Whitespace preserved** — a query of `"  addr  "` does NOT
  auto-trim. The URL handler at `/mapping?q=<s>` decides whether
  to trim before binding; contract is agnostic.

Rationale: these semantics match every other substring-search
surface in the product (Data Staging field picker, Outputs field
table) — consistent UX trumps novelty. A future escape hatch to
tokenized/fuzzy search is additive: the `rows` shape does not
change, only the client-side matcher swaps out.

Counter-pill values on the main page header use the SERVER totals
(`MappingCounts`). Per-group "3 of 19 fields match" indicators use
the CLIENT-side filtered count. This split is the reason
`MappingCounts` is server-computed — the page header must show
project-level truth regardless of filters, per the spec mock-up
at [line 646](./mapping-redesign.md#page-structure) which shows
`Total 116 · Approved 116 · Needs Review 0` unaffected by the filter
row below.

---

## 6. Edge-case handling

Every case from the prompt, addressed end-to-end.

### 6.1 Project with zero mappings

**Data state:** `target_field_mappings` is empty, `mapping_sources` is
empty, but the target schema is ingested (fields exist, grouped into
tables).

**Contract behavior:** `rows` contains ONE `UnmappedRow` per target
field. `counts.total === counts.unmapped === <target-field-count>`.
`targetSchemaEmpty === false`. The client renders every target table
group with every field as a Rule 6 row — exactly the spec's
[§Edge cases line 1189](./mapping-redesign.md#edge-cases) empty-state
behavior ("A prominent 'Generate mappings' CTA kicks off the AI
mapping generation").

### 6.2 Project with no target schema

**Data state:** No target-role dataset, or a target dataset with zero
tables.

**Contract behavior:** `rows === []`. `targetSchemaEmpty === true`.
`counts` is all zeros. The client renders the "ingest a target schema"
empty-state banner per [§Edge cases line 1167](./mapping-redesign.md#edge-cases).

### 6.3 Project with only VAs (no mapped rows)

**Data state:** Every TFM has `combination_type='custom_sql'` and zero
`mapping_sources` children. `is_acknowledged=false`.

**Contract behavior:** Every row in `rows` has `kind='value_assignment'`.
Source filter dropdown renders (`sourceTables` is populated from
source-role datasets regardless of whether any TFM references them),
but selecting any specific source produces zero filtered rows because
VAs have no `sources` to match against. The "No source mapped" badge
renders on every row per founder decision 4.

### 6.4 Cross-table mappings

**Data state:** A single TFM has ≥ 2 `mapping_sources` rows with
different `source_table_id` values. `ordinal=0` is the dominant source
(anchor table); ordinal ≥ 1 rows carry non-null `join_spec`.

**Contract behavior:** `kind='mapped'`. `sources` array is populated
with one `MappingSourceRef` per `mapping_sources` row, sorted by
ordinal ASC. Each non-dominant `MappingSourceRef` has a non-null
`joinAnnotation` string derived per §3.2 (scan dominant-table
fields.fk_reference for an FK pointing at the joined table; fall back
to `join_spec` JSONB).

This is the case the legacy shim **cannot handle** — it throws
`ShimError('CROSS_TABLE')` at
[mapping-shim.ts:581-592](../../lib/compat/mapping-shim.ts#L581-L592).
The redesign read path handles it natively; the feature-flag gate
at Gap 1 ensures no shimmed session ever encounters cross-table
data.

### 6.5 Three or more source tables contributing to one target (Rule 4)

**Data state:** Same as §6.4 but with ≥ 3 distinct `source_table_id`
values OR > 5 `mapping_sources` rows total.

**Contract behavior:** Identical to §6.4 — the server emits the full
`sources` array and the client selects Rule 4 rendering based on
`sources` length and unique-table count. No server-side Rule
discriminator; the thresholds at [spec §Rule 4 lines 748-750](./mapping-redesign.md#rule-4-multi-table-complex-three-or-more-source-tables-or-more-than-five-source-fields)
are UI logic, not data-contract logic.

### 6.6 Acknowledged source fields (no TFM touches them)

**Data state:** An entry in `source_field_acknowledgments` for a
source_field_id that has zero `mapping_sources` references.

**Contract behavior:** The acknowledgment is included in
`sourceFieldAcknowledgments`. No row in `rows` — these are source-side
facts, not target-side. The Mapping page's target-first orientation
does not surface them as rows; the drawer Source tab's field picker
uses `sourceFieldAcknowledgments` to show a "✓ acknowledged —
unavailable" marker when a user looks for a source field.

### 6.7 Rejected TFMs

**Data state:** A TFM with `status='rejected'`. Per
[spec §Mapping status lifecycle line 1216](./mapping-redesign.md#states-and-transitions),
rejection is "deletion under current UX" — the target becomes
unmapped from the user's perspective.

**Contract behavior:** The rejected TFM's row has `status='rejected'`;
its target field does NOT also appear as a synthetic `UnmappedRow`
(the server prefers the TFM record). The redesign UI filters out
rejected rows from the default view (status filter `?status=all` maps
to `{ needs_review, approved }`; `?status=rejected` shows them) —
that's a UI behavior, not a contract one. The contract returns
everything; the UI chooses what to show.

### 6.8 TFMs pointing at fields whose parent table has no `table_mappings` row

**Data state:** A TFM exists for a target field in a table that nobody
ever paired via `table_mappings`. This is the `ORPHAN_TFM` case the
shim throws on
([mapping-shim.ts:604-608](../../lib/compat/mapping-shim.ts#L604-L608)).

**Contract behavior:** The new contract does not use `table_mappings`
for iteration — groups are keyed by `target_field.target_table_id`
directly. An "orphan" TFM is NOT orphan under the redesign; it just
renders in its target table's group like any other. The redesign
silently resolves this error class.

---

## 7. Test plan

### 7.1 Pure-translation unit tests

Target the future `lib/actions/_mappings-for-redesign-core.ts` (a
test-friendly core module split following the same `'use server'`
boundary pattern as [lib/actions/_outputs-core.ts](../../lib/actions/_outputs-core.ts)).
Cover every discriminator branch + edge case.

File: `tests/actions/mappings-for-redesign-translator.test.ts`.

Proposed cases (each asserts on the full `MappingsForRedesignResult`
shape for a seeded in-memory fixture):

1. **Simple 1:1 only** — 3 TFMs each with 1 mapping_source, same
   source table. Every row `kind='mapped'`, `combinationType='single'`,
   `sources.length === 1`, `joinAnnotation === null`.
2. **Multi-source same-table (Rule 2)** — 1 TFM with 3 sources, all
   same `source_table_id`. `sources` sorted by ordinal; every
   `joinAnnotation === null`.
3. **Cross-table (Rules 3+4)** — 1 TFM with 3 sources across 2 tables.
   Dominant (ordinal=0) `joinAnnotation === null`; ordinal 1+ carry
   non-null `joinAnnotation` derived from fk_reference.
4. **Value assignment** — TFM with `combination_type='custom_sql'`,
   zero sources, `is_acknowledged=false`. Row `kind='value_assignment'`,
   `combinationSql` preserved, `confidence` echoed from TFM (not
   MIN-derived, because VAs store confidence directly).
5. **Target acknowledgment** — TFM with `is_acknowledged=true`,
   zero sources, `combination_type=null`. Row `kind='target_acknowledged'`,
   `acknowledgmentReason` populated, `status='approved'`.
6. **Unmapped** — target field with no TFM. Synthetic row `kind='unmapped'`,
   `id==='unmapped::<fieldId>'`, `confidence=null`, `status='unmapped'`.
7. **Rejected TFM** — TFM with `status='rejected'`. Row returned with
   `status='rejected'`; no duplicate synthetic unmapped row for the
   same target field.
8. **Counter derivation** — mixed fixture, assert `MappingCounts`
   matches the sum of rows by status.
9. **Source universe includes unreferenced tables** — source-role
   table with zero mapping_sources referencing it; `sourceTables`
   still includes it.
10. **Empty target schema** — zero target-role tables. `rows === []`,
    `targetSchemaEmpty === true`.
11. **FK fallback in joinAnnotation** — cross-table source where
    dominant table has NO matching FK; assert `joinAnnotation`
    falls back to `join_spec` rendering.

Test shape is purely synchronous (no DB). Use fixtures modeled after
[tests/compat/mapping-shim.test.ts](../../tests/compat/mapping-shim.test.ts)
for consistency — the same `ShimInput`-shaped fixtures can be
repurposed with the `tableMappings` array zeroed out (the new
read path doesn't need it).

### 7.2 Integration test against Heritage Core

File: `tests/integration/mappings-for-redesign-heritage.test.ts`.

Pattern-match on [tests/integration/projects-heritage.test.ts](../../tests/integration/projects-heritage.test.ts):

- CAPTURE mode: prints a JSON block suitable for pasting into
  `SNAPSHOT_2026_04_23`.
- PINNED mode: `expect(snapshot).toEqual(SNAPSHOT_2026_04_23)`.
- Env-gated (`RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1`).

Snapshot fields (exact-match pinned):

```ts
{
  projectId: '6622ddf1-47bd-4e48-ac2a-5b109a25bc13',
  rowCount: 116,               // mappingTotal
  rowCountByKind: {
    mapped: <n>,
    value_assignment: <n>,
    target_acknowledged: <n>,
    unmapped: <n>,
  },
  counts: {
    total: 116, approved: 116, needsReview: 0,
    rejected: <n>, unmapped: <n>,
  },
  targetTableCount: 8,
  sourceTableCount: <n>,
  targetSchemaEmpty: false,
  // Deterministic hash of the full rows array for drift detection:
  rowsFingerprint: '<sha256 of canonicalized JSON>',
}
```

The fingerprint lets the snapshot detect row-shape drift without
pinning every individual UUID (which would be brittle as Heritage
evolves). If the fingerprint changes, the test prints the live
capture for re-baseline following the same procedure as
[projects-heritage.test.ts §How to re-baseline](../../tests/integration/projects-heritage.test.ts#L56-L84).

### 7.3 Edge-case fixture tests

Three minimal fixture projects seeded into an in-memory translator
test (NOT requiring a live DB):

- **Empty-target fixture** — `rows === []`, `targetSchemaEmpty: true`.
- **VAs-only fixture** — 3 target fields, 3 VAs, zero mapped rows.
  Assert every `rows[i].kind === 'value_assignment'` and the Source
  filter dropdown still populates from source-role tables.
- **Cross-table fixture** — 2 target fields, one with sources across
  2 source tables. Assert `joinAnnotation` is non-null on the
  non-dominant source.

These live inside `tests/actions/mappings-for-redesign-translator.test.ts`
as additional `describe(...)` blocks — not separate files.

### 7.4 Regression guard: no legacy shim imports in redesign path

Source-invariant grep test (style-match the Gap 15 guard at
`tests/lib/url-params-guard.test.ts`): assert that
`app/app/projects/[projectId]/mapping/redesign/**` contains ZERO
imports of:
- `@/lib/compat/mapping-shim`
- Any symbol from `@/lib/types/mappings-ui` (`RichFieldMapping`,
  `RichTableMapping`, `MappingsResult`, etc.)

This catches accidental regressions where a developer refactoring
the redesign UI imports a legacy type out of habit.

### 7.5 Permission / RLS sanity

A lightweight integration test verifying that
`getMappingsForRedesign(<project-user-cannot-access>)` returns
`null` and does not leak any row metadata. This mirrors the existing
pattern in [tests/actions/mappings-permissions.test.ts](../../tests/actions/mappings-permissions.test.ts)
(if it exists) or is new.

---

## 8. Migration + deprecation strategy

### 8.1 Coexistence during Phase 3 rollout

`getMappingsForRedesign` lives **alongside** `getMappings` for the
duration of Phase 3. Both are callable; neither is aware of the other.
No runtime selection logic lives in either read path — the dispatch
happens one level up in the page component.

### 8.2 How the Gap 1 dispatch drives read-path selection

Today (post-Gap 1):
- `app/app/projects/[projectId]/mapping/page.tsx` unconditionally
  calls `getMappings(projectId)` and passes `initialData` to
  `MappingContent`.
- `MappingContent.tsx` early-returns to `<MappingRedesignContent />`
  when `useMappingRedesignEnabled(projectInfo) === true`.
- The redesign placeholder ignores `initialData` entirely.

Gap 4b will alter the page as follows:

```tsx
// app/app/projects/[projectId]/mapping/page.tsx (proposed)
const projectInfo = /* ... */
const useRedesign = projectInfo?.useMappingRedesign === true

const [legacyData, redesignData] = await Promise.all([
  useRedesign ? Promise.resolve(null) : getMappings(projectId),
  useRedesign ? getMappingsForRedesign(projectId) : Promise.resolve(null),
])

return (
  <MappingContent
    projectId={projectId}
    projectName={project.name}
    projectInfo={projectInfo}
    initialData={legacyData}
    initialRedesignData={redesignData}   // NEW
  />
)
```

`MappingContent.tsx` threads `initialRedesignData` through to the
redesign branch; the legacy branch ignores it. Only one server action
runs per request, picked by the flag. The legacy `initialData` remains
the shim-backed shape consumed by the legacy UI; the new
`initialRedesignData` is the `MappingsForRedesignResult` shape.

### 8.3 Data-shape mismatch risk

**Claim:** there is no risk of a mid-session data-shape mismatch.

**Reasoning:** the flag is project-level and server-rendered into
`projectInfo`. Each mount of `MappingContent` takes exactly one branch;
React's component tree cannot flip between them without a remount.
If an admin flips the flag mid-session, the current tab's client
cache keeps the old shape until navigation; the next RSC request
re-reads `projectInfo` and routes through the other read path. No
hybrid state is possible.

The one failure mode is **write-path coupling**: a user on the new
UI writes a cross-table mapping, then an admin flips the flag back
to false. The legacy UI then attempts to render via the shim, which
throws `ShimError('CROSS_TABLE')`. This is not a Gap 4a concern — it
is explicitly the scenario the feature-flag UX already guards against
([spec §Back-compatibility shim limitations lines 1257-1261](./mapping-redesign.md#what-the-shim-cannot-represent-blocked-by-feature-flag)).
Unflipping the flag on a project that has authored cross-table
mappings is an unsupported operation; founder-side policy, not
runtime handling.

### 8.4 Deprecation path (Phase 5 cleanup)

Removable after Phase 3c ships on 100% of projects AND the flag
column is ready to drop (per
[spec §Cleanup items lines 1293-1309](./mapping-redesign.md#cleanup-items)):

**Files deleted outright:**
- `lib/compat/mapping-shim.ts`
- `lib/types/mappings-ui.ts` (types it exports all become obsolete)
- `tests/compat/mapping-shim.test.ts`
- `tests/integration/mappings-shim-heritage.test.ts`

**Types removed from the codebase:**
- `RichFieldMapping`
- `RichTableMapping`
- `UnmappedField`
- `SimpleField`
- `FieldAcknowledgmentRow` (legacy-only; source-side acks keep their
  own `SourceFieldAcknowledgmentRow` under `lib/types/mapping-redesign.ts`)
- `MappingsResult`
- `ShimError`, `ShimErrorCode`, `DecodedShimmedRowId`, `ShimInput`,
  `ShimDatasetRow`, `ShimTableRow`, `ShimFieldRow`, `ShimTableMappingRow`,
  `ShimTransformationRow`

**Symbols removed from call sites:**
- `getMappings` (the shim-backed read path) — deleted from
  `lib/actions/mappings.ts`. The remaining write-path server actions
  stay.
- Every `decodeShimmedRowId` call site in mapping / transform write
  paths (they currently decode composite IDs; post-cleanup the UI
  sends bare UUIDs so decoders collapse to `.eq('id', rawUuid)`).
- `encodeContributorRowId`, `encodeTargetAckRowId`,
  `encodeSourceAckRowId`, `SHIMMED_ID_SEPARATOR`.
- `checkFieldMappingHasTransform` stays (the function's job doesn't
  change — it still checks whether a TFM has a transformation row —
  but its parameter type tightens from "shimmed-id-or-uuid" to
  "uuid").

**Feature-flag column dropped:**
- `projects.use_mapping_redesign` — after 30+ stable days on every
  project, per [spec §Cleanup items line 1307](./mapping-redesign.md#database-cleanup).

**Identified decode sites (grep baseline for Phase 5):**

```
$ rg "decodeShimmedRowId" --type ts
lib/actions/mappings.ts: <multiple call sites in write paths>
lib/compat/mapping-shim.ts: <definition>
tests/compat/mapping-shim.test.ts: <test cases>
```

Exact counts / line numbers captured at Phase 5 time; tracking the
inventory here avoids surprising anyone when the cleanup prompt lands.

---

## 9. Decision log (resolved open questions)

The founder-locked decisions in §2 resolve the top-level design. The
eight entries below captured smaller calls where the trade-off was
non-obvious. All were **reviewed and resolved 2026-04-22**; they are
preserved here rather than deleted so future maintainers see the
reasoning, not just the outcome.

> **Status legend:** `RESOLVED YYYY-MM-DD` — decision is final and
> baked into §3 / §4 / §5 / §6 / §7 of this document. No new bids.

### Q1 — Should `TargetAcknowledgedRow` carry `sources`? — RESOLVED 2026-04-22

**Decision:** Option A (no `sources` on `TargetAcknowledgedRow`).

**Rationale:** A target-acknowledged TFM has zero `mapping_sources` by
DB check constraint; there is nothing to carry. "Undo the
acknowledgment and preserve last-known sources for re-authoring" is a
distinct UX feature requiring its own JSONB column + migration + write
path, and is out of scope for Gap 4a. Under the shipped contract,
undo = delete the acknowledgment → target field falls back to
`kind='unmapped'` → user re-authors from scratch. If Phase 5+ surfaces
genuine demand for undo-with-sources, that feature can land
additively without breaking this contract.

**Baked in at:** §3.2 `TargetAcknowledgedRow` — no `sources` field.

---

### Q2 — `UnmappedRow.id` sentinel vs nullable? — RESOLVED 2026-04-22

**Decision:** Keep the `unmapped::<targetFieldId>` sentinel string.

**Rationale:** React list keys MUST be non-null strings. A sentinel
costs ~18 bytes/row and gives every row a deterministic stable key
that survives re-renders and filter changes. The alternative
(`id: string | null`) forces every consumer to wrap `key={row.id}`
in a defensive fallback — strictly worse ergonomics for a negligible
payload saving. Write-path safety is enforced at the server action
layer: every action that accepts an id MUST reject `id.startsWith('unmapped::')`
with a typed `'NOT_A_TFM'` error; the UI calls a dedicated
`createValueAssignment` / `createMapping` path first, which returns
the real TFM UUID to use downstream.

**Baked in at:** §3.2 `MappingRowBase.id` JSDoc.

---

### Q3 — `joinAnnotation` vs structured `joinSpec`? — RESOLVED 2026-04-22

**Decision:** Ship BOTH.
- `joinAnnotation: string | null` — display (main row + expanded view).
- `joinSpec: JoinSpec | null` — structured editor contract for the
  drawer. Interface defined in §3.2.

**Rationale:** The main row and expanded view want a pre-computed
human-readable phrase (`"(join: PrimaryContactID)"`) with no client-
side logic. The drawer's "Edit join" flow wants structured fields
it can mutate independently. Computing both server-side keeps the
client pure; cost is ~50 bytes/row in the wire payload and a
trivial extra transformation step in the Gap 4b translator.

**`JoinSpec` typing — what was NOT `unknown`.**
The founder's explicit instruction was to tighten beyond
`unknown | null`. Investigation:

1. Migration 074 line 206 declares the column as raw `JSONB` with no
   shape constraint.
2. Line 220's column comment explicitly defers shape finalization to
   Phase 3 (this project).
3. Line 1069 stubs the cross-table apply RPC "until the join_spec
   JSONB shape is finalized (Prompts 3/5+)".
4. A production query (`SELECT COUNT(*) FILTER (WHERE join_spec IS
   NOT NULL) FROM mapping_sources` against project
   `uzfbwmiskqxwixxtlmye` on 2026-04-22) returned **0 rows** — there
   is no production data to derive a shape from.
5. The canonical LLM-output contract for cross-table joins is
   specified at [mapping-redesign.md:1100-1110](./mapping-redesign.md#L1100-L1110)
   and stores three fields: `via_source_table`, `via_fk_field`,
   `to_fk_field`. That shape is what the migration 074 storage layer
   expects to ingest when Phase 4 LLM output starts emitting it.

The `JoinSpec` interface in §3.2 encodes those three fields (camelCase
at the API boundary) with inline provenance citing all five evidence
points above. Name-based (not UUID-based); rename-robustness is flagged
as a Phase 4 follow-up in the interface's JSDoc, not a Gap 4a decision.

**Baked in at:** §3.2 `MappingSourceRef.joinSpec` + `interface JoinSpec`.

---

### Q4 — Preserve `field_profiles.null_percentage`? — RESOLVED 2026-04-22

**Decision:** Dropped from the contract.

**Rationale:** The redesigned Source tab spec
([§Drawer Source tab lines 972-975](./mapping-redesign.md#tab-source))
shows per-source cards with `DATA_TYPE · N% confidence` — no null-%
indicator. Carrying the field through the wire for chrome that does
not render it is dead weight. The `field_profiles` subquery stays in
Round 4 of the query plan (§4.2) for `sampleValues`; if Gap 4b later
discovers a need for null-%, re-adding it is additive (single JSDoc
change + translator step, zero migration work).

**Baked in at:** §3.2 (no `null_percentage` field anywhere in the
contract); §3.3 bullet noting deliberate omission.

---

### Q5 — Keep `TargetFieldRef.defaultValue`? — RESOLVED 2026-04-22

**Decision:** Kept on `TargetFieldRef`.

**Rationale:** `default_value` comes along for free in the Round 4
`fields` query — it is a column on the `fields` table, not a
subquery. Excluding it would require a narrower SELECT with no wire-
payload benefit (a few dozen bytes across the whole response). Gap 4b
decides whether to surface it visually for Rule 6 (unmapped) rows;
keeping it in the contract preserves that option without a follow-up
contract change.

**Baked in at:** §3.2 `TargetFieldRef.defaultValue`.

---

### Q6 — `rejected` in the default status filter + counter pills? — RESOLVED 2026-04-22

**Decision — nuanced answer:**
1. The `?status=all` filter (default) **INCLUDES** rejected rows.
2. Counter pills default to THREE chips: `Total / Approved / Needs Review`.
3. A fourth `Rejected` chip is rendered ONLY when `counts.rejected > 0`.

**Rationale:** "All" matches user expectation of "show me every row,
no filter". The counter pills at the top of the page are a project-
level status snapshot — showing a `Rejected: 0` chip is visual noise
for the 95% of projects with no rejections, so the fourth chip
gates on `counts.rejected > 0`. Projects with at least one rejection
see it immediately (the spec's intent: rejections are rare but
important when present).

**Contract vs UI:** The contract ALWAYS exposes `counts.rejected`
(§3.2 `MappingCounts.rejected`). Rendering the fourth chip on-demand
is a client-side concern owned by Gap 4b/5 — this resolution is
documented here so the rendering code has a traceable design anchor.
No contract change.

**Baked in at:** §3.2 `MappingCounts` (unchanged — already exposes
all four counts); §9 decision log (this entry) for Gap 4b client
reference.

---

### Q7 — Row sort order within a target-table group? — RESOLVED 2026-04-22

**Decision:** Sort by
`(targetTable.name ASC, targetField.ordinalPosition ASC, targetField.name ASC)`.

**Rationale:** The target-schema browse order elsewhere in the product
(Data Staging, Outputs, target-schema viewer) is ordinal-position-
based — that is the order fields appear in the user's DDL and in the
target system itself. Alpha-by-name (the legacy shim's behavior)
wins scannability in a Latin-alphabet sense but loses the semantic
"here's column 1, then column 2" ordering that matters for reviewing
a migration. Ordinal ASC with name ASC as a tiebreak gives both
properties.

**Name tiebreak rationale:** synthetic or mis-ingested fields can
share an `ordinal_position` value (rare, but observed in the Heritage
Core dataset). Alphabetical name ordering as a tiebreak is stable
and deterministic without invoking a DB-side PK tiebreak that would
leak internal UUID ordering into the UI.

**Baked in at:** §3.2 `MappingsForRedesignResult.rows` JSDoc
(expanded by Amendment A); §4.4 server assembly step (implicit —
Gap 4b codifies the SQL-side sort keys).

---

### Q8 — `fieldCount` derivation — server COUNT vs client derive? — RESOLVED 2026-04-22

**Decision:** Derive `fieldCount` client-side from loaded `rows` +
the embedded `fields` payload.

**Rationale:** Fields are already in memory after Round 4 of the
query plan (§4.2); counting them is a single `Array.prototype.filter`
+ `.length` pass. A server-side COUNT would add a round-trip per
target table (or a GROUP BY pass). At Heritage scale (116 fields, 8
tables) the saving is measured in milliseconds; at 10k-field
enterprise scale the client work is still sub-millisecond because
the field list is already materialized. Derivation keeps the server
action's query plan lean.

**Consequence for the contract:** `TargetTableSummary.fieldCount` and
`SourceTableSummary.fieldCount` remain on the contract as REQUIRED
server-computed numbers (the server runs the same derivation before
emitting the payload — the client just doesn't have to duplicate the
logic). The "client derives" framing is about the server NOT running
a dedicated `.select('id', { count: 'exact' })` round-trip per table;
the value is still sent pre-computed to avoid forcing every UI
consumer to reimplement the count.

**Baked in at:** §3.2 `TargetTableSummary.fieldCount` + `SourceTableSummary.fieldCount`;
§4.2 query plan (no extra COUNT subqueries).

---

### Amendments (2026-04-22)

Three additional changes baked in at founder approval, not tied to
the original 8 questions.

**Amendment A — Canonical row ordering as server guarantee.**
Extended `MappingsForRedesignResult.rows` JSDoc (§3.2) to explicitly
specify the sort key, declare the ordering a server-side contract,
and instruct consumers NOT to re-sort. Complements Q7 with the
`MUST NOT re-sort` invariant the Gap 4b implementer can rely on.

**Amendment B — Search semantics locked at the contract level.**
Extended §5.3 with explicit specification of the client-side search
matcher: case-insensitive substring (`String.prototype.includes`
after `.toLowerCase()`), 4-way union across the four name fields, no
minimum query length, whitespace preserved. Locks the UX so Gap 4b
does not re-debate. Additive future work (fuzzy / tokenized search)
remains possible without a contract change.

**Amendment C — `combinationType` enum tied to migration 074 CHECK.**
Extended `MappedRow.combinationType` JSDoc (§3.2) to paste the
migration 074 `CHECK` constraint verbatim as evidence. Establishes
a single source of truth: any future widening of the union MUST come
with a migration update to the CHECK, and vice versa. Confirmed the
TypeScript union exactly matches the CHECK as of 2026-04-22 —
no allowed values missed.

---

## Appendix A — Evidence file reference

All claims in this document trace to these files (quick-lookup for
Gap 4b):

- [docs/features/mapping-redesign.md](./mapping-redesign.md) — canonical UI spec
- [lib/actions/mappings.ts:851-1074](../../lib/actions/mappings.ts#L851-L1074) — legacy `getMappings`
- [lib/compat/mapping-shim.ts](../../lib/compat/mapping-shim.ts) — shim translation
- [lib/types/mappings-ui.ts](../../lib/types/mappings-ui.ts) — legacy UI types
- [lib/types/mapping-redesign.ts](../../lib/types/mapping-redesign.ts) — new-model row types
- [lib/actions/_outputs-core.ts:948-1127](../../lib/actions/_outputs-core.ts#L948-L1127) — reference bulk-fetch pattern
- [supabase/migrations/074_mapping_redesign_data_migration.sql:136-256](../../supabase/migrations/074_mapping_redesign_data_migration.sql#L136-L256) — TFM / MS / SFA DDL + indexes
- [supabase/migrations/075_target_field_mapping_needs_transformation.sql](../../supabase/migrations/075_target_field_mapping_needs_transformation.sql) — `needs_transformation` restoration
- [tests/integration/projects-heritage.test.ts:141-207](../../tests/integration/projects-heritage.test.ts#L141-L207) — Heritage baseline snapshot

## Appendix B — Glossary (for Gap 4b readers)

- **TFM** — `target_field_mappings` row; the canonical mapping entity.
- **MS** — `mapping_sources` row; a single source contribution.
- **SFA** — `source_field_acknowledgments` row.
- **VA** — value assignment; a TFM with `combination_type='custom_sql'`
  and zero MS children.
- **Rule 1-6** — the six main-row rendering modes specified at
  [mapping-redesign.md §Row design](./mapping-redesign.md#row-design).
  Rule 7 was rejected by founder decision 4.
- **Shim** — `lib/compat/mapping-shim.ts`. Pure translation layer.
  Temporary; deleted in Phase 5.
- **Redesign path / new read path** — `getMappingsForRedesign` as
  specified by this document.
