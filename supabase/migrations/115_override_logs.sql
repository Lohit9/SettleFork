-- Migration 115 — override_logs (template flywheel signal)
-- ============================================================================
-- Records every instance where a human approves or overrides a template-
-- suggested mapping. The aggregate signal (reuse_count / override_count) lives
-- on template_entries; this table is the raw event log.
--
-- Rows are written fire-and-forget at TFM approval time. If no template existed
-- for the project's system pair, no row is written (snapshotTemplate handles
-- new template creation separately).

CREATE TABLE public.override_logs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scoping
  org_id                UUID        NOT NULL REFERENCES public.organizations(id)     ON DELETE CASCADE,
  project_id            UUID        NOT NULL REFERENCES public.projects(id)          ON DELETE CASCADE,

  -- Template linkage (null if the template entry was deleted after the fact)
  template_entry_id     UUID        REFERENCES public.template_entries(id)           ON DELETE SET NULL,

  -- What field was being mapped (target)
  target_sig            JSONB       NOT NULL,

  -- What the template / AI proposed
  suggested_source_sig  JSONB,
  suggested_transform_sql TEXT,

  -- What the human approved (null = accepted suggestion as-is)
  human_source_sig      JSONB,
  human_transform_sql   TEXT,

  -- 'accepted' = human kept template suggestion; 'overridden' = human changed it
  outcome               TEXT        NOT NULL CHECK (outcome IN ('accepted', 'overridden')),

  -- Label quality signals — used to weight this row as a training signal.
  -- time_on_task_ms: null when approval came from a batch action (approve-all).
  -- was_edited: true means the human changed source or transform before approving — strongest quality signal.
  -- approval_method: how the approval was triggered; batch approvals are down-weighted.
  time_on_task_ms       INTEGER,
  was_edited            BOOLEAN     NOT NULL DEFAULT false,
  approval_method       TEXT        CHECK (approval_method IN ('individual', 'approve_all', 'approve_high_confidence')),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.override_logs IS
  'Raw event log of human accept/override decisions on template-suggested mappings. '
  'Aggregate counters live on template_entries; this table provides audit trail and '
  'future training signal.';

ALTER TABLE public.override_logs ENABLE ROW LEVEL SECURITY;

-- Org members can read their own override history
CREATE POLICY "org_members_can_view_override_logs" ON public.override_logs
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
  );

-- Writes go through the service-role action, not the client
-- (no INSERT/UPDATE policies — supabaseAdmin bypasses RLS)

-- ─── Indexes ───────────────────────────────────────────────────────────

CREATE INDEX idx_override_logs_project   ON public.override_logs (project_id);
CREATE INDEX idx_override_logs_org       ON public.override_logs (org_id);
CREATE INDEX idx_override_logs_entry     ON public.override_logs (template_entry_id)
  WHERE template_entry_id IS NOT NULL;
