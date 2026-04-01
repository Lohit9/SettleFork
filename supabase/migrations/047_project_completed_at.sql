-- Track when a project entered "completed" state for the 90-day auto-archive timer
ALTER TABLE projects ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN archived_at TIMESTAMPTZ;

-- Backfill: if any projects are already "completed", set completed_at to updated_at
UPDATE projects SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL;
UPDATE projects SET archived_at = updated_at WHERE status = 'archived' AND archived_at IS NULL;
