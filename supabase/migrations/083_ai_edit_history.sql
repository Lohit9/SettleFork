-- 083_ai_edit_history.sql — Phase 0c provenance & edit-diff capture
--
-- Schema-only migration. Three concerns, one file:
--
--   1. New table `ai_edit_history` — sibling to `activity_log` (031). Where
--      activity_log captures human-visible events as a description string,
--      ai_edit_history captures the structured before/after for any
--      AI-touched value so we can answer "did the user keep what the AI
--      proposed?" deterministically. Drives the migration_intelligence
--      confidence-calibration loop in a later PR.
--
--   2. New `original_ai_*` columns on the four hot AI-mutating tables
--      (target_field_mappings, mapping_sources, transformations,
--      quality_issues). Frozen on the first AI write and never overwritten
--      by subsequent edits, so the UI can render "AI proposed X / user
--      kept Y" with a zero-join read. Mirrors the existing
--      validation_rules.ai_original_prompt pattern (006:22).
--
--   3. Phase 2 prep: nullable `thinking` + `thinking_token_count` columns
--      on `llm_calls`. Schema-only — wiring lives in Phase 2 when extended
--      thinking is enabled per-callsite.
--
-- Application-code wiring (`logAIEdit` helper, emission points,
-- redactor, invariant test) is PR 9. This migration is dormant until
-- PR 9 starts writing.
--
-- Hard prerequisite: 082_llm_calls.sql must be applied before this
-- migration runs — `ai_edit_history.llm_call_id` is an FK to
-- `llm_calls(id)`. If 082 has not been applied, this migration will
-- fail at FK-resolution and that is the correct fail-loud behavior.
--
-- Reversibility: every addition is nullable. Reversal is
-- `DROP TABLE ai_edit_history` plus per-table `ALTER TABLE ... DROP COLUMN`.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ai_edit_history table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_edit_history (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant scoping. Every row joins back to a project for RLS via
  -- public.user_can_access_project().
  project_id      UUID         NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Who did the edit. Service-role inserts (from server actions) MUST
  -- pass an authenticated user_id; AI-internal retries (e.g., the
  -- mapping_generate_repair retry chain in lib/ai/mapping-engine.ts)
  -- carry the original initiating user's id.
  actor_id        UUID         NOT NULL REFERENCES auth.users(id),

  -- What was edited. entity_type is one of a controlled set (CHECK
  -- below) so cross-entity analytics are tractable. entity_id is opaque
  -- (table-specific PK).
  entity_type     TEXT         NOT NULL CHECK (entity_type IN (
    'target_field_mapping',
    'mapping_source',
    'transformation',
    'validation_rule',
    'quality_issue'
  )),
  entity_id       UUID         NOT NULL,

  -- Field path within the entity, e.g. 'generated_sql', 'confidence',
  -- 'mapping_sources[0].source_field_id'. JSON-pointer-like syntax so a
  -- single row captures any-depth field changes without DDL changes
  -- when a new field becomes AI-edited.
  field_path      TEXT         NOT NULL,

  -- The diff itself. JSONB to store scalars, arrays, or objects with
  -- the same shape; future-proof for tool-use outputs without schema
  -- change. Both sides MUST be redacted (lib/ai/redact.ts in PR 9)
  -- before insert. NULL on either side means insert/delete.
  old_value       JSONB,
  new_value       JSONB,

  -- Provenance: what kind of change is this?
  --   'ai_proposed'    — initial AI write (no prior human value)
  --   'ai_replaced'    — AI overwrote an earlier AI value (e.g., regen)
  --   'human_accepted' — user explicitly approved/acknowledged AI value
  --   'human_modified' — user edited an AI value (calibration signal)
  --   'human_rejected' — user discarded AI value (status=rejected)
  --   'human_authored' — user wrote a value with no prior AI proposal
  edit_kind       TEXT         NOT NULL CHECK (edit_kind IN (
    'ai_proposed',
    'ai_replaced',
    'human_accepted',
    'human_modified',
    'human_rejected',
    'human_authored'
  )),

  -- Linkage to the AI call that produced the value (PR 6 table). NULL
  -- for human-only edits and for legacy AI rows that predate PR 6.
  -- ON DELETE SET NULL so retention policies on llm_calls don't
  -- cascade-delete provenance rows.
  llm_call_id     UUID         REFERENCES public.llm_calls(id) ON DELETE SET NULL,

  -- Free-form per-edit-kind context (e.g.
  -- {"previous_status":"proposed","next_status":"approved"} or
  -- {"regen_trigger":"schema_changed"}).
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_edit_history IS
  'Per-edit provenance for AI-mutating tables. Sibling to activity_log; activity_log captures human-visible events as descriptions, ai_edit_history captures structured before/after for AI-touched values. Phase 0c.';

COMMENT ON COLUMN public.ai_edit_history.entity_type IS
  'Locked enum (CHECK constraint). Adding a new AI-mutating entity requires both a migration to add it here AND wiring it into logAIEdit''s AIEntityType union (lib/actions/ai-edit-history.ts).';

COMMENT ON COLUMN public.ai_edit_history.field_path IS
  'JSON-pointer-like path within the entity. e.g. ''generated_sql'', ''confidence'', ''mapping_sources[0].source_field_id''. One row per field change; reconstructing a multi-field edit is ORDER BY created_at within the entity.';

COMMENT ON COLUMN public.ai_edit_history.edit_kind IS
  'Provenance discriminator. ai_proposed/ai_replaced are AI writes; human_* are user-initiated. Drives migration_intelligence confidence calibration in a later PR.';

COMMENT ON COLUMN public.ai_edit_history.llm_call_id IS
  'FK to llm_calls (082). NULL for human-only edits and for legacy AI rows that predate PR 6. ON DELETE SET NULL so llm_calls retention does not orphan-delete provenance.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ai_edit_history indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- "Show me everything that happened to this TFM/transform/etc."
CREATE INDEX IF NOT EXISTS idx_ai_edit_history_entity
  ON public.ai_edit_history (entity_type, entity_id, created_at DESC);

-- "Show me all AI edits in this project, newest first."
CREATE INDEX IF NOT EXISTS idx_ai_edit_history_project_time
  ON public.ai_edit_history (project_id, created_at DESC);

-- Calibration: "for every AI proposal in this project, did the human keep
-- it?" Drives the migration_intelligence confidence loop in a later PR.
CREATE INDEX IF NOT EXISTS idx_ai_edit_history_kind
  ON public.ai_edit_history (project_id, edit_kind, created_at DESC);

-- "What did this LLM call write?" — partial index, only populated for
-- AI-originated edits. Mirrors idx_llm_calls_parent_call_id (082:73-74).
CREATE INDEX IF NOT EXISTS idx_ai_edit_history_llm_call_id
  ON public.ai_edit_history (llm_call_id) WHERE llm_call_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ai_edit_history RLS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Read: project members via public.user_can_access_project (079).
-- Write: service_role only — server actions write via supabaseAdmin from
-- logAIEdit (PR 9). Mirrors llm_calls (082:77-83) and the
-- SECURITY DEFINER RPC convention in CLAUDE.md §4.4.

ALTER TABLE public.ai_edit_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_edit_history_select_project_members"
  ON public.ai_edit_history FOR SELECT
  USING (public.user_can_access_project(project_id));

-- INSERT/UPDATE/DELETE: service_role only (no authenticated-user policies).
-- service_role bypasses RLS by design.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. original_ai_* columns on the four hot AI-mutating tables
-- ─────────────────────────────────────────────────────────────────────────────
--
-- All nullable. Populated by PR 9's logAIEdit on the first ai_proposed
-- write per entity, never overwritten by subsequent edits. The UI treats
-- NULL as "no AI proposal recorded" — covers both legacy rows that
-- predate PR 9 and rows that were always human-authored.
--
-- Type choice: confidence columns are NUMERIC(5,2) to match the source
-- columns' type (074:145, 074:198) so backfill copies are
-- precision-faithful. The investigation suggested REAL but matching the
-- actual column type is correct.

-- target_field_mappings: confidence + ai_reasoning are AI-written today
-- (074:145-149); freeze the AI's first proposal here.
ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS original_ai_confidence  NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS original_ai_reasoning   TEXT;

COMMENT ON COLUMN public.target_field_mappings.original_ai_confidence IS
  'Frozen first-AI-proposal confidence. Populated by lib/actions/ai-edit-history.ts:logAIEdit on ai_proposed writes only; never overwritten on subsequent edits. NULL for rows with no AI proposal recorded.';

COMMENT ON COLUMN public.target_field_mappings.original_ai_reasoning IS
  'Frozen first-AI-proposal reasoning text. Same write semantics as original_ai_confidence.';

-- mapping_sources: source_field_id + confidence + ai_reasoning are
-- AI-written today (074:195, 074:198, 074:199); freeze them here.
ALTER TABLE public.mapping_sources
  ADD COLUMN IF NOT EXISTS original_ai_source_field_id UUID,
  ADD COLUMN IF NOT EXISTS original_ai_confidence      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS original_ai_reasoning       TEXT;

COMMENT ON COLUMN public.mapping_sources.original_ai_source_field_id IS
  'Frozen first-AI-proposed source field. No FK to fields(id) — the proposal is provenance, and we want it preserved even if the underlying field is deleted.';

COMMENT ON COLUMN public.mapping_sources.original_ai_confidence IS
  'Frozen first-AI-proposal confidence. Same write semantics as the parent TFM''s original_ai_confidence.';

COMMENT ON COLUMN public.mapping_sources.original_ai_reasoning IS
  'Frozen first-AI-proposal reasoning text.';

-- transformations: generated_sql is AI-written today (002:141);
-- freeze the first AI proposal here.
ALTER TABLE public.transformations
  ADD COLUMN IF NOT EXISTS original_ai_generated_sql TEXT;

COMMENT ON COLUMN public.transformations.original_ai_generated_sql IS
  'Frozen first-AI-proposal SQL. Populated on first ai_proposed write only. NULL for human-authored transforms.';

-- quality_issues: ai_fix_options is AI-written today (006:44).
ALTER TABLE public.quality_issues
  ADD COLUMN IF NOT EXISTS original_ai_fix_options JSONB;

COMMENT ON COLUMN public.quality_issues.original_ai_fix_options IS
  'Frozen first-AI-proposal fix options. Populated on first ai_proposed write only.';

-- validation_rules already has ai_original_prompt (006:22) — no change.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Backfill original_ai_* on demonstrably-AI-written rows
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Best-effort copy of current values to original_ai_* on rows where AI
-- authorship is unambiguous. Rows without those signals stay NULL; the
-- UI treats NULL as "no AI proposal recorded."
--
-- Idempotent: each UPDATE sets original_ai_* on rows where the source
-- column is non-NULL; running twice produces the same end state because
-- post-PR-9 writes will only set original_ai_* on the first ai_proposed
-- emission and never overwrite. For pre-PR-9 backfill, the current value
-- IS the AI's proposal (no human edits were tracked yet).

UPDATE public.target_field_mappings
   SET original_ai_confidence = confidence,
       original_ai_reasoning  = ai_reasoning
 WHERE ai_reasoning IS NOT NULL;

UPDATE public.mapping_sources
   SET original_ai_source_field_id = source_field_id,
       original_ai_confidence      = confidence,
       original_ai_reasoning       = ai_reasoning
 WHERE ai_reasoning IS NOT NULL;

UPDATE public.transformations
   SET original_ai_generated_sql = generated_sql
 WHERE is_ai_generated = TRUE
   AND generated_sql IS NOT NULL;

UPDATE public.quality_issues
   SET original_ai_fix_options = ai_fix_options
 WHERE ai_fix_options IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. llm_calls thinking-block columns (Phase 2 prep)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Schema-only stub. Phase 2 will turn on Anthropic's extended-thinking
-- feature for high-stakes calls (transform generation, NL→SQL,
-- validation rule synthesis) and wire lib/ai/llm-client.ts to populate
-- these columns. Adding the columns now de-risks Phase 2 by settling
-- the persistence shape.
--
-- pricing.ts will need a thinking_token_count tier when Phase 2 ships;
-- that update lives with the wiring, not here.

ALTER TABLE public.llm_calls
  ADD COLUMN IF NOT EXISTS thinking              JSONB,
  ADD COLUMN IF NOT EXISTS thinking_token_count  INT;

COMMENT ON COLUMN public.llm_calls.thinking IS
  'Anthropic extended-thinking blocks (array of {type:"thinking", thinking:"..."} blocks). NULL until Phase 2 enables extended thinking. Stored verbatim from the API response so the eval harness can parse block-by-block.';

COMMENT ON COLUMN public.llm_calls.thinking_token_count IS
  'Tokens consumed by extended-thinking generation, billed separately from input/output_tokens at Anthropic''s thinking-tier price. NULL when thinking is not requested.';

-- Partial index — small until Phase 2 ships, then useful for
-- "show me recent calls that produced thinking blocks" queries.
CREATE INDEX IF NOT EXISTS idx_llm_calls_with_thinking
  ON public.llm_calls (created_at DESC) WHERE thinking IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Intentionally NOT included in this migration
-- ─────────────────────────────────────────────────────────────────────────────
--
-- - parent_edit_id on ai_edit_history (diff chains): premature; reconstructing
--   a chain is ORDER BY created_at per (entity_type, entity_id).
--
-- - Row-level retention column on ai_edit_history: rows follow the project
--   lifecycle via ON DELETE CASCADE; per-org retention is a Phase 1+ concern.
--
-- - Postgres partitioning: overkill at expected row volumes (<10M rows
--   for any single customer in the next 18 months). Add when needed.
--
-- - migration_intelligence_increment RPC + ON CONFLICT key columns
--   (pattern_type, pattern_signature, UNIQUE constraint): the existing
--   migration_intelligence table (033) does not have those columns;
--   pattern_type lives inside pattern_config JSONB and pattern_signature
--   does not exist. Canonicalization needs its own investigation
--   (collision verification + signature derivation). Filed as a Phase 0c
--   follow-up after PR 9 lands.
--
-- - Application-code wiring (logAIEdit, redactForLog, emission points,
--   invariant test): PR 9.
--
-- - Phase 2 wiring of thinking blocks (lib/ai/llm-client.ts request
--   shape, LLMCallResult return type, pricing.ts thinking-tier math):
--   Phase 2.
