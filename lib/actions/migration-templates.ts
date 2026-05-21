'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import type {
  FieldSignature,
  MigrationTemplate,
  TemplateMappingEntry,
  CompletedMapping,
} from '@/lib/validation/migration-template'
import {
  sigKey,
  extractTemplate,
  applyTemplate,
  mergeIntoTemplate,
} from '@/lib/validation/migration-template'

// ─── Types ──────────────────────────────────────────────────────────

interface TemplateActionResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

interface TemplateRow {
  id: string
  org_id: string
  source_system: string
  target_system: string
  migration_count: number
  load_order: Array<{ tableName: string; sequence: number; dependsOn: string[] }>
  created_at: string
  updated_at: string
}

interface EntryRow {
  id: string
  template_id: string
  source_sig: FieldSignature
  target_sig: FieldSignature
  transform_sql: string | null
  explanation: string
  confidence: number
  reuse_count: number
  override_count: number
}

// ─── Auth helper ────────────────────────────────────────────────────

async function requireAuth(): Promise<{ userId: string } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  return { userId: user.id }
}

// ─── DB → domain converters ─────────────────────────────────────────

function rowsToTemplate(template: TemplateRow, entries: EntryRow[]): MigrationTemplate {
  return {
    id: template.id,
    sourceSystem: template.source_system,
    targetSystem: template.target_system,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    migrationCount: template.migration_count,
    loadOrder: template.load_order ?? [],
    entries: entries.map(e => ({
      source: e.source_sig,
      target: e.target_sig,
      transformSql: e.transform_sql,
      explanation: e.explanation,
      confidence: e.confidence,
      reuseCount: e.reuse_count,
      overrideCount: e.override_count,
    })),
  }
}

// ─── Actions ────────────────────────────────────────────────────────

/**
 * Find an existing template for a system pair within an org.
 * Called when a new project is created to check for pre-existing templates.
 */
export async function findTemplate(
  orgId: string,
  sourceSystem: string,
  targetSystem: string,
): Promise<TemplateActionResult<MigrationTemplate | null>> {
  const auth = await requireAuth()
  if ('error' in auth) return { success: false, error: auth.error }

  const { data: template, error: tErr } = await supabaseAdmin
    .from('migration_templates')
    .select('*')
    .eq('org_id', orgId)
    .eq('source_system', sourceSystem.toLowerCase().trim())
    .eq('target_system', targetSystem.toLowerCase().trim())
    .maybeSingle()

  if (tErr) return { success: false, error: tErr.message }
  if (!template) return { success: true, data: null }

  const { data: entries, error: eErr } = await supabaseAdmin
    .from('template_entries')
    .select('*')
    .eq('template_id', template.id)

  if (eErr) return { success: false, error: eErr.message }

  return {
    success: true,
    data: rowsToTemplate(template as TemplateRow, (entries ?? []) as EntryRow[]),
  }
}

/**
 * Apply a template to a new migration's target fields.
 * Returns match results with coverage percentage.
 */
export async function applyTemplateToProject(
  orgId: string,
  sourceSystem: string,
  targetSystem: string,
  targetFields: FieldSignature[],
): Promise<TemplateActionResult<{
  matched: number
  unmatched: number
  coveragePct: number
  matches: Array<{
    targetField: FieldSignature
    templateEntry: TemplateMappingEntry | null
    matchType: 'exact' | 'fuzzy' | 'none'
  }>
}>> {
  const result = await findTemplate(orgId, sourceSystem, targetSystem)
  if (!result.success) return { success: false, error: result.error }
  if (!result.data) {
    return { success: true, data: { matched: 0, unmatched: targetFields.length, coveragePct: 0, matches: [] } }
  }

  const matchResult = applyTemplate(result.data, targetFields)
  return { success: true, data: matchResult }
}

/**
 * Save or update a template after a migration completes.
 * If no template exists for this system pair, creates one.
 * If one exists, merges the new mappings into it (flywheel).
 */
export async function saveTemplate(
  orgId: string,
  sourceSystem: string,
  targetSystem: string,
  completedMappings: CompletedMapping[],
  loadOrder: Array<{ tableName: string; sequence: number; dependsOn: string[] }>,
): Promise<TemplateActionResult<{ templateId: string; entryCount: number; isNew: boolean }>> {
  const auth = await requireAuth()
  if ('error' in auth) return { success: false, error: auth.error }

  if (completedMappings.length === 0) {
    return { success: false, error: 'No completed mappings to save' }
  }

  const srcNorm = sourceSystem.toLowerCase().trim()
  const tgtNorm = targetSystem.toLowerCase().trim()

  // Check for existing template
  const existing = await findTemplate(orgId, srcNorm, tgtNorm)
  if (!existing.success) return { success: false, error: existing.error }

  if (existing.data) {
    // ── Merge into existing template ────────────────────────────────
    const merged = mergeIntoTemplate(existing.data, completedMappings, loadOrder)
    return persistTemplate(orgId, srcNorm, tgtNorm, merged, false)
  } else {
    // ── Create new template ─────────────────────────────────────────
    const template = extractTemplate(srcNorm, tgtNorm, completedMappings, loadOrder)
    return persistTemplate(orgId, srcNorm, tgtNorm, template, true)
  }
}

/**
 * Record that a human accepted or overrode a template-suggested mapping.
 * This is the signal that makes templates smarter over time.
 *
 * Call this from the mapping approval flow:
 * - accepted=true  → the human approved the template's suggestion as-is
 * - accepted=false → the human changed the mapping to something else
 */
export async function recordTemplateOutcome(
  templateId: string,
  targetSig: FieldSignature,
  accepted: boolean,
  overriddenMapping?: {
    source: FieldSignature
    transformSql: string | null
    explanation: string
    confidence: number
  },
): Promise<TemplateActionResult> {
  const auth = await requireAuth()
  if ('error' in auth) return { success: false, error: auth.error }

  // Fetch all entries for this template and find the matching target sig.
  // Template entry counts are bounded (hundreds, not thousands) so this is fine.
  const { data: entries, error: findErr } = await supabaseAdmin
    .from('template_entries')
    .select('id, reuse_count, override_count, source_sig, target_sig')
    .eq('template_id', templateId)

  if (findErr) return { success: false, error: findErr.message }

  const targetKey = sigKey(targetSig)
  const entry = (entries ?? []).find(e => sigKey(e.target_sig as FieldSignature) === targetKey)
  if (!entry) return { success: true } // No template entry for this field — nothing to track

  if (accepted) {
    // Human accepted the suggestion — increment reuse
    const { error } = await supabaseAdmin
      .from('template_entries')
      .update({
        reuse_count: entry.reuse_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id)

    if (error) return { success: false, error: error.message }
  } else {
    // Human overrode the suggestion
    const newOverrideCount = entry.override_count + 1

    if (newOverrideCount > entry.reuse_count && overriddenMapping) {
      // Self-correction: override is more common — replace the entry
      const { error } = await supabaseAdmin
        .from('template_entries')
        .update({
          source_sig: overriddenMapping.source,
          transform_sql: overriddenMapping.transformSql,
          explanation: overriddenMapping.explanation,
          confidence: overriddenMapping.confidence,
          reuse_count: 0,
          override_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entry.id)

      if (error) return { success: false, error: error.message }
    } else {
      // Not enough overrides yet — just increment
      const { error } = await supabaseAdmin
        .from('template_entries')
        .update({
          override_count: newOverrideCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entry.id)

      if (error) return { success: false, error: error.message }
    }
  }

  return { success: true }
}

/**
 * Get template stats for a system pair (for UI display).
 */
export async function getTemplateStats(
  orgId: string,
  sourceSystem: string,
  targetSystem: string,
): Promise<TemplateActionResult<{
  exists: boolean
  migrationCount: number
  entryCount: number
  avgConfidence: number
  healthScore: number
} | null>> {
  const auth = await requireAuth()
  if ('error' in auth) return { success: false, error: auth.error }

  const { data: template, error: tErr } = await supabaseAdmin
    .from('migration_templates')
    .select('id, migration_count')
    .eq('org_id', orgId)
    .eq('source_system', sourceSystem.toLowerCase().trim())
    .eq('target_system', targetSystem.toLowerCase().trim())
    .maybeSingle()

  if (tErr) return { success: false, error: tErr.message }
  if (!template) return { success: true, data: null }

  const { data: entries, error: eErr } = await supabaseAdmin
    .from('template_entries')
    .select('confidence, reuse_count, override_count')
    .eq('template_id', template.id)

  if (eErr) return { success: false, error: eErr.message }
  if (!entries || entries.length === 0) {
    return { success: true, data: { exists: true, migrationCount: template.migration_count, entryCount: 0, avgConfidence: 0, healthScore: 0 } }
  }

  const avgConfidence = Math.round(entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length)

  // Health score: what % of entries have more reuses than overrides?
  const healthy = entries.filter(e => e.reuse_count >= e.override_count).length
  const healthScore = Math.round((healthy / entries.length) * 100)

  return {
    success: true,
    data: {
      exists: true,
      migrationCount: template.migration_count,
      entryCount: entries.length,
      avgConfidence,
      healthScore,
    },
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

async function persistTemplate(
  orgId: string,
  sourceSystem: string,
  targetSystem: string,
  template: MigrationTemplate,
  isNew: boolean,
): Promise<TemplateActionResult<{ templateId: string; entryCount: number; isNew: boolean }>> {
  // Upsert the template row
  const { data: row, error: tErr } = await supabaseAdmin
    .from('migration_templates')
    .upsert({
      org_id: orgId,
      source_system: sourceSystem,
      target_system: targetSystem,
      migration_count: template.migrationCount,
      load_order: template.loadOrder,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,source_system,target_system' })
    .select('id')
    .single()

  if (tErr || !row) return { success: false, error: tErr?.message ?? 'Failed to upsert template' }

  const templateId = row.id

  // Delete existing entries and re-insert (simpler than per-entry upsert
  // given the MD5 unique constraint and potential signature changes)
  if (!isNew) {
    const { error: delErr } = await supabaseAdmin
      .from('template_entries')
      .delete()
      .eq('template_id', templateId)

    if (delErr) return { success: false, error: delErr.message }
  }

  // Batch insert entries
  if (template.entries.length > 0) {
    const rows = template.entries.map(e => ({
      template_id: templateId,
      source_sig: e.source,
      target_sig: e.target,
      transform_sql: e.transformSql,
      explanation: e.explanation,
      confidence: e.confidence,
      reuse_count: e.reuseCount,
      override_count: e.overrideCount,
    }))

    const { error: insErr } = await supabaseAdmin
      .from('template_entries')
      .insert(rows)

    if (insErr) return { success: false, error: insErr.message }
  }

  return {
    success: true,
    data: { templateId, entryCount: template.entries.length, isNew },
  }
}

