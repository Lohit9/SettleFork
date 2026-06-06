# Backend Handoff — Ready-to-Load (SET-166) + DQ Issues (SET-167)

**Author:** Alex (founding eng) · **For:** Lohit + team · **Date:** 2026-06-03 · **Status:** frozen-contract handoff before travel

This doc is the interface. Lohit builds the SET-166 grid and SET-167 DQ panel against the contracts in §3 — **those signatures and return shapes will not move while the backend cleanup in §4 happens underneath.** Everything else (god-file split, write-path consolidation, validation enforcement) is internal refactor that does not touch these reads.

All file:line references below were verified against source on 2026-06-03.

---

## 1. The pipeline + the non-negotiable invariant

Five-stage migration pipeline (`CLAUDE.md` §4.1):

1. **Schema Overview** — connect/upload source, profile tables/columns/types. Manual edits here are the source of truth.
2. **Mapping** — AI proposes source→target field mappings + confidence; user reviews/edits/approves.
3. **Map & Transform** (unified) — the transform (coalesce/concat/custom SQL) is described inline per mapping, not a separate stage. Backs the Map page. **Read contract: `getMapTransformSpec`.**
4. **Validate** — runs against **staged data only**, never source. Surfaces row-level failures with root-cause back to the offending mapping/transform. **Read contracts: `getQualityIssues`, `computeReadinessScore`, `getValidationRules`.**
5. **Ready-to-Load / Migration Center** — the materialized loadable records in the customer answer-key shape. **Read contract: `getReadyToLoadView`.**

**The product invariant (CLAUDE.md §1, do not break):**

> **AI proposes → Deterministic validates → Human approves.**

The honest current state: the **"deterministic validates" middle gate is NOT enforced at the human-approval boundary** (see SET-219 in §4). The validator (`lib/validation/mapping-validator.ts`) is pure and wired only into the AI-propose loop — `validateMappingBatch` is called at `mapping-engine.ts:2765` and in `self-correction.ts:261,375`, and nowhere at approval. `approveFieldMapping` (`mappings-for-redesign.ts:394`) flips status to `approved` with no deterministic check. Closing this is the #1 pre-travel backend item and it produces the stable failure-contract SET-167 reads.

---

## 2. Data-model spine (accurate: N→1 multi-source already exists)

```
organization (org_id — multi-tenant root; RLS by construction, CLAUDE.md §4.2)
  └─ projects                      (one migration engagement)
       └─ datasets   role ∈ {source, target}
            └─ tables
                 └─ fields
target_field_mappings (TFM)        one row per (project, target field)
  ├─ mapping_sources               N source fields per TFM:
  │     ordinal · combination_type {single | concat_space | concat_comma | custom_sql} · join_spec (cross-table)
  └─ transformations               one per TFM (soft invariant, NOT DB-enforced)
target_field_coverage              per-target-field coverage/ack/approval state
staged_data_rows                   keyed by table_mapping_id; transformed_row_data (JSONB) — Validate + Ready-to-Load read here
```

**Correction for the 6/3 meeting — the model is NOT "linear A→B."** N→1 multi-source already ships:
- A TFM owns many `mapping_sources` (ordinal-ordered), with `combination_type` (single / concat_space / concat_comma / custom_sql) and `join_spec` for cross-table joins; cross-table sources carry `source_table_id`.
- `getMapTransformSpec` already renders this today (`buildSpecRows`, `map-transform-spec.ts:100-205`): joins multiple sources as `TableA.Field | TableB.Field`, humanizes Concatenate / Coalesce / Conditional rule / Custom transform, and emits per-row `explanation` from `ai_reasoning`.

**What is genuinely missing** (do NOT greenlight a data-model rewrite):
1. **Lineage / versioning** — one source feeding *multiple* targets is representable but not surfaced; there is no TFM-to-TFM lineage across regenerations. This is an additive read-side concern, not a schema rewrite.
2. **A graph VIEW in the UI** — Lohit/Kaan's lane, presentation over data that already exists.

The deliverable for the meeting is: show `getMapTransformSpec` output proving N→1 + concat/coalesce/custom-SQL + cross-table joins already work; scope the gap to a thin lineage contract + visualization, not a model rewrite.

---

## 3. FE-facing contracts Lohit consumes — FROZEN, build against these

> **Build against the shape, not specific values.** Confidence/score numbers are uncalibrated (SET-220) and may move; the shapes below do not.
>
> **✅ Status (Jun 3):** the auth guards + pagination are **merged to `dev` (#228)** — these contracts are live and frozen. You can wire the live reads now; any "Alex will fix" note below is already done.

### 3.1 `getReadyToLoadView(projectId, { rowLimit?, offset? })` → `ReadyToLoadTable[]`  — SET-166 grid backing read
File: `lib/actions/ready-to-load.ts:53` (type `@:21`, pure `buildHeaderRows @:37`).
**Consumers today: NONE.** Only consumer is the unit test. No route, no page imports it — this is the SET-166 grid's intended backing read and **Lohit must wire it.** (The existing `app/app/projects/[projectId]/outputs/*` page is the legacy Migration Center surface backed by `getOutputsPageData`, a different contract — do not confuse.)

```ts
interface ReadyToLoadTable {
  targetTable: string
  targetFields: string[]        // Row 1: target field names, table order
  sourceMapping: string[]       // Row 2: per-field source, one of:
                                //   "TableA.Field | TableB.Field" | "(constant)" | "(unmapped)" | "(value assignment)"
  rows: Record<string, unknown>[]  // Rows 3+: transformed_row_data; default page 500, page via `offset`
  rowCount: number              // count of the RETURNED page (=== rows.length)
  totalRowCount: number         // ✅ true staged total — BIND THE GRID HEADER TO THIS, not rowCount
  materialized: boolean         // true iff staged data exists (totalRowCount > 0)
}
```
- Header rows reuse `getMapTransformSpec`; data is read-only from `staged_data_rows.transformed_row_data` — **no re-transform here.**
- The 4 `sourceMapping` sentinels are produced by `buildHeaderRows`: `(unmapped)`, `(constant)` (acknowledged), `(value assignment)` (custom_sql, no source), else `Table.Field`.

**✅ Both shipped — merged to `dev` in #228. The contract is frozen:**
1. **Pagination.** Pass `offset` to page; **bind the grid header to `totalRowCount`** (the true staged total), not `rowCount` (the returned-page count). Default page size 500.
2. **Auth guard.** `requireProjectPermission(projectId, 'viewer')` now gates both reads — no shape change. You can wire the **live** read now; the cross-org gap that made me say "use the fixture" is closed.

### 3.2 `getMapTransformSpec(projectId)` → `MapTransformSpecRow[]`  — Map page + SET-166 header strip
File: `lib/actions/map-transform-spec.ts:172` (type `@:22`, pure `buildSpecRows @:100`).
**Consumers today: NONE in FE** (only its test + `ready-to-load.ts`). Lohit consumes it directly for the grid's column/lineage strip. **This is the cleanest, most stable contract in the set — the right interface to build against while the mapping internals get refactored underneath.**

```ts
type SpecRowKind = 'mapped' | 'value_assignment' | 'acknowledged' | 'unmapped'

interface MapTransformSpecRow {
  sourceTable: string | null
  sourceField: string | null      // N-source joined with ' | '
  targetTable: string
  targetField: string
  transformation: string          // humanized: 'Direct copy' | 'Concatenate (space)…' | 'Coalesce…'
                                   //          | 'Conditional rule…' | 'Custom transform…' | '—'
  explanation: string             // from ai_reasoning / acknowledgment_reason — this is "user insight into AI decisions"
  confidence: number | null       // normalized to 0–100 %; null when unmapped
  needsReview: boolean            // confidence < 25% (SET-115). UI shows raw %, NO buckets — do not re-derive
  kind: SpecRowKind
  transformSql: string | null     // raw SQL for "show SQL" affordance
}
```
- Derived entirely from persisted mapping data via `hydrateProjectData` — **no LLM call.**
- **Confidence normalization (don't re-implement):** stored as 0–1 (Path D) or 0–100 (legacy); `confidencePct` always returns a %. Bind to the %.
- **needsReview threshold is fixed at <25%** — do not re-bucket on the client.
- Already covers N→1 multi-source (`mapping_sources` + `combination_type`).

Same auth gap as 3.1 (`hydrateProjectData @ _outputs-core.ts:327` documents "callers upstream are responsible for auth gating" — currently nobody is). Alex adds `requireProjectPermission(projectId, 'viewer')`. No shape change. **This contract is the de-risking lever: as long as `buildSpecRows` output is frozen, the 6,269-line `mappings-for-redesign.ts` and the legacy/redesign split can be refactored without touching the FE.**

### 3.3 DQ panel reads (SET-167) — already WIRED into `data-quality/page.tsx:33-35`

| Contract | File | State | Note for Lohit |
|---|---|---|---|
| `getQualityIssues(projectId)` → `{ issues: QualityIssue[]; hasMappings: boolean; stagedTargetTableIds: string[] }` | `quality-fixes.ts:716` | **leaky** | Stable subset below. `stagedTargetTableIds` is the authoritative "Staged" badge signal. |
| `getValidationRules(projectId)` → `ValidationRule[]` | `validation-rules.ts:1050` | **clean** | Safe to freeze. Lowest-risk in the set. |
| `computeReadinessScore(projectId)` → `ReadinessScore` | `readiness-score.ts:50` | **clean** | Freeze the shape; **the score number may move (SET-220) — bind to shape, not value.** |

`QualityIssue` **stable fields** (rely on these): `id, project_id, field_id, table_id, stage ('source'|'in_flight'|'target'), severity ('blocking'|'warning'), title, description, affected_records, ai_suggested_fix, ai_fix_options (FixOption[]), status ('open'|'fixed'|'accepted_risk'), validation_rule_id, created_at`.
**Do NOT rely on** (migration-archaeology optionals, presence/ordering not guaranteed): `detection_type?, issue_kind?, root_cause?, root_cause_breakdown?`.
**Leak caveat:** `generated_sql` and `affected_rows_sample` (raw customer data) currently ship in every list row. Alex will move raw row samples behind the existing lazy `getAffectedRowsForIssue` (`quality-fixes.ts:917`) and trim the list payload. **Lohit: drill into rows via `getAffectedRowsForIssue(issueId)`, not the list field.** `computeReadinessScore.top_issues` embeds full `QualityIssue` rows — same leak caveat.

`ReadinessScore` shape: `{ score, status ('ready'|'at_risk'|'not_ready'), blocking_count, warning_count, ready_field_count, total_fields_checked, unmapped_required_count, top_issues (max 5), components?:{ mapping(20), transform(25), blocking(40), warnings(5), staging(10) } }`.

### 3.4 DQ mutations (SET-167 action handlers) — UNSTABLE, do not build the write UI yet
`applyFix / acceptRisk / revertFix / markIssueFixed / triggerStagedValidation / runFullScan / getAffectedRowsForIssue` — `quality-fixes.ts:99,323,387,780,1172,576,917`.
Wired in `DataQualityContent.tsx`, but the result envelope is **not** uniform: mostly `{ success, error? }`, some return refreshed counts, some don't; **`applyFix` takes a positional fix-option index (footgun)** + optional `skipSnapshot`; `acceptRisk` takes free-text reason.
**Lohit: hold the fix/accept-risk write UI until Alex standardizes the envelope** to the `CLAUDE.md §9.3` discriminated union (`{ success:true, … } | { success:false, error }`) and documents `applyFix(issueId, optionIndex, skipSnapshot?)`. The list reads (3.3) are safe to build against now.

---

## 4. Known debt — SAFE vs UNSAFE to touch

| # | Item | Verified at | Safe for Lohit? |
|---|---|---|---|
| Security | `getReadyToLoadView` + `getMapTransformSpec` have **no auth/org guard** — `supabaseAdmin` scoped only by `project_id` | `ready-to-load.ts:72-99`; `_outputs-core.ts:327` | Alex fixes (adds `requireProjectPermission viewer`); shape unchanged — **safe to build against** |
| Security (defense-in-depth) | `fields.ts:359` TFM count not scoped by `project_id` | `fields.ts:359` | **NOT a live breach** — verified: `requireProjectPermission(projectId,'viewer')` already runs at `fields.ts:345` before the service-role query, and `target_field_mappings` is `UNIQUE(project_id, target_field_id)`. It's a real defense-in-depth gap (CLAUDE.md §4.2 "by construction"); cheap fix is `.eq('project_id', projectId)` (projectId already resolved at :341). **Do NOT pitch to Kaan as a fixed data breach.** |
| SET-219 | Deterministic validation built but **not enforced at approval** | `mapping-engine.ts:2765` only | Alex's lane; produces SET-167 failure-contract |
| Write-path debt | ~20 scattered TFM writers; **bulk-approve bypasses the audited funnel** with raw `.update({ status: 'approved' })` | `mappings-for-redesign.ts:3515,3655,4509,…` | UNSAFE to touch — does not change reads |
| SET-216 | Template flywheel **BROKEN, not dormant** | `projects.ts:284` | see meeting corrections below |
| God-files | `mappings-for-redesign.ts` (6,269), `transformations.ts` (3,879), `mapping-engine.ts` (3,282) | confirmed | UNSAFE — Alex splits behind unchanged exports; **do not import from `mappings-for-redesign.ts` directly** |
| Two mapping systems | legacy `mappings.ts` + redesign `mappings-for-redesign.ts`, bridged by `compat/mapping-shim.ts`, both write prod | confirmed | UNSAFE — both live; removal is post-travel |
| Lint debt | **74 `console.log`, ~40 `any`, 32 `eslint-disable`** (CLAUDE.md §9) | counted 6/3 | mechanical sweep; coordinate FE-file timing to avoid merge conflicts |

**Meeting corrections (several asks are imprecise):**
- **"Graph TFM — linear A→B too restrictive"** → inaccurate. Model already does N→1 (§2). Real gap = UI graph view + lineage/versioning, **not a data-model rewrite.**
- **"Template system built but dormant, holding for user growth"** → wrong. **It is BROKEN (SET-216).** `snapshotTemplate` (`projects.ts:284`) is fire-and-forget (`.catch` only logs), runs only on project *completion*, and the only completed prod projects have 0 approved maps → harvests 0 rows silently. Fix = harvest on the *approval boundary* (shadow-write on approve), awaited + logged. Pairs with SET-219 (same hook).
- **"Deterministic checks"** → partially done. Validator exists + runs at generation, **not at human approval.** Top correctness item.
- **"User insight into AI decisions"** → largely already shipped: `explanation`, `ai_reasoning`, `confidence%`, `needsReview` all in `getMapTransformSpec`; `ai-edit-history.ts` exists. Remaining = UI surfacing (Lohit) + confidence calibration (SET-220, async).
- **"Eval framework"** → already built + wired (`pnpm eval rootstock-baseline`). Lock it as a CI gate; tune engine accuracy async.
- **"Migration chatbot (3rd-party)"** → net-new integration, zero dependency on Lohit's grid/panel. Out of pre-travel scope.
- **Go/Rust** → decided out, not in scope.

---

## 5. How to run / where things live

- **Dev preview:** `dev` git branch deploys to a Vercel preview against the **same prod Supabase** (single project, `uzfbwmiskqxwixxtlmye` — there is no separate dev DB; `CLAUDE.md §8.3`). For risky/mutating verification use a **scratch Supabase**, never prod.
- **Eval / self-verify:** `pnpm eval rootstock-baseline` (`scripts/eval.ts`, run via the `eval` npm script with `--env-file=.env.local`). Scorers in `lib/eval/scorers/`. 17 gold rows on the curated Prosys→Rootstock subset. **Run this before/after any approval-path change** to confirm the 17 gold mappings still approve.
- **Lohit's grid fixture:** `~/Desktop/rootstock-ready-to-load.fixture.ts` — build the SET-166 grid against this (real Ready-to-Load shape, zero prod secrets) until the live read is auth-gated.
- **Contracts live at:** `lib/actions/ready-to-load.ts`, `lib/actions/map-transform-spec.ts`, `lib/actions/quality-fixes.ts`, `lib/actions/validation-rules.ts`, `lib/quality/readiness-score.ts`.
- **DQ panel page:** `app/app/projects/[projectId]/data-quality/page.tsx` → `DataQualityContent.tsx`.
- **Env:** `.env.local` (prod keys present). Stage contracts: `docs/PRODUCT_PRINCIPLES.md`. Full data model: `docs/architecture/`.

---

## 6. Corrected priority / sequence (pre-travel)

Ordered to maximize unblock-Lohit + security per effort; one concern per PR; tests-first on the risky ones; **read contracts (§3.1/§3.2) frozen across all of them.**

1. **Freeze + document the FE read contracts (this doc).** Docs-only, zero risk, highest leverage — Lohit is unblocked the moment Alex is on a plane, and writing the boundary down de-risks every PR below. *(Ship first.)*
2. **Harden `fields.ts:359`** with `.eq('project_id', projectId)` (+ sibling coverage/validation_rules counts). S-effort, low-risk, defense-in-depth, Lohit-independent. *(First code PR.)*
3. **Add the auth guard** (`requireProjectPermission(projectId,'viewer')`) to `getReadyToLoadView` + `getMapTransformSpec`, and add `{ offset?, totalRowCount }` to the Ready-to-Load shape. This is the only contract change — do it before Lohit wires the live read so the grid header is stable.
4. **Console.log purge** (74 across 23 files) → delete or route load-bearing ones through a structured logger. Compliance (CLAUDE.md §9.5), low-risk, clears no-console eslint-disables. Coordinate timing on FE files.
5. **Consolidate TFM status writes behind one audited gate** (individual + bulk; kill the raw `.update({status:'approved'})` bypass). High-risk keystone — tests-first, run on a scratch Supabase. Unblocks 6.
6. **Enforce SET-219** — call the deterministic validator inside that single gate so an ERROR-severity issue blocks approve (warnings pass to the human). Depends on 5. Verify with `pnpm eval rootstock-baseline` (all 17 gold must still approve). Produces the SET-167 failure-contract. Pair with the **SET-216 harvest-on-approve fix** (same hook, make it awaited + logged).
7. **Lock eval as a CI regression gate.** Cheap, high-leverage.
8. **Defer to post-travel:** god-file split (behind unchanged exports), legacy/redesign system collapse, confidence calibration (SET-220), graph visualization (Lohit/Kaan), migration chatbot.

---

## 7. Edge cases & stress-test checklist (SET-166 / SET-167 — Lohit)

"Done" isn't "the happy path renders" — it's **trustworthy on the real Epicor→Rootstock data.** Drive that dataset through Ready-to-Load + the DQ panel yourself on the **dev preview** (admin login, not local), screen-record it, and keep a running list of every case where it breaks or looks wrong. The edge-case log matters more than the happy path.

**Force these — each is a real shape in the data:**
- **Unmapped fields** — `kind:'unmapped'` / `'(unmapped)'`; check the "N to review" count.
- **Multi-source / concat** — `sourceField:"A.x | B.y"`, `transformation:'Concatenate…'`; row 2 must show both.
- **Cross-table joins** — sources from different tables (`join_spec`); verify the lineage strip.
- **Value assignment** — `kind:'value_assignment'` / `'(value assignment)'` (custom_sql, no source).
- **Acknowledged / constant** — `kind:'acknowledged'` / `'(constant)'`.
- **3-state distinction** — mapped vs unmapped vs acknowledged must be visually unambiguous.
- **Huge + null-heavy tables** — 2.6M `staged_data_rows`. **Page via `offset`; bind the header to `totalRowCount`.** The grid must not load all rows or lie about the total.
- **Partitioned targets** — one target fed by Partition A + B from different sources (SET-166 spec requires this).
- **Stale transforms** — edit a mapping after it's transformed → the column should read "stale / regenerate," not silently show old data.
- **Confidence display** — per `DESIGN.md` + SET-115: raw %, needs-review < 25%, **no green/amber buckets** (uncalibrated, SET-220 — bind to the field, not the number).

**DQ panel (SET-167):** the *write* actions (`applyFix`/`acceptRisk`) are **not frozen** — hold that UI. The *reads* (`getQualityIssues`/`getValidationRules`/`computeReadinessScore`) are safe to build against now.

**Cadence:** daily 4-line standup (did / doing / blocked / biggest risk) + a Friday demo + the running edge-case log. Have Kaan click through as a hypothetical user — any hesitation is a bug.

---

**Skipped:** did not run the build or eval (read-only mandate during scoping). **Fragile:** `rowCount === rows.length` will mislead the grid header until §6 step 3 ships pagination — design for `totalRowCount` now. **Breaks first:** if Lohit imports from `mappings-for-redesign.ts` directly (mid-split) or binds the grid to specific confidence/score *values* instead of shapes (SET-220 will move the numbers).
