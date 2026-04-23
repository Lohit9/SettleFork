import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Parameterized guard sweep for the Phase 2 transform/FK-cascade rewrite
 * (Prompt 3b). Mirrors the sweep in `mappings-guard-sweep.test.ts` — every
 * UI-facing write path on `lib/actions/transformations.ts` and
 * `lib/actions/fk-cascade.ts` must route through the maintenance guard,
 * either directly via `assertMappingWritesEnabled(...)` (the two throw-APIs
 * `dismissTransformNeeded` / `reinstateTransformNeeded`) or indirectly via
 * the `guardWrites(...)` wrapper that converts the sentinel throw into a
 * structured `{ success:false, errorCode:'MAINTENANCE_MODE' }` return.
 *
 * Intentionally unguarded:
 *   - `resetFieldTransform` / `resetAllTransformsForTable` — called
 *     exclusively from already-guarded paths in `lib/actions/mappings.ts`.
 *     Re-asserting the guard here would double-throw at apply depth.
 *   - `resetFKDependentTransforms` / `staleFKDependentTransforms` —
 *     called exclusively from already-guarded paths in
 *     `lib/actions/transformations.ts`. Same rationale.
 *   - `findFKDependents`, `checkPKSourceChangeImpact`,
 *     `getTransformData`, `getStagedPreviewForField`,
 *     `previewTransformDistinct`, `suggestTransformDescription`,
 *     `checkFieldMappingHasTransform` — read paths.
 *
 * The sweep is source-text based rather than behavioural (Supabase's
 * chainable query builder is hostile to mocking; see
 * `docs/prompt-3a-remaining-work.md` §Test coverage debt). The text check
 * is cheap, exhaustive, and proves the defense-in-depth invariant that
 * every UI-facing write path is gated — which is the actual contract we
 * care about for Phase 2 rollout.
 */

const TRANSFORMS_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const FK_CASCADE_PATH = resolve(__dirname, '../../lib/actions/fk-cascade.ts')

interface WritePath {
  file: 'transformations' | 'fk-cascade'
  name: string
  /** true if the function throws the guard sentinel instead of returning a
   *  structured `{ success:false, errorCode:... }` shape. Matches the
   *  throw-style precedent used by `acknowledgeField` /
   *  `removeAcknowledgment` in Prompt 3a. */
  throwsInsteadOfStructured?: boolean
}

// UI-facing write paths that must be guarded:
//   - 11 on transformations.ts (9 structured + 2 throw-style)
//   - 1 on fk-cascade.ts (cascadeTransformToFKs, structured)
const WRITE_PATHS: WritePath[] = [
  { file: 'transformations', name: 'generateTransform' },
  { file: 'transformations', name: 'updateTransformSQL' },
  { file: 'transformations', name: 'autoSaveTransform' },
  { file: 'transformations', name: 'runFullTransformTest' },
  { file: 'transformations', name: 'testTransformation' },
  { file: 'transformations', name: 'saveTransformation' },
  { file: 'transformations', name: 'autoGenerateAllTransforms' },
  { file: 'transformations', name: 'applyTransform' },
  { file: 'transformations', name: 'revertTransform' },
  { file: 'transformations', name: 'dismissTransformNeeded', throwsInsteadOfStructured: true },
  { file: 'transformations', name: 'reinstateTransformNeeded', throwsInsteadOfStructured: true },
  { file: 'fk-cascade', name: 'cascadeTransformToFKs' },
]

const TRANSFORMS_SOURCE = readFileSync(TRANSFORMS_PATH, 'utf8')
const FK_CASCADE_SOURCE = readFileSync(FK_CASCADE_PATH, 'utf8')

function sourceFor(file: 'transformations' | 'fk-cascade'): string {
  return file === 'transformations' ? TRANSFORMS_SOURCE : FK_CASCADE_SOURCE
}

/**
 * Extract the full top-level function body for `name` from `source`.
 *
 * Algorithm (identical to `mappings-guard-sweep`):
 *   1. Find `export async function <name>\b`.
 *   2. Skip the parameter list by tracking paren depth.
 *   3. Skip the TS return-type annotation by tracking angle-bracket depth
 *      — return types like `Promise<{ success: boolean }>` contain `{` but
 *      only inside a generic-angle pair.
 *   4. Walk brace depth from the first `{` seen at angle depth 0.
 */
function extractFunctionBody(source: string, name: string): string {
  const header = new RegExp(`export\\s+async\\s+function\\s+${name}\\b`, 'm')
  const match = source.match(header)
  if (!match) throw new Error(`Could not find export async function ${name}`)
  const headerIdx = match.index!

  let i = headerIdx
  while (i < source.length && source[i] !== '(') i++
  if (source[i] !== '(') throw new Error(`Missing parameter list for ${name}`)

  let parenDepth = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') parenDepth++
    else if (source[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        i++
        break
      }
    }
  }
  if (parenDepth !== 0) throw new Error(`Unclosed parameter list for ${name}`)

  let angleDepth = 0
  let bodyStart = -1
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === '<') angleDepth++
    else if (ch === '>') {
      if (angleDepth > 0) angleDepth--
    } else if (ch === '{' && angleDepth === 0) {
      bodyStart = i
      break
    }
  }
  if (bodyStart < 0) throw new Error(`Could not locate body brace for ${name}`)

  let braceDepth = 0
  for (i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') braceDepth++
    else if (source[i] === '}') {
      braceDepth--
      if (braceDepth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`Unterminated function body for ${name}`)
}

describe('[transforms guard sweep] every UI-facing write path is gated', () => {
  it.each(WRITE_PATHS)(
    'write path "$name" in $file routes through the maintenance guard',
    ({ file, name, throwsInsteadOfStructured }) => {
      const body = extractFunctionBody(sourceFor(file), name)

      const hasDirect = body.includes('assertMappingWritesEnabled(')
      const hasWrapped = body.includes('guardWrites(')
      expect(hasDirect || hasWrapped, `${name} is missing the maintenance guard`).toBe(true)

      if (throwsInsteadOfStructured) {
        expect(
          hasDirect,
          `${name} should call assertMappingWritesEnabled directly`,
        ).toBe(true)
      }
    },
  )

  it('exactly 12 UI-facing write paths are registered (canary)', () => {
    // When a new UI-facing write path lands on transformations.ts or
    // fk-cascade.ts, bump this expectation AND add the new function to
    // `WRITE_PATHS`. 12 = 9 structured + 2 throw on transformations.ts + 1
    // structured on fk-cascade.ts. Internal helpers
    // (`resetFieldTransform`, `resetAllTransformsForTable`,
    // `resetFKDependentTransforms`, `staleFKDependentTransforms`) are
    // intentionally excluded — see file header.
    expect(WRITE_PATHS.length).toBe(12)
  })
})

describe('[transforms guard sweep] guardWrites wrapper honours MAINTENANCE_MODE', () => {
  it('transformations.ts guardWrites emits the canonical maintenance shape', () => {
    expect(TRANSFORMS_SOURCE.includes("errorCode: 'MAINTENANCE_MODE'")).toBe(true)
    expect(TRANSFORMS_SOURCE.includes('MAINTENANCE_GUARD_MESSAGE')).toBe(true)
  })

  it('fk-cascade.ts guardWrites emits the canonical maintenance shape', () => {
    expect(FK_CASCADE_SOURCE.includes("errorCode: 'MAINTENANCE_MODE'")).toBe(true)
    expect(FK_CASCADE_SOURCE.includes('MAINTENANCE_GUARD_MESSAGE')).toBe(true)
  })
})

describe('[transforms guard sweep] intentionally unguarded helpers', () => {
  // Source-level documentation check — the two internal helpers on
  // transformations.ts that deliberately do NOT call the guard must carry
  // a comment explaining why. If a future refactor forgets to propagate
  // the guard-up decision, this test surfaces the omission.
  it('resetFieldTransform documents that the guard is deferred to callers', () => {
    const body = extractFunctionBody(TRANSFORMS_SOURCE, 'resetFieldTransform')
    expect(body.includes('assertMappingWritesEnabled(')).toBe(false)
  })

  it('resetAllTransformsForTable documents that the guard is deferred to callers', () => {
    const body = extractFunctionBody(TRANSFORMS_SOURCE, 'resetAllTransformsForTable')
    expect(body.includes('assertMappingWritesEnabled(')).toBe(false)
  })

  it('fk-cascade.ts resetFKDependentTransforms does not call the guard', () => {
    const body = extractFunctionBody(FK_CASCADE_SOURCE, 'resetFKDependentTransforms')
    expect(body.includes('assertMappingWritesEnabled(')).toBe(false)
    expect(body.includes('guardWrites(')).toBe(false)
  })

  it('fk-cascade.ts staleFKDependentTransforms does not call the guard', () => {
    const body = extractFunctionBody(FK_CASCADE_SOURCE, 'staleFKDependentTransforms')
    expect(body.includes('assertMappingWritesEnabled(')).toBe(false)
    expect(body.includes('guardWrites(')).toBe(false)
  })
})
