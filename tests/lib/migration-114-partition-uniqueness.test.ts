/**
 * Migration 114 source-shape guard (PR Ω.3.6.1).
 *
 * Cheap source-grep test that asserts the partition-uniqueness
 * contract cannot regress in the migration file itself. Mirrors
 * the source-grep pattern used by:
 *   - tests/lib/no-shim-in-redesign-path.test.ts (redesign-tree guard)
 *   - tests/actions/partitions-actions.test.ts (Ω.3.1 P10 grep)
 *   - tests/scripts/load-rootstock-spec-source-shape.test.ts (Ω.3.6)
 *
 * No DB connection — reads the migration .sql as text.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')

const MIGRATION_SRC = readFileSync(
  resolve(
    REPO_ROOT,
    'supabase/migrations/114_table_mappings_partition_uniqueness.sql',
  ),
  'utf-8',
)

describe('[migration 114] partition uniqueness contract', () => {
  it('creates the unique index on the canonical column tuple', () => {
    expect(MIGRATION_SRC).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+table_mappings_partition_uniqueness\s+ON\s+public\.table_mappings\s*\(\s*project_id,\s*target_table_id,\s*partition_label\s*\)/i,
    )
  })

  it('includes a pre-flight duplicate check before the index creation', () => {
    expect(MIGRATION_SRC).toMatch(/Pre-flight failed/)
    // RAISE EXCEPTION fires from inside a DO $$ block; confirm the
    // block exists so the pre-flight is actually executable, not just
    // documented in a comment.
    expect(MIGRATION_SRC).toMatch(/DO\s+\$\$/)
    expect(MIGRATION_SRC).toMatch(/RAISE\s+EXCEPTION/i)
  })

  it('does NOT use a partial-index WHERE clause (supabase-js ON CONFLICT compat)', () => {
    // Documents the intentional Option A (FULL) over Option B (PARTIAL)
    // choice from PR Ω.3.6.1 §2. If a future migration adds
    // `WHERE partition_label IS NOT NULL` to this index, the loader's
    // .upsert({onConflict: 'a,b,c'}) call would silently break (PostgREST
    // doesn't emit INDEX_PREDICATE for inference). This guard catches it.
    expect(MIGRATION_SRC).not.toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+table_mappings_partition_uniqueness[\s\S]*?WHERE/i,
    )
  })
})
