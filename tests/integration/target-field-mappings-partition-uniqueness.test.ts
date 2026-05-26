import { describe, it, expect } from 'vitest'

/**
 * Post-migration invariants for PR Ω.1 partition primitive foundation.
 *
 * Migration 107 introduces `target_field_mappings.table_mapping_id` (NOT NULL,
 * FK to table_mappings.id) and replaces the old `UNIQUE (project_id,
 * target_field_id)` constraint with a partition-aware
 * `UNIQUE (project_id, target_field_id, table_mapping_id)`.
 *
 * These tests assert against the LIVE database (env-gated, same pattern as
 * tests/integration/transformations-unique-invariant.test.ts):
 *
 *   T1 — every TFM has a non-null `table_mapping_id` (backfill completeness)
 *   T2 — no two TFMs share the same (project, target_field, table_mapping)
 *        triple (new UNIQUE constraint is effective)
 *   T3 — the foreign key reference is intact (no orphan TFMs whose
 *        table_mapping_id points at a deleted/missing TM)
 *
 * Why this exists separate from the migration's own pre-flight checks:
 * the migration runs once at apply time. These tests run on every release
 * gate, catching any future write path that bypasses the constraint by
 * direct SQL or misuses an ON CONFLICT clause.
 *
 * How to run:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/target-field-mappings-partition-uniqueness.test.ts
 */

const HAS_ENV =
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

describeFn('[integration] target_field_mappings partition uniqueness (PR Ω.1)', () => {
  it('T1 — every TFM has a non-null table_mapping_id', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const { count, error } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id', { count: 'exact', head: true })
      .is('table_mapping_id', null)

    expect(error).toBeNull()
    expect(count).toBe(0)
  })

  it('T2 — no two TFMs share the same (project_id, target_field_id, table_mapping_id) triple', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const { data, error } = await supabaseAdmin
      .from('target_field_mappings')
      .select('project_id, target_field_id, table_mapping_id')

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    if (!data) return

    const counts = new Map<string, number>()
    for (const row of data as Array<{
      project_id: string
      target_field_id: string
      table_mapping_id: string
    }>) {
      const key = `${row.project_id}::${row.target_field_id}::${row.table_mapping_id}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const duplicates = Array.from(counts.entries()).filter(([, n]) => n > 1)

    expect(
      duplicates,
      `${duplicates.length} (project, target_field, table_mapping) triple(s) duplicated: ` +
        JSON.stringify(duplicates.slice(0, 10)),
    ).toEqual([])
  })

  it('T3 — every TFM.table_mapping_id references an existing table_mappings row', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const { data: tfms, error: tfmErr } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, table_mapping_id')
    expect(tfmErr).toBeNull()
    if (!tfms) return

    const tmIds = new Set(
      (tfms as Array<{ table_mapping_id: string }>).map((t) => t.table_mapping_id),
    )
    if (tmIds.size === 0) return

    const { data: tms, error: tmErr } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .in('id', Array.from(tmIds))
    expect(tmErr).toBeNull()
    const existingTmIds = new Set(
      (tms ?? []).map((t) => t.id as string),
    )

    const orphans = (tfms as Array<{ id: string; table_mapping_id: string }>).filter(
      (t) => !existingTmIds.has(t.table_mapping_id),
    )

    expect(
      orphans,
      `${orphans.length} TFM(s) reference a non-existent table_mapping_id: ` +
        JSON.stringify(orphans.slice(0, 10)),
    ).toEqual([])
  })
})
