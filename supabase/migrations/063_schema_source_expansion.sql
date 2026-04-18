-- Migration 063: Expand schema_source CHECK to support additional provenance labels.
--
-- Adds two new allowed values so the write paths can honestly label where field
-- metadata came from, instead of lumping everything that isn't doc_enriched or
-- manual into 'inferred':
--   - 'ddl_parsed'            → parsed from an uploaded DDL script or a live DB
--                                introspection (information_schema.*). Structural
--                                authority is high; the metadata came from an
--                                authoritative source, not from sampling CSV values.
--   - 'cross_table_inferred'  → derived by the cross-table FK inference engine
--                                (value-overlap matching between a candidate FK
--                                column and a PK in another table).
--
-- Safe on existing data: the old default 'inferred' remains valid, so pre-migration
-- rows keep their labels unchanged.

ALTER TABLE fields DROP CONSTRAINT IF EXISTS fields_schema_source_check;

ALTER TABLE fields ADD CONSTRAINT fields_schema_source_check
  CHECK (schema_source IN ('inferred', 'ddl_parsed', 'cross_table_inferred', 'doc_enriched', 'manual'));

-- Retroactive best-effort relabel of fields that were clearly DDL-sourced.
-- Only DDL upload populates check_constraint today (the DB connector also writes it,
-- but as an untyped { raw } blob — still originates from authoritative introspection,
-- so the label applies to both). We scope to rows still marked 'inferred' to avoid
-- clobbering anything a user has since manually edited or AI-enriched.
UPDATE fields
   SET schema_source = 'ddl_parsed'
 WHERE schema_source = 'inferred'
   AND check_constraint IS NOT NULL;

-- Note: CSV-uploaded fields and DDL-uploaded fields without any CHECK constraint
-- remain labeled 'inferred'. Subsequent code changes (Part B of this feature set
-- and follow-up prompts) will label new inserts correctly at write time.
