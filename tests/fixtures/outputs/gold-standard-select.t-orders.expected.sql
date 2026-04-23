-- warnings:
-- (none)

-- target field names (order):
-- t_order_id, t_customer_fk, t_amount_dollars

SELECT (row_data->>'so_id')::integer AS "t_order_id", (row_data->>'so_customer_id')::integer AS "t_customer_fk", ((row_data->>'so_total_cents')::numeric / 100) AS "t_amount_dollars" FROM data_rows WHERE table_id = 'tbl-s-ord-0001' ORDER BY row_number
