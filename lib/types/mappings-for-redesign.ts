/**
 * Data contract for the Phase 3 redesigned Mapping page.
 *
 * Canonical source of truth: `docs/features/phase-3-gap-4a-design.md`
 * (commit 70e1ef5). Every type below traces back to a section of that
 * document. If you are about to change a shape here, start there — the
 * JSDoc below is a fair-copy of the design doc to keep the contract
 * co-located with the code.
 *
 * Scope
 * -----
 * These types feed `getMappingsForRedesign` (server action) →
 * `MappingRedesignContent` (client). They are pure data — no React,
 * no Supabase imports — so they can be shared between:
 *
 *   • `lib/actions/mappings-for-redesign.ts` (server action wrapper)
 *   • `lib/actions/_mappings-for-redesign-core.ts` (core + assembly)
 *   • `tests/actions/mappings-for-redesign-translator.test.ts` (unit)
 *   • `tests/integration/mappings-for-redesign-heritage.test.ts`
 *   • `app/app/projects/[projectId]/mapping/redesign/**` (UI)
 *
 * Stability: the contract is LOCKED as of design-doc commit 70e1ef5
 * (2026-04-22). Further changes require a founder-reviewed design
 * update — not an ad-hoc edit during implementation.
 */

// ─── Top-level result ────────────────────────────────────────────────

/**
 * Output of `getMappingsForRedesign(projectId)`.
 *
 * Returned when the caller is authenticated AND the project exists AND
 * RLS permits the read. Callers receive `null` and should fall back to
 * `notFound()` on any access failure — no partial / error shapes leak
 * onto this contract.
 *
 * Per design §8.2: consumed by the redesign-branch Mapping UI behind
 * the `projects.use_mapping_redesign` feature flag. The legacy
 * `getMappings` read path continues to power the pre-redesign UI
 * alongside this one — both server actions are callable in parallel
 * during Phase 3.
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
   *     targetTable.name            ASC,  -- group scan order
   *     targetField.ordinalPosition ASC,  -- DDL order inside a group
   *     targetField.name            ASC   -- tiebreak for synthetic
   *                                       --  fields w/ identical ordinals
   *
   * This matches the canonical target-schema browse order the user
   * already sees in Data Staging. Consumers (Gap 4b UI, drawer deep-
   * links, test fixtures) MUST NOT re-sort. Filter pipelines and
   * `groupBy(targetField.targetTable.id)` preserve order, so rendering
   * can rely on row index stability across filter changes.
   *
   * A row exists for EVERY target field, even those without a TFM
   * (those appear as `kind: 'unmapped'`). The client groups by
   * `targetTable.id` for rendering; the server emits a flat list so
   * filter pipelines (search, status, source, target) can apply
   * uniformly without re-bucketing.
   *
   * See design §9 Q7 resolution (2026-04-22) for the decision log.
   */
  rows: MappingRow[]

  /**
   * Universe of target tables for the Target filter dropdown and
   * for group-header rendering. Includes every target-role-dataset
   * table, whether or not it has any TFMs yet — matches the spec's
   * "empty state shows target schema with all rows unmapped" behavior.
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
   */
  sourceFieldAcknowledgments: SourceFieldAcknowledgmentSummary[]

  /**
   * Pre-computed counter-pill values across all rows, server-side.
   * Client-side filtering does NOT recompute these — they are the
   * PROJECT-level totals visible at the top of the page header. The
   * per-group "3 of 19 fields match" indicator is computed client-
   * side over the filtered slice of `rows`; see design §5 for the
   * split between server totals and client-filtered counts.
   */
  counts: MappingCounts

  /**
   * Absent only when the project has no target schema ingested at
   * all (design §6.2). Drives the empty-state banner in the main
   * viewport.
   */
  targetSchemaEmpty: boolean
}

// ─── Row shapes (discriminated union) ────────────────────────────────

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

/** Kind discriminator enumeration, kept exportable for exhaustiveness checks. */
export type MappingRowKind = MappingRow['kind']

/**
 * Transformation lifecycle states as stored on `transformations.status`.
 * Mirrors `TransformationStatus` in `lib/types/mapping-redesign.ts`
 * and is duplicated here so the redesign contract has zero coupling
 * to the legacy types module.
 */
export type MappingTransformationStatus =
  | 'draft'
  | 'tested'
  | 'saved'
  | 'applied'
  | 'stale'

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
   * small "has transform" indicator on the main row. The transform
   * SQL itself is NOT included — editing lives on the standalone
   * Transform page (founder decision, design §2 item 3).
   *
   * False for `kind: 'unmapped'` and `kind: 'target_acknowledged'`
   * (no TFM or an ack-only TFM — neither can carry a transformation).
   */
  hasTransformation: boolean

  /**
   * Transformation lifecycle state when `hasTransformation = true`,
   * else null. Allows the UI to surface a muted `✓ applied` vs
   * `⚠ stale` vs `✎ draft` indicator without an extra round-trip.
   *
   * Defensive default: if `hasTransformation=true` but the stored
   * status is null or outside the known enum, the core emits `'draft'`
   * (the initial transformation state). A null here always means
   * "no transformation row exists".
   */
  transformationStatus: MappingTransformationStatus | null
}

/** Mapped row — 1+ mapping_sources, not acknowledged. Rules 1-4. */
export interface MappedRow extends MappingRowBase {
  kind: 'mapped'
  /**
   * Status here is the TFM's own status, narrowed — 'unmapped' is
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
   * `supabase/migrations/074_mapping_redesign_data_migration.sql:156-157`
   *
   *   combination_type TEXT
   *     CHECK (combination_type IN ('single', 'concat_space',
   *                                 'concat_comma', 'custom_sql')),
   *
   * The DDL also allows `NULL` (for `is_acknowledged=true` rows —
   * see `TargetAcknowledgedRow` which carries no `combinationType`
   * field). If a future migration widens or narrows this set, update
   * this union, the `ValueAssignmentRow` constant, and the CHECK at
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
   * Always 'custom_sql' by DB CHECK constraint (migration 074 line
   * 156-157). Kept typed as a constant for downstream exhaustiveness
   * checks.
   */
  combinationType: 'custom_sql'

  /**
   * The VA expression as stored on target_field_mappings.combination_sql.
   * Nullable during the brief lifecycle window between
   * `createValueAssignment` (which writes NULL) and the user
   * authoring SQL on the Transform tab.
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
  /** Migration 074 STEP 3c writes 'approved' for all ack rows. */
  status: 'approved'
  confidence: null
  hasTransformation: false
  transformationStatus: null

  /** The reason the user (or AI) gave for acknowledging. */
  acknowledgmentReason: string | null
}

/**
 * Target field with no TFM. Synthesized row for Rule 6.
 *
 * Per §9 Q1 RESOLVED 2026-04-22: no `sources` field. Undo (of a
 * former acknowledgment or rejection that led to this state) =
 * re-author from scratch. Preserving last-known sources for undo is
 * a separate feature, not a contract concern.
 */
export interface UnmappedRow extends MappingRowBase {
  kind: 'unmapped'
  status: 'unmapped'
  confidence: null
  hasTransformation: false
  transformationStatus: null
}

// ─── Nested reference shapes ─────────────────────────────────────────

/**
 * Enough target-field metadata for row rendering AND drawer header
 * without a second lookup. All fields are DB-sourced.
 *
 * `defaultValue` retained per §9 Q5 resolution — cheap to include
 * (comes along with the fields fetch), lets Gap 4c+ decide whether
 * to surface "unmapped but self-populating" without a follow-up
 * contract change.
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
   * Rendered in drawer Details tab.
   */
  typeCompatibility: string | null

  /**
   * Source field — named here directly to avoid an extra lookup
   * in render code.
   *
   * Nullable at the edges: `mapping_sources.source_field_id` is
   * NULL-able in the DB for defense-in-depth, but live rows in the
   * new model always have both source_field_id and source_table_id
   * set together. The core translator drops any mapping_source with
   * a null source_field_id before assembling `sources[]`, so this
   * field is always non-null on the wire.
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
   * human-readable phrase `"(join: PrimaryContactID)"` — the FK
   * field name in the dominant source table pointing at this
   * source's table.
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
   * Sample values from `field_profiles.sample_values` for the source
   * field.
   *
   * CONSUMER — drawer Source tab card only.
   * ──────────────────────────────────────────────────────────────────
   * The mapping row's expanded view (chevron-toggled per-source list)
   * intentionally does NOT render sample values. The mapping page is
   * a scan-and-approve surface; deep per-source review — samples,
   * reasoning, edit controls — lives in the drawer opened by clicking
   * a row. See `docs/features/mapping-redesign.md` §Expanded view for
   * the scoping rationale.
   *
   * An earlier attempt (Gap 6, 2026-04-24) inlined a 3-sample preview
   * plus a `+N more` affordance on the expanded-view bullet line.
   * Smoke test revealed the density overwhelmed the scanning use
   * case, so the rendering was reverted. The 10-value wire cap
   * survived because the drawer will consume this data in Gaps 7-10.
   *
   * Shape contract (locked 2026-04-24):
   *   • Up to 10 values from the DB (cap in `extractSampleValues`).
   *   • Empty array when no profile exists, the profile has no
   *     samples, or `sample_values` is not an array.
   *   • Server order preserved — no client-side reshuffling.
   *
   * Raising the 10-cap is the single-line change to
   * `MAX_SAMPLE_VALUES` in `_mappings-for-redesign-core.ts`; update
   * this JSDoc in lockstep.
   */
  sampleValues: string[]
}

/**
 * Structured cross-table join specification, one-for-one with the
 * raw `mapping_sources.join_spec` JSONB column (migration 074 line 206).
 *
 * SHAPE PROVENANCE
 * ----------------
 * Migration 074 INTENTIONALLY does NOT constrain the JSONB shape —
 * see the column comment at migration 074 line 220 ("Exact JSON shape
 * is finalized in Phase 3; storage-only here.") and the stubbed
 * cross-table apply RPC at line 1069 ("cross-table (join_spec) apply
 * is not yet implemented; will be wired in Phase 3").
 *
 * As of 2026-04-22, production contains ZERO `mapping_sources` rows
 * with a non-null `join_spec`. This interface therefore documents the
 * FORWARD-LOOKING shape that will be populated by Phase 4 AI mapping
 * output and by Gap 4c drawer authoring. It matches the canonical
 * LLM output contract in `docs/features/mapping-redesign.md`:
 *
 *   "join": {
 *     "via_source_table": "CustomerMaster",
 *     "via_fk_field":     "PrimaryContactID",
 *     "to_fk_field":      "ContactID"
 *   }
 *
 * The stored JSONB is snake_case (verbatim AI output). The core
 * translator converts to camelCase at the API boundary to match the
 * rest of the contract.
 *
 * NAME-BASED (not UUID-based) because the LLM emits column names. A
 * rename-robustness concern (column renames after mapping creation)
 * is deferred to Phase 4 — see design §9 Q3 resolution follow-up.
 */
export interface JoinSpec {
  /**
   * Name of the DOMINANT source table — the anchor table at
   * `ordinal=0` in this mapping. Redundant given the sibling
   * mapping_sources rows but convenient for editor UIs.
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

// ─── Filter-dropdown universe ────────────────────────────────────────

export interface TargetTableSummary {
  id: string
  name: string
  /** Parent dataset name — rendered in the dropdown as a subtitle. */
  datasetName: string
  /**
   * Count of target fields in this table. Used by the group header
   * "19 fields" subtitle and by the per-group "3 of 19" indicator
   * when filters narrow the view. Per §9 Q8: derived server-side
   * from the loaded fields payload (no extra COUNT round-trip).
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
   * unmapped-source coverage guidance. Same derivation as
   * `TargetTableSummary.fieldCount`.
   */
  fieldCount: number
}

export interface SourceFieldAcknowledgmentSummary {
  /** `source_field_acknowledgments.id` */
  id: string
  sourceFieldId: string
  reason: string
}

// ─── Project-level counters ──────────────────────────────────────────

/**
 * Top-of-page counter pills. Totals include EVERY target field in
 * the project, regardless of filter state. Filter-aware "X of Y"
 * sub-counts are computed client-side over the filtered slice of
 * `rows`.
 *
 * Per §9 Q6 RESOLVED 2026-04-22: the contract always exposes all
 * four counts. Chip rendering (3 chips by default, 4th chip when
 * `rejected > 0`) is a Gap 4b/5 UI concern — the contract itself
 * is chip-agnostic.
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
