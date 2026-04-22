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

### Prompt 3c scope — `lib/actions/outputs.ts` + `lib/actions/execution-package.ts` + `lib/quality/readiness-score.ts` — ✅ COMPLETE

All three modules rewritten against the new data model. Key outcomes:

- `lib/actions/outputs.ts` is now a thin orchestrator. Data fetching lives in
  a new private `hydrateProjectData` helper; output generation delegates to
  six pure translators in `lib/actions/_outputs-translators.ts`
  (`buildMappingCsvRows`, `buildMappingJsonGroups`, `buildTransformSpecsLines`,
  `buildGoldStandardSelectSQL`, `buildSqlLoadScriptInserts`,
  `buildReadinessReportPrompt`). Persisting server actions follow the
  `__Internal`-function pattern with a `__skipPersistence` flag; the exported
  wrappers always pass `false`.
- `lib/actions/execution-package.ts` + its extracted
  `lib/actions/_execution-package-prompt.ts` module rewritten analogously.
- `lib/quality/readiness-score.ts` rewritten to query
  `target_field_mappings` + `mapping_sources` + `source_field_acknowledgments`
  + bare-ack TFMs. The scoring formula itself (`readiness-formula.ts`) is
  unchanged per D6.
- TM ↔ TFM pairing centralised in `lib/actions/_outputs-helpers.ts`
  (`groupTfmsByTableMapping`, `enumerateFieldPairs`, `isValueAssignment`)
  so outputs + exec-package + (indirectly, via the same rules inlined)
  readiness never drift.
- **D1 multi-source fallback bug fixed.** Legacy `generateGoldStandardCSVs`
  / `generateSQLLoadScripts` fallback SQL emitted one column per MS row,
  producing duplicate aliases on concat_\* TFMs without a saved
  transformation (e.g. two columns aliased `t_full_name`). The rewrite
  emits one column per primary TFM and, for concat_\* / multi-source TFMs
  without a transformation, emits a warning and skips the column instead
  of generating invalid SQL. Regression test:
  `tests/outputs/gold-standard-select.golden.test.ts › T9 D1 regression`.
- **`rows.toLocaleString()` bug fixed.** Legacy SQL load scripts rendered
  `Rows: [object Object],[object Object],…` because the row-array
  (not `rows.length`) was stringified. Fixed in
  `buildSqlLoadScriptInserts`. Regression test:
  `tests/outputs/sql-load-inserts.golden.test.ts › T10 rows-header regression`.
- **D10 `toLegacyTransformation` preserved.** The adapter in
  `lib/actions/transformations.ts` is unchanged (0 diff since
  commit `24f7ad8`). Scheduled deletion moves to Prompt 3d, at which point
  every remaining consumer of the legacy `Transformation.field_mapping_id`
  semantic lie must be audited and migrated.

Tests added (Prompt 3c):

- `tests/outputs/outputs-helpers.unit.test.ts` — 13 assertions covering
  the fixture's 10 coverage cases (A1–A10) plus orphan-skip behaviour.
- `tests/outputs/mapping-file.csv.golden.test.ts`,
  `mapping-file.json.golden.test.ts`, `transform-specs.golden.test.ts`,
  `gold-standard-select.golden.test.ts`, `sql-load-inserts.golden.test.ts`,
  `readiness-report-prompt.golden.test.ts` — six translator-level golden
  fixtures.
- `tests/outputs/execution-package-prompt.monolithic.golden.test.ts`,
  `execution-package-prompt.compartmentalized.golden.test.ts` — LLM prompt
  golden fixtures for both generation modes.
- `tests/outputs/rejected-tfm-audit-trail.test.ts` — Test 11: eight
  inclusion/exclusion assertions proving rejected TFMs appear in
  audit-trail exports (CSV, JSON) and never in execution artifacts
  (transform-specs, gold-standard-select, SQL load inserts, readiness
  prompt, both exec-package variants). Exercised by the 2026-04-22 TFM-9
  fixture relocation (see `tests/fixtures/outputs/README.md`).
- `tests/outputs/confidence-formatting.test.ts` — regression guard
  against the Gate 3 Item 1 `9500%` bug.
- `tests/outputs/no-legacy-table-refs.test.ts` — Test 13: source-level
  grep proving the three rewritten files contain zero
  `.from('field_mappings' | 'field_acknowledgments')` references.
- `tests/outputs/guard-absence.test.ts` — Test 14: source-level grep
  enforcing D8 (no `assertMappingWritesEnabled` in output-generation
  files).
- `tests/integration/outputs-heritage.test.ts` — Test 17: env-gated
  heritage integration for `generateMappingFile` + `getOutputsPageData`.
  Includes Flag 1's bounds-based plausibility assertions on Heritage
  Core metrics with verification-query comments showing how to
  re-baseline to exact hard-coded values.
- `tests/integration/readiness-score-heritage.test.ts` — Test 15:
  env-gated shape-and-soundness suite for `computeReadinessScore`.

Known coverage gaps (accepted, tracked here):

- **`__skipPersistence` flag not exercised by a dedicated test** (the
  originally-planned Test 12). The flag is consumed only by the private
  `generateXInternal` functions, which cannot be exported from a
  `'use server'` file without becoming server actions. Exposing them
  would either break the `'use server'` contract or require splitting
  `outputs.ts` into a pure helper module + a thin server-action
  wrapper — a refactor deferred to future work. The flag's effect is
  indirectly covered by the golden tests (which exercise the
  translators, which is where all output content is assembled).
- **`tests/quality/no-drift.test.ts`** (originally-planned Test 16).
  Deferred to pre-commit discipline — the git-diff-based assertion is
  awkward inside Vitest (requires spawning git as a subprocess with
  parameters that vary per branch/rebase state), and a single-founder
  team does not benefit from automating what a 5-second manual check
  catches. Before committing any Prompt 3c/3d work, run:

  ```sh
  git diff --name-only HEAD -- lib/quality/
  ```

  and verify the output matches scope expectations:

  - **Prompt 3c**: `lib/quality/readiness-score.ts` only (and
    incidentally `readiness-formula.ts` if the formula itself changes,
    though 3c leaves it untouched).
  - **Prompt 3d**: `lib/quality/readiness-score.ts` +
    `lib/quality/fix-target.ts` + `lib/quality/fix-engine.ts` +
    `lib/quality/detection-engine.ts` +
    `lib/quality/resolved-by-transform.ts`.

  If the diff shows any `lib/quality/` file not in the expected list,
  STOP and reconcile before committing — an unexpected file indicates
  either scope creep or accidental drift.
- **Fixture-based unit test for `computeReadinessScore`** (the
  originally-planned Test 15's fixture variant). Same `'use server'`
  constraint as `__skipPersistence`: the wrapper cannot be called in
  isolation without mocking `supabaseAdmin`, which would require a
  query-builder fake the codebase doesn't have (see "Test coverage
  debt" section). Shape/soundness + numeric plausibility is covered by
  the env-gated heritage test against live data.

### Prompt 3d scope — `lib/quality/*` + quality-adjacent actions

| File                                  | Line  | Description                                                    |
| ------------------------------------- | ----- | -------------------------------------------------------------- |
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

## Bugs fixed in Prompt 3c

Separate from the data-model rewrite itself, Prompt 3c repairs latent
bugs that the rewrite exposed. Each fix lands in the same commit as the
corresponding rewrite step, with a code comment at the repair site and a
regression test pinning the new behaviour.

1. **Confidence-formatter bug — render stored integer directly.**
   Production stores `target_field_mappings.confidence`,
   `mapping_sources.confidence`, and (pre-074) `field_mappings.confidence`
   as 0–100 integer-valued numerics. Verified via live query during
   Prompt 3c Gate 3 Concern 1: `min=40, max=100, avg≈91` across
   `n=763/774/776` rows (TFM / MS / backup tables respectively).

   Three formatter sites previously applied `Math.round(c * 100)` under
   the incorrect assumption that `c` was a 0–1 fraction, producing
   absurd rendered strings such as `[confidence: 9500%]` in every Claude
   execution-package prompt and every customer-facing migration
   intelligence report. The buggy formula lived in:

   - `lib/actions/_execution-package-prompt.ts:693` (monolithic +
     compartmentalized mapping sections, primary TFM line).
   - `lib/actions/_execution-package-prompt.ts:724` (same file,
     contributor MS lines).
   - `lib/actions/migration-intelligence.ts:616` (project-level LLM
     context block — technically quiescent post-074 because the file
     still reads the dropped `field_mappings` table, but fixed here so
     Prompt 3d's rewrite inherits the correct formula).

   `lib/actions/outputs.ts:1212,1235,1246` was already correct
   (`Math.round(confidence)` with no multiplier), and `readiness-score.ts`
   + UI components (`MappingContent.tsx`, `TransformContent.tsx`) had
   always treated the value as 0–100. This was a clean, isolated
   formatter bug, not a data-semantic inconsistency — the verdict was
   confirmed by a full-codebase audit of every `.confidence` reader
   (Gate 3 Item 1 grep sweep).

   Fix: remove the `* 100` multiplier at all three sites; add a verbatim
   justification comment above each site pointing future maintainers at
   this doc entry. Regression test
   `tests/outputs/confidence-formatting.test.ts` asserts that no
   prompt-assembly path emits a three-digit-plus percentage (other than
   exactly `100%`), that `9500%` specifically never appears, and that
   the fixture continues to exercise realistic 40–99 values. Golden
   fixtures regenerated 2026-04-22; the monolithic and compartmentalized
   expected.md files now show the correct `[confidence: 95%]`-style
   strings.

   The founder overruled Gate 2's byte-for-byte preservation rule for
   this specific case on the grounds that preserving a real,
   customer-visible defect purely to hold golden-fixture diffs to zero
   bytes is the wrong trade. Byte-equivalence exists to prevent
   accidental drift, not to calcify pre-existing bugs.

2. **`rows.toLocaleString()` → `rows.length.toLocaleString()` in SQL
   load scripts.** Legacy `generateSQLLoadScripts` emitted a header line
   reading `-- Rows: [object Object],[object Object],…` because it called
   `toLocaleString` on the row-array (JavaScript implicitly stringifies
   each element via `Array.prototype.toString` → `Object.prototype.toString`).
   The obvious intent is a row count — fixed at the single fix-site
   inside `buildSqlLoadScriptInserts`
   (`lib/actions/_outputs-translators.ts`) with a comment citing the
   repair. Regression test:
   `tests/outputs/sql-load-inserts.golden.test.ts › T10 rows-header regression`.

3. **D1 multi-source fallback duplicate-alias bug in gold-standard /
   SQL-load fallback SQL.** Legacy fallback path iterated every approved
   MS row and emitted a column aliased `<target_field_name>` for each,
   generating invalid SQL (`SELECT … AS t_full_name, … AS t_full_name`
   inside one projection) on any concat_\* TFM lacking a saved
   transformation. Rewrite emits one column per primary TFM; for
   multi-source TFMs without a transformation, logs a warning and skips
   the column. Regression test:
   `tests/outputs/gold-standard-select.golden.test.ts › T9 D1 regression`.

## Verification status (Prompt 3c close-out)

- `npx tsc --noEmit` — passes (0 errors).
- `npm run build` — PENDING (final run at Gate 4 pre-commit).
- `npx vitest run tests/` — 169 tests pass across 21 files (21 env-gated
  integration tests skip without Heritage credentials; total suite size
  190 tests).
- Output translators pinned via eight golden-fixture test files in
  `tests/fixtures/outputs/` covering CSV, JSON, transform specs, gold
  standard SELECT, SQL load inserts, readiness-report prompt, and both
  execution-package prompt variants.
- TM ↔ TFM pairing covered by 13 assertions in `outputs-helpers.unit.test.ts`
  (A1–A10 coverage cases).
- Rejected-TFM audit-trail contract pinned by 8 assertions
  (`rejected-tfm-audit-trail.test.ts` — Test 11).
- Three latent bugs (confidence formatter, `rows.toLocaleString()`, D1
  duplicate alias) fixed with dedicated regression tests.
- Source-level guards enforce absence of legacy table references
  (`no-legacy-table-refs.test.ts`) and absence of
  `assertMappingWritesEnabled` calls (`guard-absence.test.ts`) in all
  three rewritten files.

Runtime breakage is confined to Prompt 3d modules (`lib/quality/*`
minus `readiness-score.ts` + `readiness-formula.ts`, and the six
quality-adjacent actions listed above). The outputs read/write path,
execution-package generation, readiness-score computation, transform
apply/revert/reset/cascade, and mapping CRUD are all fully wired on the
new data model.

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
