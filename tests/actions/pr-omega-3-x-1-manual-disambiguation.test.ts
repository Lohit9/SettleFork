// @vitest-environment node
//
// PR Ω.3.x.1 — Manual multi-source disambiguation popup.
//
// Source-grep invariant tests covering the server-side foundation. Same
// strategy as `pr-omega-3-8-1-status-fanout.test.ts` and
// `edit-mapping-sources.test.ts` — we read the source files and pin the
// wire-shape decisions locked by the spec (cross-table guard,
// `allowCrossTable` opt-in, regenerate trigger wiring, multi-partition
// canonical default, partition-scoped collision check).
//
// Cases locked here:
//
//   T0   `TfmRegenerateTrigger` union exposes `'create_disambiguated'`.
//   T1   `createFieldMapping` accepts `allowCrossTable: boolean` (default false).
//   T2   `createFieldMapping` accepts `tableMappingId?: string`.
//   T3   `createFieldMapping` accepts `regenerateTrigger?: TfmRegenerateTrigger`.
//   T4   `createFieldMapping` rejects with VALIDATION when sources span
//        multiple source tables AND `allowCrossTable` is false.
//   T5   `createFieldMapping` collision check is scoped by
//        `table_mapping_id` (partition-aware; matches the migration 107
//        unique constraint).
//   T6   `createFieldMapping` fires `regenerateTfmMetadata` ONLY when
//        the caller passed `regenerateTrigger` — gated, NOT unconditional.
//        This avoids a duplicate LLM call from `createMappingFromUnmapped`
//        (which omits the trigger and fires its own regenerate after).
//   T7   `editMappingSources` accepts `allowCrossTable: boolean` (default false).
//   T8   `editMappingSources` rejects with VALIDATION when sources span
//        multiple source tables AND `allowCrossTable` is false.
//   T9   `promoteUnmappedSource` accepts `allowCrossTable: boolean` (default false).
//   T10  `promoteUnmappedSource` Step 5b rejects with VALIDATION when the
//        picked source's table is not in the existing TFM's source-table set
//        AND `allowCrossTable` is false.
//   T11  `findOrCreateTableMapping` orders by `partition_ordinal` ASC NULLS
//        LAST then `created_at` ASC then `id` ASC with `.limit(1).maybeSingle()`
//        so multi-partition projects pick the canonical default deterministically.
//   T12  The recompute-side TM lookup uses the same canonical ordering for
//        non-anchor source tables (Step 9 in `createFieldMapping`).
//   T13  Anchor TM resolution in `createFieldMapping` is wired BEFORE the
//        collision check (so the check can scope by the resolved
//        `table_mapping_id`).
//   T14  `mapping_created` activity log captures `allow_cross_table` in
//        the payload — useful for auditing which gestures bypassed the
//        guard.
//   T15  Pre-existing four `regenerateTfmMetadata` callsites preserved
//        (`source_set_edit`, `source_swap`, `target_swap`,
//        `create_from_unmapped`). No accidental removal in the wiring.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(
  __dirname,
  '../../lib/actions/mappings-for-redesign.ts',
)
const ACTIONS_SRC = readFileSync(ACTIONS_PATH, 'utf8')

const TRIGGER_PATH = resolve(__dirname, '../../lib/actions/tfm-regenerate.ts')
const TRIGGER_SRC = readFileSync(TRIGGER_PATH, 'utf8')

function sliceFromTo(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  if (a < 0) throw new Error(`start marker not found: ${start}`)
  const b = src.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`end marker not found after start: ${end}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// T0 — Trigger union
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.x.1] T0 — TfmRegenerateTrigger union', () => {
  it("includes 'create_disambiguated'", () => {
    expect(TRIGGER_SRC).toMatch(/'create_disambiguated'/)
  })

  it('keeps the four pre-existing values', () => {
    expect(TRIGGER_SRC).toMatch(/'source_swap'/)
    expect(TRIGGER_SRC).toMatch(/'target_swap'/)
    expect(TRIGGER_SRC).toMatch(/'source_set_edit'/)
    expect(TRIGGER_SRC).toMatch(/'create_from_unmapped'/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// T1–T6 — createFieldMapping
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.x.1] createFieldMapping — cross-table guard + opts', () => {
  const fn = sliceFromTo(
    ACTIONS_SRC,
    'export async function createFieldMapping',
    '// ─── Helper: find-or-create table_mappings ',
  )

  it('T1: accepts `allowCrossTable: boolean` opt with default false', () => {
    expect(fn).toMatch(/allowCrossTable\?: boolean/)
    expect(fn).toMatch(/allowCrossTable = false/)
  })

  it('T2: accepts `tableMappingId?: string` opt', () => {
    expect(fn).toMatch(/tableMappingId\?: string/)
    expect(fn).toMatch(/tableMappingId: explicitTableMappingId/)
  })

  it('T3: accepts `regenerateTrigger?: TfmRegenerateTrigger` opt', () => {
    expect(fn).toMatch(/regenerateTrigger\?: TfmRegenerateTrigger/)
  })

  it('T4: cross-table guard rejects VALIDATION pre-write', () => {
    // Guard fires BEFORE the collision check + the TM resolve. We pin
    // both the predicate and the error code.
    expect(fn).toMatch(
      /if \(!allowCrossTable && uniqueSourceTableIds\.size > 1\)/,
    )
    expect(fn).toMatch(
      /Sources span multiple source tables[\s\S]*?errorCode: 'VALIDATION'/,
    )
  })

  it('T5: collision check scoped by `table_mapping_id`', () => {
    // Pre-Ω.3.x.1 used `.maybeSingle()` on (project_id, target_field_id)
    // alone — broken for the post-migration-107 partition uniqueness.
    expect(fn).toMatch(
      /\.eq\('table_mapping_id', tableMappingId\)\s*\n\s*\.maybeSingle\(\)/,
    )
  })

  it('T6: regenerate fires only when caller opts in', () => {
    // The wiring lives inside a conditional, NOT unconditional at the
    // tail of the function. `createMappingFromUnmapped` relies on this
    // gating to avoid double-firing the regenerate.
    expect(fn).toMatch(/if \(regenerateTrigger\)/)
    expect(fn).toMatch(/triggerSource: regenerateTrigger/)
  })

  it('T13: anchor TM resolution sits BEFORE the collision check', () => {
    // Migration 107 widened the unique constraint to include
    // `table_mapping_id`; the collision check therefore needs the
    // resolved `tableMappingId` in scope. We pin the textual order in
    // the slice.
    const anchorIdx = fn.indexOf('Step 5d: anchor table_mapping resolution')
    const collisionIdx = fn.indexOf('Step 6: existing-TFM collision check')
    expect(anchorIdx).toBeGreaterThan(0)
    expect(collisionIdx).toBeGreaterThan(0)
    expect(anchorIdx).toBeLessThan(collisionIdx)
  })

  it('T14: activity log captures `allow_cross_table`', () => {
    expect(fn).toMatch(/allow_cross_table: allowCrossTable/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// T7–T8 — editMappingSources
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.x.1] editMappingSources — cross-table guard', () => {
  const fn = sliceFromTo(
    ACTIONS_SRC,
    'export async function editMappingSources',
    'updateMappingCombination',
  )

  it('T7: accepts `allowCrossTable: boolean` opt with default false', () => {
    expect(fn).toMatch(/allowCrossTable\?: boolean/)
    expect(fn).toMatch(/allowCrossTable = false/)
  })

  it('T8: rejects VALIDATION when sources span multiple tables', () => {
    expect(fn).toMatch(/Step 8b: cross-source-table hard guard/)
    expect(fn).toMatch(/if \(!allowCrossTable\)/)
    expect(fn).toMatch(/uniqueSourceTableIds\.size > 1/)
    expect(fn).toMatch(
      /Sources span multiple source tables[\s\S]*?errorCode: 'VALIDATION'/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// T9–T10 — promoteUnmappedSource
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.x.1] promoteUnmappedSource — cross-table guard (Step 5b)', () => {
  const fn = sliceFromTo(
    ACTIONS_SRC,
    'export async function promoteUnmappedSource',
    'Step 6: clear the source acknowledgment',
  )

  it('T9: accepts `allowCrossTable: boolean` opt with default false', () => {
    expect(fn).toMatch(/allowCrossTable\?: boolean/)
    expect(fn).toMatch(/allowCrossTable = false/)
  })

  it('T10: Step 5b cross-table guard rejects VALIDATION', () => {
    expect(fn).toMatch(/Step 5b': cross-source-table hard guard/)
    expect(fn).toMatch(/if \(!allowCrossTable\)/)
    // Picked source's table_id is read from `fields` and compared
    // against the existing TFM's source_table_id set.
    expect(fn).toMatch(/source_table_id/)
    expect(fn).toMatch(
      /picked source comes from a different table[\s\S]*?errorCode: 'VALIDATION'/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// T11–T12 — Multi-partition canonical ordering
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.x.1] findOrCreateTableMapping — multi-partition canonical default', () => {
  it('T11: orders by partition_ordinal NULLS LAST, created_at, id, limits 1', () => {
    const helper = sliceFromTo(
      ACTIONS_SRC,
      'async function findOrCreateTableMapping(',
      '// ─── Per-target AI Suggest',
    )
    expect(helper).toMatch(
      /\.order\('partition_ordinal', \{ ascending: true, nullsFirst: false \}\)/,
    )
    expect(helper).toMatch(/\.order\('created_at', \{ ascending: true \}\)/)
    expect(helper).toMatch(/\.order\('id', \{ ascending: true \}\)/)
    expect(helper).toMatch(/\.limit\(1\)\s*\n?\s*\.maybeSingle\(\)/)
  })
})

describe('[Ω.3.x.1] non-anchor TM lookup — canonical ordering on recompute path', () => {
  it('T12: same ordering as findOrCreateTableMapping on Step 9 fallback', () => {
    // The Step 9 recompute loop falls back to a lookup for non-anchor
    // TMs — same canonical ordering applies.
    const step9 = sliceFromTo(
      ACTIONS_SRC,
      'Step 9: coverage recompute',
      'Step 10: revalidate',
    )
    expect(step9).toMatch(
      /\.order\('partition_ordinal', \{ ascending: true, nullsFirst: false \}\)/,
    )
    expect(step9).toMatch(/\.limit\(1\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// T15 — Pre-existing regenerate callsites preserved
// ─────────────────────────────────────────────────────────────────────

describe('[Ω.3.x.1] T15 — pre-existing regenerate callsites preserved', () => {
  it('keeps the source_set_edit / source_swap / target_swap / create_from_unmapped wiring', () => {
    expect(ACTIONS_SRC).toMatch(/triggerSource: 'source_set_edit'/)
    expect(ACTIONS_SRC).toMatch(/triggerSource: 'source_swap'/)
    expect(ACTIONS_SRC).toMatch(/triggerSource: 'target_swap'/)
    expect(ACTIONS_SRC).toMatch(/triggerSource: 'create_from_unmapped'/)
  })

  it('only fires create_disambiguated through the createFieldMapping opt-in', () => {
    // We don't want the new trigger leaking into createMappingFromUnmapped
    // or any other existing call site — it's an opt-in, gated by the
    // popup paths only.
    const occurrences =
      ACTIONS_SRC.match(/triggerSource: 'create_disambiguated'/g) ?? []
    // 0 hardcoded; the value flows through the `regenerateTrigger`
    // variable name. Search via `regenerateTrigger,` instead.
    expect(occurrences.length).toBe(0)
    expect(ACTIONS_SRC).toMatch(/triggerSource: regenerateTrigger,/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// findOrCreateTableMapping fallback — pure unit on a stubbed client
// ─────────────────────────────────────────────────────────────────────
//
// The source-grep tests above pin the wire shape. A behavioural test
// on the helper isn't possible here without a Supabase mock harness;
// the multi-partition deterministic-pick behaviour is enforced by the
// SQL `ORDER BY` + `LIMIT 1`, which is locked above.
