## Migration Intelligence (Reference Only — Do Not Copy Directly)

The following patterns were learned from previous migrations completed by your team.
Use them as HINTS to improve your suggestions, but ALWAYS validate against the actual
source data and target schema for THIS project.

### Transformation Recipes

★★★ Unit-of-measure code normalization (confirmed in 4 migrations)
Legacy ERPs use idiosyncratic UOM codes ("PCS", "GRM", "EA", "BOX") that don't match modern target systems' allowed-value lists (often ISO 80000 or vendor-specific). Recipe: build an explicit mapping table from observed source values to target allowed-values; treat any unmapped source value as a blocking decision rather than silently dropping. Document the mapping table in <lookup_tables>.

★★ SKU / part-number normalization (confirmed in 3 migrations)
Inherited ERPs often pad SKUs to fixed widths with leading zeros, embed legacy plant codes, or carry hyphen variants ("ABC-123", "ABC123", "abc-123"). Strip non-significant prefix/suffix, uppercase, and document the canonicalization explicitly so downstream systems see the same keys.

### Data Quality Patterns

★★★ Active / obsolete inventory filter (seen in 6 migrations)
Most legacy ERPs carry years of obsolete SKUs. Migrating them inflates the target catalog and complicates forward-looking analytics. Recipe: filter by is_active + is_obsolete columns at extraction time; archive obsolete items separately rather than mapping them. Flag cases where obsolete rows have non-zero current inventory (rare but indicates source-data quality issue).

### Domain Context

★ Multi-warehouse stock aggregation
Sources commonly have per-warehouse stock rows (one row per SKU × warehouse); some targets use a unified stock total per SKU, others preserve the per-warehouse split. Path D should surface this as a decision when the target schema doesn't make the choice obvious from field names alone.
