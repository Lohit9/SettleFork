-- Migration 092: persist experiment_run_id onto target_field_mappings so
-- the INF-22 Path B vs Path C comparison surface can JOIN llm_calls to the
-- TFM rows it produced WITHOUT a fragile timestamp-window heuristic.
--
-- Phase A (migration 091) wired experiment_run_id onto llm_calls.metadata.
-- That gives an analyst per-call cost / latency / token telemetry but
-- attributing the resulting TFM rows back to a specific run requires a
-- timestamp-window guess (TFMs created within X seconds of the call).
-- Phase B (this migration) propagates the same UUID onto the TFM row at
-- INSERT time so the JOIN is exact.
--
-- Idempotency: the ALTER TABLE + CREATE INDEX use IF NOT EXISTS, and the
-- RPC update goes through DROP FUNCTION IF EXISTS + CREATE OR REPLACE.
-- Re-running this migration against a DB that already has the column is
-- a no-op; fresh DBs pick the column up here.

-- ── 1. Add experiment_run_id column ────────────────────────────────────

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS experiment_run_id UUID DEFAULT NULL;

COMMENT ON COLUMN public.target_field_mappings.experiment_run_id IS
  'INF-22 — UUID minted once per "Generate Mappings" click and tagged on '
  'every llm_calls row + every TFM row produced by that click. NULL on '
  'TFMs created outside the AI mapping_generate path (manual creates, '
  'pre-INF-22 rows). Direct JOIN target for the mapping_experiment_results '
  'view: tfm.experiment_run_id = (llm_calls.metadata->>''experiment_run_id'')::uuid.';

-- BTREE index for the JOIN. Cardinality is one run per click (~5-50 TFMs
-- per run), so an index makes the per-run aggregate cheap. Partial index
-- on the non-NULL subset to keep the index small (most rows pre-INF-22
-- are NULL and will stay NULL).
--
-- DROP + CREATE (not CREATE INDEX IF NOT EXISTS) because the IF NOT
-- EXISTS guard matches on index NAME only — if a previous manual run
-- on dev/prod already created `idx_tfm_experiment_run_id` as a
-- non-partial index, IF NOT EXISTS would silently leave it in place
-- and the partial-index invariant would be lost. Re-creating
-- guarantees the partial form everywhere.
DROP INDEX IF EXISTS public.idx_tfm_experiment_run_id;
CREATE INDEX idx_tfm_experiment_run_id
  ON public.target_field_mappings (experiment_run_id)
  WHERE experiment_run_id IS NOT NULL;

-- ── 2. Update dq_create_target_field_mapping ──────────────────────────
--
-- Postgres CREATE OR REPLACE FUNCTION cannot change the parameter list,
-- so we DROP the 4-arg signature and re-create with the new
-- p_experiment_run_id parameter. The new parameter has DEFAULT NULL so
-- existing callers (manual create flow, suggest flow) continue to compile
-- without modification — they just write NULL into the new column.
--
-- Body is otherwise byte-identical to migration 074:764. The only diff is
-- the new parameter at the end of the signature and its appearance in
-- the INSERT INTO target_field_mappings column list + VALUES tuple.

DROP FUNCTION IF EXISTS public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.dq_create_target_field_mapping(
  p_project_id        UUID,
  p_target_field_id   UUID,
  p_sources           JSONB,
  p_combination       JSONB,
  p_experiment_run_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tfm_id            UUID;
  v_combination_type  TEXT;
  v_combination_sql   TEXT;
  v_confidence        NUMERIC(5,2);
  v_ai_reasoning      TEXT;
BEGIN
  IF NOT public.user_has_project_role(p_project_id, 'editor') THEN
    RAISE EXCEPTION 'dq_create_target_field_mapping: permission denied for project %', p_project_id;
  END IF;

  v_combination_type := p_combination->>'type';
  v_combination_sql  := p_combination->>'sql';
  v_ai_reasoning     := p_combination->>'ai_reasoning';

  IF v_combination_type NOT IN ('single', 'concat_space', 'concat_comma', 'custom_sql') THEN
    RAISE EXCEPTION 'dq_create_target_field_mapping: invalid combination_type %', v_combination_type;
  END IF;

  IF v_combination_type = 'custom_sql' THEN
    v_confidence := NULLIF(p_combination->>'confidence', '')::NUMERIC(5,2);
  ELSE
    v_confidence := NULL;
  END IF;

  INSERT INTO public.target_field_mappings (
    project_id, target_field_id, confidence, status, ai_reasoning,
    is_acknowledged, combination_type, combination_sql, experiment_run_id
  ) VALUES (
    p_project_id, p_target_field_id, v_confidence, 'needs_review', v_ai_reasoning,
    FALSE, v_combination_type, v_combination_sql, p_experiment_run_id
  )
  RETURNING id INTO v_tfm_id;

  IF jsonb_typeof(p_sources) = 'array' AND jsonb_array_length(p_sources) > 0 THEN
    INSERT INTO public.mapping_sources (
      target_field_mapping_id, source_field_id, source_table_id,
      confidence, ai_reasoning, similar_fields_considered, type_compatibility,
      join_spec, ordinal
    )
    SELECT
      v_tfm_id,
      NULLIF(s->>'source_field_id', '')::UUID,
      NULLIF(s->>'source_table_id', '')::UUID,
      NULLIF(s->>'confidence', '')::NUMERIC(5,2),
      s->>'ai_reasoning',
      s->'similar_fields_considered',
      s->>'type_compatibility',
      CASE WHEN s ? 'join_spec' AND jsonb_typeof(s->'join_spec') <> 'null'
           THEN s->'join_spec' ELSE NULL END,
      COALESCE(NULLIF(s->>'ordinal', '')::INT, 0)
    FROM jsonb_array_elements(p_sources) AS s;
  END IF;

  RETURN v_tfm_id;
END;
$$;

COMMENT ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID) IS
  'Atomically creates a target_field_mapping with its mapping_sources children. '
  'Used by the redesigned mapping server actions (Phase 3+). The optional '
  'p_experiment_run_id parameter (default NULL) tags the TFM with the '
  'INF-22 experiment run; manual / suggest flows omit it and write NULL.';

GRANT EXECUTE ON FUNCTION public.dq_create_target_field_mapping(UUID, UUID, JSONB, JSONB, UUID)
  TO authenticated, service_role;

-- ── 3. mapping_experiment_results view (direct JOIN) ──────────────────
--
-- The Phase A view (migration 091) groups by metadata.experiment_run_id
-- and is a per-llm_call surface. This view goes the other direction:
-- per-TFM, with the producing llm_calls row joined on experiment_run_id.
-- An analyst comparing Path B and Path C uses both:
--   - mapping_experiments       — cost / latency / tokens per call
--   - mapping_experiment_results — TFM accuracy / confidence per run
--
-- The view is intentionally lossy: it surfaces only TFMs tagged with an
-- experiment_run_id (i.e. produced by a mapping_generate click since
-- INF-22), and joins to the FIRST llm_calls row for that run (Path B
-- has one row per per-table batch; Path C has Pass 1 + Pass 2 — joining
-- to either is fine for accuracy/confidence aggregation since the run
-- label is the same on both).

CREATE OR REPLACE VIEW public.mapping_experiment_results AS
SELECT
  tfm.id                                        AS tfm_id,
  tfm.project_id,
  tfm.target_field_id,
  tfm.confidence,
  tfm.status,
  tfm.combination_type,
  tfm.created_at                                AS tfm_created_at,
  tfm.experiment_run_id,
  -- Pull experiment_label off the FIRST llm_calls row tagged with the
  -- same experiment_run_id. Path B has one label per run; Path C has
  -- two rows (path_c_pass_1 + path_c_pass_2) — we surface Pass 2's
  -- label since it's the call that produced the TFM (Pass 1 is
  -- free-text reasoning that doesn't emit tool input).
  (
    SELECT c.metadata ->> 'experiment_label'
      FROM public.llm_calls c
     WHERE (c.metadata ->> 'experiment_run_id')::uuid = tfm.experiment_run_id
       AND COALESCE(c.metadata ->> 'experiment_label', '') <> 'path_c_pass_1'
     ORDER BY c.created_at ASC
     LIMIT 1
  )                                             AS experiment_label,
  (
    SELECT COUNT(*)::int
      FROM public.llm_calls c
     WHERE (c.metadata ->> 'experiment_run_id')::uuid = tfm.experiment_run_id
  )                                             AS llm_call_count
FROM public.target_field_mappings tfm
WHERE tfm.experiment_run_id IS NOT NULL;

COMMENT ON VIEW public.mapping_experiment_results IS
  'INF-22 Phase B — per-TFM surface joined to its producing experiment '
  'run. Direct JOIN replaces the timestamp-window TFM attribution '
  'heuristic. Group by (project_id, experiment_run_id, experiment_label) '
  'for per-run accuracy / confidence aggregates; pair with the '
  'mapping_experiments view (per-llm_call) for cost / latency.';
