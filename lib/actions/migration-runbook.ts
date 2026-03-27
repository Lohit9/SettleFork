'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildMigrationRunbook } from '@/lib/reports/migration-runbook-docx'
import type { RunbookData } from '@/lib/reports/migration-runbook-docx'

// ── Load-order helper (Kahn's topological sort on FK deps) ────────────────────

interface TargetFieldRow {
  table_id: string
  is_foreign_key: boolean
  fk_reference: string | null
}

function computeLoadOrder(
  targetTables: Array<{ id: string; name: string }>,
  targetFields: TargetFieldRow[]
): RunbookData['loadOrder'] {
  const tableNames = new Map(targetTables.map((t) => [t.id, t.name]))
  const tableByNameLower = new Map(targetTables.map((t) => [t.name.toLowerCase(), t.name]))

  const deps = new Map<string, Set<string>>()
  for (const t of targetTables) deps.set(t.name, new Set())

  for (const field of targetFields) {
    if (!field.is_foreign_key || !field.fk_reference) continue
    const ownerTable = tableNames.get(field.table_id)
    if (!ownerTable) continue
    const parts = field.fk_reference.split('.')
    const refTableRaw = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    const refTable = tableByNameLower.get(refTableRaw.toLowerCase())
    if (refTable && refTable !== ownerTable) deps.get(ownerTable)?.add(refTable)
  }

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const [table, tableDeps] of deps) {
    inDegree.set(table, tableDeps.size)
    for (const dep of tableDeps) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(table)
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([t]) => t)
    .sort()

  const ordered: string[] = []
  while (queue.length > 0) {
    const table = queue.shift()!
    ordered.push(table)
    for (const dep of dependents.get(table) ?? []) {
      const nd = (inDegree.get(dep) ?? 1) - 1
      inDegree.set(dep, nd)
      if (nd === 0) queue.push(dep)
    }
  }

  // Circular dependency fallback
  if (ordered.length < targetTables.length) {
    const remaining = targetTables
      .map((t) => t.name)
      .filter((n) => !ordered.includes(n))
      .sort()
    ordered.push(...remaining)
  }

  return ordered.map((name, idx) => ({
    order: idx + 1,
    tableName: name,
    dependencies: [...(deps.get(name) ?? [])],
  }))
}

// ── Claude prompts ────────────────────────────────────────────────────────────

const RUNBOOK_SYSTEM_PROMPT = `You are generating content for a professional Migration Runbook document.
This is an operational guide for engineers who will execute a data migration.

Output ONLY valid JSON matching the exact structure specified. No markdown, no code fences, no extra text.

Write in clear, professional, action-oriented language. This document will be used by technical implementation teams at Fortune 500 companies.

For checklist items, write them as actionable tasks starting with a verb (e.g., "Verify all blocking quality issues are resolved", not "Blocking issues should be resolved").

For the execution plan steps, be specific about what to do and what to check. Reference the Migration Execution Package (.sql file) where appropriate.

For transformation rules, describe each transformation in plain business language. Include value mapping tables where a field requires code/value translation (e.g., source status values to target status codes). Skip simple direct-copy mappings.

Keep the executive summary to 3-4 sentences. Keep the rollback procedure to 2-3 sentences.`

// ── generateMigrationRunbook ──────────────────────────────────────────────────

export async function generateMigrationRunbook(
  projectId: string
): Promise<{ success: boolean; downloadUrl?: string; version?: string; error?: string }> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  // ── Ownership ───────────────────────────────────────────────────────────────
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { success: false, error: 'Access denied' }

  // ── Parallel data fetch (hop 1) ─────────────────────────────────────────────
  const [
    { data: datasets },
    { data: tableMappings },
    { data: qualityIssues },
    { data: schemaDocs },
  ] = await Promise.all([
    supabaseAdmin.from('datasets').select('id, name, role').eq('project_id', projectId),
    supabaseAdmin
      .from('table_mappings')
      .select('id, source_table_id, target_table_id, status')
      .eq('project_id', projectId)
      .eq('status', 'approved'),
    supabaseAdmin
      .from('quality_issues')
      .select('id, title, description, severity, status, affected_records')
      .eq('project_id', projectId),
    supabaseAdmin
      .from('schema_documents')
      .select('extracted_text, filename, doc_type')
      .eq('project_id', projectId)
      .eq('doc_type', 'business_context'),
  ])

  const srcDs = (datasets ?? []).find((d) => d.role === 'source')
  const tgtDs = (datasets ?? []).find((d) => d.role === 'target')
  const approvedTMs = tableMappings ?? []

  if (approvedTMs.length === 0) {
    return { success: false, error: 'No approved table mappings found' }
  }

  // ── Parallel data fetch (hop 2) ─────────────────────────────────────────────
  const allTableIds = [
    ...approvedTMs.map((tm) => tm.source_table_id),
    ...approvedTMs.map((tm) => tm.target_table_id),
  ].filter(Boolean) as string[]

  const tmIds = approvedTMs.map((tm) => tm.id)

  const [{ data: allTables }, { data: fieldMappings }] = await Promise.all([
    supabaseAdmin.from('tables').select('id, name, dataset_id, row_count').in('id', allTableIds),
    supabaseAdmin
      .from('field_mappings')
      .select(
        'id, table_mapping_id, status, needs_transformation, source_field:fields!field_mappings_source_field_id_fkey(id, name, data_type), target_field:fields!field_mappings_target_field_id_fkey(id, name, data_type, is_foreign_key, fk_reference)'
      )
      .in('table_mapping_id', tmIds),
  ])

  const tables = allTables ?? []
  const fms = fieldMappings ?? []
  const fmIds = fms.map((fm) => fm.id)

  // srcFields needs allTables resolved first (can't be in the same Promise.all)
  const srcTableIds = tables.filter((t) => t.dataset_id === srcDs?.id).map((t) => t.id)
  const { data: srcFields } =
    srcTableIds.length > 0
      ? await supabaseAdmin.from('fields').select('id').in('table_id', srcTableIds)
      : { data: [] as { id: string }[] }

  // ── Parallel data fetch (hop 3) ─────────────────────────────────────────────
  const [{ data: transformations }, { data: targetFieldsFull }] = await Promise.all([
    fmIds.length > 0
      ? supabaseAdmin
          .from('transformations')
          .select('field_mapping_id, description, generated_sql, status')
          .in('field_mapping_id', fmIds)
      : Promise.resolve({ data: [] }),
    // Fetch all target fields for FK-based load order
    tgtDs
      ? supabaseAdmin
          .from('fields')
          .select('id, table_id, name, is_foreign_key, fk_reference')
          .in(
            'table_id',
            tables.filter((t) => t.dataset_id === tgtDs.id).map((t) => t.id)
          )
      : Promise.resolve({ data: [] }),
  ])

  const allTransforms = transformations ?? []
  const transformByFMId = new Map(allTransforms.map((t) => [t.field_mapping_id, t]))

  // ── Compute stats ──────────────────────────────────────────────────────────
  const srcTables = tables.filter((t) => t.dataset_id === srcDs?.id)
  const tgtTables = tables.filter((t) => t.dataset_id === tgtDs?.id)
  const tableById = new Map(tables.map((t) => [t.id, t]))

  const totalSourceRecords = srcTables.reduce((s, t) => s + (t.row_count ?? 0), 0)
  const totalSourceFields = (srcFields ?? []).length
  const openBlocking = (qualityIssues ?? []).filter((q) => q.severity === 'blocking' && q.status === 'open').length
  const openWarnings = (qualityIssues ?? []).filter((q) => q.severity === 'warning' && q.status === 'open').length
  const safeTotalFields = Math.max(totalSourceFields, 1)
  const readinessScore = Math.max(0, Math.round(100 - Math.min((openBlocking / safeTotalFields) * 60, 60) - Math.min((openWarnings / safeTotalFields) * 20, 20)))

  const qIssues = qualityIssues ?? []
  const issuesFixed = qIssues.filter((q) => q.status === 'fixed').length
  const issuesAcceptedRisk = qIssues.filter((q) => q.status === 'accepted_risk').length
  const issuesOpen = qIssues.filter((q) => q.status === 'open').length

  // ── Compute load order ─────────────────────────────────────────────────────
  const loadOrder = computeLoadOrder(
    tgtTables.map((t) => ({ id: t.id, name: t.name })),
    (targetFieldsFull ?? []).map((f) => ({
      table_id: f.table_id,
      is_foreign_key: f.is_foreign_key,
      fk_reference: f.fk_reference,
    }))
  )

  // ── Build Claude user prompt ───────────────────────────────────────────────

  // Mapping summary
  let mappingBlock = ''
  for (const tm of approvedTMs) {
    const src = tableById.get(tm.source_table_id)
    const tgt = tableById.get(tm.target_table_id)
    if (!src || !tgt) continue
    const fields = fms.filter((fm) => fm.table_mapping_id === tm.id)
    mappingBlock += `\n${src.name} → ${tgt.name} (${fields.length} fields)\n`
    for (const fm of fields.slice(0, 20)) {
      const srcF = fm.source_field as unknown as { name: string; data_type: string } | null
      const tgtF = fm.target_field as unknown as { name: string; data_type: string } | null
      if (!srcF || !tgtF) continue
      const t = transformByFMId.get(fm.id)
      const xform = t ? ` | Transform: ${t.description ?? t.generated_sql?.slice(0, 60) ?? 'yes'}` : ''
      mappingBlock += `  ${srcF.name} (${srcF.data_type}) → ${tgtF.name} (${tgtF.data_type})${xform}\n`
    }
  }

  // Transforms summary
  const transformBlock = allTransforms
    .filter((t) => t.generated_sql)
    .slice(0, 30)
    .map((t) => {
      const fm = fms.find((f) => f.id === t.field_mapping_id)
      const src = (fm?.source_field as unknown as { name: string } | null)?.name ?? '?'
      const tgt = (fm?.target_field as unknown as { name: string } | null)?.name ?? '?'
      return `  ${src} → ${tgt}: ${t.description ?? ''}\n    SQL: ${(t.generated_sql ?? '').slice(0, 100)}`
    })
    .join('\n')

  // Open blocking issues
  const blockingDetail = qIssues
    .filter((q) => q.severity === 'blocking' && q.status === 'open')
    .slice(0, 10)
    .map((q) => `  - [BLOCKING] ${q.title}: ${q.description}`)
    .join('\n')

  // Business rules doc (truncated)
  const businessRules = (schemaDocs ?? [])
    .map((d) => `${d.filename ?? ''}:\n${d.extracted_text ?? ''}`)
    .join('\n\n')
    .slice(0, 3000)

  // Load order list
  const loadOrderText = loadOrder.map((l) => `  ${l.order}. ${l.tableName}${l.dependencies.length ? ` (depends on: ${l.dependencies.join(', ')})` : ''}`).join('\n')

  const userMessage = `Generate a Migration Runbook content package for the following project.
Return ONLY a JSON object with this exact structure:

{
  "executiveSummary": "3-4 sentence summary of the migration scope and readiness",
  "preMigrationChecklist": [
    "Actionable checklist item 1",
    "Actionable checklist item 2"
  ],
  "mappingSpecification": [
    {
      "sourceTable": "source_table_name",
      "targetTable": "target_table_name",
      "fieldCount": 10,
      "keyTransformations": ["Description of key transform 1"],
      "unmappedFields": ["field_name_1"]
    }
  ],
  "transformationRules": [
    {
      "targetField": "target_table.field_name",
      "sourceField": "source_table.field_name",
      "ruleDescription": "Plain language description of the transformation",
      "valueMappingTable": [
        { "source": "Source Value", "target": "Target Code" }
      ]
    }
  ],
  "dataQualityAssessment": {
    "totalIssuesFound": ${qIssues.length},
    "issuesFixed": ${issuesFixed},
    "issuesAcceptedRisk": ${issuesAcceptedRisk},
    "issuesRemaining": ${issuesOpen},
    "blockingRemaining": ${openBlocking},
    "summaryNarrative": "2-3 sentence narrative of overall data quality",
    "keyFindings": ["Finding 1", "Finding 2"]
  },
  "executionPlan": [
    {
      "stepNumber": 1,
      "title": "Step title",
      "description": "What to do in this step. Reference the Execution Package .sql file sections where applicable.",
      "verificationCriteria": ["What to check before moving on"]
    }
  ],
  "validationCriteria": [
    {
      "criterion": "Record Count Reconciliation",
      "threshold": "Source count (post-filter) = Target count ±0.5%",
      "passCondition": "All tables within threshold"
    }
  ],
  "rollbackProcedure": "2-3 sentence procedure referencing the Execution Package rollback section"
}

For preMigrationChecklist: provide 8-12 actionable items.
For mappingSpecification: include ALL ${approvedTMs.length} table mappings. For keyTransformations, list the 2-4 most significant transforms per table. For unmappedFields, list any source fields that are not being migrated.
For transformationRules: include ALL transformations that involve value mapping, type conversion, or significant business logic. SKIP simple direct-copy mappings with no logic. Include valueMappingTable only for CASE-WHEN style value translations.
For executionPlan: provide 6-8 steps covering pre-checks, extract, transform/load per table group, post-load validation, business validation, and sign-off.
For validationCriteria: provide 5-8 criteria covering record counts, FK integrity, picklist validation, aggregate reconciliation, null checks.

## Project Data
Project: ${project.name}
Source: ${srcDs?.name ?? 'Unknown'} (${srcTables.length} tables, ${totalSourceRecords.toLocaleString()} source records)
Target: ${tgtDs?.name ?? 'Unknown'} (${tgtTables.length} tables)

## Approved Mappings (${approvedTMs.length} table mappings, ${fms.length} field mappings)
${mappingBlock || '(no mappings)'}

## Transformations (${allTransforms.length} total)
${transformBlock || '(none)'}

## Quality Issues Summary
- Total detected: ${qIssues.length}
- Fixed: ${issuesFixed}
- Accepted risk: ${issuesAcceptedRisk}
- Open blocking: ${openBlocking}
- Open warnings: ${openWarnings}

${blockingDetail ? 'Open Blocking Issues:\n' + blockingDetail : ''}

## Business Rules
${businessRules || '(no documentation uploaded)'}

## Target Table Load Order
${loadOrderText || '(no target tables)'}`

  // ── Claude call ────────────────────────────────────────────────────────────
  let rawResponse: string
  try {
    rawResponse = await callClaude(RUNBOOK_SYSTEM_PROMPT, userMessage, 8000)
  } catch {
    return { success: false, error: 'AI content generation failed. Please try again.' }
  }

  // ── Parse Claude JSON response ─────────────────────────────────────────────
  let claudeContent: Omit<
    RunbookData,
    | 'projectName'
    | 'sourceSystemName'
    | 'targetSystemName'
    | 'generatedAt'
    | 'totalSourceRecords'
    | 'totalSourceTables'
    | 'totalTargetTables'
    | 'totalFieldMappings'
    | 'totalTransformations'
    | 'migrationReadinessPercent'
    | 'loadOrder'
  >

  try {
    const cleaned = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
    claudeContent = JSON.parse(cleaned)
  } catch (parseErr) {
    console.error('[migration-runbook] JSON parse failed:', parseErr, '\nRaw:', rawResponse.slice(0, 500))
    return { success: false, error: 'AI returned invalid JSON. Please try again.' }
  }

  // ── Assemble full RunbookData ──────────────────────────────────────────────
  const runbookData: RunbookData = {
    projectName: project.name,
    sourceSystemName: srcDs?.name ?? 'Source System',
    targetSystemName: tgtDs?.name ?? 'Target System',
    generatedAt: new Date().toISOString(),
    totalSourceRecords,
    totalSourceTables: srcTables.length,
    totalTargetTables: tgtTables.length,
    totalFieldMappings: fms.length,
    totalTransformations: allTransforms.length,
    migrationReadinessPercent: readinessScore,
    loadOrder,
    executiveSummary: claudeContent.executiveSummary ?? '',
    preMigrationChecklist: claudeContent.preMigrationChecklist ?? [],
    mappingSpecification: claudeContent.mappingSpecification ?? [],
    transformationRules: claudeContent.transformationRules ?? [],
    dataQualityAssessment: claudeContent.dataQualityAssessment ?? {
      totalIssuesFound: qIssues.length,
      issuesFixed,
      issuesAcceptedRisk,
      issuesRemaining: issuesOpen,
      blockingRemaining: openBlocking,
      summaryNarrative: '',
      keyFindings: [],
    },
    executionPlan: claudeContent.executionPlan ?? [],
    validationCriteria: claudeContent.validationCriteria ?? [],
    rollbackProcedure: claudeContent.rollbackProcedure ?? '',
  }

  // ── Build docx ─────────────────────────────────────────────────────────────
  let docxBuffer: Buffer
  try {
    docxBuffer = await buildMigrationRunbook(runbookData)
  } catch (docErr) {
    console.error('[migration-runbook] docx build failed:', docErr)
    return { success: false, error: 'Failed to build Word document. Please try again.' }
  }

  // ── Upload to storage ──────────────────────────────────────────────────────
  const { data: existingOutput } = await supabaseAdmin
    .from('outputs')
    .select('version')
    .eq('project_id', projectId)
    .eq('type', 'migration_runbook')
    .eq('format', 'docx')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const nextVer = existingOutput
    ? (() => {
        const parts = existingOutput.version.split('.')
        return `${parts[0]}.${parseInt(parts[1] ?? '0', 10) + 1}`
      })()
    : '1.0'

  const storagePath = `${user.id}/${projectId}/runbook/migration_runbook_v${nextVer}.docx`

  await supabaseAdmin.storage.from('project-files').upload(storagePath, docxBuffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    upsert: true,
  })

  const { data: signed } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(storagePath, 3600)

  await supabaseAdmin.from('outputs').insert({
    project_id: projectId,
    type: 'migration_runbook',
    format: 'docx',
    version: nextVer,
    file_storage_path: storagePath,
  })

  return {
    success: true,
    downloadUrl: signed?.signedUrl ?? '',
    version: nextVer,
  }
}

// ── getMigrationRunbookUrl ────────────────────────────────────────────────────

export async function getMigrationRunbookUrl(projectId: string): Promise<{
  url?: string
  version?: string
  generatedAt?: string
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return { error: 'Access denied' }

  const { data: output } = await supabaseAdmin
    .from('outputs')
    .select('id, version, generated_at, file_storage_path')
    .eq('project_id', projectId)
    .eq('type', 'migration_runbook')
    .eq('format', 'docx')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!output?.file_storage_path) return { error: 'No runbook found for this project' }

  const { data: signed } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(output.file_storage_path, 3600)

  return {
    url: signed?.signedUrl,
    version: output.version,
    generatedAt: output.generated_at,
  }
}
