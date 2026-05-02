-- 082_llm_calls.sql — Phase 0b observability table
--
-- Logs every Anthropic API call made via the unified callLLM wrapper
-- in lib/ai/llm-client.ts. Foundation for: daily cost report, eval
-- harness replay, retry-chain diagnostics, Phase 0c edit-history
-- correlation.
--
-- Retention policy: NONE in Phase 0b. Full system_prompt + user_message
-- + response_text stored verbatim for eval harness use. Revisit at
-- ~10M rows or when SOC 2 review introduces retention requirements.

CREATE TABLE IF NOT EXISTS public.llm_calls (
  id                            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Tenant scoping (required: every production callsite has both)
  project_id                    UUID         NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id                       UUID         NOT NULL REFERENCES auth.users(id),

  -- Feature taxonomy (validated in app code via TS LLMFeature union;
  -- TEXT not ENUM so adding a feature does not require a migration)
  feature                       TEXT         NOT NULL,
  prompt_version                TEXT,

  -- Request shape
  model                         TEXT         NOT NULL,
  is_streaming                  BOOLEAN      NOT NULL DEFAULT FALSE,
  max_tokens                    INT          NOT NULL,

  -- Prompt + response (full text — see retention note above)
  system_prompt                 TEXT         NOT NULL,
  user_message                  TEXT         NOT NULL,
  response_text                 TEXT,
  system_prompt_hash            VARCHAR(16)  NOT NULL,
  user_message_hash             VARCHAR(16)  NOT NULL,

  -- Anthropic metadata
  anthropic_request_id          TEXT,
  stop_reason                   TEXT,

  -- Tokens (nullable: NULL on errors before completion)
  input_tokens                  INT,
  output_tokens                 INT,
  cache_read_tokens             INT,
  cache_creation_tokens         INT,

  -- Latency + cost
  latency_ms                    INT          NOT NULL,
  cost_usd                      NUMERIC(10,6),

  -- Outcome
  succeeded                     BOOLEAN      NOT NULL,
  error_type                    TEXT,
  error_message                 TEXT,

  -- Retry / agent grouping
  parent_call_id                UUID         REFERENCES public.llm_calls(id) ON DELETE SET NULL,

  -- Anthropic abuse-signal correlation (pass-through to API metadata.user_id)
  abuse_user_id                 TEXT,

  -- Free-form context (prompt-specific keys: target_field_id, source_table_id, batch_index, ...)
  metadata                      JSONB        NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_llm_calls_project_time
  ON public.llm_calls(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_user_time
  ON public.llm_calls(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_feature_time
  ON public.llm_calls(feature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_parent_call_id
  ON public.llm_calls(parent_call_id) WHERE parent_call_id IS NOT NULL;

-- RLS
ALTER TABLE public.llm_calls ENABLE ROW LEVEL SECURITY;

-- Project members can read calls on their projects.
-- Mirrors query_history RLS pattern (053_query_history.sql:22-23).
CREATE POLICY "llm_calls_select_project_members"
  ON public.llm_calls FOR SELECT
  USING (public.user_can_access_project(project_id));

-- INSERT/UPDATE/DELETE: service_role only (the wrapper uses supabaseAdmin).
-- No authenticated-user write policies; service_role bypasses RLS by design.

-- Column comments
COMMENT ON TABLE public.llm_calls IS
  'Every Anthropic API call made via lib/ai/llm-client.ts callLLM/callLLMStreaming wrapper. Phase 0b.';

COMMENT ON COLUMN public.llm_calls.feature IS
  'Locked enum (TS union LLMFeature in lib/ai/llm-client.ts). TEXT not ENUM so adding a feature does not require a migration.';

COMMENT ON COLUMN public.llm_calls.parent_call_id IS
  'Self-FK for retry/fallback chains. mapping_generate_repair calls reference their parent mapping_generate.';

COMMENT ON COLUMN public.llm_calls.system_prompt IS
  'Full system prompt verbatim. No retention policy in Phase 0b. Phase 0c will introduce PII redaction for thinking blocks (separate table); system_prompt is template content rarely containing PII.';

COMMENT ON COLUMN public.llm_calls.cost_usd IS
  'Computed at log time via lib/ai/pricing.ts:computeCostUsd. NULL if model is missing from PRICING table or if tokens are NULL.';

COMMENT ON COLUMN public.llm_calls.latency_ms IS
  'Wall-clock from before Anthropic call to after text-block extraction. Captured even on errors as time-to-error.';

COMMENT ON COLUMN public.llm_calls.error_type IS
  'Locked vocabulary: auth_401, rate_limit_429, sdk_network, timeout, parse_no_text_block, other. NULL when succeeded=true.';

COMMENT ON COLUMN public.llm_calls.abuse_user_id IS
  'Pass-through value for Anthropic API metadata.user_id (abuse correlation). Typically the Supabase user.id; not PII.';
