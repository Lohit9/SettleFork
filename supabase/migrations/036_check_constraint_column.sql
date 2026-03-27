-- Migration 036: Add check_constraint column to fields table
-- Stores parsed CHECK constraint data extracted from DDL uploads.
-- Safe to run on existing projects — nullable JSONB with DEFAULT NULL.

ALTER TABLE fields
ADD COLUMN IF NOT EXISTS check_constraint JSONB DEFAULT NULL;

COMMENT ON COLUMN fields.check_constraint IS
'Parsed CHECK constraint from DDL upload. Shapes:
  in_list: {"type":"in_list","allowedValues":["A","B"],"raw":"..."}
  regex:   {"type":"regex","pattern":"^[A-Z]{2}$","raw":"..."}
  range:   {"type":"range","min":0,"max":24,"raw":"..."}
  custom:  {"type":"custom","raw":"original text"}
NULL for source fields or fields with no CHECK constraint.';
