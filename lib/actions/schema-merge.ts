'use server'

/**
 * Schema Merge
 *
 * Deterministic post-processing for DDL text uploaded to Schema Documentation.
 *
 * The Schema Documentation upload path (uploadSchemaDocument) historically
 * only stored the file and delegated everything to AI enrichment, which means
 * authoritative DDL declarations were interpreted through Claude rather than
 * read directly. This module reuses the DDL parser to extract the same
 * structural metadata the "DDL Upload" ingestion method would produce, then
 * merges it into whatever fields already exist in the dataset.
 *
 * Key differences vs. confirmDDLSchema in lib/actions/ddl-upload.ts:
 *   - NON-DESTRUCTIVE. We never drop or replace existing tables. This is
 *     important because Schema Documentation uploads happen *after* CSVs are
 *     already in the dataset with real row data.
 *   - UPDATE-in-place. For each parsed field that matches an existing field
 *     (normalized name — underscores, hyphens, and whitespace stripped, so
 *     "BRANCH_NO" ≡ "Branch No") we overwrite its structural columns, guarded
 *     by the schema_source priority cascade (see lib/utils/schema-priority).
 *   - 3-LAYER TABLE MATCHING. CSV-created tables carry user-entered display
 *     names ("Branch Info") while DDL parsing preserves raw identifiers
 *     ("BRANCH_INFO"). The matcher resolves each parsed table in three
 *     passes: normalized-name equality, then field-name fingerprint overlap,
 *     then a single Claude call over whatever is still unmatched.
 *   - Target-role only INSERTs. For target datasets, parsed fields that have
 *     no existing row can be inserted (the target schema often has columns
 *     no source CSV contained). For source datasets, we never invent fields
 *     — source fields must trace back to observed data.
 *
 * The function is intentionally tolerant: if parseDDL finds no CREATE TABLE
 * statements (common for data-dictionary .txt files) it returns cleanly with
 * an all-zeroes result so the caller can still hand the text off to AI
 * enrichment. Errors are collected in the `errors` array instead of thrown,
 * so a bad DDL blob never takes down the wider upload flow.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  parseDDL,
  type CheckConstraint,
  type ParsedTable,
} from '@/lib/parsers/ddl-parser'
import {
  SCHEMA_SOURCE_PRIORITY,
  canOverride,
  type SchemaSource,
} from '@/lib/utils/schema-priority'
import { inferBasicType } from '@/lib/utils/infer-basic-type'
import { normalizeName } from '@/lib/utils/name-normalize'
import { callClaude } from '@/lib/ai/claude'

export interface MergeConstraintsResult {
  fieldsUpdated: number
  fieldsSkipped: number
  fieldsAdded: number
  rulesSeeded: number
  errors: string[]
}

interface PendingRule {
  project_id: string
  table_id: string
  field_id: string
  name: string
  rule_type: string
  rule_config: Record<string, unknown>
  severity: 'blocking'
  is_ai_generated: boolean
}

/** Minimal field shape consumed by the merge loop and the table matcher. */
interface ExistingField {
  id: string
  name: string
  schema_source: string
  ordinal_position: number
}

/** Minimal table shape with joined fields, produced by the tables-plus-fields query. */
interface ExistingTable {
  id: string
  name: string
  fields: ExistingField[]
}

/** One resolved DDL ↔ existing pairing, tagged with the layer that produced it. */
interface MatchedPair {
  parsedTable: ParsedTable
  existingTable: ExistingTable
  matchedVia: 'layer1_name' | 'layer2_fingerprint' | 'layer3_ai'
}

/**
 * Deterministically parse `ddlText` and merge extracted constraints into the
 * dataset's existing fields. Respects the schema_source priority cascade: a
 * field carrying a higher-priority label (e.g. 'manual') is never clobbered.
 *
 * Always resolves — never throws. Check `result.errors` for non-fatal issues.
 *
 * @param datasetId            Dataset receiving the merge.
 * @param projectId            Owning project (needed for validation_rules FK).
 * @param ddlText              Raw extracted text (can be full DDL, mixed prose
 *                             with CREATE TABLE blocks, or nothing parseable).
 * @param datasetRole          'source' → only update existing fields;
 *                             'target' → also insert fields the DDL declares
 *                             but no existing row matches.
 * @param schemaSourceOverride The label to stamp on updated / inserted rows.
 *                             Defaults to 'ddl_parsed' because that's where
 *                             this text came from.
 */
export async function mergeConstraintsFromDDL(
  datasetId: string,
  projectId: string,
  ddlText: string,
  datasetRole: 'source' | 'target',
  schemaSourceOverride: SchemaSource = 'ddl_parsed'
): Promise<MergeConstraintsResult> {
  const result: MergeConstraintsResult = {
    fieldsUpdated: 0,
    fieldsSkipped: 0,
    fieldsAdded: 0,
    rulesSeeded: 0,
    errors: [],
  }

  if (!ddlText || ddlText.trim().length === 0) {
    return result
  }

  // ── Step 1: parse DDL ────────────────────────────────────────────────────
  let parsed: ReturnType<typeof parseDDL>
  try {
    parsed = parseDDL(ddlText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[Schema Merge] parseDDL failed: ${msg}`)
    result.errors.push(`parseDDL failed: ${msg}`)
    return result
  }

  if (parsed.length === 0) {
    // Not DDL, or DDL the regex parser couldn't pick up. Silent no-op — the
    // AI enrichment path downstream can still make sense of the text.
    console.log('[Schema Merge] No CREATE TABLE statements detected — skipping deterministic merge')
    return result
  }

  console.log(
    `[Schema Merge] parseDDL extracted ${parsed.length} table(s) for dataset ${datasetId} (role=${datasetRole})`
  )

  // Which existing schema_source labels can we overwrite? Anything at or below
  // the override's priority. The same list drives the write-time race guard
  // in the UPDATE filter below.
  const targetIdx = SCHEMA_SOURCE_PRIORITY.indexOf(schemaSourceOverride)
  const overridableSources: string[] =
    targetIdx === -1 ? [] : [...SCHEMA_SOURCE_PRIORITY.slice(0, targetIdx + 1)]

  // ── Step 2: load existing tables + their fields (single joined query) ────
  // Pulling fields up-front serves three consumers:
  //   1. Layer 1 of the table matcher (normalized name comparison).
  //   2. Layer 2 of the table matcher (field-name fingerprint overlap).
  //   3. The per-table merge body below, which previously did an N+1 fetch.
  // This collapses the old pattern of "1 tables query + N fields queries" into
  // a single round-trip per invocation.
  const { data: tablesRaw, error: tablesErr } = await supabaseAdmin
    .from('tables')
    .select('id, name, fields(id, name, schema_source, ordinal_position)')
    .eq('dataset_id', datasetId)

  if (tablesErr) {
    result.errors.push(`list tables: ${tablesErr.message}`)
    return result
  }

  const existingTables: ExistingTable[] = (
    (tablesRaw ?? []) as unknown as ExistingTable[]
  ).map((t) => ({
    id: t.id,
    name: t.name,
    fields: t.fields ?? [],
  }))

  // Collected across all tables; inserted in one batch at the end to keep the
  // number of round-trips small.
  const pendingRules: PendingRule[] = []

  // ── Step 3: match parsed DDL tables → existing tables (3 layers) ─────────
  // CSV-created tables hold user-entered display names ("Branch Info") while
  // DDL parsing preserves raw identifiers ("BRANCH_INFO"). A plain lowercase
  // equality misses all such pairs. The layered matcher progressively relaxes
  // its heuristic and falls back to a single Claude call when the
  // deterministic layers can't resolve a name. See `matchDdlTablesToExisting`.
  const matches = await matchDdlTablesToExisting(parsed, existingTables)

  // ── Step 4: per matched pair, merge fields ───────────────────────────────
  for (const { parsedTable, existingTable } of matches) {
    const fieldByName = new Map<string, ExistingField>()
    let maxOrdinal = 0
    for (const f of existingTable.fields) {
      fieldByName.set(normalizeName(f.name), f)
      if (f.ordinal_position > maxOrdinal) maxOrdinal = f.ordinal_position
    }

    // Target-role new-field INSERTs accumulated per table so we can insert
    // them as a batch and then seed rules against the fresh IDs.
    type NewFieldInsert = {
      table_id: string
      name: string
      data_type: string
      inferred_type: string | null
      is_nullable: boolean
      is_primary_key: boolean
      is_foreign_key: boolean
      fk_reference: string | null
      ordinal_position: number
      check_constraint: CheckConstraint | null
      schema_source: SchemaSource
    }
    const newFields: NewFieldInsert[] = []
    const pendingCheckForNewField: Array<{
      fieldName: string
      constraint: CheckConstraint
    }> = []

    for (const pf of parsedTable.fields) {
      const match = fieldByName.get(normalizeName(pf.name))

      // ── No existing field ──
      if (!match) {
        if (datasetRole === 'target') {
          maxOrdinal += 1
          newFields.push({
            table_id: existingTable.id,
            name: pf.name,
            data_type: pf.dataType,
            inferred_type: inferBasicType(pf.dataType),
            is_nullable: pf.isNullable,
            is_primary_key: pf.isPrimaryKey,
            is_foreign_key: pf.isForeignKey,
            fk_reference: pf.fkReference,
            ordinal_position: maxOrdinal,
            check_constraint: pf.checkConstraint ?? null,
            schema_source: schemaSourceOverride,
          })
          if (pf.checkConstraint) {
            pendingCheckForNewField.push({
              fieldName: pf.name,
              constraint: pf.checkConstraint,
            })
          }
          console.log(
            `[Schema Merge] Queued INSERT for target field ${existingTable.name}.${pf.name}`
          )
        } else {
          // Source DDL declared a column that no CSV contained. We don't
          // fabricate source fields — they must trace back to observed data.
          result.fieldsSkipped++
          console.log(
            `[Schema Merge] Skipping ${existingTable.name}.${pf.name} — DDL-declared field has no matching source data`
          )
        }
        continue
      }

      // ── Priority guard (upfront) ──
      if (!canOverride(match.schema_source, schemaSourceOverride)) {
        result.fieldsSkipped++
        console.log(
          `[Schema Priority] Skipping update to ${existingTable.name}.${match.name} — '${match.schema_source}' > '${schemaSourceOverride}'`
        )
        continue
      }

      const updates = {
        is_nullable: pf.isNullable,
        is_primary_key: pf.isPrimaryKey,
        is_foreign_key: pf.isForeignKey,
        fk_reference: pf.fkReference,
        data_type: pf.dataType,
        inferred_type: inferBasicType(pf.dataType),
        check_constraint: pf.checkConstraint ?? null,
        schema_source: schemaSourceOverride,
      }

      // Write-time race guard. Another writer (e.g. a parallel manual edit
      // bumping schema_source to 'manual') may have promoted this row after
      // we read it. The .in() filter makes the UPDATE match zero rows in
      // that case, and we log it instead of silently clobbering.
      const { data: updatedRows, error: updErr } = await supabaseAdmin
        .from('fields')
        .update(updates)
        .eq('id', match.id)
        .in('schema_source', overridableSources)
        .select('id')

      if (updErr) {
        result.errors.push(
          `update ${existingTable.name}.${match.name}: ${updErr.message}`
        )
        continue
      }

      if (!updatedRows || updatedRows.length === 0) {
        result.fieldsSkipped++
        console.log(
          `[Schema Priority] Skipping update to ${existingTable.name}.${match.name} — schema_source raced to a higher priority before write`
        )
        continue
      }

      result.fieldsUpdated++
      console.log(
        `[Schema Merge] Updated ${existingTable.name}.${match.name} (was '${match.schema_source}', now '${schemaSourceOverride}')`
      )

      if (pf.checkConstraint) {
        pendingRules.push(
          ...buildRuleInsertsForField({
            projectId,
            tableId: existingTable.id,
            fieldId: match.id,
            fieldName: pf.name,
            constraint: pf.checkConstraint,
          })
        )
      }
    }

    // ── Bulk-insert new target fields for this table ──────────────────────
    if (newFields.length > 0) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('fields')
        .insert(newFields)
        .select('id, name')

      if (insErr) {
        result.errors.push(
          `insert new fields for ${existingTable.name}: ${insErr.message}`
        )
      } else if (inserted) {
        result.fieldsAdded += inserted.length
        console.log(
          `[Schema Merge] Inserted ${inserted.length} new field(s) into ${existingTable.name}`
        )
        const newFieldIdByName = new Map(
          inserted.map((f: { id: string; name: string }) => [
            normalizeName(f.name),
            f.id,
          ])
        )
        for (const pending of pendingCheckForNewField) {
          const fid = newFieldIdByName.get(normalizeName(pending.fieldName))
          if (!fid) continue
          pendingRules.push(
            ...buildRuleInsertsForField({
              projectId,
              tableId: existingTable.id,
              fieldId: fid,
              fieldName: pending.fieldName,
              constraint: pending.constraint,
            })
          )
        }
      }
    }
  }

  // ── Step 5: seed validation_rules (dedup by exact name) ──────────────────
  // Rule names are suffixed "(from DDL doc)" to distinguish from "(from DDL)"
  // written by confirmDDLSchema and "(from DB)" written by db-connector.
  // That keeps the two provenance paths independent: re-uploading the same
  // DDL twice via Schema Documentation is idempotent against itself, but a
  // DDL Upload of the same shape still gets to own its own rule set.
  if (pendingRules.length > 0) {
    const ruleNames = pendingRules.map((r) => r.name)
    const { data: existingRules, error: existingErr } = await supabaseAdmin
      .from('validation_rules')
      .select('name')
      .eq('project_id', projectId)
      .in('name', ruleNames)

    if (existingErr) {
      result.errors.push(`check existing rules: ${existingErr.message}`)
    } else {
      const existingNames = new Set(
        (existingRules ?? []).map((r: { name: string }) => r.name)
      )
      const fresh = pendingRules.filter((r) => !existingNames.has(r.name))

      if (fresh.length > 0) {
        const { error: ruleErr } = await supabaseAdmin
          .from('validation_rules')
          .insert(fresh)

        if (ruleErr) {
          result.errors.push(`seed validation rules: ${ruleErr.message}`)
        } else {
          result.rulesSeeded = fresh.length
          console.log(
            `[Schema Merge] Seeded ${fresh.length} validation rule(s) from CHECK constraints`
          )
        }
      }
    }
  }

  console.log(
    `[Schema Merge] Done. updated=${result.fieldsUpdated} skipped=${result.fieldsSkipped} added=${result.fieldsAdded} rulesSeeded=${result.rulesSeeded} errors=${result.errors.length}`
  )

  // ── Step 6: re-run cross-table FK inference ──────────────────────────────
  // Legacy-named PKs (BRANCH_NO, CIF_NO, TYPE_CD, OFFICER_CD, …) typically
  // don't exist after CSV upload — they're only established once a DDL has
  // been parsed. FK inference already runs post-CSV (lib/actions/csv.ts) but
  // finds nothing useful when there are no PKs in the dataset yet. Re-running
  // it here, once the DDL merge has promoted the real PKs, is what turns the
  // implicit references (Account Master.BRANCH_NO → Branch Info.BRANCH_NO,
  // etc.) into is_foreign_key + fk_reference rows that the validation engine
  // and the execution planner can consume.
  //
  // Gate on fieldsUpdated: if the merge didn't change anything, the PK
  // landscape is unchanged and a re-run would just repeat the last call.
  // Dynamic import breaks any potential circular dep and defers loading to
  // the rare "DDL actually matched" path. Any failure is non-fatal — the
  // merge itself already succeeded.
  if (result.fieldsUpdated > 0) {
    try {
      const { inferCrossTableFKs } = await import('@/lib/quality/fk-inference')
      console.log('[DDL Merge] Re-running FK inference with DDL-established PKs...')
      const fkResult = await inferCrossTableFKs(projectId, datasetId)
      const summary =
        fkResult.inferred.length > 0
          ? ': ' +
            fkResult.inferred
              .map(
                (fk) =>
                  `${fk.tableName}.${fk.fieldName} → ${fk.referencedTable}.${fk.referencedField}`
              )
              .join(', ')
          : ''
      console.log(
        `[DDL Merge → FK Inference] Inferred ${fkResult.inferred.length} FK(s)${summary}`
      )
      if (fkResult.errors.length > 0) {
        console.warn(
          `[DDL Merge → FK Inference] ${fkResult.errors.length} non-fatal error(s):`,
          fkResult.errors
        )
      }
    } catch (err) {
      console.error('[DDL Merge → FK Inference] Error:', err)
    }
  }

  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build validation_rule INSERT rows for a single field's CHECK constraint.
 * Mirrors the shapes in lib/actions/ddl-upload.ts so both write paths stay in
 * lockstep with the read path in lib/actions/validation-rules.ts.
 *
 * Canonical rule_config shapes (MUST match executeCustomRules):
 *   allowed_values → { values: string[] }
 *   regex          → { pattern: string }
 *   range          → { min: number, max: number }
 *   min_value      → { min: number }
 *   max_value      → { max: number }
 */
function buildRuleInsertsForField(args: {
  projectId: string
  tableId: string
  fieldId: string
  fieldName: string
  constraint: CheckConstraint
}): PendingRule[] {
  const { projectId, tableId, fieldId, fieldName, constraint } = args
  const base = {
    project_id: projectId,
    table_id: tableId,
    field_id: fieldId,
    severity: 'blocking' as const,
    is_ai_generated: false,
  }

  if (constraint.type === 'in_list' && constraint.allowedValues.length > 0) {
    return [
      {
        ...base,
        name: `${fieldName}: allowed values (from DDL doc)`,
        rule_type: 'allowed_values',
        rule_config: { values: constraint.allowedValues },
      },
    ]
  }

  if (constraint.type === 'regex' && constraint.pattern) {
    return [
      {
        ...base,
        name: `${fieldName}: format validation (from DDL doc)`,
        rule_type: 'regex',
        rule_config: { pattern: constraint.pattern },
      },
    ]
  }

  if (constraint.type === 'range') {
    if (constraint.min !== undefined && constraint.max !== undefined) {
      return [
        {
          ...base,
          name: `${fieldName}: value range (from DDL doc)`,
          rule_type: 'range',
          rule_config: { min: constraint.min, max: constraint.max },
        },
      ]
    }
    if (constraint.min !== undefined) {
      return [
        {
          ...base,
          name: `${fieldName}: minimum value (from DDL doc)`,
          rule_type: 'min_value',
          rule_config: { min: constraint.min },
        },
      ]
    }
    if (constraint.max !== undefined) {
      return [
        {
          ...base,
          name: `${fieldName}: maximum value (from DDL doc)`,
          rule_type: 'max_value',
          rule_config: { max: constraint.max },
        },
      ]
    }
  }

  // 'custom' CHECK — no deterministic runtime handler exists yet, so skip.
  // Claude-driven rule generation or a future typed handler would pick this up.
  return []
}

// ── Table matching (3 layers) ─────────────────────────────────────────────────
//
// DDL identifiers and user-entered display names rarely collide on a plain
// equality check. The matcher resolves that in three passes, each strictly
// more permissive than the previous. Layers 1 and 2 are deterministic and run
// in-memory; Layer 3 spends a single Claude call only when the earlier layers
// couldn't resolve a name and there are still unmatched candidates on both
// sides. Every match is one-to-one: once an existing table has been claimed
// by one DDL table it's taken out of the pool for the remaining layers.

const LAYER2_MIN_OVERLAP = 0.6
const LAYER2_MIN_MATCHED_FIELDS = 3

/**
 * Match each parsed DDL table to at most one existing table using the three
 * layers described above. Returns pairs in the order they were resolved
 * (Layer 1 first, then Layer 2, then Layer 3). Unresolved DDL tables are not
 * in the returned array and are logged once each.
 */
async function matchDdlTablesToExisting(
  parsed: ParsedTable[],
  existing: ExistingTable[]
): Promise<MatchedPair[]> {
  const pairs: MatchedPair[] = []
  const usedDdlIdx = new Set<number>()
  const usedExistingId = new Set<string>()

  // ── Layer 1: normalized-name equality ──────────────────────────────────
  // Strips underscores/hyphens/whitespace and lowercases, so "BRANCH_INFO",
  // "Branch Info", and "branch-info" all collapse to the same key. This
  // handles the overwhelming majority of real-world mismatches.
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    const pKey = normalizeName(p.name)
    for (const e of existing) {
      if (usedExistingId.has(e.id)) continue
      if (normalizeName(e.name) !== pKey) continue
      pairs.push({ parsedTable: p, existingTable: e, matchedVia: 'layer1_name' })
      usedDdlIdx.add(i)
      usedExistingId.add(e.id)
      console.log(
        `[DDL Merge] Layer 1 match: ${p.name} → "${e.name}" (normalized name)`
      )
      break
    }
  }

  // ── Layer 2: field-name fingerprint ────────────────────────────────────
  // For any DDL table we didn't name-match, count how many of its fields
  // (by normalized name) exist in each remaining existing table. The best
  // candidate per DDL table wins — greedy, but ties are broken by input
  // order which is good enough in practice. Thresholds keep small tables
  // (2-field lookup tables) from producing 100% "matches" against
  // incidental overlap with unrelated fact tables.
  const unmatchedDdlIndices = parsed
    .map((_, idx) => idx)
    .filter((idx) => !usedDdlIdx.has(idx))

  if (unmatchedDdlIndices.length > 0) {
    const remainingExisting = existing.filter((e) => !usedExistingId.has(e.id))
    const existingFieldKeys = remainingExisting.map(
      (e) => new Set(e.fields.map((f) => normalizeName(f.name)))
    )

    interface L2Candidate {
      ddlIdx: number
      existingListIdx: number
      matched: number
      total: number
      overlap: number
    }
    const candidates: L2Candidate[] = []

    for (const ddlIdx of unmatchedDdlIndices) {
      const p = parsed[ddlIdx]
      const total = p.fields.length
      if (total === 0) continue
      const pKeys = p.fields.map((f) => normalizeName(f.name))
      for (let eIdx = 0; eIdx < remainingExisting.length; eIdx++) {
        const eKeys = existingFieldKeys[eIdx]
        let matched = 0
        for (const k of pKeys) if (eKeys.has(k)) matched++
        if (matched < LAYER2_MIN_MATCHED_FIELDS) continue
        const overlap = matched / total
        if (overlap < LAYER2_MIN_OVERLAP) continue
        candidates.push({ ddlIdx, existingListIdx: eIdx, matched, total, overlap })
      }
    }

    candidates.sort((a, b) => b.overlap - a.overlap)

    const l2UsedDdl = new Set<number>()
    const l2UsedExisting = new Set<number>()
    for (const c of candidates) {
      if (l2UsedDdl.has(c.ddlIdx)) continue
      if (l2UsedExisting.has(c.existingListIdx)) continue
      const p = parsed[c.ddlIdx]
      const e = remainingExisting[c.existingListIdx]
      pairs.push({ parsedTable: p, existingTable: e, matchedVia: 'layer2_fingerprint' })
      usedDdlIdx.add(c.ddlIdx)
      usedExistingId.add(e.id)
      l2UsedDdl.add(c.ddlIdx)
      l2UsedExisting.add(c.existingListIdx)
      console.log(
        `[DDL Merge] Layer 2 match: ${p.name} → "${e.name}" (${Math.round(
          c.overlap * 100
        )}% field overlap, ${c.matched}/${c.total} fields)`
      )
    }
  }

  // ── Layer 3: AI-assisted fallback ──────────────────────────────────────
  // One Claude call, regardless of how many tables remain. Claude sees only
  // what's still unmatched on both sides so the prompt stays small and
  // focused. Any failure (API error, bad JSON, unknown IDs) is swallowed:
  // unresolved tables just fall through to the final skip log. We never
  // fabricate a match.
  const stillUnmatchedDdl = parsed.filter((_, i) => !usedDdlIdx.has(i))
  const stillUnmatchedExisting = existing.filter((e) => !usedExistingId.has(e.id))

  if (stillUnmatchedDdl.length > 0 && stillUnmatchedExisting.length > 0) {
    try {
      const aiMatches = await layer3AIMatch(
        stillUnmatchedDdl,
        stillUnmatchedExisting
      )
      for (const { ddlName, existingId } of aiMatches) {
        // Find the first still-unmatched parsed table whose name Claude
        // referenced. Using a manual loop keeps duplicate names safe — if a
        // DDL legitimately declares the same name twice, the second claim
        // falls through to the skip log.
        let ddlIdx = -1
        for (let i = 0; i < parsed.length; i++) {
          if (!usedDdlIdx.has(i) && parsed[i].name === ddlName) {
            ddlIdx = i
            break
          }
        }
        if (ddlIdx === -1) continue
        const e = existing.find((x) => x.id === existingId)
        if (!e || usedExistingId.has(e.id)) continue
        pairs.push({
          parsedTable: parsed[ddlIdx],
          existingTable: e,
          matchedVia: 'layer3_ai',
        })
        usedDdlIdx.add(ddlIdx)
        usedExistingId.add(e.id)
        console.log(
          `[DDL Merge] Layer 3 match: ${parsed[ddlIdx].name} → "${e.name}" (AI-assisted)`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[DDL Merge] Layer 3 AI matching failed (non-fatal): ${msg}`)
    }
  }

  // Log everything that didn't resolve so the caller can see why a DDL
  // statement had no effect on the dataset.
  for (let i = 0; i < parsed.length; i++) {
    if (!usedDdlIdx.has(i)) {
      console.log(
        `[DDL Merge] No match for DDL table "${parsed[i].name}" — skipping`
      )
    }
  }

  return pairs
}

/**
 * Ask Claude to pair the remaining DDL tables with the remaining existing
 * tables. We pass field names on both sides so Claude can reason about
 * semantic equivalence (e.g., "Transactions" vs. "TRAN_HISTORY") when the
 * fingerprint threshold didn't fire. Returns only the matches Claude
 * produced; the caller validates them.
 */
async function layer3AIMatch(
  unmatchedDdl: ParsedTable[],
  unmatchedExisting: ExistingTable[]
): Promise<Array<{ ddlName: string; existingId: string }>> {
  const systemPrompt = `You are matching DDL-declared tables against existing database tables whose names may differ due to display-name conventions.

Given two lists:
  - DDL tables from a .sql file (raw identifiers like "ACCT_MASTER")
  - Existing database tables with IDs and user-entered display names (like "Customer Accounts")

Identify which DDL table corresponds to which existing table. Use field-name overlap and semantic name equivalence. Prefer precision over recall: if you are not confident, omit the match. Each existing table matches at most one DDL table.

Respond with ONLY valid JSON (no markdown fences, no commentary):
{
  "matches": [
    { "ddl_table_name": "ACCT_MASTER", "existing_table_id": "<uuid>" }
  ]
}`

  const ddlLines = unmatchedDdl
    .map((d) => `${d.name}: ${d.fields.map((f) => f.name).join(', ') || '(no fields parsed)'}`)
    .join('\n')
  const existingLines = unmatchedExisting
    .map(
      (e) =>
        `id=${e.id} name="${e.name}": ${e.fields.map((f) => f.name).join(', ') || '(no fields)'}`
    )
    .join('\n')

  const userMessage = `<unmatched_ddl_tables>
${ddlLines}
</unmatched_ddl_tables>

<unmatched_existing_tables>
${existingLines}
</unmatched_existing_tables>`

  const raw = await callClaude(systemPrompt, userMessage, 1024)

  // Strip any stray code fences Claude sometimes adds despite the instructions.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    console.warn('[DDL Merge] Layer 3: Claude returned non-JSON; skipping')
    return []
  }

  const maybeMatches =
    parsed && typeof parsed === 'object' && 'matches' in parsed
      ? (parsed as { matches?: unknown }).matches
      : null
  if (!Array.isArray(maybeMatches)) return []

  const ddlNameSet = new Set(unmatchedDdl.map((d) => d.name))
  const existingIdSet = new Set(unmatchedExisting.map((e) => e.id))

  const results: Array<{ ddlName: string; existingId: string }> = []
  for (const m of maybeMatches) {
    if (!m || typeof m !== 'object') continue
    const ddlName = (m as { ddl_table_name?: unknown }).ddl_table_name
    const existingId = (m as { existing_table_id?: unknown }).existing_table_id
    if (typeof ddlName !== 'string' || typeof existingId !== 'string') continue
    if (!ddlNameSet.has(ddlName)) continue
    if (!existingIdSet.has(existingId)) continue
    results.push({ ddlName, existingId })
  }
  return results
}
