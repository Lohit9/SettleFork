-- Add schema_source to track whether a field's metadata was inferred from data,
-- enriched by comparing against uploaded schema documents, or manually edited.
ALTER TABLE fields
  ADD COLUMN IF NOT EXISTS schema_source TEXT NOT NULL DEFAULT 'inferred'
    CHECK (schema_source IN ('inferred', 'doc_enriched', 'manual'));
