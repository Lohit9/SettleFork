-- Add extracted_text column to schema_documents
-- This stores text content parsed from PDF/SQL/DDL/TXT files
-- Used as context for Claude API calls in later phases (mapping, transforms)
ALTER TABLE schema_documents
  ADD COLUMN IF NOT EXISTS extracted_text TEXT;
