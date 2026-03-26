-- ============================================================
-- Migration 031: Dedicated activity log table
--
-- Replaces the ad-hoc 5-query log assembly in getOutputsPageData
-- with a single append-only table. Every meaningful user action
-- writes one row via logActivity() in lib/actions/activity-log.ts.
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL,
  action_type  TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  -- Broad category used for dot-colour in the UI
  category     TEXT        NOT NULL DEFAULT 'action',
  -- Structured context for deep-linking / future detail views
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast project-scoped time-descending reads
CREATE INDEX IF NOT EXISTS idx_activity_log_project_time
  ON activity_log(project_id, created_at DESC);

-- RLS: owners can read their own project logs; server-side writes use service role
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_log_select_own"
  ON activity_log FOR SELECT
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- ============================================================
-- Backfill from existing data
-- (Run after table creation so the log has history immediately)
-- ============================================================

-- Fix applications (status = applied, excludes reverts)
INSERT INTO activity_log
  (project_id, user_id, action_type, description, category, metadata, created_at)
SELECT
  fh.project_id,
  COALESCE(fh.applied_by::uuid, (SELECT user_id FROM projects WHERE id = fh.project_id)),
  'fix_applied',
  'Fix applied: ' || fh.fix_description || ' — ' || fh.affected_row_count || ' record' ||
    CASE WHEN fh.affected_row_count = 1 THEN '' ELSE 's' END,
  'fix',
  jsonb_build_object(
    'fix_history_id',    fh.id,
    'quality_issue_id',  fh.quality_issue_id,
    'affected_rows',     fh.affected_row_count
  ),
  fh.applied_at
FROM fix_history fh
WHERE fh.project_id IS NOT NULL
  AND fh.status = 'applied'
  AND fh.fix_sql != '-- Risk accepted, no SQL executed'
ON CONFLICT DO NOTHING;

-- Reverted fixes
INSERT INTO activity_log
  (project_id, user_id, action_type, description, category, metadata, created_at)
SELECT
  fh.project_id,
  COALESCE(fh.applied_by::uuid, (SELECT user_id FROM projects WHERE id = fh.project_id)),
  'fix_reverted',
  'Fix reverted: ' || fh.fix_description,
  'fix',
  jsonb_build_object(
    'fix_history_id',   fh.id,
    'quality_issue_id', fh.quality_issue_id
  ),
  COALESCE(fh.reverted_at, fh.applied_at)
FROM fix_history fh
WHERE fh.project_id IS NOT NULL
  AND fh.status = 'reverted'
  AND fh.fix_sql != '-- Risk accepted, no SQL executed'
ON CONFLICT DO NOTHING;

-- Risk accepted
INSERT INTO activity_log
  (project_id, user_id, action_type, description, category, metadata, created_at)
SELECT
  qi.project_id,
  (SELECT user_id FROM projects WHERE id = qi.project_id),
  'risk_accepted',
  'Risk accepted: ' || qi.title,
  'validation',
  jsonb_build_object('quality_issue_id', qi.id),
  qi.created_at
FROM quality_issues qi
WHERE qi.status = 'accepted_risk'
ON CONFLICT DO NOTHING;

-- Validation rules added
INSERT INTO activity_log
  (project_id, user_id, action_type, description, category, metadata, created_at)
SELECT
  vr.project_id,
  (SELECT user_id FROM projects WHERE id = vr.project_id),
  'rule_added',
  'Validation rule added: ' || vr.name,
  'validation',
  jsonb_build_object(
    'validation_rule_id', vr.id,
    'rule_type',          vr.rule_type
  ),
  vr.created_at
FROM validation_rules vr
ON CONFLICT DO NOTHING;

-- Approved mappings (best-effort; created_at approximates approval time)
INSERT INTO activity_log
  (project_id, user_id, action_type, description, category, metadata, created_at)
SELECT
  tm.project_id,
  (SELECT user_id FROM projects WHERE id = tm.project_id),
  'mapping_approved',
  'Mapping approved: ' || sf.name || ' → ' || tf.name ||
    CASE WHEN fm.confidence IS NOT NULL
         THEN ' (' || round(fm.confidence) || '% confidence)'
         ELSE '' END,
  'mapping',
  jsonb_build_object(
    'field_mapping_id', fm.id,
    'source_field',     sf.name,
    'target_field',     tf.name,
    'confidence',       fm.confidence
  ),
  fm.created_at
FROM field_mappings fm
JOIN table_mappings tm ON fm.table_mapping_id = tm.id
JOIN fields sf          ON fm.source_field_id  = sf.id
JOIN fields tf          ON fm.target_field_id  = tf.id
WHERE fm.status = 'approved'
ON CONFLICT DO NOTHING;
