/**
 * Rootstock loader Phase 6.25 (field descriptions) — source-shape guards.
 *
 * Mirrors tests/scripts/load-rootstock-spec-source-shape.test.ts: reads
 * load-rootstock-spec.ts as text and asserts the structural invariants
 * of Phase 6.25 so the contract from PR Ω.3.7.5 cannot regress silently.
 *
 * Cheap (no DB, no script invocation, runs in CI on every PR). The pure
 * extraction function itself is covered by
 * tests/scripts/rootstock-descriptions.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')

const LOADER_SRC = readFileSync(
  resolve(REPO_ROOT, 'scripts/load-rootstock-spec.ts'),
  'utf-8',
)

function loaderRegion(startMarker: string, endMarker: string): string {
  const start = LOADER_SRC.indexOf(startMarker)
  const end = LOADER_SRC.indexOf(endMarker)
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThan(-1)
  expect(end, `marker not found: ${endMarker}`).toBeGreaterThan(start)
  return LOADER_SRC.slice(start, end)
}

describe('load-rootstock-spec Phase 6.25 (field descriptions)', () => {
  it('declares the Phase 6.25 section header', () => {
    expect(LOADER_SRC).toMatch(/Phase 6\.25: write fields\.description/)
  })

  it('imports extractTargetFieldDescription from rootstock-descriptions', () => {
    expect(LOADER_SRC).toMatch(
      /import \{ extractTargetFieldDescription \} from '\.\/rootstock-descriptions'/,
    )
  })

  it('positions Phase 6.25 between Phase 6 (--force wipe) and Phase 6.5 (partition TMs)', () => {
    const phase6 = LOADER_SRC.indexOf('Phase 6: --force wipe')
    const phase625 = LOADER_SRC.indexOf('Phase 6.25: write fields.description')
    const phase65 = LOADER_SRC.indexOf(
      'Phase 6.5: bulk UPSERT table_mappings',
    )
    expect(phase6).toBeGreaterThan(-1)
    expect(phase625).toBeGreaterThan(phase6)
    expect(phase65).toBeGreaterThan(phase625)
  })

  it('gates each UPDATE on description IS NULL (Decision D1 — overwrite guard)', () => {
    const block = loaderRegion(
      'Phase 6.25: write fields.description',
      'Phase 6.5: bulk UPSERT',
    )
    expect(block).toMatch(/\.is\('description', null\)/)
  })

  it('drops source-ack entries (target_table === Unmapped) before grouping', () => {
    const block = loaderRegion(
      'Phase 6.25: write fields.description',
      'Phase 6.5: bulk UPSERT',
    )
    expect(block).toMatch(/e\.target_table === 'Unmapped'/)
  })

  it('targets the `fields` table for the UPDATE (not target_fields or other tables)', () => {
    const block = loaderRegion(
      'Phase 6.25: write fields.description',
      'Phase 6.5: bulk UPSERT',
    )
    expect(block).toMatch(/\.from\('fields'\)/)
    // Defense against an accidental rename to the legacy table name.
    expect(block).not.toMatch(/\.from\('target_fields'\)/)
  })

  it('groups entries by (target_table, target_field) using the same delimiter as Phase 5', () => {
    const block = loaderRegion(
      'Phase 6.25: write fields.description',
      'Phase 6.5: bulk UPSERT',
    )
    // groupKey = `${target_table}|${target_field}` — split() must use '|'.
    expect(block).toMatch(/`\$\{e\.target_table\}\|\$\{e\.target_field\}`/)
    expect(block).toMatch(/groupKey\.split\('\|'\)/)
  })
})
