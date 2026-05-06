-- Migration 090: Add `fields.description` column to backfill the
-- column that PR 3.4a (mapping-agent-adoption, Feb 2026) referenced
-- in `lib/ai/context-builder.ts:formatSchemaForPrompt` + the field
-- SELECT in `buildAIContext` but never created via migration.
--
-- The PR 3.4a investigation doc (docs/investigations/pr3.4-mapping-agent-adoption.md
-- §C.5 row "description") incorrectly checked NO under "needs new
-- migration?" because it assumed the column already existed.
-- Application code shipped the SELECT; the column never landed.
--
-- Symptom (Rootstock POC, May 2026): mapping_generate prompt showed
-- "0 fields" for fresh projects despite the rows existing in DB. The
-- silent root cause was:
--
--   { error: { code: '42703', message: 'column fields.description does
--              not exist' } }
--
-- which buildAIContext swallowed (only `data` was destructured) and
-- surfaced as `fields = []`. Defense-in-depth error logging shipped
-- with this same PR exposed the missing column.
--
-- Adding the column is additive and leaves legacy rows unchanged. NULL
-- means "no description recorded" (which is every existing row, since
-- nothing has ever written to this column).
--
-- This pairs with `default_value` (migration 064) — both fields exist
-- to surface DDL-derived metadata into the prompt for target-side
-- rendering. Where `default_value` carries the verbatim DEFAULT clause,
-- `description` carries the COMMENT ON COLUMN text (when DDL declared
-- one) or operator-supplied free text (PR-Q4 in INV-1's open
-- questions — UI editor not yet wired).

ALTER TABLE fields
  ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;

COMMENT ON COLUMN fields.description IS
  'Free-text description of the field — populated from DDL '
  'COMMENT ON COLUMN clauses by the DDL parser, or in the future '
  'directly via Schema Overview UI edits. Read by buildAIContext + '
  'rendered into the target_schema block. NULL means no description '
  'recorded.';
