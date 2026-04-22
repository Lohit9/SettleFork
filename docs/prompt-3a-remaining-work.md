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

### Prompt 3b scope — `lib/actions/transformations.ts` + `lib/actions/fk-cascade.ts` — ✅ COMPLETE

Both modules were fully rewritten against the new data model. Key outcomes:

- `lib/actions/transformations.ts` now queries `target_field_mappings` +
  `mapping_sources` exclusively. The legacy `field_mapping_id` column has
  been replaced by `target_field_mapping_id` everywhere. A
  `toLegacyTransformation` adapter keeps the exported `Transformation`
  type stable for out-of-scope consumers (outputs.ts, execution-package.ts,
  quality/\*) so those modules continue to type-check until Prompt 3c/3d.
- `lib/actions/fk-cascade.ts` now walks dependents via
  `target_field_mappings` and skips Value Assignments (custom_sql),
  rejected mappings, acknowledged targets, and TFMs with zero
  `mapping_sources` (Gate 2 Precision P1).
- ID semantics (Gate 2 Option 2-narrow): `transformations.ts` contains a
  private `resolveTfmId` helper that accepts both bare TFM UUIDs and
  composite shimmed ids (`tfm::ms`). `fk-cascade.ts` does NOT import from
  `lib/compat/mapping-shim`; it inlines a minimal composite-id stripper
  with a documented link to `SHIMMED_ID_SEPARATOR`.
- Apply RPC wiring (Gate 2 Q2 + G-a):
  - Mapped TFMs → `dq_apply_field_transform_joined(tfm_id, target_name, sql, NULL)`.
  - Value Assignments → legacy `dq_apply_field_transform` looped over every
    TM sharing the VA's target table. A dedicated `dq_apply_value_assignment`
    RPC is deferred to Prompt 3c.
  - `cascadeTransformToFKs` uses `dq_apply_field_transform_joined`
    exclusively (cascade never targets VAs by construction).
- Maintenance guard wiring: every UI-facing write threads through
  `guardWrites(projectId, …)`. `dismissTransformNeeded` /
  `reinstateTransformNeeded` call `assertMappingWritesEnabled` directly
  to preserve the throw-on-error contract (Gate 2 Q4). The internal
  helpers `resetFieldTransform`, `resetAllTransformsForTable`,
  `resetFKDependentTransforms`, `staleFKDependentTransforms` are
  deliberately unguarded — they are only called from already-guarded
  paths.

Migration 075 (executed 2026-04-22 against production) added
`target_field_mappings.needs_transformation` and backfilled from
`field_mappings_backup_074`, filtering out rejected primary FMs and
acknowledged TFMs.

Tests added:

- `tests/actions/transforms-guard-sweep.test.ts` — 12 UI-facing write
  paths verified to route through the maintenance guard, plus a canary
  count and per-helper unguarded-is-intentional assertions.
- `tests/actions/transforms-refinements.test.ts` — R1–R7 source-level
  invariants (resolveTfmId semantics, apply RPC wiring, cascade RPC
  purity, `needs_transformation` column location, findFKDependents
  filters, header invariant documentation, logging convention).
- `tests/integration/transformations-unique-invariant.test.ts` —
  env-gated live-data check that every `target_field_mapping_id` has at
  most one transformation row (Gate 2 Q3 3a).
- `tests/integration/transforms-heritage.test.ts` — env-gated read-only
  smoke test for `getTransformData` shape + uniqueness + unmapped-field
  non-overlap against the Heritage canary.

The write-lifecycle end-to-end (create mapping → attach transform →
apply → cascade on source change) is covered by manual canary QA rather
than an automated test — running a rollback-safe write cycle against
production in CI is judged worse than the manual smoke test.

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

The three functions that `mappings.ts` calls in `transformations.ts`
(`resetFieldTransform`, `resetAllTransformsForTable`,
`checkFieldMappingHasTransform`) are now rewritten against the new data
model as of Prompt 3b. TFM UUID semantics are preserved — callers still
pass the TFM id, and `resolveTfmId` handles the composite contributor
form defensively.

## Known caveats (Prompt 3b)

1. **Value Assignment apply uses the legacy RPC.** `applyTransform` for
   a VA TFM loops every TM whose `target_table_id` matches the VA's
   target field and calls the legacy `dq_apply_field_transform` RPC for
   each. `dq_apply_field_transform_joined` rejects zero-source TFMs by
   design, so the legacy call-path stays in use until a dedicated
   `dq_apply_value_assignment` RPC lands in Prompt 3c alongside the
   `outputs.ts` rewrite. Nothing is currently broken — the legacy RPC
   still exists in the DB and works; the wiring is simply heavier than
   it needs to be.

2. **`flagStagedRowIssues` call site preserved in try/catch.**
   `lib/actions/staged-row-flags.ts` still queries legacy
   `field_mappings` and is out of scope until Prompt 3d. Its call site
   inside `applyTransform` is wrapped in `try/catch` so the apply
   succeeds even when the flagging pass throws.

3. **`toLegacyTransformation` adapter — semantic lie, scheduled deletion.**
   Location: `lib/actions/transformations.ts`, private function
   `toLegacyTransformation(row: TransformationRow): Transformation`.

   What it does: takes a new-model `TransformationRow` (which keys on
   `target_field_mapping_id`) and coerces it into the legacy
   `Transformation` interface from `lib/types/database.ts`, populating
   the legacy `field_mapping_id` field with the **TFM id** instead of a
   real (now-dropped) `field_mappings.id`. Every `FieldItem.transformation`
   surfaced by `getTransformData` routes through this adapter before
   being returned.

   Why it exists: the legacy `Transformation` TypeScript interface is
   imported by 10+ out-of-scope consumers (`outputs.ts`,
   `execution-package.ts`, `lib/quality/*`, `migration-intelligence.ts`,
   `migration-runbook.ts`, `ai-quality-detection.ts`, `validation-rules.ts`,
   `staging.ts`, `staged-row-flags.ts`, `projects.ts`). Changing the
   interface in Prompt 3b would cascade a TypeScript-error storm across
   all of them while their bodies are still operating on the legacy
   data model. The adapter keeps the interface stable so those files
   continue to type-check until Prompt 3c/3d rewrites their bodies.

   Why it is a semantic lie: downstream readers see `.field_mapping_id`
   and (reasonably) infer it identifies a row in the dropped
   `field_mappings` table. It actually identifies a row in
   `target_field_mappings`. The two id spaces have no overlap post-074,
   so any caller that joins on the wrong table will return zero rows
   silently.

   Current dependants that consume `Transformation.field_mapping_id`
   with the new TFM-id semantics:
   - `lib/actions/transformations.ts` itself (internally stable; always
     the same id it started with).
   - `FieldItem.transformation` in `getTransformData` payloads — consumed
     by `app/app/projects/[projectId]/transform/TransformContent.tsx`,
     which never cross-references the id against `field_mappings`
     (it only uses it as an opaque handle for `applyTransform` /
     `revertTransform` calls, both of which flow back through
     `resolveTfmId`).
   - Any of the 10 out-of-scope modules that already query
     `transformations.field_mapping_id` — all of which are broken at
     runtime regardless, because they also reference the dropped
     `field_mappings` / `field_acknowledgments` tables.

   **REMOVAL REQUIREMENT (DO NOT SHIP PAST PROMPT 3d):** when the
   Prompt 3c and Prompt 3d rewrites complete, `toLegacyTransformation`
   and the legacy `Transformation` interface in `lib/types/database.ts`
   must both be deleted. Downstream code should read
   `transformations.target_field_mapping_id` directly (matching the
   actual DB column name). Carrying a permanent
   "looks-like-FM-id-but-actually-TFM-id" semantic shim past Phase 2 is
   a maintenance liability — future engineers will read
   `.field_mapping_id` and write code that depends on the wrong
   identity semantics. The deletion should land in the same commit that
   closes out Prompt 3d; a tracking TODO inside the adapter's header
   comment reminds the commit author.

4. **`suggestTransformDescription` context building.** The AI context
   pulls from `target_field_mappings` + `mapping_sources` directly; the
   prompt text is unchanged from the legacy shape. If a future Prompt
   wants to exploit the new model (e.g., include combination_type /
   combination_sql hints), that will be a targeted edit rather than a
   structural change.

## Verification status (Prompt 3b close-out)

- `npx tsc --noEmit` — passes (0 errors).
- `npm run build` — passes.
- `npx vitest run tests/` — 116 tests pass across 8 files (10 env-gated
  integration tests skip without Heritage credentials).
- Parameterised guard sweep covers 15 mapping write paths + 12
  transform/cascade write paths (27 total).
- `computeOrphanedTfmsForTmDelete` covered by 5 behavioural unit tests.
- Source-level refinement tests pin the seven Gate-2 decisions (R1–R7)
  in `transforms-refinements.test.ts`.

Runtime breakage is confined to Prompt 3c/3d modules
(`outputs.ts`, `execution-package.ts`, `lib/quality/*`, and the six
quality-adjacent actions listed below). The transform read path
(`getTransformData`), apply path (mapped + VA), revert path, reset path,
and FK cascade path are all fully wired.

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
