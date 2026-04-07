-- Clean up any existing duplicates: keep the newest row per (dataset_id, filename)
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY dataset_id, filename
           ORDER BY created_at DESC
         ) AS rn
  FROM schema_documents
  WHERE dataset_id IS NOT NULL
)
DELETE FROM schema_documents
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Add unique constraint to prevent future duplicates at the database level.
-- Using a partial unique index on dataset_id IS NOT NULL so business_context docs
-- (which have dataset_id = NULL and project_id set) are not affected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_schema_documents_dataset_filename
  ON schema_documents (dataset_id, filename)
  WHERE dataset_id IS NOT NULL;
