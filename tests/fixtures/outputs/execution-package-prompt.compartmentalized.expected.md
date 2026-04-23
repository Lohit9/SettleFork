## Project
Migration: Legacy CRM → Modern ERP
Project: Heritage Core Migration
Generated: <ISO_TIMESTAMP>

## Source Tables
- s_customers: 100 rows, fields: s_id, s_first_name, s_last_name, s_email, s_phone, s_legacy_flag
- s_orders: 250 rows, fields: so_id, so_customer_id, so_total_cents

## Target Schema
### t_customers
Fields:
  - t_customer_id integer NOT NULL PK
  - t_full_name text NOT NULL
  - t_email_norm text
  - t_tenant_id uuid NOT NULL
  - t_notes text
  - t_deprecated_flag text
### t_orders
Fields:
  - t_order_id integer NOT NULL PK
  - t_customer_fk integer NOT NULL FK→t_customers.t_customer_id
  - t_amount_dollars numeric(10,2)

## Approved Mappings
### s_customers → t_customers
  - s_id (integer) → t_customer_id (integer) [confidence: 95%]
    Transform SQL: (row_data->>'s_id')::integer
    Description: Cast s_id to integer.
  - s_first_name (text) → t_full_name (text) [confidence: 80%]
    Transform SQL: ((row_data->>'s_first_name') || ' ' || (row_data->>'s_last_name'))
    Description: Concatenate first and last name with a space.
  - s_last_name (text) → t_full_name (text) [confidence: 80%]
  - s_email (text) → t_email_norm (text) [confidence: 90%]
    Transform SQL: lower(row_data->>'s_email')
    Description: Normalize email to lowercase.
  - [Value Assignment] → t_tenant_id (uuid)
    Transform SQL: '00000000-0000-0000-0000-000000000001'::uuid
    Description: Hardcoded tenant UUID per deployment instance.

### s_orders → t_orders
  - so_id (integer) → t_order_id (integer) [confidence: 95%]
    Transform SQL: (row_data->>'so_id')::integer
    Description: Cast so_id to integer.
  - so_customer_id (integer) → t_customer_fk (integer) [confidence: 92%]
    Transform SQL: (row_data->>'so_customer_id')::integer
    Description: Cast FK to integer.
  - so_total_cents (integer) → t_amount_dollars (numeric(10,2)) [confidence: 88%]
    Transform SQL: ((row_data->>'so_total_cents')::numeric / 100)
    Description: Convert cents to dollars by dividing by 100.

## Reference Documentation
The following documents provide business context, naming conventions, and domain knowledge.
If they describe different data types, constraints, or nullability than the Target Schema above, follow the Target Schema — it reflects the user's latest configuration.

(no documentation uploaded)

## Data Quality Summary
- Open blocking issues: 0
- Open warnings: 0
- Fixed issues: 0
- Accepted risks: 0
- Active validation rules: 0

### Open Blocking Issues
  None.

### Accepted Risks
  None.

### Active Validation Rules
Use each rule's values/pattern/range verbatim when emitting CHECK / guard SQL. Blocking rules violated by staged rows must halt promotion.
  None.

## Load Order (FK-dependency resolved)
1. t_customers (no dependencies)
2. t_orders (depends on: t_customers)

## Total Counts
2 approved table mappings, 8 field mappings, 7 transformation rules.

## Instructions
⚠️ CRITICAL: ALL SQL in ALL files MUST use T-SQL (MS SQL Server) syntax with [bracket] identifiers for ALL identifiers. Do NOT use PostgreSQL-specific syntax (::type casting, ~, ||, TRIM(), REGEXP_REPLACE, SPLIT_PART, TO_DATE, INITCAP) regardless of what syntax appears in the Transform SQL or Quality Issue examples above. Adapt ALL SQL expressions to T-SQL (MS SQL Server).

Generate the compartmentalized migration scripts using the Source → Staging → Target pattern, following the system prompt rules exactly.
ALL per-table INSERT statements MUST target STG_{target_table} staging tables, NEVER the target tables directly.
Return one entry per target table (in the load order listed above, using the table names exactly as listed).
The "files" array must contain entries in this order:
1. Pre-migration checklist with CREATE/TRUNCATE staging tables (type: "checklist")
2. One entry per target table in the order listed above (type: "table_script") — use the exact table name in "table_name". Section B inserts into STG_{target_table}.
3. Post-staging validation against STG_ tables (type: "validation")
4. Promote to target — INSERT INTO {target} SELECT * FROM STG_{target} for each table (type: "promote")
5. Full rollback — DELETE target tables + TRUNCATE staging tables (type: "rollback")

---FALLBACK---

## Project
Migration: Legacy CRM → Modern ERP
Project: Heritage Core Migration
Generated: <ISO_TIMESTAMP>

## Source Tables
- s_customers: 100 rows, fields: s_id, s_first_name, s_last_name, s_email, s_phone, s_legacy_flag
- s_orders: 250 rows, fields: so_id, so_customer_id, so_total_cents

## Target Schema
### t_customers
Fields:
  - t_customer_id integer NOT NULL PK
  - t_full_name text NOT NULL
  - t_email_norm text
  - t_tenant_id uuid NOT NULL
  - t_notes text
  - t_deprecated_flag text
### t_orders
Fields:
  - t_order_id integer NOT NULL PK
  - t_customer_fk integer NOT NULL FK→t_customers.t_customer_id
  - t_amount_dollars numeric(10,2)

## Approved Mappings
### s_customers → t_customers
  - s_id (integer) → t_customer_id (integer) [confidence: 95%]
    Transform SQL: (row_data->>'s_id')::integer
    Description: Cast s_id to integer.
  - s_first_name (text) → t_full_name (text) [confidence: 80%]
    Transform SQL: ((row_data->>'s_first_name') || ' ' || (row_data->>'s_last_name'))
    Description: Concatenate first and last name with a space.
  - s_last_name (text) → t_full_name (text) [confidence: 80%]
  - s_email (text) → t_email_norm (text) [confidence: 90%]
    Transform SQL: lower(row_data->>'s_email')
    Description: Normalize email to lowercase.
  - [Value Assignment] → t_tenant_id (uuid)
    Transform SQL: '00000000-0000-0000-0000-000000000001'::uuid
    Description: Hardcoded tenant UUID per deployment instance.

### s_orders → t_orders
  - so_id (integer) → t_order_id (integer) [confidence: 95%]
    Transform SQL: (row_data->>'so_id')::integer
    Description: Cast so_id to integer.
  - so_customer_id (integer) → t_customer_fk (integer) [confidence: 92%]
    Transform SQL: (row_data->>'so_customer_id')::integer
    Description: Cast FK to integer.
  - so_total_cents (integer) → t_amount_dollars (numeric(10,2)) [confidence: 88%]
    Transform SQL: ((row_data->>'so_total_cents')::numeric / 100)
    Description: Convert cents to dollars by dividing by 100.

## Reference Documentation
The following documents provide business context, naming conventions, and domain knowledge.
If they describe different data types, constraints, or nullability than the Target Schema above, follow the Target Schema — it reflects the user's latest configuration.

(no documentation uploaded)

## Data Quality Summary
- Open blocking issues: 0
- Open warnings: 0
- Fixed issues: 0
- Accepted risks: 0
- Active validation rules: 0

### Open Blocking Issues
  None.

### Accepted Risks
  None.

### Active Validation Rules
Use each rule's values/pattern/range verbatim when emitting CHECK / guard SQL. Blocking rules violated by staged rows must halt promotion.
  None.

## Load Order (FK-dependency resolved)
1. t_customers (no dependencies)
2. t_orders (depends on: t_customers)

## Total Counts
2 approved table mappings, 8 field mappings, 7 transformation rules.

## Instructions
Generate a SQL migration execution package with exactly 6 sections using the Source → Staging → Target pattern.
Each section MUST start with a SQL block comment header that includes "SECTION N" (e.g., -- ===... SECTION 1 — PRE-MIGRATION CHECKLIST ===...).
Use exactly these section labels:

SECTION 1 — PRE-MIGRATION CHECKLIST
SECTION 2 — EXTRACT QUERIES
SECTION 3 — TRANSFORMATION & STAGING SCRIPTS
SECTION 4 — POST-STAGING VALIDATION
SECTION 5 — PROMOTE TO TARGET
SECTION 6 — ROLLBACK

In SECTION 1, include CREATE TABLE IF NOT EXISTS STG_{target_table} for every target table (mirroring target schema without FKs) and TRUNCATE all STG_ tables.
In SECTION 3, add a SQL comment header line containing the exact table name before each INSERT INTO STG_{target_table} block. ALL inserts go to staging tables (STG_ prefix), NEVER directly to target tables.
In SECTION 5, INSERT INTO {target_table} SELECT * FROM STG_{target_table} for each table in FK dependency order, wrapped in a transaction with ROLLBACK (not COMMIT).
In SECTION 6, DELETE from target tables in reverse FK order, then TRUNCATE all STG_ tables.
Generate one INSERT INTO block per target table in the FK-dependency load order listed above.
Output ONLY valid SQL with comments. No markdown, no code fences, no JSON.