/**
 * Golden-output fixture helper.
 *
 * Two modes controlled by the UPDATE_FIXTURES env var:
 *
 *   Default (UPDATE_FIXTURES unset / not '1'):
 *     Read the expected file from disk, compare against actual content.
 *     Test fails if they differ.
 *
 *   UPDATE_FIXTURES=1:
 *     Overwrite the expected file with actual content. Test always passes.
 *     This is the regeneration mode — use only when you intentionally want
 *     every fixture to pick up the current output.
 *
 * Both `actual` and the fixture content are passed through `redactVariableContent`
 * before comparison, normalizing known non-deterministic patterns
 * (timestamps, locale dates) to stable tokens. See the function's comment
 * block for the complete list of redactions and their rationale.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'vitest'

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/outputs')
const UPDATE = process.env.UPDATE_FIXTURES === '1'

/**
 * Normalize known runtime-variable content so that fixtures are byte-stable
 * across machines, time zones, and clock time.
 *
 * Every redaction below comes from the R2 determinism audit performed at
 * Gate 3 of Prompt 3c. If you add a new redaction, document:
 *   - Where the variable content originates (file + line)
 *   - Why the variable content is necessary in production output
 *   - What token replaces it (keep tokens human-readable like <ISO_TIMESTAMP>)
 *
 * Order matters: more specific patterns must match before more general ones
 * (e.g. ISO timestamps before locale dates, otherwise an ISO timestamp's
 * date prefix would be redacted as a locale date).
 */
export function redactVariableContent(text: string): string {
  let out = text

  // ── ISO 8601 timestamps ───────────────────────────────────────────────
  // Emitted by `new Date().toISOString()` in:
  //   - lib/actions/execution-package.ts userMessage ("Generated: ${now}")
  //   - lib/actions/outputs.ts JSON "generated_at" values and CSV/SQL headers
  // Production need: customer-visible "when was this generated" line.
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, '<ISO_TIMESTAMP>')

  // ── UTC date strings ─────────────────────────────────────────────────
  // Emitted by `new Date().toUTCString()` in lib/actions/outputs.ts file
  // headers (CSV, readiness DOCX, transform specs, mapping file).
  // Production need: same "when" disclosure, Word-friendly format.
  out = out.replace(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g,
    '<UTC_TIMESTAMP>',
  )

  // ── Locale-formatted short dates (e.g. "6/13/2026", "13/06/2026") ────
  // Emitted by `new Date(applied_at).toLocaleDateString()` in
  //   - lib/actions/outputs.ts readiness-report fixHistoryDetail
  // Locale-dependent: CI may render US-en, UK-en, or ISO format depending
  // on the runner's LC_TIME. Redaction makes the fixture stable without
  // changing production behavior.
  //
  // IMPORTANT: this regex deliberately does not match 4-digit year leading
  // format ("2026-04-22") because those are ISO dates handled above.
  out = out.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, '<LOCALE_DATE>')

  return out
}

/**
 * Assert that `actual` matches the fixture file. Variable content is redacted
 * before comparison on both sides.
 *
 * Paths are relative to `tests/fixtures/outputs/`.
 */
export function assertMatchesFixture(actual: string, fixtureRelPath: string): void {
  const fullPath = path.join(FIXTURES_DIR, fixtureRelPath)
  const redactedActual = redactVariableContent(actual)

  if (UPDATE) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    // When regenerating, we write the REDACTED actual so that the fixture
    // file itself contains the stable tokens. Otherwise the first commit
    // after regeneration would contain a timestamp, and the next CI run
    // (with a different timestamp) would fail.
    fs.writeFileSync(fullPath, redactedActual, 'utf8')
    return
  }

  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Fixture not found: ${fullPath}\n\n` +
        `Run with UPDATE_FIXTURES=1 to create it. See ` +
        `tests/fixtures/outputs/README.md for the change process.`,
    )
  }

  const expected = fs.readFileSync(fullPath, 'utf8')
  const redactedExpected = redactVariableContent(expected)

  if (redactedActual !== redactedExpected) {
    // Provide a helpful hint in the failure message.
    const hint =
      `\n\nFixture mismatch at ${fixtureRelPath}.\n` +
      `If this change is intentional, regenerate with:\n` +
      `  UPDATE_FIXTURES=1 npx vitest ${path.relative(process.cwd(), __filename).replace(/_fixture-assert\.ts$/, '')}\n` +
      `Commit message must include a "Fixture change:" line. See ` +
      `tests/fixtures/outputs/README.md.\n`
    expect(redactedActual, hint).toBe(redactedExpected)
  }
}

/**
 * Variant that asserts a JSON-serializable object against a fixture file.
 * Formats the object with `JSON.stringify(…, null, 2)` + trailing newline
 * for human-friendly diffs.
 */
export function assertMatchesJsonFixture(actual: unknown, fixtureRelPath: string): void {
  const serialized = JSON.stringify(actual, null, 2) + '\n'
  assertMatchesFixture(serialized, fixtureRelPath)
}
