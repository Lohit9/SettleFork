-- Value Assignments: allow field_mappings with NULL source_field_id
-- These represent target fields that receive a constant, expression, or derived value
-- with no source field (e.g., org_type_cd = 'FIRM', matter_number = 'TC-' || sequence)

ALTER TABLE field_mappings ALTER COLUMN source_field_id DROP NOT NULL;

COMMENT ON COLUMN field_mappings.source_field_id IS
  'NULL for value assignments — target fields that receive a constant or computed value with no source field';
