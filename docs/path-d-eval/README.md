# Path D eval framework

Sub-PR 6 (this directory) ships the framework that gates Phase C empirical
prompt iteration. Three components:

- **Scorer** ([lib/ai/path-d-eval/scorer.ts](../../lib/ai/path-d-eval/scorer.ts))
  — pure function `scorePathDOutput(actual, expected, weights?) → EvalScore`.
  Eight scoring dimensions, weighted aggregate.
- **Runner** ([lib/ai/path-d-eval/runner.ts](../../lib/ai/path-d-eval/runner.ts))
  — loads fixtures, calls Path D against each via `callLLMStreaming`, scores,
  formats report.
- **Fixtures** ([tests/fixtures/path-d-eval/](../../tests/fixtures/path-d-eval/))
  — three starter scenarios covering different domain profiles. Phase C adds
  more as needed.

This document is the **fixture-authoring guide**. Read it before adding a new
fixture.

---

## Running an eval

The runner is exposed as an env-gated integration test:

```bash
# Default: N=1 trial per fixture, all 3 fixtures, ~$1.70
RUN_PATH_D_EVAL=1 pnpm test:integration path-d-eval-runner

# N=3 trials for variance-aware comparison (Phase C iteration), ~$5
RUN_PATH_D_EVAL=1 PATH_D_EVAL_TRIALS=3 pnpm test:integration path-d-eval-runner

# Single fixture (faster iteration), ~$0.40-0.80
RUN_PATH_D_EVAL=1 PATH_D_EVAL_FIXTURE=crm-sf-to-hubspot pnpm test:integration path-d-eval-runner

# Dump full JSON report for trend tracking
RUN_PATH_D_EVAL=1 PATH_D_EVAL_JSON_OUT=/tmp/eval-baseline.json pnpm test:integration path-d-eval-runner
```

The runner uses the canonical `callLLMStreaming` wrapper, so eval costs land
in `llm_calls` with `feature='eval_path_d'` and don't pollute production cost
reports.

### Output format

The runner emits a console-friendly report after the run completes:

```
Path D eval — 3 fixture(s) × 1 trial(s)

  crm-sf-to-hubspot
    mapping_accuracy             0.917    weight 0.25
    combination_type             1.000    weight 0.10
    coverage_completeness        0.889    weight 0.20
    decision_recall              1.000    weight 0.10
    lookup_recall                1.000    weight 0.10
    dq_recall                    1.000    weight 0.10
    inferred_targets_recall      1.000    weight 0.05
    output_completeness          1.000    weight 0.10
    ─────────────────────────────────────────────
    AGGREGATE                    0.949
    cost: $0.42   duration: 287.3s

  erp-rootstock-style
    ...

OVERALL — mean aggregate: 0.86  cost: $1.78  duration: 858.4s
```

Per-dimension scores show where the prompt regresses; the aggregate is the
headline metric Phase C iteration tracks.

---

## Scoring dimensions

Eight dimensions, weighted aggregate. Default weights sum to 1.00.

| # | Dimension | Weight | What it measures |
|---|---|---|---|
| 1 | `mapping_accuracy` | 0.25 | F1 over `(target_field_id, set(source_field_ids))` pairs. Set semantics on source ids — order-invariant. |
| 2 | `combination_type` | 0.10 | For each mapping that matches on field-pair, did the AI pick the right `combination_type` (single / concat_space / concat_comma / custom_sql)? |
| 3 | `coverage_completeness` | 0.20 | F1 over `(target_field_id, coverage_status)` pairs. Penalises both missing entries AND wrong-status entries. |
| 4 | `decision_recall` | 0.10 | Recall over expected `decision_type` values (case-insensitive). Recall-only — extras don't hurt. |
| 5 | `lookup_recall` | 0.10 | Recall over expected lookup-table `name` values (case-insensitive). |
| 6 | `dq_recall` | 0.10 | Recall over expected `(source_field_id, category)` pairs. |
| 7 | `inferred_targets_recall` | 0.05 | Recall over expected `inferred_target_object` names (case-insensitive). |
| 8 | `output_completeness` | 0.10 | Fraction of 7 sections that returned `parsed_ok`. |

### Why recall-only for decisions / lookup / DQ / inferred_targets?

Path D's value is partly in **surfacing judgment opportunities the customer
didn't think to raise.** Penalising the AI for finding extras would punish
exactly what we want to encourage. The "AI proposes → human approves"
architecture lives in this asymmetry. Coverage and mapping are F1 because
the AI shouldn't invent fields — but decisions/DQ/lookup are open-ended.

### Why hard scoring (no semantic similarity on free-text)?

`ai_reasoning`, `transformation_intent`, and `description` fields aren't
scored. They're for human review, not measurement. If Phase C wants
embedding-cosine on `ai_reasoning`, that's a future addition — but starting
with structural-only scoring keeps the signal-to-noise high.

### Custom weights

Phase C iteration may want to weight specific dimensions higher when
focusing on a known weakness. Pass a custom weights object:

```ts
import { runEvalSuite } from '@/lib/ai/path-d-eval/runner'
import { DEFAULT_WEIGHTS } from '@/lib/ai/path-d-eval/types'

const weights = {
  ...DEFAULT_WEIGHTS,
  mapping_accuracy: 0.40, // double-weight mapping accuracy
  coverage_completeness: 0.30,
  combination_type: 0.05,
  // ... rest stay at defaults; ensure sum is still 1.00
}

const report = await runEvalSuite({ weights })
```

Weights must sum to 1.00 to be comparable across runs — the runner trusts
the input but documents the contract.

---

## Cost considerations

| Setup | Per fixture | Per run |
|---|---|---|
| N=1, all 3 fixtures | $0.40-0.80 | ~$1.70 |
| N=3, all 3 fixtures | $1.20-2.40 | ~$5 |
| N=1, single fixture | $0.40-0.80 | ~$0.50 |

When to bump trial count:
- **Day-to-day iteration:** N=1 keeps feedback fast and cheap.
- **Comparing two prompt versions head-to-head:** N=3 captures variance;
  one prompt scoring 0.85 ± 0.04 vs another scoring 0.83 ± 0.06 isn't a
  meaningful difference at N=1.
- **Final pre-merge gate for a Phase C prompt revision:** N=3 minimum.

Cost is roughly linear in `trials × fixtures × prompt_complexity`. The
v0 prompt costs ~$0.60 per fixture; if Phase C adds substantial prompt
content, expect costs to climb.

---

## Adding a new fixture

A fixture is a **directory** under `tests/fixtures/path-d-eval/<fixture-name>/`
containing 5 files.

### Required files

```
<fixture-name>/
  source-schema.json       # Source-side schema (tables + fields with UUIDs)
  target-schema.json       # Target-side schema (tables + fields with UUIDs)
  sample-data.json         # Optional per-field sample value distributions
  business-context.md      # Free-form markdown describing the migration
  expected-output.json     # Gold-standard Path D output (the scorer's "right answers")
```

### File: `source-schema.json` / `target-schema.json`

```json
{
  "tables": [
    {
      "id": "<UUID>",
      "name": "<table_name>",
      "fields": [
        {
          "id": "<UUID>",
          "name": "<field_name>",
          "data_type": "<sql_type>",
          "is_nullable": false,
          "is_primary_key": true,
          "description": "<free-form>"
        }
      ]
    }
  ]
}
```

**Field UUIDs are load-bearing.** The scorer matches on `target_field_id`
and `source_field_ids` byte-for-byte against the model's emitted UUIDs.
Hand-author them to be unique within the fixture; convention used by the v0
fixtures is `<fixture-prefix>-0000-4000-8000-<sequence>` (e.g.,
`f1000000-0000-4000-8000-000000000001` for fixture 1's first source field).

### File: `sample-data.json` (optional)

Map of field-id → array of `{value, count}` tuples representing the
field's value distribution. Used to drive the `value_distribution` /
`sample_values` surface in the prompt.

```json
{
  "<field-id>": [
    { "value": "Open - Not Contacted", "count": 12 },
    { "value": "Working - Contacted",  "count":  8 }
  ]
}
```

Include sample data for fields where the AI's output should be informed by
realistic value patterns (status enums, format examples, edge cases).
Omit fields where samples don't add signal.

### File: `business-context.md`

Free-form markdown describing:

- The customer's overall migration goal
- Why the source/target schemas differ (system swap, normalisation,
  consolidation)
- Known data-quality concerns the migration must handle
- Out-of-scope items
- Any customer-specific judgment calls (dedup tiebreakers, default values)

This file flows verbatim into the prompt's `business_context_documents`
slot. Treat it as the customer's PM-style brief to a consulting engineer —
the AI reads this to understand intent.

### File: `expected-output.json`

The gold standard. The scorer reads only the typed fields; everything else
(including `_authoring_notes`) is ignored.

```json
{
  "_authoring_notes": "...",
  "mappings": [
    {
      "target_field_id": "<UUID>",
      "source_field_ids": ["<UUID>", "<UUID>"],
      "combination_type": "single" | "concat_space" | "concat_comma" | "custom_sql"
    }
  ],
  "coverage": [
    {
      "target_field_id": "<UUID>",
      "coverage_status": "covered" | "partial" | "gap" | "optional" | "out_of_scope"
    }
  ],
  "decisions": [
    { "decision_type": "<short_tag>" }
  ],
  "lookup_tables": [
    { "name": "<lookup_name>" }
  ],
  "data_quality": [
    {
      "source_field_id": "<UUID>" | null,
      "category": "<short_tag>"
    }
  ],
  "inferred_targets": [
    { "inferred_target_object": "<entity_name>" }
  ],
  "project_notes_expected": true
}
```

**Free-text fields are intentionally absent.** The scorer doesn't grade
`ai_reasoning`, `transformation_intent`, etc. — those exist for human review
of the model's actual output, not for scoring.

#### Canonical `decision_type` vocabulary (Phase C iter 1)

The system prompt instructs the model to prefer one of 12 canonical
`decision_type` values for each decision it surfaces. Fixture
`expected-output.json` files MUST use these canonical values too — the
scorer matches case-insensitive exact-string, so a fixture using
`uom_normalization` won't match a model emitting `value_normalization`.

| canonical | what it covers |
|---|---|
| `value_normalization` | converting source values to canonical target form (UOM codes, status enums, case normalization, currency assumptions) |
| `unit_conversion` | numeric unit conversion (g→kg, cents→dollars) |
| `enum_mapping` | translating source vocabulary to target via lookup table (LeadStatus → lifecycle_stage, item-type code → label) |
| `aggregation_strategy` | combining multiple source rows/values into one target (sum across warehouses, source-priority for multi-source dedup) |
| `duplicate_resolution` | how to dedupe when source has duplicate keys |
| `default_value` | what to fill when source is null or missing |
| `scope_filter` | what subset of source data to include/exclude |
| `external_dependency` | relies on data outside this migration's scope (vendor mapping, user-id resolution) |
| `data_quality_handling` | how to treat malformed source rows (invalid emails, format violations) |
| `schema_interpretation` | how to parse a free-form or ambiguous field |
| `precision_loss` | handling truncation, rounding, type narrowing |
| `platform_behaviour` | target-platform constraint or expectation (Salesforce-managed timestamps, trigger requirements) |

The model is instructed to use the closest match and only emit a non-canonical
value (snake_case, ≤3 words) when none fits. When a fixture's expected
decision genuinely doesn't fit any canonical value, it's acceptable to use
a custom value in the fixture — but be aware the model is unlikely to
spontaneously emit the same custom value, so recall on that decision will
likely be 0 unless the prompt is also tuned to emit it.

The Phase C iter 1 single-trial empirical comparison validated this
vocabulary: prompt change with strict canonical list raised
`decision_recall` mean from 0.278 → 0.694 (+0.42) without aggregate
regression. See the iter 1 commit body (`feat(ai): Phase C iter 1 —
decision_type vocabulary alignment`) for the per-fixture deltas.

#### Canonical lookup naming convention (Phase C iter 2)

The system prompt instructs the model to name lookups along the
SOURCE-TO-TARGET axis using the `<source_concept>_to_<target_concept>`
pattern (snake_case). Fixture `expected-output.json` files MUST follow the
same convention — the scorer matches case-insensitive exact-string on
lookup `name`, so a fixture using `casing_normalization_lookup` won't
match a model emitting `product_group_to_category`.

Source concept and target concept can each be a field name, a
value-domain label, or a target-system name — whichever most cleanly
identifies the endpoints. The axis is the SOURCE-TO-TARGET endpoint
pair, not the transformation type the lookup performs.

| pattern | example |
|---|---|
| source field → target field | `lead_status_to_lifecycle_stage` |
| source field → target table | `product_group_to_category` |
| value-domain → target-system | `uom_legacy_to_rootstock` |
| value-domain → value-domain | `status_code_legacy_to_modern` |

When a lookup serves a dual purpose (e.g., casing normalization + FK
resolution), name along the source-to-target endpoint axis and document
the secondary aspect in `description` and/or `data_quality_notes`. Do
NOT name lookups by transformation type (`casing_normalization`,
`enum_mapping`, `unit_conversion`) — those terms are reserved for
`decision_type`.

The Phase C iter 2 N=3 empirical measurement validated this convention:
prompt change lifted manufacturing `lookup_recall` from deterministic
0.000 → 1.000 (deterministic) and CRM `lookup_recall` from variance
0.667 (1/0/1) → 1.000 (deterministic stabilization), with overall
aggregate moving 0.843 → 0.892 (+0.049). See the iter 2 commit body
(`feat(ai): Phase C iter 2 — lookup naming canonicalization`) for
per-fixture deltas + the cross-fixture generalization observation.

#### Canonical inferred_targets naming (Phase C iter 2)

`inferred_target_object` is a single concept noun in lowercase
snake_case (e.g., `vendors`, `payment_methods`, `audit_log`). Avoid
descriptive multi-word phrases or relationship descriptors. Variance
signal from iter-2 Stop 0 (`Vendors / PreferredVendor relationship`
in single-trial vs `vendors` across N=3 trials) showed the model's
mode behavior already produces this shape; the convention is documented
to prevent regression.

### Workflow for authoring expected output

The Stop 1 design choice is **Option C — Claude Chat draft → human review**:

1. Open chat.anthropic.com (or use Claude Code in this repo).
2. Paste the source schema + target schema + business context.
3. Ask: "Produce the seven-section Path D output for this migration. Use the
   field UUIDs verbatim from the schemas. Format as JSON arrays per the
   protocol in `lib/types/path-d-events.ts`."
4. Review the draft critically — look for hallucinated UUIDs, missed
   mappings, decisions that should/shouldn't be there.
5. Strip free-text fields the scorer doesn't read; keep only the structural
   answers.
6. Commit `expected-output.json` with an `_authoring_notes` block recording
   who drafted, when reviewed, and what known judgment calls were made.

Re-baseline after running the eval and comparing actual to expected — the
expected may need adjustment if Path D consistently surfaces something
reasonable that the human draft missed.

### Diversity goals

The four v0 fixtures intentionally cover different profiles:

| Fixture | Domain | Scale | Stresses |
|---|---|---|---|
| `crm-sf-to-hubspot` | CRM | Small (~10 fields) | 1:1 mappings, picklist transform, dedup |
| `erp-rootstock-style` | ERP | Medium (~17 fields) | UOM normalisation, custom_sql heavy, lookup tables |
| `manufacturing-products-with-policies` | Manufacturing | Medium (~14 target fields) | Aggregation-derived rollup tables, constant-value mappings, multi-purpose lookups |
| `marketing-multi-source-dedup` | Marketing | Medium (~12 fields) | Many-to-one source consolidation, source priority logic |

When adding a new fixture, ask: **what dimension of Path D's behaviour does
this exercise that the existing 4 don't?** If the answer is "nothing
distinct," Phase C's iteration won't gain signal from the new fixture.

Good candidates for Phase C additions:
- Healthcare (HL7 / FHIR shapes, PHI-aware DQ findings)
- Financial (multi-currency normalisation, regulatory category mappings)
- Highly-denormalised → highly-normalised (testing inferred_targets surface)
- Schema with FK chains (testing many-to-many mapping_cardinality)

---

## v0 baseline scores

The first eval run against the v0 prompt (recorded in this PR's commit body)
becomes the empirical anchor for Phase C iteration. Phase C ships a prompt
revision iff the eval score improves on this baseline.

See the commit body for `feat(ai): Sub-PR 6 — Path D eval framework + ...`
for the per-fixture + overall-mean baseline numbers.

---

## INF follow-ups

- **INF-39** (filed in this PR): two parallel eval frameworks exist
  (`lib/eval/` for per-example tasks, `lib/ai/path-d-eval/` for monolithic
  Path D). Consider consolidation once both stabilise and Path D's eval
  shape is well-understood (post-Phase C iteration).
