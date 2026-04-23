-- Feature flag infrastructure for the mapping redesign rollout.
--
-- Implements docs/features/mapping-redesign.md §"Feature flag infrastructure".
--
-- Two additive boolean columns on public.projects. Existing org-based RLS
-- policies on public.projects (migration 050_organizations.sql) cover these
-- columns automatically — no new policies required.
--
-- Both columns are transient: dropped in a future cleanup migration once the
-- redesign rollout is complete (per spec §Cleanup migration, line ~1307).

ALTER TABLE public.projects
  ADD COLUMN use_mapping_redesign BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.projects
  ADD COLUMN maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: optimized for the canary rollout (most projects off, few on).
-- Not useful for maintenance_mode — that column flips briefly across ALL rows
-- during the deployment window, so a partial index wouldn't stay selective.
CREATE INDEX idx_projects_use_mapping_redesign
  ON public.projects(use_mapping_redesign)
  WHERE use_mapping_redesign = true;

COMMENT ON COLUMN public.projects.use_mapping_redesign IS
  'Phase 3+ redesigned mapping UI + cross-table authoring gate. Per-project feature flag. Dropped after all projects stable on new UI post-migration.';

COMMENT ON COLUMN public.projects.maintenance_mode IS
  'Transient flag for the Phase 1+2 migration deployment window. Blocks mapping writes when true. Dropped after migration complete.';
