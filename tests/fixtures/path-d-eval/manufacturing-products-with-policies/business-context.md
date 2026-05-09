# Manufacturing migration — legacy items + policies → modern Products + Categories

## Overview

A 350-employee industrial-supplies manufacturer is migrating off a legacy
on-prem ERP onto a modern cloud product-catalogue system. The legacy system
stores all product metadata in two flat tables: `items` (master record) and
`item_policies` (reorder thresholds). The target system splits products
across two normalised tables: `products` and a separate `categories` lookup.

The customer's catalogue is small (~21 SKUs across 5 product groups) but
each SKU carries detailed cost / lead-time / inventory-policy metadata that
must survive the migration intact.

## Migration goals

- **Migrate every active item** (`Discontinued = false`); discontinued items
  carry forward with `IsActive = false` rather than being filtered out.
  Polarity flips between source and target.
- **Aggregate distinct ProductGroupName values into the new Categories
  table.** The source has no Categories table — it's a flat string column.
  The target requires one Categories row per distinct group, with
  Products.CategoryID set via lookup. Path D should infer the rollup
  pattern from the data shape.
- **Populate three constant audit fields on every migrated row:**
  - `Products.BusinessUnit = 'Manufacturing'`
  - `Products.SourceSystem = 'Legacy ERP'`
  - `Categories.BusinessSegment = 'Industrial'`
  None of these have source counterparts; each row gets the literal value.
- **Move `ReorderPoint` and `SafetyStock`** from `item_policies` (separate
  table joined by ItemID) onto the consolidated `products` row. Same units
  on both sides; no conversion.
- **Carry `LeadTimeDays`, `ItemDescription`, `UnitCost`** straight across
  with light renames (UnitCost → StandardCost, ItemDescription →
  ProductDescription).

## Known data-quality concerns

- `ProductGroupName` has casing inconsistencies — "Cups" / "cups" / "CUPS"
  appear in different rows for what's clearly the same group. The
  merchandising team confirmed this is one logical group; normalize to
  canonical "Cups" before deriving Categories.
- `UnitCost` has ~2 negative values, almost certainly bad data carried over
  from a legacy import script. Treat as NULL.
- Item descriptions occasionally contain stray pipe characters from a
  long-since-removed ETL pipeline. Out of scope for this migration.

## Scope decisions

- **Out of scope:** `PreferredVendor`. No Vendors target table exists in
  this engagement — the customer plans to migrate vendor master data under
  a separate workstream next quarter. Path D should flag this as inferred
  target rather than invent a mapping.
- **Out of scope:** Historical purchase orders or stock movements; only
  master data is in scope here.
- The customer's primary concern is that every active product row has a
  valid `CategoryID` populated — orphaned products fail their downstream
  catalogue-publishing pipeline.
