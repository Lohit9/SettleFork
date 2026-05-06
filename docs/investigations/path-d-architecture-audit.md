# INF-23 — Path D Architecture Audit

**Date:** 2026-05-06
**Branch context:** working tree of `experiment/mapping-two-pass-path-c` (uncommitted Path C delta on top of `main` at commit 5040a6c). Findings cite both as needed.
**Mode:** READ-ONLY investigation. No code changes. No DB writes.

> Synthesis of five parallel investigation passes. Every claim cites a file:line so it can be verified. Where two passes disagreed, I annotate the discrepancy inline rather than silently picking one.

---

## A. AI Agent Inventory

19 distinct AI agents identified across `lib/ai/` and `lib/actions/`. Mapping pipeline carries the most surface area; downstream deliverables are mostly AI-generated; query/exploration tools are AI but ephemeral.

### A.1 `mapping_generate` (production / Path B)

- **Entry point:** `generateMappings()` at [lib/actions/mappings.ts:480](lib/actions/mappings.ts#L480)
- **Files:** [lib/actions/mappings.ts](lib/actions/mappings.ts), [lib/ai/mapping-engine.ts](lib/ai/mapping-engine.ts), [lib/ai/single-agent-mapping.ts](lib/ai/single-agent-mapping.ts), [lib/ai/multi-agent-orchestrator.ts](lib/ai/multi-agent-orchestrator.ts), [lib/ai/tool-schemas.ts:189](lib/ai/tool-schemas.ts#L189)
- **Trigger:** "Generate mappings" button → server action with `sourceTableIds` + `targetTableIds`
- **Reads from DB:** `datasets` (role), `table_mappings`, `fields`, `field_profiles` (samples + distributions), `source_field_acknowledgments`, `schema_documents`, `migration_intelligence`
- **Prompt construction:** `withProvenanceGuidance(MAPPING_GENERATION_AGENT_SYSTEM_PROMPT)` at [lib/ai/mapping-engine.ts:1579](lib/ai/mapping-engine.ts#L1579); context built via `buildAIContext()` at [lib/actions/mappings.ts:193](lib/actions/mappings.ts#L193); schema overview via `formatSchemaOverviewBlock()` at [lib/actions/mappings.ts:236](lib/actions/mappings.ts#L236); business context via `readBusinessContext()` at [lib/actions/mappings.ts:234](lib/actions/mappings.ts#L234)
- **Tool forcing:** `EMIT_TABLE_MAPPINGS_TOOL` forced at [lib/ai/single-agent-mapping.ts:148](lib/ai/single-agent-mapping.ts#L148)
- **Output persistence:** `target_field_mappings` (ai_reasoning, confidence, status), `mapping_sources`, `transformations` via `persistClaudeFieldMappingsForTM()` in mapping-engine.ts
- **Caching:** `cacheControl: true` at [lib/actions/mappings.ts:276](lib/actions/mappings.ts#L276) (BULK / PR 13.1); `cacheControl: false` at [lib/actions/mappings.ts:296](lib/actions/mappings.ts#L296) (single-pair / LOCK #4)
- **Streaming:** YES via `callLLMStreaming()` at [lib/ai/single-agent-mapping.ts:144](lib/ai/single-agent-mapping.ts#L144)
- **Token sizes:** `PER_BATCH_MAX_TOKENS=32000` at [lib/actions/mappings.ts:241](lib/actions/mappings.ts#L241)
- **Tests:** [tests/integration/agent-loop-end-to-end.test.ts](tests/integration/agent-loop-end-to-end.test.ts), [tests/integration/mappings-for-redesign-heritage.test.ts](tests/integration/mappings-for-redesign-heritage.test.ts), [tests/integration/llm-calls-streaming-logging.test.ts](tests/integration/llm-calls-streaming-logging.test.ts)

### A.2 `mapping_generate_multi_agent` (Phase 3.4 / experimental, default OFF)

- **Entry point:** `runMultiAgentMappingPipeline()` at [lib/ai/multi-agent-orchestrator.ts:133](lib/ai/multi-agent-orchestrator.ts#L133)
- **Files:** [lib/ai/multi-agent-orchestrator.ts](lib/ai/multi-agent-orchestrator.ts), [lib/ai/multi-agent-types.ts](lib/ai/multi-agent-types.ts), [lib/ai/multi-agent-prompts.ts](lib/ai/multi-agent-prompts.ts)
- **Trigger:** Routed via `runMappingGenerationForPair()` when `AI_PHASE_3_MULTI_AGENT_ENABLED=1` at [lib/actions/mappings.ts:257](lib/actions/mappings.ts#L257)
- **Pipeline tiers:** T0 Generator ×3 (`EMIT_MAPPING_CANDIDATES_TOOL`), T1 Specialists (cross-table + cardinality), T2 Critic ×3, T3 Refinement (delegates to single-agent path)
- **Caching:** `cacheControl: false` at [lib/ai/multi-agent-orchestrator.ts:275](lib/ai/multi-agent-orchestrator.ts#L275)
- **Streaming:** NO — `callLLM` (non-streaming) for all agents
- **Cost ceiling:** `PER_PAIR_MAX_COST_USD=15.0` at [lib/ai/multi-agent-orchestrator.ts:80-83](lib/ai/multi-agent-orchestrator.ts#L80-L83)

### A.3 `mapping_generate` Path C variant (two-pass, on `experiment/mapping-two-pass-path-c` only)

- **Entry point:** `runSingleAgentMappingLoopTwoPass()` at [lib/ai/single-agent-mapping.ts](lib/ai/single-agent-mapping.ts) (modified file on the experiment branch)
- **Files (NEW on branch):** `lib/ai/two-pass-experiment.ts` (127 LOC), `lib/ai/two-pass-prompts.ts` (158 LOC); `lib/ai/single-agent-mapping.ts` (+200 LOC modified); `lib/ai/mapping-engine.ts` (+34); `lib/actions/mappings.ts` (+17); `supabase/migrations/091_mapping_experiments_view.sql` (108 LOC), `supabase/migrations/092_target_field_mappings_experiment_run_id.sql` (190 LOC)
- **Pass 1:** reasoning-only (no tool); Pass 2: extraction (tool-forced) with prior-reasoning block injected
- **Output persistence:** writes TFMs with `experiment_run_id` (UUID minted per click) + `experiment_label` (`'path_c_pass_1'` | `'path_c_pass_2'`)
- **Tests:** [tests/integration/mapping-two-pass-experiment.test.ts](tests/integration/mapping-two-pass-experiment.test.ts) (env-gated `RUN_TWO_PASS_INTEGRATION=1`)

### A.4 `mapping_suggest` (per-target AI Suggest)

- **Entry point:** `suggestMappingForTarget()` at [lib/actions/mappings-for-redesign.ts:1014](lib/actions/mappings-for-redesign.ts#L1014); engine at [lib/ai/mapping-engine.ts:1944](lib/ai/mapping-engine.ts#L1944) (`runMappingSuggestion`)
- **Tool forcing:** `EMIT_MAPPING_SUGGESTION_TOOL` at [lib/ai/tool-schemas.ts:239](lib/ai/tool-schemas.ts#L239)
- **Output persistence:** none until user confirms; confirmed mappings via `createFieldMapping()`
- **Streaming:** NO (single-target focus, ~8k tokens)

### A.5 `regenerateFieldMappings` (per-table regen)

- Entry point: `regenerateFieldMappings()` at [lib/actions/mappings.ts:1992](lib/actions/mappings.ts#L1992) — delegates to `mapping_generate` pipeline.

### A.6 `suggestRemainingMappings` (bulk unmapped suggestions)

- Entry point: `suggestRemainingMappings()` at [lib/actions/mappings.ts:2432](lib/actions/mappings.ts#L2432) — loops `mapping_suggest` per unmapped target.

### A.7 `transform_generate`

- **Entry point:** `applyTransform()` at [lib/actions/transformations.ts:200](lib/actions/transformations.ts#L200); supporting prompt builders around [transformations.ts:2795](lib/actions/transformations.ts#L2795)
- **Reads from DB:** TFM (source + target field details), `transformations`, `field_profiles`, `fields`
- **READS `target_field_mappings.ai_reasoning`** via two paths:
  - Substring extraction at [lib/actions/transformations.ts:1244](lib/actions/transformations.ts#L1244) — regex `\[Combination:\s*(.*?)\]` extracts multi-source combination hint
  - Prose-as-context at [lib/actions/transformations.ts:2795](lib/actions/transformations.ts#L2795) — full reasoning string injected into prompt
- **Tool forcing:** `EMIT_TRANSFORM_SQL_TOOL` at [lib/ai/tool-schemas.ts:1452](lib/ai/tool-schemas.ts#L1452)
- **Output persistence:** `transformations.generated_sql` via RPC `dq_apply_field_transform_joined()` at [lib/actions/transformations.ts:650](lib/actions/transformations.ts#L650)
- **Streaming:** NO. Token size ~4k.

### A.8 `validation_rule_from_nl`

- **Entry point:** validation rule generation flow inside [lib/actions/validation-rules.ts](lib/actions/validation-rules.ts)
- **Tool forcing:** `EMIT_VALIDATION_RULE_TOOL` at [lib/ai/tool-schemas.ts:299](lib/ai/tool-schemas.ts#L299)
- **Caching:** `cacheControl: true` (PR 13.1 cohort)
- **Does NOT read** `target_field_mappings.ai_reasoning`.

### A.9 `quality_detection_ai`

- **Entry point:** `runAIAugmentedChecks()` at [lib/actions/ai-quality-detection.ts:150](lib/actions/ai-quality-detection.ts#L150)
- **Tool forcing:** `EMIT_QUALITY_ISSUES_TOOL` at [lib/ai/tool-schemas.ts:861](lib/ai/tool-schemas.ts#L861)
- **Output persistence:** `quality_issues` (title, description, severity, verification_sql)
- **Caching:** `cacheControl: true` (PR 13.1 cohort)
- **Tests:** [tests/integration/detection-engine-heritage.test.ts](tests/integration/detection-engine-heritage.test.ts)

### A.10 `migration_intelligence` (post-migration pattern extraction)

- **Entry point:** `extractMigrationIntelligence()` at [lib/actions/migration-intelligence.ts:150](lib/actions/migration-intelligence.ts#L150)
- **Tool forcing:** `EMIT_EXTRACTED_PATTERNS_TOOL` at [lib/ai/tool-schemas.ts:709](lib/ai/tool-schemas.ts#L709)
- **Output persistence:** UPSERT to `migration_intelligence` (dedup by title)

### A.11 `outputs_readiness_report`

- **Entry point:** `generateReadinessReportInternal()` at [lib/actions/\_outputs-core.ts:674](lib/actions/_outputs-core.ts#L674)
- **Prompt builder:** `buildReadinessReportPrompt()` in [lib/actions/\_outputs-translators.ts](lib/actions/_outputs-translators.ts)
- **Tool forcing:** NONE — text-only callsite (markdown narrative)
- **Output:** DOCX via `buildReadinessDocx()`; written to `outputs` table + storage
- **READS** `target_field_mappings.ai_reasoning` via `_outputs-translators.ts:308, 414` (emits as `reasoning` field in CSV/JSON deliverables)

### A.12 `outputs_migration_runbook`

- **Entry point:** `generateMigrationRunbook()` at [lib/actions/migration-runbook.ts:109](lib/actions/migration-runbook.ts#L109)
- **Tool forcing:** `EMIT_MIGRATION_RUNBOOK_TOOL` at [lib/ai/tool-schemas.ts:1032](lib/ai/tool-schemas.ts#L1032)
- **Reads:** approved table_mappings, transformations, quality_issues, TFMs, validation_rules, schema_documents
- **Output:** DOCX → storage + `outputs` row
- **Token size:** ~20k

### A.13 `outputs_execution_package` (SQL migration scripts)

- **Entry points:** `generateExecutionPackageInternal()` at [lib/actions/execution-package.ts:200](lib/actions/execution-package.ts#L200); `generateCompartmentalizedPackageInternal()` at [lib/actions/execution-package.ts:500](lib/actions/execution-package.ts#L500)
- **Prompt assembly:** [lib/actions/\_execution-package-prompt.ts](lib/actions/_execution-package-prompt.ts)
- **Tool forcing:** `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` at [lib/ai/tool-schemas.ts:1287](lib/ai/tool-schemas.ts#L1287)
- **Streaming:** YES via `callLLMStreaming` at [lib/actions/execution-package.ts:300](lib/actions/execution-package.ts#L300); 32k token budget

### A.14 `outputs_mapping_file` (CSV/JSON export — TEMPLATE-RENDERED, no AI)

- **Entry point:** `generateMappingFileInternal()` at [lib/actions/\_outputs-core.ts:824](lib/actions/_outputs-core.ts#L824)
- Pure deterministic assembly via `buildMappingCsvRows()` / `buildMappingJsonGroups()` in [lib/actions/\_outputs-translators.ts](lib/actions/_outputs-translators.ts)
- Reads `target_field_mappings.ai_reasoning` and emits as `reasoning` column

### A.15 `outputs_transformation_specs` (TEMPLATE-RENDERED, no AI)

- **Entry point:** `generateTransformSpecsInternal()` at [lib/actions/\_outputs-core.ts:908](lib/actions/_outputs-core.ts#L908)
- Pure deterministic assembly via `buildTransformSpecsLines()`

### A.16 `schema_enrichment_from_docs`

- **Entry point:** `enrichSchemaFromDocs()` at [lib/actions/schema-enrichment.ts:85](lib/actions/schema-enrichment.ts#L85)
- **Tool forcing:** `EMIT_SCHEMA_CORRECTIONS_TOOL` at [lib/ai/tool-schemas.ts:551](lib/ai/tool-schemas.ts#L551)
- **Output persistence:** UPDATE `fields` (priority-gated), conflicts → `validation_rules` warnings

### A.17 `ddl_parsing` (AI fallback when deterministic parser fails)

- **Entry point:** `parseDDLWithAI()` at [lib/ai/ddl-conversion.ts](lib/ai/ddl-conversion.ts); caller at [lib/actions/ddl-upload.ts:85](lib/actions/ddl-upload.ts#L85)
- **Tool forcing:** `EMIT_PARSED_DDL_TOOL` at [lib/ai/tool-schemas.ts:417](lib/ai/tool-schemas.ts#L417)
- **No DB read** (input is raw DDL text)

### A.18 `manual_fix` (AI-suggested fix SQL)

- **Entry point:** `generateManualFix()` at [lib/actions/manual-fix.ts:75](lib/actions/manual-fix.ts#L75)
- **Tool forcing:** `EMIT_FIX_SQL_TOOL` at [lib/ai/tool-schemas.ts:1533](lib/ai/tool-schemas.ts#L1533)

### A.19 `nl_to_sql` + `nl_suggest_queries` (Data Exploration)

- **Entries:** `executeNLQuery()` at [lib/actions/query.ts:58](lib/actions/query.ts#L58); `generateSuggestedQueries()` at [lib/actions/query.ts:476](lib/actions/query.ts#L476)
- **Tool forcing:** `EMIT_SQL_QUERY_TOOL` (line 1403) and `EMIT_QUERY_SUGGESTIONS_TOOL` (line 1360) in [lib/ai/tool-schemas.ts](lib/ai/tool-schemas.ts)

### Aggregate observations

| Property                                  | Count                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Total agents                              | 19                                                                                        |
| AI-generated (model output → persistence) | 16                                                                                        |
| Template-rendered (pure assembly)         | 3 (mapping file, transform specs, fix log, data dictionary — non-AI)                      |
| Streaming-enabled                         | 3 (`mapping_generate`, `regenerateFieldMappings`, `outputs_execution_package`)            |
| Prompt-cache-enabled (PR 13.1 cohort)     | 2 confirmed (`quality_detection_ai`, `validation_rule_from_nl`) + BULK `mapping_generate` |
| Tool-forced (most callsites)              | 16 (only `outputs_readiness_report` is intentionally text-mode)                           |
| Post-migration-only                       | 1 (`migration_intelligence`)                                                              |

---

## B. Data Model Audit

### B.1 Tables inventory

45 customer-data-touching tables created across migrations 001–092. Annotated by AI-read status (✅ = consulted by an agent in `lib/ai/` or `lib/actions/ai-*` or `lib/ai/context-builder.ts`).

| Table                                                               | Migration           | Purpose                           | has experiment_run_id           | Read by AI?                |
| ------------------------------------------------------------------- | ------------------- | --------------------------------- | ------------------------------- | -------------------------- |
| profiles                                                            | 001                 | Auth user profile                 | no                              | no                         |
| projects                                                            | 002                 | Tenant container                  | no                              | ✅                         |
| datasets                                                            | 002                 | Source/target role container      | no                              | ✅                         |
| tables                                                              | 002                 | Table metadata                    | no                              | ✅                         |
| fields                                                              | 002                 | Field metadata                    | no                              | ✅                         |
| data_rows                                                           | 002                 | Raw rows (JSONB)                  | no                              | no (profiles used instead) |
| field_profiles                                                      | 002                 | Distribution stats                | no                              | ✅                         |
| schema_documents                                                    | 002                 | Uploaded DDL/ERD/dictionary       | no                              | ✅                         |
| table_mappings                                                      | 002                 | Source→target table mapping       | no                              | ✅                         |
| field_mappings                                                      | 002                 | Legacy (superseded by 074)        | no                              | no                         |
| quality_issues                                                      | 002                 | DQ violations                     | no                              | ✅                         |
| transformations                                                     | 002                 | SQL transform expressions         | no                              | ✅                         |
| outputs                                                             | 002                 | Generated artifacts               | no                              | no                         |
| validation_rules                                                    | 006                 | User + AI rules                   | no                              | ✅                         |
| fix_history                                                         | 006                 | Fix audit                         | no                              | no                         |
| fix_snapshots                                                       | 008                 | Pre-fix row snapshots             | no                              | no                         |
| staged_data_rows                                                    | 013                 | Transformed rows pending approval | no                              | no                         |
| invites                                                             | 015                 | Legacy invite codes               | no                              | no                         |
| access_requests                                                     | 015                 | Legacy access requests            | no                              | no                         |
| activity_log                                                        | 031                 | **Audit trail (decisions log)**   | no                              | no                         |
| migration_intelligence                                              | 033                 | Extracted patterns                | no                              | ✅                         |
| migration_pages                                                     | 0370                | Workbook pages                    | no                              | no                         |
| migration_leads                                                     | 037                 | Plan lead tasks                   | no                              | no                         |
| field_acknowledgments                                               | 039                 | Legacy acknowledgments            | no                              | no                         |
| db_connections                                                      | 045                 | Target DB connection strings      | no                              | no                         |
| organizations                                                       | 050                 | Multi-tenant                      | no                              | ✅                         |
| org_memberships                                                     | 050                 | Org roles                         | no                              | no                         |
| org_invites                                                         | 050                 | Org invites                       | no                              | no                         |
| project_members                                                     | 050                 | Project-level RBAC                | no                              | no                         |
| query_history                                                       | 053                 | SQL audit                         | no                              | no                         |
| user_preferences                                                    | 062                 | UI prefs                          | no                              | no                         |
| platform_admins                                                     | 068                 | Platform staff                    | no                              | no                         |
| sso_providers / sso_domains / sso_identity_links / sso_audit_events | 070                 | SAML 2.0 SSO                      | no                              | no                         |
| **target_field_mappings**                                           | 074                 | **Primary mapping entity**        | **YES (worktree-only via 092)** | ✅                         |
| **mapping_sources**                                                 | 074                 | Child of TFM                      | no                              | ✅                         |
| source_field_acknowledgments                                        | 074                 | User ack of unmapped sources      | no                              | no                         |
| field_mappings_backup_074                                           | 074                 | Read-only archive                 | no                              | no                         |
| field_acknowledgments_backup_074                                    | 074                 | Read-only archive                 | no                              | no                         |
| llm_calls                                                           | 082                 | LLM observability                 | no                              | no (write-only)            |
| ai_edit_history                                                     | 083                 | AI-edit audit                     | no                              | no (write-only)            |
| ingestion_jobs                                                      | 087                 | Async CSV jobs                    | no                              | no                         |
| **mapping_experiments view**                                        | 091 (worktree-only) | Per-experiment LLM-call rollup    | n/a (view)                      | n/a                        |

> **Discrepancy note:** the Section B audit pass scanned only tracked migrations and reported "no experiment*run_id column anywhere." Section E's pass correctly identifies that migration `092_target_field_mappings_experiment_run_id.sql` IS in the worktree (untracked, originating from the Path C experiment branch — `?? supabase/migrations/092*...sql`per session-start git status) and adds`experiment_run_id UUID`to`target_field_mappings`with a partial BTREE index plus an updated`dq_create_target_field_mapping` RPC signature (`p_experiment_run_id` DEFAULT NULL). I treat 092 as authoritative for the post-INF-22 shape.

### B.2 `target_field_mappings` deep dive

**Created:** [supabase/migrations/074_mapping_redesign_data_migration.sql:136](supabase/migrations/074_mapping_redesign_data_migration.sql#L136)
**ALTERed by:** 075 (line 166 — `needs_transformation`), 077 (line 63 — `va_dismissed`, `dismissal_reason`), 083 (line 178 — `original_ai_confidence`, `original_ai_reasoning`), 092 worktree-only (`experiment_run_id`)

| Column                                        | Type          | Purpose                                                                                                            | Written by                                                                                                                                                                                                                                                                        | Read by                                                                                                                                                            |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                                            | UUID          | PK                                                                                                                 | DB default                                                                                                                                                                                                                                                                        | UI, all queries                                                                                                                                                    |
| project_id                                    | UUID          | Tenant FK                                                                                                          | Insert caller                                                                                                                                                                                                                                                                     | mapping engine ([lib/ai/mapping-engine.ts:1246](lib/ai/mapping-engine.ts#L1246)), outputs ([lib/actions/\_outputs-core.ts:364](lib/actions/_outputs-core.ts#L364)) |
| target_field_id                               | UUID          | FK to fields                                                                                                       | Insert caller                                                                                                                                                                                                                                                                     | all consumers                                                                                                                                                      |
| confidence                                    | NUMERIC(5,2)  | 0–100; trigger-derived MIN of source confidences for mapped, stored directly for custom_sql, NULL for acknowledged | Trigger / insert caller                                                                                                                                                                                                                                                           | [lib/quality/readiness-score.ts:78](lib/quality/readiness-score.ts#L78), outputs                                                                                   |
| status                                        | TEXT          | needs_review / approved / rejected                                                                                 | UI handler / approve-all action                                                                                                                                                                                                                                                   | All consumers filter `status='approved'`                                                                                                                           |
| **ai_reasoning**                              | TEXT          | Free-form rationale                                                                                                | mapping engine ([lib/ai/mapping-engine.ts:1426, 1435, 1448](lib/ai/mapping-engine.ts#L1426)); RPC paths in [lib/actions/mappings.ts:1400, 1449, 1480, 1484](lib/actions/mappings.ts#L1400); [lib/actions/mappings-for-redesign.ts:836](lib/actions/mappings-for-redesign.ts#L836) | **see B.3 below**                                                                                                                                                  |
| is_acknowledged                               | BOOLEAN       | Target acknowledged as "won't migrate"                                                                             | [lib/actions/mappings.ts:1563, 2262](lib/actions/mappings.ts#L1563)                                                                                                                                                                                                               | readiness-score.ts, outputs                                                                                                                                        |
| acknowledgment_reason                         | TEXT          | User reason                                                                                                        | mappings.ts                                                                                                                                                                                                                                                                       | outputs                                                                                                                                                            |
| combination_type                              | TEXT          | single / concat_space / concat_comma / custom_sql                                                                  | mapping engine ([lib/ai/mapping-engine.ts:1424–1450](lib/ai/mapping-engine.ts#L1424)); [lib/actions/mappings-for-redesign.ts:1618](lib/actions/mappings-for-redesign.ts#L1618)                                                                                                    | transformations, outputs, execution-package                                                                                                                        |
| combination_sql                               | TEXT          | Custom SQL for combination_type=custom_sql                                                                         | mappings.ts                                                                                                                                                                                                                                                                       | transformations, [lib/actions/execution-package.ts:251](lib/actions/execution-package.ts#L251)                                                                     |
| needs_transformation                          | BOOLEAN (075) | NULL=auto / FALSE=user-dismissed / TRUE=required                                                                   | [lib/actions/mappings-for-redesign.ts:1587, 1618](lib/actions/mappings-for-redesign.ts#L1587)                                                                                                                                                                                     | transformations, execution-package, readiness-score                                                                                                                |
| va_dismissed                                  | BOOLEAN (077) | User dismissed VA alert for value assignment                                                                       | UI dismiss handler                                                                                                                                                                                                                                                                | readiness-score (re-trigger logic)                                                                                                                                 |
| dismissal_reason                              | TEXT (077)    | User reason                                                                                                        | UI                                                                                                                                                                                                                                                                                | outputs                                                                                                                                                            |
| original_ai_confidence                        | NUMERIC (083) | Pre-edit AI confidence                                                                                             | [lib/actions/ai-edit-history.ts](lib/actions/ai-edit-history.ts)                                                                                                                                                                                                                  | audit only                                                                                                                                                         |
| original_ai_reasoning                         | TEXT (083)    | Pre-edit AI reasoning                                                                                              | ai-edit-history                                                                                                                                                                                                                                                                   | audit only                                                                                                                                                         |
| **experiment_run_id** (worktree only via 092) | UUID NULL     | Per-click experiment correlation                                                                                   | mapping engine, mappings.ts (Path C path)                                                                                                                                                                                                                                         | `mapping_experiments` view (worktree only via 091)                                                                                                                 |
| created_at / updated_at                       | TIMESTAMPTZ   | Standard                                                                                                           | DB default + trigger                                                                                                                                                                                                                                                              | All                                                                                                                                                                |

### B.3 `ai_reasoning` consumption (critical for Path D)

**Writes:**

- [lib/ai/mapping-engine.ts:1426, 1435, 1448](lib/ai/mapping-engine.ts#L1426) — directly from Claude tool-output
- [lib/actions/mappings.ts:1400, 1449, 1480, 1484](lib/actions/mappings.ts#L1400) — manual/RPC paths
- [lib/actions/mappings-for-redesign.ts:820, 836](lib/actions/mappings-for-redesign.ts#L820) — suggestion workflow

**Reads (this is the load-bearing surface for Path D):**

- **Transform agent — substring extraction:** [lib/actions/transformations.ts:1244](lib/actions/transformations.ts#L1244) — regex `\[Combination:\s*(.*?)\]` extracts a hint marker that the mapping engine embeds inside `ai_reasoning` for many-to-one combinations
- **Transform agent — prose context:** [lib/actions/transformations.ts:2795](lib/actions/transformations.ts#L2795) — full `ai_reasoning` injected into transform-suggest prompt's `mapping_context` block
- **Outputs (CSV/JSON deliverables):** [lib/actions/\_outputs-translators.ts:308, 414](lib/actions/_outputs-translators.ts#L308) — emitted as `reasoning` column in customer-facing files
- **Outputs (helpers):** [lib/actions/\_outputs-helpers.ts:243](lib/actions/_outputs-helpers.ts#L243)
- **Execution package:** [lib/actions/execution-package.ts:199, 251](lib/actions/execution-package.ts#L199) — full TFM row including ai_reasoning passed to translator
- **Mapping shim (compat):** [lib/compat/mapping-shim.ts:641, 673](lib/compat/mapping-shim.ts#L641)
- **NOT read** by `validation-rules.ts` directly
- **NOT rendered** as a UI section in current MappingDrawer (deferred to Phase 4c per drawer comments)

**Consumption modes:**

- Prose-as-context (transform prompt, runbook prompt) — robust to format changes
- **Brittle structured-substring-search** (`[Combination: ...]` regex) — Path D format change WILL break this consumer
- Audit/customer-facing pass-through (CSV/JSON outputs) — robust to format changes

### B.4 Decisions & Actions Log (the "decisions" widget on Migration Center)

**Backing table:** `activity_log` at [supabase/migrations/031_activity_log.sql:9](supabase/migrations/031_activity_log.sql#L9)

**Schema:**

```
id UUID PK DEFAULT gen_random_uuid()
project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE
user_id UUID NOT NULL
action_type TEXT NOT NULL                 -- enum at lib/actions/activity-log.ts:41-78
description TEXT NOT NULL
category TEXT NOT NULL DEFAULT 'action'   -- 'action'|'fix'|'mapping'|'transform'|'validation'|'data'|'system'
metadata JSONB NOT NULL DEFAULT '{}'      -- feature-specific payload
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Insert sites:**

- `logActivity()` wrapper at [lib/actions/activity-log.ts:99](lib/actions/activity-log.ts#L99) — fire-and-forget, never blocks
- [lib/actions/mappings.ts:1091](lib/actions/mappings.ts#L1091) — `mapping_approved`
- Reject path: [lib/actions/mappings-for-redesign.ts:339-349](lib/actions/mappings-for-redesign.ts#L339) — `mapping_rejected` with `{target_field_mapping_id, target_field, source_field}` payload
- [lib/actions/staging.ts:478](lib/actions/staging.ts#L478) — `stage_all`
- [lib/actions/validation-rules.ts:228, 467, 1018](lib/actions/validation-rules.ts#L228) — rule lifecycle + `risk_accepted`
- [lib/actions/quality-fixes.ts:305, 351](lib/actions/quality-fixes.ts#L305) — fix lifecycle
- [lib/actions/schema-documents.ts:239, 458](lib/actions/schema-documents.ts#L239) — `doc_uploaded`

**What it tracks:** **BOTH business decisions AND approve/reject events**, plus admin/lifecycle:

- Mapping decisions: `mapping_approved`, `mapping_rejected`, `mapping_combination_changed`, `mapping_sources_changed`, `acknowledgment_removed`, `mapping_bulk_approved`, `mapping_bulk_rejected`
- Transform decisions: `transform_generated`, `transform_tested`, `transform_applied`
- QA decisions: `risk_accepted`, `rule_added`, `rule_deleted`, `scan_run`
- Fix decisions: `fix_applied`, `fix_reverted`, `custom_fix_applied`
- RBAC: `project_member_added`, `project_member_removed`, `project_member_role_changed`
- Lifecycle: `stage_all`, `source_uploaded`, `target_uploaded`, `doc_uploaded`, `project_archived`

**Critical gap for Path D:** `activity_log` records _which mapping was approved/rejected_ and _who changed combination_type to what_, but it does **NOT** capture genuine business-decision payloads like "user chose picklist transform 'Active'→'A' because legacy CRM exported as full word, target requires single char." The shape Path D contemplates (decision rationale + structured input/output payload) would either need (a) an extension of `activity_log.metadata` JSONB schema or (b) a new `mapping_decisions` table.

### B.5 Sample rows

Representative rows synthesized from [tests/fixtures/outputs/seed.ts](tests/fixtures/outputs/seed.ts) (deterministic golden-output fixture). For real production data a read-only SELECT against dev is required (TBD — needs follow-up).

`target_field_mappings` examples:
| id | combination_type | confidence | status | ai_reasoning | is_acknowledged |
| --- | --- | --- | --- | --- | --- |
| tfm-…01 | single | 95 | approved | "Direct primary key mapping." | false |
| tfm-…02 | concat_space | 80 | approved | "Concatenate first name and last name with a space." | false |
| tfm-…04 | custom_sql | NULL | approved | "Tenant ID hardcoded per deployment instance." | false |
| tfm-…05 | NULL | NULL | approved | NULL | true |

`activity_log` examples:
| action_type | category | description | metadata |
| --- | --- | --- | --- |
| `mapping_generated` | mapping | "Mapping suggested: s_id → t_customer_id" | `{target_field, confidence: 95}` |
| `mapping_approved` | mapping | "Mapping approved: s_id → t_customer_id (95% confidence)" | `{target_field, confidence: 95}` |
| `transform_generated` | transform | "Transform suggested for t_customer_id" | `{target_field_id, transform_type}` |
| `rule_added` | validation | "Validation rule added: not_null on t_customer_id" | `{rule_name, field}` |
| `fix_applied` | fix | "Fix applied: Remove NULL values from t_customer_id — 12 records" | `{fix_history_id, affected_rows: 12}` |

---

## C. UI Surface Audit

### C.1 Pages under `app/projects/[projectId]/`

| Stage                          | Page                                                                                               | Server actions                                                                                                            | Tables hit                                                                    | Component type |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------- |
| Schema Overview                | [app/projects/[projectId]/data-overview/page.tsx](app/projects/[projectId]/data-overview/page.tsx) | `getProjectSchema()`, `getAllTablesForProject()` ([lib/actions/data-overview.ts](lib/actions/data-overview.ts))           | datasets, tables, fields, schema_documents                                    | Server         |
| Mapping                        | [app/projects/[projectId]/mapping/page.tsx](app/projects/[projectId]/mapping/page.tsx)             | `getMappings()` or `getMappingsForRedesign()` (feature-flag dispatch via `projects.use_mapping_redesign`)                 | TFM, mapping_sources, fields, tables                                          | Server         |
| Transform                      | [app/projects/[projectId]/transform/page.tsx](app/projects/[projectId]/transform/page.tsx)         | `getTransformData()` ([lib/actions/transformations.ts](lib/actions/transformations.ts))                                   | TFM (with nested transforms), transformations, target_fields                  | Server         |
| Validate / Data Quality        | [app/projects/[projectId]/data-quality/page.tsx](app/projects/[projectId]/data-quality/page.tsx)   | `getQualityIssues()`, `getFixHistory()`, `getValidationRules()`, `computeReadinessScore()`, `getResolvedSourceFieldIds()` | quality_issues, fix_history, validation_rules, transformations, TFM           | Server         |
| Project / Schema Ingestion     | [app/projects/[projectId]/project/page.tsx](app/projects/[projectId]/project/page.tsx)             | `getDatasetsWithTables()`, `getSchemaDocuments()`, `getBusinessContextDocs()`                                             | datasets, tables, fields, db_connections, schema_documents                    | Server         |
| **Migration Center / Outputs** | [app/projects/[projectId]/outputs/page.tsx](app/projects/[projectId]/outputs/page.tsx)             | `getOutputsPageData()` ([lib/actions/outputs.ts:85-104](lib/actions/outputs.ts#L85))                                      | TFM, transformations, quality_issues, validation_rules, activity_log, outputs | Server         |
| Schemas (legacy stub)          | app/projects/[projectId]/schemas/page.tsx                                                          | none — mock data per file comments                                                                                        | n/a                                                                           | Client         |

### C.2 Mapping right drawer

**Component:** [app/projects/[projectId]/mapping/redesign/components/MappingDrawer.tsx](app/projects/[projectId]/mapping/redesign/components/MappingDrawer.tsx) (~1120 LOC, Client Component)

**Sections rendered (kind-dispatched at lines 90–111):**

- Target Field Header — name + TableBadge (lines 126–129)
- Subheader — per-row-kind summary (lines 131–161)
- Body:
  - `target_acknowledged` → AcknowledgedBody
  - `unmapped` → UnmappedBody
  - `value_assignment` → ValueAssignmentBody (value expr + AI reasoning + confidence + status)
  - `mapped` → MappedBody (sources + combination + AI reasoning + confidence + status)
- Footer:
  - mapped/value_assignment → ApproveRejectFooter
  - target_acknowledged → AcknowledgedFooter (both buttons disabled with tooltips)
  - unmapped → no footer

**Notable absence:** Sample Values + source profiling NOT rendered in current drawer (deferred to Phase 4c per drawer comment ~line 127). AI Reasoning is shown, but only on `mapped` rows — comes from `row.mapping.ai_reasoning` (server-fetched).

**Approve handler:** `handleApprove()` at lines 748–777

- Calls `approveFieldMapping(rowId)` at [lib/actions/mappings-for-redesign.ts:195-223](lib/actions/mappings-for-redesign.ts#L195)
- Updates `target_field_mappings.status='approved'`
- **Does NOT emit activity_log** (per inline comment ~line 375; legacy parity)
- Optimistic update overlay (lines 742–746)

**Reject handler:** `handleRejectConfirm()` at lines 779–808

- Calls `rejectFieldMapping(rowId)` at [lib/actions/mappings-for-redesign.ts:255-356](lib/actions/mappings-for-redesign.ts#L255)
- Pre-delete TFM lookup (line 277–290) + defensive guard (line 302–308)
- Calls `deleteFieldMapping(rowId)` at line 327 (handles FK-cascade, transform reset, coverage recompute)
- **Emits `mapping_rejected` to activity_log** at lines 339–349 with `{target_field_mapping_id, target_field, source_field}`

**Un-acknowledge:** `handleUnacknowledgeConfirm()` (lines 817–853) → `unacknowledgeField()` → flips `is_acknowledged=false`

### C.3 Migration Center widgets

Location: [app/projects/[projectId]/outputs/OutputsContent.tsx](app/projects/[projectId]/outputs/OutputsContent.tsx) (lines 926–1117)

| Widget                  | Component lines | Data source                                                                                                                | Computation                                                                                                                                                                                                                                                        |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mapping Coverage        | 926–949         | `metrics.approvedFieldMappings`, `metrics.totalFieldMappings` from `getOutputsPageData()`                                  | `approvedFieldMappings / totalFieldMappings * 100%` (line 940). Numerator = `COUNT(target_field_mappings WHERE status='approved')`, denominator = `COUNT(target_fields)` per [lib/actions/\_outputs-core.ts:1243-1244](lib/actions/_outputs-core.ts#L1243)         |
| Transforms              | 951–982         | `metrics.completedTransforms`, `metrics.totalTransforms`                                                                   | completed = transformations with status/stage = applied; total = mapped fields' transform scope ([\_outputs-core.ts:1114-1115, 1247-1248](lib/actions/_outputs-core.ts#L1114))                                                                                     |
| Quality Issues          | 984–1013        | `metrics.openBlocking`, `metrics.openWarnings`                                                                             | `COUNT(quality_issues WHERE severity='blocking' AND status='open')` (resolution-suppressed per line 1119 comment)                                                                                                                                                  |
| Migration Readiness     | 1015–1038       | `metrics.readinessScore`, `metrics.readinessStatus`                                                                        | `calculateReadinessScore()` at [lib/quality/readiness-score.ts](lib/quality/readiness-score.ts) — weighted blend of mapping%, transforms%, quality_issues, staged_tables, total_tables. Status: `ready` (≥80%), `at_risk` (50–79%), `not_ready` (<50%) (line 1148) |
| Decisions & Actions Log | 1041–1117       | `decisions` array from `getOutputsPageData()`, enriched with user identity ([outputs.ts:100](lib/actions/outputs.ts#L100)) | Reads `activity_log`, filtered by category (mapping/transform/fix/validation/data/system); grouped client-side at lines 1072–1099                                                                                                                                  |

> **What "0/190" or "45% Not Ready" actually means:** purely deterministic SQL aggregations over current DB state. No AI involved in computation. Path D's promise of "coverage analysis as part of monolithic output" would _compete_ with these deterministic computations rather than replace them — see RISK 5.

### C.4 Migration Center deliverables

| Deliverable                       | Generator                                                                                                                                                 | Inputs                                                                                  | Output                                  | AI?                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Runbook                           | `generateMigrationRunbook()` at [lib/actions/migration-runbook.ts:109](lib/actions/migration-runbook.ts#L109)                                             | datasets, table_mappings (approved), quality_issues, schema_documents, TFMs (flattened) | DOCX → storage + outputs row            | **YES** (`EMIT_MIGRATION_RUNBOOK_TOOL`)                    |
| Readiness Report                  | `generateReadinessReport()` at [lib/actions/outputs.ts:150-185](lib/actions/outputs.ts#L150) → [\_outputs-core.ts:674](lib/actions/_outputs-core.ts#L674) | readiness components, mapping%, transform%, quality issues, staged tables               | DOCX                                    | **YES** (text-mode callsite)                               |
| Mapping File (CSV/JSON)           | `generateMappingFile()` at [lib/actions/outputs.ts:205-240](lib/actions/outputs.ts#L205)                                                                  | TFM + mapping_sources flattened, source/target fields                                   | CSV or JSON                             | **NO** (template-rendered)                                 |
| Transformation Specs              | `generateTransformSpecs()` at [lib/actions/outputs.ts:255-290](lib/actions/outputs.ts#L255)                                                               | transformations (approved), TFMs, source profiling                                      | SQL                                     | **YES** (synthesized)                                      |
| Data Dictionary                   | `generateDataDictionary()` at [lib/actions/outputs.ts:305-340](lib/actions/outputs.ts#L305)                                                               | TFMs, target_fields, transformations                                                    | CSV                                     | **NO** (template)                                          |
| Fix Log                           | `generateFixLog()` at [lib/actions/outputs.ts:355-390](lib/actions/outputs.ts#L355)                                                                       | quality_issue_fixes (approved), quality_issues, user_id, timestamps                     | CSV                                     | **NO** (template)                                          |
| Execution Package (monolithic)    | `generateExecutionPackage()` at [lib/actions/execution-package.ts:50-120](lib/actions/execution-package.ts#L50)                                           | TFMs, transformations (approved), source row counts, target schema                      | single .sql file                        | **YES** (Claude synthesis)                                 |
| Execution Package (per-table ZIP) | `generateExecutionPackageWithFormat()` at [lib/actions/execution-package.ts:130-200](lib/actions/execution-package.ts#L130)                               | same, compartmentalized                                                                 | ZIP `<table>_v<n>.sql` + load_order.txt | **YES** (`EMIT_COMPARTMENTALIZED_PACKAGE_TOOL`, streaming) |

All deliverables persist via `outputs` table (id, project_id, type, format, version, generated_at, file_storage_path, metadata) + `project-files/<projectId>/...` storage bucket. Signed URLs minted on-demand by `getDeliverableUrl()` at [lib/actions/deliverables.ts:77-130](lib/actions/deliverables.ts#L77) (3600s TTL).

---

## D. Streaming + UX

### D.1 + D.2 Streaming usage

**Backend streaming (server-internal):**

- [lib/ai/llm-client.ts:757-943](lib/ai/llm-client.ts#L757) — `callLLMStreaming()` calls `anthropic.messages.stream(request)` at line 805, awaits `stream.finalMessage()` at line 806. Returns aggregated `CallLLMResult`. **The stream is consumed server-side and not forwarded to clients.**
- Recent commit b3417b2 ("feat(ai): switch mapping_generate to streaming + raise PER_BATCH_MAX_TOKENS to 32k") wired this into the mapping path.
- Used by: `mapping_generate` ([lib/ai/single-agent-mapping.ts:144](lib/ai/single-agent-mapping.ts#L144)), `regenerateFieldMappings` (delegates to same), `outputs_execution_package` ([lib/actions/execution-package.ts:300](lib/actions/execution-package.ts#L300)).

**Client SSE / EventSource:** **NONE FOUND.** No `EventSource` consumers, no `text/event-stream` route handlers in `app/api/`. The streaming optimization is entirely a server-side trick to unlock the 32k token budget and reduce latency-to-finalMessage.

### D.3 Long-running AI operation UX

Long-running ops: `mapping_generate` (30s–3min per scaling comments), `outputs_execution_package` (similar), `outputs_migration_runbook`.

**Loading UX for `mapping_generate`** at [app/projects/[projectId]/mapping/redesign/components/GenerateMappingsPanel.tsx:338-437](app/projects/[projectId]/mapping/redesign/components/GenerateMappingsPanel.tsx#L338):

- Animated `Loader2` spinner (Lucide), color blue-600 (lines 349–352)
- Two-phase status text:
  - Phase 1 "generating": _"Generating AI-powered mappings… Analyzing N source / M target tables. This typically takes 1-3 minutes."_ + elapsed counter `M:SS` (lines 360–376)
  - Phase 2 "refreshing": _"Loading mappings…"_ (line 383) — brief while `router.refresh()` rehydrates server data
- Semi-transparent backdrop `bg-white/95` (lines 343–347)
- Elapsed counter via `setInterval(+1, 1000ms)` while phase==='generating' (lines 215–236)
- Toast on success: _"Generated X mappings"_ / _"Generated X mappings (Y existing pairs skipped)"_ (lines 310–317)

**No real-time progress to user.** The user sees a spinner and elapsed time, never granular _"5/190 mappings generated"_ updates.

---

## E. Path C Apparatus Disposition

### E.1 Experiment branch contents (read via `git show experiment/mapping-two-pass-path-c:<file>`, never checked out)

Top commit: `d33a892` — "feat(ai): INF-22 Phase B — wire experiment_run_id to TFM persistence"
Parent: `5040a6c` — "feat(ai): INF-22 — Path C two-pass mapping experiment (flag-gated, dev-only)"
**Neither merged to main.**

| File                                                                | Status   | LOC  | Purpose                                                                                                                                                                |
| ------------------------------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lib/ai/two-pass-experiment.ts                                       | new      | 127  | Env-flag helpers, `mintExperimentRunId()`, metadata builders for Path B vs Path C                                                                                      |
| lib/ai/two-pass-prompts.ts                                          | new      | 158  | Pass 1 (reasoning-only) + Pass 2 (extraction) prompt templates                                                                                                         |
| lib/ai/single-agent-mapping.ts                                      | modified | +200 | Branching: heritage Path B vs Path C two-pass dispatch                                                                                                                 |
| lib/ai/mapping-engine.ts                                            | modified | +34  | `experiment_run_id` minted at BULK entry; propagated to TFM persistence                                                                                                |
| lib/actions/mappings.ts                                             | modified | +17  | `experiment_run_id` minted at single-pair entry; propagated through agent helper + legacy fallback                                                                     |
| supabase/migrations/091_mapping_experiments_view.sql                | new      | 108  | View over `llm_calls` grouped by `experiment_run_id`+`experiment_label` for cross-experiment cost/latency/token rollups                                                |
| supabase/migrations/092_target_field_mappings_experiment_run_id.sql | new      | 190  | ALTER TABLE add `experiment_run_id UUID` to TFM + partial BTREE index + updated `dq_create_target_field_mapping` RPC signature with `p_experiment_run_id` DEFAULT NULL |
| tests/integration/mapping-two-pass-experiment.test.ts               | new      | 527  | Env-gated (`RUN_TWO_PASS_INTEGRATION=1`); verifies pass propagation, `experiment_label` discrimination, shared `experiment_run_id`, byte-identical when flag OFF       |

### E.2 Reusability for Path D

**REUSE (lift to Path D feature branch unchanged):**

- Migration 092 — Path D needs experiment correlation across runs. The TFM column + partial index + RPC signature change are foundational.
- Migration 091 — view structure is reusable; only the `experiment_label` literal will change (e.g., `'path_d_v1'`).
- `mintExperimentRunId()` + metadata patterns at [lib/ai/two-pass-experiment.ts:40-65, 68-106](lib/ai/two-pass-experiment.ts#L40) — UUID-per-click + metadata-tagging is orthogonal to pass count.

**REWRITE (Path D is single-pass, structured monolithic output):**

- `lib/ai/two-pass-experiment.ts` two-pass-specific control logic (`twoPassEnabled()`, `pathCPass1Metadata()`, `pathCPass2Metadata()`)
- `lib/ai/two-pass-prompts.ts` (Path C-specific prompts; Path D has unified prompt)
- `runSingleAgentMappingLoopTwoPass()` dispatcher in single-agent-mapping.ts

### E.3 Recommended disposition

**ARCHIVE the branch; do NOT delete.**

1. Tag `inf-22-phase-c-archive` at `d33a892` for institutional memory
2. Cherry-pick migrations 091 + 092 to a new Path D feature branch (no code modification needed)
3. Document in INF tracker: "Phase C complete; branch archived; 091+092 cherry-picked to Path D"
4. Keep `experiment_run_id` wiring on TFMs permanently — costs nothing in production (NULL for non-experiment rows)

---

## F. Phase 3 Work-in-Flight Status

### F.1 Branch inventory (non-main, with status)

**In-flight (not merged):**
| Branch | Ahead | Last date | Subject |
| --- | --- | --- | --- |
| `experiment/mapping-two-pass-path-c` | 2 | 2026-05-06 | Path C two-pass — see Section E |
| `feat/pr3.4e-voting-variance-fix` | 4, behind 18 | 2026-05-05 | Multi-agent variance fix; blocks 3.4 rollout |
| `fix/remove-unregistered-datascanning-tools` | 1, behind 5 | 2026-05-05 | Unblocks Phase 3.3 tool exposure |
| `feat/salesforce-connector` | 8 | 2026-04-25 | Stale; merge or archive |
| `docs/add-inf-ticket-tracker` | 1 | 2026-05-06 | Awaiting review |
| `dev` | 7 | 2026-05-06 | Synced to main; keep |
| `backup/dev-pre-recovery-2026-05-03` | 36 | 2026-05-03 | Recovery backup; keep until ~2026-05-10 |

**Merged-but-not-deleted (cleanup candidates):** `feat/pr3.4b-mapping-agent-callsites`, `feat/pr13.1-prompt-caching-cohort`, `feat/pr12-sub-commit-12.3`, `feat/pr13-prompt-caching`, `feat/mapping-streaming-32k`, `feat/drawer-redesign`, `feat/inline-row-actions`, `feat/drawer-target-header`, `feat/inline-picker-save-cancel`, `feat/transform-target-led-sidebar`, `feat/counter-semantic-redesign`, `feat/transform-counter-unification` (reverted), `feat/cloudflare-turnstile`, `feat/multi-table-mapping`, `feat/source-cell-unification`, `feat/enable-redesign-default`, `feat/mapping-empty-state`, `feat/collapsed-groups`, `feature/careers-page`, `fix/buildaicontext-field-load-rls`, `fix/mapping-reject-no-flash`, `fix/migration-pages-history`, `fix/schema-documents-dataset-id-persistence`, `investigate/csv-scaling`, `chore/ci-test-secrets`, several `feat/sso-*`.

### F.2 Phase 3 status

| Phase                       | Status                               | Evidence                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 Design                  | ✅ Shipped                           | [docs/investigations/pr-phase3.1-agent-design.md](docs/investigations/pr-phase3.1-agent-design.md) (~41.5 KB)                                                                                                                                                    |
| 3.2 Agent loop              | ✅ Shipped to main                   | Commit `e5450db`; [lib/ai/agent-loop.ts](lib/ai/agent-loop.ts); migration 084                                                                                                                                                                                    |
| 3.3 Data-scanning tools     | ✅ Shipped, **incident pending fix** | Commit `0b93e12`; [lib/ai/agent-tools.ts](lib/ai/agent-tools.ts); [supabase/migrations/085_agent_data_scanning_rpcs.sql](supabase/migrations/085_agent_data_scanning_rpcs.sql); fix on `fix/remove-unregistered-datascanning-tools` (1 commit ahead, not merged) |
| 3.4a Plumbing               | ✅ Shipped                           | Commit `96e68d4`; mapping-engine + ContextScope + CallLLMOptions on main                                                                                                                                                                                         |
| 3.4b Single-agent adoption  | ✅ Shipped                           | Commit `796ee94`; BULK + single-pair dispatch to `runAgentLoop` when `AI_PHASE_3_ENABLED=1`; heritage byte-identical when OFF                                                                                                                                    |
| 3.4cd Multi-agent voting    | ✅ Shipped, **default-OFF**          | Commits `62ff144`–`fd0710f`; [lib/ai/multi-agent-orchestrator.ts](lib/ai/multi-agent-orchestrator.ts), [multi-agent-prompts.ts](lib/ai/multi-agent-prompts.ts), [multi-agent-types.ts](lib/ai/multi-agent-types.ts); flag `AI_PHASE_3_MULTI_AGENT_ENABLED=0`     |
| 3.4e Variance validation    | 🔬 In-flight                         | `feat/pr3.4e-voting-variance-fix` — Sonnet 4.6 swap (Opus 4.7 rejects temperature with tools), telemetry, RLS bypass; not merged                                                                                                                                 |
| 3.5 Transform pipeline      | 📝 Designed only                     | [docs/investigations/pr3.5-transform-pipeline.md](docs/investigations/pr3.5-transform-pipeline.md) (~54 KB); no branch                                                                                                                                           |
| 3.6 Validation row sampling | ❌ Not started                       | No doc, no branch                                                                                                                                                                                                                                                |
| 3.7 SSE UX                  | 🟡 Partial                           | Backend streaming via `b3417b2` ✅; client EventSource/SSE ❌ not started                                                                                                                                                                                        |
| 3.8 Eval                    | 🟡 Partial                           | [lib/eval/runner.ts](lib/eval/runner.ts), [lib/eval/scorers/](lib/eval/scorers/), [tests/eval/](tests/eval/) exist; mapping + multi-agent voting fixtures present; no 3.6/3.7 coverage                                                                           |

---

## G. Test Coverage Inventory

### G.1 Heritage tests (regression pin baseline)

11 dedicated heritage files under `tests/integration/`, totaling **47 test blocks** that pin existing read- and write-path behavior against the "Heritage Core" canary project:

- [projects-heritage.test.ts](tests/integration/projects-heritage.test.ts) — `getProjectsWithStats` rollup (2)
- [mappings-for-redesign-heritage.test.ts](tests/integration/mappings-for-redesign-heritage.test.ts) — read-path + `createFieldMapping`/`suggestMappingForTarget` (13)
- [transforms-heritage.test.ts](tests/integration/transforms-heritage.test.ts) — `getTransformData` shape (4)
- [detection-engine-heritage.test.ts](tests/integration/detection-engine-heritage.test.ts) — in-flight quality-detection results (2)
- [outputs-heritage.test.ts](tests/integration/outputs-heritage.test.ts) — outputs file generators + `getOutputsPageData` (10)
- [edit-mapping-heritage.test.ts](tests/integration/edit-mapping-heritage.test.ts) — `editMappingSources`, `updateMappingCombination`, `unacknowledgeField` (4)
- [readiness-score-heritage.test.ts](tests/integration/readiness-score-heritage.test.ts) — readiness calc (4)
- [bulk-approve-heritage.test.ts](tests/integration/bulk-approve-heritage.test.ts) (2), [bulk-reject-heritage.test.ts](tests/integration/bulk-reject-heritage.test.ts) (1), [transform-apply-cross-table-heritage.test.ts](tests/integration/transform-apply-cross-table-heritage.test.ts) (1), [mappings-shim-heritage.test.ts](tests/integration/mappings-shim-heritage.test.ts) (4)

### G.2 Integration tests for AI flows

| Agent / Component         | Test file                                | Env-gated                                       | Scenarios                                        |
| ------------------------- | ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Agent loop                | agent-loop-end-to-end.test.ts            | `RUN_LLM_CALLS_INTEGRATION=1`                   | 2-tool loop, parent_call_id chain, iteration cap |
| LLM prompt caching        | llm-calls-prompt-caching.test.ts         | same                                            | cache write+read, token tracking                 |
| LLM logging               | llm-calls-logging.test.ts                | same                                            | llm_calls observability                          |
| LLM streaming             | llm-calls-streaming-logging.test.ts      | same                                            | stream events + token counts                     |
| Mapping persistence       | mapping-persistence-write-path.test.ts   | `RUN_MAPPING_PERSISTENCE_INTEGRATION=1`         | runMappingGenerationForPair → TFM/MS persistence |
| Mapping redesign          | mappings-for-redesign-heritage.test.ts   | `RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1`  | new model shape, create/suggest                  |
| Build AI context          | build-ai-context-field-load.test.ts      | `RUN_BUILD_AI_CONTEXT_FIELD_LOAD_INTEGRATION=1` | RLS, column drift                                |
| Quality detection         | detection-engine-heritage.test.ts        | `RUN_DETECTION_HERITAGE_INTEGRATION=1`          | runInFlightChecksInternal                        |
| Outputs generation        | outputs-heritage.test.ts                 | HERITAGE_PROJECT_ID                             | file generators snapshot                         |
| Transformations invariant | transformations-unique-invariant.test.ts | (none)                                          | global uniqueness                                |
| Agent RPCs                | agent-rpcs.test.ts                       | `RUN_LLM_CALLS_INTEGRATION=1`                   | tool_handler dispatch                            |
| Path C two-pass           | mapping-two-pass-experiment.test.ts      | `RUN_TWO_PASS_INTEGRATION=1` (worktree only)    | Pass propagation, label discrimination           |

**Gaps (no integration test):** `ddl_parsing`, `manual_fix` / quality fix engine, `migration_runbook`, compartmentalized deliverables, `nl_to_sql` + `nl_suggest_queries`, `schema_enrichment_from_docs`.

### G.3 Test count breakdown

| Category           | Files   | it()/test() blocks |
| ------------------ | ------- | ------------------ |
| tests/actions/     | 40      | 885                |
| tests/components/  | 39      | 1,172              |
| tests/lib/         | 34      | 597                |
| tests/utils/       | 5       | 140                |
| tests/eval/        | 5       | 85                 |
| tests/quality/     | 6       | 67                 |
| tests/migrations/  | 2       | 46                 |
| tests/outputs/     | 12      | 48                 |
| tests/hooks/       | 3       | 40                 |
| tests/compat/      | 1       | 25                 |
| tests/sso/         | 1       | 17                 |
| tests/api/         | 2       | 8                  |
| tests/integration/ | 22      | 94                 |
| tests/ (root)      | 1       | 3                  |
| **Total**          | **203** | **3,241**          |

---

## Specific Questions — Direct Answers

### Q1. Does the current transform agent consume `ai_reasoning` from TFMs? If yes, how?

**YES, in two distinct modes:**

- **Brittle structured-substring search:** [lib/actions/transformations.ts:1244](lib/actions/transformations.ts#L1244) extracts a `[Combination: ...]` marker via regex `\[Combination:\s*(.*?)\]`. The mapping engine _embeds_ this marker inside `ai_reasoning` for many-to-one combinations; the transform agent fishes it back out to drive multi-source SQL synthesis.
- **Prose-as-context:** [lib/actions/transformations.ts:2795](lib/actions/transformations.ts#L2795) injects the full `ai_reasoning` string into the transform-suggest prompt's `mapping_context` block.

Plus consumers outside the transform agent: [lib/actions/\_outputs-translators.ts:308, 414](lib/actions/_outputs-translators.ts#L308) (CSV/JSON deliverables, customer-facing), [lib/actions/\_outputs-helpers.ts:243](lib/actions/_outputs-helpers.ts#L243), [lib/actions/execution-package.ts:199, 251](lib/actions/execution-package.ts#L199), [lib/compat/mapping-shim.ts:641, 673](lib/compat/mapping-shim.ts#L641).

`validation-rules.ts` does **NOT** read it. The MappingDrawer UI does **NOT** render it as a separate section (deferred to Phase 4c).

### Q2. What does the Decisions & Actions Log currently track?

**Both business decisions AND approve/reject lifecycle events**, backed by `activity_log` (migration 031). Action types include `mapping_approved`, `mapping_rejected`, `mapping_combination_changed`, `mapping_sources_changed`, `acknowledgment_removed`, `transform_generated`/`tested`/`applied`, `risk_accepted`, `rule_added`/`deleted`, `fix_applied`/`reverted`/`custom_fix_applied`, `stage_all`, `doc_uploaded`, plus RBAC and lifecycle events. Full enum at [lib/actions/activity-log.ts:41-78](lib/actions/activity-log.ts#L41).

**However**, what the current schema does NOT capture is the _content_ of business decisions in structured form — e.g., "user chose picklist transform `Active`→`A` because legacy CRM exported full word, target requires single char." The `metadata JSONB` column stores per-event payload (e.g., `{target_field, confidence}`), but there is no first-class table with structured columns for decision input/output/rationale. Path D's "business decisions" output would require either an extension of `activity_log.metadata` schema or a new `mapping_decisions` table.

### Q3. Are migration deliverables AI-generated?

**Mixed:**

- **AI-generated:** Runbook (tool-forced), Readiness Report (text-mode), Transformation Specs (synthesized), Execution Package (monolithic + compartmentalized, both tool-forced; compartmentalized streams)
- **Template-rendered:** Mapping File (CSV/JSON), Data Dictionary (CSV), Fix Log (CSV) — pure deterministic assembly by `_outputs-translators.ts`

Input data sources and prompt construction are detailed in §C.4 above.

### Q4. Is anything streaming today?

**Backend yes, client no.**

- `callLLMStreaming()` at [lib/ai/llm-client.ts:757-943](lib/ai/llm-client.ts#L757) wraps `anthropic.messages.stream()` (line 805) and awaits `stream.finalMessage()` server-side. Used by `mapping_generate`, `regenerateFieldMappings`, `outputs_execution_package`. Purpose: unlock 32k token budget without latency tax.
- **No client-side EventSource consumers exist anywhere in the codebase. No `text/event-stream` route handlers in `app/api/`.**
- Longest-running visible AI op is `mapping_generate` (30s–3min). UX: animated `Loader2` spinner + "Generating AI-powered mappings… typically 1-3 minutes." + elapsed counter (`M:SS`) at [GenerateMappingsPanel.tsx:338-437](app/projects/[projectId]/mapping/redesign/components/GenerateMappingsPanel.tsx#L338). No granular per-mapping progress shown to user.

### Q5. Path C apparatus disposition — what's reusable, what to archive?

**Reusable for Path D (lift unchanged):**

- `supabase/migrations/092_target_field_mappings_experiment_run_id.sql` (TFM column + index + RPC signature)
- `supabase/migrations/091_mapping_experiments_view.sql` (LLM-call rollup view; only the `experiment_label` literal changes)
- `mintExperimentRunId()` + ExperimentLabel/metadata patterns at [lib/ai/two-pass-experiment.ts:40-65, 68-106](lib/ai/two-pass-experiment.ts#L40)

**NOT reusable (Path D is single-pass):**

- Two-pass orchestrator + prompts (`lib/ai/two-pass-experiment.ts` two-pass control flow, `lib/ai/two-pass-prompts.ts`, `runSingleAgentMappingLoopTwoPass`)

**Recommended action:** archive branch under tag `inf-22-phase-c-archive`; cherry-pick 091+092 to Path D feature branch; document in INF tracker.

---

## RISKS

1. **`target_field_mappings.ai_reasoning` is read by 6 distinct downstream consumers in production (transform agent + outputs translators + execution-package + compat shim).** Any change to its shape or content semantics from Path D will require coordinated updates across [lib/actions/transformations.ts:1244](lib/actions/transformations.ts#L1244), [lib/actions/transformations.ts:2795](lib/actions/transformations.ts#L2795), [lib/actions/\_outputs-translators.ts:308, 414](lib/actions/_outputs-translators.ts#L308), [lib/actions/\_outputs-helpers.ts:243](lib/actions/_outputs-helpers.ts#L243), [lib/actions/execution-package.ts:199, 251](lib/actions/execution-package.ts#L199), [lib/compat/mapping-shim.ts:641, 673](lib/compat/mapping-shim.ts#L641). The substring-search consumer is especially brittle.

2. **No client-facing SSE/streaming exists.** Path D's expected 90–180s latency for the monolithic Opus 4.7 call would be a UX regression from today's already-30s–3min experience without progress signals. Current UX is just `Loader2` + elapsed counter ([GenerateMappingsPanel.tsx:354-387](app/projects/[projectId]/mapping/redesign/components/GenerateMappingsPanel.tsx#L354)). Phase 3.7 ships only the _backend_ side of streaming (commit `b3417b2`).

3. **Multi-agent voting (Phase 3.4cd) is shipped but default-OFF**, blocked by [feat/pr3.4e-voting-variance-fix](https://) (4 commits ahead, behind 18, no merge plan). Path D either competes with this path or supersedes it. Continuing to maintain three competing mapping pipelines (Path B single-agent, Path C two-pass on experiment branch, Phase 3.4 multi-agent flag-OFF, Path D upcoming) compounds maintenance burden in [lib/ai/multi-agent-orchestrator.ts:133](lib/ai/multi-agent-orchestrator.ts#L133), [lib/actions/mappings.ts:257](lib/actions/mappings.ts#L257).

4. **The "Decisions & Actions Log" has no structured business-decision schema today.** It is `activity_log` ([supabase/migrations/031_activity_log.sql:9](supabase/migrations/031_activity_log.sql#L9)) — a workflow audit trail keyed by `action_type` + free-form `metadata JSONB`. Path D's promise of "business decisions in structured form" requires new schema (extension of `activity_log.metadata` schema with payload validation OR a new `mapping_decisions` table with FK to TFM and structured columns).

5. **Coverage and readiness are deterministic computations today.** Mapping coverage % at [OutputsContent.tsx:940](app/projects/[projectId]/outputs/OutputsContent.tsx#L940) and readiness score at [lib/quality/readiness-score.ts](lib/quality/readiness-score.ts) are pure aggregations over DB state. If Path D produces "coverage analysis" as part of its monolithic output, two sources of truth emerge — divergence is a high-value bug class for an enterprise sales tool ("the sidebar says 95% mapped but the report says 87%").

6. **Migration 092 is uncommitted on the `experiment/mapping-two-pass-path-c` branch.** If Path D ships from a fresh feature branch and also wants `experiment_run_id`, two parallel attempts to add the same column will conflict. Single canonical migration must own the column.

7. **`PER_BATCH_MAX_TOKENS=32000` cap at [lib/actions/mappings.ts:241](lib/actions/mappings.ts#L241) may be insufficient for Path D's monolithic output.** Mappings + coverage analysis + business decisions + lookup tables + DQ findings, even compressed, will likely exceed 32k for any non-trivial enterprise schema (10k+ tables target per CLAUDE.md §1). Need to audit Opus 4.7 max_output limits and validate prompt+output budget.

8. **The transform agent reads `ai_reasoning` via brittle substring regex** at [lib/actions/transformations.ts:1244](lib/actions/transformations.ts#L1244). Path D output format change will break this consumer silently (no test pins this contract). Most likely failure mode: many-to-one combinations regress to single-source on Path D rollout.

9. **19 distinct AI agents exist in the codebase.** Path D consolidates only `mapping_generate`. The 18 others (transform_generate, validation_rule_from_nl, runbook, deliverables, manual_fix, schema_enrichment, ddl_parsing, quality_detection, etc.) keep existing patterns. Consistency across the pipeline requires either (a) Path D output that downstream agents can consume unchanged, or (b) prompt updates to each downstream agent — multi-PR effort.

10. **11 heritage tests pin existing prompt + persistence shape byte-for-byte** (47 test blocks in `tests/integration/*-heritage.test.ts`). Path D will require updating these baselines. Without `AI_PHASE_4_PATH_D_ENABLED=0` byte-identical guarantee, heritage tests cannot serve as regression gates during rollout.

11. **`fix/remove-unregistered-datascanning-tools` (Phase 3.3 incident fix) is 1 commit ahead and not merged.** Path D may want to use the data-scanning RPCs at [supabase/migrations/085_agent_data_scanning_rpcs.sql](supabase/migrations/085_agent_data_scanning_rpcs.sql); shipping Path D before this fix lands risks repeating the May 2026 "registered-but-unexposed" incident.

12. **No integration tests cover `migration_runbook`, `manual_fix`, `ddl_parsing`, or compartmentalized deliverables generation.** Path D will inevitably reshape the data flowing into these agents (TFMs + new tables); shipping Path D without smoke coverage on downstream consumers risks silent breakage in customer-facing artifacts.

---

## RECOMMENDATIONS

1. **Land schema migration 093 with the structural Path D additions.** Specifically: (a) cherry-pick `092_target_field_mappings_experiment_run_id.sql` from the Path C branch unchanged; (b) cherry-pick `091_mapping_experiments_view.sql` unchanged; (c) add a new `mapping_decisions` table (FK to TFM, columns: `decision_type`, `input_payload JSONB`, `output_payload JSONB`, `rationale TEXT`, `model_version`, `experiment_run_id`); (d) add a new `mapping_lookup_tables` table for first-class enum/code mappings; (e) add `mapping_dq_findings` for AI-detected quality issues attached to TFMs. Keep migration small; resist scope creep.

2. **Phase 3.7 client SSE must precede Path D rollout.** Build (a) an SSE route handler in `app/api/projects/[projectId]/mapping/generate/stream/route.ts` that proxies Anthropic streaming and emits structured events (mapping-emitted, decision-emitted, dq-finding-emitted, coverage-update); (b) an `EventSource` consumer in `GenerateMappingsPanel.tsx` that progressively renders cards as events arrive. Without this, 90–180s latency on Opus 4.7 single-call is a UX regression.

3. **Deprecate the `ai_reasoning` substring-search consumer at [lib/actions/transformations.ts:1244](lib/actions/transformations.ts#L1244).** Replace the regex `\[Combination:\s*(.*?)\]` with reads against new structured columns (e.g., `target_field_mappings.transformation_intent`, or the new `mapping_decisions` table). Add a heritage test that pins multi-source-combination transform behavior before the change.

4. **Archive `experiment/mapping-two-pass-path-c` under tag `inf-22-phase-c-archive`.** Do not delete. Cherry-pick 091+092 into the Path D branch. Update the INF tracker entry: "INF-22 closed; superseded by INF-23 Path D; experiment apparatus reused."

5. **Default-disable Path D.** Add `AI_PHASE_4_PATH_D_ENABLED` env flag with the existing exact-`'1'` semantics (mirror `AI_PHASE_2_ENABLED` / `AI_PHASE_3_ENABLED` patterns documented in CLAUDE.md §4.5.1). Heritage tests must continue passing under flag-OFF byte-identical.

6. **Establish Path D eval baseline before any callsite cutover.** Use the existing [lib/eval/runner.ts](lib/eval/runner.ts) infrastructure with a new fixture set keyed to the Standalone-Claude-Chat-21-mapping benchmark. Compare on the same canary corpus: Path B (production single-shot), Path C (two-pass), Path D (monolithic Opus 4.7), Phase 3.4 multi-agent. Decision criteria: ≥21 mappings on benchmark dataset, ≥coverage parity, no regression on existing heritage corpus.

7. **Add `path-d-byte-identical.test.ts` heritage test before merging Path D.** Mirror the Phase 2/3 heritage pattern — pin `mapping_generate` system prompt construction + persistence shape under `AI_PHASE_4_PATH_D_ENABLED=0`. Prevents the "flag flip changes flag-OFF behavior" regression that Phase 3 hot-fixed twice (commits 5040a6c, 2ee0eff in recent history).

8. **Decide Phase 3.4cd multi-agent disposition before Path D ships.** Three options: (a) ship via 3.4e variance fix and keep both as competing default-OFF flag-paths; (b) deprecate multi-agent in favor of Path D and revert/archive [lib/ai/multi-agent-orchestrator.ts:133](lib/ai/multi-agent-orchestrator.ts#L133), [multi-agent-prompts.ts](lib/ai/multi-agent-prompts.ts), [multi-agent-types.ts](lib/ai/multi-agent-types.ts); (c) explicitly document indefinite parallel maintenance. Don't leave 3.4e in-flight indefinitely; it carries variance-correctness risk if accidentally enabled.

9. **Land `fix/remove-unregistered-datascanning-tools` to main before Path D starts coding.** Phase 3.3 data-scanning RPCs at [supabase/migrations/085_agent_data_scanning_rpcs.sql](supabase/migrations/085_agent_data_scanning_rpcs.sql) are foundational for Path D's expected "let the model investigate" pattern. Don't repeat the registered-but-unexposed incident.

10. **Add minimum smoke-tests for the 6 untested AI flows before changing any prompts:** `migration_runbook`, `manual_fix`, `ddl_parsing`, compartmentalized deliverables, `nl_to_sql` + `nl_suggest_queries`, `schema_enrichment_from_docs`. Target tests/integration/, env-gated. Each just exercises the happy path with a fixed fixture and asserts the tool-output schema validates.

11. **Pin Path D cost ceiling.** Add `PER_PROJECT_MAX_COST_USD` constant analogous to `PER_PAIR_MAX_COST_USD=15.0` at [lib/ai/multi-agent-orchestrator.ts:80-83](lib/ai/multi-agent-orchestrator.ts#L80). Opus 4.7 monolithic call could blow budget on a 10k-table schema. Default to a conservative limit (e.g., $50/project) with explicit override env var.

12. **Cleanup branch hygiene before Path D feature branch creates more clutter.** ~24 merged-but-not-deleted branches (listed in F.1) — most >7 days old. Run a single sweep: `git push origin --delete <list>` after confirming `git diff origin/dev..origin/main --stat` is empty per CLAUDE.md §7.6.

13. **Document the load-bearing `[Combination: ...]` marker contract.** Today this marker is implicit — written by mapping engine, consumed by transform agent, with no schema or test. While it exists (i.e., before recommendation #3 lands), add an inline comment + a unit test in tests/lib/ that pins the producer/consumer contract. Path D's output format change will silently break this otherwise.

14. **Plan the deliverables generator updates as separate follow-up PRs.** Path D will inevitably reshape the inputs to `migration_runbook`, `execution_package`, `readiness_report`, etc. Don't bundle these prompt updates with the Path D core PR — sequence as: (a) Path D core (mapping flow + new tables) flag-gated; (b) per-deliverable PRs that consume new tables; (c) coverage parity validation before any flag flip in prod.

---

## Done Criteria

- ✅ File `docs/investigations/path-d-architecture-audit.md` exists at this path
- ✅ All sections A–G populated with file:line citations
- ✅ All 5 specific questions answered directly
- ✅ RISKS section: 12 entries with file:line citations
- ✅ RECOMMENDATIONS section: 14 actionable items

> **Verification note:** All file:line citations originate from five parallel investigation passes. Spot-check before relying on any specific line number for code edits, particularly around frequently-modified files like [lib/actions/mappings.ts](lib/actions/mappings.ts), [lib/ai/mapping-engine.ts](lib/ai/mapping-engine.ts), and [lib/actions/transformations.ts](lib/actions/transformations.ts).
