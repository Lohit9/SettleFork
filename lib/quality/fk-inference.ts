/**
 * Cross-Table Foreign-Key Inference Engine
 *
 * Examines fields across sibling tables in a dataset and detects implicit
 * FK relationships that weren't declared in a DDL, enrichment doc, or
 * manual edit. Matches candidate columns against other tables' primary
 * keys by name (in three tiers of confidence), then verifies each
 * candidate with a value-overlap check against actual `data_rows` data.
 *
 * Priority cascade: this writer emits schema_source='cross_table_inferred'
 * (priority 1 — see lib/utils/schema-priority.ts) *only when the target
 * field is currently at 'inferred'*. For fields already at a higher tier
 * ('doc_enriched', 'ddl_parsed', or a prior 'cross_table_inferred' pass)
 * we still fill in is_foreign_key + fk_reference, but we leave
 * schema_source alone — the authoritative source for data_type /
 * is_primary_key stays with whoever wrote it. Fields at 'manual' are
 * skipped entirely: the user's explicit decision wins, full stop.
 *
 * Write contract (idempotent):
 *   - Skips fields where `schema_source = 'manual'` — user overrides win.
 *   - Skips fields where `is_foreign_key = true` — preserves both our own
 *     prior-run output and FKs declared by a DDL or enrichment.
 *   - Designed to run twice: once after CSV upload (catches *_id-style
 *     matches when PKs exist from the column-name heuristic) and again
 *     after DDL merge (catches the legacy-named PKs — BRANCH_NO, TYPE_CD,
 *     OFFICER_CD — that only become visible once a DDL has been parsed).
 *     The is_foreign_key filter keeps the second pass from re-doing the
 *     first pass's work.
 *   - UPDATE is guarded by a strict `schema_source = <pre-read value>`
 *     equality check so a concurrent writer who elevated the row between
 *     our read and write wins unconditionally.
 *   - Requires the schema_source CHECK constraint from migration 063.
 *
 * Safety contract: this function never throws. All failures are reported
 * through the returned `errors` array so callers can log without having
 * to wrap the call in try/catch just to keep their own action alive.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { normalizeName } from '@/lib/utils/name-normalize'

// ── Public types ─────────────────────────────────────────────────────────────

export interface InferredFK {
  tableName: string
  fieldName: string
  fieldId: string
  referencedTable: string
  referencedField: string
  confidence: 'high' | 'medium'
  overlapPercentage: number
}

export interface InferCrossTableFKsResult {
  inferred: InferredFK[]
  skipped: Array<{ field: string; reason: string }>
  errors: string[]
}

// ── Internal types ───────────────────────────────────────────────────────────

interface PkInfo {
  tableId: string
  fieldId: string
  tableName: string
  fieldName: string
}

interface CandidateField {
  tableId: string
  fieldId: string
  tableName: string
  fieldName: string
  /** Pre-read value. Used both to decide whether we can stamp schema_source
   *  to 'cross_table_inferred' and as the race guard on the UPDATE. */
  schemaSource: string
}

type MatchTier = 'exact_name' | 'table_name' | 'suffix_strip'

interface NameMatch {
  candidate: CandidateField
  pk: PkInfo
  tier: MatchTier
}

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Max rows sampled per candidate FK column when computing distinct values. */
const CANDIDATE_SAMPLE_LIMIT = 1000
/** Max rows pulled from a PK table to build its distinct-value set. */
const PK_SAMPLE_LIMIT = 10_000
/** Hard cap on overlap verifications per run — each one is a DB fetch. */
const MAX_CANDIDATES_TO_VERIFY = 30
/** Overlap ≥ this → high-confidence FK (when backed by an exact name match). */
const CONFIRM_THRESHOLD = 0.75
/** Overlap ≥ this but below CONFIRM_THRESHOLD → still written, logged as medium. */
const PROBABLE_THRESHOLD = 0.5
/** Minimum distinct non-null FK values before overlap math is statistically meaningful. */
const MIN_CANDIDATE_DISTINCT = 3
/** Minimum distinct PK values — guards against picking up status/flag fields that got mis-flagged as PK. */
const MIN_PK_DISTINCT = 2
/** Common trailing tokens that typically mark a field as a reference. Ordered longest-first so `_CODE` wins over `_CD` when both would apply. */
const FK_SUFFIXES = ['_CODE', '_KEY', '_REF', '_NUM', '_NO', '_CD', '_ID'] as const

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Infer cross-table FKs for every eligible field in a dataset and persist
 * the detections. Intended to run once after bulk ingestion (CSV upload or
 * DDL confirmation) — safe to call repeatedly.
 *
 * @param projectId  Project that owns the dataset. Used only to sanity-check
 *                   the caller isn't passing a dataset from a different project.
 * @param datasetId  Dataset whose tables should be scanned.
 */
export async function inferCrossTableFKs(
  projectId: string,
  datasetId: string
): Promise<InferCrossTableFKsResult> {
  const inferred: InferredFK[] = []
  const skipped: Array<{ field: string; reason: string }> = []
  const errors: string[] = []

  try {
    // Sanity check: confirm the dataset belongs to the claimed project. This
    // doesn't replace the caller's permission check — it just prevents a
    // mis-wired call from scribbling across project boundaries.
    const { data: dataset, error: datasetErr } = await supabaseAdmin
      .from('datasets')
      .select('id')
      .eq('id', datasetId)
      .eq('project_id', projectId)
      .maybeSingle()
    if (datasetErr) {
      errors.push(`dataset lookup: ${datasetErr.message}`)
      return { inferred, skipped, errors }
    }
    if (!dataset) {
      errors.push(`dataset ${datasetId} not found in project ${projectId}`)
      return { inferred, skipped, errors }
    }

    // Step 1a: list all tables in this dataset.
    const { data: tables, error: tablesErr } = await supabaseAdmin
      .from('tables')
      .select('id, name')
      .eq('dataset_id', datasetId)
    if (tablesErr) {
      errors.push(`list tables: ${tablesErr.message}`)
      return { inferred, skipped, errors }
    }
    if (!tables || tables.length < 2) {
      // Cross-table inference needs at least two tables in the dataset.
      return { inferred, skipped, errors }
    }
    const tableById = new Map(tables.map((t) => [t.id, { id: t.id, name: t.name }]))

    // Step 1b + 2: one batched query pulls every field we might care about
    // (both PKs and candidate FKs). Filtering is cheap in JS vs another round trip.
    const { data: fields, error: fieldsErr } = await supabaseAdmin
      .from('fields')
      .select('id, name, is_primary_key, is_foreign_key, schema_source, table_id')
      .in('table_id', [...tableById.keys()])
    if (fieldsErr) {
      errors.push(`list fields: ${fieldsErr.message}`)
      return { inferred, skipped, errors }
    }
    if (!fields || fields.length === 0) {
      return { inferred, skipped, errors }
    }

    // Build the PK registry. Keyed both by field name and table name (Step 3b
    // needs the latter to resolve "column-named-after-its-target-table").
    const pkByFieldName = new Map<string, PkInfo[]>()
    const pkByTableName = new Map<string, PkInfo[]>()

    for (const f of fields) {
      if (!f.is_primary_key) continue
      const tbl = tableById.get(f.table_id)
      if (!tbl) continue
      const info: PkInfo = {
        tableId: tbl.id,
        fieldId: f.id,
        tableName: tbl.name,
        fieldName: f.name,
      }
      // normalizeName (strips _/-/whitespace, lowercases) lets "BRANCH_NO"
      // match "Branch No" and "BRANCH_INFO" match "Branch Info" without
      // changing any display names.
      pushIntoMap(pkByFieldName, normalizeName(f.name), info)
      pushIntoMap(pkByTableName, normalizeName(tbl.name), info)
    }

    // Step 2: collect candidates. We consider any field that isn't already
    // flagged as a key *and* isn't locked by a manual user decision. The
    // broad schema_source filter (everything except 'manual') is what lets
    // this function do useful work on a second pass — after DDL merge has
    // elevated some fields to 'ddl_parsed' but didn't declare FKs. The
    // per-row write path further down decides whether we also get to
    // promote schema_source or only fill in FK info.
    const candidates: CandidateField[] = []
    for (const f of fields) {
      if (f.is_primary_key) continue
      if (f.is_foreign_key) continue
      if (f.schema_source === 'manual') continue
      const tbl = tableById.get(f.table_id)
      if (!tbl) continue
      candidates.push({
        tableId: tbl.id,
        fieldId: f.id,
        tableName: tbl.name,
        fieldName: f.name,
        schemaSource: f.schema_source,
      })
    }

    // Step 3: tiered name-matching. For each candidate, keep the best tier that
    // yields at least one PK in a different table. We take one best match per
    // candidate — overlap verification below is the authoritative gate, so
    // there's no point spending the per-run budget on same-candidate ambiguity.
    const bestByCandidate = new Map<string, NameMatch>()
    for (const cand of candidates) {
      const match = findBestNameMatch(cand, pkByFieldName, pkByTableName)
      if (!match) {
        skipped.push({ field: qualify(cand), reason: 'no PK match found' })
        continue
      }
      bestByCandidate.set(cand.fieldId, match)
    }

    // Prioritize higher-tier (exact name) matches so the per-run budget spends
    // on the most-likely FKs first.
    const ordered = [...bestByCandidate.values()].sort(
      (a, b) => tierRank(a.tier) - tierRank(b.tier)
    )
    const toVerify = ordered.slice(0, MAX_CANDIDATES_TO_VERIFY)
    for (const m of ordered.slice(MAX_CANDIDATES_TO_VERIFY)) {
      skipped.push({
        field: qualify(m.candidate),
        reason: `exceeded per-run cap of ${MAX_CANDIDATES_TO_VERIFY} overlap verifications`,
      })
    }

    // Step 4: value-overlap verification. Cache row fetches so two candidates
    // that share a PK target (common — e.g. every table references BRANCH_INFO)
    // don't refetch its rows.
    const rowCache = new Map<string, Record<string, unknown>[]>()
    const confirmed: Array<{ match: NameMatch; overlap: number }> = []

    for (const match of toVerify) {
      try {
        const candRows = await getRows(match.candidate.tableId, CANDIDATE_SAMPLE_LIMIT, rowCache)
        const candValues = distinctNonEmpty(candRows, match.candidate.fieldName, CANDIDATE_SAMPLE_LIMIT)
        if (candValues.size < MIN_CANDIDATE_DISTINCT) {
          skipped.push({
            field: qualify(match.candidate),
            reason: `too few distinct non-null values (${candValues.size}) to verify overlap`,
          })
          continue
        }

        const pkRows = await getRows(match.pk.tableId, PK_SAMPLE_LIMIT, rowCache)
        const pkValues = distinctNonEmpty(pkRows, match.pk.fieldName, PK_SAMPLE_LIMIT)
        if (pkValues.size < MIN_PK_DISTINCT) {
          skipped.push({
            field: qualify(match.candidate),
            reason: `target ${match.pk.tableName}.${match.pk.fieldName} has too few distinct values (${pkValues.size})`,
          })
          continue
        }

        let intersect = 0
        for (const v of candValues) if (pkValues.has(v)) intersect++
        const overlap = intersect / candValues.size

        if (overlap < PROBABLE_THRESHOLD) {
          skipped.push({
            field: qualify(match.candidate),
            reason: `overlap ${(overlap * 100).toFixed(1)}% with ${match.pk.tableName}.${match.pk.fieldName} below ${PROBABLE_THRESHOLD * 100}% threshold`,
          })
          continue
        }

        confirmed.push({ match, overlap })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`overlap check for ${qualify(match.candidate)}: ${msg}`)
      }
    }

    // Step 5: persist. Two-branch write: if the field was at 'inferred' we
    // own the structural label and stamp 'cross_table_inferred'; otherwise
    // something higher-priority (ddl_parsed / doc_enriched / a prior pass)
    // already wrote the row and we only contribute FK info. The race guard
    // (.eq on the pre-read schema_source) closes the TOCTOU window — if a
    // concurrent writer changed the row between our read and write, the
    // UPDATE matches zero rows and we skip.
    for (const { match, overlap } of confirmed) {
      const confidence: InferredFK['confidence'] =
        match.tier === 'exact_name' && overlap >= CONFIRM_THRESHOLD ? 'high' : 'medium'
      const fkReference = `${match.pk.tableName}.${match.pk.fieldName}`
      const pct = +(overlap * 100).toFixed(1)

      const updatePayload: Record<string, unknown> = {
        is_foreign_key: true,
        fk_reference: fkReference,
      }
      const claimsSource = match.candidate.schemaSource === 'inferred'
      if (claimsSource) {
        updatePayload.schema_source = 'cross_table_inferred'
      }

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('fields')
        .update(updatePayload)
        .eq('id', match.candidate.fieldId)
        .eq('schema_source', match.candidate.schemaSource)
        .select('id')
        .maybeSingle()

      if (updateErr) {
        errors.push(`update ${qualify(match.candidate)}: ${updateErr.message}`)
        continue
      }
      if (!updated) {
        // Write-time race: schema_source changed between our snapshot read
        // and this update. Whoever changed it wins — we let their value
        // stand and try again on the next invocation (is_foreign_key is
        // still false so we remain a candidate).
        console.log(
          `[Schema Priority] Skipping update to ${qualify(match.candidate)} — schema_source raced (was '${match.candidate.schemaSource}')`
        )
        skipped.push({
          field: qualify(match.candidate),
          reason: `field schema_source changed before write (was '${match.candidate.schemaSource}') — a concurrent writer won`,
        })
        continue
      }

      inferred.push({
        tableName: match.candidate.tableName,
        fieldName: match.candidate.fieldName,
        fieldId: match.candidate.fieldId,
        referencedTable: match.pk.tableName,
        referencedField: match.pk.fieldName,
        confidence,
        overlapPercentage: pct,
      })

      console.log(
        `[FK Inference] ${match.candidate.tableName}.${match.candidate.fieldName} → ${fkReference} (overlap: ${pct}%, confidence: ${confidence})`
      )
    }

    for (const s of skipped) {
      console.log(`[FK Inference] Skipped ${s.field}: ${s.reason}`)
    }
  } catch (err) {
    // Unexpected control-flow failure. Callers treat this as non-fatal.
    errors.push(err instanceof Error ? err.message : String(err))
  }

  return { inferred, skipped, errors }
}

// ── Name matching ────────────────────────────────────────────────────────────

function findBestNameMatch(
  cand: CandidateField,
  pkByFieldName: Map<string, PkInfo[]>,
  pkByTableName: Map<string, PkInfo[]>
): NameMatch | null {
  // Shared normalizeName (underscore/hyphen/whitespace stripped, lowercased)
  // keeps this comparison aligned with the rest of the schema layer —
  // "BRANCH_NO", "Branch No", and "branch-no" all collapse to the same key.
  const candKey = normalizeName(cand.fieldName)

  // 3a — exact name match. Highest confidence: column name is literally the
  // PK field name in another table. Skip same-table matches (a PK doesn't
  // reference itself).
  const exact = (pkByFieldName.get(candKey) ?? []).filter((p) => p.tableId !== cand.tableId)
  if (exact.length > 0) {
    return { candidate: cand, pk: pickDeterministic(exact), tier: 'exact_name' }
  }

  // 3b — column name equals a table name in the dataset. Handles the
  // "ACCT_TYPE_CD column referencing the ACCT_TYPE_CD lookup table whose PK
  // is named TYPE_CD" pattern. We look up the table's PK(s) and target one.
  const byTable = (pkByTableName.get(candKey) ?? []).filter((p) => p.tableId !== cand.tableId)
  if (byTable.length > 0) {
    return { candidate: cand, pk: pickDeterministic(byTable), tier: 'table_name' }
  }

  // 3c — strip a common trailing FK suffix and try the table-name map on the
  // stem. E.g. CUSTOMER_ID → stem CUSTOMER → table CUSTOMER's PK.
  // We only try the table-name map on the stem (not the field-name map),
  // because the stem is a noun, not a column name. stripFkSuffix operates
  // on the raw name (suffixes like "_ID" need the underscore to match);
  // normalization happens after, for the map lookup only.
  const stem = stripFkSuffix(cand.fieldName)
  if (stem) {
    const stemKey = normalizeName(stem)
    if (stemKey !== candKey) {
      const stemPks = (pkByTableName.get(stemKey) ?? []).filter(
        (p) => p.tableId !== cand.tableId
      )
      if (stemPks.length > 0) {
        return { candidate: cand, pk: pickDeterministic(stemPks), tier: 'suffix_strip' }
      }
    }
  }

  return null
}

function stripFkSuffix(name: string): string | null {
  const upper = name.toUpperCase()
  for (const suffix of FK_SUFFIXES) {
    if (upper.endsWith(suffix) && upper.length > suffix.length) {
      return upper.slice(0, -suffix.length)
    }
  }
  return null
}

function tierRank(t: MatchTier): number {
  switch (t) {
    case 'exact_name':
      return 0
    case 'table_name':
      return 1
    case 'suffix_strip':
      return 2
  }
}

/** Deterministic tie-break so two invocations produce the same matches. */
function pickDeterministic(pks: PkInfo[]): PkInfo {
  return [...pks].sort((a, b) =>
    a.tableName === b.tableName
      ? a.fieldName.localeCompare(b.fieldName)
      : a.tableName.localeCompare(b.tableName)
  )[0]
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function getRows(
  tableId: string,
  limit: number,
  cache: Map<string, Record<string, unknown>[]>
): Promise<Record<string, unknown>[]> {
  const key = `${tableId}|${limit}`
  const hit = cache.get(key)
  if (hit) return hit

  const { data, error } = await supabaseAdmin
    .from('data_rows')
    .select('row_data')
    .eq('table_id', tableId)
    .limit(limit)
  if (error) throw new Error(`data_rows fetch for table ${tableId}: ${error.message}`)

  const rows = (data ?? [])
    .map((r) => r.row_data as Record<string, unknown> | null)
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
  cache.set(key, rows)
  return rows
}

function distinctNonEmpty(
  rows: Record<string, unknown>[],
  fieldName: string,
  cap: number
): Set<string> {
  const out = new Set<string>()
  for (const row of rows) {
    const raw = row[fieldName]
    if (raw === null || raw === undefined) continue
    const s = String(raw).trim()
    if (s === '') continue
    out.add(s)
    if (out.size >= cap) break
  }
  return out
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

function pushIntoMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key)
  if (arr) arr.push(value)
  else map.set(key, [value])
}

function qualify(c: CandidateField): string {
  return `${c.tableName}.${c.fieldName}`
}
