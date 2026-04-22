# Prompt 3a — Remaining Work Inventory

Generated as part of Gate-3 R6 (Option B: build-pass + grep sweep). This is
the work inventory for Prompt 3b's investigation.

## Scope recap

Prompt 3a rewrote:

- `lib/actions/mappings.ts` — full rewrite against the new data model
  (`target_field_mappings`, `mapping_sources`, `source_field_acknowledgments`).
- `lib/actions/field-acknowledgments.ts` — split between target-side (TFM
  `is_acknowledged=true`) and source-side (`source_field_acknowledgments`).
- `lib/compat/mapping-shim.ts` — new translation layer from new-model rows
  to the legacy `MappingsResult` / `RichFieldMapping` shape.

Everything else still references the dropped `field_mappings` /
`field_acknowledgments` tables and will break at runtime on any call path
that exercises it. Prompt 3b/3c/3d must rewrite each of the following
modules against the new data model.

## Remaining old-table references

Produced via:

```bash
rg "from\('field_mappings'|from\('field_acknowledgments'|\.field_mappings\b|\.field_acknowledgments\b" \
   --glob '*.{ts,tsx}' \
   -l --no-heading
```

Results filtered to exclude:

- `lib/actions/mappings.ts` — the only in-file `field_mappings` hits are
  `parsed.field_mappings` and `tm.field_mappings`, which are **Claude JSON
  response properties**, not database references. Safe.
- `tests/actions/field-acknowledgments.test.ts` — defensive assertion that
  `from('field_acknowledgments')` does NOT appear in the rewritten source.
  Safe (it is an anti-match).

All remaining references are real breakages waiting for Prompt 3b/3c/3d.

### Prompt 3b scope — `lib/actions/transformations.ts` + `lib/actions/fk-cascade.ts`

| File                              | Line  | Description                                                         |
| --------------------------------- | ----- | ------------------------------------------------------------------- |
| `lib/actions/transformations.ts`  | 138   | Load source/target for a single transform via FM join               |
| `lib/actions/transformations.ts`  | 536   | Check if a transform has a generated_sql for its FM                 |
| `lib/actions/transformations.ts`  | 582   | Fetch sibling FMs on the same TM for staged-data dependency sweep   |
| `lib/actions/transformations.ts`  | 625   | Resolve FM.target_field_id → field name for JSONB key               |
| `lib/actions/transformations.ts`  | 773   | Transform preview join through FM → fields                          |
| `lib/actions/transformations.ts`  | 811   | Permission resolution via `txLookup.field_mappings.table_mappings`  |
| `lib/actions/transformations.ts`  | 858   | Permission resolution — `applyStagedTransform` path                 |
| `lib/actions/transformations.ts`  | 908   | Load FM row for transform metadata binding                          |
| `lib/actions/transformations.ts`  | 1007  | FM lookup for `saveFieldTransform`                                  |
| `lib/actions/transformations.ts`  | 1136  | Permission lookup in `saveFieldTransform`                           |
| `lib/actions/transformations.ts`  | 1247  | FM → field resolution for `resetFieldTransform`                     |
| `lib/actions/transformations.ts`  | 1355  | FM-level staged-row revert                                          |
| `lib/actions/transformations.ts`  | 1415  | FM list for `resetAllTransformsForTable`                            |
| `lib/actions/transformations.ts`  | 1486  | Per-FM transform row fetch                                          |
| `lib/actions/transformations.ts`  | 1587  | FM list for table-scoped transform enumeration                      |
| `lib/actions/transformations.ts`  | 1671  | FM lookup in `resetFieldTransform` (legacy path)                    |
| `lib/actions/transformations.ts`  | 1691  | FM row hydrate for reset                                            |
| `lib/actions/transformations.ts`  | 1719  | FM row hydrate — alt branch                                         |
| `lib/actions/transformations.ts`  | 1812  | FM → field join for transform apply                                 |
| `lib/actions/fk-cascade.ts`       | 111   | FM enumeration to detect FK dependents                              |
| `lib/actions/fk-cascade.ts`       | 218   | FM → source_field_id for cascade planning                           |
| `lib/actions/fk-cascade.ts`       | 224   | Sibling-FM probe for cascade                                        |
| `lib/actions/fk-cascade.ts`       | 389   | FM batch fetch for cascade apply                                    |
| `lib/actions/fk-cascade.ts`       | 421   | FM-based post-cascade verify                                        |

New model mapping: every `field_mappings` read → `target_field_mappings` +
`mapping_sources`. Every `field_mappings.is_contributing` → inverse of
`mapping_sources.ordinal == 0`. Every `field_mappings.source_field_id /
target_field_id` → the corresponding column on the mapping_source / TFM.

The `resetFieldTransform(fieldMappingId)` signature needs to be preserved
but internally reinterpret `fieldMappingId` as a TFM UUID (per Gate-2
Design Call D). All callers in the rewritten `mappings.ts` already pass
a TFM UUID — the rewrite of `transformations.ts` is the last thing to make
this end-to-end functional.

### Prompt 3c scope — `lib/actions/outputs.ts` + `lib/actions/execution-package.ts`

| File                              | Line  | Description                                                    |
| --------------------------------- | ----- | -------------------------------------------------------------- |
| `lib/actions/outputs.ts`          | 251   | Ack join — fetch `field_acknowledgments` for project rollup    |
| `lib/actions/outputs.ts`          | 278   | FM enumeration for migration output catalog                    |
| `lib/actions/outputs.ts`          | 660   | FM → target field list for output manifest                     |
| `lib/actions/outputs.ts`          | 813   | FM row for JSONB-shape output                                  |
| `lib/actions/outputs.ts`          | 981   | FM status filter (non-rejected TMs) for export                 |
| `lib/actions/outputs.ts`          | 1175  | FM batch fetch for export bundle                               |
| `lib/actions/outputs.ts`          | 1309  | FM → (source_field, target_field, TM) tuple for package        |
| `lib/actions/execution-package.ts`| 829   | FM enumeration for apply plan                                  |
| `lib/actions/execution-package.ts`| 1339  | FM → field join for SQL stitching                              |

### Prompt 3d scope — `lib/quality/*` + quality-adjacent actions

| File                                  | Line  | Description                                                    |
| ------------------------------------- | ----- | -------------------------------------------------------------- |
| `lib/quality/readiness-score.ts`      | 36    | `field_acknowledgments` read for project coverage              |
| `lib/quality/readiness-score.ts`      | 65    | FM enumeration for mapped-vs-total calc                        |
| `lib/quality/fix-target.ts`           | 109   | FM → target field lookup for fix suggestion                    |
| `lib/quality/fix-engine.ts`           | 334   | FM → staged row hydration for fix apply                        |
| `lib/quality/detection-engine.ts`     | 678   | FM enumeration for "un-mapped target with non-null constraint" |
| `lib/quality/detection-engine.ts`     | 1087  | FM probe for "not in allowed values" detection                 |
| `lib/quality/resolved-by-transform.ts`| 32    | FM → transform status join for resolved-by-transform tally     |
| `lib/actions/validation-rules.ts`     | 496   | FM id list for validation rule target selection                |
| `lib/actions/validation-rules.ts`     | 501   | FM batch fetch for rule apply                                  |
| `lib/actions/staging.ts`              | 250   | FM → target field for staged-row key allocation                |
| `lib/actions/staging.ts`              | 637   | FM enumeration for stage-phase diff                            |
| `lib/actions/staged-row-flags.ts`     | 114   | FM → target field lookup for flag write                        |
| `lib/actions/migration-intelligence.ts` | 499 | FM sampling for intelligence context                           |
| `lib/actions/migration-runbook.ts`    | 169   | FM count for runbook preamble                                  |
| `lib/actions/ai-quality-detection.ts` | 194   | FM → field name lookup for AI prompt                           |
| `lib/actions/projects.ts`             | 199   | `field_acknowledgments` rollup for project grid                |
| `lib/actions/projects.ts`             | 213   | FM count for project grid                                      |

## Call-site preservation (from `lib/actions/mappings.ts`)

Per Gate-2 Design Call D, the rewritten `mappings.ts` still calls three
functions in the unmodified `transformations.ts`:

- `resetFieldTransform(tfmId)` — called from `editFieldMapping`,
  `deleteFieldMapping`, and `replaceValueAssignment`. Will fail at runtime
  until Prompt 3b rewrites it to query `target_field_mappings` instead of
  the dropped `field_mappings` table.
- `resetAllTransformsForTable(tableMappingId)` — called from
  `regenerateFieldMappings`. Same status.
- `checkFieldMappingHasTransform(tfmId)` — re-exported from `mappings.ts`
  for the drawer UI. Prompt 3b will flip the implementation.

The rewritten `mappings.ts` passes TFM UUIDs to these functions; Prompt 3b
must preserve that semantics during the rewrite.

## Verification status

- `npx tsc --noEmit` — passes (0 errors).
- `npm run build` — passes.
- `npx vitest run tests/` — 78 tests pass across 7 files (4 env-gated
  integration tests skip without Heritage credentials).
- Parameterised guard sweep covers all 15 write paths in
  `lib/actions/mappings.ts` + `lib/actions/field-acknowledgments.ts`.
- `computeOrphanedTfmsForTmDelete` (pure helper extracted from
  `deleteTableMapping`) covered by 5 behavioural unit tests including the
  two-TM scenario required by Gate-3 Item 2.

Runtime breakage is confined to the out-of-scope modules listed above.
The mapping read path (`getMappings`), the guard wiring, and the shim
are fully wired and exercised by the test suite.

## Test coverage debt (accepted at Gate-3 Item 3)

Prompt 3a's test suite verifies translation correctness (shim), source-level
contracts (guard wiring, refinement patterns), and one pure algorithm
(`computeOrphanedTfmsForTmDelete`). What it does NOT cover is the full
end-to-end behaviour of the 15 write-path server actions against a live or
fake Supabase client — i.e., "does this server action, when called with
these inputs and this DB state, produce these RPC calls and these row
changes?".

This gap is explicit, not accidental. A short-lived attempt during Prompt
3a to mock `supabase.from().select().eq()...` chains for
`tests/actions/field-acknowledgments.test.ts` produced a hanging test and
was abandoned in favour of source-level contract assertions. The
`@supabase/postgrest-js` query builder is highly chainable and each method
returns a different shape; producing a faithful fake is a project in its
own right.

### Write-path actions lacking behavioural tests

All 15 live in `lib/actions/mappings.ts` or `lib/actions/field-acknowledgments.ts`
and are currently only verified by the guard sweep and source-level
refinement assertions:

1. `generateMappings` — AI-driven TM+TFM creation for a table pair.
2. `updateFieldMappingStatus` — approve/reject a single primary TFM or
   reject a contributor (deletes the `mapping_sources` row).
3. `updateTableMappingStatus` — set a TM's `status` column.
4. `editFieldMapping` — retarget a TFM or relocate a contributor source.
5. `addManualFieldMapping` — primary TFM via `dq_create_target_field_mapping`
   or contributor via direct `mapping_sources` INSERT (Refinement 1).
6. `addManualTableMapping` — create a TM row, dedupe first.
7. `regenerateFieldMappings` — purge TFMs (non-VA) + reset transforms +
   re-run AI for a TM pair.
8. `deleteFieldMapping` — delete a primary TFM or one `mapping_source`.
9. `deleteTableMapping` — delete a TM and cascade-orphan TFMs via the
   (now unit-tested) `computeOrphanedTfmsForTmDelete` helper.
10. `approveAllFieldMappings` — bulk approve + ack (Refinement 3 filter).
11. `rejectAllFieldMappings` — bulk reject.
12. `approveHighConfidenceMappings` — threshold-based bulk approve.
13. `suggestRemainingMappings` — LLM suggest + persist.
14. `mapUnmappedField` — convenience wrapper that finds/creates TM then
    calls `addManualFieldMapping`.
15. `createValueAssignment` — VA TFM with `combination_sql = NULL`
    (intentional lifecycle per Gate-3 Item 1).

Plus `field-acknowledgments.ts`:

- `acknowledgeField`, `removeAcknowledgment`, `getAcknowledgmentsForProject`,
  `recomputeAffectedTableMappings` — covered by source-level contract
  assertions only.

### Recommendation for Prompt 3b

Before adding new business logic, decide on the testing strategy for the
rewritten mapping/transform/cascade layer:

1. **Build a mock harness** — implement a chainable `@supabase/postgrest-js`
   stub with an in-memory fake table set. ~1–2 days of work, pays back
   across Prompts 3b/3c/3d and every future mapping change. Reference
   implementations exist (`supabase-mock`, hand-rolled fakes in other OSS
   projects); Prompt 3b can lift-and-shape one.
2. **Commit to integration-only testing** — rely exclusively on the
   Heritage canary + env-gated integration tests, dropping source-level
   contract assertions in favour of real RPC calls against a staging DB.
   Lower setup cost, but each test run needs network + credentials and CI
   gets slower.

Either is acceptable. What's NOT acceptable is letting the coverage debt
compound past Prompt 3d — the fk-cascade and execution-package logic in
Prompts 3c/3d has too many invariants for source-level grep to catch.
