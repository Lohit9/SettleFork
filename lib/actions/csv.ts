'use server'

import Papa from 'papaparse'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { computeFriendlyName } from '@/lib/db/sql-rewriter'
import { computeValueDistribution, computeMinMax, countFormatIssues } from '@/lib/utils/profiling'
import { logActivity } from '@/lib/actions/activity-log'

export interface UploadCSVResult {
  success: boolean
  tableId?: string
  fieldCount?: number
  rowCount?: number
  error?: string
}

// ─── Direct-to-Supabase-Storage upload pipeline ──────────────────────────────
//
// Background — production bug we're working around:
//   Vercel's serverless function body limit is 4.5 MB and Next.js's default
//   `serverActions.bodySizeLimit` is 1 MB. The previous `uploadCSV(FormData)`
//   server action received the entire file as multipart body, so any CSV
//   over ~1 MB failed at the platform layer before reaching application
//   validation (the 1M-row check, etc.). The 250 MB / 1M-row caps the UI
//   advertised were unenforceable on production.
//
// Architecture — direct-to-Storage:
//   1. Browser calls `getCsvUploadSlot` (a tiny server action — kilobytes
//      in, kilobytes out). Server checks permissions and issues a signed
//      PUT URL scoped to the user's `{user.id}/...` path prefix in the
//      `project-files` bucket. RLS (migration 002:406-415) gates by the
//      first path segment, so the signed URL can only be used to write
//      under the authenticated user's tree.
//   2. Browser PUTs the file directly to Supabase Storage via XHR (see
//      lib/utils/upload-helpers.ts — XHR not fetch because fetch lacks
//      upload progress events). Any size; bypasses Vercel entirely.
//   3. Browser calls `processUploadedCsv` (another tiny server action).
//      Server downloads the file from Storage, runs the EXISTING pipeline
//      (parse → infer schema → insert tables/fields/data_rows → compute
//      field_profiles synchronously → fire-and-forget quality + enrichment
//      + FK inference), and moves the file from `pending/` to its final
//      path.
//
// Synchronous contract preserved (PR 3.3 / PR 3.4b coupling):
//   The order data_rows.insert → compute field_profiles → field_profiles
//   .insert → return success is unchanged. PR 3.3's data-scanning RPCs
//   read data_rows; PR 3.4b's mapping engine reads field_profiles
//   .sample_values. Both expect those rows to exist as soon as the upload
//   action returns success. We do NOT split profile compute into a
//   background job.
//
// data_rows write shape preserved (PR 3.3 coupling):
//   The `{ table_id, row_number, row_data }` insert shape is independent
//   of where the file came from. Whether Papa.parse runs on FormData
//   multipart content or on a Storage download, the parsed row object
//   shape is identical.

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
  // The `pending/` subprefix marks in-flight uploads; processUploadedCsv
  // moves the file out of pending/ on success. A daily cron (separate PR)
  // sweeps pending/ files older than 24h that no DB record references.
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

export async function processUploadedCsv(input: {
  projectId: string
  datasetId: string
  role: 'source' | 'target'
  tableName: string
  storagePath: string
}): Promise<UploadCSVResult> {
  const { projectId, datasetId, role, tableName, storagePath } = input

  try {
    if (!projectId || !datasetId || !role || !tableName || !storagePath) {
      return { success: false, error: 'Missing required fields' }
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

    // Defense-in-depth: confirm the storage path is under the user's tree
    // before downloading. RLS would also reject, but a malformed input
    // should fail fast with a clear error.
    if (!storagePath.startsWith(`${user.id}/`)) {
      return { success: false, error: 'Storage path is not under the authenticated user prefix' }
    }

    // ── Step 1: Verify dataset ownership ─────────────────────────────────────
    const { data: ownedDataset } = await supabase
      .from('datasets')
      .select('id, name')
      .eq('id', datasetId)
      .eq('project_id', projectId)
      .maybeSingle()
    if (!ownedDataset) {
      return { success: false, error: 'Dataset not found or access denied' }
    }
    const friendlyName = computeFriendlyName(ownedDataset.name, tableName)

    // ── Step 2: Download file from Storage ───────────────────────────────────
    // The browser already PUT the file via the signed URL. Read it back as
    // text so we can run Papa.parse on the contents. Download size matches
    // upload size; the only platform constraint we hit here is Vercel
    // function memory (Pro Performance tier: 4096 MB) which is well above
    // realistic CSV sizes (a 1M-row CSV is ~600-800 MB peak per the prior
    // investigation, ~15-20% utilisation of the 4 GB ceiling).
    const { data: downloaded, error: downloadError } = await supabase.storage
      .from('project-files')
      .download(storagePath)
    if (downloadError || !downloaded) {
      return {
        success: false,
        error: 'Failed to read uploaded file from storage: ' + (downloadError?.message ?? 'unknown error'),
      }
    }

    // Reconstruct a File-shaped wrapper for the rest of the pipeline. We
    // need both the text (for parsing) and a File (for the storage move
    // below + the activity-log filename). We pull filename out of the
    // storage path tail (after the timestamp + datasetId prefix).
    const text = await downloaded.text()
    const pathTail = storagePath.split('/').pop() ?? `${tableName}.csv`
    // pathTail format: `{timestamp}-{datasetId}-{safeName}`. Strip the
    // timestamp + datasetId prefix to recover the original filename for
    // logging. Two leading dashes if both timestamp and datasetId have no
    // dashes themselves (timestamp is digits; datasetId is a uuid which
    // does have dashes — so split on the FIRST two dashes only).
    const dashSplit = pathTail.split('-')
    const filename =
      dashSplit.length > 6
        ? dashSplit.slice(6).join('-') // skip [ts, uuidPart×5]
        : pathTail

    // ── Step 3: Parse CSV ─────────────────────────────────────────────────────
    const parseResult = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    })

    if (parseResult.errors.length > 0 && parseResult.data.length === 0) {
      return { success: false, error: 'Failed to parse CSV: ' + parseResult.errors[0].message }
    }

    const rows = parseResult.data
    if (rows.length === 0) {
      return { success: false, error: 'CSV has no data rows' }
    }
    if (rows.length > 1_000_000) {
      return { success: false, error: 'CSV exceeds 1,000,000 row limit' }
    }

    // ── Step 4: Sanitize + validate headers ───────────────────────────────────
    const rawHeaders = parseResult.meta.fields || Object.keys(rows[0])
    if (rawHeaders.length < 2) {
      return { success: false, error: 'CSV must have at least 2 columns' }
    }

    const headers = deduplicateHeaders(rawHeaders.map(sanitizeHeader))

    // ── Step 5: Sanitize all cell values ─────────────────────────────────────
    const sanitizedRows = rows.map((row: Record<string, string>) => {
      const out: Record<string, string> = {}
      rawHeaders.forEach((raw: string, i: number) => {
        const sanitized = headers[i]
        const val = row[raw] ?? ''
        out[sanitized] = sanitizeValue(String(val))
      })
      return out
    })

    // ── Step 6: Infer schema ──────────────────────────────────────────────────
    // Same value-observable inference as the legacy uploadCSV. Structural
    // metadata (PK/FK) is deliberately deferred to higher-priority schema_source
    // layers (ddl_parsed, doc_enriched, cross_table_inferred, manual) — see
    // lib/utils/schema-priority.ts for the cascade.
    const sampleRows = sanitizedRows.slice(0, 100)
    const inferredFields = headers.map((header, index) => {
      const values = sampleRows
        .map((r: Record<string, string>) => r[header])
        .filter((v: string) => v !== '' && v !== null && v !== undefined)

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

    // ── Step 7: Upsert table record (delete old + recreate) ───────────────────
    const { data: existingTable } = await supabase
      .from('tables')
      .select('id')
      .eq('dataset_id', datasetId)
      .eq('name', tableName)
      .maybeSingle()

    if (existingTable) {
      // Cascade delete cleans up fields, data_rows, field_profiles
      await supabase.from('tables').delete().eq('id', existingTable.id)
    }

    const { data: newTable, error: tableError } = await supabase
      .from('tables')
      .insert({ dataset_id: datasetId, name: tableName, row_count: rows.length, friendly_name: friendlyName })
      .select()
      .single()

    if (tableError || !newTable) {
      return { success: false, error: tableError?.message || 'Failed to create table record' }
    }
    const tableId: string = newTable.id

    // ── Step 8: Insert fields ─────────────────────────────────────────────────
    const { data: createdFields, error: fieldsError } = await supabase
      .from('fields')
      .insert(inferredFields.map((f) => ({ ...f, table_id: tableId })))
      .select()

    if (fieldsError || !createdFields) {
      await supabase.from('tables').delete().eq('id', tableId)
      return { success: false, error: 'Failed to create field records: ' + fieldsError?.message }
    }

    // ── Step 9: Insert data_rows in batches of 1,000 ─────────────────────────
    // Insert shape `{ table_id, row_number, row_data }` is preserved
    // byte-identically from the legacy uploadCSV. PR 3.3's data-scanning
    // RPCs (agent_query_field_data, agent_count_distinct_patterns,
    // agent_cross_field_correlation) read data_rows via this shape; the
    // refactor must NOT change it.
    const BATCH_SIZE = 1000
    for (let i = 0; i < sanitizedRows.length; i += BATCH_SIZE) {
      const batch = sanitizedRows.slice(i, i + BATCH_SIZE).map((row: Record<string, string>, idx: number) => ({
        table_id: tableId,
        row_number: i + idx + 1,
        row_data: row,
      }))
      const { error: rowsError } = await supabase.from('data_rows').insert(batch)
      if (rowsError) {
        await supabase.from('tables').delete().eq('id', tableId)
        return { success: false, error: 'Failed to insert rows: ' + rowsError.message }
      }
    }

    // ── Step 10: Compute and insert field_profiles SYNCHRONOUSLY ─────────────
    // CRITICAL: this MUST complete before the action returns success.
    // PR 3.4b's formatSchemaForPrompt reads field.sample_values from this
    // table; mapping-engine invocations downstream of upload assume the
    // profile rows already exist. Splitting this into background work
    // would break that contract.
    const profiles = createdFields.map((field) => {
      const fieldValues = sanitizedRows.map((r: Record<string, string>) => r[field.name] ?? '')
      const nonNull = fieldValues.filter((v: string) => v !== '' && v !== null && v !== undefined)
      const formatIssues = countFormatIssues(nonNull, field.data_type, field.inferred_type ?? null, field.name)

      const valueDistribution = computeValueDistribution(nonNull)
      const sampleValues = valueDistribution.slice(0, 10).map((d) => d.value)
      const { min: minValue, max: maxValue } = computeMinMax(nonNull, field.inferred_type ?? null)

      return {
        field_id: field.id,
        total_rows: sanitizedRows.length,
        null_count: sanitizedRows.length - nonNull.length,
        null_percentage: +(
          (((sanitizedRows.length - nonNull.length) / sanitizedRows.length) * 100).toFixed(2)
        ),
        cardinality: new Set(nonNull).size,
        unique_percentage:
          nonNull.length > 0 ? +((new Set(nonNull).size / nonNull.length) * 100).toFixed(2) : 0,
        format_issues_count: formatIssues,
        min_value: minValue,
        max_value: maxValue,
        sample_values: sampleValues,
        value_distribution: valueDistribution,
      }
    })

    await supabase.from('field_profiles').insert(profiles)

    // ── Step 11: Move file out of pending/ to its final path ─────────────────
    // The signed-URL path is `{user}/{project}/{role}/pending/{ts}-{ds}-{name}`.
    // After successful processing, move it to `{user}/{project}/{role}/{name}`
    // so the file lives at the same shape the legacy uploadCSV used (and
    // tables.csv_storage_path records it). Move failure is non-fatal —
    // the file is still accessible at the pending/ path; the daily cron
    // sweep would otherwise treat it as orphaned, but Step 12 records
    // the path against the table so cron won't delete it.
    const finalPath = `${user.id}/${projectId}/${role}/${filename}`
    const { error: moveError } = await supabase.storage
      .from('project-files')
      .move(storagePath, finalPath)
    const persistedPath = moveError ? storagePath : finalPath
    if (moveError) {
      console.warn('[csv] storage move from pending/ failed (non-fatal):', moveError.message)
    }
    await supabase.from('tables').update({ csv_storage_path: persistedPath }).eq('id', tableId)

    // ── Step 12: Auto-run source data quality checks ──────────────────────────
    // Fire-and-forget pattern preserved from legacy uploadCSV.
    try {
      const { runSourceDataChecks } = await import('@/lib/quality/detection-engine')
      await runSourceDataChecks(projectId, tableId, 'auto')
    } catch (detectionErr) {
      console.warn('[csv] Auto detection failed (non-fatal):', detectionErr)
    }

    // ── Step 13: AI schema enrichment (if schema docs exist for this dataset) ─
    try {
      const { count: docCount } = await supabase
        .from('schema_documents')
        .select('id', { count: 'exact', head: true })
        .eq('dataset_id', datasetId)
        .not('extracted_text', 'is', null)

      if ((docCount ?? 0) > 0) {
        const { enrichSchemaFromDocs } = await import('@/lib/actions/schema-enrichment')
        const enrichResult = await enrichSchemaFromDocs(datasetId, tableId)
        if (enrichResult.correctedFields > 0) {
          console.log(`[csv] Schema enrichment: ${enrichResult.correctedFields} field(s) corrected for table ${tableId}`)
        }
      }
    } catch (enrichErr) {
      console.warn('[csv] Schema enrichment failed (non-fatal):', enrichErr)
    }

    // ── Step 14: Cross-table FK inference ────────────────────────────────────
    try {
      const { inferCrossTableFKs } = await import('@/lib/quality/fk-inference')
      const result = await inferCrossTableFKs(projectId, datasetId)
      if (result.inferred.length > 0) {
        console.log(`[csv] FK inference added ${result.inferred.length} cross-table FK(s) after "${tableName}"`)
      }
      if (result.errors.length > 0) {
        console.warn('[csv] FK inference completed with errors:', result.errors)
      }
    } catch (inferErr) {
      console.warn('[csv] FK inference failed (non-fatal):', inferErr)
    }

    const actionType = role === 'source' ? 'source_uploaded' : 'target_uploaded'
    await logActivity(
      projectId,
      actionType,
      `${role === 'source' ? 'Source' : 'Target'} data uploaded: ${tableName} (${sanitizedRows.length} rows, ${inferredFields.length} fields)`,
      'data',
      { file_name: filename, table_name: tableName, row_count: sanitizedRows.length, field_count: inferredFields.length },
    )

    revalidatePath(`/app/projects/${projectId}`, 'layout')

    return {
      success: true,
      tableId,
      fieldCount: inferredFields.length,
      rowCount: sanitizedRows.length,
    }
  } catch (err) {
    console.error('[processUploadedCsv]', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unexpected error occurred',
    }
  }
}

// ─── Header sanitization ──────────────────────────────────────────────────────

function sanitizeHeader(name: string): string {
  const trimmed = name.trim().slice(0, 100)
  return trimmed.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'column'
}

function deduplicateHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((h) => {
    const count = seen.get(h) ?? 0
    seen.set(h, count + 1)
    return count === 0 ? h : `${h}_${count + 1}`
  })
}

// ─── Value sanitization ───────────────────────────────────────────────────────

function sanitizeValue(value: string): string {
  // Neutralize CSV formula injection (Excel/Sheets / DDE attack vector).
  // '=' and '@' at start are always formula triggers. Tab/CR are always injection vectors.
  if (/^[=@\t\r]/.test(value)) return "'" + value

  // '+' and '-' are ONLY dangerous when not followed by a number.
  //   +15551234567  → E.164 phone — legitimate, don't corrupt
  //   -70023.63     → negative number — legitimate, don't corrupt
  //   +CMD()        → DDE injection — sanitize
  //   -1+1+cmd|...  → DDE injection — sanitize
  if (value[0] === '+' || value[0] === '-') {
    const rest = value.slice(1).replace(/[$,.\s]/g, '')
    // Treat as safe if remainder is all digits (numeric or phone)
    if (rest === '' || /^\d+$/.test(rest)) return value
    return "'" + value
  }

  return value
}

// ─── Schema inference ─────────────────────────────────────────────────────────

function inferColumnType(
  name: string,
  values: string[]
): { dataType: string; inferredType: string | null } {
  const lower = name.toLowerCase()

  if (values.length === 0) return { dataType: 'VARCHAR(255)', inferredType: null }

  // Email — name hint or value pattern
  if (lower.includes('email') || values.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) {
    return { dataType: 'VARCHAR(255)', inferredType: 'email' }
  }

  // Boolean
  const boolSet = new Set(['true', 'false', '0', '1', 'yes', 'no', 'y', 'n', 't', 'f'])
  if (values.every((v) => boolSet.has(v.toLowerCase()))) {
    return { dataType: 'BOOLEAN', inferredType: null }
  }

  // ISO timestamp (must check before date)
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) {
    return { dataType: 'TIMESTAMP', inferredType: null }
  }

  // Date patterns
  const datePatterns = [/^\d{4}-\d{2}-\d{2}$/, /^\d{1,2}\/\d{1,2}\/\d{4}$/, /^\d{1,2}-\d{1,2}-\d{4}$/]
  if (values.every((v) => datePatterns.some((p) => p.test(v)))) {
    return { dataType: 'DATE', inferredType: null }
  }

  // Integer (no decimals)
  if (values.every((v) => /^-?\d+$/.test(v))) {
    const isCurrency =
      lower.includes('price') ||
      lower.includes('amount') ||
      lower.includes('revenue') ||
      lower.includes('salary') ||
      lower.includes('cost') ||
      lower.includes('total')
    if (isCurrency) return { dataType: 'DECIMAL(18,2)', inferredType: 'currency' }
    return { dataType: 'INT', inferredType: null }
  }

  // Decimal
  if (values.every((v) => /^-?\d+\.?\d*$/.test(v)) && values.some((v) => v.includes('.'))) {
    const isCurrency =
      lower.includes('price') ||
      lower.includes('amount') ||
      lower.includes('revenue') ||
      lower.includes('salary') ||
      lower.includes('cost') ||
      lower.includes('total')
    return { dataType: 'DECIMAL(18,2)', inferredType: isCurrency ? 'currency' : null }
  }

  // Phone
  if (lower.includes('phone') || lower.includes('mobile') || lower.includes('fax')) {
    return { dataType: 'VARCHAR(20)', inferredType: 'phone' }
  }

  // URL
  if (lower.includes('url') || lower.includes('website') || values.some((v) => /^https?:\/\//.test(v))) {
    return { dataType: 'VARCHAR(2048)', inferredType: 'url' }
  }

  // Default: VARCHAR sized to max observed length, min 40, round up to nearest 10
  const maxLen = Math.max(...values.map((v) => v.length), 1)
  const roundedLen = Math.min(4096, Math.max(40, Math.ceil(maxLen / 10) * 10))
  return { dataType: `VARCHAR(${roundedLen})`, inferredType: null }
}

// DEPRECATED: PK/FK detection removed from CSV upload.
// Structural metadata is now handled by DDL merge, cross-table inference,
// AI enrichment, and manual edit. This function is preserved for reference
// but not called.
//
// Context: column-name + uniqueness heuristics produced wrong answers on
// legacy schemas — e.g. NMLS_ID and TELLER_ID were mis-flagged as PK while
// the real PKs (BRANCH_NO, CIF_NO, OFFICER_CD) were missed because they
// don't end in "_id". Rather than extend the heuristic, CSV upload now
// defers PK/FK determination entirely to layers that work from authoritative
// evidence (see lib/utils/schema-priority.ts):
//   - ddl_parsed           (uploaded DDL / DB connector introspection)
//   - doc_enriched         (AI reading schema documentation)
//   - cross_table_inferred (value-overlap matching once real PKs exist)
//   - manual               (user edit in Schema Overview)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function detectKeyType(
  fieldName: string,
  tableName: string,
  values: string[],
  existingTables: { name: string }[]
): { isPrimaryKey: boolean; isForeignKey: boolean; fkReference: string | null } {
  const lowerField = fieldName.toLowerCase()
  const lowerTable = tableName.toLowerCase()
  const singularTable = lowerTable.endsWith('s') ? lowerTable.slice(0, -1) : lowerTable

  // Step 1: Self-referencing PK — highest priority, no uniqueness check needed.
  // "customer_id" in "customers" or "contacts" table → always PK.
  const isSelfReferencing =
    lowerField === 'id' ||
    lowerField === 'pk' ||
    lowerField === 'key' ||
    lowerField === `${lowerTable}_id` ||
    lowerField === `${singularTable}_id`

  if (isSelfReferencing) {
    return { isPrimaryKey: true, isForeignKey: false, fkReference: null }
  }

  // Step 2: FK detection — only if the referenced table actually exists.
  // "customer_id" in "contacts" when customers table already uploaded → FK.
  // Also populate fkReference so the orphaned FK check can use it.
  const fkMatch = lowerField.match(/^(.+?)_id$/)
  if (fkMatch) {
    const referencedName = fkMatch[1].toLowerCase()
    const matchedTable = existingTables.find((t) => {
      const otherTable = t.name.toLowerCase()
      const otherSingular = otherTable.endsWith('s') ? otherTable.slice(0, -1) : otherTable
      return referencedName === otherTable || referencedName === otherSingular
    })
    if (matchedTable) {
      // Canonical fk_reference: "<TableName>.<fieldName>" pointing to the likely PK of the parent
      const pkFieldName = referencedName + '_id'
      const fkRef = `${matchedTable.name}.${pkFieldName}`
      return { isPrimaryKey: false, isForeignKey: true, fkReference: fkRef }
    }
  }

  // Step 3: Heuristic PK — fallback for plain "id" variants with high uniqueness.
  const nonNullValues = values.filter((v) => v !== null && v !== undefined && v !== '')
  const uniqueRatio = new Set(nonNullValues).size / Math.max(nonNullValues.length, 1)
  const isIdColumn = lowerField === 'id' || lowerField.endsWith('_id')

  if (isIdColumn && uniqueRatio > 0.95 && nonNullValues.length > 0) {
    return { isPrimaryKey: true, isForeignKey: false, fkReference: null }
  }

  // Step 4: Heuristic FK fallback — *_id that isn't self-referencing.
  // Referenced table hasn't been uploaded yet — set a best-guess fk_reference
  // using the field name prefix so the orphaned FK check can fire once the
  // parent table is uploaded and the scan is re-run.
  if (lowerField.endsWith('_id') && fkMatch) {
    const prefix = fkMatch[1]
    // Capitalise first letter to match the table naming convention (e.g. Customers)
    const guessedTable = prefix.charAt(0).toUpperCase() + prefix.slice(1) + 's'
    const fkRef = `${guessedTable}.${lowerField}`
    return { isPrimaryKey: false, isForeignKey: true, fkReference: fkRef }
  }

  return { isPrimaryKey: false, isForeignKey: false, fkReference: null }
}

// Profiling helpers (computeValueDistribution, computeMinMax, countFormatIssues) are in
// lib/utils/profiling.ts — import from there. They are used below via the import at the top.
