# Changelog

Sprint progress and shipped features. One entry per sprint or significant milestone.

---

## S2 — Template Flywheel + Override Logging (May 27–28, 2026)

### Shipped
- **S2.1** Template storage live — `migration_templates` + `template_entries` tables, RLS, flywheel counters (SET-1, PR #204)
- **S2.2** Extract template on approve — `snapshotTemplate()` fires after generate-all-transforms, stores approved mappings (SET-2)
- **S2.3** Template priors in LLM prompt — both BULK and SINGLE-PAIR paths inject `<TEMPLATE_PRIORS>` with up to 5 matched prior entries (SET-3)
- **S2.4** Override logging schema — `override_logs` table (migration 115), label quality columns: `time_on_task_ms`, `was_edited`, `approval_method` (SET-8, PR #202)
- **S2.5** Prompt 2 synonym expansion — `interpretCrossSystemSynonyms()` in `field-interpreter.ts`, new `field_interpretation` callsite (SET-9, PR #203)
- **Infra** Migration 110→115 rename (collision with Kaan's 110_apply_field_transform_filter_sql)
- **Infra** Merged all 3 PRs (#202 #203 #204) into main, propagated to dev

### Decisions
- Label quality signals: `time_on_task_ms` + `was_edited` + `approval_method` — enough to weight training signal without invasive tracking
- Template priors are "historical signal only" — LLM instruction prevents auto-approval from prior mappings
- Override logging is fire-and-forget at approval time — no user-facing latency impact

### Known gaps
- `updateTemplateFromApproval()` wired but override_logs migration not yet applied to prod
- No integration test for full template lifecycle (SET-4)
- Override undo/revert not implemented (SET-11)

---

## S1 — Core Pipeline (Apr–May 2026)

### Shipped
- **S1.1** Single LLM mapping call — replaced 4-agent voting with one call + deterministic validation
- **S1.2** Transformation Layer 1 validators — type compat, null checks, FK gaps, enum mismatches
- **S1.3** Field-level domain interpretation — `interpretFieldDomains()` adds semantic context before mapping
- **S1.4** Self-correction loop — validator → LLM re-propose, max 3 iterations
- **S1.5** Cross-mapping + package consistency checks (deterministic)

### Decisions
- Single LLM call > multi-agent voting: cheaper, faster, equally accurate with good validators
- Self-correction capped at 3 retries to prevent runaway API costs
- Validators are deterministic-only — no LLM in the validation path
