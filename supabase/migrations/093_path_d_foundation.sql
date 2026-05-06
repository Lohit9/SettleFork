-- ============================================================================
-- Migration 093 — Path D Foundation: Tables + TFM Enrichment
-- ============================================================================
-- Adds 5 new tables (target_field_coverage, project_decisions,
-- project_lookup_tables, project_data_quality_issues, project_inferred_targets)
-- + 5 enrichment columns on target_field_mappings (transformation_intent,
-- mapping_cardinality, dedup_required, dedup_strategy, data_quality_flag_ids).
--
-- Apply order: 091 (mapping_experiments view, cherry-picked) → 092
-- (experiment_run_id on TFM, cherry-picked) → 093 (this file).
--
-- Apply to dev only at this stage; prod application deferred until Path D
-- ships behind AI_MAPPING_PATH_D_ENABLED (mirrors AI_MAPPING_TWO_PASS_ENABLED
-- naming from INF-22 Path C).
--
-- RLS pattern: canonical from 074:266–283 — `user_can_access_project` for
-- SELECT, `user_has_project_role(_, 'editor')` for INSERT / UPDATE / DELETE.
-- Auth-attribution FKs (default_decided_by, decided_by, acknowledged_by) use
-- ON DELETE SET NULL so removing an auth user does not cascade-delete
-- decisions or DQ-issue acknowledgments.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE on functions, DROP TRIGGER + CREATE TRIGGER for
-- updated_at triggers, DROP INDEX IF EXISTS + CREATE INDEX for partial
-- indexes (matches 092's idiom — partial-index invariant cannot be
-- preserved by IF NOT EXISTS alone).
-- ============================================================================


-- ── 0. Defensive redefinition of update_updated_at() ────────────────────────
-- This trigger function originally lands in migration 0370. Redefining here
-- with CREATE OR REPLACE makes 093 self-contained for fresh DBs where
-- migrations may apply in non-strict order, and is a safe no-op when the
-- function is already present from 0370.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 1. target_field_coverage
-- ============================================================================
-- One row per (project, target_field) recording Path D's coverage verdict
-- for that target. A single TFM may exist independently; coverage is the
-- "is the target satisfied?" outcome (covered / partial / gap / optional /
-- out_of_scope) plus the AI's recommended default-value handling.

CREATE TABLE IF NOT EXISTS public.target_field_coverage (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  target_field_id                 UUID NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
  coverage_status                 TEXT NOT NULL
                                    CHECK (coverage_status IN ('covered', 'partial', 'gap', 'optional', 'out_of_scope')),
  ai_reasoning                    TEXT,
  default_value_recommendation    JSONB,
  default_value_decided           JSONB,
  default_decided_at              TIMESTAMPTZ,
  default_decided_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  experiment_run_id               UUID,
  UNIQUE (project_id, target_field_id)
);

COMMENT ON TABLE public.target_field_coverage IS
  'Path D — per-target coverage verdict and default-value handling. One row '
  'per (project, target_field). Joined to target_field_mappings via '
  '(project_id, target_field_id).';

CREATE INDEX IF NOT EXISTS idx_target_field_coverage_project_status
  ON public.target_field_coverage (project_id, coverage_status);

DROP INDEX IF EXISTS public.idx_target_field_coverage_experiment_run_id;
CREATE INDEX idx_target_field_coverage_experiment_run_id
  ON public.target_field_coverage (experiment_run_id)
  WHERE experiment_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_target_field_coverage_updated_at ON public.target_field_coverage;
CREATE TRIGGER update_target_field_coverage_updated_at
  BEFORE UPDATE ON public.target_field_coverage
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.target_field_coverage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_target_field_coverage"
  ON public.target_field_coverage FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_target_field_coverage"
  ON public.target_field_coverage FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_target_field_coverage"
  ON public.target_field_coverage FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_target_field_coverage"
  ON public.target_field_coverage FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));


-- ============================================================================
-- 2. project_decisions
-- ============================================================================
-- Structured business decisions surfaced by Path D (e.g., picklist transforms,
-- description sources, external-id format choices). Replaces the activity_log
-- "approve/reject only" shape with structured input/output payload + rationale
-- + applies-to references back to the TFM and coverage rows the decision
-- shapes.

CREATE TABLE IF NOT EXISTS public.project_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  decision_type       TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  ai_recommendation   JSONB NOT NULL,
  alternatives        JSONB NOT NULL,
  customer_decision   JSONB,
  applies_to          JSONB,
  status              TEXT NOT NULL
                        CHECK (status IN ('pending', 'decided', 'auto_applied')),
  decided_at          TIMESTAMPTZ,
  decided_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  experiment_run_id   UUID
);

COMMENT ON TABLE public.project_decisions IS
  'Path D — structured business decisions per project. ai_recommendation is '
  'the AI''s primary suggestion (option/value/rationale shape); alternatives '
  'is the per-option array; customer_decision is the chosen outcome (NULL '
  'until decided). applies_to references {tfm_ids, coverage_ids}.';

CREATE INDEX IF NOT EXISTS idx_project_decisions_project_status
  ON public.project_decisions (project_id, status);

DROP INDEX IF EXISTS public.idx_project_decisions_experiment_run_id;
CREATE INDEX idx_project_decisions_experiment_run_id
  ON public.project_decisions (experiment_run_id)
  WHERE experiment_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_project_decisions_updated_at ON public.project_decisions;
CREATE TRIGGER update_project_decisions_updated_at
  BEFORE UPDATE ON public.project_decisions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.project_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_project_decisions"
  ON public.project_decisions FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_project_decisions"
  ON public.project_decisions FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_project_decisions"
  ON public.project_decisions FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_project_decisions"
  ON public.project_decisions FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));


-- ============================================================================
-- 3. project_lookup_tables
-- ============================================================================
-- Reusable enum / code mapping tables surfaced by Path D as first-class
-- entities (e.g., uom_normalization, item_type_picklist). Avoid encoding
-- lookup logic only inside transformation SQL — making lookups a queryable
-- entity supports cross-table reuse and customer review/approval flows.

CREATE TABLE IF NOT EXISTS public.project_lookup_tables (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  applies_to_fields   JSONB,
  mappings            JSONB NOT NULL,
  data_quality_notes  JSONB,
  customer_approved   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  experiment_run_id   UUID,
  UNIQUE (project_id, name)
);

COMMENT ON TABLE public.project_lookup_tables IS
  'Path D — first-class enum / code mapping tables. mappings is the source→'
  'target value dictionary (e.g. {"Each":"EA","Lbs":"LB"}); applies_to_fields '
  'lists the (source_field_id, target_field_id) pairs the lookup serves; '
  'data_quality_notes captures per-source-value caveats.';

DROP INDEX IF EXISTS public.idx_project_lookup_tables_experiment_run_id;
CREATE INDEX idx_project_lookup_tables_experiment_run_id
  ON public.project_lookup_tables (experiment_run_id)
  WHERE experiment_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_project_lookup_tables_updated_at ON public.project_lookup_tables;
CREATE TRIGGER update_project_lookup_tables_updated_at
  BEFORE UPDATE ON public.project_lookup_tables
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.project_lookup_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_project_lookup_tables"
  ON public.project_lookup_tables FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_project_lookup_tables"
  ON public.project_lookup_tables FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_project_lookup_tables"
  ON public.project_lookup_tables FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_project_lookup_tables"
  ON public.project_lookup_tables FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));


-- ============================================================================
-- 4. project_data_quality_issues
-- ============================================================================
-- Append-only AI-detected DQ findings tied to Path D's pass. source_field_id
-- nullable so project-level (cross-field / cross-table) findings have a home.
-- Distinct from quality_issues (002) which is the in-flight DQ engine's
-- output — this table is Path D's single-call structured DQ surface.

CREATE TABLE IF NOT EXISTS public.project_data_quality_issues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_field_id     UUID REFERENCES public.fields(id) ON DELETE CASCADE,
  severity            TEXT NOT NULL
                        CHECK (severity IN ('critical', 'warning', 'info')),
  category            TEXT NOT NULL,
  description         TEXT NOT NULL,
  example_values      JSONB,
  recommendation      TEXT,
  acknowledged_at     TIMESTAMPTZ,
  acknowledged_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  experiment_run_id   UUID
);

COMMENT ON TABLE public.project_data_quality_issues IS
  'Path D — append-only AI-detected data-quality findings. Distinct from '
  'quality_issues (002) which is the in-flight DQ engine''s output — this '
  'table captures the single-call Path D pass. source_field_id is NULL for '
  'project-level findings (e.g. cross-table consistency violations).';

CREATE INDEX IF NOT EXISTS idx_project_data_quality_issues_project_severity
  ON public.project_data_quality_issues (project_id, severity);

DROP INDEX IF EXISTS public.idx_project_data_quality_issues_experiment_run_id;
CREATE INDEX idx_project_data_quality_issues_experiment_run_id
  ON public.project_data_quality_issues (experiment_run_id)
  WHERE experiment_run_id IS NOT NULL;

ALTER TABLE public.project_data_quality_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_project_data_quality_issues"
  ON public.project_data_quality_issues FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_project_data_quality_issues"
  ON public.project_data_quality_issues FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_project_data_quality_issues"
  ON public.project_data_quality_issues FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_project_data_quality_issues"
  ON public.project_data_quality_issues FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));


-- ============================================================================
-- 5. project_inferred_targets
-- ============================================================================
-- Append-only AI-inferred target objects that aren't in the customer's
-- declared target schema but appear required given the source data
-- (e.g., a "Contact" entity inferred from contact_first / contact_last
-- columns when only an Account target was declared). No acknowledged_by
-- attribution — these are AI inferences and acknowledgment is project-
-- level, not user-level.

CREATE TABLE IF NOT EXISTS public.project_inferred_targets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  inferred_target_object   TEXT NOT NULL,
  evidence_source_fields   JSONB,
  reasoning                TEXT,
  acknowledged_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  experiment_run_id        UUID
);

COMMENT ON TABLE public.project_inferred_targets IS
  'Path D — append-only AI-inferred target objects implied by the source '
  'data but absent from the declared target schema. evidence_source_fields '
  'is the JSON list of source field UUIDs the inference drew from.';

DROP INDEX IF EXISTS public.idx_project_inferred_targets_experiment_run_id;
CREATE INDEX idx_project_inferred_targets_experiment_run_id
  ON public.project_inferred_targets (experiment_run_id)
  WHERE experiment_run_id IS NOT NULL;

ALTER TABLE public.project_inferred_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_access_project_inferred_targets"
  ON public.project_inferred_targets FOR SELECT
  USING (public.user_can_access_project(project_id));

CREATE POLICY "editors_insert_project_inferred_targets"
  ON public.project_inferred_targets FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_update_project_inferred_targets"
  ON public.project_inferred_targets FOR UPDATE
  USING (public.user_has_project_role(project_id, 'editor'));

CREATE POLICY "editors_delete_project_inferred_targets"
  ON public.project_inferred_targets FOR DELETE
  USING (public.user_has_project_role(project_id, 'editor'));


-- ============================================================================
-- 6. target_field_mappings — enrichment columns
-- ============================================================================
-- Path D structured outputs that complement the existing TFM shape. All five
-- columns are nullable / defaulted so existing rows are valid post-ALTER and
-- the heritage byte-identical baseline is preserved (no SELECT * callsite
-- against TFM exists in lib/ — verified Stop 1 audit).
--
-- mapping_cardinality is renamed from the original Path D spec's
-- `cardinality` to disambiguate from `field_profiles.cardinality` (existing
-- column on a different table) — Stop 1 found the collision and the rename
-- was approved before authoring.

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS transformation_intent TEXT;

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS mapping_cardinality TEXT
    CHECK (mapping_cardinality IS NULL OR
           mapping_cardinality IN ('1:1', 'many_to_one', 'one_to_many', 'many_to_many'));

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS dedup_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS dedup_strategy JSONB;

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS data_quality_flag_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.target_field_mappings.transformation_intent IS
  'Path D — free-form AI rationale describing the intent of the transformation '
  '(distinct from ai_reasoning which describes the mapping decision itself).';

COMMENT ON COLUMN public.target_field_mappings.mapping_cardinality IS
  'Path D — ''1:1'' | ''many_to_one'' | ''one_to_many'' | ''many_to_many''. '
  'Renamed from ''cardinality'' to disambiguate from field_profiles.cardinality.';

COMMENT ON COLUMN public.target_field_mappings.dedup_required IS
  'Path D — TRUE when the source-to-target shape requires deduplication '
  '(e.g. many_to_one collapse).';

COMMENT ON COLUMN public.target_field_mappings.dedup_strategy IS
  'Path D — JSON describing the dedup approach (key fields, conflict '
  'resolution, ordering). NULL when dedup_required is FALSE.';

COMMENT ON COLUMN public.target_field_mappings.data_quality_flag_ids IS
  'Path D — JSON array of project_data_quality_issues.id values referencing '
  'DQ findings that bear on this mapping. Default empty array.';
