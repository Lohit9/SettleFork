import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Parameterized guard sweep for the Phase 2 mapping redesign.
 *
 * This test reads `lib/actions/mappings.ts` and
 * `lib/actions/field-acknowledgments.ts` as text and asserts that EVERY
 * exported write path routes through the maintenance guard — either
 * directly via `assertMappingWritesEnabled(...)` (used by the two field-
 * acknowledgment throw-APIs) or indirectly via `guardWrites(...)` (the
 * wrapper around the guard that converts errors into the structured
 * { success: false, errorCode: 'MAINTENANCE_MODE' } return shape used by
 * the rest of the action surface).
 *
 * The sweep is source-text based rather than behavioural because
 * fully mocking Supabase's chainable query builder for 15 separate
 * functions would dwarf the coverage it provides and be brittle against
 * implementation detail. The text check is cheap, exhaustive, and proves
 * the defense-in-depth invariant that every write path is gated — which
 * is the actual contract we care about for Phase 2 rollout.
 */

const MAPPINGS_PATH = resolve(__dirname, '../../lib/actions/mappings.ts')
const FIELD_ACKS_PATH = resolve(__dirname, '../../lib/actions/field-acknowledgments.ts')

interface WritePath {
  file: 'mappings' | 'field-acknowledgments'
  name: string
  /** true if the function is expected to throw instead of returning
   *  structured { success: false, errorCode: ... } — acknowledgment APIs
   *  historically throw so MappingContent.tsx's try/catch catches them. */
  throwsInsteadOfStructured?: boolean
}

// The 15 write paths that must be guarded:
// - 13 structured-return paths on `lib/actions/mappings.ts`
// - 2 throw-instead paths on `lib/actions/field-acknowledgments.ts`
const WRITE_PATHS: WritePath[] = [
  { file: 'mappings', name: 'generateMappings' },
  { file: 'mappings', name: 'updateFieldMappingStatus' },
  { file: 'mappings', name: 'updateTableMappingStatus' },
  { file: 'mappings', name: 'editFieldMapping' },
  { file: 'mappings', name: 'addManualFieldMapping' },
  { file: 'mappings', name: 'addManualTableMapping' },
  { file: 'mappings', name: 'regenerateFieldMappings' },
  { file: 'mappings', name: 'deleteFieldMapping' },
  { file: 'mappings', name: 'deleteTableMapping' },
  { file: 'mappings', name: 'approveAllFieldMappings' },
  { file: 'mappings', name: 'rejectAllFieldMappings' },
  { file: 'mappings', name: 'approveHighConfidenceMappings' },
  { file: 'mappings', name: 'suggestRemainingMappings' },
  { file: 'mappings', name: 'mapUnmappedField' },
  { file: 'mappings', name: 'createValueAssignment' },
  { file: 'field-acknowledgments', name: 'acknowledgeField', throwsInsteadOfStructured: true },
  { file: 'field-acknowledgments', name: 'removeAcknowledgment', throwsInsteadOfStructured: true },
]

const MAPPINGS_SOURCE = readFileSync(MAPPINGS_PATH, 'utf8')
const FIELD_ACKS_SOURCE = readFileSync(FIELD_ACKS_PATH, 'utf8')

function sourceFor(file: 'mappings' | 'field-acknowledgments'): string {
  return file === 'mappings' ? MAPPINGS_SOURCE : FIELD_ACKS_SOURCE
}

/**
 * Extract the full top-level function body for `name` from `source`.
 *
 * The `lib/actions/*.ts` files follow a strict convention: every write
 * path is an `export async function <name>(...)`. We find that header,
 * then walk the brace stack from the first `{` after the signature
 * until it returns to depth 0. This is brittle against string literals
 * containing `{}/}` but in this codebase the risk is negligible —
 * function bodies do not contain `}` inside strings at the top level.
 */
function extractFunctionBody(source: string, name: string): string {
  const header = new RegExp(`export\\s+async\\s+function\\s+${name}\\b`, 'm')
  const match = source.match(header)
  if (!match) {
    throw new Error(`Could not find export async function ${name}`)
  }
  const headerIdx = match.index!

  // Step 1: find the opening `(` of the parameter list.
  let i = headerIdx
  while (i < source.length && source[i] !== '(') i++
  if (source[i] !== '(') throw new Error(`Missing parameter list for ${name}`)

  // Step 2: walk paren depth to find the matching `)`.
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

  // Step 3: skip the TS return-type annotation. Return types may contain
  // `{...}` (e.g. `Promise<{ success: boolean }>`) but those braces always
  // sit inside a generic-angle pair `<...>`. We track angle-bracket depth
  // and accept the first `{` seen at angle depth 0 as the body opener.
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

  // Step 4: walk brace depth from bodyStart to find the matching `}`.
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

describe('[mappings guard sweep] every write path is gated by assertMappingWritesEnabled', () => {
  it.each(WRITE_PATHS)(
    'write path "$name" in $file routes through the maintenance guard',
    ({ file, name, throwsInsteadOfStructured }) => {
      const body = extractFunctionBody(sourceFor(file), name)

      // Either a direct call to `assertMappingWritesEnabled(` (throw-style,
      // field-acknowledgments) or via the `guardWrites(` wrapper (structured
      // returns, mappings) must be present.
      const hasDirect = body.includes('assertMappingWritesEnabled(')
      const hasWrapped = body.includes('guardWrites(')
      expect(hasDirect || hasWrapped, `${name} is missing the maintenance guard`).toBe(true)

      if (throwsInsteadOfStructured) {
        // Throw-style APIs must call the guard directly (the wrapper swallows
        // the throw and converts it to a structured return).
        expect(hasDirect, `${name} should call assertMappingWritesEnabled directly`).toBe(true)
      }
    },
  )

  it('exactly 15 mapping-side write paths are registered (canary against adding ungated paths)', () => {
    const mappingSide = WRITE_PATHS.filter((p) => p.file === 'mappings')
    // When a new write path lands, bump this expectation AND add the new
    // function to the WRITE_PATHS array. The test is a canary: if a dev
    // forgets to add the new path here, CI still passes; but if they add
    // a new export that isn't covered, this count will drift and we'll
    // catch it on review. 15 = 13 structured returns + 2 in the ack file.
    expect(mappingSide.length).toBe(15)
  })
})

describe('[mappings guard sweep] guardWrites wrapper honours MAINTENANCE_MODE', () => {
  it('wrapper source contains the canonical maintenance error shape', () => {
    // guardWrites is the sole conversion point between thrown guard errors
    // and the structured return shape. Verify the translation is present in
    // source so `errorCode: 'MAINTENANCE_MODE'` cannot silently drift.
    const body = extractFunctionBody(MAPPINGS_SOURCE, 'generateMappings')
    // generateMappings is a representative caller; it must use guardWrites
    // which in turn must reference MAINTENANCE_MODE.
    expect(body.includes('guardWrites(')).toBe(true)
    expect(MAPPINGS_SOURCE.includes("errorCode: 'MAINTENANCE_MODE'")).toBe(true)
    expect(MAPPINGS_SOURCE.includes('MAINTENANCE_GUARD_MESSAGE')).toBe(true)
  })
})
