// @vitest-environment node
//
// Source-level invariants for lib/utils/upload-helpers.ts. The runtime
// XHR flow is hard to test cleanly in a node env (jsdom's XMLHttpRequest
// implementation doesn't fire upload-progress events), so we pin the
// structural commitments via regex on the source file. Together with the
// IngestionCard manual smoke-test (PR safety Rule 1), these invariants
// guarantee the upload helper has the right shape on disk.
//
// Invariants:
//   UH1.  lib/utils/upload-helpers.ts exports `uploadToSignedUrl`.
//   UH2.  Implementation uses XMLHttpRequest, not fetch (fetch lacks
//         upload-progress events; switching would silently break the
//         progress UX).
//   UH3.  Implementation wires `xhr.upload.addEventListener('progress',
//         ...)` so the browser fires per-chunk progress for the bar.
//   UH4.  Implementation uses HTTP PUT (Supabase signed-URL contract).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const SRC = readFileSync(resolve(ROOT, 'lib/utils/upload-helpers.ts'), 'utf8')

describe('[upload-helpers] UH1-UH4 source-level invariants', () => {
  it('UH1: exports uploadToSignedUrl', () => {
    expect(SRC).toMatch(/export\s+(?:async\s+)?function\s+uploadToSignedUrl\b/)
  })

  it('UH2: uses XMLHttpRequest (NOT fetch)', () => {
    expect(SRC).toMatch(/new\s+XMLHttpRequest\(\)/)
    // Negative pin: no fetch() call in the upload path. Doc-comment
    // mentions of fetch are allowed (the file's header explains why we
    // avoided it), but no actual call.
    expect(SRC).not.toMatch(/^\s*(?:await\s+)?fetch\(/m)
  })

  it('UH3: wires xhr.upload.addEventListener("progress", ...)', () => {
    expect(SRC).toMatch(
      /xhr\.upload\.addEventListener\(\s*['"]progress['"]/,
    )
  })

  it('UH4: opens with PUT method', () => {
    expect(SRC).toMatch(/xhr\.open\(\s*['"]PUT['"]/)
  })
})
