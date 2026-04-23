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

## Instructions
Generate a SQL migration execution package with exactly 6 sections using the Source → Staging → Target pattern.
ALL transform-and-load scripts insert into STAGING tables (STG_ prefix), NEVER directly into target tables. The ONLY section that writes to target tables is Section 5 (Promote to Target).

SECTION 1 — PRE-MIGRATION CHECKLIST
- List all open blocking issues as SQL comments with severity and record counts.
- Include fix SQL for each issue if available (commented out with -- prefix, ready to uncomment and run).
- List all accepted risks as comments.
- Include a comment block with total source record counts per table.
- CRITICAL: Check every NOT NULL target field. If any source mapping or transformation could produce NULL for a NOT NULL target field, flag it here as a blocking issue with the specific field name and estimated affected row count.
- CREATE STAGING TABLES: Output CREATE TABLE IF NOT EXISTS STG_{target_table} for every target table. Schema mirrors target exactly (same columns, same types, same NOT NULL) but WITHOUT foreign key constraints.
- TRUNCATE STAGING TABLES: TRUNCATE all STG_ tables in reverse dependency order for idempotent re-runs.

SECTION 2 — EXTRACT QUERIES
- One SELECT query per source table.
- Apply filtering rules from the business rules documentation (e.g., status exclusions like excluding Archived records).
- Include WHERE clauses that exclude records with null or empty primary keys.
- DO NOT apply date-range or numeric-range filters here if the source field is VARCHAR — those filters belong in Section 3 after type conversion.
- For child tables, include a WHERE clause that filters to only records whose FK exists in the parent table AFTER the parent's own filters are applied. Example: WHERE customer_id IN (SELECT customer_id FROM Customers WHERE customer_id IS NOT NULL AND status != 'Archived')
- Add a comment above each WHERE clause explaining the filter criterion and which business rule it implements.

SECTION 3 — TRANSFORMATION & STAGING SCRIPTS
- Generate scripts in the load order specified above.
- For EACH target table, generate a complete:
    INSERT INTO STG_{target_table} (col1, col2, ...)
    SELECT
        -- source_field → target_field: description
        transform_expression AS col1,

        -- source_field → target_field: description
        transform_expression AS col2,
        ...
    FROM source_table
    WHERE <filters>;
- The INSERT target is ALWAYS the staging table (STG_ prefix), NEVER the target table directly.
- Use the EXACT approved transformation SQL for fields that have it — embed verbatim.
- For fields without explicit transforms, generate appropriate type casting or direct mapping.
- For NOT NULL target fields where the source can be NULL, use COALESCE with a sensible default.
- For unmapped target fields that have database DEFAULT values, omit them from the INSERT column list (let the database apply the default).
- Apply all filtering: null PK exclusion, business rule exclusions, parent-table existence checks for child tables.
- Date-range filters (e.g., close_date >= '2020-01-01') MUST be applied AFTER date parsing/conversion, not on the raw VARCHAR. Use a subquery or CTE if needed.
- Format each column expression on its own line with a descriptive comment.

SECTION 4 — POST-STAGING VALIDATION
Generate these validation queries against STAGING tables (STG_ prefix):
- Record count reconciliation: For each table mapping, generate TWO independent queries side by side:
    SELECT 'Source: table_name' AS label, COUNT(*) AS row_count FROM source_table WHERE <same filters as Section 3>;
    SELECT 'Staging: table_name' AS label, COUNT(*) AS row_count FROM STG_{target_table};
- FK integrity checks across staging tables: For every FK relationship:
    SELECT 'Orphaned records in STG_child.fk_field' AS check_name, COUNT(*) AS violations FROM STG_{child_table} c LEFT JOIN STG_{parent_table} p ON c.fk = p.pk WHERE p.pk IS NULL;
- CHECK constraint validation: For every picklist/code field with a CHECK constraint:
    SELECT 'Invalid values in STG_table.field' AS check_name, field_name, COUNT(*) AS violations FROM STG_{table} WHERE field NOT IN ('val1', 'val2', ...) GROUP BY field_name;
- NOT NULL checks: For every NOT NULL target field:
    SELECT 'NULL violations in STG_table.field' AS check_name, COUNT(*) AS violations FROM STG_{table} WHERE field IS NULL;
- Aggregate reconciliation: For key numeric fields (amounts, revenues), generate independent SUM queries:
    SELECT 'Source total: field' AS label, SUM(cleaned_expression) AS total FROM source_table WHERE <filters>;
    SELECT 'Staging total: field' AS label, SUM(field) AS total FROM STG_{target_table};
- End with: -- ⚠️ REVIEW ALL RESULTS ABOVE. DO NOT PROCEED TO PROMOTION (Section 5) UNLESS ALL CHECKS PASS.

SECTION 5 — PROMOTE TO TARGET
- Wrap all inserts in a single transaction (dialect-appropriate).
- For each target table in FK dependency order: INSERT INTO {target_table} SELECT * FROM STG_{target_table}.
- No transforms, no CASE statements — clean column-for-column copy from staging to target.
- After all inserts: post-promotion row count verification confirming target count = staging count for each table.
- Transaction ends with ROLLBACK by default — NOT COMMIT.
- Include: -- ⚠️ CHANGE ROLLBACK TO COMMIT ONLY AFTER VERIFYING ALL POST-PROMOTION COUNTS MATCH.

SECTION 6 — ROLLBACK
- Generate DELETE FROM statements for each target table in REVERSE load order (to respect FK constraints).
- After all target table deletions: TRUNCATE all STG_ tables in reverse dependency order.
- Post-rollback verification: SELECT COUNT(*) checks confirming both target and staging tables are empty.
- Wrap in BEGIN / ROLLBACK (not COMMIT) so the engineer must explicitly change ROLLBACK to COMMIT.
- Include a prominent warning comment block at the top of this section.