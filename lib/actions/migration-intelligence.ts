'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callClaude } from '@/lib/ai/claude'
import type { MigrationIntelligence } from '@/lib/types/database'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractedPattern {
  category: MigrationIntelligence['category']
  title: string
  pattern_description: string
  pattern_config: Record<string, unknown>
  tags: string[]
}

interface AppliedTransform {
  sourceFieldType: string
  targetFieldType: string
  transformDescription: string
  transformSql: string
  sourceFieldName: string
  targetFieldName: string
}

interface DetectedIssue {
  title: string
  description: string
  severity: string
  detectionType: string
}

interface ProjectOutcomes {
  appliedTransforms: AppliedTransform[]
  detectedIssues: DetectedIssue[]
  sourceSystemName: string
  targetSystemName: string
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are analyzing a completed data migration project to extract GENERALIZABLE patterns for a migration intelligence knowledge base.

CRITICAL RULES:
1. Extract PATTERNS and APPROACHES, not project-specific field names or values.
2. Every pattern must be useful across DIFFERENT source and target systems — not just this specific pair.
3. Do NOT reference specific table names or field names as if they will exist in future projects.
4. DO describe the TYPE of transformation, the APPROACH used, and EDGE CASES discovered.
5. For transformations, describe the general recipe (e.g., "strip currency formatting from VARCHAR before casting to DECIMAL") not the specific mapping (e.g., "customers.annual_revenue → Account.AnnualRevenue").
6. For data quality issues, describe the detection method and typical characteristics, not the specific affected records.
7. For domain knowledge, describe the general entity model and relationships, not specific schema structures.
8. Patterns should be written as 2-3 sentence descriptions that could be injected directly into a future Claude prompt as reference context.
9. Avoid duplicating common knowledge that any LLM already knows (e.g., "dates should be valid"). Focus on patterns specific to enterprise data migration that are genuinely learned from this project.

Output ONLY a JSON array. No markdown, no code fences, no explanation text.

Each element must have exactly these fields:
{
  "category": "transformation_recipe" | "data_quality_pattern" | "domain_knowledge" | "source_system_hint",
  "title": "Short descriptive title (max 60 chars)",
  "pattern_description": "2-3 sentence description for prompt injection",
  "pattern_config": { structured metadata — see examples below },
  "tags": ["relevant", "lowercase", "tags"]
}

PATTERN_CONFIG EXAMPLES:

For transformation_recipe:
{
  "pattern_type": "currency_cleanup",
  "source_indicators": ["VARCHAR field with $ or comma characters", "field name suggests money/revenue/price"],
  "target_indicators": ["DECIMAL or NUMERIC type"],
  "approach": "REGEXP_REPLACE to strip formatting, then cast",
  "edge_cases": ["parentheses for negatives", "currency code prefixes", "empty string vs NULL"]
}

For data_quality_pattern:
{
  "pattern_type": "orphaned_foreign_keys",
  "detection_method": "LEFT JOIN parent WHERE parent.pk IS NULL",
  "typical_rate_percent": "2-5",
  "common_causes": ["parent deletions without cascade", "bulk imports with bad references"]
}

For domain_knowledge:
{
  "domain": "legal_elm",
  "entity_patterns": ["matters as core entity", "organizations linked to timekeepers", "invoices reference both matters and orgs"],
  "load_order_hint": "independent entities first, then junction/child entities"
}

For source_system_hint:
{
  "system_type": "legacy_crm",
  "common_characteristics": ["VARCHAR for most fields", "mixed date formats", "currency formatting in numeric fields"],
  "typical_issues": ["orphaned FKs from historical deletions", "inconsistent categorical values"]
}

Generate 8-15 patterns. Prioritize transformation recipes and data quality patterns — these are most actionable. Include 1-2 domain knowledge entries and 1 source system hint if applicable.`

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Rough title similarity check: returns true if the two titles share enough
 * words to be considered the same pattern. Favors false negatives over false
 * positives (when in doubt, we insert as a new record).
 */
function titlesAreSimilar(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)

  const wordsA = new Set(normalize(a))
  const wordsB = new Set(normalize(b))

  if (wordsA.size === 0 || wordsB.size === 0) return false

  // Exact match after normalization
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true

  // One title contains the other (substring match)
  if (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase())) {
    return true
  }

  // >60% word overlap (Jaccard-style)
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
  const union = new Set([...wordsA, ...wordsB]).size
  return intersection / union > 0.6
}

/**
 * Merge array values from a new pattern_config into an existing one.
 * For array fields, computes the union. For non-array fields, keeps existing.
 */
function mergePatternConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value) && Array.isArray(existing[key])) {
      // Union of arrays (deduplicated strings)
      const combined = [...(existing[key] as unknown[]), ...value]
      merged[key] = [...new Set(combined.map(String))]
    }
    // Non-array fields: keep existing value (don't overwrite)
  }
  return merged
}

// ── Feedback Loop Helpers ─────────────────────────────────────────────────────

/**
 * Returns true if an applied transform confirms a transformation_recipe pattern.
 * Deliberately generous — false positives (small confidence boost) are low risk.
 */
function doesTransformMatchRecipe(
  transform: AppliedTransform,
  pattern: MigrationIntelligence
): boolean {
  const config = pattern.pattern_config as Record<string, unknown>
  const patternType = config?.pattern_type as string | undefined
  if (!patternType) return false

  const sql = transform.transformSql
  const tgtType = transform.targetFieldType.toUpperCase()

  switch (patternType) {
    case 'currency_cleanup':
      return (
        sql.includes('REGEXP_REPLACE') &&
        (sql.includes('$') || sql.includes('\\$') || sql.includes("'[\\$,]'") || sql.includes("'[$,]'")) &&
        (tgtType.includes('DECIMAL') || tgtType.includes('NUMERIC') || tgtType.includes('FLOAT'))
      )

    case 'date_format':
      return (
        (sql.toUpperCase().includes('TO_DATE') ||
          sql.includes('::date') ||
          sql.includes('::timestamp') ||
          sql.toUpperCase().includes('TO_TIMESTAMP') ||
          sql.toUpperCase().includes('STR_TO_DATE')) &&
        (tgtType.includes('DATE') || tgtType.includes('TIMESTAMP'))
      )

    case 'boolean_normalization':
      return (
        (sql.includes("'Y'") ||
          sql.includes("'YES'") ||
          sql.includes("'true'") ||
          sql.includes("'1'") ||
          sql.toUpperCase().includes('CASE') && sql.toUpperCase().includes('BOOL')) &&
        (tgtType.includes('BOOL') || tgtType.includes('BIT'))
      )

    case 'code_mapping':
      return (
        sql.toUpperCase().includes('CASE') &&
        sql.toUpperCase().includes('WHEN') &&
        sql.toUpperCase().includes('THEN')
      )

    case 'phone_standardization':
      return (
        sql.includes('E.164') ||
        (sql.includes('REGEXP_REPLACE') && sql.includes('[^0-9'))
      )

    case 'name_capitalization':
      return (
        sql.toUpperCase().includes('INITCAP') ||
        sql.toUpperCase().includes('PROPER') ||
        (sql.toUpperCase().includes('UPPER') && sql.toUpperCase().includes('LEFT'))
      )

    case 'state_code':
      return (
        sql.includes('LEFT(') &&
        sql.includes('2)') &&
        sql.toUpperCase().includes('UPPER')
      )

    case 'id_prefix_strip':
      return sql.includes('REPLACE') || sql.includes('SUBSTRING') || sql.includes('SUBSTR')

    case 'string_truncation':
      return sql.includes('LEFT(') || sql.includes('SUBSTRING(') || sql.includes('SUBSTR(')

    default: {
      // Fuzzy match: >1 meaningful word in common between pattern title and transform description
      const patternWords = pattern.title.toLowerCase().split(/\s+/)
      const transformWords = transform.transformDescription.toLowerCase().split(/\s+/)
      const overlap = patternWords.filter(
        (w) => w.length > 3 && transformWords.includes(w)
      )
      return overlap.length >= 2
    }
  }
}

/**
 * Returns true if a detected quality issue confirms a data_quality_pattern.
 */
function doesIssueMatchPattern(
  issue: DetectedIssue,
  pattern: MigrationIntelligence
): boolean {
  const config = pattern.pattern_config as Record<string, unknown>
  const patternType = config?.pattern_type as string | undefined
  if (!patternType) return false

  const issueText = (issue.title + ' ' + issue.description).toLowerCase()

  switch (patternType) {
    case 'orphaned_foreign_keys':
      return issueText.includes('orphan') || issueText.includes('referential integrity') || issueText.includes('foreign key')
    case 'null_primary_keys':
      return issueText.includes('null') && (issueText.includes('primary key') || issueText.includes(' pk ') || issueText.includes('pk)'))
    case 'mixed_date_formats':
      return issueText.includes('date') && (issueText.includes('format') || issueText.includes('invalid') || issueText.includes('mixed'))
    case 'duplicate_records':
      return issueText.includes('duplicate') || issueText.includes('duplicat')
    case 'inconsistent_categorical':
      return issueText.includes('inconsistent') || issueText.includes('variant') || issueText.includes('casing')
    case 'currency_formatting':
      return issueText.includes('currency') || issueText.includes('dollar') || issueText.includes('$') || issueText.includes('symbol')
    case 'truncation_risk':
      return issueText.includes('truncat') || issueText.includes('exceed') || issueText.includes('length')
    case 'empty_string_vs_null':
      return (issueText.includes('empty') || issueText.includes("''")) && issueText.includes('null')
    default: {
      // Fuzzy match: pattern title words appear in issue text
      const patternWords = pattern.title.toLowerCase().split(/\s+/)
      return patternWords.filter((w) => w.length > 3 && issueText.includes(w)).length >= 2
    }
  }
}

/**
 * Recalculates pattern confidence using Laplace-smoothed confirmation ratio
 * plus a breadth bonus for patterns seen across many projects.
 *
 * Range: 0.1 (floor) – 0.95 (ceiling)
 * A new pattern (no confirmations, no rejections) scores ~0.3.
 * 5 confirmations + 0 rejections → ~0.75.
 * 10 confirmations + 0 rejections → ~0.86.
 */
function recalculateConfidence(pattern: {
  times_confirmed: number
  times_rejected: number
  times_seen: number
}): number {
  const { times_confirmed, times_rejected, times_seen } = pattern
  const confirmationScore = times_confirmed / (times_confirmed + times_rejected + 5)
  const seenBonus = Math.min(0.15, (times_seen - 1) * 0.03)
  const confidence = Math.min(0.95, 0.3 + confirmationScore * 0.55 + seenBonus)
  return Math.max(0.1, Number(confidence.toFixed(3)))
}

/**
 * For each existing pattern, checks whether the completed project's outcomes
 * confirm it. Confirmed patterns get times_confirmed + 1 and a confidence boost.
 * Rejection is only applied to transformation_recipe patterns that were relevant
 * to the project's target field types but were not matched — a deliberately
 * conservative signal.
 */
async function updatePatternConfidence(
  userId: string,
  projectId: string,
  existingPatterns: MigrationIntelligence[],
  outcomes: ProjectOutcomes
): Promise<{ updated: number }> {
  let updated = 0

  // Collect all target field types in this project for relevance checks
  const allTargetTypes = new Set(
    outcomes.appliedTransforms.map((t) => t.targetFieldType.toUpperCase())
  )

  for (const pattern of existingPatterns) {
    // Skip domain_knowledge and source_system_hint — too broad to confirm/reject per project
    if (pattern.category === 'domain_knowledge' || pattern.category === 'source_system_hint') {
      continue
    }

    let confirmed = false
    let relevant = false

    if (pattern.category === 'transformation_recipe') {
      // Check if any applied transform matches this recipe
      confirmed = outcomes.appliedTransforms.some((t) =>
        doesTransformMatchRecipe(t, pattern)
      )

      // Determine relevance: pattern's target_indicators mention a type present in this project
      const config = pattern.pattern_config as Record<string, unknown>
      const targetIndicators = (config?.target_indicators as string[] | undefined) ?? []
      relevant = targetIndicators.some((indicator) =>
        [...allTargetTypes].some((tgt) =>
          tgt.includes(indicator.toUpperCase().replace(/[^A-Z0-9]/g, ''))
        )
      )
    } else if (pattern.category === 'data_quality_pattern') {
      // Check if any detected issue matches this pattern
      confirmed = outcomes.detectedIssues.some((issue) =>
        doesIssueMatchPattern(issue, pattern)
      )
      relevant = outcomes.detectedIssues.length > 0
    }

    if (confirmed) {
      const updated_times_confirmed = pattern.times_confirmed + 1
      const updated_times_seen = Math.max(pattern.times_seen, pattern.times_seen + 1)
      const mergedProjectIds = [...new Set([...pattern.source_project_ids, projectId])]

      await supabaseAdmin
        .from('migration_intelligence')
        .update({
          times_confirmed: updated_times_confirmed,
          times_seen: updated_times_seen,
          confidence: recalculateConfidence({
            times_confirmed: updated_times_confirmed,
            times_rejected: pattern.times_rejected,
            times_seen: updated_times_seen,
          }),
          source_project_ids: mergedProjectIds,
          updated_at: new Date().toISOString(),
        })
        .eq('id', pattern.id)
        .eq('user_id', userId)

      updated++
    } else if (
      !confirmed &&
      relevant &&
      pattern.category === 'transformation_recipe'
      // Only reject recipe patterns that were applicable to this project's
      // target types but went unused — conservative signal
    ) {
      const updated_times_rejected = pattern.times_rejected + 1

      await supabaseAdmin
        .from('migration_intelligence')
        .update({
          times_rejected: updated_times_rejected,
          confidence: recalculateConfidence({
            times_confirmed: pattern.times_confirmed,
            times_rejected: updated_times_rejected,
            times_seen: pattern.times_seen,
          }),
          updated_at: new Date().toISOString(),
        })
        .eq('id', pattern.id)
        .eq('user_id', userId)

      updated++
    }
  }

  return { updated }
}

// ── Main Extraction Action ────────────────────────────────────────────────────

// Guard-wiring decision (Prompt 3d, Step 3D-9, Gate 2 §1.8):
// `extractMigrationIntelligence` writes to the `migration_intelligence`
// knowledge-base table — NOT to any mapping-shape table
// (target_field_mappings / mapping_sources / transformations /
// table_mappings). Per the Gate 2 guard-wiring policy, only functions
// that mutate mapping shape need `assertMappingWritesEnabled` guards;
// this function is out of scope for that guard and intentionally does
// not call it. The feedback-loop `UPDATE`s and the dedupe `INSERT/UPDATE`s
// all target `migration_intelligence` rows only, and are safe to run
// while mapping writes are disabled (maintenance_mode=true).
export async function extractMigrationIntelligence(projectId: string): Promise<{
  success: boolean
  patternsExtracted?: number
  patternsNew?: number
  patternsUpdated?: number
  error?: string
}> {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return { success: false, error: 'Not authenticated' }
    }

    const { data: project, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id, name, user_id')
      .eq('id', projectId)
      .maybeSingle()

    if (projectError || !project) {
      return { success: false, error: 'Project not found or access denied' }
    }

    // ── Parallel data fetch (hop 1) ───────────────────────────────────────────
    const [datasetsResult, tableMappingsResult, qualityIssuesResult, validationRulesResult, schemaDocsResult] =
      await Promise.all([
        supabaseAdmin
          .from('datasets')
          .select('id, name, role')
          .eq('project_id', projectId),

        supabaseAdmin
          .from('table_mappings')
          .select('id, source_table_id, target_table_id, status')
          .eq('project_id', projectId)
          .eq('status', 'approved'),

        supabaseAdmin
          .from('quality_issues')
          .select('id, title, description, stage, severity, status, detection_type, affected_records')
          .eq('project_id', projectId),

        supabaseAdmin
          .from('validation_rules')
          .select('id, name, rule_type, rule_config, severity, field_id')
          .eq('project_id', projectId),

        supabaseAdmin
          .from('schema_documents')
          .select('doc_type, extracted_text, filename')
          .eq('project_id', projectId)
          .in('doc_type', ['schema', 'business_context']),
      ])

    const datasets = datasetsResult.data ?? []
    const tableMappings = tableMappingsResult.data ?? []
    const qualityIssues = qualityIssuesResult.data ?? []
    const validationRules = validationRulesResult.data ?? []
    const schemaDocs = schemaDocsResult.data ?? []

    const sourceDataset = datasets.find((d) => d.role === 'source')
    const targetDataset = datasets.find((d) => d.role === 'target')

    if (tableMappings.length === 0) {
      return { success: false, error: 'No approved table mappings found — nothing to extract' }
    }

    // ── Parallel data fetch (hop 2) ───────────────────────────────────────────
    // Fetch all source/target table names and project-scoped TFMs in parallel.
    //
    // NEW-MODEL NOTE (Prompt 3d, Step 3D-9, Gate 2 §1.8): the legacy
    // per-TM `.from('field_mappings')` query is replaced with a project-
    // scoped `target_field_mappings` fetch that nests `mapping_sources`
    // (with their own `source_field` embed) and `target_field`. Per Q3
    // decision we then FLATTEN the TFM+MS graph into an array of
    // FM-shaped rows — one row per primary MS, one row per contributor
    // MS, one row per value assignment — so the Claude prompt retains
    // its legacy "one line per primary + one line per contributor"
    // shape. Bare-acknowledgment TFMs (no MS, combination_type != custom_sql)
    // produce zero rows: legacy field_acknowledgments never emitted
    // prompt lines either.
    //
    // Contributor flat-rows carry a sentinel `id` (distinct from any
    // TFM id) so that `transformsByTfmId.get(flat.id)` naturally
    // returns undefined for contributors — legacy semantics, where the
    // transform line rendered exactly once per multi-source mapping,
    // are preserved without any new branching in the downstream
    // render loops.
    const allTableIds = [
      ...tableMappings.map((tm) => tm.source_table_id),
      ...tableMappings.map((tm) => tm.target_table_id),
    ].filter(Boolean) as string[]

    const [tablesResult, tfmResult] = await Promise.all([
      supabaseAdmin
        .from('tables')
        .select('id, name, dataset_id')
        .in('id', allTableIds),

      supabaseAdmin
        .from('target_field_mappings')
        .select(
          `
          id,
          confidence,
          needs_transformation,
          combination_type,
          target_field:fields!target_field_id (
            id, name, data_type, is_nullable, is_primary_key, is_foreign_key, table_id
          ),
          mapping_sources (
            id, ordinal, source_field_id, source_table_id, confidence,
            source_field:fields!source_field_id (
              id, name, data_type, inferred_type
            )
          )
          `
        )
        .eq('project_id', projectId)
        .neq('status', 'rejected'),
    ])

    const allTables = tablesResult.data ?? []
    const tableById = new Map(allTables.map((t) => [t.id, t]))

    // ── Flatten TFM+MS into FM-shaped rows (Q3 preserves N-row output) ────────
    type SrcEmbed = { id: string; name: string; data_type: string; inferred_type: string | null }
    type TgtEmbed = {
      id: string
      name: string
      data_type: string
      is_nullable: boolean
      is_primary_key: boolean
      is_foreign_key: boolean
      table_id: string
    }
    type MsEmbed = {
      id: string
      ordinal: number
      source_field_id: string | null
      source_table_id: string | null
      confidence: number | null
      source_field: SrcEmbed | SrcEmbed[] | null
    }
    type TfmRow = {
      id: string
      confidence: number | null
      needs_transformation: boolean | null
      combination_type: string | null
      target_field: TgtEmbed | TgtEmbed[] | null
      mapping_sources: MsEmbed[] | null
    }
    type FlatMappingRow = {
      id: string
      tfm_id: string
      table_mapping_id: string
      confidence: number | null
      needs_transformation: boolean | null
      source_field_id: string | null
      source_field: SrcEmbed | null
      target_field: TgtEmbed | null
      is_contributor: boolean
    }
    const pickOne = <T>(v: T | T[] | null | undefined): T | null =>
      v == null ? null : Array.isArray(v) ? v[0] ?? null : v

    const tfms = (tfmResult.data ?? []) as unknown as TfmRow[]
    const tfmIds = tfms.map((t) => t.id)

    const fieldMappings: FlatMappingRow[] = []
    for (const tfm of tfms) {
      const tgt = pickOne(tfm.target_field)
      if (!tgt) continue
      const msAll = [...(tfm.mapping_sources ?? [])].sort((a, b) => a.ordinal - b.ordinal)
      const primary = msAll[0] ?? null
      const isVA = msAll.length === 0 && tfm.combination_type === 'custom_sql'
      const isBareAck = msAll.length === 0 && !isVA
      if (isBareAck) continue

      // Owning-TM rule: target_field.table_id == tm.target_table_id AND
      //   mapped case: primary MS source_table_id == tm.source_table_id
      //   VA case:     any tm with matching target_table_id (first match)
      const owningTm = tableMappings.find((tm) => {
        if (tm.target_table_id !== tgt.table_id) return false
        if (isVA) return true
        if (!primary) return false
        return primary.source_table_id === tm.source_table_id
      })
      if (!owningTm) continue

      if (isVA) {
        fieldMappings.push({
          id: tfm.id,
          tfm_id: tfm.id,
          table_mapping_id: owningTm.id,
          confidence: tfm.confidence,
          needs_transformation: tfm.needs_transformation,
          source_field_id: null,
          source_field: null,
          target_field: tgt,
          is_contributor: false,
        })
        continue
      }

      // Mapped case: emit primary + each contributor (ordinal ascending).
      for (const ms of msAll) {
        const isPrimary = ms.ordinal === 0
        fieldMappings.push({
          // Only primary carries the real TFM id; contributors get a
          // sentinel id so transformsByTfmId.get() yields undefined for
          // them (legacy: only primary had a transformation row; its
          // render block fired exactly once per multi-source mapping).
          id: isPrimary ? tfm.id : `${tfm.id}:contrib:${ms.ordinal}`,
          tfm_id: tfm.id,
          table_mapping_id: owningTm.id,
          // Legacy: per-FM confidence on each row. MS.confidence is the
          // per-contributor confidence in the new model.
          confidence: ms.confidence,
          // `needs_transformation` lives on TFM only (migration 075);
          // surface the same TFM-level flag on every flat row to
          // preserve the legacy "Needs transform: yes/no" column.
          needs_transformation: tfm.needs_transformation,
          source_field_id: ms.source_field_id,
          source_field: pickOne(ms.source_field),
          target_field: tgt,
          is_contributor: !isPrimary,
        })
      }
    }

    // ── Parallel data fetch (hop 3) ───────────────────────────────────────────
    // Fetch transformations scoped by target_field_mapping_id (column rename).
    const { data: transformations } = await supabaseAdmin
      .from('transformations')
      .select('id, target_field_mapping_id, description, generated_sql, status')
      .in('target_field_mapping_id', tfmIds)

    const transformsByTfmId = new Map(
      (transformations ?? []).map((t) => [t.target_field_mapping_id, t])
    )

    // ── Fetch existing patterns (used for both feedback and deduplication) ────
    const { data: existingPatternsData } = await supabaseAdmin
      .from('migration_intelligence')
      .select('*')
      .eq('user_id', user.id)
      .gte('confidence', 0.1)
      .order('confidence', { ascending: false })

    const existing = (existingPatternsData ?? []) as MigrationIntelligence[]

    // ── Feedback loop: update confidence on existing patterns ─────────────────
    if (existing.length > 0) {
      try {
        // Build ProjectOutcomes from already-fetched data
        const appliedTransforms: AppliedTransform[] = []
        for (const t of transformations ?? []) {
          if (!t.generated_sql) continue
          // Match against the primary flat row (whose id equals the real
          // TFM id). Contributor flat rows carry sentinel ids and will
          // never match here — correct, since transformations are 1:1
          // with TFMs in the new model.
          const fm = fieldMappings.find((f) => f.id === t.target_field_mapping_id)
          if (!fm) continue
          const tgt = fm.target_field as unknown as { name: string; data_type: string } | null
          if (!tgt) continue
          if (fm.source_field_id == null) continue
          const src = fm.source_field as unknown as { name: string; data_type: string } | null
          if (!src) continue

          appliedTransforms.push({
            sourceFieldType: src.data_type,
            targetFieldType: tgt.data_type,
            transformDescription: t.description ?? '',
            transformSql: t.generated_sql,
            sourceFieldName: src.name,
            targetFieldName: tgt.name,
          })
        }

        const detectedIssues: DetectedIssue[] = qualityIssues.map((issue) => ({
          title: issue.title,
          description: issue.description,
          severity: issue.severity,
          detectionType: issue.detection_type ?? 'manual',
        }))

        const outcomes: ProjectOutcomes = {
          appliedTransforms,
          detectedIssues,
          sourceSystemName: sourceDataset?.name ?? '',
          targetSystemName: targetDataset?.name ?? '',
        }

        const feedbackResult = await updatePatternConfidence(
          user.id,
          projectId,
          existing,
          outcomes
        )
        console.log(`[migration-intelligence] Feedback loop: updated ${feedbackResult.updated} patterns`)
      } catch (feedbackErr) {
        console.error('[migration-intelligence] Feedback loop failed (non-critical):', feedbackErr)
        // Continue with extraction regardless
      }
    }

    // ── Build user prompt ─────────────────────────────────────────────────────

    // Documentation context (truncated to keep prompt under 8k tokens)
    const docText = schemaDocs
      .map((d) => `[${d.doc_type}] ${d.filename ?? ''}:\n${d.extracted_text ?? ''}`)
      .join('\n\n---\n\n')
      .slice(0, 3000)

    // Mappings section
    let mappingsSection = ''
    for (const tm of tableMappings) {
      const srcTable = tableById.get(tm.source_table_id)
      const tgtTable = tableById.get(tm.target_table_id)
      if (!srcTable || !tgtTable) continue

      mappingsSection += `\n${srcTable.name} → ${tgtTable.name}\nFields:\n`

      const fields = fieldMappings.filter((fm) => fm.table_mapping_id === tm.id)
      for (const fm of fields) {
        const tgt = fm.target_field as unknown as { name: string; data_type: string; is_nullable: boolean } | null
        if (!tgt) continue
        const src = fm.source_field as unknown as { name: string; data_type: string; inferred_type: string | null } | null
        const srcDisplay =
          fm.source_field_id == null
            ? '[Value Assignment]'
            : src
              ? `${src.name} (${src.data_type}${src.inferred_type ? '/' + src.inferred_type : ''})`
              : null
        if (srcDisplay === null) continue

        // Contributor flat-rows carry sentinel ids (see TFM flattening
        // block above), so .get() returns undefined for them — only
        // the primary flat-row for each TFM produces a "Transform:"
        // line. Matches legacy semantics exactly.
        const transform = transformsByTfmId.get(fm.id)
        // Confidence is stored as 0-100 integer in target_field_mappings
        // and mapping_sources. Legacy formatter did Math.round(c * 100)
        // under the incorrect assumption that c was a 0-1 fraction,
        // producing absurd values like "9500%" in Claude prompts and
        // customer-facing execution packages. Fixed in Prompt 3c
        // (2026-04-22) — we now render the stored integer directly.
        const confidence = fm.confidence != null ? Math.round(fm.confidence) : '?'
        const needsTransform = fm.needs_transformation ? 'yes' : 'no'

        mappingsSection += `  - ${srcDisplay} → ${tgt.name} (${tgt.data_type})\n`
        mappingsSection += `    Confidence: ${confidence}% | Needs transform: ${needsTransform}\n`

        if (transform) {
          mappingsSection += `    Transform: ${transform.description ?? 'n/a'} | SQL: ${transform.generated_sql ?? 'n/a'}\n`
        }
      }
    }

    // Transformations section
    const allTransforms = transformations ?? []
    let transformsSection = ''
    for (const t of allTransforms) {
      // Resolves to the primary flat row (its id is the real TFM id);
      // contributor sentinel ids never collide with a transformation's
      // target_field_mapping_id.
      const fm = fieldMappings.find((f) => f.id === t.target_field_mapping_id)
      const src = !fm
        ? 'unknown'
        : fm.source_field_id == null
          ? '[Value Assignment]'
          : (fm.source_field as unknown as { name: string } | null)?.name ?? 'unknown'
      const tgt = (fm?.target_field as unknown as { name: string } | null)?.name ?? 'unknown'
      transformsSection += `  - ${src} → ${tgt}: ${t.description ?? 'n/a'}\n    SQL: ${t.generated_sql ?? 'n/a'}\n    Status: ${t.status}\n`
    }

    // Quality issues section
    let issuesSection = ''
    for (const issue of qualityIssues) {
      issuesSection += `  - [${issue.severity}] ${issue.title}: ${issue.description}\n`
      issuesSection += `    Stage: ${issue.stage} | Status: ${issue.status} | Affected: ${issue.affected_records ?? 0} records\n`
      issuesSection += `    Detection: ${issue.detection_type ?? 'manual'}\n`
    }

    // Validation rules section
    let rulesSection = ''
    for (const rule of validationRules) {
      rulesSection += `  - ${rule.name}: ${rule.rule_type}\n`
      rulesSection += `    Config: ${JSON.stringify(rule.rule_config)}\n`
      rulesSection += `    Severity: ${rule.severity}\n`
    }

    const totalFieldMappings = fieldMappings.length
    const totalTableMappings = tableMappings.length

    const userMessage = `## Completed Migration Project Analysis

Project: ${project.name}
Source system: ${sourceDataset?.name ?? 'Unknown'}
Target system: ${targetDataset?.name ?? 'Unknown'}

## Approved Mappings (${totalFieldMappings} field mappings across ${totalTableMappings} table mappings)
${mappingsSection}

## Transformations Applied (${allTransforms.length} total)
${transformsSection || '  (none)'}

## Data Quality Issues Detected (${qualityIssues.length} total)
${issuesSection || '  (none)'}

## Validation Rules Created (${validationRules.length} total)
${rulesSection || '  (none)'}

## Documentation Context
<documentation>
${docText || '(no documentation uploaded)'}
</documentation>`

    // ── Claude call ───────────────────────────────────────────────────────────
    let rawResponse: string
    try {
      rawResponse = await callClaude(EXTRACTION_SYSTEM_PROMPT, userMessage, 4096)
    } catch (claudeErr) {
      console.error('Migration intelligence: Claude call failed:', claudeErr)
      return { success: false, error: 'AI extraction failed' }
    }

    // ── Parse Claude response ─────────────────────────────────────────────────
    let extractedPatterns: ExtractedPattern[]
    try {
      // Strip any accidental markdown fences Claude may include
      const cleaned = rawResponse
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim()
      extractedPatterns = JSON.parse(cleaned)

      if (!Array.isArray(extractedPatterns)) {
        throw new Error('Response is not a JSON array')
      }
    } catch (parseErr) {
      console.error('Migration intelligence: JSON parse failed. Raw response:', rawResponse, parseErr)
      return { success: false, error: 'Failed to parse AI response as JSON' }
    }

    // ── Deduplicate and upsert ────────────────────────────────────────────────
    // `existing` was fetched before the Claude call; stale confidence values are
    // fine here since deduplication only matches on category + title.
    let patternsNew = 0
    let patternsUpdated = 0

    for (const pattern of extractedPatterns) {
      // Basic validation
      if (!pattern.title || !pattern.pattern_description || !pattern.category) continue

      const similar = existing.find(
        (e) => e.category === pattern.category && titlesAreSimilar(e.title, pattern.title)
      )

      if (similar) {
        // Merge with existing record
        const newTimesSeen = (similar.times_seen ?? 1) + 1
        const existingProjectIds = (similar.source_project_ids as string[]) ?? []
        const mergedProjectIds = existingProjectIds.includes(projectId)
          ? existingProjectIds
          : [...existingProjectIds, projectId]
        const mergedTags = [
          ...new Set([...(similar.tags as string[] ?? []), ...(pattern.tags ?? [])]),
        ]
        const mergedConfig = mergePatternConfig(
          (similar.pattern_config as Record<string, unknown>) ?? {},
          pattern.pattern_config ?? {}
        )
        const newConfidence = recalculateConfidence({
          times_confirmed: similar.times_confirmed ?? 0,
          times_rejected: similar.times_rejected ?? 0,
          times_seen: newTimesSeen,
        })

        await supabaseAdmin
          .from('migration_intelligence')
          .update({
            times_seen: newTimesSeen,
            source_project_ids: mergedProjectIds,
            tags: mergedTags,
            pattern_config: mergedConfig,
            confidence: newConfidence,
            updated_at: new Date().toISOString(),
          })
          .eq('id', similar.id)
          .eq('user_id', user.id)

        patternsUpdated++
      } else {
        // Insert as a new pattern
        await supabaseAdmin.from('migration_intelligence').insert({
          user_id: user.id,
          category: pattern.category,
          title: pattern.title.slice(0, 200),
          pattern_description: pattern.pattern_description,
          pattern_config: pattern.pattern_config ?? {},
          confidence: 0.5,
          times_seen: 1,
          times_confirmed: 0,
          times_rejected: 0,
          tags: pattern.tags ?? [],
          source_project_ids: [projectId],
        })

        patternsNew++
      }
    }

    return {
      success: true,
      patternsExtracted: extractedPatterns.length,
      patternsNew,
      patternsUpdated,
    }
  } catch (err) {
    console.error('Migration intelligence: unexpected error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Unexpected error' }
  }
}

// ── Query Helper ──────────────────────────────────────────────────────────────

export async function getMigrationIntelligence(userId?: string): Promise<{
  success: boolean
  patterns?: MigrationIntelligence[]
  error?: string
}> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return { success: false, error: 'Not authenticated' }
    }

    const targetUserId = userId ?? user.id

    const { data, error } = await supabaseAdmin
      .from('migration_intelligence')
      .select('*')
      .eq('user_id', targetUserId)
      .order('confidence', { ascending: false })
      .limit(50)

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, patterns: (data ?? []) as MigrationIntelligence[] }
  } catch (err) {
    console.error('getMigrationIntelligence error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Unexpected error' }
  }
}
