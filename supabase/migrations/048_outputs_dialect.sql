-- Migration 048: Add dialect column to outputs table
-- Stores the SQL dialect used when generating the execution package.
ALTER TABLE outputs ADD COLUMN dialect TEXT DEFAULT 'postgresql';
