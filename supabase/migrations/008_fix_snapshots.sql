-- Migration 008: Row-level snapshots for fully reversible fixes
-- Run this in the Supabase SQL Editor.

-- ── fix_snapshots table ───────────────────────────────────────────────────────
-- Stores a per-row snapshot of row_data BEFORE a fix is applied.
-- Enables full restoration of all affected rows on revert.

CREATE TABLE IF NOT EXISTS fix_snapshots (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  fix_history_id  UUID    NOT NULL REFERENCES fix_history(id) ON DELETE CASCADE,
  row_id          BIGINT  NOT NULL,   -- data_rows.id
  row_number      INT,                -- data_rows.row_number (needed for DELETE reverts)
  old_row_data    JSONB   NOT NULL
);

ALTER TABLE fix_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own fix snapshots"
  ON fix_snapshots FOR ALL
  USING (
    fix_history_id IN (
      SELECT fh.id FROM fix_history fh
      JOIN projects p ON fh.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_fix_snapshots_history ON fix_snapshots(fix_history_id);

-- ── RPC: capture affected rows before fix executes ───────────────────────────
-- Called with the WHERE clause of the fix SQL. Returns all matching rows so
-- they can be stored in fix_snapshots before the fix runs.
CREATE OR REPLACE FUNCTION dq_snapshot_for_fix(p_where_clause TEXT, p_table_id UUID)
RETURNS TABLE(row_id BIGINT, row_number INT, old_row_data JSONB)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- WHERE clause must include the specific table_id
  IF position(p_table_id::TEXT IN p_where_clause) = 0 THEN
    RAISE EXCEPTION 'WHERE clause must include table_id = ''%''', p_table_id;
  END IF;
  -- Block any attempted DML/DDL inside the WHERE clause
  IF upper(p_where_clause) ~ '\y(UPDATE|DELETE|INSERT|DROP|ALTER|CREATE|TRUNCATE|EXECUTE)\y' THEN
    RAISE EXCEPTION 'WHERE clause cannot contain data modification statements';
  END IF;
  RETURN QUERY EXECUTE
    'SELECT id, row_number, row_data FROM data_rows WHERE ' || p_where_clause;
END;
$$;

-- ── RPC: bulk-restore rows after UPDATE fix ───────────────────────────────────
-- Restores all snapshotted rows in a single UPDATE join — efficient even for
-- tens of thousands of rows.
CREATE OR REPLACE FUNCTION dq_revert_update_rows(p_fix_history_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE data_rows dr
  SET row_data = fs.old_row_data
  FROM fix_snapshots fs
  WHERE dr.id = fs.row_id
    AND fs.fix_history_id = p_fix_history_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── RPC: re-insert rows after DELETE fix ─────────────────────────────────────
-- Re-inserts all deleted rows from snapshots back into data_rows.
-- Row IDs are not preserved (new IDs are assigned), but row_number and
-- row_data are restored exactly.
CREATE OR REPLACE FUNCTION dq_revert_insert_rows(p_table_id UUID, p_fix_history_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INT;
BEGIN
  INSERT INTO data_rows(table_id, row_number, row_data)
  SELECT p_table_id, fs.row_number, fs.old_row_data
  FROM fix_snapshots fs
  WHERE fs.fix_history_id = p_fix_history_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── RPC: count rows matching a WHERE clause ───────────────────────────────────
-- Used by generateManualFix() and manual fix validation to estimate how many
-- rows will be affected before the fix executes.
CREATE OR REPLACE FUNCTION dq_count_for_fix(p_where_clause TEXT, p_table_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count BIGINT;
BEGIN
  IF position(p_table_id::TEXT IN p_where_clause) = 0 THEN
    RAISE EXCEPTION 'WHERE clause must include table_id = ''%''', p_table_id;
  END IF;
  IF upper(p_where_clause) ~ '\y(UPDATE|DELETE|INSERT|DROP|ALTER|CREATE|TRUNCATE|EXECUTE)\y' THEN
    RAISE EXCEPTION 'WHERE clause cannot contain data modification statements';
  END IF;
  EXECUTE 'SELECT COUNT(*) FROM data_rows WHERE ' || p_where_clause INTO v_count;
  RETURN v_count;
END;
$$;
