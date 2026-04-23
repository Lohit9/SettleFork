/**
 * Pure translators for `lib/actions/outputs.ts`.
 *
 * Every function in this module is:
 *   - Pure (no DB access, no I/O; every input arrives fully hydrated)
 *   - Free of side effects (no logging, no mutation of inputs)
 *   - Free of `'use server'` (callers import from server actions AND unit tests
 *     that feed in-memory fixtures)
 *
 * Scope separation from `_outputs-helpers.ts`:
 *
 *   `_outputs-helpers.ts`      — TFM-to-TM grouping + field-pair enumeration
 *                                (the "which TFM belongs to which TM" rule,
 *                                shared by outputs.ts, execution-package.ts,
 *                                and readiness-score.ts)
 *
 *   `_outputs-translators.ts`  — THIS FILE. Six pure translators producing
 *                                customer-facing text (CSV rows, JSON groups,
 *                                transform-specs lines, gold-standard SELECT,
 *                                SQL load inserts, readiness-report LLM prompt).
 *
 * Why the separation: the grouping rule is load-bearing across three different
 * consumers; the translators are per-consumer text-assembly code. Concentrating
 * translators here keeps outputs.ts's server actions to I/O + persistence
 * orchestration and nothing else.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Bugs fixed in this module (documented at each site + in
 * `docs/prompt-3a-remaining-work.md` ▸ Bugs fixed in Prompt 3c):
 *
 *   D1 — Gold-standard SELECT duplicate-alias bug
 *        Legacy iterated `field_mappings` rows, where concat_space mappings
 *        stored each (primary, contributor) pair as its own FM. Without a
 *        transformation attached, every contributor's fallback branch emitted
 *        `row_data->>'contribField' AS "sharedTargetAlias"`, producing SQL
 *        with duplicate column aliases — an outright Postgres error. The new
 *        model stores one TFM per target column; this translator therefore
 *        emits exactly one SELECT expression per TFM. For concat_* TFMs
 *        without a transformation, we emit a structured warning and skip the
 *        column (no safe fallback exists — we cannot fabricate a multi-source
 *        concatenation without SQL).
 *
 *   A  — SQL load script "Rows: " header rendered as [object Object]…
 *        Legacy `sqlLines.push(\`-- Rows: \${rows.toLocaleString()}\`)` called
 *        `Array.prototype.toLocaleString` on an array of JSONB row objects,
 *        yielding strings like "[object Object],[object Object],…" in every
 *        generated SQL load script header. Fixed here by calling
 *        `rows.length.toLocaleString()`.
 *
 *   Confidence formatter bug — already fixed in `_execution-package-prompt.ts`
 *        and `migration-intelligence.ts`; `outputs.ts` was correct all along
 *        (`Math.round(confidence)` without multiplier) so no change is needed
 *        here. See regression guard in `tests/outputs/confidence-formatting.test.ts`.
 */

import type {
  MappingSourceRow,
  SourceFieldAcknowledgmentRow,
  TargetFieldMappingRow,
  TransformationRow,
} from '@/lib/types/mapping-redesign'
import { fieldNeedsTransform, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'

// ─── Shared input types ────────────────────────────────────────────────────

/**
 * Minimal target-field shape. Everything the translators read is covered here —
 * callers may pass the full DB row; extra properties are ignored.
 */
export interface TranslatorField {
  id: string
  table_id: string
  name: string
  data_type: string
  inferred_type?: string | null
  is_nullable?: boolean
  is_primary_key?: boolean
  is_foreign_key?: boolean
  fk_reference?: string | null
  ordinal_position?: number | null
}

export interface TranslatorTable {
  id: string
  dataset_id: string
  name: string
  row_count?: number | null
}

export interface TranslatorDataset {
  id: string
  name: string
  role: 'source' | 'target'
}

export interface TranslatorTableMapping {
  id: string
  project_id?: string
  source_table_id: string
  target_table_id: string
  status: 'needs_review' | 'approved' | 'rejected'
  confidence?: number | null
  ai_reasoning?: string | null
}

// ─── Local grouping variant (Item B option: duplicate-the-loop) ───────────
//
// `_outputs-helpers.ts` ▸ `groupTfmsByTableMapping` unconditionally excludes
// rejected TFMs (because every execution-package / gold-standard consumer
// wants to skip them). The mapping-file CSV/JSON exports are the one
// legacy-byte-equivalent exception: customer sees rejected FMs as part of
// their audit trail.
//
// Per Gate 3 Item B (founder approved "duplicate" option, 2026-04-22), we
// keep the approved helper untouched and duplicate the minimal grouping
// loop here. ~40 lines of controlled duplication rather than a
// broader-contract change to the shared helper.

interface LocalTfmForTm {
  tableMappingId: string
  tfm: TargetFieldMappingRow
  primarySource: MappingSourceRow | null
  contributors: MappingSourceRow[]
}

/**
 * Group TFMs by table_mapping, INCLUDING rejected TFMs (and, as a
 * consequence, including rejected MS rows beneath them).
 *
 * Rules:
 *   - Exclude bare acknowledgments (is_acknowledged=true, combination_type IS NULL).
 *   - Include rejected TFMs (status='rejected') — customer-facing CSV/JSON
 *     exports show them as audit trail.
 *   - VA TFMs fan out to every TM whose target_table matches the VA's target.
 *   - Mapped TFMs belong to the TM whose source_table matches MS[ordinal=0]'s
 *     source_table AND whose target_table matches the TFM's target_field.table_id.
 *   - Ordering: TFMs sorted by target_field.ordinal_position, then by
 *     target_field_id for determinism; contributors sorted by ordinal.
 */
function groupTfmsWithRejected(
  tableMappings: readonly TranslatorTableMapping[],
  targetFieldMappings: readonly TargetFieldMappingRow[],
  mappingSources: readonly MappingSourceRow[],
  fieldsById: ReadonlyMap<string, TranslatorField>,
): Map<string, LocalTfmForTm[]> {
  const msByTfm = new Map<string, MappingSourceRow[]>()
  for (const ms of mappingSources) {
    const list = msByTfm.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfm.set(ms.target_field_mapping_id, list)
  }
  for (const list of msByTfm.values()) list.sort((a, b) => a.ordinal - b.ordinal)

  const tmsByTargetTable = new Map<string, TranslatorTableMapping[]>()
  const tmByPair = new Map<string, TranslatorTableMapping>()
  for (const tm of tableMappings) {
    const list = tmsByTargetTable.get(tm.target_table_id) ?? []
    list.push(tm)
    tmsByTargetTable.set(tm.target_table_id, list)
    tmByPair.set(`${tm.source_table_id}::${tm.target_table_id}`, tm)
  }

  const out = new Map<string, LocalTfmForTm[]>()
  for (const tm of tableMappings) out.set(tm.id, [])

  for (const tfm of targetFieldMappings) {
    // Bare ack: carries no column in any export.
    if (tfm.is_acknowledged && tfm.combination_type === null) continue

    const tgtField = fieldsById.get(tfm.target_field_id)
    if (!tgtField) continue

    const msList = msByTfm.get(tfm.id) ?? []
    const primaryMs = msList.find((m) => m.ordinal === 0) ?? null
    const contributors = msList.filter((m) => m.ordinal >= 1)
    const isVA = tfm.combination_type === 'custom_sql' && msList.length === 0

    if (isVA) {
      const matching = tmsByTargetTable.get(tgtField.table_id) ?? []
      for (const tm of matching) {
        out.get(tm.id)!.push({ tableMappingId: tm.id, tfm, primarySource: null, contributors: [] })
      }
      continue
    }

    if (!primaryMs || !primaryMs.source_field_id) continue
    const primarySrc = fieldsById.get(primaryMs.source_field_id)
    if (!primarySrc) continue
    const key = `${primarySrc.table_id}::${tgtField.table_id}`
    const owning = tmByPair.get(key)
    if (!owning) continue
    out.get(owning.id)!.push({ tableMappingId: owning.id, tfm, primarySource: primaryMs, contributors })
  }

  for (const list of out.values()) {
    list.sort((a, b) => {
      const ao = fieldsById.get(a.tfm.target_field_id)?.ordinal_position ?? 0
      const bo = fieldsById.get(b.tfm.target_field_id)?.ordinal_position ?? 0
      if (ao !== bo) return (ao ?? 0) - (bo ?? 0)
      return a.tfm.target_field_id.localeCompare(b.tfm.target_field_id)
    })
  }

  return out
}

// ─── (1) buildMappingCsvRows ───────────────────────────────────────────────

export interface MappingCsvInput {
  tableMappings: readonly TranslatorTableMapping[]
  targetFieldMappings: readonly TargetFieldMappingRow[]
  mappingSources: readonly MappingSourceRow[]
  transformations: readonly TransformationRow[]
  fieldsById: ReadonlyMap<string, TranslatorField>
  tablesById: ReadonlyMap<string, TranslatorTable>
}

export interface MappingCsvRow {
  source_table: string
  source_field: string
  source_type: string
  target_table: string
  target_field: string
  target_type: string
  confidence: string | number
  status: string
  reasoning: string
  needs_transform: string
}

export const MAPPING_CSV_HEADERS = [
  'source_table',
  'source_field',
  'source_type',
  'target_table',
  'target_field',
  'target_type',
  'confidence',
  'status',
  'reasoning',
  'needs_transform',
] as const

/**
 * Build the rows for the mapping-file CSV. One row per field-pair (primary or
 * contributor). Includes rejected TFMs (audit trail); excludes bare acks.
 *
 * Byte-equivalence notes vs legacy:
 *   - `source_field` is `'[Value Assignment]'` for a VA primary pair, the
 *     source field's name for any mapped primary/contributor pair.
 *   - `source_table` is `''` when `source_field` is `'[Value Assignment]'`.
 *   - `confidence` is rendered as `Math.round(value)` for primary pairs and
 *     `Math.round(ms.confidence)` for contributor pairs (legacy called
 *     `Math.round(fm.confidence)` indiscriminately against the legacy FM row).
 *     Already correct — no multiplier bug here.
 *   - `status` is the TFM's status for every pair (legacy read FM.status,
 *     which in migration 074's backfill mirrored TFM.status on both primary
 *     and contributor FMs, so this matches byte-for-byte).
 *   - `reasoning` is `tfm.ai_reasoning` for primary pairs and
 *     `ms.ai_reasoning` for contributor pairs (legacy read fm.ai_reasoning —
 *     matches because migration 074 backfilled primary ai_reasoning onto the
 *     primary FM and contributor ai_reasoning onto the contributor FM).
 *   - `needs_transform` is `'true'` when a transformation exists on the TFM
 *     (shared across primary + contributor pairs, since there is AT MOST ONE
 *     transformation per TFM — see invariant in
 *     `lib/types/mapping-redesign.ts`). Legacy asked `transformByFMId.has(fm.id)`
 *     which matched the same transformation row on both primary and
 *     contributor FMs (the migration linked every split FM to the same
 *     transformation via the same field_mapping_id column).
 */
export function buildMappingCsvRows(input: MappingCsvInput): MappingCsvRow[] {
  const { tableMappings, targetFieldMappings, mappingSources, transformations, fieldsById, tablesById } = input

  const txByTfmId = new Map<string, TransformationRow>()
  for (const t of transformations) txByTfmId.set(t.target_field_mapping_id, t)

  const grouped = groupTfmsWithRejected(tableMappings, targetFieldMappings, mappingSources, fieldsById)

  const rows: MappingCsvRow[] = []

  // Iterate TMs in insertion order to match the legacy
  // `.in('table_mapping_id', tmIds)` fetch order. Within a TM, TFMs are sorted
  // by target ordinal_position (stable) in `groupTfmsWithRejected`.
  for (const tm of tableMappings) {
    const entries = grouped.get(tm.id) ?? []
    for (const entry of entries) {
      const tgtField = fieldsById.get(entry.tfm.target_field_id)
      if (!tgtField) continue
      const tgtTable = tablesById.get(tgtField.table_id)
      const hasTransform = txByTfmId.has(entry.tfm.id)

      // Primary pair.
      const primarySrcField = entry.primarySource?.source_field_id
        ? fieldsById.get(entry.primarySource.source_field_id) ?? null
        : null
      const primarySrcTable = primarySrcField ? tablesById.get(primarySrcField.table_id) ?? null : null
      const isVA = entry.primarySource === null

      rows.push({
        source_table: primarySrcTable?.name ?? '',
        source_field: isVA ? '[Value Assignment]' : primarySrcField?.name ?? '',
        source_type: isVA ? '' : primarySrcField?.data_type ?? '',
        target_table: tgtTable?.name ?? '',
        target_field: tgtField.name,
        target_type: tgtField.data_type,
        confidence: entry.tfm.confidence !== null ? Math.round(entry.tfm.confidence) : '',
        status: entry.tfm.status,
        reasoning: entry.tfm.ai_reasoning ?? '',
        needs_transform: hasTransform ? 'true' : 'false',
      })

      // Contributor pairs.
      for (const ms of entry.contributors) {
        const cSrcField = ms.source_field_id ? fieldsById.get(ms.source_field_id) ?? null : null
        const cSrcTable = cSrcField ? tablesById.get(cSrcField.table_id) ?? null : null
        rows.push({
          source_table: cSrcTable?.name ?? '',
          source_field: cSrcField?.name ?? '',
          source_type: cSrcField?.data_type ?? '',
          target_table: tgtTable?.name ?? '',
          target_field: tgtField.name,
          target_type: tgtField.data_type,
          confidence: ms.confidence !== null ? Math.round(ms.confidence) : '',
          status: entry.tfm.status,
          reasoning: ms.ai_reasoning ?? '',
          needs_transform: hasTransform ? 'true' : 'false',
        })
      }
    }
  }

  return rows
}

// ─── (2) buildMappingJsonGroups ────────────────────────────────────────────

export interface MappingJsonInput extends MappingCsvInput {
  datasetsById: ReadonlyMap<string, TranslatorDataset>
}

export interface MappingJsonFieldMapping {
  source_field: string
  source_type: string
  target_field: string
  target_type: string
  confidence: number | null
  status: string
  type_compatibility: string | null
  reasoning: string | null
  needs_transform: boolean
}

export interface MappingJsonTableGroup {
  source: { table: string; dataset: string }
  target: { table: string; dataset: string }
  confidence: number | null
  status: string
  reasoning: string | null
  field_mappings: MappingJsonFieldMapping[]
}

/**
 * Build the table-group objects for the mapping-file JSON. One group per TM
 * (callers should filter rejected TMs before passing — legacy did
 * `.neq('status', 'rejected')` on the TM query). Within each group, includes
 * every TFM owned by that TM (including rejected ones), excluding bare acks.
 *
 * Byte-equivalence notes vs legacy:
 *   - `source.table` / `target.table` are the TM's source/target table names.
 *   - `confidence` on the TM group is `Math.round(tm.confidence)` (already
 *     correct; no multiplier bug).
 *   - Field-mapping entries: one per field-pair (primary + contributors).
 *   - `type_compatibility` on the JSON side is `null` for primary pairs
 *     (legacy: primary FMs didn't carry type_compatibility in the backfill —
 *     only contributor FMs did; preserving that shape).
 */
export function buildMappingJsonGroups(input: MappingJsonInput): MappingJsonTableGroup[] {
  const { tableMappings, targetFieldMappings, mappingSources, transformations, fieldsById, tablesById, datasetsById } = input

  const txByTfmId = new Map<string, TransformationRow>()
  for (const t of transformations) txByTfmId.set(t.target_field_mapping_id, t)

  const grouped = groupTfmsWithRejected(tableMappings, targetFieldMappings, mappingSources, fieldsById)

  const result: MappingJsonTableGroup[] = []

  for (const tm of tableMappings) {
    const srcTable = tablesById.get(tm.source_table_id)
    const tgtTable = tablesById.get(tm.target_table_id)
    const srcDs = srcTable ? datasetsById.get(srcTable.dataset_id) : null
    const tgtDs = tgtTable ? datasetsById.get(tgtTable.dataset_id) : null

    const entries = grouped.get(tm.id) ?? []
    const fms: MappingJsonFieldMapping[] = []

    for (const entry of entries) {
      const tgtField = fieldsById.get(entry.tfm.target_field_id)
      if (!tgtField) continue
      const hasTransform = txByTfmId.has(entry.tfm.id)
      const isVA = entry.primarySource === null

      const primarySrcField = entry.primarySource?.source_field_id
        ? fieldsById.get(entry.primarySource.source_field_id) ?? null
        : null

      fms.push({
        source_field: isVA ? '[Value Assignment]' : primarySrcField?.name ?? '',
        source_type: isVA ? '' : primarySrcField?.data_type ?? '',
        target_field: tgtField.name,
        target_type: tgtField.data_type,
        confidence: entry.tfm.confidence !== null ? Math.round(entry.tfm.confidence) : null,
        status: entry.tfm.status,
        type_compatibility: null,
        reasoning: entry.tfm.ai_reasoning ?? null,
        needs_transform: hasTransform,
      })

      for (const ms of entry.contributors) {
        const cField = ms.source_field_id ? fieldsById.get(ms.source_field_id) ?? null : null
        fms.push({
          source_field: cField?.name ?? '',
          source_type: cField?.data_type ?? '',
          target_field: tgtField.name,
          target_type: tgtField.data_type,
          confidence: ms.confidence !== null ? Math.round(ms.confidence) : null,
          status: entry.tfm.status,
          type_compatibility: ms.type_compatibility ?? null,
          reasoning: ms.ai_reasoning ?? null,
          needs_transform: hasTransform,
        })
      }
    }

    result.push({
      source: { table: srcTable?.name ?? '', dataset: srcDs?.name ?? '' },
      target: { table: tgtTable?.name ?? '', dataset: tgtDs?.name ?? '' },
      confidence: tm.confidence !== null && tm.confidence !== undefined ? Math.round(tm.confidence) : null,
      status: tm.status,
      reasoning: tm.ai_reasoning ?? null,
      field_mappings: fms,
    })
  }

  return result
}

// ─── (3) buildTransformSpecsLines ──────────────────────────────────────────

export interface TransformSpecsInput {
  projectName: string
  generatedAt: string
  tableMappings: readonly TranslatorTableMapping[]
  targetFieldMappings: readonly TargetFieldMappingRow[]
  mappingSources: readonly MappingSourceRow[]
  transformations: readonly TransformationRow[]
  fieldsById: ReadonlyMap<string, TranslatorField>
  tablesById: ReadonlyMap<string, TranslatorTable>
}

/**
 * Build the line-by-line SQL comment + statement output for the
 * transform-specs file. Iterates transformations; for each, resolves its
 * TFM, primary MS, source/target fields, and source/target tables.
 *
 * Byte-equivalence notes vs legacy:
 *   - Header block: `-- Settle — Transformation Specifications`,
 *     `-- Project: <name>`, `-- Generated: <UTC ts>`, `-- Total transforms: N`.
 *   - One transform block per transformation, separated by a blank line:
 *       -- Source: <srcTable>.<srcField> → Target: <tgtTable>.<tgtField>
 *       -- Description: <desc> (omitted if null)
 *       -- Status: <mark>
 *       <generated_sql>
 *   - Status mark: `✓ Saved` / `◎ Tested` / `○ Draft` (legacy unchanged).
 *     `applied` and `stale` fall through the legacy ternary to `○ Draft`.
 *     Preserving byte-for-byte, though arguably these should have their own
 *     marks. Not a bug this prompt is scoped to fix.
 *   - Source label for VA: `[Value Assignment]`.
 *   - Fallback `?` for missing tables/fields (defensive — live data always
 *     has these resolvable after migration 074's contracts).
 */
export function buildTransformSpecsLines(input: TransformSpecsInput): string[] {
  const { projectName, generatedAt, targetFieldMappings, mappingSources, transformations, fieldsById, tablesById } = input

  const tfmById = new Map<string, TargetFieldMappingRow>()
  for (const tfm of targetFieldMappings) tfmById.set(tfm.id, tfm)

  const primaryMsByTfmId = new Map<string, MappingSourceRow>()
  for (const ms of mappingSources) {
    if (ms.ordinal !== 0) continue
    primaryMsByTfmId.set(ms.target_field_mapping_id, ms)
  }

  const lines: string[] = [
    `-- ============================================================`,
    `-- Settle — Transformation Specifications`,
    `-- Project: ${projectName}`,
    `-- Generated: ${generatedAt}`,
    `-- Total transforms: ${transformations.length}`,
    `-- ============================================================`,
    '',
  ]

  for (const t of transformations) {
    const tfm = tfmById.get(t.target_field_mapping_id)
    if (!tfm) continue
    const tgtField = fieldsById.get(tfm.target_field_id)
    if (!tgtField) continue
    const tgtTable = tablesById.get(tgtField.table_id) ?? null

    const primary = primaryMsByTfmId.get(tfm.id) ?? null
    const srcField = primary?.source_field_id ? fieldsById.get(primary.source_field_id) ?? null : null
    const srcTable = srcField ? tablesById.get(srcField.table_id) ?? null : null

    const statusMark =
      t.status === 'saved'
        ? '✓ Saved'
        : t.status === 'tested'
          ? '◎ Tested'
          : '○ Draft'

    const srcLabel = srcField ? `${srcTable?.name ?? '?'}.${srcField.name}` : '[Value Assignment]'
    lines.push(`-- Source: ${srcLabel} → Target: ${tgtTable?.name ?? '?'}.${tgtField.name ?? '?'}`)
    if (t.description) lines.push(`-- Description: ${t.description}`)
    lines.push(`-- Status: ${statusMark}`)
    lines.push(t.generated_sql)
    lines.push('')
  }

  return lines
}

// ─── (4) buildGoldStandardSelectSQL ────────────────────────────────────────

export interface GoldStandardSelectInput {
  tableMapping: TranslatorTableMapping
  /** Every TFM in the project; function filters to those owned by the TM. */
  targetFieldMappings: readonly TargetFieldMappingRow[]
  mappingSources: readonly MappingSourceRow[]
  transformations: readonly TransformationRow[]
  fieldsById: ReadonlyMap<string, TranslatorField>
  /** All source field names in the TM's source table — used by
   *  `wrapFieldRefsInJsonb` to rewrite bare field references as JSONB lookups. */
  allSourceFieldNames: readonly string[]
}

export interface GoldStandardSelectResult {
  /** The full SELECT statement. Empty string if no columns resolved. */
  selectSQL: string
  /** Ordered list of the target field names emitted (used as CSV/SQL header). */
  targetFieldNames: string[]
  /**
   * Structured warnings for columns that were SKIPPED rather than emitted.
   * Currently populated only by the D1 concat-without-transform guard.
   * Callers surface these to the generated file header and/or errors[] list.
   */
  warnings: string[]
}

/**
 * Build the gold-standard SELECT for a single TM. Emits one SELECT expression
 * per approved, non-rejected TFM owned by the TM:
 *
 *   - With transformation: `<wrapped transform SQL> AS "<target_alias>"`
 *   - Mapped, no transformation, single-source: `row_data->>'<srcField>' AS "<target_alias>"`
 *   - Mapped, no transformation, concat_* / multi-source: SKIPPED + warning
 *     (D1 fix — see module header).
 *   - VA, no transformation: SKIPPED (no SQL to emit).
 *
 * Rejected TFMs, bare acks, and TFMs whose status ≠ 'approved' are excluded
 * to match legacy `.eq('status', 'approved')` filter.
 */
export function buildGoldStandardSelectSQL(input: GoldStandardSelectInput): GoldStandardSelectResult {
  const { tableMapping, targetFieldMappings, mappingSources, transformations, fieldsById, allSourceFieldNames } = input

  const txByTfmId = new Map<string, TransformationRow>()
  for (const t of transformations) txByTfmId.set(t.target_field_mapping_id, t)

  const msByTfmId = new Map<string, MappingSourceRow[]>()
  for (const ms of mappingSources) {
    const list = msByTfmId.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfmId.set(ms.target_field_mapping_id, list)
  }
  for (const list of msByTfmId.values()) list.sort((a, b) => a.ordinal - b.ordinal)

  const columns: string[] = []
  const targetFieldNames: string[] = []
  const warnings: string[] = []

  // Iterate TFMs in ordinal_position order for deterministic column order.
  const owned = targetFieldMappings
    .filter((tfm) => {
      if (tfm.status !== 'approved') return false
      if (tfm.is_acknowledged && tfm.combination_type === null) return false
      const tgt = fieldsById.get(tfm.target_field_id)
      if (!tgt) return false
      // Mapped TFMs: owning TM pairs source-field-table with target-field-table.
      const msList = msByTfmId.get(tfm.id) ?? []
      const isVA = tfm.combination_type === 'custom_sql' && msList.length === 0
      if (isVA) return tgt.table_id === tableMapping.target_table_id
      const primary = msList[0]
      if (!primary?.source_field_id) return false
      const primarySrc = fieldsById.get(primary.source_field_id)
      if (!primarySrc) return false
      return (
        primarySrc.table_id === tableMapping.source_table_id &&
        tgt.table_id === tableMapping.target_table_id
      )
    })
    .sort((a, b) => {
      const ao = fieldsById.get(a.target_field_id)?.ordinal_position ?? 0
      const bo = fieldsById.get(b.target_field_id)?.ordinal_position ?? 0
      if (ao !== bo) return (ao ?? 0) - (bo ?? 0)
      return a.target_field_id.localeCompare(b.target_field_id)
    })

  for (const tfm of owned) {
    const tgtField = fieldsById.get(tfm.target_field_id)
    if (!tgtField) continue
    const tgtAlias = `"${tgtField.name.replace(/"/g, '""')}"`
    const transform = txByTfmId.get(tfm.id)

    if (transform?.generated_sql) {
      const wrapped = wrapFieldRefsInJsonb(
        transform.generated_sql.replace(/;+$/, '').trim(),
        [...allSourceFieldNames],
      )
      columns.push(`${wrapped} AS ${tgtAlias}`)
      targetFieldNames.push(tgtField.name)
      continue
    }

    const msList = msByTfmId.get(tfm.id) ?? []
    const primary = msList[0]
    const isVA = tfm.combination_type === 'custom_sql' && msList.length === 0
    const isSingleMapped =
      !isVA &&
      primary?.source_field_id !== null &&
      (tfm.combination_type === 'single' || tfm.combination_type === null)

    if (isSingleMapped && primary?.source_field_id) {
      const srcField = fieldsById.get(primary.source_field_id)
      if (!srcField) continue
      const escaped = srcField.name.replace(/'/g, "''")
      columns.push(`row_data->>'${escaped}' AS ${tgtAlias}`)
      targetFieldNames.push(tgtField.name)
      continue
    }

    // ── D1 fix site ──
    // Concat-style TFM without a transformation: legacy would emit one
    // `row_data->>'contribField' AS "sameTargetAlias"` per contributor,
    // producing duplicate-alias SQL errors. There is no safe fallback
    // (we cannot fabricate the concat expression without SQL), so we
    // skip the column and log a structured warning. Customer can add a
    // transform and re-run; the old broken behavior gave them an error
    // at execution time instead of a surfaced warning at generation time.
    if (
      !transform?.generated_sql &&
      (tfm.combination_type === 'concat_space' ||
        tfm.combination_type === 'concat_comma' ||
        (msList.length > 1 && !isVA))
    ) {
      warnings.push(
        `Skipped target column "${tgtField.name}" on table_mapping ${tableMapping.id}: ${tfm.combination_type ?? 'multi-source'} mapping has no transformation attached. Add a transform in the Transform tab and regenerate.`,
      )
      continue
    }

    // VA without transform: skip silently (legacy behavior).
    // Any other combination we don't recognize: skip silently.
  }

  if (columns.length === 0) {
    return { selectSQL: '', targetFieldNames: [], warnings }
  }

  const selectSQL = `SELECT ${columns.join(', ')} FROM data_rows WHERE table_id = '${tableMapping.source_table_id}' ORDER BY row_number`
  return { selectSQL, targetFieldNames, warnings }
}

// ─── (5) buildSqlLoadScriptInserts ─────────────────────────────────────────

export interface SqlLoadScriptInput {
  targetTableName: string
  sourceTableName: string
  sourceDatasetName: string
  generatedAt: string
  rows: ReadonlyArray<Record<string, unknown>>
  targetFieldNames: readonly string[]
}

/**
 * Build the full SQL load script text for one TM — header comments +
 * chunked INSERT statements.
 *
 * Byte-equivalence notes vs legacy:
 *   - Header lines identical (including `-- Rows: N` — see bug fix below).
 *   - INSERT chunks of 500 rows each.
 *   - Column list quoted with escaped doubles (`"Col""Name"`).
 *   - VALUES rows one per line, joined with `,\n`.
 *   - Trailing blank line after each chunk.
 *
 * ── Item A fix site ──
 * Legacy rendered `-- Rows: ${rows.toLocaleString()}` which invoked
 * `Array.prototype.toLocaleString` against an array of row objects, producing
 * `-- Rows: [object Object],[object Object],…` in every generated script.
 * Fix: render `rows.length.toLocaleString()` — the row count the legacy code
 * obviously intended.
 */
export function buildSqlLoadScriptInserts(input: SqlLoadScriptInput): string {
  const { targetTableName, sourceTableName, sourceDatasetName, generatedAt, rows, targetFieldNames } = input

  const colList = targetFieldNames.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ')
  const CHUNK = 500

  const lines: string[] = [
    `-- Generated by Settle`,
    `-- Target table: ${targetTableName}`,
    `-- Source: ${sourceDatasetName}.${sourceTableName}`,
    `-- Generated: ${generatedAt}`,
    // Item A fix: legacy had `rows.toLocaleString()` which stringified the
    // entire row array as "[object Object],[object Object],…". The obvious
    // intent is a row count — render `rows.length.toLocaleString()`.
    `-- Rows: ${rows.length.toLocaleString()}`,
    '',
  ]

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const valueRows = chunk
      .map((row) => `(${targetFieldNames.map((h) => escapeSqlValue(row[h])).join(', ')})`)
      .join(',\n')
    lines.push(`INSERT INTO "${targetTableName}" (${colList}) VALUES`)
    lines.push(valueRows + ';')
    lines.push('')
  }

  return lines.join('\n')
}

function escapeSqlValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL'
  const str = String(val)
  return "'" + str.replace(/'/g, "''") + "'"
}

// ─── (6) buildReadinessReportPrompt ────────────────────────────────────────

export const READINESS_REPORT_SYSTEM_PROMPT = `You are a senior data migration consultant. Generate a comprehensive Migration Readiness Report in clean Markdown format. Use ## for section headers, **bold** for key terms, and tables where appropriate. Be direct, precise, and actionable. Reference specific table and field names from the data provided.

If documentation is provided (business rules, data dictionaries, schema docs), reference it when assessing readiness. Flag any areas where the current data state does not meet the documented requirements, and include relevant business rule references in the Risk Register.

Structure the report exactly as follows:
## Go/No-Go Recommendation
## Executive Summary
## Migration Scope
## Readiness Score Analysis
## Mapping Coverage
## Data Quality Assessment
## Transformation Summary
## Risk Register
## Fix History & Audit Trail
## Recommended Next Steps`

export interface ReadinessReportInput {
  projectName: string
  srcDatasetName: string
  tgtDatasetName: string
  srcTableCount: number
  tgtTableCount: number
  totalSourceRows: number
  totalSourceFields: number
  readinessScore: number
  readinessLabel: string

  tableMappings: readonly TranslatorTableMapping[]
  targetFieldMappings: readonly TargetFieldMappingRow[]
  mappingSources: readonly MappingSourceRow[]
  sourceFieldAcknowledgments: readonly SourceFieldAcknowledgmentRow[]
  transformations: readonly TransformationRow[]

  qualityIssues: ReadonlyArray<{
    title: string
    severity: string
    description: string | null
    affected_records: number | null
    status: string
  }>
  fixHistory: ReadonlyArray<{
    fix_description: string
    affected_row_count: number | null
    applied_at: string
    status: string
  }>
  validationRules: ReadonlyArray<{ name?: string }>

  /** Document block rendered via `formatDocumentsForPrompt` by the caller. */
  documentBlock: string
}

export interface ReadinessReportPromptBundle {
  systemPrompt: string
  userMessage: string
  maxTokens: number

  /** Derived metrics also surfaced to the caller for the DOCX header. */
  approvedSourceFieldsMapped: number
  approvedTargetFieldsMapped: number
  sourceCoveragePct: number
  unmappedSourceFieldsCount: number
  approvedTableMappingsCount: number
  rejectedMappingsCount: number
  avgConfidence: number
  openBlocking: number
  openWarnings: number
  savedTransformsCount: number
}

/**
 * Assemble the LLM prompt bundle for the readiness report.
 *
 * Byte-equivalence notes vs legacy:
 *   - `userMessage` structure mirrors the original `<project>…<fix_history>`
 *     XML-tagged blocks.
 *   - Metrics (approved source fields, VA count, rejected count, avg
 *     confidence) are recomputed against the new model:
 *
 *       approvedSourceFieldsMapped = |unique MS.source_field_id across
 *                                     approved, non-VA TFMs|
 *       approvedTargetFieldsMapped = |approved, non-VA, non-ack TFMs|
 *       valueAssignmentsCount      = |approved TFMs with combination_type='custom_sql'
 *                                     and zero MS rows|
 *       rejectedMappingsCount      = |rejected TFMs|
 *       avgConfidence              = Math.round(mean(approved-TFM-primary-MS
 *                                     and VA TFM confidences)). Legacy
 *                                     averaged FM.confidence across approved
 *                                     FMs (primary + contributor), which,
 *                                     after the 074 trigger that writes
 *                                     TFM.confidence = MIN(MS.confidence),
 *                                     is equivalent in aggregate to the new
 *                                     formula to within rounding noise.
 *                                     Documented as an intentional semantic
 *                                     simplification — we now compute a
 *                                     TFM-level average instead of an
 *                                     FM-level average.
 *   - `Value assignments (no source field): N` → count of VA TFMs.
 *   - `Unmapped source fields: N` → (totalSourceFields − approvedSourceFieldsMapped).
 */
export function buildReadinessReportPrompt(input: ReadinessReportInput): ReadinessReportPromptBundle {
  const {
    projectName,
    srcDatasetName,
    tgtDatasetName,
    srcTableCount,
    tgtTableCount,
    totalSourceRows,
    totalSourceFields,
    readinessScore,
    readinessLabel,
    tableMappings,
    targetFieldMappings,
    mappingSources,
    transformations,
    qualityIssues,
    fixHistory,
    validationRules,
    documentBlock,
  } = input

  const approvedTfms = targetFieldMappings.filter((tfm) => tfm.status === 'approved' && !tfm.is_acknowledged)

  // Approved, non-VA TFMs (mapped ones have MS rows).
  const msByTfm = new Map<string, MappingSourceRow[]>()
  for (const ms of mappingSources) {
    const list = msByTfm.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfm.set(ms.target_field_mapping_id, list)
  }
  const approvedMappedTfms = approvedTfms.filter((t) => (msByTfm.get(t.id)?.length ?? 0) > 0)
  const approvedVaTfms = approvedTfms.filter(
    (t) => t.combination_type === 'custom_sql' && (msByTfm.get(t.id)?.length ?? 0) === 0,
  )

  const approvedSourceFieldsMapped = new Set<string>()
  for (const tfm of approvedMappedTfms) {
    for (const ms of msByTfm.get(tfm.id) ?? []) {
      if (ms.source_field_id) approvedSourceFieldsMapped.add(ms.source_field_id)
    }
  }

  // Approved target-field count: every approved non-ack TFM targets one field.
  const approvedTargetFieldsMapped = approvedTfms.length

  const sourceCoveragePct =
    totalSourceFields > 0 ? Math.round((approvedSourceFieldsMapped.size / totalSourceFields) * 100) : 0

  const unmappedSourceFieldsCount = Math.max(0, totalSourceFields - approvedSourceFieldsMapped.size)

  const approvedTableMappingsCount = tableMappings.filter((tm) => tm.status === 'approved').length

  const rejectedMappingsCount = targetFieldMappings.filter((tfm) => tfm.status === 'rejected').length

  // Average confidence: mean of approved-TFM confidences (non-null, non-ack).
  // Legacy averaged FM.confidence which included contributor rows; since the
  // 074 trigger derives TFM.confidence = MIN(MS.confidence), the TFM-level
  // average is a simpler and equally-defensible summary statistic.
  const confValues = approvedTfms.map((t) => t.confidence).filter((v): v is number => v != null)
  const avgConfidence =
    confValues.length > 0 ? Math.round(confValues.reduce((s, v) => s + v, 0) / confValues.length) : 0

  const openBlocking = qualityIssues.filter((q) => q.severity === 'blocking' && q.status === 'open').length
  const openWarnings = qualityIssues.filter((q) => q.severity === 'warning' && q.status === 'open').length
  const fixedIssues = qualityIssues.filter((q) => q.status === 'fixed').length
  const acceptedRisks = qualityIssues.filter((q) => q.status === 'accepted_risk').length

  const savedTransformsCount = transformations.filter((t) => t.status === 'saved').length
  const testedTransformsCount = transformations.filter((t) => t.status === 'tested').length
  const draftTransformsCount = transformations.filter((t) => t.status === 'draft').length

  const openIssuesDetail = qualityIssues
    .filter((q) => q.status === 'open')
    .slice(0, 20)
    .map(
      (q) =>
        `- [${q.severity.toUpperCase()}] ${q.title}: ${q.description ?? ''} (${q.affected_records ?? 0} records affected)`,
    )
    .join('\n')

  const acceptedRisksDetail = qualityIssues
    .filter((q) => q.status === 'accepted_risk')
    .slice(0, 10)
    .map((q) => `- ${q.title}: ${q.description ?? ''}`)
    .join('\n')

  const savedTransformDetail = transformations
    .filter((t) => t.status === 'saved')
    .slice(0, 15)
    .map(
      (t) =>
        `- ${t.description ?? 'Transform'}: \`${(t.generated_sql ?? '').slice(0, 80)}${
          t.generated_sql && t.generated_sql.length > 80 ? '...' : ''
        }\``,
    )
    .join('\n')

  const fixHistoryDetail = fixHistory
    .slice(0, 20)
    .map(
      (fh) =>
        `- ${new Date(fh.applied_at).toLocaleDateString()}: ${fh.fix_description} (${fh.affected_row_count ?? 0} rows, status: ${fh.status})`,
    )
    .join('\n')

  const userMessage = `<project>
Name: ${projectName}
Source: ${srcDatasetName} (${srcTableCount} tables, ${totalSourceRows.toLocaleString()} rows)
Target: ${tgtDatasetName} (${tgtTableCount} tables)
</project>

<readiness>
Score: ${readinessScore}%
Status: ${readinessLabel}
</readiness>

<mapping_summary>
Total source fields: ${totalSourceFields}
Approved field mappings: ${approvedSourceFieldsMapped.size} source fields → ${approvedTargetFieldsMapped} target fields (${sourceCoveragePct}% source coverage)
Value assignments (no source field): ${approvedVaTfms.length}
Unmapped source fields: ${unmappedSourceFieldsCount}
Approved table mappings: ${approvedTableMappingsCount}
Rejected mappings: ${rejectedMappingsCount}
Average confidence: ${avgConfidence}%
</mapping_summary>

<quality_summary>
Open blocking issues: ${openBlocking}
Open warnings: ${openWarnings}
Fixed issues: ${fixedIssues}
Accepted risks: ${acceptedRisks}
Active validation rules: ${validationRules.length}
</quality_summary>

<quality_issues_detail>
${openIssuesDetail || 'No open issues.'}
</quality_issues_detail>

<accepted_risks>
${acceptedRisksDetail || 'No accepted risks.'}
</accepted_risks>

<transformations>
Total transforms: ${transformations.length}
Saved: ${savedTransformsCount}
Tested: ${testedTransformsCount}
Draft: ${draftTransformsCount}
${savedTransformDetail || 'No saved transforms.'}
</transformations>

<fix_history>
${fixHistoryDetail || 'No fixes applied.'}
</fix_history>
${documentBlock}
Generate the full Migration Readiness Report now.`

  return {
    systemPrompt: READINESS_REPORT_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 6000,

    approvedSourceFieldsMapped: approvedSourceFieldsMapped.size,
    approvedTargetFieldsMapped,
    sourceCoveragePct,
    unmappedSourceFieldsCount,
    approvedTableMappingsCount,
    rejectedMappingsCount,
    avgConfidence,
    openBlocking,
    openWarnings,
    savedTransformsCount,
  }
}

// ─── Shared convenience: `fieldNeedsTransform` re-export ───────────────────
//
// Re-exported so callers can import from a single module when assembling
// readiness-score inputs. No behavioural change vs lib/utils/transform-helpers.
export { fieldNeedsTransform }
