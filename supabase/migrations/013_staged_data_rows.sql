-- ============================================================
-- Staging Data Layer
-- Stores transformed copies of source rows for validation.
-- source_row_data  = original JSONB from data_rows
-- transformed_row_data = target-format JSONB with transforms applied
-- ============================================================

CREATE TABLE IF NOT EXISTS staged_data_rows (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_mapping_id      UUID REFERENCES table_mappings(id)  ON DELETE CASCADE NOT NULL,
  source_table_id       UUID REFERENCES tables(id)          ON DELETE CASCADE NOT NULL,
  target_table_id       UUID REFERENCES tables(id)          ON DELETE CASCADE NOT NULL,
  row_number            INT NOT NULL,
  source_row_data       JSONB NOT NULL,
  transformed_row_data  JSONB NOT NULL,
  staged_at             TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE staged_data_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own staged data"
  ON staged_data_rows FOR ALL
  USING (
    table_mapping_id IN (
      SELECT tm.id FROM table_mappings tm
      JOIN projects p ON tm.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_staged_data_mapping
  ON staged_data_rows(table_mapping_id);
CREATE INDEX IF NOT EXISTS idx_staged_data_source
  ON staged_data_rows(source_table_id);
CREATE INDEX IF NOT EXISTS idx_staged_data_target
  ON staged_data_rows(target_table_id);
CREATE INDEX IF NOT EXISTS idx_staged_data_mapping_rownum
  ON staged_data_rows(table_mapping_id, row_number);

-- ── RPC: generate staged data for one table mapping ─────────────────────────
-- Accepts a SELECT that returns (rn INT, src JSONB, tgt JSONB), deletes
-- existing staged rows, then inserts fresh results in one DB round-trip.

CREATE OR REPLACE FUNCTION generate_staged_data_for_mapping(
  p_table_mapping_id  UUID,
  p_source_table_id   UUID,
  p_target_table_id   UUID,
  p_select_sql        TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
SET work_mem          = '64MB'
AS $$
DECLARE
  v_count INT;
  v_clean TEXT;
BEGIN
  v_clean := lower(trim(p_select_sql));

  IF NOT (v_clean LIKE 'select%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  IF v_clean ~ '\m(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|exec)\M' THEN
    RAISE EXCEPTION 'Query contains forbidden data-modification keywords';
  END IF;

  IF v_clean ~ '\m(pg_catalog|information_schema|pg_roles|pg_shadow|pg_authid|auth\.users)\M' THEN
    RAISE EXCEPTION 'System catalog access is not allowed';
  END IF;

  -- Fresh staging: remove previous results for this mapping
  DELETE FROM staged_data_rows WHERE table_mapping_id = p_table_mapping_id;

  -- Insert transformed rows in one INSERT INTO … SELECT
  EXECUTE format(
    'INSERT INTO staged_data_rows
       (table_mapping_id, source_table_id, target_table_id, row_number, source_row_data, transformed_row_data)
     SELECT %L::uuid, %L::uuid, %L::uuid, s.rn, s.src, s.tgt
     FROM (%s) AS s(rn, src, tgt)',
    p_table_mapping_id,
    p_source_table_id,
    p_target_table_id,
    p_select_sql
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION generate_staged_data_for_mapping(UUID, UUID, UUID, TEXT)
  TO authenticated, service_role;

-- ── RPCs for in-flight validation against staged data ────────────────────────

CREATE OR REPLACE FUNCTION dq_staged_null_count(p_mapping_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*) FROM staged_data_rows
  WHERE table_mapping_id = p_mapping_id
    AND (transformed_row_data->>p_field IS NULL
         OR transformed_row_data->>p_field = '')
$$;

CREATE OR REPLACE FUNCTION dq_staged_length_exceeded(
  p_mapping_id UUID, p_field TEXT, p_max INT
)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*) FROM staged_data_rows
  WHERE table_mapping_id = p_mapping_id
    AND length(transformed_row_data->>p_field) > p_max
$$;

CREATE OR REPLACE FUNCTION dq_staged_length_exceeded_samples(
  p_mapping_id UUID, p_field TEXT, p_max INT, p_limit INT DEFAULT 5
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(jsonb_agg(transformed_row_data), '[]')
  FROM (
    SELECT transformed_row_data
    FROM staged_data_rows
    WHERE table_mapping_id = p_mapping_id
      AND length(transformed_row_data->>p_field) > p_max
    LIMIT p_limit
  ) t
$$;

CREATE OR REPLACE FUNCTION dq_staged_mixed_case_count(p_mapping_id UUID, p_field TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*) FROM staged_data_rows
  WHERE table_mapping_id = p_mapping_id
    AND transformed_row_data->>p_field ~ '[a-z]'
$$;

GRANT EXECUTE ON FUNCTION dq_staged_null_count(UUID, TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION dq_staged_length_exceeded(UUID, TEXT, INT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION dq_staged_length_exceeded_samples(UUID, TEXT, INT, INT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION dq_staged_mixed_case_count(UUID, TEXT)
  TO authenticated, service_role;
