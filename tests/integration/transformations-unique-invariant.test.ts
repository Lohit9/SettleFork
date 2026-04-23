import { describe, it, expect } from 'vitest'

/**
 * Post-migration invariant: every `target_field_mapping_id` in the
 * `transformations` table appears at most once.
 *
 * Why this test exists
 * ────────────────────
 * Migration 074 enforces `UNIQUE (target_field_mapping_id)` via a partial
 * index on `public.transformations`. The Prompt-3b code paths
 * (`generateTransform`, `cascadeTransformToFKs`, `updateTransformSQL`,
 * `autoSaveTransform`, `applyTransform`) all upsert transformations keyed
 * on TFM id and depend on that uniqueness for their `.maybeSingle()` /
 * `.update().eq()` call shapes.
 *
 * A regression that inserts a second transformation row under the same
 * TFM would:
 *   - silently corrupt `getTransformData` (which caches one row per TFM),
 *   - desync the "applied" status,
 *   - and break `revertTransform` / `resetFieldTransform` which both
 *     assume a single row per TFM.
 *
 * How to run
 * ──────────
 * This is a live-data check, so it is **env-gated** and auto-skips in CI
 * or on machines without production credentials:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/transformations-unique-invariant.test.ts
 *
 * Run manually against production before each release. If it ever fails,
 * a write path has introduced data corruption and must be fixed before
 * ship — the UNIQUE index in migration 074 should make violation
 * impossible, so a failure likely means the index was dropped or a
 * migration skipped it.
 *
 * Gate 2 precision: "Add unit test asserting COUNT(transformations) per
 * target_field_mapping_id ≤ 1. Document the invariant in a comment block
 * at the top of transformations.ts."
 */

const HAS_ENV =
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

describeFn('[integration] transformations uniqueness invariant', () => {
  it('every target_field_mapping_id has at most one transformation row', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const { data, error } = await supabaseAdmin
      .from('transformations')
      .select('target_field_mapping_id')

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    if (!data) return

    const counts = new Map<string, number>()
    for (const row of data as Array<{ target_field_mapping_id: string }>) {
      counts.set(
        row.target_field_mapping_id,
        (counts.get(row.target_field_mapping_id) ?? 0) + 1,
      )
    }

    const duplicates = Array.from(counts.entries()).filter(([, n]) => n > 1)

    expect(
      duplicates,
      `${duplicates.length} target_field_mapping_id(s) have more than one transformation row: ` +
        JSON.stringify(duplicates.slice(0, 10)),
    ).toEqual([])
  })

  it('target_field_mapping_id is NOT NULL on every transformation row', async () => {
    // Migration 074 replaced the nullable `field_mapping_id` column with
    // `target_field_mapping_id NOT NULL`. Any null here would indicate a
    // rollback-without-backfill failure mode.
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const { count, error } = await supabaseAdmin
      .from('transformations')
      .select('id', { count: 'exact', head: true })
      .is('target_field_mapping_id', null)

    expect(error).toBeNull()
    expect(count).toBe(0)
  })
})
