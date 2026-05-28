/**
 * Rootstock loader source-shape guards — LSS1–5 (PR Ω.3.6 §6).
 *
 * Read scripts/load-rootstock-spec.ts and scripts/rootstock-partitions.ts
 * as text and assert that the partition-aware contract from commit 1
 * cannot regress without tripping CI. Mirrors the source-grep pattern
 * used by:
 *   - tests/lib/no-shim-in-redesign-path.test.ts (redesign guard)
 *   - tests/lib/url-params-guard.test.ts (URL-param back-compat)
 *   - tests/actions/partitions-actions.test.ts (Ω.3.1 P10 source check)
 *
 * Cheap: no DB, no imports of the script (avoids running main()), runs
 * in CI on every PR.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')

const LOADER_SRC = readFileSync(
  resolve(REPO_ROOT, 'scripts/load-rootstock-spec.ts'),
  'utf-8',
)
const PARTITIONS_SRC = readFileSync(
  resolve(REPO_ROOT, 'scripts/rootstock-partitions.ts'),
  'utf-8',
)

// ─── LSS1 — three hardcoded partition labels present ────────────────────

describe('[loader source-shape] LSS1 — partition labels hardcoded', () => {
  it('declares all 3 EIM partition labels in scripts/rootstock-partitions.ts', () => {
    expect(PARTITIONS_SRC).toMatch(/label:\s*['"]Engineering Parents['"]/)
    expect(PARTITIONS_SRC).toMatch(/label:\s*['"]Products Catalog['"]/)
    expect(PARTITIONS_SRC).toMatch(/label:\s*['"]Engineering Components['"]/)
  })
})

// ─── LSS2 — explicit ordinal assignment 0 / 1 / 2 ───────────────────────

describe('[loader source-shape] LSS2 — partition_ordinal assignment', () => {
  it('declares ordinals 0, 1, 2 on the EIM_PARTITIONS const', () => {
    expect(PARTITIONS_SRC).toMatch(/ordinal:\s*0/)
    expect(PARTITIONS_SRC).toMatch(/ordinal:\s*1/)
    expect(PARTITIONS_SRC).toMatch(/ordinal:\s*2/)
  })

  it('emits partition_ordinal to the TM row in load-rootstock-spec.ts Phase 6.5', () => {
    expect(LOADER_SRC).toMatch(/partition_ordinal:\s*p\.ordinal/)
  })
})

// ─── LSS3 — dedup_priority 0 / 1 / 2 emitted ────────────────────────────

describe('[loader source-shape] LSS3 — dedup_priority assignment', () => {
  it('declares dedupPriority 0, 1, 2 on the EIM_PARTITIONS const', () => {
    expect(PARTITIONS_SRC).toMatch(/dedupPriority:\s*0/)
    expect(PARTITIONS_SRC).toMatch(/dedupPriority:\s*1/)
    expect(PARTITIONS_SRC).toMatch(/dedupPriority:\s*2/)
  })

  it('emits dedup_priority to the TM row in load-rootstock-spec.ts Phase 6.5', () => {
    expect(LOADER_SRC).toMatch(/dedup_priority:\s*p\.dedupPriority/)
  })
})

// ─── LSS4 — identity_field_id resolved from 'Item Number' on EIM ────────

describe('[loader source-shape] LSS4 — identity_field_id wiring', () => {
  it('declares the identity field name constant in rootstock-partitions.ts', () => {
    expect(PARTITIONS_SRC).toMatch(
      /EIM_IDENTITY_TARGET_FIELD_NAME\s*=\s*['"]Item Number['"]/,
    )
  })

  it('Phase 6.5 resolves the identity field via resolveTarget(EIM, identity)', () => {
    // Loose match — allows trailing comma (prettier multi-line formatting)
    // between args and the closing paren.
    expect(LOADER_SRC).toMatch(
      /resolveTarget\(\s*EIM_TARGET_TABLE,\s*EIM_IDENTITY_TARGET_FIELD_NAME,?\s*\)/,
    )
  })

  it('Phase 6.5 wires the EIM identity onto TM rows via identityFieldId', () => {
    // PR Ω.3.9: identity_field_id is now computed per-partition
    // (EIM uses eimIdentityResolved.fieldId; ICC uses null). Both halves
    // of the wiring must be present.
    expect(LOADER_SRC).toMatch(
      /p\.targetTableName\s*===\s*EIM_TARGET_TABLE\s*\?\s*eimIdentityResolved\.fieldId\s*:\s*null/,
    )
    expect(LOADER_SRC).toMatch(/identity_field_id:\s*identityFieldId/)
  })
})

// ─── LSS5 — TM upsert keyed on (project_id, target_table_id, partition_label) ──

describe('[loader source-shape] LSS5 — partition idempotency contract', () => {
  it('Phase 6.5 uses upsert with onConflict on the partition-uniqueness tuple', () => {
    expect(LOADER_SRC).toMatch(
      /onConflict:\s*['"]project_id,target_table_id,partition_label['"]/,
    )
  })

  it('does NOT use the legacy plain insert + (source, target) pair keying anywhere in Phase 6.5', () => {
    // The pre-Ω.3.6 path inserted TMs without partition awareness. Make
    // sure no stale `tablePairs` reference survives — if a refactor
    // reintroduces it, this guard catches it before the loader silently
    // collapses Parents + Components into a single TM.
    expect(LOADER_SRC).not.toMatch(/tablePairs/)
  })

  it('TFM upsert keeps the partition-aware composite key from Ω.3.1', () => {
    expect(LOADER_SRC).toMatch(
      /onConflict:\s*['"]project_id,target_field_id,table_mapping_id['"]/,
    )
  })

  it('Phase 7 selects table_mapping_id from the upsert return so Phase 8 can index by composite', () => {
    expect(LOADER_SRC).toMatch(
      /\.select\(\s*['"]id,\s*target_field_id,\s*table_mapping_id['"]\s*\)/,
    )
  })
})

// ─── Bonus — router invocation contract ──────────────────────────────────

describe('[loader source-shape] router wiring', () => {
  it('Phase 5 calls routePartition() for both mapped and VA entries', () => {
    // Two distinct call sites — mapped loop + VA loop. Count them.
    const matches = LOADER_SRC.match(/routePartition\(/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('Phase 5 no longer skips ICC entries (PR Ω.3.9 reversed Option A)', () => {
    // The skip counters and their branches were removed when ICC was
    // promoted to a non-partitioned target table loaded alongside EIM.
    // Anti-grep — these strings must not reappear.
    expect(LOADER_SRC).not.toMatch(/skippedIccCount/)
    expect(LOADER_SRC).not.toMatch(/skippedIccVaCount/)
    expect(LOADER_SRC).not.toMatch(/ICC entries skipped/)
  })

  it('Phase 6.5 writes the ICC non-partitioned TM alongside EIM partitions', () => {
    // ICC is a single non-partitioned TM; the writer iterates
    // [...EIM_PARTITIONS, ICC_PARTITION] and the ai_reasoning branch
    // distinguishes partitioned from non-partitioned text.
    expect(LOADER_SRC).toMatch(/\[\.\.\.EIM_PARTITIONS,\s*ICC_PARTITION\]/)
    expect(LOADER_SRC).toMatch(/\(non-partitioned\)/)
  })

  it('summary printout reports per-partition TFM counts (not pre-Ω.3.6 per-target)', () => {
    expect(LOADER_SRC).toMatch(/TFMs \(mapped, per partition\)/)
  })
})
