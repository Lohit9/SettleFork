-- ============================================================================
-- Migration 101 — POC flag infrastructure (Rootstock answer-key injection)
-- ============================================================================
-- Adds the minimum schema needed to route a project-scoped authoritative
-- answer key into the Path D mapping pipeline. Three additive changes:
--
--   1. Extend `schema_documents.doc_type` CHECK to accept 'poc_answer_key'
--      alongside the existing 'schema' / 'business_context' values.
--   2. Add `projects.poc_template TEXT` (NULL = flag off) and
--      `projects.poc_overrides JSONB DEFAULT '{}'` for {{token}} substitution.
--   3. Partial index on `projects.poc_template` for the flag-on lookup —
--      mirrors the `idx_projects_use_mapping_redesign` partial-index idiom
--      from migration 073, since the cardinality is rare-true.
--
-- All three changes are nullable / defaulted, so existing rows remain valid
-- post-ALTER and the heritage byte-identical baseline is preserved.
--
-- Sunset: INF-73 — single removal PR after iter-3 ships generic multi-entity
-- authoring + answer-key-style decision/lookup output as default behavior.
--
-- Stop 0 reconciliation: the original spec referenced `content` and
-- `uploaded_by` columns on schema_documents that do not exist. The
-- canonical text-bearing column is `extracted_text` (migration 003) and
-- there is no actor-id column. Confirmed against `schema_documents` insert
-- shape used by `uploadBusinessContextDoc` at
-- `lib/actions/schema-documents.ts:391-401`. Migration 101 itself is
-- unaffected; the rename only matters for Tasks 3.2 and 7.
-- ============================================================================


-- 1. Extend schema_documents.doc_type to allow 'poc_answer_key' ---------------
-- The constraint was added inline in migration 021 (no explicit name), so
-- Postgres auto-named it `schema_documents_doc_type_check`. Drop-then-add
-- is the canonical idiom for widening a CHECK enumeration without changing
-- the constraint name.

ALTER TABLE public.schema_documents
  DROP CONSTRAINT schema_documents_doc_type_check;

ALTER TABLE public.schema_documents
  ADD CONSTRAINT schema_documents_doc_type_check
    CHECK (doc_type IN ('schema', 'business_context', 'poc_answer_key'));


-- 2. Add POC flag columns to projects -----------------------------------------
-- `poc_template` is the discriminator (NULL = OFF, 'rootstock' = ON for the
-- RCB Industries POC; future POCs add new string values). `poc_overrides` is
-- the per-project {{token}} substitution map applied to the answer-key
-- markdown at read time (see lib/ai/poc-overrides.ts in this PR).
--
-- Both nullable / defaulted so the heritage flag-OFF byte-identical baseline
-- is preserved (every existing project row reads `poc_template IS NULL` →
-- the Path D code path doesn't even fetch the answer-key row).

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS poc_template  TEXT,
  ADD COLUMN IF NOT EXISTS poc_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.projects.poc_template IS
  'Rootstock POC flag (INF-73 sunset). NULL = OFF (default; preserves '
  'Path D heritage behavior). Non-NULL string identifies which '
  'doc_type=poc_answer_key document Path D should inject as authoritative '
  'context. Today only the literal ''rootstock'' is used.';

COMMENT ON COLUMN public.projects.poc_overrides IS
  'Per-project {{token}} substitution map for the POC answer-key markdown. '
  'Applied at read time by applyPocOverrides (lib/ai/poc-overrides.ts). '
  'Empty object means "no overrides; render template verbatim". Sunset INF-73.';


-- 3. Partial index on poc_template (rare-true lookup) -------------------------
-- Mirrors the `idx_projects_use_mapping_redesign` idiom (migration 073:21-23).
-- Only ~1 row will have poc_template IS NOT NULL during the POC window, so a
-- partial index stays tight. IF NOT EXISTS keeps re-apply safe.

CREATE INDEX IF NOT EXISTS idx_projects_poc_template
  ON public.projects (poc_template)
  WHERE poc_template IS NOT NULL;
