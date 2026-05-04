-- 086_project_business_context.sql
-- PR 3.4a — customer-supplied free-text context for the AI mapping engine.
-- Distinct from `description` (project name blurb, 002_foundation.sql:14).
-- Nullable; both NULL and empty string read as "absent" by the prompt
-- builder. RLS unchanged — column inherits the row-level project
-- policies from 050/079. Read consumed in PR 3.4b.

ALTER TABLE public.projects
  ADD COLUMN business_context TEXT;

COMMENT ON COLUMN public.projects.business_context IS
  'Customer-supplied free-text context surfaced to the AI mapping engine. Distinct from `description` (project name blurb).';
