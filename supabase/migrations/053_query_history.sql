-- Query history: persist every NL and SQL query execution per project/user
CREATE TABLE public.query_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode VARCHAR(10) NOT NULL CHECK (mode IN ('nl', 'sql')),
  input TEXT NOT NULL,
  generated_sql TEXT,
  executed_sql TEXT,
  row_count INTEGER,
  execution_time_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_query_history_project ON public.query_history(project_id, created_at DESC);
CREATE INDEX idx_query_history_user ON public.query_history(user_id);

ALTER TABLE public.query_history ENABLE ROW LEVEL SECURITY;

-- Any project member can read their project's history
CREATE POLICY "users_can_view_project_query_history" ON public.query_history FOR SELECT
  USING (public.user_can_access_project(project_id));

-- Any project member (viewer+) can insert their own history rows
CREATE POLICY "users_can_insert_query_history" ON public.query_history FOR INSERT
  WITH CHECK (public.user_has_project_role(project_id, 'viewer') AND user_id = auth.uid());

-- Users can only delete their own history rows
CREATE POLICY "users_can_delete_own_history" ON public.query_history FOR DELETE
  USING (user_id = auth.uid());
