-- 084_index_parent_call_id_on_llm_calls.sql
-- Phase 3.2 (PR 3.2) — Partial btree index on llm_calls.parent_call_id.
--
-- The parent_call_id column ALREADY EXISTS in public.llm_calls — declared
-- in 082_llm_calls.sql:75-76 as a self-FK with ON DELETE SET NULL,
-- populated today by repair-retry chains (mapping_generate_repair,
-- mapping_generate_legacy_pair_repair, nl_to_sql_retry,
-- outputs_execution_package_fallback). PR 3.2's agent-loop primitive
-- chains its per-iteration llm_calls rows through the SAME column.
--
-- Postgres does NOT auto-create indexes for FK columns. The partial
-- predicate (WHERE parent_call_id IS NOT NULL) matches usage: the vast
-- majority of rows are heads-of-chain (NULL parent_call_id); only the
-- continuation rows need indexing. Retroactively benefits both the new
-- agent-loop chain-walking AND the existing repair-retry queries.
--
-- Perf-only addition; no behavior change. Idempotent via IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_llm_calls_parent_call_id
  ON public.llm_calls(parent_call_id)
  WHERE parent_call_id IS NOT NULL;

COMMENT ON INDEX public.idx_llm_calls_parent_call_id IS
  'Partial btree index for chain-walking queries (PR 3.2 agent loops + existing repair-retry chains).';
