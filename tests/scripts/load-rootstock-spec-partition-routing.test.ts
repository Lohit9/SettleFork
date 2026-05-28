/**
 * Rootstock partition router — PR1–8 (PR Ω.3.6 §6).
 *
 * Pure unit tests against scripts/rootstock-partitions.ts. The
 * extracted module has zero side effects, so we can import +
 * call routePartition() directly with fixture entries; no DB,
 * no service-role key, no script invocation.
 *
 * Covers:
 *   PR1 — Assy Item (EBM) → ONLY [Engineering Parents]
 *   PR2 — Part # (EBM) → ONLY [Engineering Components]
 *   PR3 — Products.<any> → ONLY [Products Catalog]
 *   PR4 — Unmapped.Unmapped (VA targeting EIM) → all 3 partitions
 *   PR5 — Unknown EBM source_field → THROWS with descriptive error
 *   PR6 — source-ack (target=Unmapped) → []
 *   PR7 — Unit of Measure → ICC target → []  (joint-keying gap fix)
 *   PR8 — Unit of Measure → EIM target → [Engineering Components]
 *         (joint-keying gap fix; same source_field as PR7 but
 *          different target_table proves the joint key works)
 */

import { describe, it, expect } from 'vitest'
import {
  EIM_PARTITIONS,
  EIM_TARGET_TABLE,
  ICC_TARGET_TABLE,
  NULL_PARTITION_KEY,
  routePartition,
  type RoutableEntry,
} from '@/scripts/rootstock-partitions'

// ─── Fixture builder ─────────────────────────────────────────────────────

function entry(overrides: Partial<RoutableEntry> = {}): RoutableEntry {
  return {
    source_table: 'Engineering BOM Masters',
    source_field: 'Assy Item',
    target_table: EIM_TARGET_TABLE,
    target_field: 'Item Number',
    ...overrides,
  }
}

// ─── PR1 — Assy Item → ONLY Engineering Parents ──────────────────────────

describe('[routePartition] PR1 — Assy Item (parent identity)', () => {
  it('routes Engineering BOM Masters.Assy Item → [Engineering Parents]', () => {
    const out = routePartition(
      entry({
        source_table: 'Engineering BOM Masters',
        source_field: 'Assy Item',
        target_table: EIM_TARGET_TABLE,
        target_field: 'Item Number',
      }),
    )
    expect(out).toEqual(['Engineering Parents'])
  })

  it('routes Engineering BOM Masters.Assy Desc → [Engineering Parents]', () => {
    const out = routePartition(
      entry({
        source_table: 'Engineering BOM Masters',
        source_field: 'Assy Desc',
        target_table: EIM_TARGET_TABLE,
        target_field: 'Item Description',
      }),
    )
    expect(out).toEqual(['Engineering Parents'])
  })
})

// ─── PR2 — Part # → ONLY Engineering Components ──────────────────────────

describe('[routePartition] PR2 — Part # (component identity)', () => {
  it('routes Engineering BOM Masters.Part # → [Engineering Components]', () => {
    const out = routePartition(
      entry({
        source_table: 'Engineering BOM Masters',
        source_field: 'Part #',
        target_table: EIM_TARGET_TABLE,
        target_field: 'Item Number',
      }),
    )
    expect(out).toEqual(['Engineering Components'])
  })

  it('routes other COMPONENT_FIELDS — Item, Item Type, Sub-Assembly Flag', () => {
    for (const sourceField of ['Item', 'Item Type', 'Sub-Assembly Flag']) {
      const out = routePartition(
        entry({
          source_table: 'Engineering BOM Masters',
          source_field: sourceField,
          target_table: EIM_TARGET_TABLE,
          target_field: 'irrelevant',
        }),
      )
      expect(out).toEqual(['Engineering Components'])
    }
  })
})

// ─── PR3 — Products.<any> → ONLY Products Catalog ────────────────────────

describe('[routePartition] PR3 — Products source table', () => {
  it('routes Products.ProductSKU → [Products Catalog]', () => {
    const out = routePartition(
      entry({
        source_table: 'Products',
        source_field: 'ProductSKU',
        target_table: EIM_TARGET_TABLE,
        target_field: 'Item Number',
      }),
    )
    expect(out).toEqual(['Products Catalog'])
  })

  it('routes Products.<any other field> → [Products Catalog] (single-partition table)', () => {
    for (const sourceField of [
      'ProductName',
      'ProductCaseQty',
      'AnyNewFieldNotInCurrentJson',
    ]) {
      const out = routePartition(
        entry({
          source_table: 'Products',
          source_field: sourceField,
          target_table: EIM_TARGET_TABLE,
          target_field: 'irrelevant',
        }),
      )
      expect(out).toEqual(['Products Catalog'])
    }
  })
})

// ─── PR4 — Unmapped.Unmapped (VA) → all 3 partitions ────────────────────

describe('[routePartition] PR4 — VAs targeting EIM replicate', () => {
  it('routes Unmapped.Unmapped (VA) → all 3 EIM partitions', () => {
    const out = routePartition(
      entry({
        source_table: 'Unmapped',
        source_field: 'Unmapped',
        target_table: EIM_TARGET_TABLE,
        target_field: 'Inventory Source',
      }),
    )
    // Order matches EIM_PARTITIONS array order (ordinal 0 → 1 → 2).
    expect(out).toEqual(EIM_PARTITIONS.map((p) => p.label))
    expect(out).toEqual([
      'Engineering Parents',
      'Products Catalog',
      'Engineering Components',
    ])
  })
})

// ─── PR5 — Unknown EBM source_field → THROWS ─────────────────────────────

describe('[routePartition] PR5 — fail-loudly on unrouted EBM entries', () => {
  it('throws when an EBM source_field is not in any classification set', () => {
    expect(() =>
      routePartition(
        entry({
          source_table: 'Engineering BOM Masters',
          source_field: 'Mystery New Column',
          target_table: EIM_TARGET_TABLE,
          target_field: 'Item Number',
        }),
      ),
    ).toThrow(/unrouted Engineering BOM Masters entry/)
  })

  it('throw message includes the source_field + target_field for the spec author', () => {
    try {
      routePartition(
        entry({
          source_table: 'Engineering BOM Masters',
          source_field: 'Mystery New Column',
          target_table: EIM_TARGET_TABLE,
          target_field: 'Some Target',
        }),
      )
      throw new Error('expected throw')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toMatch(/"Mystery New Column"/)
      expect(msg).toMatch(/"Some Target"/)
      expect(msg).toMatch(/PARENT_FIELD_KEYS/)
    }
  })

  it('throws on unknown source_table (e.g. a new POC source not yet routed)', () => {
    expect(() =>
      routePartition(
        entry({
          source_table: 'A New Source Table',
          source_field: 'Whatever',
          target_table: EIM_TARGET_TABLE,
          target_field: 'Item Number',
        }),
      ),
    ).toThrow(/unrouted entry/)
  })
})

// ─── PR6 — source-ack (target=Unmapped) → [] ─────────────────────────────

describe('[routePartition] PR6 — source acknowledgments (target=Unmapped)', () => {
  it('returns [] when target_table is the Unmapped sentinel (project-scoped ack)', () => {
    const out = routePartition(
      entry({
        source_table: 'Engineering BOM Masters',
        source_field: 'FG Commodity Code',
        target_table: 'Unmapped',
        target_field: 'Unmapped',
      }),
    )
    expect(out).toEqual([])
  })

  it('returns [] for ANY source side when target is Unmapped (even Products)', () => {
    const out = routePartition(
      entry({
        source_table: 'Products',
        source_field: 'AnyField',
        target_table: 'Unmapped',
        target_field: 'Unmapped',
      }),
    )
    expect(out).toEqual([])
  })
})

// ─── PR7 — ICC target → [NULL_PARTITION_KEY] (non-partitioned) ──────────
//
// PR Ω.3.9 reversed the Option-A skip. ICC entries now route to a
// single non-partitioned TM. The router returns `[NULL_PARTITION_KEY]`
// as the in-memory key for that TM (its DB `partition_label` is NULL).

describe('[routePartition] PR7 — ICC target → non-partitioned TM', () => {
  it('routes Unit of Measure → ICC target → [NULL_PARTITION_KEY]', () => {
    const out = routePartition(
      entry({
        source_table: 'Engineering BOM Masters',
        source_field: 'Unit of Measure',
        target_table: ICC_TARGET_TABLE,
        target_field: 'rstk__iccomcod_dfltinvuom__r external id',
      }),
    )
    expect(out).toEqual([NULL_PARTITION_KEY])
  })

  it('routes VAs targeting ICC → [NULL_PARTITION_KEY] (per-code transformations)', () => {
    const out = routePartition(
      entry({
        source_table: 'Unmapped',
        source_field: 'Unmapped',
        target_table: ICC_TARGET_TABLE,
        target_field: 'COMMODITY CODE',
      }),
    )
    expect(out).toEqual([NULL_PARTITION_KEY])
  })
})

// ─── PR8 — Unit of Measure → EIM target → Components (joint-keying fix) ──

describe('[routePartition] PR8 — joint (source_field, target_table) keying', () => {
  it('routes Unit of Measure → EIM target → [Engineering Components]', () => {
    const out = routePartition(
      entry({
        source_table: 'Engineering BOM Masters',
        source_field: 'Unit of Measure',
        target_table: EIM_TARGET_TABLE,
        target_field: 'rstk__peitem_enguom__r external id',
      }),
    )
    expect(out).toEqual(['Engineering Components'])
  })

  it('proves the same source_field routes DIFFERENTLY based on target_table (PR7 + PR8)', () => {
    const sourceField = 'Unit of Measure'
    const sourceTable = 'Engineering BOM Masters'

    // EIM target → routed to Components.
    const eimOut = routePartition(
      entry({
        source_table: sourceTable,
        source_field: sourceField,
        target_table: EIM_TARGET_TABLE,
        target_field: 'rstk__peitem_enguom__r external id',
      }),
    )
    expect(eimOut).toEqual(['Engineering Components'])

    // ICC target → non-partitioned TM (PR Ω.3.9 reversal of Option A).
    const iccOut = routePartition(
      entry({
        source_table: sourceTable,
        source_field: sourceField,
        target_table: ICC_TARGET_TABLE,
        target_field: 'rstk__iccomcod_dfltenguom__r external id',
      }),
    )
    expect(iccOut).toEqual([NULL_PARTITION_KEY])
  })
})

// ─── EIM_PARTITIONS shape sanity ─────────────────────────────────────────

describe('[EIM_PARTITIONS] shape invariants', () => {
  it('has exactly 3 partitions', () => {
    expect(EIM_PARTITIONS).toHaveLength(3)
  })

  it('ordinals are 0, 1, 2 in declared order', () => {
    expect(EIM_PARTITIONS.map((p) => p.ordinal)).toEqual([0, 1, 2])
  })

  it('dedup_priority matches ordinal (Parents < Products < Components)', () => {
    expect(EIM_PARTITIONS.map((p) => p.dedupPriority)).toEqual([0, 1, 2])
  })

  it('labels are unique', () => {
    const labels = EIM_PARTITIONS.map((p) => p.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('every partition targets the EIM table', () => {
    for (const p of EIM_PARTITIONS) {
      expect(p.targetTableName).toBe(EIM_TARGET_TABLE)
    }
  })

  it('Parents + Components use the same source table (different filter)', () => {
    const parents = EIM_PARTITIONS.find((p) => p.label === 'Engineering Parents')!
    const components = EIM_PARTITIONS.find((p) => p.label === 'Engineering Components')!
    expect(parents.sourceTableName).toBe(components.sourceTableName)
    expect(parents.sourceTableName).toBe('Engineering BOM Masters')
    expect(parents.filterSql).not.toBe(components.filterSql)
  })

  it('Products Catalog has NULL filter (no row restriction)', () => {
    const products = EIM_PARTITIONS.find((p) => p.label === 'Products Catalog')!
    expect(products.filterSql).toBeNull()
  })

  it('filter_sql for EBM partitions uses JSONB-style row_data accessors', () => {
    const parents = EIM_PARTITIONS.find((p) => p.label === 'Engineering Parents')!
    const components = EIM_PARTITIONS.find((p) => p.label === 'Engineering Components')!
    expect(parents.filterSql).toMatch(/row_data->>'Assy Item'/)
    expect(components.filterSql).toMatch(/row_data->>'Part #'/)
    // Components also excludes parent rows (defensive ambiguity fix).
    expect(components.filterSql).toMatch(/Assy Item.*IS NULL/)
  })
})
