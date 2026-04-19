-- Migration 064: Persist DEFAULT values extracted from DDL / information_schema.
--
-- The DDL parser (lib/parsers/ddl-parser.ts) has always captured the DEFAULT
-- clause on column definitions into ParsedField.defaultValue, and the live
-- DB connector (lib/actions/db-connector.ts) has always selected
-- information_schema.column_default. Neither write path has ever persisted
-- the value — so unmapped target fields that would auto-populate on INSERT
-- (e.g. `created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`, `status TEXT
-- DEFAULT 'active'`) are indistinguishable in the UI from unmapped fields
-- that really do need a source column.
--
-- Adding the column is additive and leaves legacy rows unchanged. NULL means
-- "no default declared" (or "we never knew"); any non-NULL string is the raw
-- default expression as it appeared in the DDL / information_schema (not
-- evaluated, not coerced — `'0.00'`, `CURRENT_TIMESTAMP`, `true`, etc.).

ALTER TABLE fields
  ADD COLUMN IF NOT EXISTS default_value TEXT DEFAULT NULL;

COMMENT ON COLUMN fields.default_value IS
  'Raw DEFAULT expression from DDL or information_schema.column_default '
  '(e.g. "CURRENT_TIMESTAMP", "0.00", "true", "''active''"). NULL means no '
  'default declared. Stored verbatim — not evaluated, not type-coerced.';
