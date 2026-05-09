## Migration Intelligence (Reference Only — Do Not Copy Directly)

The following patterns were learned from previous migrations completed by your team.
Use them as HINTS to improve your suggestions, but ALWAYS validate against the actual
source data and target schema for THIS project.

### Transformation Recipes

★★★ Aggregation-derived rollup tables (confirmed in 5 migrations)
Legacy systems often store category / classification data as a free-form column on the master record (e.g., `ProductGroupName` on items, `RegionName` on accounts). Modern targets normalise this into a dedicated lookup table with a generated PK. Recipe: surface a mapping from the source column to the new lookup table's display field with `combination_type: custom_sql` and a SELECT DISTINCT-style derivation; surface the FK on the master record as a separate mapping that resolves via lookup. Document the rollup as an `aggregation_strategy` decision.

★★ Constant-value / audit-field assignment (confirmed in 4 migrations)
Modern target schemas frequently add audit / tenancy fields (`BusinessUnit`, `SourceSystem`, `Tenant`, `Region`) that have no source counterpart in single-tenant or single-system migrations. Recipe: emit a mapping with `source_field_ids: []` and `combination_type: custom_sql`, with the literal value embedded in `combination_sql`. Surface as a `default_value` decision so the customer can confirm the constant is correct for their tenancy model.

### Data Quality Patterns

★★ Casing inconsistencies on free-form classification columns (seen in 6 migrations)
Free-form group / category / status columns accumulate casing drift over years of manual entry ("Cups" / "cups" / "CUPS"). Before deriving rollup tables from these columns, normalise casing to a canonical form to avoid duplicate category rows. Surface as `case_inconsistency`.

### Domain Context

★ Inverse-polarity boolean flags
Legacy systems often track lifecycle state with negative-polarity columns (`Discontinued`, `Inactive`, `Deleted`); modern targets prefer positive polarity (`IsActive`). When mapping, emit a `custom_sql` with `NOT discontinued` (or equivalent) and surface as a `value_normalization` decision so the customer can sanity-check the flip.
