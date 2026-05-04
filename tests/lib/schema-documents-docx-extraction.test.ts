// @vitest-environment node
//
// Source-level invariants for the .docx text-extraction wiring added
// to lib/actions/schema-documents.ts (PR feat/docx-schema-extraction).
// Closes the silent-ignore gap where .docx schema documents were
// accepted by the upload validator but never extracted to text.
//
// Invariants:
//   DOCX1.  package.json declares mammoth as a runtime dependency.
//   DOCX2.  schema-documents.ts has a `.docx` branch that imports
//           mammoth dynamically AND calls `mammoth.extractRawText`.
//   DOCX3.  Symmetric coverage: BOTH extraction paths in schema-
//           documents.ts (uploadSchemaDocument + uploadBusinessContextDoc)
//           handle `.docx`. Asymmetric coverage would create a bug
//           surface where one upload entry routes .docx through AI
//           enrichment and the other silently drops it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const PACKAGE_JSON = read('package.json')
const SCHEMA_DOCUMENTS = read('lib/actions/schema-documents.ts')

describe('[docx schema extraction] DOCX1-DOCX3 source-level invariants', () => {
  it('DOCX1: package.json declares mammoth as a dependency', () => {
    expect(PACKAGE_JSON).toMatch(
      /["']mammoth["']\s*:\s*["'][^"']+["']/,
    )
  })

  it('DOCX2: schema-documents.ts has a .docx branch that dynamically imports mammoth AND calls extractRawText', () => {
    // The dynamic import. mammoth is heavy at module-load time, so we
    // import lazily inside the extraction branch (same pattern as
    // unpdf and lib/parsers/excel above).
    expect(SCHEMA_DOCUMENTS).toMatch(/await\s+import\(\s*['"]mammoth['"]\s*\)/)
    // The extraction call. Pin the function name so a future refactor
    // that swaps mammoth for another lib forces an explicit invariant
    // update rather than silently changing the contract.
    expect(SCHEMA_DOCUMENTS).toMatch(
      /mammoth\.extractRawText\(\s*\{\s*buffer\s*\}\s*\)/,
    )
    // The branch is keyed on the .docx extension specifically — pin
    // this so a future widening that also matches .doc (legacy binary
    // Word) doesn't silently produce empty extracts (mammoth only
    // supports .docx).
    expect(SCHEMA_DOCUMENTS).toMatch(/ext\s*===\s*['"]\.docx['"]/)
  })

  it('DOCX3: both extraction paths (uploadSchemaDocument + uploadBusinessContextDoc) handle .docx symmetrically', () => {
    // Asymmetric coverage between the two upload entry points would
    // be a class-of-cases bug (same shape as Issue 2 from PR #62/#68
    // — both routes must mirror their format-detection branches).
    // The two functions are co-located in this file; both should call
    // mammoth.extractRawText, so we expect at least 2 matches.
    const matches =
      SCHEMA_DOCUMENTS.match(/mammoth\.extractRawText/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
    // Each branch lives downstream of its own function declaration.
    // Slice the file at the second uploadBusinessContextDoc symbol
    // and verify the .docx branch appears in the second slice too.
    const splitMarker = SCHEMA_DOCUMENTS.indexOf(
      'uploadBusinessContextDoc',
    )
    expect(splitMarker).toBeGreaterThan(-1)
    // Find the FUNCTION-DEFINITION occurrence (not the doc-comment
    // mention). We want a `function uploadBusinessContextDoc` or
    // `async function uploadBusinessContextDoc` declaration.
    const fnDeclIdx = SCHEMA_DOCUMENTS.search(
      /function\s+uploadBusinessContextDoc\b/,
    )
    expect(fnDeclIdx).toBeGreaterThan(-1)
    const businessSlice = SCHEMA_DOCUMENTS.slice(fnDeclIdx)
    expect(businessSlice).toMatch(/ext\s*===\s*['"]\.docx['"]/)
    expect(businessSlice).toMatch(/mammoth\.extractRawText/)
  })
})
