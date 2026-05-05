'use server'

import { createClient } from '@/lib/supabase/server'

// ─── Background-job ingestion server actions ─────────────────────────────────
//
// Two server actions back the new async upload pipeline:
//
//   queueIngestionJob       — small round-trip; permission check, cap
//                             validation, insert 'pending' row, return jobId.
//                             Replaces the synchronous processUploadedCsv
//                             that hit Vercel's 300s timeout at ~704K rows.
//
//   getIngestionJobStatus   — small read; RLS gates by user_id so users
//                             see only their own jobs. Drives the UI
//                             polling loop in IngestionCard.
//
// The actual processing happens in the cron worker
// (app/api/cron/process-ingestion-job/route.ts) which picks up jobs
// once a minute via claim_next_ingestion_job (migration 088).
//
// Synchronous-contract change vs PR #72:
//   The legacy processUploadedCsv guaranteed field_profiles existed
//   when the action returned success. The new pattern returns success
//   as soon as the job is QUEUED — field_profiles are populated by
//   the worker after data_rows insertion completes. PR 3.4b's
//   formatSchemaForPrompt already handles missing sample_values via
//   `?? []` fallback ([context-builder.ts](../ai/context-builder.ts)),
//   so mapping-page renders before job completion show empty
//   sample arrays rather than crashing. The IngestionCard polling
//   loop holds the user on the upload UI until status='completed',
//   so users won't navigate to mapping mid-job in practice.

export interface QueueIngestionJobInput {
  projectId: string
  datasetId: string
  role: 'source' | 'target'
  tableName: string
  storagePath: string
  totalRows: number
}

export type QueueIngestionJobResult =
  | { success: true; jobId: string }
  | { success: false; error: string }

export async function queueIngestionJob(
  input: QueueIngestionJobInput,
): Promise<QueueIngestionJobResult> {
  const { projectId, datasetId, role, tableName, storagePath, totalRows } = input

  if (!projectId || !datasetId || !role || !tableName || !storagePath) {
    return { success: false, error: 'Missing required fields' }
  }

  // Cap validation. The 1M ceiling was carried forward from PR #73 —
  // the new architecture lifts the timeout constraint that broke at
  // ~704K, but the application-layer cap stays at 1M for now.
  // Tightened to also reject non-positive totals (defensive; client
  // should never pass these, but a buggy client must fail cleanly).
  if (!Number.isFinite(totalRows) || totalRows <= 0) {
    return { success: false, error: 'CSV has no data rows' }
  }
  if (totalRows > 1_000_000) {
    return { success: false, error: 'CSV exceeds 1,000,000 row limit' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Editor permission required. Mirrors the gate that lived inside
  // the legacy uploadCSV / processUploadedCsv. Failing here gives
  // the user a clean error before we burn a worker pickup.
  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  // Defense-in-depth: confirm the storage path is under the user's
  // tree before queueing. RLS would also reject a worker download
  // for a path outside the user's prefix (RLS bypass via service_role
  // notwithstanding — the file simply wouldn't have been writable in
  // the first place under the storage RLS policy from migration 002).
  // Fail fast here so the user sees a clear error.
  if (!storagePath.startsWith(`${user.id}/`)) {
    return { success: false, error: 'Storage path is not under the authenticated user prefix' }
  }

  // Confirm dataset ownership. Same defense-in-depth as
  // getCsvUploadSlot — RLS would catch a mismatched dataset on the
  // downstream worker insert, but failing here gives a clean error.
  const { data: ownedDataset } = await supabase
    .from('datasets')
    .select('id')
    .eq('id', datasetId)
    .eq('project_id', projectId)
    .maybeSingle()
  if (!ownedDataset) {
    return { success: false, error: 'Dataset not found or access denied' }
  }

  const { data: job, error } = await supabase
    .from('ingestion_jobs')
    .insert({
      project_id: projectId,
      user_id: user.id,
      storage_path: storagePath,
      dataset_id: datasetId,
      role,
      table_name: tableName,
      status: 'pending',
      total_rows: totalRows,
      progress: 0,
      completed_rows: 0,
    })
    .select('id')
    .single()

  if (error || !job) {
    return {
      success: false,
      error: error?.message ?? 'Failed to queue ingestion job',
    }
  }

  return { success: true, jobId: job.id }
}

export interface IngestionJobSnapshot {
  id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  total_rows: number | null
  completed_rows: number
  error: string | null
  created_at: string
  completed_at: string | null
  table_id: string | null
}

export type GetIngestionJobStatusResult =
  | { success: true; job: IngestionJobSnapshot }
  | { success: false; error: string }

export async function getIngestionJobStatus(
  jobId: string,
): Promise<GetIngestionJobStatusResult> {
  if (!jobId) {
    return { success: false, error: 'Missing jobId' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // RLS policy `ingestion_jobs_select_own` (migration 087) gates by
  // user_id = auth.uid(), so we don't need an explicit user_id filter.
  // .maybeSingle() returns null (not error) for not-found-or-not-yours,
  // letting us emit a uniform "not found" error in either case.
  const { data: job, error } = await supabase
    .from('ingestion_jobs')
    .select(
      'id, status, progress, total_rows, completed_rows, error, created_at, completed_at, table_id',
    )
    .eq('id', jobId)
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message }
  }
  if (!job) {
    return { success: false, error: 'Job not found' }
  }

  return {
    success: true,
    job: {
      id: job.id,
      status: job.status,
      progress: Number(job.progress),
      total_rows: job.total_rows,
      completed_rows: job.completed_rows,
      error: job.error,
      created_at: job.created_at,
      completed_at: job.completed_at,
      table_id: job.table_id,
    },
  }
}
