# How Settle Measures AI Accuracy

**Document:** Settle measurement methodology
**Status:** Living document. Updated as Phase 2/3 ship.
**Last updated:** May 2, 2026

---

## 1. Summary

Settle measures per-task accuracy across the four AI workflows that drive enterprise data migration: schema mapping, transformation generation, natural-language to SQL, and validation rule synthesis. Gold labels come from real customer migrations — every AI proposal is captured, every human edit is recorded, and the difference is the measurement. We deliberately do not benchmark against synthetic datasets fabricated from public documentation. Methodology is the moat: competitors with hand-authored benchmarks have invented numbers, while Settle has a measurement system that compounds with every customer migration.

---

## 2. What "accuracy" means in data migration

Accuracy in data migration is not one number. The right framing is per-task, because the AI workflows that comprise a migration have structurally different success criteria.

A schema mapping is correct when a domain expert reviewing the migration would mark it correct — when the source field genuinely belongs to the target field in the customer's operational reality, with the right combination type when multiple sources collapse into one target. A SQL transformation is correct when it executes against real customer data and produces the values the customer expects. A natural-language SQL query is correct when it returns the rows the user was asking about. A validation rule is correct when it captures the constraint the user described in plain English, in a form the validator can enforce.

These criteria do not reduce to a single benchmark. A mapping that scores 0.80 field-pair F1 might still produce transforms that fail at execution time. A transform suite that runs cleanly might still propose validation rules that miss obvious constraints. Per-task measurement is the only honest framing.

The deeper question is what serves as ground truth. Schema-matching benchmarks like Magneto and TabLLM compare AI output against published gold labels — labels authored once by the benchmark's creators and treated as canonical. This works for academic benchmarks because the gold labels are themselves the artifact being studied. It does not work for production migration accuracy, where the right ground truth is "what would the customer's domain expert mark correct?" — a question that can only be answered by actually asking them.

This is the structural difference between academic LLM evaluation and production AI accuracy. Settle's measurement methodology starts here: ground truth comes from domain reviewers running real migrations, captured systematically, scored automatically.

---

## 3. How Settle captures gold labels

Every AI interaction in Settle produces a structured record of what the AI proposed and what the human kept. This is the substrate that makes principled accuracy measurement possible.

**Every AI call is logged.** The `llm_calls` table captures the model, system prompt, user message, response text, token counts, latency, and per-call cost for every Anthropic API invocation. Logging is implemented at the client layer (`lib/ai/llm-client.ts`); a CI invariant test prevents any direct SDK calls that would bypass it. Daily cost reports run on cron (`/api/cron/llm-cost-report`).

**Every AI proposal is frozen at the moment of creation.** Migration `083_ai_edit_history.sql` added `original_ai_*` columns to the four tables that AI mutates: `target_field_mappings`, `mapping_sources`, `transformations`, and `quality_issues`. When the AI first proposes a value, the proposal is written to both the live column (e.g. `generated_sql`) and the frozen column (`original_ai_generated_sql`). Subsequent human edits modify the live column; the frozen value is the AI's original proposal preserved for measurement.

**Every human edit is captured as a structured diff.** The `ai_edit_history` table records each edit with the entity type, entity ID, field path, old value, new value, edit kind (one of `ai_proposed`, `ai_replaced`, `human_accepted`, `human_modified`, `human_rejected`, `human_authored`), and a foreign key back to the originating `llm_calls` row. The `logAIEdit` helper at `lib/actions/ai-edit-history.ts` is wired into 24 emission sites across the production code paths that mutate AI tables. A CI invariant (`tests/lib/ai-edit-emission-invariant.test.ts`) ensures no future AI-table writer is added without emission.

**The chain that produces gold labels is then:**

```
AI proposes value
    ↓
original_ai_* column captures the proposal
    ↓
llm_calls row records the prompt, response, cost
    ↓
Human reviewer accepts / modifies / rejects
    ↓
ai_edit_history row captures (AI proposal, human result, edit kind)
    ↓
Eval harness reads (proposal, result) as (AI output, gold label)
```

Each `human_modified`, `human_accepted`, or `human_rejected` row is a labeled training example produced by the same domain experts running the migration. Sensitive content is redacted at write-time via a pattern-based PII redactor (`lib/ai/redact.ts`).

This substrate is in production today. PRs 6 through 9 of Sprint 6 built it. The eval harness reads from it.

---

## 4. How Settle measures accuracy

The eval harness invokes the same production code paths that customer migrations exercise, against real schemas, and scores the AI's output with explicit per-task scorers.

The harness is a CLI (`pnpm eval`) that loads gold-labeled examples, replays the AI prompt through production code (`runMappingGenerationForPair`, `addValidationRuleFromNL`, etc.), and applies a task-appropriate scorer to the response. Three architectural commitments make the measurements defensible:

- **Same code, not parallel reimplementation.** The eval calls the production AI entry points with `featureOverride: 'eval_mapping' | 'eval_validation_rule' | ...` so the eval rows are tagged distinctly in `llm_calls` but the code path is identical to what customers trigger. There is no "eval version" of the prompt assembly logic.

- **Real database, real cleanup.** The eval creates synthetic projects (prefix `eval-synthetic-`) with the same schema as real projects, runs the AI against them, and tears them down via cascade-delete. A `try/finally` cleanup invariant ensures zero orphan rows after every run, success or failure. Cost accounting is captured in-memory before teardown so cost data persists even though the synthetic `llm_calls` rows cascade away.

- **Per-task scorers with explicit semantics.** Mapping accuracy uses field-pair F1 over `(source_field_id, target_field_id)` tuples — precision and recall computed over set membership, with `combination_type` ignored at this layer (a separate scorer measures it). Validation rules use a structural five-axis score covering JSON validity, rule type match, field match, config keys match, config values match, and severity match. Transform accuracy (Phase 1.5) will use exec accuracy against test fixtures plus output-row-count match. Each scorer is unit-tested with all-correct, all-wrong, and edge cases.

The harness exists today (PR 10.4). The infrastructure for cost capping, scratch-context guards, JWT signing for synthetic users, and module-resolution for CLI consumption of Next.js production code is complete and verified end-to-end against the production database.

```
ai_edit_history row (gold label)
    ↓
Eval CLI loads (input prompt, expected output)
    ↓
Replays prompt through production code path
    ↓
Receives AI response
    ↓
Per-task scorer compares response to gold
    ↓
Aggregated metrics: precision, recall, F1, exec accuracy, etc.
```

What's not yet active: the eval has not been pointed at real edit-history data because the substrate is too new. PRs 6 through 9 shipped between April 28 and May 2, 2026. The `ai_edit_history` table is empty in production. As migrations run and the table populates, the eval activates against real customer-validated gold labels.

---

## 5. Why we don't fabricate synthetic benchmarks

The standard pattern in LLM eval design is to author synthetic benchmarks: hand-craft a few hundred examples per task, label them by hand, run the model against them, report the score. This is what every published LLM benchmark does. It is what most AI-startup eval slides show.

Settle deliberately does not do this. The reasoning is not that synthetic benchmarks are wrong in principle. It is that they are wrong for production migration accuracy, for two specific reasons.

First, the gold labels would be fabricated by an engineer reading public documentation, not by domain experts running real migrations. Public documentation describes what fields exist; it does not describe what a NetSuite-to-Rootstock migration practitioner would mark canonical. The two are different. A benchmark labeled from public docs measures the AI's ability to reproduce one engineer's interpretation of the docs, not its ability to produce migrations a customer would accept. The number that emerges is precise and unfalsifiable until a real customer reviews it — at which point either the number was right and the benchmark was unnecessary, or the number was wrong and the benchmark misled every decision built on it.

Second, synthetic benchmarks systematically overweight what is easy to author. A benchmark hand-crafted by an engineer will contain examples that engineer thought to write down. It will undersample the long tail of weird vendor-specific quirks that are 80% of real migration work. The AI's accuracy on such a benchmark is not a useful predictor of its accuracy on customer data, because the benchmark distribution is not the customer distribution.

The alternative we chose is slower to produce numbers but every number is independently defensible: gold labels emerge from real customer reviews. When Mitratech reviews the AI's mapping proposals and approves some while modifying others, the approved-vs-modified split is captured automatically by the substrate from §3. When Rootstock pilot users edit AI-generated transforms, the edits become gold labels for transform accuracy. The numbers Settle reports about its AI accuracy are numbers that came from customers running migrations, not from us writing what we hoped customers would agree with.

This is intentional methodology, not absence of methodology. The infrastructure to measure accurately exists. The choice to populate it with real data instead of fabricated data is the choice that makes the measurements defensible.

---

## 6. Timeline and what numbers exist when

Honest accountability requires being explicit about what numbers exist now and when meaningful numbers become available.

**Today, May 2, 2026:** zero rows in `ai_edit_history`. The substrate that captures gold labels was completed yesterday. No production migrations have run since. Settle reports no accuracy numbers because none exist that would be statistically defensible.

**After one customer pilot:** approximately 50 to 200 `ai_edit_history` rows per task per project. Enough for directional signal — "AI is getting most mappings approved without modification" or "AI is failing on currency conversions" — but not enough for confidence intervals on per-task accuracy.

**After three to five customer pilots:** approximately 500 to 2000 rows per task aggregated across projects. Enough for per-task accuracy reporting with meaningful confidence intervals. This is the threshold at which Settle will publish accuracy numbers in customer-facing materials.

**After ten or more customers:** vendor-pair benchmarks emerge organically. Each NetSuite-to-Rootstock customer's edit history validates the AI's mapping conventions for that vendor pair. Each Salesforce-to-HubSpot customer does the same for that pair. The accumulating data lets Settle report "NetSuite-to-Rootstock mapping accuracy: 0.87 across 12 customer projects, 1,847 reviewed mappings" — a number that is defensible because it came from customers, not from us.

**The compounding claim:** competitors who measure accuracy once at launch report a static benchmark number. Settle's methodology produces a measurement system that improves with every customer migration. After 50 customers, Settle's accuracy measurements are statistically more credible than any single launch benchmark could be. After 200 customers, the per-vendor-pair benchmarks exceed the resolution of any hand-authored dataset, because the data came from people who actually run those migrations.

The price of this methodology is patience in the early months. The return is benchmarks that compound rather than decay.

---

## Appendix: Implementation references

The infrastructure underlying this methodology is in the Settle codebase. Key references:

- `lib/ai/llm-client.ts` — unified AI call layer with logging
- `lib/ai/pricing.ts` — per-model cost calibration
- `lib/ai/redact.ts` — pattern-based PII redactor
- `lib/actions/ai-edit-history.ts` — the `logAIEdit` emission helper
- `supabase/migrations/082_llm_calls.sql` — observability substrate
- `supabase/migrations/083_ai_edit_history.sql` — provenance substrate
- `lib/eval/` — the eval harness module
- `scripts/eval.ts` — CLI entry point
- `tests/lib/no-direct-callclaude.test.ts` — invariant preventing SDK bypass
- `tests/lib/ai-edit-emission-invariant.test.ts` — invariant requiring `logAIEdit` on AI table writes

The eval harness was shipped in PR 10.4. The substrate it reads from was shipped in PRs 6 through 9. Phase 2 (model upgrade) and Phase 3 (specialized agents and self-consistency) will produce accuracy improvements measurable against the substrate as it populates with customer data.