// @vitest-environment node
//
// Source-level invariants for the CSV upload cap raise. PR #72's
// direct-to-Storage refactor removed the Vercel 1MB serverActions
// body limit as a constraint; this PR raises the application-layer
// caps that were preserved as orthogonal concerns:
//
//   row count: 100_000 → 1_000_000  (lib/actions/csv.ts)
//   file size: 10 MB   → 250 MB     (lib/upload/validate.ts)
//
// The schema-document size cap stays at 20 MB — schema docs still
// go through FormData → 1 MB body limit until PR 2 ships their
// direct-to-Storage refactor. CAP3 pins this scope-isolation as a
// negative invariant.
//
// Invariants:
//   CAP1.  RETIRED. PR #75's async-ingestion refactor moved the
//          row-count enforcement out of lib/actions/csv.ts into
//          lib/actions/ingestion-jobs.ts (queueIngestionJob). The
//          1,000,000-row gate + matching error message are pinned by
//          IGJ3 in tests/actions/ingestion-jobs.test.ts, which is the
//          natural home for the new architecture's source-text pin.
//          Re-pointing CAP1 here would duplicate IGJ3.
//   CAP2.  CSV file-size cap = 250 * 1024 * 1024 in
//          lib/upload/validate.ts (validateCSVUpload).
//   CAP3.  Schema-doc file-size cap UNCHANGED at 20 * 1024 * 1024
//          in lib/upload/validate.ts (validateSchemaDocUpload).
//          Negative invariant — confirms scope isolation; PR 2
//          will lift this.
//   CAP4.  IngestionCard dropzone helper text reflects the new
//          250 MB / 1,000,000-row caps (regex pin on the new
//          numbers in the user-facing copy).
//   CAP5.  IngestionCard "capped at" warning badge: threshold
//          uses 1_000_000 AND the badge text reads "capped at 1M".
//          Threshold + text are coupled — at cap 1M, both change
//          together; a future refactor that raises the threshold
//          but forgets the text (or vice-versa) would mislead
//          users about WHEN the warning fires.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const VALIDATE = read('lib/upload/validate.ts')
const INGESTION_CARD = read(
  'app/app/projects/[projectId]/project/IngestionCard.tsx',
)

describe('[csv cap raise] CAP2-CAP5 source-level invariants (CAP1 retired — see header)', () => {
  it('CAP2: lib/upload/validate.ts validateCSVUpload caps file size at 250 MB', () => {
    // Locate the validateCSVUpload function body and pin the cap
    // there. We don't pin globally because validateSchemaDocUpload
    // (in the same file) carries a different cap (20 MB) which CAP3
    // covers separately.
    const csvFnStart = VALIDATE.indexOf('function validateCSVUpload')
    expect(csvFnStart, 'validateCSVUpload not found').toBeGreaterThan(-1)
    const docFnStart = VALIDATE.indexOf('function validateSchemaDocUpload')
    expect(docFnStart, 'validateSchemaDocUpload not found').toBeGreaterThan(
      csvFnStart,
    )
    const csvFnBody = VALIDATE.slice(csvFnStart, docFnStart)
    expect(csvFnBody).toMatch(/file\.size\s*>\s*250\s*\*\s*1024\s*\*\s*1024/)
    expect(csvFnBody).toMatch(/['"]File exceeds 250MB limit['"]/)
    // Negative pin: the old 10 MB literal should not appear in the
    // CSV branch.
    expect(csvFnBody).not.toMatch(
      /file\.size\s*>\s*10\s*\*\s*1024\s*\*\s*1024/,
    )
  })

  it('CAP3: validateSchemaDocUpload size cap UNCHANGED at 20 MB (scope isolation; PR 2 territory)', () => {
    // Schema docs still go through FormData → 1 MB body limit until
    // PR 2 ships their direct-to-Storage refactor. Bumping their
    // cap now would let users upload files that fail at the body
    // limit. Negative invariant: confirms this PR did NOT touch
    // the schema-doc cap.
    const docFnStart = VALIDATE.indexOf('function validateSchemaDocUpload')
    expect(docFnStart).toBeGreaterThan(-1)
    const docFnBody = VALIDATE.slice(docFnStart)
    expect(docFnBody).toMatch(/file\.size\s*>\s*20\s*\*\s*1024\s*\*\s*1024/)
    // The schema-doc branch must NOT carry a 250 MB cap (would
    // signal an accidental mass-replace).
    expect(docFnBody).not.toMatch(
      /file\.size\s*>\s*250\s*\*\s*1024\s*\*\s*1024/,
    )
  })

  it('CAP4: IngestionCard dropzone helper text reflects new 250 MB / 1,000,000-row caps', () => {
    // The dropzone hint is the highest-leverage user touchpoint —
    // users see it at the moment of upload decision. After the cap
    // raise it must NOT advertise the old caps.
    expect(INGESTION_CARD).toMatch(/Max 250MB[\s\S]{0,40}1,000,000 rows/)
    expect(INGESTION_CARD).not.toMatch(/Max 10MB[\s\S]{0,40}100,000 rows/)
  })

  it('CAP5: IngestionCard "capped at" warning badge — threshold + text move together', () => {
    // Threshold and text are COUPLED. At cap 1M, both must change
    // together; a future refactor that raises the threshold but
    // forgets the text (or vice-versa) would tell users the badge
    // fires for "1M" rows when it actually fires at a different
    // count. Single test with two assertions reflects that coupling.
    expect(INGESTION_CARD).toMatch(
      /table\.estimatedRows\s*>\s*1_000_000/,
    )
    expect(INGESTION_CARD).toMatch(/capped at 1M/)
    // Negative pin on the old paired values — both must be absent.
    expect(INGESTION_CARD).not.toMatch(
      /table\.estimatedRows\s*>\s*100_000\b/,
    )
    expect(INGESTION_CARD).not.toMatch(/capped at 100K/)
  })
})
