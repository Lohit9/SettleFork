-- warnings:
-- (none)

-- target field names (order):
-- t_customer_id, t_full_name, t_email_norm, t_tenant_id

SELECT (row_data->>'s_id')::integer AS "t_customer_id", ((row_data->>'s_first_name') || ' ' || (row_data->>'s_last_name')) AS "t_full_name", lower(row_data->>'s_email') AS "t_email_norm", '00000000-0000-0000-0000-000000000001'::uuid AS "t_tenant_id" FROM data_rows WHERE table_id = 'tbl-s-cust-0001' ORDER BY row_number
