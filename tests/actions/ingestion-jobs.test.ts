// @vitest-environment node
//
// Source-level invariants for the async-ingestion architecture
// (queueIngestionJob action + cron worker). Replaces the synchronous
// processUploadedCsv path that timed out at ~700K rows on the 300s
// Vercel function budget.
//
// The architecture is split across three artifacts:
//   - lib/actions/ingestion-jobs.ts            (queue + status actions)
//   - app/api/cron/process-ingestion-job/route.ts (cron worker)
//   - vercel.json                              (cron schedule entry)
//
// These tests pin source-level invariants — the same readFileSync + regex
// pattern used by tests/actions/projects-validation.test.ts and
// tests/actions/csv-direct-to-storage.test.ts. Behavioral verification
// (RPC + RLS + cron auth) lives in integration tests run against a
// scratch Supabase project (CLAUDE.md §10.4).
//
// Invariants:
//   IGJ1.   lib/actions/ingestion-jobs.ts exports queueIngestionJob.
//   IGJ2.   lib/actions/ingestion-jobs.ts exports getIngestionJobStatus.
//   IGJ3.   queueIngestionJob enforces the 1,000,000-row ceiling
//           (totalRows > 1_000_000 returns the documented error).
//   IGJ4.   The cron route file exports a GET handler.
//   IGJ5.   The cron route gates on Bearer ${CRON_SECRET} so unauthenticated
//           callers are rejected with 401.
//   IGJ6.   The cron worker calls supabase.rpc('claim_next_ingestion_job')
//           — atomic FOR UPDATE SKIP LOCKED claim from migration 088.
//   IGJ7.   The cron worker calls supabase.rpc('bulk_insert_data_rows')
//           — chunked RPC insert from migration 088.
//   IGJ8.   The cron worker uses CHUNK_SIZE = 1000 (PostgREST 1MB body
//           limit anchor — ~770KB per 1K-row chunk).
//   IGJ9.   The cron worker updates BOTH completed_rows and progress on
//           the ingestion_jobs row after each chunk (UI poll reads both).
//   IGJ10.  vercel.json schedules the cron at every minute on
//           /api/cron/process-ingestion-job.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const ACTION_SRC = readFileSync(resolve(ROOT, 'lib/actions/ingestion-jobs.ts'), 'utf8')
const CRON_SRC = readFileSync(
  resolve(ROOT, 'app/api/cron/process-ingestion-job/route.ts'),
  'utf8',
)
const VERCEL_JSON = JSON.parse(
  readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'),
) as { crons?: Array<{ path: string; schedule: string }> }

describe('[ingestion-jobs] async ingestion architecture source-level invariants', () => {
  it('IGJ1: lib/actions/ingestion-jobs.ts exports queueIngestionJob', () => {
    expect(ACTION_SRC).toMatch(/export\s+async\s+function\s+queueIngestionJob\b/)
  })

  it('IGJ2: lib/actions/ingestion-jobs.ts exports getIngestionJobStatus', () => {
    expect(ACTION_SRC).toMatch(/export\s+async\s+function\s+getIngestionJobStatus\b/)
  })

  it('IGJ3: queueIngestionJob enforces the 1,000,000-row ceiling', () => {
    // Cap check + the user-visible error message that the IngestionCard UI
    // surfaces verbatim. Pin both so a future refactor that loosens the
    // ceiling has to acknowledge both.
    expect(ACTION_SRC).toMatch(/totalRows\s*>\s*1[_,]?000[_,]?000/)
    expect(ACTION_SRC).toMatch(/CSV exceeds 1,000,000 row limit/)
  })

  it('IGJ4: cron route exports a GET handler', () => {
    expect(CRON_SRC).toMatch(/export\s+async\s+function\s+GET\s*\(/)
  })

  it('IGJ5: cron route gates on Bearer ${CRON_SECRET}', () => {
    // Pin both the env-var read and the Bearer-prefix shape so a refactor
    // that switches to a different auth header has to update this test.
    expect(CRON_SRC).toMatch(/process\.env\.CRON_SECRET/)
    expect(CRON_SRC).toMatch(/Bearer\s+\$\{[^}]*CRON_SECRET[^}]*\}/)
  })

  it("IGJ6: cron worker calls supabase.rpc('claim_next_ingestion_job')", () => {
    expect(CRON_SRC).toMatch(/\.rpc\(\s*['"]claim_next_ingestion_job['"]\s*\)/)
  })

  it("IGJ7: cron worker calls supabase.rpc('bulk_insert_data_rows')", () => {
    expect(CRON_SRC).toMatch(/\.rpc\(\s*['"]bulk_insert_data_rows['"]/)
  })

  it('IGJ8: cron worker uses CHUNK_SIZE = 1000 (PostgREST 1MB body limit)', () => {
    expect(CRON_SRC).toMatch(/const\s+CHUNK_SIZE\s*=\s*1000\b/)
  })

  it('IGJ9: cron worker updates completed_rows and progress on each chunk', () => {
    // Both fields must be written together so the UI's getIngestionJobStatus
    // poll observes a consistent snapshot. We pin the field names rather
    // than the exact statement since the helper shape may change.
    expect(CRON_SRC).toMatch(/completed_rows\s*:/)
    expect(CRON_SRC).toMatch(/progress\s*:/)
    // And confirm the worker actually runs an UPDATE on ingestion_jobs.
    expect(CRON_SRC).toMatch(/from\(\s*['"]ingestion_jobs['"]\s*\)\s*\.update/)
  })

  it('IGJ10: vercel.json schedules /api/cron/process-ingestion-job every minute', () => {
    expect(VERCEL_JSON.crons).toBeDefined()
    const entry = VERCEL_JSON.crons?.find(
      (c) => c.path === '/api/cron/process-ingestion-job',
    )
    expect(entry, 'expected vercel.json crons[] to include /api/cron/process-ingestion-job').toBeDefined()
    expect(entry?.schedule).toBe('* * * * *')
  })
})
