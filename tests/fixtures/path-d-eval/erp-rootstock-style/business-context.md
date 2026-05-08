# ERP migration — legacy SQL Server inventory → Rootstock Items

## Overview

A 200-employee precision-manufacturing customer is migrating off a 12-year-old
custom-built SQL Server inventory system onto Rootstock Cloud ERP (running on
the Salesforce platform). The customer makes engineered components for the
aerospace and medical-device industries — small but complex SKU catalogue
(~270 active items), but every SKU carries detailed cost / vendor / lead-time
metadata that must survive the migration.

This migration moves the `items` table (item master) and aggregates the
`inventory_levels` table (per-warehouse stock) into Rootstock's
`rstk__pjproj__c` Item object.

## Migration goals

- **Migrate all active items** (`is_active = true AND is_obsolete = false`).
  Obsolete items archived separately per Rootstock data-retention policy.
- **Normalise UOM codes** from the legacy 3-letter codes (`PCS`, `GRM`, `KGM`,
  `LBS`, `MTR`, `FT`, `GAL`, `L`) into Rootstock's canonical 2-letter codes
  (`EA`, `KG`, `LB`, `M`, `FT`, `GAL`, `L`). The customer has provided the
  canonical mapping; treat as a lookup table.
- **Convert weight from grams to kilograms.** Source stores weight in `GRAMS`
  (`weight_grams`); Rootstock standard is `KILOGRAMS` (`weight_kg`). Divide
  by 1000.
- **Aggregate inventory across warehouses.** Source has per-warehouse
  `qty_on_hand`; target wants a single sum per item. Same for `reorder_point`
  (use MAX, not SUM, since reorder is per-item not per-warehouse-instance).
- **Map item-type codes** (`RM`, `FG`, `WIP`, `OBS`) to Rootstock canonical
  labels (`raw_material`, `finished_good`, `wip`, `obsolete`). New lookup
  table.
- **Truncate descriptions.** Source allows 500 chars; target caps at 100. Use
  `LEFT(item_descr, 100)`.

## Known data-quality concerns

- Some `weight_grams` values are negative (~3 records) — bad data from a
  decade-old import script that wasn't caught. Treat as NULL.
- Some `qty_on_hand` values are negative (~5 records) — also bad data; treat
  as 0.
- ~3 items have lowercase `item_type_code` (`rm` instead of `RM`) — historical
  case-inconsistency. Normalize.
- Item descriptions occasionally contain non-printable characters from copy-
  paste from old PDFs. Ignore in this migration; out of scope.
- The `lead_time_days` field is occasionally extreme (1500 days = ~4 years)
  for slow-procurement items; this is real data, not bad data.

## Scope decisions

- **Out of scope:** Vendor data migration. The vendor mapping table has been
  populated separately; the customer will resolve `vendor_id` → vendor
  identifiers via that mapping during the transform step. Path D should
  acknowledge this and not invent vendor mappings.
- **Out of scope:** Bills of materials (BOMs). The customer has chosen to
  manually rebuild BOMs in Rootstock rather than migrate.
- **Out of scope:** Historical transactions (purchase orders, sales orders).
  Inventory `qty_on_hand` is migrated; transactional history is not.
- The customer's primary concern is that the `rstk__peitem_uom__c` field on
  every active item resolves to a valid Rootstock UOM code — Rootstock's
  triggers will reject inserts with unknown UOM values.
