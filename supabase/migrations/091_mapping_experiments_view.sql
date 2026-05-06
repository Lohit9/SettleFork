-- Migration 091: mapping_experiments view for INF-22 Path B vs Path C
-- side-by-side comparison.
--
-- INF-22 (May 2026) ships an experimental two-pass mapping pipeline
-- (Path C) gated behind `AI_MAPPING_TWO_PASS_ENABLED='1'`. Production
-- stays on Path B (PR #81 + HOT-FIX 6 architecture). This view groups
-- llm_calls rows by `metadata.experiment_run_id` (one UUID per
-- "Generate Mappings" click) so an analyst can run:
--
--   SELECT * FROM mapping_experiments
--    WHERE project_id = '894eeb8e-...'
--    ORDER BY experiment_run_id, experiment_label;
--
-- and see a flat row per call with the fields needed for an A/B
-- accuracy + cost + latency comparison.
--
-- Design choices:
--   - View, not table. Source of truth stays on llm_calls; rebuilding
--     the metric set after schema changes is a `CREATE OR REPLACE
--     VIEW` rather than a backfill. Cheap reads on small data.
--   - Reads metadata from JSONB via `->>` so a future tag is a
--     non-migration change to the writer (lib/ai/two-pass-experiment.ts).
--   - SECURITY INVOKER (Postgres view default). Falls back to
--     llm_calls RLS — analyst SQL must run as service_role or via
--     the `mapping_experiments_for_user` route below if we ever need
--     non-admin access. For INF-22 the comparison runs as service
--     role from psql / Supabase Studio.
--   - `experiment_label` is text (not enum) so adding `path_d_*` for
--     a future variant is a writer-side change with no migration.
--
-- Joins: the view is intentionally llm_calls-only. Mapping the
-- emitted target_field_mappings back to a single `experiment_run_id`
-- requires propagating that ID into TFM metadata too — that's
-- follow-up work (INF-22 Phase B). For Phase A (this migration), the
-- comparison is per-llm-call: Path B is one row per per-table batch
-- + one row per per-pair regen call; Path C is two rows per call
-- (Pass 1 + Pass 2). Aggregation across rows gives the per-run
-- mean confidence / cost / latency.

CREATE OR REPLACE VIEW public.mapping_experiments AS
SELECT
  c.id                                                    AS llm_call_id,
  c.project_id,
  c.user_id,
  c.feature,
  c.prompt_version,
  c.model,
  c.created_at,
  -- Experiment metadata (NULL on legacy llm_calls rows from before
  -- INF-22 — the WHERE clause below filters them out).
  (c.metadata ->> 'experiment_run_id')                    AS experiment_run_id,
  (c.metadata ->> 'experiment_label')                     AS experiment_label,
  (c.metadata ->> 'pass')                                 AS experiment_pass,
  -- Per-batch identifiers (BULK callsite only — single-pair has
  -- table_mapping_id instead; the view emits NULL for whichever
  -- shape is absent).
  (c.metadata ->> 'source_table_id')                      AS source_table_id,
  (c.metadata ->> 'target_table_id')                      AS target_table_id,
  (c.metadata ->> 'table_mapping_id')                     AS table_mapping_id,
  (c.metadata ->> 'source_table_name')                    AS source_table_name,
  ((c.metadata ->> 'batch_index')::int)                   AS batch_index,
  ((c.metadata ->> 'batch_total')::int)                   AS batch_total,
  -- LLM telemetry (token counts + cost + latency).
  c.input_tokens,
  c.output_tokens,
  c.cache_read_tokens,
  c.cache_creation_tokens,
  c.cost_usd,
  c.latency_ms,
  c.is_streaming,
  c.succeeded,
  c.error_type,
  c.error_message,
  c.stop_reason,
  -- Tool / response payload — for Path B / Pass 2 this is the
  -- emit_table_mappings tool input as JSON; for Path C Pass 1 this
  -- is the free-text reasoning. Truncated at 64K to keep view
  -- selects cheap; analyst SQL that needs the full payload joins
  -- llm_calls.response_text directly.
  LEFT(c.response_text, 65536)                            AS response_preview
FROM public.llm_calls c
WHERE
  -- Surface only mapping_generate-family rows. Keeps the view tight
  -- and prevents accidental cross-feature comparison from a
  -- malformed analyst query.
  c.feature IN (
    'mapping_generate',
    'mapping_generate_legacy_pair',
    'eval_mapping'
  )
  -- Surface only rows tagged with experiment metadata. Legacy rows
  -- from before INF-22 lack `experiment_run_id` and are excluded.
  AND c.metadata ->> 'experiment_run_id' IS NOT NULL;

COMMENT ON VIEW public.mapping_experiments IS
  'INF-22 Path B vs Path C comparison surface. One row per llm_calls '
  'entry that carries experiment metadata. Path B emits one row per '
  'per-table batch / per-pair regen; Path C emits two rows per call '
  '(Pass 1 reasoning + Pass 2 extraction) sharing one experiment_run_id. '
  'Group by (project_id, experiment_run_id, experiment_label) for a '
  'per-run metric aggregate.';

-- Index hint: the WHERE clause above filters by `feature` (already
-- indexed via idx_llm_calls_feature_time per migration 082) and
-- `metadata ->> 'experiment_run_id'`. The metadata path is NOT
-- indexed today; for the volume INF-22 produces (~5-50 rows per
-- comparison run, ~1-5 runs per project) sequential scan is faster
-- than building a JSONB GIN index. Revisit if the experiment scales.
