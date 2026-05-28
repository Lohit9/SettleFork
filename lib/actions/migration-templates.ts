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

/**
 * Fire-and-forget: called at TFM approval time.
 * Looks up whether the project has a template for its system pair and whether
 * the approved mapping matches or diverges from the template suggestion.
 * Updates template counters and writes an override_log row.
 *
 * Exits silently if no template exists — snapshotTemplate handles new-template
 * creation on project completion.
 */
export async function updateTemplateFromApproval(
  projectId: string,
  tfmId: string,
  labelQuality?: {
    timeOnTaskMs?: number
    wasEdited?: boolean
    approvalMethod?: 'individual' | 'approve_all' | 'approve_high_confidence'
  },
): Promise<void> {
  // Resolve org + system names from the project
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .single()
  if (!project) return

  const { data: datasets } = await supabaseAdmin
    .from('datasets')
    .select('role, name')
    .eq('project_id', projectId)
    .in('role', ['source', 'target'])
  if (!datasets || datasets.length < 2) return

  const sourceSystem = datasets.find(d => d.role === 'source')?.name
  const targetSystem = datasets.find(d => d.role === 'target')?.name
  if (!sourceSystem || !targetSystem) return

  // Check if a template exists for this system pair
  const templateResult = await findTemplate(project.org_id, sourceSystem, targetSystem)
  if (!templateResult.success || !templateResult.data) return

  const template = templateResult.data

  // Resolve the target field's signature
  const { data: tfmRow } = await supabaseAdmin
    .from('target_field_mappings')
    .select('target_field_id')
    .eq('id', tfmId)
    .single()
  if (!tfmRow) return

  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('name, data_type, is_nullable, is_foreign_key, tables!inner(name)')
    .eq('id', tfmRow.target_field_id)
    .single()
  if (!targetField) return

  const tables = targetField.tables as unknown as { name: string }
  const targetSig: FieldSignature = {
    tableName: tables.name.toLowerCase(),
    fieldName: targetField.name.toLowerCase(),
    dataType: targetField.data_type.toLowerCase(),
    isNullable: targetField.is_nullable ?? true,
    isForeignKey: targetField.is_foreign_key ?? false,
  }

  // Find the matching template entry for this target sig
  const targetKey = sigKey(targetSig)
  const matchingEntry = template.entries.find(e => sigKey(e.target) === targetKey)
  if (!matchingEntry) return

  // Get the template entry DB row id
  const { data: entryRow } = await supabaseAdmin
    .from('template_entries')
    .select('id, source_sig, transform_sql, reuse_count, override_count')
    .eq('template_id', template.id)
    .filter('target_sig->>fieldName', 'eq', targetSig.fieldName)
    .filter('target_sig->>tableName', 'eq', targetSig.tableName)
    .maybeSingle()
  if (!entryRow) return

  // Resolve the current (human-approved) primary source field
  const { data: primarySource } = await supabaseAdmin
    .from('mapping_sources')
    .select('source_field_id, ordinal')
    .eq('target_field_mapping_id', tfmId)
    .order('ordinal', { ascending: true })
    .limit(1)
    .maybeSingle()

  let humanSourceSig: FieldSignature | undefined
  let humanTransformSql: string | undefined

  if (primarySource) {
    const { data: srcField } = await supabaseAdmin
      .from('fields')
      .select('name, data_type, is_nullable, is_foreign_key, tables!inner(name)')
      .eq('id', primarySource.source_field_id)
      .single()

    if (srcField) {
      const srcTables = srcField.tables as unknown as { name: string }
      humanSourceSig = {
        tableName: srcTables.name.toLowerCase(),
        fieldName: srcField.name.toLowerCase(),
        dataType: srcField.data_type.toLowerCase(),
        isNullable: srcField.is_nullable ?? true,
        isForeignKey: srcField.is_foreign_key ?? false,
      }
    }

    // Fetch the TFM's approved transform SQL if any
    const { data: tfmFull } = await supabaseAdmin
      .from('target_field_mappings')
      .select('transform_sql')
      .eq('id', tfmId)
      .maybeSingle()
    humanTransformSql = tfmFull?.transform_sql ?? undefined
  }

  // Determine outcome: did the human's choice match the template's suggestion?
  const suggestedKey = sigKey(matchingEntry.source)
  const humanKey = humanSourceSig ? sigKey(humanSourceSig) : null
  const accepted = humanKey === suggestedKey

  // Update template entry counters
  const newReuseCount = accepted ? entryRow.reuse_count + 1 : entryRow.reuse_count
  const newOverrideCount = accepted ? entryRow.override_count : entryRow.override_count + 1
  const shouldSelfCorrect = !accepted && newOverrideCount > newReuseCount && humanSourceSig

  if (shouldSelfCorrect && humanSourceSig) {
    await supabaseAdmin
      .from('template_entries')
      .update({
        source_sig: humanSourceSig,
        transform_sql: humanTransformSql ?? null,
        reuse_count: 0,
        override_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entryRow.id)
  } else {
    await supabaseAdmin
      .from('template_entries')
      .update({
        reuse_count: newReuseCount,
        override_count: newOverrideCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entryRow.id)
  }

  // Write the audit log row
  await supabaseAdmin
    .from('override_logs')
    .insert({
      org_id: project.org_id,
      project_id: projectId,
      template_entry_id: entryRow.id,
      target_sig: targetSig,
      suggested_source_sig: matchingEntry.source,
      suggested_transform_sql: matchingEntry.transformSql,
      human_source_sig: humanSourceSig ?? null,
      human_transform_sql: humanTransformSql ?? null,
      outcome: accepted ? 'accepted' : 'overridden',
      time_on_task_ms: labelQuality?.timeOnTaskMs ?? null,
      was_edited: labelQuality?.wasEdited ?? false,
      approval_method: labelQuality?.approvalMethod ?? null,
    })
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

