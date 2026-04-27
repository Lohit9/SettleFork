-- Flip the default for `projects.use_mapping_redesign` so that newly-created
-- projects automatically opt into the Phase 3+ redesigned mapping UI.
--
-- This affects FUTURE rows only. Existing projects keep whatever value they
-- have today (NOT NULL, no row rewrite). Rollback is a symmetric SET DEFAULT.

ALTER TABLE public.projects
  ALTER COLUMN use_mapping_redesign SET DEFAULT TRUE;
