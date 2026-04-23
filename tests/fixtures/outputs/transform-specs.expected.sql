-- ============================================================
-- Settle — Transformation Specifications
-- Project: Fixture Project
-- Generated: <UTC_TIMESTAMP>
-- Total transforms: 7
-- ============================================================

-- Source: s_customers.s_id → Target: t_customers.t_customer_id
-- Description: Cast s_id to integer.
-- Status: ✓ Saved
(row_data->>'s_id')::integer

-- Source: s_customers.s_first_name → Target: t_customers.t_full_name
-- Description: Concatenate first and last name with a space.
-- Status: ○ Draft
((row_data->>'s_first_name') || ' ' || (row_data->>'s_last_name'))

-- Source: s_customers.s_email → Target: t_customers.t_email_norm
-- Description: Normalize email to lowercase.
-- Status: ○ Draft
lower(row_data->>'s_email')

-- Source: [Value Assignment] → Target: t_customers.t_tenant_id
-- Description: Hardcoded tenant UUID per deployment instance.
-- Status: ○ Draft
'00000000-0000-0000-0000-000000000001'::uuid

-- Source: s_orders.so_id → Target: t_orders.t_order_id
-- Description: Cast so_id to integer.
-- Status: ○ Draft
(row_data->>'so_id')::integer

-- Source: s_orders.so_customer_id → Target: t_orders.t_customer_fk
-- Description: Cast FK to integer.
-- Status: ○ Draft
(row_data->>'so_customer_id')::integer

-- Source: s_orders.so_total_cents → Target: t_orders.t_amount_dollars
-- Description: Convert cents to dollars by dividing by 100.
-- Status: ○ Draft
((row_data->>'so_total_cents')::numeric / 100)

