/**
 * Migration template extraction and application.
 *
 * When a migration is completed (all mappings approved, exported),
 * extract a reusable template keyed by source_system + target_system.
 * Next time someone migrates the same pair, pre-populate mappings
 * from the template instead of starting from scratch.
 *
 * This is the flywheel: migration #1 costs $0.50/table in AI.
 * Migration #50 on the same system pair costs ~$0 because 70%+
 * of mappings are already known.
 *
 * Template matching is by FIELD SIGNATURE, not by project ID.
 * A field signature is: { tableName, fieldName, dataType, isNullable, isForeignKey }
 * Two fields match if their signatures are identical. This means templates
 * work across different customers migrating the same system pair.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface FieldSignature {
  tableName: string
  fieldName: string
  dataType: string
  isNullable: boolean
  isForeignKey: boolean
}

export interface TemplateMappingEntry {
  /** Source field signature. */
  source: FieldSignature
  /** Target field signature. */
  target: FieldSignature
  /** The approved transformation SQL (null if direct map). */
  transformSql: string | null
  /** Human-written or AI-generated explanation. */
  explanation: string
  /** Confidence from the original mapping (0-100). */
  confidence: number
  /** How many times this mapping has been reused across projects. */
  reuseCount: number
  /** How many times a human overrode this mapping after template application. */
  overrideCount: number
}

export interface MigrationTemplate {
  id: string
  /** e.g. "Prosys" */
  sourceSystem: string
  /** e.g. "Rootstock" */
  targetSystem: string
  /** ISO timestamp of template creation. */
  createdAt: string
  /** ISO timestamp of last update (when a new migration refines it). */
  updatedAt: string
  /** Number of completed migrations that fed this template. */
  migrationCount: number
  /** Total field mappings in the template. */
  entries: TemplateMappingEntry[]
  /** Load order derived from FK graph across all contributing migrations. */
  loadOrder: Array<{ tableName: string; sequence: number; dependsOn: string[] }>
}

export interface TemplateMatchResult {
  /** How many target fields got a template match. */
  matched: number
  /** How many target fields had no match. */
  unmatched: number
  /** Coverage percentage. */
  coveragePct: number
  /** Per-field match results. */
  matches: Array<{
    targetField: FieldSignature
    templateEntry: TemplateMappingEntry | null
    /** 'exact' = same table+field+type. 'fuzzy' = same field+type, different table name. */
    matchType: 'exact' | 'fuzzy' | 'none'
  }>
}

// ─── Signature helpers ──────────────────────────────────────────────

function normalizeType(dataType: string): string {
  return dataType.toLowerCase().trim().replace(/\s+/g, ' ')
}

export function fieldSignature(
  tableName: string,
  fieldName: string,
  dataType: string,
  isNullable: boolean,
  isForeignKey: boolean,
): FieldSignature {
  return {
    tableName: tableName.toLowerCase(),
    fieldName: fieldName.toLowerCase(),
    dataType: normalizeType(dataType),
    isNullable,
    isForeignKey,
  }
}

function sigKey(sig: FieldSignature): string {
  return `${sig.tableName}.${sig.fieldName}|${sig.dataType}|${sig.isNullable}|${sig.isForeignKey}`
}

function fuzzyKey(sig: FieldSignature): string {
  return `${sig.fieldName}|${sig.dataType}`
}

// ─── Extract template from completed migration ──────────────────────

export interface CompletedMapping {
  sourceTableName: string
  sourceFieldName: string
  sourceDataType: string
  sourceIsNullable: boolean
  sourceIsForeignKey: boolean
  targetTableName: string
  targetFieldName: string
  targetDataType: string
  targetIsNullable: boolean
  targetIsForeignKey: boolean
  transformSql: string | null
  explanation: string
  confidence: number
}

/**
 * Extract a template from a completed migration's approved mappings.
 * Call this when a project reaches "exported" status.
 */
export function extractTemplate(
  sourceSystem: string,
  targetSystem: string,
  completedMappings: CompletedMapping[],
  loadOrder: Array<{ tableName: string; sequence: number; dependsOn: string[] }>,
): MigrationTemplate {
  const entries: TemplateMappingEntry[] = completedMappings.map(m => ({
    source: fieldSignature(
      m.sourceTableName, m.sourceFieldName, m.sourceDataType,
      m.sourceIsNullable, m.sourceIsForeignKey,
    ),
    target: fieldSignature(
      m.targetTableName, m.targetFieldName, m.targetDataType,
      m.targetIsNullable, m.targetIsForeignKey,
    ),
    transformSql: m.transformSql,
    explanation: m.explanation,
    confidence: m.confidence,
    reuseCount: 0,
    overrideCount: 0,
  }))

  return {
    id: crypto.randomUUID(),
    sourceSystem,
    targetSystem,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    migrationCount: 1,
    entries,
    loadOrder,
  }
}

// ─── Apply template to new migration ────────────────────────────────

/**
 * Match a template against a new migration's target fields.
 * Returns which fields have pre-existing mappings and which don't.
 *
 * Match priority:
 * 1. Exact: same table name + field name + data type
 * 2. Fuzzy: same field name + data type (different table name)
 * 3. None: no match
 *
 * Fuzzy matches get lower confidence (original × 0.7).
 */
export function applyTemplate(
  template: MigrationTemplate,
  targetFields: FieldSignature[],
): TemplateMatchResult {
  // Build lookup indexes
  const exactIndex = new Map<string, TemplateMappingEntry>()
  const fuzzyIndex = new Map<string, TemplateMappingEntry[]>()

  for (const entry of template.entries) {
    exactIndex.set(sigKey(entry.target), entry)
    const fk = fuzzyKey(entry.target)
    if (!fuzzyIndex.has(fk)) fuzzyIndex.set(fk, [])
    fuzzyIndex.get(fk)!.push(entry)
  }

  const matches: TemplateMatchResult['matches'] = []

  for (const tf of targetFields) {
    // Try exact match
    const exact = exactIndex.get(sigKey(tf))
    if (exact) {
      matches.push({ targetField: tf, templateEntry: exact, matchType: 'exact' })
      continue
    }

    // Try fuzzy match (same field name + type, any table)
    const fuzzyMatches = fuzzyIndex.get(fuzzyKey(tf))
    if (fuzzyMatches && fuzzyMatches.length === 1) {
      // Only use fuzzy if unambiguous (exactly one match)
      const fuzzy = { ...fuzzyMatches[0], confidence: fuzzyMatches[0].confidence * 0.7 }
      matches.push({ targetField: tf, templateEntry: fuzzy, matchType: 'fuzzy' })
      continue
    }

    matches.push({ targetField: tf, templateEntry: null, matchType: 'none' })
  }

  const matched = matches.filter(m => m.matchType !== 'none').length
  const unmatched = matches.filter(m => m.matchType === 'none').length

  return {
    matched,
    unmatched,
    coveragePct: targetFields.length > 0 ? Math.round((matched / targetFields.length) * 100) : 0,
    matches,
  }
}

/**
 * Merge a newly completed migration's mappings into an existing template.
 * Keeps the higher-confidence version when both exist.
 * Increments reuseCount for matching entries.
 * Adds new entries for mappings not in the template.
 */
export function mergeIntoTemplate(
  existing: MigrationTemplate,
  newMappings: CompletedMapping[],
  newLoadOrder: Array<{ tableName: string; sequence: number; dependsOn: string[] }>,
): MigrationTemplate {
  const entryIndex = new Map(existing.entries.map(e => [sigKey(e.target), e]))

  for (const m of newMappings) {
    const tSig = fieldSignature(
      m.targetTableName, m.targetFieldName, m.targetDataType,
      m.targetIsNullable, m.targetIsForeignKey,
    )
    const key = sigKey(tSig)
    const existingEntry = entryIndex.get(key)

    if (existingEntry) {
      // Entry exists — check if the new mapping matches or overrides
      const sSig = fieldSignature(
        m.sourceTableName, m.sourceFieldName, m.sourceDataType,
        m.sourceIsNullable, m.sourceIsForeignKey,
      )
      if (sigKey(existingEntry.source) === sigKey(sSig)) {
        // Same mapping — increment reuse count, keep higher confidence
        existingEntry.reuseCount++
        if (m.confidence > existingEntry.confidence) {
          existingEntry.confidence = m.confidence
          existingEntry.transformSql = m.transformSql
          existingEntry.explanation = m.explanation
        }
      } else {
        // Different mapping for same target — human overrode the template
        existingEntry.overrideCount++
        // If override is frequent (>50% of uses), replace the template entry
        if (existingEntry.overrideCount > existingEntry.reuseCount) {
          entryIndex.set(key, {
            source: sSig,
            target: tSig,
            transformSql: m.transformSql,
            explanation: m.explanation,
            confidence: m.confidence,
            reuseCount: 0,
            overrideCount: 0,
          })
        }
      }
    } else {
      // New entry — add to template
      entryIndex.set(key, {
        source: fieldSignature(
          m.sourceTableName, m.sourceFieldName, m.sourceDataType,
          m.sourceIsNullable, m.sourceIsForeignKey,
        ),
        target: tSig,
        transformSql: m.transformSql,
        explanation: m.explanation,
        confidence: m.confidence,
        reuseCount: 0,
        overrideCount: 0,
      })
    }
  }

  return {
    ...existing,
    updatedAt: new Date().toISOString(),
    migrationCount: existing.migrationCount + 1,
    entries: Array.from(entryIndex.values()),
    // Merge load orders — keep the longer/more detailed one
    loadOrder: newLoadOrder.length > existing.loadOrder.length ? newLoadOrder : existing.loadOrder,
  }
}
