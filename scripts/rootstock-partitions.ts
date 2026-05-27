/**
 * scripts/rootstock-partitions.ts
 *
 * Pure (no side-effects, no DB) routing + partition definitions for the
 * Rootstock POC loader. Extracted from load-rootstock-spec.ts so both
 * the loader and the unit tests can import without running `main()`.
 *
 * The 3-partition split for Engineering Item Master + the
 * (source_field, target_table)-keyed classification sets are a
 * domain-specific Rootstock decision that lives in code (NOT JSON).
 *
 * KNOWN LIMITATION — dedup deferred (PR Ω.3.6, locked Q1 answer):
 *   Filter SQL is a LOOSE per-row WHERE clause. It does NOT collapse
 *   duplicate Assy_Item / Part_# values from the 1,562-row Engineering
 *   BOM Masters source — that's a Migration Center / pre-processing
 *   concern. Mapping page TFMs (one per (target_field, partition))
 *   are correct regardless of source row cardinality.
 */

// ─── Target table sentinels ──────────────────────────────────────────────

export const EIM_TARGET_TABLE = 'Engineering Item Master'
export const ICC_TARGET_TABLE = 'Inventory Commodity Code'
export const UNMAPPED_SENTINEL = 'Unmapped'

// ─── Partition definitions (hardcoded; NOT derived from JSON) ────────────
//
// Per PR Ω.3.6 locked spec (Kaan):
//   Ordinal 0 — Engineering Parents       (EBM Assy_Item-side rows)
//   Ordinal 1 — Products Catalog          (Products SKU-side rows)
//   Ordinal 2 — Engineering Components    (EBM Part_#-side rows)
//
// Filter SQL is LOOSE per Q1 (a): the Mapping page renders correctly;
// staged data may contain duplicates. Dedup is a downstream concern.
//
// dedup_priority: Parents wins over Products (a SKU with a BOM is
// manufactured per the JSON's "Item Number" justification) — Components
// last because raw materials shouldn't collide with finished items.
//
// identity_field_id is RESOLVED AT RUNTIME via the project's fields
// table — we store the target field NAME here and the loader maps to
// the UUID after Phase 3 name-resolution. All 3 partitions share the
// same identity ("Item Number" — required by Ω.3.1 sibling consistency).

export const EIM_IDENTITY_TARGET_FIELD_NAME = 'Item Number'

export interface RootstockPartitionDef {
  /** partition_label — unique per (project, target_table) */
  label: string
  /** Source-table NAME (resolved to UUID at runtime). */
  sourceTableName: string
  /** target_table_id NAME (resolved to UUID at runtime). All 3 are EIM. */
  targetTableName: string
  /** partition_ordinal — stable across re-runs. */
  ordinal: number
  /** filter_sql — loose; dedup deferred. NULL = no filter. */
  filterSql: string | null
  /** dedup_priority — lower wins on identity collision. */
  dedupPriority: number
}

export const EIM_PARTITIONS: readonly RootstockPartitionDef[] = [
  {
    label: 'Engineering Parents',
    sourceTableName: 'Engineering BOM Masters',
    targetTableName: EIM_TARGET_TABLE,
    ordinal: 0,
    // Loose filter: any row where Assy Item is non-null. Yields ~1562
    // rows from the source (duplicates) — staging dedup is a Migration
    // Center concern; identity_field_id ('Item Number') makes downstream
    // queries dedup-aware regardless.
    filterSql: `(row_data->>'Assy Item') IS NOT NULL`,
    dedupPriority: 0,
  },
  {
    label: 'Products Catalog',
    sourceTableName: 'Products',
    targetTableName: EIM_TARGET_TABLE,
    ordinal: 1,
    // No filter — every Products row is a real catalog item.
    filterSql: null,
    dedupPriority: 1,
  },
  {
    label: 'Engineering Components',
    sourceTableName: 'Engineering BOM Masters',
    targetTableName: EIM_TARGET_TABLE,
    ordinal: 2,
    // Loose filter: rows that have a Part # AND are NOT also a parent.
    // The `AND ... IS NULL` half is the conservative discriminator —
    // a row that has both Assy Item and Part # is ambiguous; we
    // attribute it to Parents (ordinal 0 wins). Same dedup caveat as
    // Parents: duplicates survive at the staged-data layer.
    filterSql: `(row_data->>'Part #') IS NOT NULL AND (row_data->>'Assy Item') IS NULL`,
    dedupPriority: 2,
  },
]

// Convenience lookups.
export function getPartitionByLabel(label: string): RootstockPartitionDef {
  const match = EIM_PARTITIONS.find((p) => p.label === label)
  if (!match) {
    throw new Error(
      `[rootstock-partitions] unknown partition label "${label}". ` +
        `Valid: ${EIM_PARTITIONS.map((p) => p.label).join(', ')}`,
    )
  }
  return match
}

// ─── Classification sets — keyed by (source_field, target_table) ─────────
//
// Why joint keying (Q1 / classification-gap fix): the JSON has
// "Unit of Measure" as a source_field appearing in BOTH EIM-targeting
// entries AND ICC-targeting entries (with different target_field
// values per row). Routing by source_field alone would mis-route
// the ICC entries.
//
// Format: `${source_field}|${target_table}` — opaque string used only
// inside this module.

function key(sourceField: string, targetTable: string): string {
  return `${sourceField}|${targetTable}`
}

// Engineering BOM Masters fields that represent PARENT rows.
// Every (source_field, EIM) entry whose row identity is Assy_Item.
const PARENT_FIELD_KEYS: ReadonlySet<string> = new Set([
  key('Assy Item', EIM_TARGET_TABLE),
  key('Assy Desc', EIM_TARGET_TABLE),
])

// Engineering BOM Masters fields that represent COMPONENT rows.
// Every (source_field, EIM) entry whose row identity is Part_#.
const COMPONENT_FIELD_KEYS: ReadonlySet<string> = new Set([
  key('Part #', EIM_TARGET_TABLE),
  key('Item', EIM_TARGET_TABLE),
  key('Item Type', EIM_TARGET_TABLE),
  key('Unit of Measure', EIM_TARGET_TABLE),
  key('Sub-Assembly Flag', EIM_TARGET_TABLE),
])

// Engineering BOM Masters fields that apply to BOTH partitions
// (replicate). Empty today; add here if pilot surfaces shared fields.
const SHARED_FIELD_KEYS: ReadonlySet<string> = new Set<string>([])

// ─── Router ──────────────────────────────────────────────────────────────

/**
 * Minimum entry shape the router needs. Mirrors the EntrySchema in
 * load-rootstock-spec.ts but kept loose here so tests can construct
 * fixtures without importing the script.
 */
export interface RoutableEntry {
  source_table: string
  source_field: string
  target_table: string
  target_field: string
}

/**
 * Route a JSON entry to its target partition label(s).
 *
 * Return value semantics:
 *   - `[]` — entry is not partition-bound (source_ack rows where
 *     target_table='Unmapped'; OR ICC-target rows which are skipped
 *     per Q4-Option-A). The caller MUST handle these via the
 *     existing acks / skip flow; routing does not concern itself
 *     with persistence.
 *   - `[label]` — single-partition routing (mapped entry with a
 *     real source_table OR VA targeting a non-EIM table).
 *   - `[label, label, ...]` — multi-partition replication (VA
 *     targeting EIM; shared EBM field).
 *
 * Throws on unknown EBM source_field per Q2 (fail-loudly).
 */
export function routePartition(entry: RoutableEntry): readonly string[] {
  // Source-ack: target is the Unmapped sentinel. Acks are
  // project-scoped (source_field_acknowledgments), NOT partition-bound.
  if (entry.target_table === UNMAPPED_SENTINEL) {
    return []
  }

  // ICC target — skipped per Q4 Option A. ICC is loaded outside Settle.
  if (entry.target_table === ICC_TARGET_TABLE) {
    return []
  }

  // Value assignment targeting EIM: replicate across all 3 partitions.
  // (Q5 — VAs replicate verbatim; Joanna edits per-partition post-load
  // if any are wrong for Components.)
  if (entry.source_table === UNMAPPED_SENTINEL) {
    if (entry.target_table === EIM_TARGET_TABLE) {
      return EIM_PARTITIONS.map((p) => p.label)
    }
    // VA targeting a non-EIM target_table — not partitioned; surfaces
    // as a single-TM mapping using the loader's heritage path. Today
    // the JSON has no such entry (every VA targets EIM), but the
    // contract is "return [] here" so the caller falls back to its
    // pre-partition flow. If/when a new target table appears with VAs,
    // it'll need its own partition design.
    return []
  }

  // Products is single-partition → Products Catalog.
  if (entry.source_table === 'Products' && entry.target_table === EIM_TARGET_TABLE) {
    return ['Products Catalog']
  }

  // Engineering BOM Masters: route by (source_field, target_table) joint key.
  if (entry.source_table === 'Engineering BOM Masters' && entry.target_table === EIM_TARGET_TABLE) {
    const k = key(entry.source_field, entry.target_table)
    if (PARENT_FIELD_KEYS.has(k)) return ['Engineering Parents']
    if (COMPONENT_FIELD_KEYS.has(k)) return ['Engineering Components']
    if (SHARED_FIELD_KEYS.has(k)) return ['Engineering Parents', 'Engineering Components']
    throw new Error(
      `[rootstock-partitions] unrouted Engineering BOM Masters entry: ` +
        `source_field="${entry.source_field}", target_field="${entry.target_field}". ` +
        `Add it to PARENT_FIELD_KEYS, COMPONENT_FIELD_KEYS, or SHARED_FIELD_KEYS ` +
        `in scripts/rootstock-partitions.ts.`,
    )
  }

  // Any other mapped entry (new source table, etc.) — fail-loudly so
  // the spec author has to extend this router consciously rather than
  // silently producing zero-partition routing.
  throw new Error(
    `[rootstock-partitions] unrouted entry: source_table="${entry.source_table}", ` +
      `target_table="${entry.target_table}". Extend routePartition() to handle this case.`,
  )
}
