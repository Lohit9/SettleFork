/**
 * Guard against re-introduction of the retired legacy
 * `Transformation` interface (Prompt 3d, Step 3D-13, Gate 2 §3.2).
 *
 * Prompt 3d Step 3D-12 retired `export interface Transformation`
 * from `lib/types/database.ts`. Consumers now read the new-model
 * row shape `TransformationRow` from `lib/types/mapping-redesign.ts`
 * directly — its FK column is `target_field_mapping_id` to match
 * migration 074.
 *
 * If the interface is reintroduced, downstream readers will silently
 * start projecting through the legacy `field_mapping_id` shape (either
 * via the adapter or via a fresh hand-written type), which is exactly
 * the "semantic lie" dependency we spent Phase 2 eliminating. This
 * test locks the deletion in place.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const DATABASE_TS = resolve(REPO_ROOT, 'lib/types/database.ts')

describe('[codebase guard] no legacy Transformation type', () => {
  const raw = readFileSync(DATABASE_TS, 'utf-8')

  // Strip block comments + line comments so a retirement note
  // describing the deleted interface does not trigger the guard.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('lib/types/database.ts has no `interface Transformation` declaration', () => {
    // Matches `interface Transformation` or `export interface Transformation`
    // as a declaration (requires whitespace after to avoid partial-name
    // collisions with `interface TransformationRow` or similar).
    expect(code).not.toMatch(/\binterface\s+Transformation\s*[{<]/)
  })

  it('lib/types/database.ts has no `export interface Transformation` declaration', () => {
    expect(code).not.toMatch(/\bexport\s+interface\s+Transformation\s*[{<]/)
  })

  it('lib/types/database.ts contains the retirement note pointing readers at TransformationRow', () => {
    // The retirement note lives in a comment, so we read the raw
    // source for this check (not the stripped view). Drift-guard:
    // if someone deletes the note, readers lose the breadcrumb to
    // `lib/types/mapping-redesign.ts :: TransformationRow` and the
    // "why was this removed" history vanishes.
    expect(raw).toMatch(/TransformationRow/)
    expect(raw).toMatch(/mapping-redesign/)
    expect(raw).toMatch(/Prompt 3d,?\s*Step 3D-12/)
  })

  it('adjacent `Output` interface is preserved (sanity — the deletion was surgical)', () => {
    expect(code).toMatch(/\bexport\s+interface\s+Output\s*\{/)
  })
})
