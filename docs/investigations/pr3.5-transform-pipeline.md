# PR 3.5 — Transform pipeline (single-agent + dry-run verification loop)

**Status:** Phase A read-only investigation (no code changes; no LLM spend).
**Author:** Claude Code session, 2026-05-05.
**Branch when authored:** `feat/inv1-validation-rule-context` (off `origin/main`; PR 3.4e branch sits separately at `feat/pr3.4e-voting-variance-fix`, un-pushed).
**Sibling investigations consulted:**
- [pr3.4-mapping-agent-adoption.md](./pr3.4-mapping-agent-adoption.md) — Phase 3.4 single-agent shape (mirror this)
- [pr3.4cd-multi-agent-mapping.md](./pr3.4cd-multi-agent-mapping.md) — multi-agent patterns (deferred for transform)
- [inv1-input-prioritization.md](./inv1-input-prioritization.md) — input-layer audit (transform inherits same gaps)
- PR 3.4e voting-variance-fix doc (lives only on `feat/pr3.4e-voting-variance-fix`; key takeaway: Opus 4.7 deprecates `temperature` / `top_p` / `top_k` — single-agent transform cannot use these for variance, but doesn't need to).

> **Why this is pilot-critical:** Mapping decides "field A → field B" but does not generate runnable SQL. Without transform, customers can see what mappings exist but can't execute the migration. Mitratech / Nymbus / Rootstock pilot completion blocks on transform.

> **Founder's three explicit goals:**
> 1. **"Transform Needed" classification** accuracy — visible to user as a "Define" tag on the UI. Bias toward over-flag when uncertain.
> 2. **What** transformation is needed — type coercion, NULL handling, format conversion, lookup, concatenation, splitting, computation.
> 3. **Producing the actual SQL** correctly — runnable on real customer data without errors.

> **Architectural locks inherited from Phase 3.4:**
> - Single-agent first; multi-agent deferred indefinitely (mirror PR 3.4a/b).
> - "AI proposes → Deterministic validates → Human approves" preserved.
> - Dry-run verification loop is the **deterministic-validates** step.
> - Heritage byte-identical preserved under flag-OFF.

---

## §A — Current state surface read

### A.1 What already exists in [`lib/actions/transformations.ts`](../../lib/actions/transformations.ts) (3 247 LOC)

The transform agent ALREADY EXISTS as a complete single-shot path. Phase 3.5 EXTENDS rather than replaces. Inventory:

| Surface | File:line | Behaviour |
|---|---|---|
| Entry — generate SQL | [`generateTransform`](../../lib/actions/transformations.ts#L1116) | Single `callLLM` per field. Tool: `EMIT_TRANSFORM_SQL_TOOL`. `cacheControl: true`. Status set to `'draft'`. |
| Entry — bulk path | [`autoGenerateAllTransforms`](../../lib/actions/transformations.ts#L2084) | Sequential loop calling `generateTransform` for every field where `field.needsTransform && !field.transformation`. |
| Entry — refine SQL | [`generateTransform` w/ `existingSQL` arg](../../lib/actions/transformations.ts#L1259-L1275) | When user updates the description, prior SQL is passed back as `<existing_sql>` + `<iteration_instruction>` block. |
| System prompt | [`TRANSFORM_SYSTEM_PROMPT` lib/actions/transformations.ts:989-1084](../../lib/actions/transformations.ts#L989-L1084) | ~5K tk of SQL pattern guidance. Largest system prompt in the codebase per the inline comment at line 1349. |
| User-message construction | [transformations.ts:1312-1329](../../lib/actions/transformations.ts#L1312-L1329) | `<source_field>` / `<contributing_source_fields>` / `<target_field>` / `<type_compatibility>` / `${transformDocBlock}` / `intelligence_context` / `<existing_sql>` + `<iteration_instruction>` (refinement) / `<description>` |
| Context source | [`buildAIContext` w/ scope tableIds + fieldIds](../../lib/actions/transformations.ts#L1208-L1220) | profilingStats + valueDistributions + sampleValues + documents (maxDistributionValues=25). |
| Post-process | [`wrapWithNullGuard`](../../lib/actions/transformations.ts#L1095-L1113) | Idempotently injects `WHEN field IS NULL OR TRIM(field::text) = '' THEN NULL` as the first CASE branch. |
| Provenance | [`logAIEdit` + `original_ai_generated_sql` freeze](../../lib/actions/transformations.ts#L1414-L1453) | First AI proposal frozen on INSERT; `ai_replaced` event on subsequent regenerations. |
| Sampled dry-run | [`testTransformation`](../../lib/actions/transformations.ts#L1849) | Runs 10-20 rows through `execute_transform_test` RPC. Returns `{ before, after, beforeValues }[]`. Auto-flips status to `'tested'` on success. |
| Full-table dry-run | [`runFullTransformTest`](../../lib/actions/transformations.ts#L1753) | Runs ENTIRE source table through `execute_transform_full_test` RPC ([migration 043:119](../../supabase/migrations/043_null_safe_apply_and_window_guard.sql#L119)). Returns `{ totalRows, passedRows, failedRows, failures: { rowNumber, sourceValue, errorMessage }[] }`. |
| Apply → staging | [`applyTransform`](../../lib/actions/transformations.ts#L2185) | Executes via `dq_apply_field_transform` (mapped) or `dq_apply_field_transform_joined` (cross-table). Gates on `status === 'tested' \|\| 'applied'` ([line 2208](../../lib/actions/transformations.ts#L2208)). |
| Revert | [`revertTransform`](../../lib/actions/transformations.ts#L2411) | Undo into prior state. |
| Classification dismiss | [`dismissTransformNeeded`](../../lib/actions/transformations.ts#L2852) / [`reinstateTransformNeeded`](../../lib/actions/transformations.ts#L2901) | Toggle `target_field_mappings.needs_transformation`. Logged via `ai_edit_history`. |
| Suggest NL description | [`suggestTransformDescription`](../../lib/actions/transformations.ts#L2686) (system prompt at [line 2666](../../lib/actions/transformations.ts#L2666)) | Pre-generation step: AI suggests an NL description based on src/tgt context. Single call. |
| Helper | [`fieldNeedsTransform`](../../lib/utils/transform-helpers.ts#L28-L132) | 4-step heuristic resolving NULL/TRUE/FALSE classification + type-family fallback. |
| Helper | [`wrapFieldRefsInJsonb`](../../lib/utils/transform-helpers.ts#L185-L311) | Rewrites SQL identifier refs into JSONB `row_data->>'<name>'` accessors. Same-table + cross-table overloads. |

### A.2 Transformation row lifecycle

[`TransformationStatus`](../../lib/types/mapping-redesign.ts#L134-L139): `'draft' | 'tested' | 'saved' | 'applied' | 'stale'`.

```
generateTransform        →  status='draft'
runFullTransformTest     →  status='tested'   (if failedRows === 0)
                         →  status='draft'    (if failedRows > 0; surfaces failures to user)
saveTransformation       →  status='saved'
applyTransform           →  status='applied'  (gates on tested|applied)
upstream change          →  status='stale'    (FK cascade, regen of upstream PK transform)
```

`applied` is the load-bearing state — `outputs.ts`, `execution-package.ts`, `_outputs-helpers.ts`, `lib/quality/*` all read `transformations` rows assuming a single applied row per TFM.

### A.3 Where "Transform Needed" classification lives today

**Classification happens at MAPPING time, not transform time.** The mapping prompt at [`mapping-engine.ts:234-245`](../../lib/ai/mapping-engine.ts#L234-L245) instructs the model to emit `needs_transformation: true|false` per field mapping. The value is persisted on `target_field_mappings.needs_transformation` ([migration 075](../../supabase/migrations/075_target_field_mappings_needs_transformation.sql)). The transform tab reads it via the [`fieldNeedsTransform`](../../lib/utils/transform-helpers.ts#L28-L132) 4-step heuristic and surfaces a "Define" tag in the UI.

User actions: [`dismissTransformNeeded`](../../lib/actions/transformations.ts#L2852) (TRUE/NULL → FALSE; authoritative per migration 075) and [`reinstateTransformNeeded`](../../lib/actions/transformations.ts#L2901) (FALSE → TRUE).

The `fieldNeedsTransform` heuristic at [transform-helpers.ts:28-132](../../lib/utils/transform-helpers.ts#L28-L132) is documented as 4 steps:

1. `needsTransformation === false` → return false (user dismissal authoritative)
2. `hasTransformation === true` → return true (transformation row exists)
3. `needsTransformation === true` → return true (AI / FK-cascade / user-reinstated flag)
4. `needsTransformation === null` → type-family fallback. Default to "needs transform" *unless* same-type direct-compatible passthrough at confidence ≥ 90.

The default-to-"needs-transform" already biases toward over-flagging when classification is missing — aligned with founder Goal 1.

### A.4 SQL execution surfaces

| RPC | Migration | Behaviour |
|---|---|---|
| `execute_transform_test` | [014_transform_apply.sql](../../supabase/migrations/014_transform_apply.sql) (later refined) | Sampled run (10-20 rows). Returns before/after pairs. |
| `execute_transform_full_test` | [043_null_safe_apply_and_window_guard.sql:119-220](../../supabase/migrations/043_null_safe_apply_and_window_guard.sql#L119-L220) | **Full-table run.** SECURITY DEFINER. `statement_timeout = '60s'`. Fast path: one-shot `SELECT COUNT(*) FROM (SELECT (expr) FROM data_rows WHERE table_id=…) _t` — if it succeeds, all rows pass. Slow path: per-row iteration in a `BEGIN/EXCEPTION` block, collecting up to 20 failures with `row_number`, `source_value`, `error_message`. **Already the right shape for an AI feedback loop.** |
| `dq_apply_field_transform` | [014_transform_apply.sql](../../supabase/migrations/014_transform_apply.sql) (later refined) | Same-table apply into `staged_data_rows`. |
| `dq_apply_field_transform_joined` | [076_…](../../supabase/migrations/076_apply_field_transform_joined.sql) | Cross-table apply with LATERAL join spec. |

Security-check posture in `execute_transform_full_test`:
- Rejects DDL/DML keywords (`insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute`).
- Rejects access to `pg_catalog|information_schema|auth\.|storage\.`.
- Rejects access to `projects|datasets|field_mappings|table_mappings|quality_issues|fix_history|fix_snapshots|validation_rules`.
- Rejects semicolons.
- Rejects window functions (test/apply parity).

### A.5 Test surfaces today

| Test file | Coverage |
|---|---|
| [tests/utils/transform-helpers.test.ts](../../tests/utils/transform-helpers.test.ts) (247 LOC) | `fieldNeedsTransform` heuristic + `wrapFieldRefsInJsonb` (same-table + cross-table). |
| [tests/integration/transforms-heritage.test.ts](../../tests/integration/transforms-heritage.test.ts) (118 LOC) | Heritage byte-identical fingerprint for transform write path. |
| [tests/integration/transformations-unique-invariant.test.ts](../../tests/integration/transformations-unique-invariant.test.ts) | One-row-per-TFM invariant. |
| [tests/integration/transform-apply-cross-table-heritage.test.ts](../../tests/integration/transform-apply-cross-table-heritage.test.ts) | Cross-table apply heritage. |
| [tests/components/transform-redesign-ui.test.ts](../../tests/components/transform-redesign-ui.test.ts) (273 LOC) | UI rendering. |
| [tests/actions/transforms-cross-table-apply.test.ts](../../tests/actions/transforms-cross-table-apply.test.ts) | Cross-table apply actions. |
| [tests/actions/transforms-guard-sweep.test.ts](../../tests/actions/transforms-guard-sweep.test.ts) | Per-action guard wiring. |
| [tests/actions/transforms-refinements.test.ts](../../tests/actions/transforms-refinements.test.ts) | Source-text invariants. |
| [tests/outputs/transform-specs.golden.test.ts](../../tests/outputs/transform-specs.golden.test.ts) | Golden-file specs for output package SQL. |

**Gaps today**:
- No test exercises an AI-correction-loop because no loop exists.
- No test exercises classification accuracy (no fixture-based eval for `needs_transformation` true/false correctness).
- No test exercises per-category SQL correctness (no fixture-by-category for type coercion / format conversion / boolean normalization / etc.).

### A.6 What does NOT exist yet (Phase 3.5 must add)

1. **AI feedback loop on dry-run failures.** Today `runFullTransformTest` returns failures to the *user*; there is no automatic `AI generates → execute_full_test → AI corrects → re-test` cycle.
2. **Per-pair cost / iteration cap** scoped to the transform stage.
3. **Heritage gate flag** (proposed name: `AI_PHASE_3_5_ENABLED`). Today the entire transform path runs in production with `cacheControl: true` and PR 12 tool-use under `AI_PHASE_2_ENABLED=1`. There is no flag specific to "new transform pipeline" because no new pipeline has been written yet.
4. **Per-transform-category eval fixtures.** Path 2 PR 1 wired `eval_transform` ([lib/eval/runner.ts](../../lib/eval/runner.ts)) feature, but the fixtures are limited to `tests/eval/datasets/_fixture/examples/transform/` (smoke tests only).
5. **Runtime classification refresh.** If an AI run shows the SQL fails on every row, the user can dismiss; but there's no path for the AI to refine its own classification from "needs transform" to "no transform needed" based on test results.

---

## §B — Three-stage architecture lock

The original plan called for "3 stages + dry-run verification loop". The three stages are:

1. **Classification** — does this field need a transform?
2. **Category** — what KIND of transform (type coercion / NULL handling / format conv / lookup / concat / split / compute)?
3. **SQL generation** — produce the actual expression.

### B.1 Three architectural shapes considered

#### Shape 1 — Single combined call

One `callLLM` produces all three outputs in a single tool-use response (extended `EMIT_TRANSFORM_SQL_TOOL` schema with `needs_transform: bool`, `category: enum`, `sql: string`). Cheaper, simpler, faster.

**Pros:**
- ~70% cheaper per pair (1 call vs 3)
- Cache-hot system prompt once per call instead of per stage
- No coordination logic between stages
- Mirrors the existing `generateTransform` shape — minimum LOC delta

**Cons:**
- Cannot iterate classification independently of SQL — if classification is the bottleneck, prompt iteration affects all three outputs simultaneously
- Eval scoring must blend three axes into one score (or run three scorers on one telemetry payload)
- A single bad SQL emission discards all three outputs together; cannot persist the classification + category if SQL fails

#### Shape 2 — Three separate calls

Stage 1 (classify) → Stage 2 (categorize) → Stage 3 (generate SQL). Each gates on the prior.

**Pros:**
- Each stage independently iterable + scoreable
- Stage 1 short-circuit: if classification says "no transform", stages 2 + 3 are skipped (cost saving on the no-transform path)
- Per-stage prompt length scales with stage's complexity (stage 1 prompt is tiny vs stage 3's 5K-tk SQL guidance)
- Mirrors the multi-agent decomposition pattern from PR 3.4cd without taking on the variance / vote-aggregation cost

**Cons:**
- 3× LLM calls for transforms-needed pairs
- Coordination logic + new state machine
- Cache-warmth split: each stage caches its own system prompt; first call burns 3 cold caches per pair
- LOC delta significantly larger (~3× scaffolding)

#### Shape 3 — Hybrid (recommended)

**One agent. One initial call producing all three outputs. The dry-run loop is a SEPARATE deterministic verification step that runs after AI generation.** The "three stages" are conceptual axes the prompt + scorers measure, not three separate LLM calls.

When dry-run fails, a SECOND call is made — but only with the failure context, not a re-classification. This second call can re-emit category + sql; it does not re-litigate "should we transform at all?" (the user has already seen the Define tag and clicked Generate).

**Pros:**
- Same cost profile as Shape 1 on the happy path
- Dry-run loop adds at most N extra calls per pair on the unhappy path (capped per OQ2 below)
- Independent iteration via prompt section: classification rules at the top of `TRANSFORM_SYSTEM_PROMPT`, category guidance in the middle, SQL pattern guidance at the bottom (already structured this way at [transformations.ts:989-1084](../../lib/actions/transformations.ts#L989-L1084))
- Preserves the existing `generateTransform` shape — Phase 3.5 wraps rather than replaces
- Eval scoring can run three scorers on one telemetry payload

**Cons:**
- Stage 1 short-circuit (skip 2 + 3 when no transform needed) is lost — but this is small change vs the broader cost picture (most pairs DO need transforms in real migrations)

### B.2 Recommendation

**Shape 3 (hybrid).** One agent, one initial call that emits classification + category + sql together via an extended tool schema. Dry-run loop wraps with deterministic verification. Reasoning matrix:

| Dimension | Shape 1 | Shape 2 | Shape 3 |
|---|---|---|---|
| Cost per pair (no failures) | 1× | 3× | 1× |
| Cost per pair (3 failures, max iterations) | 4× | 6× | 4× |
| LOC delta vs current | ~+200 | ~+600 | ~+250 |
| Heritage flag complexity | low | high | low |
| Eval scoreability | 1 telemetry / 3 scorers | 3 telemetries / 3 scorers | 1 telemetry / 3 scorers |
| Independent prompt iteration | partial | full | partial (via prompt sections) |
| Reuses existing surface | full | partial | full |

Shape 3 is the cleanest mirror of PR 3.4a/b's "single-agent first, expand if needed" lock.

### B.3 Tool-schema delta

[`EMIT_TRANSFORM_SQL_TOOL`](../../lib/ai/tool-schemas.ts#L1452) currently emits `{ sql, description, source_columns, target_column, joins }`. Phase 3.5 extends:

```jsonc
{
  "needs_transformation": "boolean — explicit AI classification (overrides mapping-time signal when present)",
  "transformation_category": "enum: type_coercion | null_handling | format_conversion | lookup | concatenation | splitting | computation | passthrough",
  "category_confidence": "0-100",
  "sql": "...existing...",
  "description": "...existing...",
  "source_columns": "...existing...",
  "target_column": "...existing...",
  "joins": "...existing..."
}
```

Behaviour: when `needs_transformation === false`, the agent MUST emit `transformation_category = "passthrough"` and `sql = "row_data->>'<src>'"` (or empty string — TBD per OQ). When `needs_transformation === true`, all other fields are required.

---

## §C — Dry-run verification loop architecture

### C.1 Loop shape

```
   ┌───────────────────────────────────────────────────────┐
   │  generateTransform(fieldMappingId, description)       │
   │                                                        │
   │  ┌──────────────────────────────────────────────────┐  │
   │  │  iteration 0:                                     │  │
   │  │  buildAIContext + AI call (Shape 3)              │  │
   │  │  → SQL_v0 + classification + category            │  │
   │  └──────────────────────────────────────────────────┘  │
   │                       │                                 │
   │                       ▼                                 │
   │  ┌──────────────────────────────────────────────────┐  │
   │  │  execute_transform_full_test(SQL_v0)             │  │
   │  │  → { totalRows, passedRows, failedRows,          │  │
   │  │      failures[≤20] }                             │  │
   │  └──────────────────────────────────────────────────┘  │
   │             │                                  │        │
   │      failedRows == 0                  failedRows > 0    │
   │             │                                  │        │
   │             ▼                                  ▼        │
   │       persist + status='tested'    iteration ≥ N max?   │
   │                                          │              │
   │                                yes:    persist v_last  │
   │                                  +    status='draft'   │
   │                                  +    surface failures │
   │                                  no:                    │
   │                                  ┌──────────────────┐   │
   │                                  │ AI correction:   │   │
   │                                  │ feed failures +  │   │
   │                                  │ SQL_v_n →        │   │
   │                                  │ SQL_v_(n+1)      │   │
   │                                  └──────────────────┘   │
   │                                          │              │
   │                                          └─────────┐    │
   │                                                    │    │
   │                              ◄────────loop─────────┘    │
   └───────────────────────────────────────────────────────┘
```

### C.2 Locks needed

| Lock | Recommendation | Rationale |
|---|---|---|
| **Sample size for dry-run** | Full table for the 0th run; full table on each correction iteration. | `execute_transform_full_test` already runs the whole table with a 60s `statement_timeout` per call; failures cap at 20. No need to sample — the work is already bounded. Sampling is *less* useful here than for mapping because a transform that fails on row 547 of 10 000 still produces a structured failure the AI can correct. |
| **Max iterations** | **N = 3 corrections** (= 4 LLM calls total: initial + 3 corrections). | Past N=3, marginal correction yield drops sharply; almost all real failures stem from a misread of one or two specific rows that the first correction either fixes or surfaces as fundamentally ambiguous. Cap aligns with PR 3.4cd's per-pair iteration ceiling. |
| **Wall-clock cap** | **≤180s per pair** (3 × 60s RPC timeout, plus ~15s AI overhead). | Bounds worst-case latency. Per-pair LLM cost cap (OQ7 below) is the orthogonal control. |
| **Failure-to-AI shape** | Pass top-5 of the 20 captured failures back: `{ row_number, source_value, error_message }`. | 5 is enough for the AI to spot the pattern; passing all 20 inflates input tokens with diminishing yield. |
| **Give-up policy** | After N exhausted, persist the LAST SQL the AI produced (not the failing one — but the most-recent attempt) with `status='draft'`, attach the test_results JSONB with the latest failures, and surface a `loop_exhausted` flag in the action result. | User sees "AI tried 3 corrections; last attempt still has 47 failures — please refine the description". |
| **Where dry-run runs** | Postgres SECURITY DEFINER function (`execute_transform_full_test`). Already exists. | Stays in the DB tier; no app-server-side SQL execution. Re-uses the keyword + access guards already in place. |
| **Error structuring** | Raw Postgres `SQLERRM` per failure. | Postgres errors are typically self-explanatory ("invalid input syntax for type numeric: 'N/A'"). No additional parsing needed for the AI. |
| **Cost estimation** | Worst case per pair: 4 calls × ~$0.03/call (Sonnet 4.6) ≈ $0.12. Best case: 1 call ≈ $0.03. | Accept the upper bound. Per-migration: 100 pairs × $0.12 worst case = $12. Pilot-scale acceptable. |

### C.3 Correction prompt template (sketch)

```
<previous_attempt>
The following SQL was generated:
${SQL_v_n}

It failed on ${failedRows} of ${totalRows} rows. Top 5 failures:
${failures.slice(0, 5).map(f =>
  `  row ${f.rowNumber}: source_value="${f.sourceValue}" → error: ${f.errorMessage}`
).join('\n')}
</previous_attempt>

<correction_instruction>
Modify the SQL to handle these failure patterns. Common patterns:
- "invalid input syntax for type numeric" → add a regex guard before ::numeric cast
- "value too long for type" → add LEFT() truncation
- "date/time field value out of range" → add format detection + branch
- "null value in column violates not-null constraint" → add a NULL fallback (only if the description allows it)

Re-emit a complete SQL expression. Do NOT explain — emit only the corrected expression via the tool.
</correction_instruction>
```

### C.4 Per-iteration telemetry

Each loop iteration is a separate `llm_calls` row tagged with `metadata.iteration: 0|1|2|3` and `metadata.dry_run_failures: <count>` (when iteration > 0). Telemetry consumers (cost reports, eval harness) get visibility per-iteration without new RPCs.

---

## §D — Per-field "Transform Needed" classification

### D.1 Asymmetric failure modes (founder's framing)

| Outcome | User impact | Cost |
|---|---|---|
| **False negative** ("no transform needed" when actually needed) | User pushes data → execution-time error → migration aborts | **High — customer-visible bad** |
| **False positive** ("transform needed" when actually fine) | User wastes time defining unnecessary transform | **Low — annoying but not catastrophic** |

Bias toward over-flag is the right default. The existing 4-step `fieldNeedsTransform` heuristic ([transform-helpers.ts:121-129](../../lib/utils/transform-helpers.ts#L121-L129)) already does this: NULL classification falls through to "needs transform" *unless* same-type direct-compatible at confidence ≥ 90.

### D.2 Where classification happens (current vs proposed)

**Current**: classification is emitted by the *mapping* agent ([mapping-engine.ts:234-245](../../lib/ai/mapping-engine.ts#L234-L245)) and persisted on `target_field_mappings.needs_transformation` at mapping-approval time.

**Proposed for Phase 3.5**: classification is also emitted by the *transform* agent (Shape 3 from §B, via the extended `EMIT_TRANSFORM_SQL_TOOL`). When transform-agent emits `needs_transformation`, the persisted value on TFM is updated *only if* the prior signal was NULL or AI-true (never overrides a user dismissal — preserves the migration 075 invariant).

### D.3 Confidence emission

Tool-schema delta in §B.3 adds `category_confidence: 0-100`. Proposed UI mapping:

| Confidence | UI |
|---|---|
| ≥ 90 | Plain "Define" tag (current behaviour) |
| 50-89 | "Define (uncertain)" tag with hover-tooltip showing the AI's hesitation reasoning |
| < 50 | "Define ⚠️" tag — strong signal that the user should review the AI's classification first |

UI changes are out of scope for the first PR (PR 3.5.A) but the data-layer surface is included now so a follow-up PR can wire UI without a second migration.

### D.4 Classification eval fixture suggestion

Path 2 PR 1's `eval_validation_rule` and `eval_mapping_suggestion` fixtures show the pattern. New Phase 3.5 fixture set: `tests/eval/datasets/_fixture/examples/transform-needed/` with hand-authored cases covering:
- `001-direct-passthrough.json` — VARCHAR(50) → VARCHAR(100), same semantic, expected `needs_transformation: false`
- `002-numeric-coercion.json` — VARCHAR (with `$1,234.56` samples) → DECIMAL(15,4), expected `needs_transformation: true`
- `003-boolean-normalize.json` — VARCHAR (mixed Y/N/yes/no) → BOOLEAN, expected `needs_transformation: true`
- `004-date-format-mixed.json` — VARCHAR (mixed MM/DD/YYYY + DD/MM/YYYY samples) → DATE, expected `needs_transformation: true`
- `005-ambiguous-uppercase.json` — VARCHAR (mostly uppercase, some lowercase) → VARCHAR (target uses case-sensitive picklist), expected `needs_transformation: true` with `category: format_conversion`
- `006-passthrough-but-ai-might-overflag.json` — INT → BIGINT, expected `needs_transformation: false` (PostgreSQL implicit cast)

---

## §E — Transform category enumeration + per-category SQL templates

The existing system prompt ([transformations.ts:989-1084](../../lib/actions/transformations.ts#L989-L1084)) implicitly covers all the categories below. Phase 3.5 enumerates them in the tool schema (`transformation_category` enum) and adds per-category eval scorers.

### E.1 Category catalogue

| # | Category | Source/target signal | SQL skeleton (PostgreSQL) | Edge cases |
|---|---|---|---|---|
| 1 | **type_coercion** | source / target data_type differ; source profile shows values matching target type pattern | `CASE WHEN row_data->>'X' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (row_data->>'X')::numeric ELSE NULL END` | Empty string, "N/A" sentinels, scientific notation, currency symbols |
| 2 | **null_handling** | target NOT NULL; source has nulls or empty strings | `COALESCE(NULLIF(TRIM(row_data->>'X'::text), ''), '<default>')` | "default" must come from business context or be explicit user instruction; never invent |
| 3 | **format_conversion** | values exist but format mismatches (date layout, casing, separator) | Date: CASE+regex per format ([transformations.ts:1029-1050](../../lib/actions/transformations.ts#L1029-L1050)). Casing: `INITCAP(LOWER(row_data->>'X'))`. Phone: `REGEXP_REPLACE(row_data->>'X', '[^0-9+]', '', 'g')`. | Mixed formats in one field; localisation differences (DD/MM vs MM/DD) |
| 4 | **lookup** | source FK column → target needs the joined value | Today: requires the `dq_apply_field_transform_joined` cross-table path + `<contributing_source_fields>` block. SQL still operates on the dominant table; joined refs use `<alias>.row_data->>'<field>'`. | FK direction (one-to-many would multiply rows — reject); orphan FKs |
| 5 | **concatenation** | many-to-one mapping (`first_name` + `last_name` → `full_name`) | `TRIM(CONCAT_WS(' ', NULLIF(TRIM(row_data->>'first_name'), ''), NULLIF(TRIM(row_data->>'last_name'), '')))` | All-null inputs (CONCAT_WS handles); leading/trailing whitespace |
| 6 | **splitting** | one-to-many mapping (`full_name` → `first_name`, `last_name`) | First: `SPLIT_PART(row_data->>'full_name', ' ', 1)`. Last: `SUBSTRING(row_data->>'full_name' FROM POSITION(' ' IN row_data->>'full_name') + 1)`. | Single-token names; multi-word last names; titles ("Dr. ", "Jr.") |
| 7 | **computation** | derived value (currency stripping, hashing, derived ID) | `(REGEXP_REPLACE(row_data->>'amount', '[$,]', '', 'g'))::numeric` for currency cleanup; `MD5(row_data->>'X')` for hashing. | Locale-specific separators (1.234,56 vs 1,234.56); NULL through hash |
| 8 | **passthrough** | `needs_transformation === false` | `row_data->>'X'` (or empty SQL — TBD per OQ; see §J) | None — this is the no-op category |

### E.2 Per-category eval-fixture sketch

`tests/eval/datasets/_fixture/examples/transform/` is the existing scope. New fixtures:

- `010-type-coerce-currency.json` — VARCHAR `"$1,234.56"` → DECIMAL(15,4); expects regex-guarded numeric cast
- `011-type-coerce-empty-string.json` — VARCHAR `""` → INT; expects `NULLIF` + cast
- `012-null-handling-default.json` — TEXT NULL → TEXT NOT NULL with documented default; expects COALESCE
- `013-format-date-mixed.json` — VARCHAR (mix of MM/DD/YYYY and DD/MM/YYYY) → DATE; expects CASE+regex per format
- `014-format-bool-normalize.json` — VARCHAR (Y/N/yes/no/1/0) → BOOLEAN; expects CASE expression
- `015-format-casing.json` — VARCHAR mixed case → VARCHAR INITCAP target; expects INITCAP/LOWER
- `016-format-phone.json` — VARCHAR `"(415) 555-1234"` → VARCHAR E.164; expects REGEXP_REPLACE
- `017-many-to-one-name.json` — first_name + last_name → full_name; expects CONCAT_WS
- `018-one-to-many-name.json` — full_name → first_name; expects SPLIT_PART
- `019-computation-currency.json` — VARCHAR amount → DECIMAL revenue; expects strip+cast
- `020-computation-hash.json` — VARCHAR PII → CHAR(32) hashed_id; expects MD5

Per Phase 2 PR 1's pattern, each fixture has a gold answer + per-row source data, and the scorer measures both:

- **classification correctness** — `needs_transformation` matches gold
- **SQL correctness** — `dry-run on a small synthetic dataset passes 100%`

---

## §F — Input-layer integration (INV-1 alignment)

Per [INV-1 §B.3](./inv1-input-prioritization.md#b3), the existing transform agent is well-aligned with three of four input-layer tiers:

| Tier | Source | Status in transform agent today |
|---|---|---|
| **P1** User schema overview edits | Field row carries post-edit values. **`schema_source` provenance label NOT emitted in prompt** ([context-builder.ts:300](../../lib/ai/context-builder.ts#L300)) — same gap as every other agent. | INV-1 PR-A would close this with the `AGENT_PROVENANCE_GUIDANCE` shared block. |
| **P2** Schema docs | `<schema_documentation>` block via [`formatDocumentsForPrompt` (transformations.ts:1223)](../../lib/actions/transformations.ts#L1223). | ✓ Wired |
| **P3** Business docs | `<business_context>` block via the same formatter. | ✓ Wired |
| **P4** Raw data | Field profiles + value distributions + sample values via `buildAIContext` ([transformations.ts:1208-1220](../../lib/actions/transformations.ts#L1208-L1220)). Transform needs MORE raw data than mapping (it generates SQL operating on actual values), and indeed already requests `maxDistributionValues: 25` (vs mapping's 15). | ✓ Wired |

### F.1 Should Phase 3.5 wait for INV-1 PR-A?

**No — proceed with current input layer.** PR-A adds the `[manual]` provenance flag which is useful but not load-bearing for transform. Transform agents read the *value* of a field (post-edit), not the provenance. The user's edited type / nullable / FK is already what the transform agent sees; the provenance label is only useful when the doc and the schema disagree (P1 vs P2 conflict).

If PR-A merges before Phase 3.5 Phase B begins, Phase 3.5 inherits the new provenance flag for free via the shared block. If not, Phase 3.5 ships with current input layer; PR-A's adoption is a one-line system-prompt prefix add.

### F.2 Transform iteration ("Pass Existing SQL")

**Already wired** ([transformations.ts:1259-1275](../../lib/actions/transformations.ts#L1259-L1275)). When user updates the description, prior SQL is passed back as `<existing_sql>` + `<iteration_instruction>` block. **In scope for Phase 3.5** — the dry-run loop's correction iterations should re-use this same surface (the correction iteration IS a "previous SQL was X, here's why it failed" instruction).

### F.3 "Claude explains why" rationale comments

**Recommend deferred.** The existing tool schema already has a `description` field carrying a one-line plain-English summary ([tool-schemas.ts:1466-1469](../../lib/ai/tool-schemas.ts#L1466-L1469)). Persisting that into a UI tooltip is small UI work, but adding richer SQL-level rationale comments (per-clause `/* explanation */`) ramps complexity. Defer to Phase 3.5.B or later — the dry-run loop is the pilot-critical piece.

### F.4 INV-1 carry-over gaps

Three INV-1 findings affect the transform agent and could be closed in Phase 3.5 if scope allows:

| Gap | Impact on transform | Recommendation |
|---|---|---|
| `validation_rules` not visible to transform agent (INV-1 §B.8) | If user has a "must match SSN format" rule, transform doesn't see it; AI may emit SQL that produces strings violating the rule. | **Defer to PR-Q8 (post-INV-1 follow-up).** Out of scope for Phase 3.5. |
| `projects.business_context` dormant in production (INV-1 §A.4) | Free-text business context not surfaced. | Out of scope for Phase 3.5. |
| `fields.description` no UI editor (INV-1 §A.5) | If DDL had `COMMENT ON COLUMN`, transform sees it; otherwise blank. | Out of scope for Phase 3.5. |

---

## §G — Cache strategy

Transform may run for 100s of source-target pairs per migration. Caching is **more critical** than mapping because of the larger system prompt + tighter per-pair work.

### G.1 Cacheable prefix vs dynamic tail

| Section | Cacheable? | Rationale |
|---|---|---|
| `TRANSFORM_SYSTEM_PROMPT` (~5K tk) | **Yes** | Content-static across invocations. Already cached: [transformations.ts:1352](../../lib/actions/transformations.ts#L1352). |
| `EMIT_TRANSFORM_SQL_TOOL` schema (~1.5K tk) | **Yes** | Static. Implicit in `cacheControl: true`. |
| `<source_field>` / `<target_field>` blocks | **No** | Per-pair. |
| `<contributing_source_fields>` (many-to-one) | **No** | Per-pair. |
| `transformDocBlock` (`<schema_documentation>` + `<business_context>`) | **Mostly cacheable** within a migration project — same docs, ~static across pairs. | Today: not separately cached because cache-key boundary is the system prompt only. Phase 3.5 could split: `cacheControl: true` on system + project-level docs prefix; per-pair tail uncached. Anthropic's prompt-cache cohort already does this for `mapping_generate` per [PR 13.1](./pr13-prompt-caching.md). |
| `intelligence_context` | **Partially** | Per-user, per-project. Same across pairs in a single migration. |
| `<existing_sql>` + `<iteration_instruction>` | **No** | Refinement-only; per-pair. |
| `<description>` | **No** | Per-pair user text. |
| Correction-iteration `<previous_attempt>` block | **No** | Per-iteration. |

### G.2 Cache savings estimate

Without splitting cache zones (current behaviour): cache hit only on `TRANSFORM_SYSTEM_PROMPT` + tool schema. Per pair: ~6.5K cached input tokens; ~2-3K uncached input tokens; ~500-1000 output tokens.

With per-project cache zone (recommended for Phase 3.5): cache hit on system + tool + project docs. Per pair: ~9-15K cached; ~1-2K uncached; ~500-1000 output.

Cost per pair (Sonnet 4.6 @ $3/Mtok input, $15/Mtok output, cache reads at 10% of input rate):
- Today: ~$0.025/pair (read) + ~$0.012/pair (uncached input) + ~$0.012/pair (output) ≈ **~$0.05/pair**
- Phase 3.5 with project-level cache: ~$0.04/pair (read) + ~$0.005/pair (uncached) + ~$0.012/pair (output) ≈ **~$0.06/pair, but the read portion now includes project docs which today cost full uncached rate**
- Net improvement: 100-pair migration drops from ~$5 → ~$3.5 if doc-block is large; negligible if doc-block is small.

Recommendation: **start with current cache shape (system + tool only); add project-level cache zone in a follow-up sub-PR if telemetry shows doc-block re-tokenisation cost dominates**.

### G.3 Correction-loop cache hits

On correction iterations, the system prompt + tool + (optionally) project docs are all cache-hot. Only the small `<previous_attempt>` + `<correction_instruction>` blocks are uncached. Per correction: ~500 uncached input tokens + ~500 output. Marginal cost per correction ≈ $0.01.

3-correction worst case: $0.05 (initial) + 3×$0.01 (corrections) = **~$0.08/pair**. 100-pair worst case: $8.

---

## §H — Heritage gate strategy

### H.1 Existing transform path is in production

The current `generateTransform` ships in production today. ANY change to its behaviour (prompt edits, dry-run loop activation, classification refinement) potentially regresses customer-visible output.

### H.2 Proposed flag

**`AI_PHASE_3_5_ENABLED`** (exact-match `'1'`, default OFF). Mirrors `AI_PHASE_3_ENABLED` semantics (per [CLAUDE.md §4.5.1](../../CLAUDE.md)). Heritage flag-OFF byte-identical preserved as long as the flag stays unset.

When flag = OFF: existing `generateTransform` path runs unchanged. No dry-run loop. No classification refinement. No category emission.

When flag = ON: new wrapper engages — initial generation goes through the extended tool schema, dry-run loop activates, category metadata persisted.

### H.3 Heritage captures

Mirror PR 3.4cd / 3.4e structure:

| Capture | Flag combo | Expected |
|---|---|---|
| **A** — all flags OFF | (default) | rowsFingerprint + sourceFieldsFingerprint match pre-mutation |
| **B** — `AI_PHASE_3_5_ENABLED=1`, no project flag | (same project, transform-agent flag ON) | Read-path heritage byte-identical (transform-write tests run with mocked LLM) |

Existing transform-heritage tests at [tests/integration/transforms-heritage.test.ts](../../tests/integration/transforms-heritage.test.ts) and [tests/integration/transform-apply-cross-table-heritage.test.ts](../../tests/integration/transform-apply-cross-table-heritage.test.ts) exercise the apply path; they should remain byte-identical since `AI_PHASE_3_5_ENABLED` only affects `generateTransform` (the LLM stage).

### H.4 Default state in dev / prod

| Environment | Default | Rationale |
|---|---|---|
| `.env.development` | `1` | Engineering iterations against real fixtures from day 1. |
| `vercel.json` (production) | `0` | Default-off until Phase 3.5.C cohort eval clears the SC bar (mirrors PR 3.4cd default-off lock). |

---

## §I — Risk catalog

### R1 — SQL injection via AI-generated SQL

**Vector**: AI emits SQL containing string concatenation that includes user-controlled data, executed by `execute_transform_full_test`.

**Existing mitigations** ([migration 043:140-152](../../supabase/migrations/043_null_safe_apply_and_window_guard.sql#L140-L152)):
- Reject DDL/DML keywords (`insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute`)
- Reject `pg_catalog|information_schema|auth\.|storage\.`
- Reject access to `projects|datasets|field_mappings|table_mappings|quality_issues|fix_history|fix_snapshots|validation_rules`
- Reject semicolons
- Reject window functions
- `statement_timeout = '60s'`
- `wrapWithNullGuard` post-processing

**Phase 3.5 additional mitigations**:
- Tool-schema validation: `EMIT_TRANSFORM_SQL_TOOL` description forbids `SELECT`/`FROM`/`WHERE` keywords; the validator at app layer enforces.
- Correction-iteration prompt does NOT echo failure messages directly into a future `EXECUTE` — failures are passed as text in the user message, which is then re-emitted by the AI as a tool input, then validated. The "round-trip" through the tool ensures no escape.

**Residual risk**: low. Migration 043 is mature; PR 3.5 doesn't change the security perimeter.

### R2 — Dry-run loop infinite recursion

**Vector**: AI emits SQL that fails, system feeds failures back, AI emits same-or-similar SQL, loop never converges.

**Mitigation**: Hard cap N = 3 corrections (= 4 total LLM calls per pair). After N exhausted, persist last attempt as `'draft'` and surface failures to user.

### R3 — Per-pair cost runaway

**Vector**: Bulk path `autoGenerateAllTransforms` runs over 1000 pairs; each hits 3-correction worst case; total cost = 1000 × $0.08 = $80 per migration run.

**Mitigation**:
- Per-pair cap: `PER_PAIR_MAX_COST_USD = 1.5` (mirrors PR 3.4cd).
- Per-bulk-run cap: open question (OQ7) — recommend `PER_RUN_MAX_COST_USD = 100` as a safety net for wild bulk runs.

### R4 — Transform inherits INV-1 input-layer gaps

**Vector**: User-edited schema overview not surfaced; user's `validation_rules` not visible; `projects.business_context` empty in production.

**Impact**: AI emits SQL that doesn't account for user-authoritative signals. Goal 2 (correctly identify what transformation is needed) and Goal 3 (correct SQL) both degrade.

**Mitigation**:
- INV-1 PR-B already wired `formatDocumentsForPrompt` into validation rules (orthogonal — doesn't help transform).
- INV-1 PR-A would fix P1 invisibility for ALL agents; if it merges before Phase 3.5 Phase B, transform inherits.
- For Phase 3.5 PR scope: ACCEPT this gap. Document it in the Phase 3.5 final report; revisit in PR 3.5 follow-up if cohort eval shows P1-related failure modes.

### R5 — Sample-row dry-run gives false confidence

**Vector**: `execute_transform_full_test` runs ALL rows but caps captured failures at 20. If row 547 of 50 000 fails for a unique reason and rows 21-46 also fail (totalling 27), only the first 20 are returned to the AI. The AI corrects for those 20; the unmentioned 21-27 may persist.

**Mitigation**:
- `failedRows` is the AUTHORITATIVE signal — if `failedRows > 0` after the loop terminates, surface the count even if the failures array is truncated.
- After loop terminates, re-run `execute_transform_full_test` once more (already cheap; no LLM call). If `failedRows > 0` STILL, the loop "failed" — surface to user with the latest failure list + count.

### R6 — Cache pollution if prompt template changes mid-migration

**Vector**: A code change to `TRANSFORM_SYSTEM_PROMPT` mid-deploy invalidates the cache; for ~24h users see full uncached-input cost on every transform call.

**Mitigation**: standard PR 13.1 posture — system prompt is content-hash-keyed; deploys flush cache. Document in CLAUDE.md AI flag block (already implicit). No new mitigation needed.

### R7 — User edits SQL after AI generation; how do we track provenance?

**Vector**: AI generates SQL_v0, user edits to SQL_v0_edited via `updateTransformSQL`. Now `transformations.generated_sql` differs from `transformations.original_ai_generated_sql` ([transformations.ts:1416](../../lib/actions/transformations.ts#L1416)). On re-generation (regenerate button), the AI gets fed `<existing_sql>` — but is that the AI's last attempt or the user's edit?

**Current behaviour** ([generateTransform existingSQL arg](../../lib/actions/transformations.ts#L1119)): the caller passes `existingSQL` from wherever it sourced. If the UI passes the `generated_sql` (current value), AI sees the user's edit. If the UI passes `original_ai_generated_sql`, AI sees its own first attempt.

**Phase 3.5 lock**: pass the CURRENT `generated_sql` (i.e., the user's edit if there was one) — the assumption is the user's edit is the new starting point. `original_ai_generated_sql` is for audit/eval only. `ai_edit_history` already captures the edit chain ([ai-edit-history.ts:55-77](../../lib/actions/ai-edit-history.ts#L55-L77)) so provenance is preserved without prompt-time complexity.

---

## §J — Open questions for principal review

| OQ | Question |
|---|---|
| **OQ1** | Lock Shape 3 (hybrid: one initial AI call + dry-run loop wrapper)? Or prefer Shape 2 (three separate stage calls) for independent iterability? |
| **OQ2** | Dry-run loop max iterations: locked at **N = 3** per §C.2? Or want a different ceiling? Founder's earlier remark on transform was "self-correcting" — does N=3 feel right for production? |
| **OQ3** | Transform iteration ("Pass Existing SQL" surface) — already wired; in scope to RE-USE for the correction loop, or build a separate correction-iteration-only path? Recommend re-use. |
| **OQ4** | "Claude explains why" — defer to a follow-up PR, or include rationale-comment generation in the first PR scope? Recommend defer. |
| **OQ5** | Wait for INV-1 PR-A (provenance flag) before starting Phase 3.5 Phase B, or proceed with current input layer? Recommend proceed; PR-A is a one-line system-prompt-prefix add when it lands. |
| **OQ6** | New env flag name + default: `AI_PHASE_3_5_ENABLED` per §H.2? Default ON in `.env.development`, OFF in `vercel.json`? |
| **OQ7** | Per-pair cost cap = `$1.50`? Per-bulk-run cap = `$100`? Or different ceilings? |
| **OQ8** | Tool-schema delta: extend `EMIT_TRANSFORM_SQL_TOOL` (recommended) or create a new `EMIT_TRANSFORM_PROPOSAL_TOOL` and keep the existing tool for pure-SQL emissions? Recommend extend; new fields are all optional and the existing apply path remains untouched. |
| **OQ9** | Classification refresh: when the transform agent's `needs_transformation` disagrees with the mapping-time signal, who wins? Mapping was first; transform has more context. Recommend transform-time signal overrides mapping-time signal **except** when the user has explicitly dismissed (dismiss is always authoritative). |
| **OQ10** | Per-category eval fixtures: ship 11 hand-authored fixtures per §E.2 in the first PR, or split into a follow-up? Recommend ship 6 in PR-A (covering the most common categories), 5 in PR-B. |
| **OQ11** | When `needs_transformation === false`, does the agent emit `sql = "row_data->>'X'"` (explicit passthrough) or empty string? Today's heuristic auto-skips draft creation when no transform exists; explicit passthrough creates a draft row that needs subsequent dismissal. Recommend empty string (preserves current dismiss-tag UX). |
| **OQ12** | Bulk-path cost: today `autoGenerateAllTransforms` runs sequentially. Phase 3.5 would inherit this. Should Phase 3.5 add Promise.all parallelism for the bulk path (with a concurrency limit), or keep sequential? Recommend keep sequential for the first PR; parallelism adds complexity + cost surprises. |

---

## §K — Phase B implementation sequencing

Multi-session estimate. Each session is one PR; PRs gate sequentially because the dry-run loop tests can't be authored until the loop exists.

### Session 1 — PR 3.5.A: Single-call hybrid path + dry-run loop

**Scope:**
- Extend `EMIT_TRANSFORM_SQL_TOOL` with the new fields per §B.3.
- Wrap `generateTransform` with the dry-run loop per §C.
- Add `AI_PHASE_3_5_ENABLED` flag plumbing per §H.
- Persist `transformation_category` on `transformations` rows (new migration column).
- Heritage gate: 2 captures (A all-OFF, B flag-ON).
- Source-text invariants in `transforms-refinements.test.ts`.
- One smoke fixture: `tests/eval/datasets/_fixture/examples/transform/100-dry-run-loop-smoke.json` exercising the loop's correction path.

**Cost cap:** $30 LLM (heritage runs no LLM; smoke fixture < $5; cohort baseline ~$15-25).

**Heritage gate:** Captures A + B byte-identical pre/post.

**Test count delta:** +20 to +30 (source-text pins + 1 smoke fixture).

### Session 2 — PR 3.5.B: Per-category eval fixtures + classification refinement

**Scope:**
- Hand-author 6 fixtures per §E.2 (categories 1-6: type_coerce / null_handling / format_conv / lookup / concat / split).
- Add `scoreTransformCategory` scorer to `lib/eval/scorers/`.
- Cohort baseline: `pnpm eval transform --dataset _fixture` × 3 runs to establish variance.
- Iteration on `TRANSFORM_SYSTEM_PROMPT` to refine classification accuracy if cohort baseline misses target.

**Cost cap:** $50 LLM (cohort × 3 × 6 fixtures × ~$0.06 per pair = ~$11; iteration cycles ~$30; final cohort confirmation ~$10).

**Heritage gate:** Captures A + B byte-identical (no new flag — operates under PR 3.5.A's flag).

**Test count delta:** +10 to +15 (eval scorers + fixture loaders).

### Session 3 — PR 3.5.C: Cohort eval validation + flag-flip decision

**Scope:**
- Final cohort eval over all 11 fixtures (PR 3.5.B's 6 + 5 new in §E.2).
- Compare to single-call (PR 3.5.A) baseline: did the dry-run loop measurably improve `failedRows == 0` rate?
- Per-fixture failure-mode report.
- Update `vercel.json` to flip `AI_PHASE_3_5_ENABLED=1` if cohort clears bar (SC: ≥80% per-category correct + ≥95% dry-run pass rate after loop).
- Update CLAUDE.md §11 (Current State) section.

**Cost cap:** $50 LLM.

**Heritage gate:** Captures A + B byte-identical (final post-Session-3 verification).

**Test count delta:** +5 to +10 (cohort eval scaffolding).

### Total Phase B estimate

- 3 sessions
- $130 LLM (target $100; ceiling $200 if iteration cycles run long)
- ~3 weeks engineer-effort with 1-2 days per session + review gate
- Net test count delta: +35 to +55

---

## §L — LOC delta estimate per session

| Session | File | Δ LOC | Notes |
|---|---|---|---|
| **PR 3.5.A** | `lib/actions/transformations.ts` | +180 | dry-run loop wrapper, classification persistence, correction-prompt builder |
| | `lib/ai/tool-schemas.ts` | +35 | extended `EMIT_TRANSFORM_SQL_TOOL` schema |
| | `lib/utils/transform-helpers.ts` | +15 | new helper for category enum + classification override logic |
| | `supabase/migrations/0XX_transformation_category.sql` | +30 | new column + CHECK constraint |
| | `lib/types/mapping-redesign.ts` | +5 | `TransformationCategory` enum |
| | `tests/actions/transforms-refinements.test.ts` | +60 | source-text pins for dry-run loop + classification |
| | `tests/eval/datasets/_fixture/examples/transform/100-*.json` | +50 | 1 fixture (gold + source data) |
| | `vercel.json` + `.env.development` | +2 | flag default |
| | `CLAUDE.md §4.5.1 + §11` | +25 | new flag entry + state update |
| | **Subtotal PR 3.5.A** | **~+400** | |
| **PR 3.5.B** | `tests/eval/datasets/_fixture/examples/transform/0{10..15}-*.json` | +300 | 6 fixtures × ~50 LOC each |
| | `lib/eval/scorers/transform-category.ts` | +60 | new scorer |
| | `lib/eval/scorers/transform-needed.ts` | +40 | new scorer |
| | `lib/eval/runner.ts` | +30 | wire scorers per Path 2 PR 1 pattern |
| | `lib/actions/transformations.ts` | +30 | prompt iteration (TRANSFORM_SYSTEM_PROMPT classification section) |
| | `tests/actions/transforms-refinements.test.ts` | +40 | classification accuracy pins |
| | **Subtotal PR 3.5.B** | **~+500** | |
| **PR 3.5.C** | `tests/eval/datasets/_fixture/examples/transform/0{16..20}-*.json` | +250 | 5 more fixtures |
| | `vercel.json` (flag flip) | +1 | |
| | `CLAUDE.md §11` | +10 | |
| | `docs/investigations/pr3.5-cohort-eval-results.md` | +200 | cohort eval report (new investigation appendix) |
| | **Subtotal PR 3.5.C** | **~+460** | |
| | **Phase B total** | **~+1 360** | |

PR 3.5.A is the load-bearing PR — flag-gated, byte-identical default, ships the dry-run loop. PR 3.5.B + C iterate prompt + add fixtures.

---

## §M — Recommended pre-flight checks before Phase B

Before starting PR 3.5.A:

1. **Lock principal answers to OQ1, OQ2, OQ6, OQ7, OQ11.** These shape the implementation directly.
2. **Verify INV-1 PR-A status.** If it merges first, Phase 3.5 inherits the provenance flag for free; otherwise document the deferral.
3. **Re-run heritage Captures A + B on `feat/inv1-validation-rule-context` baseline.** Establish the byte-identical reference *before* PR 3.5.A modifies anything.
4. **Capture pre-mutation eval baseline.** Run `AI_PHASE_2_ENABLED=1 pnpm eval transform --dataset _fixture` 3× to measure current single-call performance. Phase 3.5.B compares the loop vs this baseline.

---

*End of PR 3.5 Phase A investigation.*
