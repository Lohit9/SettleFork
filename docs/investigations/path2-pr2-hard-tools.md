# Path 2 PR 2 Phase A — Hard Tools Investigation (Read-Only)

**Type:** Read-only design exercise. No code changes proposed below as patches. The only file written is this document.

**Audience:** AI architect drafting Phase B's three sub-commits + Kaan for fixture / cleanup-strategy sign-off.

**Scope:** Wire 3 Hard-tier eval features (`eval_quality_issues`, `eval_extracted_patterns`, `eval_fix_options`) into the existing eval harness. Path 2 PR 1 wired the Medium tier (mapping, validation-rule, mapping-suggestion).

**Out of scope:** Phase 3 multi-step reasoning, `eval_transform`, `eval_nl_to_sql`, real-customer benchmarks.

---

## DIVERGENCE callouts

1. **Function naming.** Prompt referred to `extractMigrationPatterns`. Actual exported name is **`extractMigrationIntelligence`** ([lib/actions/migration-intelligence.ts:421](lib/actions/migration-intelligence.ts#L421)). One-line correction; no scope change.

2. **No reserved enum values for any of the 3 Hard tools.** `LLMFeature` at [lib/ai/llm-client.ts:63-67](lib/ai/llm-client.ts#L63-L67) lists only: `eval_mapping`, `eval_validation_rule`, `eval_mapping_suggestion`, `eval_transform`, `eval_nl_to_sql`. **None** of `eval_quality_issues`, `eval_extracted_patterns`, `eval_fix_options` are reserved. Same finding pattern as Path 2 PR 1's `eval_mapping_suggestion`. Phase B B-1 adds 3 enum values.

3. **`runAIAugmentedChecks` filters AI proposals via verification SQL execution before persisting.** [lib/actions/ai-quality-detection.ts:332-356](lib/actions/ai-quality-detection.ts#L332-L356) runs each proposal's `verification_sql` via `execute_readonly_query` RPC and DROPS proposals where `actualCount <= 0`. For an eval, this conflates "AI proposal quality" with "did the synthetic data shape match the AI's verification_sql filter". To score AI proposals as the AI emitted them, the eval-friendly path **must** bypass the verification + insert step and return raw `proposed_issues`. Same C2-style skipPersist pattern as `extractMigrationIntelligence` — but here it's `skipVerificationAndPersist`, which also obviates the need for synthetic `data_rows` rows that match arbitrary AI-emitted SQL. **Material effect on synthetic-context scope** (see §2).

4. **`runAIAugmentedChecks` also reads existing `quality_issues` for dedup.** [line 176-184](lib/actions/ai-quality-detection.ts#L176). For the synthetic project, existing_issues is empty (correct). No-op concern but documented.

5. **`generateFixSuggestions` writes ONLY to `quality_issues.ai_fix_options` JSONB.** [lines 462+](lib/quality/fix-engine.ts#L462). Does NOT write to `fix_history` or `fix_snapshots` — those are populated by `applyFix`, a separate function. So eval-mode `skipPersist` for fix_options just needs to skip the UPDATE; no broader cleanup risk.

6. **`extractMigrationIntelligence` requires ≥1 approved table_mapping** ([line 490-492](lib/actions/migration-intelligence.ts#L490-L492)) — early-returns with `'No approved table mappings found — nothing to extract'` otherwise. The synthetic-context-builder already inserts an approved table_mapping (existing behavior, [line 181-197](lib/eval/synthetic-context-builder.ts#L181-L197)), so this is naturally satisfied. No scope addition.

7. **`generateFixSuggestions` requires a pre-existing `quality_issues` row** ([line 210](lib/quality/fix-engine.ts#L210)). Synthetic builder must seed one for the fix_options eval — this IS a scope addition.

---

## TL;DR

| Tool | Entry function | Persistence shape | Eval skipPersist surface | Synthetic-context need |
|---|---|---|---|---|
| `eval_quality_issues` | `runAIAugmentedChecks(projectId, tableId)` | INSERT to `quality_issues` (filtered by verification_sql) | **`skipVerificationAndPersist: true`** — return raw `proposed_issues[]`, skip SQL execution + insert | field_profiles + value distributions on synthetic fields |
| `eval_extracted_patterns` | `extractMigrationIntelligence(projectId)` | INSERT/UPDATE to `migration_intelligence` (user-scoped, no FK cascade) | **`skipPersist: true`** — return raw `extractedPatterns[]`, skip dedupe + upsert | approved table_mapping (already there) + ≥1 quality_issues row + field_profiles |
| `eval_fix_options` | `generateFixSuggestions(issueId)` | UPDATE `quality_issues.ai_fix_options` JSONB | **`skipPersist: true`** — return raw `parsed.fix_options`, skip the UPDATE | seed `quality_issues` row + field_profiles + sample data_rows on the affected field |

**3 sub-commits, ~950-1100 LOC total**, ~$0.20-0.30 verification spend.

---

## Section 1 — Per-tool entry function audit

### 1.1 `eval_quality_issues` → `runAIAugmentedChecks`

**File:line:** [lib/actions/ai-quality-detection.ts:128](lib/actions/ai-quality-detection.ts#L128)

**Current signature (positional):**
```ts
export async function runAIAugmentedChecks(
  projectId: string,
  tableId: string,
): Promise<{ issuesFound: number; skipped?: boolean; error?: string }>
```

**Return type:** Just a count. Eval needs the raw `proposed_issues` array.

**DB side effects:**
- Reads: `tables` (joined to datasets/projects for ownership), `quality_issues` (existing-issues for dedup), `fields`, `mapping_sources`, `data_rows` (via verification_sql RPC)
- Writes: `quality_issues` (one INSERT per proposal where verification SQL returns count > 0)
- Writes: `ai_edit_history` (provenance per inserted issue)

**`featureOverride` status:** Missing. The `callLLM` invocation at [line 290](lib/actions/ai-quality-detection.ts#L290) hardcodes `feature: 'quality_detection_ai'`.

**Refactor required (B-1):** Substantial. Mirror Path 2 PR 1's pattern but with object-style signature per locked decision #2. Proposed:

```ts
// Object-style refactor — production callsites pass { projectId, tableId };
// eval passes { projectId, tableId, evalContext: {...} } and gets back the
// raw proposals.
type RunAIAugmentedChecksParams = {
  projectId: string
  tableId: string
  evalContext?: {
    supabase: SupabaseClient
    userId: string
    featureOverride: LLMFeature
    skipVerificationAndPersist: true
  }
}

type RunAIAugmentedChecksResult =
  | { issuesFound: number; skipped?: boolean; error?: string }
  | { issuesFound: 0; rawProposals: ProposedIssue[]; error?: string }
```

**Open question for Phase B drafting:** the production callsite at the existing API route (the one at [line 286](lib/actions/ai-quality-detection.ts#L286) — actually that's the LLM call, not the production callsite of `runAIAugmentedChecks` itself) needs to keep working. Confirm via grep: who calls `runAIAugmentedChecks` today?

**Relationship to callLLM:** Direct. The function calls `callLLM` once per invocation; no intermediate. featureOverride wiring is a 1-line change at the callLLM site.

### 1.2 `eval_extracted_patterns` → `extractMigrationIntelligence`

**File:line:** [lib/actions/migration-intelligence.ts:421](lib/actions/migration-intelligence.ts#L421)

**Current signature (positional):**
```ts
export async function extractMigrationIntelligence(projectId: string): Promise<{
  success: boolean
  patternsExtracted?: number
  patternsNew?: number
  patternsUpdated?: number
  error?: string
}>
```

**Return type:** Counts only. Eval needs the raw `extractedPatterns` array.

**DB side effects:**
- Reads: `projects`, `datasets`, `table_mappings WHERE status='approved'`, `quality_issues`, `validation_rules`, `schema_documents`, `tables`, `target_field_mappings + mapping_sources` (with deep nested joins), `migration_intelligence` (existing-patterns for dedup)
- Writes: `migration_intelligence` (UPDATE existing similar pattern OR INSERT new) — **per-pattern at lines 937-953**

**`featureOverride` status:** Missing. The `callLLM` at [line 861](lib/actions/migration-intelligence.ts#L861) hardcodes `feature: 'migration_intelligence'`.

**Refactor required (B-1):** Object-style signature with `skipPersist`. Proposed:

```ts
type ExtractMigrationIntelligenceParams = {
  projectId: string
  evalContext?: {
    supabase: SupabaseClient
    userId: string
    featureOverride: LLMFeature
    skipPersist: true
  }
}

type ExtractMigrationIntelligenceResult = {
  success: boolean
  patternsExtracted?: number
  patternsNew?: number
  patternsUpdated?: number
  rawPatterns?: ExtractedPattern[]  // populated only when evalContext.skipPersist
  error?: string
}
```

The skipPersist gate wraps the for-loop at [line 909-981](lib/actions/migration-intelligence.ts#L909). When skipping, the function returns `{ success: true, rawPatterns: extractedPatterns }` and exits before the UPDATE/INSERT loop.

**`migration_intelligence` cleanup confirmation:** Per [supabase/migrations/033_migration_intelligence.sql](supabase/migrations/033_migration_intelligence.sql), the table is **user-scoped** (user_id only, no project_id FK). Project teardown does NOT cascade-delete migration_intelligence rows. This confirms C2 skipPersist is the correct approach — without it, eval runs would leak migration_intelligence rows tagged with the EVAL_USER_ID forever.

**Relationship to callLLM:** Direct. featureOverride is a 1-line change.

### 1.3 `eval_fix_options` → `generateFixSuggestions`

**File:line:** [lib/quality/fix-engine.ts:194](lib/quality/fix-engine.ts#L194)

**Current signature (positional):**
```ts
export async function generateFixSuggestions(
  issueId: string,
): Promise<{ success: boolean; error?: string }>
```

**Return type:** Bare success/error. Eval needs the raw `fix_options` array.

**DB side effects:**
- Reads: `quality_issues` (with ownership join), `fields`, `tables`, `mapping_sources` (for in-flight routing), `quality_issues` (other open issues on same table for context)
- Writes: `quality_issues` UPDATE (writes `ai_fix_options` JSONB column at [line ~470](lib/quality/fix-engine.ts#L470)), `ai_edit_history` provenance
- **Does NOT write to `fix_history` or `fix_snapshots`** — those are owned by `applyFix`, a separate function

**`featureOverride` status:** Missing. The `callLLM` at [line 425](lib/quality/fix-engine.ts#L425) hardcodes `feature: 'quality_fix_options'`.

**Refactor required (B-1):** Object-style signature. Proposed:

```ts
type GenerateFixSuggestionsParams = {
  issueId: string
  evalContext?: {
    supabase: SupabaseClient
    userId: string
    featureOverride: LLMFeature
    skipPersist: true
  }
}

type GenerateFixSuggestionsResult = {
  success: boolean
  rawFixOptions?: FixOption[]  // populated only when evalContext.skipPersist
  error?: string
}
```

**Relationship to callLLM:** Direct. featureOverride is a 1-line change.

**Eval scaffolding requirement:** Unlike the other two tools, `generateFixSuggestions` requires a **pre-existing `quality_issues` row** as input. The eval runner can't just say "score this against my synthetic project" — it needs to first INSERT a synthetic quality_issues row, get its ID, then call `generateFixSuggestions(issueId)` with that ID. This adds one INSERT to the synthetic-context-builder for fix_options examples (or as a dedicated step in the runner's `runOneFixOptionsExample`).

---

## Section 2 — Synthetic-context-builder extension design

### 2.1 Current state (confirmed)

[lib/eval/synthetic-context-builder.ts](lib/eval/synthetic-context-builder.ts) is a single procedural builder that inserts:
- 1 source dataset (role='source')
- 1 target dataset (role='target')
- 1 source table + 1 target table
- N source fields + M target fields (per the schema spec)
- 1 approved `table_mappings` row

Total: ~7 INSERTs per call. All cascade-cleaned via `teardownSyntheticProject` (project FK with ON DELETE CASCADE).

### 2.2 What the 3 Hard tools additionally need

| Tool | Additional fixture context |
|---|---|
| `quality_issues` | Field profiling stats per source field (`field_profiles` rows): null_count, total_rows, sample_values, etc. The AI uses these to surface issues. Schema at [migration 002:58-71](supabase/migrations/002_foundation.sql#L58-L71). |
| `extracted_patterns` | Same field_profiles + the existing approved table_mapping IS sufficient (function reads from there). Optional richer context: schema_documents row for documentation reference. |
| `fix_options` | Same field_profiles + 1 seed `quality_issues` row (the issueId the function takes as input). |

**Surprise: `data_rows` rows are NOT needed** under the eval-skipPersist design. `runAIAugmentedChecks`'s verification_sql executes against `data_rows`, but Phase A's locked design has eval skip the verification step entirely (per DIVERGENCE #3). For `extractMigrationIntelligence` and `generateFixSuggestions`, the AI prompt uses field_profiles' aggregated stats (sample_values, null_count) NOT raw data_rows — so synthetic data_rows are not required.

This **shrinks the builder extension significantly** vs Phase A's original 280-330 LOC estimate.

### 2.3 Builder extension design (revised)

**Single parameterized builder, not 3 separate ones.**

```ts
// New parameter on the existing input type:
export interface BuildMappingContextInput {
  projectId: string
  schema: DatasetSchema
  sourceTableName: string
  targetTableName: string
  // NEW (Path 2 PR 2):
  withFieldProfiles?: boolean  // insert field_profiles for source fields
  seedQualityIssue?: {          // insert one quality_issues row, return its id
    fieldName: string  // looked up against sourceFieldsByName
    severity: 'blocking' | 'warning'
    title: string
    description: string
  }
}

export interface BuiltMappingContext {
  // ... existing fields ...
  // NEW:
  qualityIssueId?: string  // populated only when seedQualityIssue was set
}
```

**Per-feature usage:**
- `quality_issues` eval: `withFieldProfiles: true`. No seedQualityIssue.
- `extracted_patterns` eval: `withFieldProfiles: true`. Optionally a seedQualityIssue + a stub schema_documents row to give the AI more to extract from.
- `fix_options` eval: `withFieldProfiles: true` + `seedQualityIssue` (eval needs the issueId).

**Field profiles content:** Hand-crafted per-field stats matching what the synthetic schema represents. Example for the existing fixture's `name` field (text, 100 sample rows):
```ts
{
  field_id: <synthetic name field id>,
  total_rows: 100,
  null_count: 5,
  null_percentage: 5.0,
  cardinality: 87,
  unique_percentage: 87.0,
  sample_values: ["Alice", "Bob", "Carol", "David", "Eve"],
  min_value: "Alice",
  max_value: "Zoe",
}
```

Realistic enough that the AI can surface meaningful issues (e.g., "5% nulls on `name`" → null_violation pattern).

### 2.4 Estimated builder extension LOC

**~150-200 LOC** in `synthetic-context-builder.ts` (revised down from the original 280-330 estimate because `data_rows` is dropped and the seedQualityIssue is small).

| Addition | LOC |
|---|---|
| `withFieldProfiles` parameter + per-source-field INSERT loop with hand-crafted stats | ~80 |
| `seedQualityIssue` parameter + 1 INSERT + return-id wiring | ~30 |
| `BuiltMappingContext` shape extension + downstream type plumbing | ~10 |
| Unit tests for new builder paths (vitest) | ~80 |
| **Total** | **~200 LOC** |

### 2.5 Cleanup story (verified)

| Synthetic table | Cleanup mechanism | Status |
|---|---|---|
| `field_profiles` | FK to `fields` ON DELETE CASCADE → `fields` cascades on `tables` → `datasets` → `projects` | ✅ no-op for builder |
| `quality_issues` | FK to `projects` ON DELETE CASCADE | ✅ no-op for builder |
| `migration_intelligence` | NO project FK (user-scoped) — would leak | ⚠️ skipPersist required (locked design #1) |
| `data_rows` | FK to `tables` ON DELETE CASCADE | N/A — not populated in this design |

`finalCleanupCheck` ([lib/eval/runner.ts:605](lib/eval/runner.ts#L605)) sweeps orphan synthetic projects only; doesn't need extension as long as the cascade chains hold.

---

## Section 3 — Per-tool scorer design

### 3.1 `scoreQualityIssueDetection`

**File path:** `lib/eval/scorers/quality-issues.ts` (new file).

**Inputs:**
```ts
type ProposedIssue = {
  field_name: string
  cross_field?: string
  description: string
  severity: 'blocking' | 'warning'
  estimated_count: number
  verification_sql: string
  reasoning: string
}

type GoldQualityIssues = {
  expected_issues: Array<{
    field_name: string
    expected_severity: 'blocking' | 'warning'
    description_keywords?: string[]  // a few must-include tokens
  }>
  acceptable_extra_issues?: number  // tolerance for AI proposing more issues than gold expects (default 0)
}
```

**Output:** `{ score: number, details: { precision, recall, severityCorrectness, sqlSafetyRate, axisScores } }`.

**Axes (weights):**

| Axis | Weight | Computation |
|---|---|---|
| **precision** | 0.40 | Of proposed issues, fraction that match a gold expected_issue (matched on `field_name`, case-insensitive). |
| **recall** | 0.40 | Of gold expected_issues, fraction that the AI proposed (same matching). |
| **severityCorrectness** | 0.10 | Among matched issues, fraction with severity == expected_severity. |
| **sqlSafetyRate** | 0.10 | Fraction of proposed issues whose verification_sql passes `isVerificationSQLSafe(sql, tableId)` — already exists at [ai-quality-detection.ts:38](lib/actions/ai-quality-detection.ts#L38). Reuse the validator. |

**Gold-label format:** Hand-authored, structural (NOT point-prediction on description text). Example:
```json
{
  "expected_issues": [
    { "field_name": "name", "expected_severity": "warning",
      "description_keywords": ["null"] }
  ]
}
```

**False-positive guard (R2):** Adversarial unit test — feed a proposal with all 5 verification_sql strings failing safety. Confirm sqlSafetyRate = 0 (axis catches it cleanly).

**False-negative guard:** A proposal with no field_name match scores precision=0, recall=0 — but severityCorrectness becomes vacuously 1.0 (no matches to score). Edge case: when there are 0 matched issues, severityCorrectness should be 0 (no credit for an empty match set). Document this in the scorer.

### 3.2 `scoreExtractedPatterns`

**File path:** `lib/eval/scorers/extracted-patterns.ts` (new file).

**Inputs:**
```ts
type ExtractedPattern = {
  category: 'transformation_recipe' | 'data_quality_pattern' | 'domain_knowledge' | 'source_system_hint'
  title: string
  pattern_description: string
  pattern_config: Record<string, unknown>
  tags: string[]
}

type GoldExtractedPatterns = {
  min_pattern_count: number  // e.g., 3 for the smoke fixture
  expected_categories: Array<'transformation_recipe' | 'data_quality_pattern' | 'domain_knowledge' | 'source_system_hint'>
  // Specific pattern_type values are NOT pinned — that's the canonical
  // vocabulary axis (canonicalPatternTypeUsage), not a per-pattern match.
}
```

**Output:** `{ score: number, details: { ... } }`.

**Axes (weights):**

| Axis | Weight | Computation |
|---|---|---|
| **patternCountMet** | 0.20 | 1.0 if `proposed.length >= gold.min_pattern_count`, 0 otherwise. |
| **categoryCorrectness** | 0.30 | Fraction of proposed patterns whose `category` is in the 4-value enum. (Schema enforces this via strict mode + enum, but pin it as a scorer axis to defend against future schema relaxations.) |
| **canonicalPatternTypeUsage** | 0.30 | Fraction of proposed patterns whose `pattern_config.pattern_type` (or `domain` for `domain_knowledge`, `system_type` for `source_system_hint`) is a key in `ALL_CANONICAL_PATTERNS` from [lib/ai/canonical-patterns.ts](lib/ai/canonical-patterns.ts). Target ≥ 0.70 — measures whether the description-embedded canonical vocabulary actually shapes generation. |
| **expectedCategoriesPresent** | 0.20 | Of `gold.expected_categories`, fraction that appear at least once in proposed patterns. |

**Gold-label format:** Structural-only, no specific patterns ground-truthed:
```json
{
  "min_pattern_count": 3,
  "expected_categories": ["transformation_recipe", "data_quality_pattern"]
}
```

**False-positive guard:** Adversarial test — feed all 8 patterns with `pattern_type: "ad_hoc_made_up_thing"` (none in canonical list). Confirm canonicalPatternTypeUsage = 0.

**Confidence calibration NOT scored** here (the AI doesn't return per-pattern confidence; the dedupe path computes its own). Sanity check: if confidence appears in pattern_config, ignore it for scoring.

### 3.3 `scoreFixOptions`

**File path:** `lib/eval/scorers/fix-options.ts` (new file).

**Inputs:**
```ts
type FixOption = {
  label: string
  description: string
  sql: string
  tradeoff: string
  downstream_impact: string
  risk_level: 'low' | 'medium' | 'high'
  estimated_rows_affected: number
}

type GoldFixOptions = {
  min_option_count: number  // e.g., 2 (per tool description's "2-3 fix options")
  max_option_count: number  // e.g., 3
  requires_low_risk_option: boolean  // true (per tool description's "Always include at least one low")
  expected_risk_level_for_first_option?: 'low' | 'medium' | 'high'  // OPTIONAL per-issue calibration
}
```

**Output:** `{ score: number, details: { ... } }`.

**Axes (weights):**

| Axis | Weight | Computation |
|---|---|---|
| **sqlValidityRate** | 0.40 | Fraction of options whose `sql` passes `validateFixSQL(sql, tableId)` — exists at [lib/quality/fix-sql-validator.ts](lib/quality/fix-sql-validator.ts). Reuse. |
| **optionCountInRange** | 0.20 | 1.0 if `proposed.length` is in `[min, max]`, 0 otherwise. |
| **hasLowRiskOption** | 0.20 | 1.0 if at least one option has `risk_level === 'low'` (when `requires_low_risk_option`), else 0. |
| **riskLevelDiversity** | 0.10 | 1.0 if the set of unique risk_level values across options has cardinality ≥ 2, else 0. |
| **descriptionNonEmpty** | 0.10 | Fraction of options with `description.length >= 20`. Sanity check. |

**Gold-label format:** Structural assertion only:
```json
{
  "min_option_count": 2,
  "max_option_count": 3,
  "requires_low_risk_option": true
}
```

**Phase B does NOT ground-truth specific SQL strings.** That's the R3 trap from PR 18 (synthetic-gold-labels). The scorer measures "did the AI satisfy the structural contract", not "did the AI produce the SQL we expected".

**False-positive guard:** Adversarial test — feed valid SQL but all options at `risk_level: 'high'` (no low). Confirm `hasLowRiskOption` = 0 + `riskLevelDiversity` = 0.

---

## Section 4 — Per-tool fixture design

All 3 fixtures live under `tests/eval/datasets/_fixture/examples/<task>/`. Single example each, hand-crafted unambiguous.

### 4.1 `quality-issues/001-fixture.json`

```json
{
  "id": "_fixture/quality-issues/001-fixture",
  "task": "quality-issues",
  "input": {
    "source_table": "fixture_source_table",
    "target_table": "fixture_target_table",
    "table_side": "source"
  },
  "gold": {
    "expected_issues": [
      { "field_name": "name", "expected_severity": "warning",
        "description_keywords": ["null"] }
    ]
  },
  "metadata": { "author": "...", "difficulty": "easy" }
}
```

The synthetic builder's `withFieldProfiles: true` populates `name` field's profile with non-zero `null_count`. The AI proposes a null-violation issue on `name` → matches gold's expected_issues.

**Hand-craftability:** High. The fixture's gold encodes "expect AI to detect the null pattern in `name`'s profile".

### 4.2 `extracted-patterns/001-fixture.json`

```json
{
  "id": "_fixture/extracted-patterns/001-fixture",
  "task": "extracted-patterns",
  "input": {
    "source_table": "fixture_source_table",
    "target_table": "fixture_target_table"
  },
  "gold": {
    "min_pattern_count": 3,
    "expected_categories": ["data_quality_pattern"]
  },
  "metadata": { "author": "...", "difficulty": "easy" }
}
```

The synthetic context (1 approved table_mapping + 1 seed quality_issues row + field_profiles) gives the AI enough to extract ≥3 patterns. With `data_quality_pattern` from the seed quality_issues, that category is reliably present.

**Hand-craftability:** Medium. The gold's `min_pattern_count: 3` is a heuristic. May need calibration after first eval runs.

### 4.3 `fix-options/001-fixture.json`

```json
{
  "id": "_fixture/fix-options/001-fixture",
  "task": "fix-options",
  "input": {
    "source_table": "fixture_source_table",
    "target_table": "fixture_target_table",
    "seed_issue": {
      "field_name": "name",
      "severity": "warning",
      "title": "fixture_source_table.name",
      "description": "Null name on 5% of rows"
    }
  },
  "gold": {
    "min_option_count": 2,
    "max_option_count": 3,
    "requires_low_risk_option": true
  }
}
```

The runner's `runOneFixOptionsExample`:
1. Calls `buildSyntheticMappingContext({ ..., withFieldProfiles: true, seedQualityIssue: input.seed_issue })`
2. Reads `qualityIssueId` from the returned `BuiltMappingContext`
3. Calls `generateFixSuggestions({ issueId: qualityIssueId, evalContext: {...} })`
4. Scores `result.rawFixOptions` against gold

**Hand-craftability:** Medium-high. Seed issue is part of the fixture input, not the gold — so the fixture author defines what kind of issue to test against.

### 4.4 Recommendation: builder pre-populates context, fixtures stay small

All 3 fixtures are <40 LOC each. Field profiles and seed quality_issues live in code (the builder), not in JSON — easier to author + maintain.

---

## Section 5 — B-1 / B-2 / B-3 implementation phasing

### B-1: Foundation (~280-340 LOC)

**Code:**
- Add 3 enum values to `LLMFeature` in `lib/ai/llm-client.ts` (~3 LOC)
- Refactor `runAIAugmentedChecks` to object-style + add `evalContext` + `skipVerificationAndPersist` branch + return `rawProposals` field (~50 LOC)
- Refactor `extractMigrationIntelligence` to object-style + add `evalContext` + `skipPersist` branch + return `rawPatterns` field (~40 LOC)
- Refactor `generateFixSuggestions` to object-style + add `evalContext` + `skipPersist` branch + return `rawFixOptions` field (~40 LOC)
- Extend `synthetic-context-builder.ts`: `withFieldProfiles` + `seedQualityIssue` parameters (~110 LOC)
- Extend `EvalTask` union in `lib/eval/types.ts` (+3 values) + `loader.ts` TASKS array + `examples` Record initializer (~10 LOC)
- Update CLI argv parsing in `scripts/eval.ts` to allow new task names (~10 LOC)

**Tests:**
- Builder unit tests for the new parameters (with-profiles inserts the right rows; with-seed-issue returns id) (~50 LOC)
- Existing callsite regression tests should still pass (the object-style refactors must keep production behavior unchanged)

**Verification gates:**
- `pnpm tsc --noEmit` clean
- `pnpm vitest run` — full suite passes; baseline 3042 + ~5-10 new = ~3047-3052
- `pnpm test:integration` heritage flag-OFF — byte-identical (production callsites unchanged)
- NO eval feature wiring yet → no eval-flag-ON spend in B-1
- Spend cap: $0

### B-2: Eval feature wiring (~520-650 LOC)

**Code:**
- 3 dispatch functions in `lib/eval/runner.ts` (mirror `runOneValidationRuleExample` / `runOneMappingSuggestionExample`): `runOneQualityIssuesExample`, `runOneExtractedPatternsExample`, `runOneFixOptionsExample` (~250 LOC total)
- 3 scorer files: `lib/eval/scorers/quality-issues.ts` (~150 LOC), `lib/eval/scorers/extracted-patterns.ts` (~180 LOC; canonical-pattern lookup adds bulk), `lib/eval/scorers/fix-options.ts` (~140 LOC)
- Runner dispatch switch updated to handle 3 new task strings (~20 LOC)
- 3 fixture JSON files (~30 LOC each)
- Schema extension: optionally one more field on `_fixture/schema.json` if richer profiling data is needed for issue detection

**Tests:**
- Unit tests for each new scorer with adversarial cases (wrong-field, all-high-risk, etc.) (~120 LOC each = ~360 LOC)
- Wireability sanity tests for each (mirror `validation-rule-wireability.test.ts`) (~60 LOC each = ~180 LOC; or one combined file)

**Verification gates:**
- `pnpm tsc --noEmit` clean
- `pnpm vitest run` — full suite passes; B-1 baseline + ~30-50 new tests
- 3 flag-OFF pre-flights: each $0
- 3 flag-ON smokes: each ~$0.05; **all 3 must score ≥ 0.5** (sanity floor; expected 0.85-1.0 with the rich descriptions)
- Regression: existing `eval mapping`, `eval validation-rule`, `eval mapping-suggestion` flag-ON smokes must still score 1.000
- Spend cap: $0.30

### B-3: Meta-documentation (~50-80 LOC)

**Code:**
- `docs/anthropic-strict-mode-constraints.md` — catalog of known strict-mode rejections (oneOf, additionalProperties:true, minimum/maximum on numbers, minItems/maxItems on arrays). Discovered across PR 12.1, PR 12.1.5 B-2, Path 2 PR 1. Pre-empts future probes.
- `docs/known-issues.md` — log entry for the 1-test-flake on `tests/eval/runner.test.ts > runEval — env-var guard` under concurrent load (documented across PR 12.1.5 + Path 2 PR 1 reports).

**Verification gates:**
- Docs lint if applicable; otherwise just `git status` clean
- Spend cap: $0

---

## Section 6 — Risk assessment

### R1: Production code paths leak DB rows during eval runs

**Specific risks:**
- `quality_issues`: project FK with CASCADE — ✅ teardown handles it
- `migration_intelligence`: NO project FK — ⚠️ would leak unless skipPersist is honored
- `data_rows`: not populated under this design
- `fix_history` / `fix_snapshots`: not populated by `generateFixSuggestions` (separate function `applyFix` owns those)

**Verification gate:** Add a B-2 invariant to `finalCleanupCheck` that queries `migration_intelligence WHERE source_project_ids @> ARRAY[<EVAL_USER_ID>]::uuid[]` and asserts 0 rows after each run. If skipPersist is honored, this trivially passes; if a bug bypasses it, the invariant catches the leak loudly.

### R2: Scorers produce false positives/negatives

**Per-scorer adversarial cases (in unit tests, NOT eval fixtures):**
- `scoreQualityIssueDetection`: a proposal with all-correct fields but every verification_sql failing safety → confirm sqlSafetyRate = 0 axis-isolation
- `scoreExtractedPatterns`: 8 patterns with `pattern_type: "ad_hoc"` → confirm canonicalPatternTypeUsage = 0
- `scoreFixOptions`: 3 options at `risk_level: 'high'` → confirm `hasLowRiskOption` = 0

**Verification gate:** B-2 unit-test files include 2-3 adversarial cases per scorer. CI gates them.

### R3: Fixtures encode implicit priors

**Methodology distinction (locked):** Path 2 fixtures are minimal single-example smoke tests, NOT benchmarks.

**Specific traps avoided:**
- No specific verification_sql strings ground-truthed (R3 on quality_issues)
- No specific pattern_type values ground-truthed (R3 on extracted_patterns) — only "is in canonical set" not "equals X"
- No specific SQL strings ground-truthed (R3 on fix_options)

**Verification gate:** Phase B fixture-author review pass before each fixture commits — confirm gold is structural, not point-prediction.

### R4: Per-feature cost adds up

PR 12.1 baseline: ~$0.0298/run. PR 12.1.5 enrichment: ~$0.0461/run. Path 2 PR 1 added 2 features (~$0.10 total verification). **Path 2 PR 2 adds 3 more.** Estimated:

| Eval | Approx cost |
|---|---|
| `eval quality-issues` flag-ON smoke | ~$0.05 |
| `eval extracted-patterns` flag-ON smoke | ~$0.07 (larger context payload from joined queries) |
| `eval fix-options` flag-ON smoke | ~$0.05 |
| Regression checks (3 existing tools) | ~$0.10 |
| **Total B-2 verification** | **~$0.30** |

"Run all 6 evals" becomes ~$0.40 dev-cost. Acceptable for development; flag for ops if eval is wired to CI.

**Verification gate:** B-2 spend cap is $0.30; track actuals in commit message.

### R5: Test count baseline shifts

Current baseline: **3042** (post-PR-#31, confirmed via the merge log). Path 2 PR 2:
- B-1 adds ~5-10 builder tests
- B-2 adds ~30-50 scorer tests
- B-3 adds 0 (docs only)

**Verification gate:** Each commit's body states the EXACT before/after test count. If non-AI test-count drift exceeds ~20 between B-1 and B-2 starts, investigate.

### R6: Anthropic strict mode surfaces another constraint

**Track record:**
- PR 12.1 surfaced `additionalProperties: false` requirement
- PR 12.1.5 B-2 surfaced `oneOf` rejection
- Path 2 PR 1 surfaced `additionalProperties: true` rejection
- B-3 cataloging this in `docs/anthropic-strict-mode-constraints.md`

The 3 Hard tools' schemas (`EMIT_QUALITY_ISSUES_TOOL`, `EMIT_EXTRACTED_PATTERNS_TOOL`, `EMIT_FIX_OPTIONS_TOOL`) all have `additionalProperties: false` per the recent harmonization. They use enum types and arrays of objects extensively. **One more probe area:** these schemas use array `items: { type: 'object', properties: {...} }` heavily — confirm strict mode handles those (it should; Path 2 PR 1's `EMIT_VALIDATION_RULE_TOOL` had this and worked).

**Verification gate:** B-2's flag-ON smokes will surface any new strict-mode rejection at `$0` cost (the API rejects with HTTP 400 before any tokens are billed).

### R7: skipPersist + verification_sql skip are correctly bypassed

**Specific risks:**
- The `runAIAugmentedChecks` skipVerificationAndPersist gate must be the FIRST thing checked after AI parse — before the `proposal.length === 0` early-return is fine, but before the verification_sql loop
- `extractMigrationIntelligence` skipPersist must wrap the for-loop without disrupting the dedupe-related read of `existing` (which happens BEFORE the loop)
- `generateFixSuggestions` skipPersist must wrap the UPDATE call, but NOT the `parsed.fix_options` validation (eval still wants invalid output to propagate as an error)

**Verification gate:** B-1 adds a unit test per refactored function: pass `evalContext.skipPersist: true`, mock the underlying callLLM, assert NO DB writes happen and the raw output is returned. Pure-function logic, no real DB.

### R8: Synthetic-context-builder field_profiles content drifts from production-realistic

The builder's hand-crafted field_profiles values must be plausible enough that the AI surfaces issues. If `null_count` is 0 and `cardinality` matches `total_rows`, the AI sees "perfect data" and proposes nothing → score 0.

**Verification gate:** B-2 first flag-ON smoke for `quality-issues` — if score is 0 with `errored: false`, the field_profiles are TOO clean. Iterate the seed values until the AI proposes ≥1 issue against the smoke fixture. Document the calibration in the builder's docstring.

---

## Section 7 — Surprises / divergences from this prompt's claims

Already enumerated as DIVERGENCE callouts at the top of the document:

1. Function name `extractMigrationIntelligence` (not `extractMigrationPatterns`)
2. Zero reserved enum values for the 3 Hard tools
3. `runAIAugmentedChecks` filters proposals via verification SQL — eval needs `skipVerificationAndPersist`, not just `skipPersist`. This is structurally different from `extractMigrationIntelligence` (where `skipPersist` is sufficient) and from `generateFixSuggestions` (where `skipPersist` is sufficient).
4. The eval-friendly path **does NOT need synthetic `data_rows`** under the locked design (because `runAIAugmentedChecks` skipVerificationAndPersist bypasses the SQL execution against data_rows; the other two tools don't read data_rows at all). This shrinks builder extension scope by ~50-80 LOC vs the original 280-330 estimate.
5. `extractMigrationIntelligence` early-returns when no approved table_mappings exist — the synthetic builder already provides one, so naturally satisfied.
6. `generateFixSuggestions` requires a pre-existing `quality_issues` row → builder needs `seedQualityIssue` parameter (this IS a scope addition).
7. `migration_intelligence` is user-scoped (no project FK), confirming C2 skipPersist necessity.

---

## What's NOT in this investigation (out of scope)

- Implementation of any code (Phase B work)
- Authoring fixture JSON content with specific gold labels (Phase B + Kaan jointly during fixture review)
- Phase 3 multi-step reasoning loops or self-consistency
- Wiring `eval_transform` or `eval_nl_to_sql`
- Eval-harness CI integration
- LLM calls (this audit is read-only; spend cap is $0)
- Committing this investigation doc (Phase B PR will pick it up alongside the code edits)

## Phase B implementation budget summary

| Sub-commit | LOC delta | Spend | Hours |
|---|---|---|---|
| B-1 foundation | ~280-340 | $0 | 4-5 |
| B-2 wiring + scorers + fixtures | ~520-650 | ~$0.30 | 6-8 |
| B-3 meta-docs | ~50-80 | $0 | 1-2 |
| **Total Phase B** | **~850-1,070 LOC** | **~$0.30** | **11-15 hours** |

Total wall-clock: ~3 working days for one engineer + Claude Code, including review cycles between sub-commits.

*End of Path 2 PR 2 Phase A investigation.*
