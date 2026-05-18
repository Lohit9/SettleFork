// app/api/cron/process-ingestion-job/route.ts
//
// Background-job CSV ingestion worker. Scheduled in vercel.json as
// `* * * * *` (every minute). Each invocation claims at most ONE
// pending or stale-processing ingestion job via
// claim_next_ingestion_job (migration 088), processes it, and
// returns. Future-pickup runs handle remaining jobs in the queue.
//
// Why one-job-per-invocation:
//   Vercel function instances are bounded by memory + 300s timeout.
//   Processing a 1M-row CSV takes ~250s of the 300s budget; running
//   multiple jobs serially in one invocation risks the second
//   timing out partway through. One per minute is fast enough for
//   queue depth in practice (uploads are bursty by user, not by
//   minute).
//
// Resume-aware processing:
//   Worker handles two pickup cases:
//     (A) FIRST PICKUP — job.table_id is null. Worker runs schema
//         inference, creates the table + fields rows, then enters
//         the chunked-insert loop from row 0.
//     (B) RESUME — job.table_id is set, job.completed_rows > 0.
//         Worker SKIPS schema inference + table creation, reads the
//         existing fields, and enters the chunked-insert loop from
//         row job.completed_rows.
//   Idempotency for the data_rows insert comes from the UNIQUE
//   constraint + ON CONFLICT DO NOTHING in bulk_insert_data_rows
//   (migration 088). Resume after a crash mid-chunk is safe.

import { NextResponse } from 'next/server'
import Papa from 'papaparse'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeFriendlyName } from '@/lib/db/sql-rewriter'
import {
  computeValueDistribution,
  computeMinMax,
  countFormatIssues,
} from '@/lib/utils/profiling'
import { logActivity } from '@/lib/actions/activity-log'

// Vercel function timeout. Pro Performance tier default is 300s for
// Fluid Compute; the explicit declaration keeps the worker honest if
// the project default changes.
export const maxDuration = 300

const CHUNK_SIZE = 1000

interface IngestionJob {
  id: string
  project_id: string
  user_id: string
  storage_path: string
  dataset_id: string
  table_id: string | null
  role: 'source' | 'target'
  table_name: string
  status: string
  total_rows: number | null
  completed_rows: number
  metadata: Record<string, unknown> | null
}

interface ParsedField {
  name: string
  data_type: string
  inferred_type: string | null
  is_nullable: boolean
  is_primary_key: boolean
  is_foreign_key: boolean
  fk_reference: null
  ordinal_position: number
}

interface CreatedField extends ParsedField {
  id: string
  table_id: string
}

export async function GET(request: Request) {
  // ── Cron auth ──────────────────────────────────────────────────────────
  // Same pattern as auto-archive + llm-cost-report cron routes:
  // Vercel attaches Bearer ${CRON_SECRET} to scheduled invocations.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // ── Claim a job ────────────────────────────────────────────────────────
  // claim_next_ingestion_job (migration 088) atomically picks the
  // oldest pending OR stale-processing job, marks it processing, and
  // returns the row. FOR UPDATE SKIP LOCKED handles concurrent crons.
  const { data: job, error: claimError } = await supabaseAdmin
    .rpc('claim_next_ingestion_job')
    .single<IngestionJob>()

  if (claimError) {
    console.error('[cron/process-ingestion-job] claim failed:', claimError)
    // 200 on logical errors so cron loop continues. 500 only on
    // unexpected errors that warrant external alerting.
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }

  if (!job) {
    return NextResponse.json({ idle: true, message: 'No pending jobs' })
  }

  console.log(`[cron/process-ingestion-job] claimed job ${job.id}`)

  // ── Process the job ───────────────────────────────────────────────────
  try {
    await processJob(job)
    return NextResponse.json({ jobId: job.id, status: 'completed' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    console.error(`[cron/process-ingestion-job] job ${job.id} failed:`, message)
    await markFailed(job.id, message)
    // 200 — cron loop must continue picking up other jobs.
    return NextResponse.json({ jobId: job.id, status: 'failed', error: message })
  }
}

async function processJob(job: IngestionJob): Promise<void> {
  // Step 1: Download file from Storage. Service-role bypasses RLS.
  const { data: downloaded, error: downloadError } = await supabaseAdmin.storage
    .from('project-files')
    .download(job.storage_path)
  if (downloadError || !downloaded) {
    throw new Error(
      'Failed to read uploaded file from storage: ' +
        (downloadError?.message ?? 'unknown error'),
    )
  }
  const text = await downloaded.text()

  // Step 2: Parse CSV. Same options as legacy processUploadedCsv.
  const parseResult = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  })
  if (parseResult.errors.length > 0 && parseResult.data.length === 0) {
    throw new Error('Failed to parse CSV: ' + parseResult.errors[0].message)
  }
  const rows = parseResult.data
  if (rows.length === 0) {
    throw new Error('CSV has no data rows')
  }

  const rawHeaders = parseResult.meta.fields || Object.keys(rows[0])
  if (rawHeaders.length < 2) {
    throw new Error('CSV must have at least 2 columns')
  }
  const headers = deduplicateHeaders(rawHeaders)

  // Step 3: Sanitize cell values. Same formula-injection defense as
  // the legacy processUploadedCsv.
  const sanitizedRows = rows.map((row: Record<string, string>) => {
    const out: Record<string, string> = {}
    rawHeaders.forEach((raw: string, i: number) => {
      const sanitized = headers[i]
      const val = row[raw] ?? ''
      out[sanitized] = sanitizeValue(String(val))
    })
    return out
  })

  // Step 4: Resume-vs-first-pickup branch.
  let tableId: string
  let createdFields: CreatedField[]

  if (job.table_id) {
    // RESUME: schema + tables + fields already exist from a prior
    // pickup. Read fields back and skip schema inference.
    tableId = job.table_id
    const { data: existingFields, error: fieldsErr } = await supabaseAdmin
      .from('fields')
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position')
      .eq('table_id', tableId)
      .order('ordinal_position')
    if (fieldsErr || !existingFields || existingFields.length === 0) {
      throw new Error(
        'Resume failed: existing fields not found for table ' + tableId,
      )
    }
    createdFields = existingFields as CreatedField[]
    console.log(
      `[cron/process-ingestion-job] resuming job ${job.id} from row ${job.completed_rows}`,
    )
  } else {
    // FIRST PICKUP: infer schema, create tables + fields rows.
    const { data: ownedDataset } = await supabaseAdmin
      .from('datasets')
      .select('id, name')
      .eq('id', job.dataset_id)
      .eq('project_id', job.project_id)
      .maybeSingle()
    if (!ownedDataset) {
      throw new Error('Dataset not found or access denied')
    }
    const friendlyName = computeFriendlyName(ownedDataset.name, job.table_name)

    // Schema inference — same value-observable logic as legacy
    // processUploadedCsv. Sample first 100 rows; defer PK/FK to
    // higher-priority schema_source layers (ddl_parsed, doc_enriched,
    // cross_table_inferred, manual).
    const sampleRows = sanitizedRows.slice(0, 100)
    const inferredFields: ParsedField[] = headers.map((header, index) => {
      const values = sampleRows
        .map((r) => r[header])
        .filter((v) => v !== '' && v !== null && v !== undefined)
      const { dataType, inferredType } = inferColumnType(header, values)
      const isNullable = values.length < sampleRows.length
      return {
        name: header,
        data_type: dataType,
        inferred_type: inferredType,
        is_nullable: isNullable,
        is_primary_key: false,
        is_foreign_key: false,
        fk_reference: null,
        ordinal_position: index + 1,
      }
    })

    // Upsert table record (delete old + recreate). Cascade delete on
    // tables cleans up fields, data_rows, field_profiles. UNIQUE
    // constraint on data_rows means stale rows from a re-upload never
    // collide with the new worker's inserts.
    const { data: existingTable } = await supabaseAdmin
      .from('tables')
      .select('id')
      .eq('dataset_id', job.dataset_id)
      .eq('name', job.table_name)
      .maybeSingle()
    if (existingTable) {
      await supabaseAdmin.from('tables').delete().eq('id', existingTable.id)
    }
    const { data: newTable, error: tableError } = await supabaseAdmin
      .from('tables')
      .insert({
        dataset_id: job.dataset_id,
        name: job.table_name,
        row_count: sanitizedRows.length,
        friendly_name: friendlyName,
      })
      .select()
      .single()
    if (tableError || !newTable) {
      throw new Error(
        'Failed to create table record: ' + (tableError?.message ?? 'unknown'),
      )
    }
    tableId = newTable.id

    const { data: insertedFields, error: fieldsError } = await supabaseAdmin
      .from('fields')
      .insert(inferredFields.map((f) => ({ ...f, table_id: tableId })))
      .select()
    if (fieldsError || !insertedFields) {
      await supabaseAdmin.from('tables').delete().eq('id', tableId)
      throw new Error(
        'Failed to create field records: ' + (fieldsError?.message ?? 'unknown'),
      )
    }
    createdFields = insertedFields as CreatedField[]

    // Persist table_id + total_rows on the job. If the worker crashes
    // before the chunked-insert loop completes, the next pickup reads
    // these and resumes correctly.
    await supabaseAdmin
      .from('ingestion_jobs')
      .update({
        table_id: tableId,
        total_rows: sanitizedRows.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }

  // Step 5: Chunked data_rows insertion via bulk_insert_data_rows RPC.
  // Resume-aware: start at job.completed_rows (0 on first pickup,
  // last-checkpointed offset on resume).
  const totalRows = sanitizedRows.length
  for (let i = job.completed_rows; i < totalRows; i += CHUNK_SIZE) {
    const chunkEnd = Math.min(i + CHUNK_SIZE, totalRows)
    const chunkPayload = sanitizedRows.slice(i, chunkEnd).map((row, idx) => ({
      row_number: i + idx + 1,
      row_data: row,
    }))

    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
      'bulk_insert_data_rows',
      {
        p_table_id: tableId,
        p_dataset_id: job.dataset_id,
        p_project_id: job.project_id,
        p_rows: chunkPayload,
        p_offset: i,
      },
    )
    if (rpcError) {
      throw new Error('Bulk insert RPC failed: ' + rpcError.message)
    }
    // bulk_insert_data_rows returns { status: 'failed', error } on
    // structural-scope mismatch. Check explicitly so the worker treats
    // this as a logical failure, not a silent partial-insert.
    const result = rpcResult as { status: string; error?: string } | null
    if (result?.status === 'failed') {
      throw new Error('Bulk insert returned failed status: ' + (result.error ?? 'unknown'))
    }

    // Update progress checkpoint after each chunk. The worker's
    // resume logic reads this on next pickup; the UI polling loop
    // reads it via getIngestionJobStatus to drive the progress bar.
    await supabaseAdmin
      .from('ingestion_jobs')
      .update({
        completed_rows: chunkEnd,
        progress: Math.min(1, chunkEnd / totalRows),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }

  // Step 6: Compute and insert field_profiles. Same logic as legacy
  // processUploadedCsv step 10. Synchronous to job completion (worker
  // doesn't mark job 'completed' until profiles exist), so by the
  // time the UI polling loop sees status='completed', PR 3.4b's
  // formatSchemaForPrompt will see populated sample_values.
  const profiles = createdFields.map((field) => {
    const fieldValues = sanitizedRows.map((r) => r[field.name] ?? '')
    const nonNull = fieldValues.filter(
      (v) => v !== '' && v !== null && v !== undefined,
    )
    const formatIssues = countFormatIssues(
      nonNull,
      field.data_type,
      field.inferred_type ?? null,
      field.name,
    )
    const valueDistribution = computeValueDistribution(nonNull)
    const sampleValues = valueDistribution.slice(0, 10).map((d) => d.value)
    const { min: minValue, max: maxValue } = computeMinMax(
      nonNull,
      field.inferred_type ?? null,
    )
    return {
      field_id: field.id,
      total_rows: sanitizedRows.length,
      null_count: sanitizedRows.length - nonNull.length,
      null_percentage: +(
        (((sanitizedRows.length - nonNull.length) / sanitizedRows.length) *
          100).toFixed(2)
      ),
      cardinality: new Set(nonNull).size,
      unique_percentage:
        nonNull.length > 0
          ? +((new Set(nonNull).size / nonNull.length) * 100).toFixed(2)
          : 0,
      format_issues_count: formatIssues,
      min_value: minValue,
      max_value: maxValue,
      sample_values: sampleValues,
      value_distribution: valueDistribution,
    }
  })
  // Idempotent on resume: delete existing profiles for these fields
  // before inserting fresh ones. (Resume case can re-enter step 6 if
  // the worker crashed AFTER inserting profiles but BEFORE marking
  // completed. Cleaner than ON CONFLICT for a 10-row insert.)
  const fieldIds = createdFields.map((f) => f.id)
  await supabaseAdmin.from('field_profiles').delete().in('field_id', fieldIds)
  await supabaseAdmin.from('field_profiles').insert(profiles)

  // Step 7: Move file out of pending/. Mirrors legacy processUploadedCsv
  // step 11. Move failure is non-fatal — the file still exists at the
  // pending path; subsequent pending-cleanup cron will leave it alone
  // because tables.csv_storage_path records the (still-pending) path.
  const pathTail = job.storage_path.split('/').pop() ?? `${job.table_name}.csv`
  const dashSplit = pathTail.split('-')
  const filename =
    dashSplit.length > 6 ? dashSplit.slice(6).join('-') : pathTail
  const finalPath = `${job.user_id}/${job.project_id}/${job.role}/${filename}`
  const { error: moveError } = await supabaseAdmin.storage
    .from('project-files')
    .move(job.storage_path, finalPath)
  const persistedPath = moveError ? job.storage_path : finalPath
  if (moveError) {
    console.warn(
      '[cron/process-ingestion-job] storage move from pending/ failed (non-fatal):',
      moveError.message,
    )
  }
  await supabaseAdmin
    .from('tables')
    .update({ csv_storage_path: persistedPath })
    .eq('id', tableId)

  // Step 8: Fire-and-forget side effects (quality checks, schema
  // enrichment, FK inference). Same try/catch pattern as legacy
  // processUploadedCsv. None of these block job completion.
  try {
    const { runSourceDataChecks } = await import(
      '@/lib/quality/detection-engine'
    )
    await runSourceDataChecks(job.project_id, tableId, 'auto')
  } catch (detectionErr) {
    console.warn(
      '[cron/process-ingestion-job] auto detection failed (non-fatal):',
      detectionErr,
    )
  }

  try {
    const { count: docCount } = await supabaseAdmin
      .from('schema_documents')
      .select('id', { count: 'exact', head: true })
      .eq('dataset_id', job.dataset_id)
      .not('extracted_text', 'is', null)
    if ((docCount ?? 0) > 0) {
      const { enrichSchemaFromDocs } = await import(
        '@/lib/actions/schema-enrichment'
      )
      const enrichResult = await enrichSchemaFromDocs(job.dataset_id, tableId)
      if (enrichResult.correctedFields > 0) {
        console.log(
          `[cron/process-ingestion-job] schema enrichment: ${enrichResult.correctedFields} field(s) corrected for table ${tableId}`,
        )
      }
    }
  } catch (enrichErr) {
    console.warn(
      '[cron/process-ingestion-job] schema enrichment failed (non-fatal):',
      enrichErr,
    )
  }

  try {
    const { inferCrossTableFKs } = await import('@/lib/quality/fk-inference')
    const result = await inferCrossTableFKs(job.project_id, job.dataset_id)
    if (result.inferred.length > 0) {
      console.log(
        `[cron/process-ingestion-job] FK inference added ${result.inferred.length} cross-table FK(s) after "${job.table_name}"`,
      )
    }
  } catch (inferErr) {
    console.warn(
      '[cron/process-ingestion-job] FK inference failed (non-fatal):',
      inferErr,
    )
  }

  // Step 9: Activity log entry. Same shape as legacy processUploadedCsv.
  const actionType =
    job.role === 'source' ? 'source_uploaded' : 'target_uploaded'
  try {
    await logActivity(
      job.project_id,
      actionType,
      `${job.role === 'source' ? 'Source' : 'Target'} data uploaded: ${job.table_name} (${sanitizedRows.length} rows, ${createdFields.length} fields)`,
      'data',
      {
        file_name: filename,
        table_name: job.table_name,
        row_count: sanitizedRows.length,
        field_count: createdFields.length,
      },
    )
  } catch (logErr) {
    console.warn(
      '[cron/process-ingestion-job] activity log failed (non-fatal):',
      logErr,
    )
  }

  // Step 10: Mark complete. After this UPDATE, the UI polling loop
  // observes status='completed' on its next 2-second tick and
  // transitions to the success state.
  await supabaseAdmin
    .from('ingestion_jobs')
    .update({
      status: 'completed',
      progress: 1,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
}

async function markFailed(jobId: string, error: string): Promise<void> {
  await supabaseAdmin
    .from('ingestion_jobs')
    .update({
      status: 'failed',
      error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
}

// ─── Helpers — same logic as lib/actions/csv.ts ──────────────────────────────
//
// Header names are preserved verbatim from the uploaded file. The only
// adjustment is de-duplication when the same header appears multiple times.
// Cell-value sanitization remains in place for formula-injection defense.

function deduplicateHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((h) => {
    const count = seen.get(h) ?? 0
    seen.set(h, count + 1)
    return count === 0 ? h : `${h}_${count + 1}`
  })
}

function sanitizeValue(value: string): string {
  if (/^[=@\t\r]/.test(value)) return "'" + value
  if (value[0] === '+' || value[0] === '-') {
    const rest = value.slice(1).replace(/[$,.\s]/g, '')
    if (rest === '' || /^\d+$/.test(rest)) return value
    return "'" + value
  }
  return value
}

function inferColumnType(
  name: string,
  values: string[],
): { dataType: string; inferredType: string | null } {
  const lower = name.toLowerCase()
  if (values.length === 0) return { dataType: 'VARCHAR(255)', inferredType: null }
  if (lower.includes('email') || values.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) {
    return { dataType: 'VARCHAR(255)', inferredType: 'email' }
  }
  const boolSet = new Set(['true', 'false', '0', '1', 'yes', 'no', 'y', 'n', 't', 'f'])
  if (values.every((v) => boolSet.has(v.toLowerCase()))) {
    return { dataType: 'BOOLEAN', inferredType: null }
  }
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) {
    return { dataType: 'TIMESTAMP', inferredType: null }
  }
  const datePatterns = [/^\d{4}-\d{2}-\d{2}$/, /^\d{1,2}\/\d{1,2}\/\d{4}$/, /^\d{1,2}-\d{1,2}-\d{4}$/]
  if (values.every((v) => datePatterns.some((p) => p.test(v)))) {
    return { dataType: 'DATE', inferredType: null }
  }
  if (values.every((v) => /^-?\d+$/.test(v))) {
    const isCurrency =
      lower.includes('price') || lower.includes('amount') || lower.includes('revenue') ||
      lower.includes('salary') || lower.includes('cost') || lower.includes('total')
    if (isCurrency) return { dataType: 'DECIMAL(18,2)', inferredType: 'currency' }
    return { dataType: 'INT', inferredType: null }
  }
  if (values.every((v) => /^-?\d+\.?\d*$/.test(v)) && values.some((v) => v.includes('.'))) {
    const isCurrency =
      lower.includes('price') || lower.includes('amount') || lower.includes('revenue') ||
      lower.includes('salary') || lower.includes('cost') || lower.includes('total')
    return { dataType: 'DECIMAL(18,2)', inferredType: isCurrency ? 'currency' : null }
  }
  if (lower.includes('phone') || lower.includes('mobile') || lower.includes('fax')) {
    return { dataType: 'VARCHAR(20)', inferredType: 'phone' }
  }
  if (lower.includes('url') || lower.includes('website') || values.some((v) => /^https?:\/\//.test(v))) {
    return { dataType: 'VARCHAR(2048)', inferredType: 'url' }
  }
  const maxLen = Math.max(...values.map((v) => v.length), 1)
  const roundedLen = Math.min(4096, Math.max(40, Math.ceil(maxLen / 10) * 10))
  return { dataType: `VARCHAR(${roundedLen})`, inferredType: null }
}
