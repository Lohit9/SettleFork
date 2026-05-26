BEGIN;

-- ============================================================
-- 108: schema_documents — by_project companion policies
-- ============================================================
-- RENUMBERING NOTE
-- ----------------
-- This migration's SQL was hot-applied to production via Supabase
-- Dashboard on 2026-05-25 under the filename
-- 106_schema_documents_by_project_policies.sql. A concurrent workstream
-- merged 106_transform_layer1_validators.sql to main during the same
-- session, so the file was renumbered to 108 here for repo consistency
-- (107 reserved for PR Ω.1). The prod DB state is correct — only the
-- filename in the repo is shifted.
--
-- BACKGROUND
-- ----------
-- Migration 050 wrote 4 RLS policies on schema_documents
-- (SELECT/INSERT/UPDATE/DELETE) that all use a dataset_id-only predicate:
--     EXISTS (SELECT 1 FROM datasets d
--             WHERE d.id = dataset_id AND user_..._project(d.project_id))
-- When business-context docs were introduced (doc_type='business_context'),
-- they store project_id directly with dataset_id = NULL. The EXISTS
-- subquery is unsatisfiable for those rows, so the 050 policies silently
-- block them.
--
-- In prod, this was patched out-of-band by manually adding two companion
-- policies for SELECT and INSERT scoped on project_id. UPDATE and DELETE
-- were missed, producing the reported bug:
--   editor clicks X on a business-context doc → server returns success
--   (Supabase returns {data:[], error:null} on RLS-blocked DELETE — no
--    error to detect) → UI removes the row → refresh shows it's still
--   there.
--
-- This migration:
--   1. Backports the two prod-only by_project policies into the repo so
--      the schema source-of-truth (migrations/) matches what prod is
--      actually running. Fresh DBs (dev resets, scratch projects, local)
--      will now match prod behavior on business-context docs.
--   2. Adds the missing by_project companion policies for UPDATE and
--      DELETE, so editors can mutate business-context docs.
--
-- The four policies are uniform in shape and match prod's verbatim
-- expressions for #1 and #2 — including the parenthesized form, the
-- 'editor'::character varying cast, and the unqualified function names —
-- so a `pg_get_expr(polqual, polrelid)` diff against prod is byte-identical
-- for the backported pair.
--
-- IDEMPOTENCY & ATOMICITY
-- -----------------------
-- Uses DROP POLICY IF EXISTS + CREATE POLICY so the migration is safe to
-- re-run, safe on prod (where #1/#2 already exist), and safe on dev/local
-- (where they don't). Applying twice produces the same end state.
--
-- The entire migration is wrapped in BEGIN/COMMIT. Each DROP+CREATE pair
-- is atomic from another session's perspective — concurrent queries
-- never see a window where a policy is missing. Either every policy is
-- present in its new form, or the prior state is intact (on rollback).
--
-- WHAT THIS DOES NOT TOUCH
-- ------------------------
-- - The 4 dataset-scoped policies from 050 (org_access_schema_documents,
--   editors_insert_schema_documents, editors_update_schema_documents,
--   editors_delete_schema_documents) — they remain correct for schema
--   docs.
-- - The legacy "Users see own schema documents" policy (separate
--   concern, audit in a future cleanup pass).
--
-- ROLLBACK
-- --------
-- Forward migration 109_revert_schema_documents_by_project.sql:
--   DROP POLICY IF EXISTS "org_access_schema_documents_by_project"
--     ON public.schema_documents;
--   DROP POLICY IF EXISTS "editors_insert_schema_documents_by_project"
--     ON public.schema_documents;
--   DROP POLICY IF EXISTS "editors_update_schema_documents_by_project"
--     ON public.schema_documents;
--   DROP POLICY IF EXISTS "editors_delete_schema_documents_by_project"
--     ON public.schema_documents;
-- Caveat: rolling back drops the prod-only #1/#2 policies that this
-- migration backported. Business-context SELECT/INSERT would break on
-- prod unless those two are manually re-applied from the pre-108 state
-- (see probe 3 output captured in the PR description). Only intended
-- if a regression we didn't foresee shows up.
-- ============================================================

-- ── 1. Backport: by_project SELECT (already exists in prod) ──────────
DROP POLICY IF EXISTS "org_access_schema_documents_by_project" ON public.schema_documents;
CREATE POLICY "org_access_schema_documents_by_project" ON public.schema_documents FOR SELECT
  USING (((project_id IS NOT NULL) AND user_can_access_project(project_id)));

-- ── 2. Backport: by_project INSERT (already exists in prod) ──────────
DROP POLICY IF EXISTS "editors_insert_schema_documents_by_project" ON public.schema_documents;
CREATE POLICY "editors_insert_schema_documents_by_project" ON public.schema_documents FOR INSERT
  WITH CHECK (((project_id IS NOT NULL) AND user_has_project_role(project_id, 'editor'::character varying)));

-- ── 3. NEW: by_project UPDATE (missing in prod — completeness) ───────
DROP POLICY IF EXISTS "editors_update_schema_documents_by_project" ON public.schema_documents;
CREATE POLICY "editors_update_schema_documents_by_project" ON public.schema_documents FOR UPDATE
  USING (((project_id IS NOT NULL) AND user_has_project_role(project_id, 'editor'::character varying)));

-- ── 4. NEW: by_project DELETE (missing in prod — THE FIX) ────────────
DROP POLICY IF EXISTS "editors_delete_schema_documents_by_project" ON public.schema_documents;
CREATE POLICY "editors_delete_schema_documents_by_project" ON public.schema_documents FOR DELETE
  USING (((project_id IS NOT NULL) AND user_has_project_role(project_id, 'editor'::character varying)));

COMMIT;
