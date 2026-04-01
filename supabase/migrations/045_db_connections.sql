-- Database connections: stores encrypted credentials for live DB introspection
-- One connection per dataset (UNIQUE constraint on dataset_id)

CREATE TABLE db_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  dataset_id UUID REFERENCES datasets(id) ON DELETE CASCADE NOT NULL,
  db_type TEXT NOT NULL DEFAULT 'postgresql',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 5432,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  ssl_mode TEXT DEFAULT 'require',
  status TEXT DEFAULT 'connected',
  last_connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  CHECK (db_type IN ('postgresql', 'mysql')),
  CHECK (ssl_mode IN ('disable', 'require', 'verify-ca', 'verify-full')),
  CHECK (status IN ('connected', 'failed', 'disconnected')),
  UNIQUE(dataset_id)
);

ALTER TABLE db_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own db connections"
  ON db_connections FOR ALL
  USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

CREATE INDEX idx_db_connections_dataset ON db_connections(dataset_id);
CREATE INDEX idx_db_connections_project ON db_connections(project_id);
