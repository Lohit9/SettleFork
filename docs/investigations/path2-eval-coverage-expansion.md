# Path 2 Phase A — Eval Harness Coverage Expansion (Read-Only Investigation)

**Type:** Read-only design exercise. No code changes proposed below as patches. The only file written is this document.

**Audience:** AI architect drafting Phase B's wiring PRs + Kaan for fixture-design sign-off.

**Scope:** Design Phase B's wiring of 5 additional eval features (`eval_validation_rule`, `eval_quality_issues`, `eval_extracted_patterns`, `eval_mapping_suggestion`, `eval_fix_options`) into the existing eval harness. Today only `eval_mapping` is wired.

**Out of scope:** Implementation. Phase 3 multi-step reasoning. `eval_transform` and `eval_nl_to_sql` (the other two reserved enum values).

---

## DIVERGENCE callouts (path corrections + state surprises)

1. **Fixture path correction (minor).** The Phase A prompt referenced `lib/eval/datasets/_fixture/` — that directory does not exist. Fixtures actually live at **`tests/eval/datasets/_fixture/`**, anchored by the `DATASETS_DIR` constant at [lib/eval/loader.ts:25](lib/eval/loader.ts#L25). Used consistently below.

2. **Validation-rule scorer is FULLY IMPLEMENTED but unwired.** [lib/eval/scorers/validation-rule.ts](lib/eval/scorers/validation-rule.ts) (256 LOC) exports `scoreValidationRuleStructural` with 6 scoring axes (`jsonValid 0.30`, `ruleTypeMatch 0.25`, `fieldMatch 0.20`, `configKeysMatch 0.10`, `configValuesMatch 0.10`, `severityMatch 0.05`) and pure deep-equal logic. The runner does NOT import it; [lib/eval/runner.ts:212-217](lib/eval/runner.ts#L212-L217) explicitly skips validation-rule examples with the comment "deferred to PR 11". This materially shrinks Phase B's scorer-design work for `emit_validation_rule` — see §2.1.

3. **Validation-rule fixture exists but uses stale severity vocabulary.** [tests/eval/datasets/_fixture/examples/validation-rule/001-fixture.json](tests/eval/datasets/_fixture/examples/validation-rule/001-fixture.json) ships gold label `"severity": "error"` while the production schema (and the scorer's TS types) require `'blocking' | 'warning'`. The scorer's docstring at line 16-19 already documents this divergence. Phase B fixture work must update the gold label to `'blocking'` (or `'warning'`, depending on intent) — small but necessary.

4. **`EvalTask` is a closed 4-value enum.** [lib/eval/types.ts:19](lib/eval/types.ts#L19) declares `EvalTask = 'mapping' | 'transform' | 'nl-to-sql' | 'validation-rule'`. The 5 high-stakes tools require **3 NEW task names** beyond the existing 4: `quality-issues`, `extracted-patterns`, `mapping-suggestion`, `fix-options` (4 if we count separately; `validation-rule` is already in the enum). Phase B must extend the type union, the loader's `TASKS` array at [loader.ts:27](lib/eval/loader.ts#L27), and the loader's `examples` initialization. Mechanical but explicit.

5. **One reserved enum value is misnamed in the prompt.** Path 2's prompt lists `eval_quality_issues`. The actual reserved `LLMFeature` value is `eval_quality_issues` — verified, no DIVERGENCE here. (Cross-checked against [lib/ai/llm-client.ts](lib/ai/llm-client.ts) `LLMFeature` union — the reserved values match the prompt's list.)

---

## TL;DR

| Tool | Eval-feasibility | Scorer status | Phase B wiring complexity |
|---|---|---|---|
| `emit_validation_rule` | **Medium** | ✅ exists (`scoreValidationRuleStructural`, 6 axes) | Add `featureOverride` + supabase injection; reuse scorer as-is |
| `emit_mapping_suggestion` | **Medium** | Needs new scorer (~3 axes) | `runMappingSuggestion` is already supabase-injectable; add `featureOverride` only |
| `emit_quality_issues` | **Hard** | Needs new scorer (4 axes incl. SQL safety) | Heavy synthetic context (`buildAIContext` requires field profiles + value distributions + docs) |
| `emit_fix_options` | **Hard** | Needs new scorer (3 axes incl. SQL validation) | Requires pre-existing `quality_issues` row + rich field context |
| `emit_extracted_patterns` | **Hard** | Needs new scorer (3-4 axes incl. canonical-pattern usage) | LATE-stage feature; needs approved mappings + issues + rules pre-populated |

**Recommendation: Option P2 — Two PRs by complexity.** PR 1 wires the 2 Medium-complexity tools (~$0.10 verification spend, 6-8 hr Claude Code). PR 2 wires the 3 Hard-complexity tools after the synthetic-context-builder is extended. Real measurement on the Medium tools de-risks the Hard tools' fixture and scorer design.

---

## Section 1 — Per-tool eval feasibility

### Summary table

| Tool | Production entry function | Input shape | Output shape | DB side effects | `featureOverride` status | Eval feasibility |
|---|---|---|---|---|---|---|
| `emit_validation_rule` | [`addValidationRuleFromNL(projectId, fieldId, naturalLanguageRule, severityOverride?)`](lib/actions/validation-rules.ts#L255) | 3 args (projectId, fieldId UUID, NL string) | `{ success, rule?: ValidationRule, error? }` | INSERTS into `validation_rules` table | **Missing** — must be added | **Medium** |
| `emit_mapping_suggestion` | [`runMappingSuggestion(supabase, userId, projectId, targetFieldId)`](lib/ai/mapping-engine.ts#L1727) | 4 args, supabase already injectable | `{ success: true, suggestion: { sourceFieldIds[], combinationType, confidence, rationale } } \| { success: false, error, errorCode }` | None (returns suggestion in-memory; no INSERT) | **Missing** — must be added | **Medium** |
| `emit_quality_issues` | [`runAIAugmentedChecks(projectId, tableId)`](lib/actions/ai-quality-detection.ts#L128) | 2 UUID args | `{ issuesFound, skipped?, error? }` | INSERTS into `quality_issues` (per-issue) | **Missing** — must be added | **Hard** |
| `emit_fix_options` | [`generateFixSuggestions(issueId)`](lib/quality/fix-engine.ts#L194) | 1 UUID arg (issue id) | `{ success, error? }` | UPDATES `quality_issues.ai_fix_options` column | **Missing** — must be added | **Hard** |
| `emit_extracted_patterns` | [`extractMigrationIntelligence(projectId)`](lib/actions/migration-intelligence.ts#L421) | 1 UUID arg | `{ success, patternsExtracted?, patternsNew?, patternsUpdated?, error? }` | INSERTS/UPDATES into `migration_intelligence` table | **Missing** — must be added | **Hard** |

### 1.1 `emit_validation_rule` — Medium

- **Entry:** [lib/actions/validation-rules.ts:255](lib/actions/validation-rules.ts#L255) — `addValidationRuleFromNL`.
- **Inputs:** `projectId`, `fieldId`, `naturalLanguageRule`, `severityOverride?`. Builds the supabase client INTERNALLY at line 266 (`const supabase = await createClient()`); cannot be supabase-injected today.
- **Output:** Returns `{ success, rule?: ValidationRule, error? }`. The `rule` object has the columns the scorer needs (`rule_type`, `rule_config`, `field_id`, `severity`, `name`).
- **Side effects:** INSERTs into `validation_rules` (RLS client). Cascade-cleaned on project teardown.
- **`featureOverride` status:** missing. The `callLLM` invocation at line 345 hardcodes `feature: 'validation_rule_from_nl'`. Phase B adds an optional 5th param `featureOverride?: LLMFeature` and threads `featureOverride ?? 'validation_rule_from_nl'` to the callLLM call (mirror the [`runMappingGenerationForPair`](lib/actions/mappings.ts) pattern).
- **Blockers:** (a) supabase client must become injectable like `runMappingGenerationForPair`'s pattern; (b) eval needs a synthetic field row to point `fieldId` at — current `synthetic-context-builder` already inserts source/target fields (per [synthetic-context-builder.ts:42-52](lib/eval/synthetic-context-builder.ts#L42)), so picking one source field id from `BuiltMappingContext.sourceFieldsByName` covers it.
- **Why Medium not Easy:** the supabase-injection refactor + featureOverride threading is ~30 LOC, but no novel scoring/context work is needed (scorer exists, fixture pattern exists).

### 1.2 `emit_mapping_suggestion` — Medium

- **Entry:** [lib/ai/mapping-engine.ts:1727](lib/ai/mapping-engine.ts#L1727) — `runMappingSuggestion`.
- **Inputs:** `(supabase, userId, projectId, targetFieldId)` — **already supabase-injectable** at the entry. Best-positioned of the 5 for eval wiring.
- **Output:** `{ success: true, suggestion: { sourceFieldIds[], combinationType, confidence, rationale } }` — clean in-memory return. Eval reads `suggestion` directly; no DB read-back needed.
- **Side effects:** **None.** Function does not insert/update any DB row. (Production callsite is the per-target Suggest flow; the user accepts/rejects the suggestion downstream.)
- **`featureOverride` status:** missing. Per the PR 12.1 migration, the `callLLM` call at line ~1972 uses `feature: 'mapping_suggest'` directly. Phase B adds `featureOverride` parameter.
- **Blockers:** (a) needs project-wide source schema in synthetic context (current builder builds source + target tables; should suffice — the prompt's "same-table" constraint applies at AI-generation time, not at synthetic-context construction time); (b) the function uses [`buildAIContext`](lib/ai/context-builder.ts) for sample values + value distributions + documents — synthetic context inserts tables and fields but not field profiles or documents, so `buildAIContext` will return empty profile rows. **Verification needed:** confirm the AI suggestion still produces sensible output without populated field profiles. Likely yes (the system prompt says "Use bare field names" — name + data type is enough), but worth a one-shot smoke as part of Phase B.
- **Why Medium not Easy:** new scorer needed (best-of-N source-field match); `featureOverride` threading; field-profile-availability uncertainty.

### 1.3 `emit_quality_issues` — Hard

- **Entry:** [lib/actions/ai-quality-detection.ts:128](lib/actions/ai-quality-detection.ts#L128) — `runAIAugmentedChecks`.
- **Inputs:** `(projectId, tableId)`. Builds supabase client internally; not injectable.
- **Output:** `{ issuesFound, skipped?, error? }` — returns ONLY a count, not the proposed_issues array. The eval would have to read back from `quality_issues` to access the actual issues for scoring.
- **Side effects:** INSERTs one row per `proposed_issue` into `quality_issues`. Cascade-cleaned on project teardown.
- **`featureOverride` status:** missing. The `callLLM` call at line ~286 uses `feature: 'quality_detection_ai'`.
- **Blockers (multiple):**
  - **Heavy context-builder requirement.** Function calls `buildAIContext` at line 160 with `includeProfilingStats`, `includeValueDistributions`, `includeSampleValues`, `includeDocuments` all `true`. Without these, the system prompt has no signal to detect data-quality issues from. **Phase B must extend `synthetic-context-builder` to insert `field_profiles` rows + `data_rows` JSONB samples + a stub `schema_documents` row.** That's a major addition (~150-200 LOC) but it's reusable across the 3 Hard tools (quality_issues, fix_options, extracted_patterns).
  - **Output structure is opaque.** The function returns only `issuesFound`. Phase B adds an optional return field `proposedIssues?: ProposedIssue[]` so the eval runner can score the actual outputs without re-querying. Alternative: reuse the existing query pattern (read back from `quality_issues` filtered by project_id + table_id + created_at since example start); slower but no production code change beyond `featureOverride`.
  - **Owner check at line 153.** `if (tableData.datasets?.projects?.user_id !== user.id) return { issuesFound: 0, error: 'Access denied' }`. Synthetic project must be owned by EVAL_USER_ID — the existing `createSyntheticProject` already ensures this.
- **Why Hard:** new scorer needed (4 axes); supabase injection refactor; CONTEXT-BUILDER EXTENSION needed (the load-bearing scope item); output-structure refactor or read-back pattern.

### 1.4 `emit_fix_options` — Hard

- **Entry:** [lib/quality/fix-engine.ts:194](lib/quality/fix-engine.ts#L194) — `generateFixSuggestions(issueId)`.
- **Inputs:** Single `issueId` UUID. Function fetches the issue + project + field internally.
- **Output:** `{ success, error? }` — generated fix options are written into `quality_issues.ai_fix_options` as a JSONB column update; not returned in the response shape.
- **Side effects:** UPDATES the `quality_issues` row (writes `ai_fix_options` JSONB array of fix proposals). No fix execution — `applyFix` is a separate function.
- **`featureOverride` status:** missing. The `callLLM` call at line 421 uses `feature: 'quality_fix_options'`.
- **Blockers (multiple):**
  - **Pre-existing `quality_issues` row required.** The eval cannot invoke `generateFixSuggestions` without first creating a quality issue. Two paths: (a) hand-author a fixture quality_issues row in `synthetic-context-builder` extension, or (b) chain off `emit_quality_issues` eval (run that first, pick one of its outputs as input to fix-options eval). Path (a) is cleaner — eval examples should be independent.
  - **Rich field context.** Same `buildAIContext` requirement as quality_issues. The synthetic-context-builder extension that supports quality_issues will satisfy fix_options too (shared dependency).
  - **Output read-back.** Same shape problem as quality_issues — read `ai_fix_options` column back after the function returns.
  - **Owner check chain.** Issue → project → user_id. Synthetic project ownership already correct.
- **Why Hard:** scorer needs SQL safety validation (parse + run through `validateFixSQL`); fixture must include both a target field with profiling stats AND a `quality_issues` seed row; output read-back pattern.

### 1.5 `emit_extracted_patterns` — Hard

- **Entry:** [lib/actions/migration-intelligence.ts:421](lib/actions/migration-intelligence.ts#L421) — `extractMigrationIntelligence(projectId)`.
- **Inputs:** Single `projectId`.
- **Output:** `{ success, patternsExtracted?, patternsNew?, patternsUpdated?, error? }` — returns counts only, not the patterns. Patterns are inserted into the `migration_intelligence` table; eval would read them back.
- **Side effects:** INSERTs/UPDATES `migration_intelligence` rows. The `migration_intelligence` table is a CROSS-PROJECT knowledge base — rows persist beyond the synthetic project's lifetime. **CRITICAL:** the table cascade-cleanup story may not work if `migration_intelligence` doesn't have a FK to `projects` with ON DELETE CASCADE. **Verification needed in Phase B's first step:** check `supabase/migrations/` for the `migration_intelligence` schema and confirm cleanup behavior.
- **`featureOverride` status:** missing. The `callLLM` call at line ~855 uses `feature: 'migration_intelligence'`.
- **Blockers (multiple):**
  - **LATE-stage data prerequisites.** Function reads from 5 tables (`datasets`, `table_mappings WHERE status = 'approved'`, `quality_issues`, `validation_rules`, `schema_documents WHERE doc_type IN ('schema', 'business_context')`) at lines 451-479. **Synthetic context must populate ALL 5 tables** — table_mappings must be approved, schema_documents must include business_context, etc. Roughly 30-50 INSERT operations to set up one example.
  - **Cleanup risk (see above).** If `migration_intelligence` rows don't cascade-delete with the project, eval runs leak rows. R1 risk in §5.
  - **Output read-back via merged knowledge base.** The function uses `titlesAreSimilar` (line 110) to dedupe extracted patterns against existing rows. Eval might see fewer "new" rows than expected if a prior eval run already inserted similar patterns. Phase B's read-back must filter by `project_id` (assuming the column exists; if patterns are project-scoped via `source_project_ids` array, the filter is array-contains).
- **Why Hard:** the heaviest synthetic-context burden of the 5; cleanup uncertainty; output dedupe semantics complicate scoring.

---

## Section 2 — Scorer design per tool

### 2.1 `emit_validation_rule` — `scoreValidationRuleStructural` (already exists; wireable AS-IS)

**Wireability resolution:** **WIREABLE AS-IS.** [lib/eval/scorers/validation-rule.ts](lib/eval/scorers/validation-rule.ts) is a complete 256-LOC scorer with 6 axes already designed and weighted. The function signature `scoreValidationRuleStructural(proposed: ProposedValidationRule | null, gold: GoldValidationRule)` returns `{ score, details }`, mirroring `scoreMappingFieldPair`'s shape. The runner can dispatch directly:

```ts
// Phase B Pseudocode (NOT prescription)
const aiResult = await addValidationRuleFromNL(projectId, fieldId, nlRule, undefined, /* featureOverride */ 'eval_validation_rule')
const proposed = aiResult.success && aiResult.rule
  ? toProposedValidationRule(aiResult.rule)
  : null
const scored = scoreValidationRuleStructural(proposed, example.gold as GoldValidationRule)
```

**Inputs:** `ProposedValidationRule | null` + `GoldValidationRule`.
**Output:** `{ score: number (0-1), details: StructuralScoreDetails }` with axis-level booleans + axis scores.
**Scoring axes (already locked):**
- `jsonValid` (0.30 weight) — proposed object has all required fields with correct types
- `ruleTypeMatch` (0.25) — strict string equality on `rule_type`
- `fieldMatch` (0.20) — strict string equality on `field_id`
- `configKeysMatch` (0.10) — sorted `Object.keys(rule_config)` equality
- `configValuesMatch` (0.10) — gated on configKeysMatch; deep-equal on rule_config
- `severityMatch` (0.05) — strict string equality on `severity`

**Gold-label format:** matches `ProposedValidationRule` shape — `{ rule_type, rule_config, field_id, severity, name? }`. The existing fixture at [tests/eval/datasets/_fixture/examples/validation-rule/001-fixture.json](tests/eval/datasets/_fixture/examples/validation-rule/001-fixture.json) follows this shape modulo the stale `severity: "error"` value (Phase B fixes to `"blocking"`).

**Phase B work for validation_rule scorer:** ZERO scorer code; just wiring. All effort is on the production-side `featureOverride` + supabase injection.

### 2.2 `emit_mapping_suggestion` — new scorer `scoreMappingSuggestion`

**Inputs:** `ProposedSuggestion = { sourceFieldNames: string[], combinationType: 'single'|'concat_space'|'concat_comma', confidence: number, rationale: string } | null` + `GoldSuggestion = { sourceFieldNames: string[], combinationType, confidence?: { min, max }, ... }`.

**Output:** `{ score: number, details: { sourceFieldsMatch: boolean, combinationTypeMatch: boolean, confidenceInBand: boolean, ... } }`.

**Scoring axes (proposed; subject to Kaan review in Phase B prep):**
- `sourceFieldsMatch` (0.55) — best-of-N: proposed `sourceFieldNames` (as a Set) equals gold's. Partial credit possible (Jaccard) but recommend strict equality for v1 to avoid false positives.
- `combinationTypeMatch` (0.30) — strict equality. Must agree with gold (single iff cardinality 1).
- `confidenceInBand` (0.10) — proposed confidence within `[gold.min, gold.max]` (gold authors a confidence band, not a point). When gold omits the band, axis scored true unconditionally.
- `rationaleNonEmpty` (0.05) — `proposed.rationale.length >= 10`. Sanity check, not a quality measure.

**Gold-label format:**
```json
{
  "sourceFieldNames": ["first_name", "last_name"],
  "combinationType": "concat_space",
  "confidence": { "min": 70, "max": 100 }
}
```

**Translation gotcha:** `runMappingSuggestion` returns `sourceFieldIds` (UUIDs). The scorer translates IDs → names via `BuiltMappingContext.sourceFieldsByName` (reverse lookup), mirroring `translateGoldMappings` in [runner.ts:515](lib/eval/runner.ts#L515). Phase B reuses that translation pattern.

### 2.3 `emit_quality_issues` — new scorer `scoreQualityIssueDetection`

**Inputs:** `ProposedIssues = ProposedIssue[]` + `GoldIssues = ProposedIssue[]` (both shaped per `ai-quality-detection.ts` `ProposedIssue` interface).

**Output:** `{ score: number, details: { precision, recall, severityCorrectness, sqlSafetyRate, ... } }`.

**Scoring axes (proposed):**
- `precision` (0.30) — fraction of proposed issues that match a gold issue (matched on `field_name + cross_field` tuple).
- `recall` (0.30) — fraction of gold issues that the AI proposed.
- `severityCorrectness` (0.20) — among matched issues, fraction with correct `severity` (per the locked 5-blocking-conditions rubric from PR 12.1.5).
- `sqlSafetyRate` (0.15) — fraction of `verification_sql` strings that pass `isVerificationSQLSafe(sql, tableId)` (the safety validator at [ai-quality-detection.ts:38](lib/actions/ai-quality-detection.ts#L38)).
- `descriptionNonEmpty` (0.05) — fraction of proposed issues with `description.length >= 20`. Sanity check.

**Gold-label format:** array of `{ field_name, cross_field?, description, severity, estimated_count, verification_sql?, reasoning }` rows. Phase B authors 1-2 issues per fixture (e.g., one null-violation, one cross-field inconsistency). Verification_sql gold can be a regex match (proposed must INCLUDE certain key tokens) rather than a literal SQL match — true SQL equivalence is undecidable.

**False-positive guard:** verification_sql is the highest-stakes axis (real SQL gets executed downstream); the scorer must REJECT proposals where verification_sql fails the safety validator, not pass them through with a 0 on that axis only.

### 2.4 `emit_fix_options` — new scorer `scoreFixOptions`

**Inputs:** `ProposedFixOptions = FixOption[]` (read from `quality_issues.ai_fix_options` after `generateFixSuggestions` completes) + `GoldFixOptions = { minOptionCount: number, maxOptionCount: number, requiresLowRiskOption: boolean, expectedRiskLevels: ('low'|'medium'|'high')[] }`.

**Output:** `{ score: number, details: { optionCountInRange, hasLowRisk, sqlValidityRate, riskLevelDiversity, ... } }`.

**Scoring axes (proposed):**
- `optionCountInRange` (0.20) — number of options is in `[minOptionCount, maxOptionCount]` (typically `[2, 3]` per the tool description).
- `sqlValidityRate` (0.40) — fraction of options whose `sql` passes `validateFixSQL(sql, tableId)` (the validator at [lib/quality/fix-sql-validator.ts](lib/quality/fix-sql-validator.ts)). Anything below 1.0 here is a hard issue — fix SQL that fails validation will be rejected at apply time.
- `riskLevelDiversity` (0.20) — set of unique `risk_level` values across options has cardinality >= 2 (the tool description says "spans the risk spectrum").
- `hasLowRisk` (0.15) — at least one option has `risk_level === 'low'` (per the tool description's "Always include at least one 'low' option").
- `descriptionNonEmpty` (0.05) — fraction of options with `description.length >= 20`. Sanity check.

**Gold-label format:** structural assertion, not point-prediction. Gold authors say "expect 2-3 options, at least one low-risk, all SQL must validate". Phase B does NOT ground-truth specific SQL strings — that's a benchmark trap (R3 in §5).

### 2.5 `emit_extracted_patterns` — new scorer `scorePatternExtraction`

**Inputs:** `ProposedPatterns = ExtractedPattern[]` (read from `migration_intelligence` table filtered by source_project_ids array-contains the synthetic project) + `GoldPatterns = { minPatternCount: number, expectedCategories: string[], requiresCanonicalPatternType: boolean }`.

**Output:** `{ score: number, details: { patternCountInRange, categoryCorrectness, canonicalUsageRate, ... } }`.

**Scoring axes (proposed):**
- `patternCountInRange` (0.20) — count is in `[minPatternCount, ∞)` (tool says "8-15 patterns"; gold authors "min 5" for the synthetic example since the synthetic context is sparser than a real completed project).
- `categoryCorrectness` (0.30) — every proposed pattern's `category` is one of the 4 valid enum values (`transformation_recipe`, `data_quality_pattern`, `domain_knowledge`, `source_system_hint`). Schema enforces this at the API layer; this axis catches the rare strict-mode-bypass case.
- **`canonicalPatternTypeUsageRate`** (0.30) — fraction of proposed patterns whose `pattern_config.pattern_type` (or `domain` for domain_knowledge, or `system_type` for source_system_hint) is a key in `ALL_CANONICAL_PATTERNS` (imported from [lib/ai/canonical-patterns.ts](lib/ai/canonical-patterns.ts)). **This is the load-bearing axis** — measures whether the description-embedded canonical vocabulary actually shapes the AI's output. Target: ≥0.70.
- `tagCountInRange` (0.10) — fraction of patterns with 3-6 tags (per the tool description).
- `categoryWeighting` (0.10) — fraction of patterns in `transformation_recipe` + `data_quality_pattern` is ≥ 0.50 (the tool description says "weight toward" these categories).

**Gold-label format:** structural-only, no specific patterns ground-truthed. The synthetic context is too thin to deterministically yield specific patterns, so gold says "given a project with N transformations and M quality issues, expect ≥5 patterns including ≥1 transformation_recipe and ≥1 data_quality_pattern, with ≥70% canonical pattern_type usage".

---

## Section 3 — Fixture design

### 3.1 Existing structure (verified)

[tests/eval/datasets/_fixture/](tests/eval/datasets/_fixture/) layout:

```
_fixture/
├── metadata.json
├── schema.json
└── examples/
    ├── mapping/
    │   └── 001-fixture.json
    └── validation-rule/
        └── 001-fixture.json
```

Per [lib/eval/loader.ts:182-195](lib/eval/loader.ts#L182-L195), the loader iterates `examples/<task>/*.json` files. Adding new tasks is mechanical: create a new subdirectory under `examples/`, add JSON files matching the validated `EvalExample` shape, extend `EvalTask` union and `TASKS` constant.

### 3.2 Recommendation: extend `_fixture/`, do NOT create new dataset directories

**Rationale:**
- Operational surface stays at one dataset name (`_fixture`) for CLI invocations
- Schema definition is shared (one `schema.json` per dataset; the 5 tools all need source/target tables)
- New-tool examples live in their own task subdirectory, so they don't collide with existing examples

### 3.3 Per-tool fixture design

| Task subdirectory | Example count | Gold-label content (minimum) |
|---|---|---|
| `mapping/` (existing) | 1 | Already exists. No change. |
| `validation-rule/` (existing, gold needs update) | 1 | Update gold's `severity` from `"error"` to `"blocking"` to match the production schema (see DIVERGENCE #3). |
| `mapping-suggestion/` (NEW) | 1 | `{ sourceFieldNames: [...], combinationType, confidence: { min, max } }`. The fixture's target field is one of the existing fixture's target fields (e.g., `label` from the mapping fixture). |
| `quality-issues/` (NEW) | 1 | `{ proposedIssues: [{ field_name, severity, ...verification_sql_pattern }] }` — STRUCTURAL gold (assert ≥1 issue, severity matches blocking-rubric, verification_sql passes safety). NOT specific issue text. |
| `fix-options/` (NEW) | 1 | `{ minOptionCount: 2, maxOptionCount: 3, requiresLowRiskOption: true }`. STRUCTURAL gold; no specific SQL strings. |
| `extracted-patterns/` (NEW) | 1 | `{ minPatternCount: 5, expectedCategories: ['transformation_recipe', 'data_quality_pattern'], requiresCanonicalPatternType: true }`. STRUCTURAL gold; the per-pattern content varies non-deterministically. |

### 3.4 Schema additions in `schema.json`

The existing `schema.json` defines `fixture_source_table` + `fixture_target_table` with 4 fields total. For the new examples:
- `mapping-suggestion/` reuses existing tables (suggesting one source field for one target field)
- `quality-issues/` + `fix-options/` need ONE field with rich enough profile to surface issues. Recommend extending source schema to include 2-3 more fields (e.g., `email`, `phone`, `created_at`) where field profiles can encode issue patterns
- `extracted-patterns/` needs the synthetic context built up with mappings + issues + rules — minimal schema addition; the bulk is synthetic-context-builder extension

**Schema delta:** `~30-50 LOC of schema.json additions`, not new dataset directories.

---

## Section 4 — Implementation phasing (recommendation: P2)

### Three options compared

| Option | LOC delta | Verification spend | Calendar time | Risk profile |
|---|---|---|---|---|
| **P1 — Single PR, all 5** | ~1,100-1,400 | ~$0.30-0.40 | 12-16 hr | High blast radius if synthetic-context extension breaks something |
| **P2 — Two PRs (Medium → Hard)** | PR 1: ~350-450 / PR 2: ~700-950 | PR 1: ~$0.10-0.15 / PR 2: ~$0.20-0.30 | 6-8 hr + 8-10 hr | LOW — Medium PR validates pattern; Hard PR builds on proven base |
| **P3 — Five PRs, one per tool** | 5 × ~250-400 | 5 × ~$0.05-0.10 | 5 × 4-6 hr | Low per-PR risk; high overall overhead |

### Recommendation: **P2 — Two PRs by complexity**

**Rationale:**
- **Synthetic-context-builder extension is the load-bearing change** for the 3 Hard tools (quality_issues, fix_options, extracted_patterns). All three need field_profiles, value distributions, and (for extracted_patterns) approved table_mappings + quality_issues seed rows. PR 2 invests in this once and reuses across 3 features.
- **PR 1 validates the Medium pattern at low spend.** Wiring `eval_validation_rule` (scorer exists) and `eval_mapping_suggestion` (scorer is new but small) end-to-end in PR 1 produces real measurement. If anything breaks (e.g., `featureOverride` threading interacts badly with the supabase-injection refactor), it surfaces at PR 1's verification gate, not after PR 2's larger investment.
- **Calendar parallelism.** PR 2's Hard tools can start once PR 1's pattern is locked. PR 2 doesn't need to wait for PR 1 to merge — only for PR 1's `featureOverride`-injection pattern to be reviewed.
- **Avoids P3 overhead.** Five PRs require five rounds of CI, review, deploy. P2 is twice that of P1 but a fifth of P3.

### PR 1 (Medium tools)

**Scope:**
- Add `featureOverride?: LLMFeature` parameter to `addValidationRuleFromNL` + supabase-injection refactor (~80 LOC)
- Add `featureOverride?: LLMFeature` parameter to `runMappingSuggestion` (~10 LOC)
- New scorer: `lib/eval/scorers/mapping-suggestion.ts` (~150 LOC)
- Runner dispatch for `validation-rule` (replace skip + warning with real path) (~70 LOC)
- Runner dispatch for `mapping-suggestion` task (~80 LOC)
- Type union extension in `lib/eval/types.ts` for `EvalTask` (+1 value, ~5 LOC)
- Loader: extend `TASKS` array (~5 LOC)
- Fixture updates: 1 new task directory, 1 example file, schema.json addition; gold-label fix for validation-rule (~80 LOC of JSON)
- Test additions: unit tests for new scorer + runner-dispatch coverage (~120 LOC)

**Verification gates:**
- `pnpm tsc --noEmit` — clean
- `pnpm vitest run` — baseline 2968 + ~6-10 new tests
- `pnpm test:integration` heritage flag-OFF — byte-identical
- `AI_PHASE_2_ENABLED=1 pnpm eval mapping --dataset _fixture --smoke` — score 1.0 (regression check)
- `AI_PHASE_2_ENABLED=1 pnpm eval validation-rule --dataset _fixture --smoke` — NEW; expect score >= 0.85 (rich descriptions should help)
- `AI_PHASE_2_ENABLED=1 pnpm eval mapping-suggestion --dataset _fixture --smoke` — NEW; expect score >= 0.75 (single-target suggestion is harder than full-table mapping)
- Spend cap: $0.20

### PR 2 (Hard tools)

**Scope:**
- Synthetic-context-builder extension: insert field_profiles + sample data_rows + stub schema_documents + approved table_mappings + seed quality_issues (~250-300 LOC)
- Add `featureOverride` + supabase-injection to `runAIAugmentedChecks` (~80 LOC)
- Add `featureOverride` to `generateFixSuggestions` (~50 LOC)
- Add `featureOverride` to `extractMigrationIntelligence` (~40 LOC)
- Three new scorers: `quality-issues.ts` (~180 LOC), `fix-options.ts` (~150 LOC), `extracted-patterns.ts` (~200 LOC, includes canonical-pattern lookup against `ALL_CANONICAL_PATTERNS`)
- Runner dispatch for 3 new tasks (~200 LOC)
- Type union extension (+3 values, ~10 LOC) + loader update (~10 LOC)
- 3 new fixture directories with examples + schema additions (~200 LOC of JSON)
- Test additions for 3 new scorers + dispatch (~250 LOC)
- **Migration sanity check:** verify `migration_intelligence` cleanup behavior (R1 risk; fix if needed via migration extending ON DELETE CASCADE)

**Verification gates:**
- Same as PR 1 plus the 3 new feature smokes
- Heritage byte-identical (load-bearing — synthetic-context extension must not affect non-eval paths)
- Per-feature smoke: `AI_PHASE_2_ENABLED=1 pnpm eval <task> --dataset _fixture --smoke` for each of quality-issues, fix-options, extracted-patterns; expect score >= 0.65 (Hard tools, looser threshold)
- Spend cap: $0.30

---

## Section 5 — Risk assessment

### R1: Production code paths have side effects polluting eval runs

**Specific risks:**
- `runAIAugmentedChecks` INSERTs into `quality_issues`. **Cleanup mechanism:** project-cascade delete via `teardownSyntheticProject`. Verify in Phase B-2 that `quality_issues.project_id` has a valid FK with ON DELETE CASCADE.
- `generateFixSuggestions` UPDATES `quality_issues.ai_fix_options`. Same cleanup mechanism.
- `extractMigrationIntelligence` INSERTs into `migration_intelligence`. **HIGH RISK:** the schema may NOT cascade on project delete (this is a cross-project knowledge base). Phase B-2 must verify and fix if needed (likely a small migration adding ON DELETE CASCADE or a manual sweep in `teardownSyntheticProject`).

**Verification gate:** existing `finalCleanupCheck` invariant at [runner.ts:605](lib/eval/runner.ts#L605) checks for orphan synthetic projects. Phase B-2 adds an analogous "no orphan migration_intelligence rows tagged with synthetic project" check (or verifies cascade-delete works) AS PART OF the synthetic-context extension. If the check fails on a single eval run, fail the run loudly.

**Decision criterion before merging PR 2:** zero `migration_intelligence` rows referencing a deleted synthetic project after a full eval run.

### R2: Scorers produce false positives/negatives

A scorer that scores 1.0 on a wrong answer is worse than no scorer. Five new scorers means five new false-positive surfaces.

**Verification:** for each new scorer in PR 1 + PR 2, hand-author 2-3 KNOWN-WRONG fixture entries with adversarial gold/proposed combinations:
- `mapping-suggestion`: a proposed suggestion with the same source field BUT wrong combinationType — confirm scorer DOES NOT give it >0.70
- `quality-issues`: a proposal with all-correct issues but every `verification_sql` failing safety — confirm scorer's sqlSafetyRate axis = 0
- `fix-options`: a proposal with valid SQL but no low-risk option — confirm `hasLowRisk` axis = 0
- `extracted-patterns`: a proposal with all 8 patterns having `pattern_type: "ad_hoc_made_up"` (none in canonical list) — confirm canonicalUsageRate = 0
- `validation-rule`: scorer is already shipped; existing tests cover the 6-axis matrix. No additional adversarial fixtures needed.

These adversarial fixtures live in `tests/lib/eval-scorers/` (NOT under `tests/eval/datasets/_fixture/` — they're unit-test fixtures for the scorers, not eval-runner inputs).

### R3: Fixtures encode implicit priors (the synthetic-gold-labels trap)

The synthetic-fixtures methodology distinction is **explicit and load-bearing**:

> **Path 2 fixtures are minimal single-example smoke tests, NOT benchmarks.**

The single fixture per tool exists to answer: "did the tool-use path produce STRUCTURALLY-VALID output that the production code can consume?" — NOT "is the AI's answer correct?". When gold labels are STRUCTURAL (e.g., "expect 2-3 options, at least one low-risk, all SQL must validate") rather than POINT-PREDICTIONS (e.g., "expect this exact SQL string"), the fixture measures the AI's ability to satisfy the contract, not our prior about what the right answer is.

**Verification:** during Phase B fixture authoring, the gold-label content must avoid:
- Ground-truthed specific SQL strings (R3 trap on fix-options + quality-issues)
- Exact pattern_type values (R3 trap on extracted-patterns) — only verify "is in canonical set" not "equals X"
- Specific validation rule names (R3 trap on validation-rule) — already handled by the scorer's name being unscored

**Trap warning encoded in the report:** Phase 3 work (real benchmark datasets like NetSuite→Rootstock 60-example set) is the proper place for point-prediction gold labels with multi-author review. Path 2 is single-example smoke only.

### R4: Per-feature cost is meaningful at scale

Today: `pnpm eval mapping --smoke` costs ~$0.0454. Five features at similar per-feature cost: **~$0.25 for "run all evals"**. Acceptable for development; flag for ops.

**Operational implications:**
- CI integration would need a daily/weekly cap if eval is wired to CI (currently it's developer-invoked only)
- Each PR's verification suite runs ONE smoke per affected feature, not all-features. PR 1 runs ~3 smokes (~$0.15); PR 2 runs ~5 (~$0.25)
- Long-term Phase 3 benchmark runs (60-example datasets) at ~$0.05 per example × 60 × 5 features = $15/run. That cost is acceptable for periodic baselines; not for per-PR CI

**Verification:** Phase B verification spends are bounded at $0.20 (PR 1) + $0.30 (PR 2) = $0.50 total. Track actuals; flag if any single smoke exceeds $0.10.

### R5: Test count baseline keeps shifting

Current baseline: **2968** (verified via worktree A's vitest run after PR 12.1.5 merged). The 12-test drift between this and the PR-12.1.5-implementation-report's stated 2980 lives in non-AI tests (likely worktree B's PR #25 refactor cleanup). Phase B does NOT block on this discrepancy.

**Verification:**
- PR 1 verification computes its own baseline AT MERGE TIME, not from this report
- Each PR's commit message states the EXACT before/after test count (no rounding)
- If the baseline diverges by more than ~20 tests between PR 1 and PR 2 starts, Phase B-2 lead investigates whether non-AI worktrees changed something load-bearing for the eval runner

---

## Section 6 — Phase B implementation scope

### 6.1 Per-PR LOC and file delta

**PR 1 (Medium tools — `eval_validation_rule` + `eval_mapping_suggestion`)**

| File | Status | LOC delta |
|---|---|---|
| `lib/actions/validation-rules.ts` | Modified | ~+30 (featureOverride + supabase injection) |
| `lib/ai/mapping-engine.ts` | Modified | ~+10 (featureOverride threading on `runMappingSuggestion`) |
| `lib/eval/runner.ts` | Modified | ~+150 (two new dispatch functions + scorer wiring) |
| `lib/eval/types.ts` | Modified | ~+5 (EvalTask union extension if needed; mapping-suggestion may need new type) |
| `lib/eval/loader.ts` | Modified | ~+5 (TASKS array) |
| `lib/eval/scorers/mapping-suggestion.ts` | NEW | ~+150 |
| `tests/eval/datasets/_fixture/schema.json` | Modified | ~+30 |
| `tests/eval/datasets/_fixture/examples/validation-rule/001-fixture.json` | Modified | gold severity update |
| `tests/eval/datasets/_fixture/examples/mapping-suggestion/001-fixture.json` | NEW | ~+30 |
| `tests/lib/eval-scorers/mapping-suggestion.test.ts` | NEW | ~+150 |
| `tests/lib/eval-scorers/validation-rule.test.ts` | (already exists per scorer) | no change |
| `tests/eval/runner.test.ts` (or equivalent) | Modified | ~+50 (dispatch coverage for 2 new tasks) |
| **Total PR 1** | | **~+610 net LOC** |

**PR 2 (Hard tools — `eval_quality_issues` + `eval_fix_options` + `eval_extracted_patterns`)**

| File | Status | LOC delta |
|---|---|---|
| `lib/eval/synthetic-context-builder.ts` | Modified | ~+250-300 (field_profiles, data_rows, schema_documents, approved table_mappings, seed quality_issues) |
| `lib/actions/ai-quality-detection.ts` | Modified | ~+80 (featureOverride + supabase injection + optional return field for proposed_issues) |
| `lib/quality/fix-engine.ts` | Modified | ~+50 (featureOverride threading) |
| `lib/actions/migration-intelligence.ts` | Modified | ~+40 (featureOverride threading) |
| `supabase/migrations/<NNN>_migration_intelligence_cascade.sql` | NEW (if needed) | ~+15 (ON DELETE CASCADE if missing) |
| `lib/eval/runner.ts` | Modified | ~+200 (three new dispatch functions) |
| `lib/eval/types.ts` | Modified | ~+10 (EvalTask union extension) |
| `lib/eval/loader.ts` | Modified | ~+10 (TASKS array) |
| `lib/eval/scorers/quality-issues.ts` | NEW | ~+180 |
| `lib/eval/scorers/fix-options.ts` | NEW | ~+150 |
| `lib/eval/scorers/extracted-patterns.ts` | NEW | ~+200 (includes canonical-pattern lookup vs `ALL_CANONICAL_PATTERNS`) |
| `tests/eval/datasets/_fixture/schema.json` | Modified | ~+50 |
| 3 new fixture example files | NEW | ~+150 (50 each) |
| 3 new scorer unit tests | NEW | ~+450 (150 each) |
| Runner dispatch tests | Modified | ~+80 |
| **Total PR 2** | | **~+1,915-1,985 net LOC** |

(PR 2 is larger than P2's mid-range estimate from §4 because the synthetic-context extension is the load-bearing change. Net total across PR 1 + PR 2: ~2,500-2,600 LOC.)

### 6.2 Verification spend

| Phase | Spend |
|---|---|
| PR 1 verification — eval mapping smoke (regression) + 2 new feature smokes | ~$0.10-0.15 |
| PR 2 verification — eval mapping smoke + 2 from PR 1 (regression) + 3 new feature smokes | ~$0.25-0.30 |
| **Total Phase B verification spend** | **~$0.35-0.45** |

Plus ~$0.05 for adversarial-fixture unit tests (R2 — these run as fixture-shape tests, not real LLM calls, so $0).

### 6.3 Estimated Claude Code hours

| PR | Implementation | Verification | Total |
|---|---|---|---|
| PR 1 | 4-5 hr | 1-2 hr | 5-7 hr |
| PR 2 | 6-8 hr | 2-3 hr | 8-11 hr |
| **Phase B total** | | | **13-18 hr** |

PR 2's longer hours reflect the synthetic-context-builder extension complexity + the 3-scorer parallel work.

### 6.4 Verification gates per PR (consolidated)

**Both PRs must pass:**
1. `pnpm tsc --noEmit` — clean
2. `pnpm vitest run` — full suite passes (baseline + new tests)
3. `pnpm test:integration` heritage flag-OFF — byte-identical to PR #23 baseline (proves H1 design preserved)
4. `AI_PHASE_2_ENABLED=1 pnpm eval mapping --dataset _fixture --smoke` — score 1.0 (regression check on the existing wired feature)
5. Per-PR feature smokes (PR 1: 2 new; PR 2: 3 new) — each must score above the threshold listed in §4

**PR 2 additionally must pass:**
6. `migration_intelligence` cleanup invariant — zero rows orphaned after a full eval run
7. Synthetic-context teardown invariant — `finalCleanupCheck` reports 0 orphans across all 3 hard-tool fixture runs

### 6.5 Sequencing recommendation

1. **Phase B-1 (pre-PR 1):** Confirm `validation-rule.ts` scorer types match `ProposedValidationRule` shape returned by `addValidationRuleFromNL` after refactor. ~30 min sanity check.
2. **PR 1:** Wire `eval_validation_rule` + `eval_mapping_suggestion`. Land. ~6 hr.
3. **Phase B-2 (pre-PR 2):** Verify `migration_intelligence` cascade-delete behavior. If missing, write the migration first as a separate small PR. ~1 hr.
4. **PR 2:** Wire the 3 Hard tools on top of extended synthetic-context-builder. Land. ~10 hr.

Total wall-clock: ~3 working days for one engineer + Claude Code, including review cycles.

---

## What's NOT in this investigation (out of scope)

- Implementation of any code (Phase B work)
- Authoring fixture content with specific gold labels (Phase B + Kaan jointly during fixture review)
- Phase 3 multi-step reasoning loops or self-consistency
- Wiring `eval_transform` or `eval_nl_to_sql` (out of Path 2 scope; those are the other 2 reserved enum values)
- Eval-harness CI integration (out of scope; eval is developer-invoked today)
- LLM calls (this audit is read-only; spend cap was $0)
- Committing this investigation doc (Phase B PR will pick it up alongside the code edits)

## DIVERGENCE summary (consolidated)

1. Fixture path is `tests/eval/datasets/_fixture/`, not `lib/eval/datasets/_fixture/` (per Phase A prompt). One-line correction; doesn't change scope.
2. `lib/eval/scorers/validation-rule.ts` is already implemented (256 LOC, 6 axes) but unwired. Phase B reuses it as-is.
3. The validation-rule fixture's gold uses stale `severity: "error"` instead of `'blocking' | 'warning'`. Phase B fixture update.
4. `EvalTask` is closed at 4 values; Phase B extends it +3-4 values (depending on whether validation-rule re-uses the existing task or splits).
5. `migration_intelligence` table cascade-delete behavior is uncertain; Phase B-2 verifies and fixes if needed.

*End of Path 2 Phase A investigation.*
