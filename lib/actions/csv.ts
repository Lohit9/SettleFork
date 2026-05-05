'use server'

import { createClient } from '@/lib/supabase/server'

// ─── Direct-to-Supabase-Storage upload slot ──────────────────────────────────
//
// Background — production bugs the upload pipeline has worked around:
//   1. Vercel's serverless function body limit is 4.5 MB and Next.js's
//      default `serverActions.bodySizeLimit` is 1 MB. The original
//      `uploadCSV(FormData)` action received the file as multipart body,
//      so any CSV over ~1 MB failed at the platform layer before reaching
//      application validation. (Fixed by direct-to-Storage upload — PR #72.)
//   2. The synchronous `processUploadedCsv` follow-up action then ran
//      parse + insert + profile inside a single 300s server-action budget.
//      Files near the 1M-row cap timed out at ~700K rows leaving silent
//      partial state. (Fixed by async queue + cron worker — this PR.)
//
// Architecture — direct-to-Storage upload, then async ingestion job:
//   1. Browser calls `getCsvUploadSlot` (this file). Server checks
//      permissions and issues a signed PUT URL scoped to the user's
//      `{user.id}/...` path prefix in the `project-files` bucket. RLS
//      (migration 002:406-415) gates by the first path segment, so the
//      signed URL can only be used to write under the authenticated user's
//      tree.
//   2. Browser PUTs the file directly to Supabase Storage via XHR (see
//      lib/utils/upload-helpers.ts — XHR not fetch because fetch lacks
//      upload progress events). Any size; bypasses Vercel entirely.
//   3. Browser calls `queueIngestionJob` (lib/actions/ingestion-jobs.ts),
//      which inserts a row into `ingestion_jobs` with status='pending' and
//      returns immediately. The Vercel cron worker
//      (app/api/cron/process-ingestion-job/route.ts) picks up pending jobs
//      every minute via FOR UPDATE SKIP LOCKED, downloads the file, parses
//      it, and inserts data_rows in 1K-row chunks via the
//      bulk_insert_data_rows RPC. The UI polls `getIngestionJobStatus`
//      every 2s for progress.
//
// Synchronous contract preserved (PR 3.3 / PR 3.4b coupling):
//   The cron worker still executes data_rows.insert → compute
//   field_profiles → field_profiles.insert before marking the job
//   completed. PR 3.3's data-scanning RPCs read data_rows; PR 3.4b's
//   mapping engine reads field_profiles.sample_values. Both expect those
//   rows to exist as soon as the job reports completed.
//
// data_rows write shape preserved (PR 3.3 coupling):
//   The `{ table_id, row_number, row_data }` insert shape is unchanged.
//   The bulk_insert_data_rows RPC accepts the same shape as a JSONB array
//   so chunked inserts produce identical rows to the legacy single-call
//   insert.

const PENDING_PREFIX = 'pending'

export interface CsvUploadSlot {
  success: true
  signedUrl: string
  storagePath: string
}

export interface CsvUploadSlotError {
  success: false
  error: string
}

export async function getCsvUploadSlot(input: {
  projectId: string
  datasetId: string
  role: 'source' | 'target'
  tableName: string
  filename: string
}): Promise<CsvUploadSlot | CsvUploadSlotError> {
  const { projectId, datasetId, role, tableName, filename } = input

  if (!projectId || !datasetId || !role || !tableName || !filename) {
    return { success: false, error: 'Missing required fields' }
  }

  // Filename validation: enforce .csv extension at the slot-issuance
  // boundary so we never hand out signed URLs for non-CSV uploads.
  // Path-traversal characters are rejected to defend against signed-URL
  // misuse — even though the RLS policy already gates by user.id prefix,
  // a `..` in the filename could let a user write outside their tree
  // within their own project's namespace.
  if (!filename.toLowerCase().endsWith('.csv')) {
    return { success: false, error: 'Filename must end with .csv' }
  }
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return { success: false, error: 'Invalid filename: path traversal not allowed' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  // Verify dataset ownership BEFORE issuing the signed URL — same
  // defense-in-depth as the previous uploadCSV. RLS would also catch a
  // mismatched dataset on the downstream insert, but failing here gives
  // the user a clean error instead of a half-completed upload.
  const { data: ownedDataset } = await supabase
    .from('datasets')
    .select('id')
    .eq('id', datasetId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!ownedDataset) {
    return { success: false, error: 'Dataset not found or access denied' }
  }

  // Path convention:
  //   {user.id}/{projectId}/{role}/pending/{timestamp}-{datasetId}-{filename}
  //
  // The `pending/` subprefix marks in-flight uploads; the ingestion
  // cron worker moves the file out of pending/ on completion. A daily cron
  // (separate PR) sweeps pending/ files older than 24h that no DB record
  // references.
  // Timestamp + datasetId in the leaf prevent collisions between repeated
  // upload attempts of the same filename.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = `${user.id}/${projectId}/${role}/${PENDING_PREFIX}/${Date.now()}-${datasetId}-${safeName}`

  const { data, error } = await supabase.storage
    .from('project-files')
    .createSignedUploadUrl(storagePath, { upsert: true })

  if (error || !data) {
    return {
      success: false,
      error: error?.message ?? 'Failed to issue signed upload URL',
    }
  }

  return { success: true, signedUrl: data.signedUrl, storagePath }
}
