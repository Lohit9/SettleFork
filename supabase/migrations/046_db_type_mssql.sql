-- Extend db_type CHECK constraint to include MS SQL Server
ALTER TABLE db_connections DROP CONSTRAINT IF EXISTS db_connections_db_type_check;
ALTER TABLE db_connections ADD CONSTRAINT db_connections_db_type_check
  CHECK (db_type IN ('postgresql', 'mysql', 'mssql'));
