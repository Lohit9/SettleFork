-- Migration 010: Server-side snapshot RPC to avoid PostgREST's 1,000-row response limit.
--
-- Problem: dq_snapshot_for_fix returns TABLE(...), so PostgREST caps the result at
-- ~1,000 rows before returning it to the JavaScript client. The client then inserts
-- only 1,000 snapshots even when a fix affects tens of thousands of rows. This means
-- revert only restores 1,000 rows, silently leaving the rest permanently changed.
--
-- Fix: dq_snapshot_rows performs the INSERT INTO fix_snapshots ... SELECT directly
-- inside PostgreSQL. Only a BIGINT count is returned through PostgREST — no row limit
-- applies. All affected rows are snapshotted regardless of dataset size.

CREATE OR REPLACE FUNCTION dq_snapshot_rows(
  p_fix_history_id UUID,
  p_where_clause   TEXT,
  p_table_id       UUID
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  -- WHERE clause must include the specific table_id to prevent cross-table snapshots
  IF position(p_table_id::TEXT IN p_where_clause) = 0 THEN
    RAISE EXCEPTION 'WHERE clause must include table_id = ''%''', p_table_id;
  END IF;

  -- Block DML/DDL keywords inside the WHERE clause (injection guard)
  IF upper(p_where_clause) ~ '\y(UPDATE|DELETE|INSERT|DROP|ALTER|CREATE|TRUNCATE|EXECUTE)\y' THEN
    RAISE EXCEPTION 'WHERE clause cannot contain data modification statements';
  END IF;

  -- Snapshot all affected rows directly into fix_snapshots.
  -- Using EXECUTE format() with a positional bind parameter ($1) for the UUID
  -- so it is properly quoted; the WHERE clause has already been validated above.
  EXECUTE format(
    'INSERT INTO fix_snapshots(fix_history_id, row_id, row_number, old_row_data)
     SELECT $1, id, row_number, row_data
     FROM data_rows
     WHERE %s',
    p_where_clause
  ) USING p_fix_history_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
