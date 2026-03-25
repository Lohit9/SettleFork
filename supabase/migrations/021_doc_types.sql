-- Distinguish schema documents (structural DDL/ERD/data-dict) from business
-- context documents (migration rules, value mappings, requirements).
-- Schema docs are dataset-scoped; business context docs are project-scoped.

ALTER TABLE schema_documents
  ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'schema'
    CHECK (doc_type IN ('schema', 'business_context')),
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

-- Back-fill: all existing rows are schema docs, leave project_id null.
-- (dataset_id is already populated for them.)
UPDATE schema_documents SET doc_type = 'schema' WHERE doc_type IS NULL;
