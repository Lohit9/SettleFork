'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callLLM } from '@/lib/ai/llm-client'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildMigrationRunbook } from '@/lib/reports/migration-runbook-docx'
import type { RunbookData } from '@/lib/reports/migration-runbook-docx'
import { computeReadinessScore } from '@/lib/quality/readiness-score'

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

// Guard-wiring decision (Prompt 3d, Step 3D-10, Gate 2 §1.9):
// `generateMigrationRunbook` writes to `outputs` and to Supabase
// storage only — NOT to any mapping-shape table (target_field_mappings /
// mapping_sources / transformations / table_mappings). Per the Gate 2
// guard-wiring policy, only functions that mutate mapping shape need
// `assertMappingWritesEnabled` guards; this function is out of scope
// for that guard and intentionally does not call it. It is safe to
// run while mapping writes are disabled (maintenance_mode=true).
export async function generateMigrationRunbook(
  projectId: string
): Promise<{ success: boolean; downloadUrl?: string; version?: string; error?: string }> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  // ── Access check ────────────────────────────────────────────────────────────
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
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

  // ── Parallel data fetch (hop 2) ─────────────────────────────────────────────
  //
  // NEW-MODEL NOTE (Prompt 3d, Step 3D-10, Gate 2 §1.9): the legacy
  // per-TM `.from('field_mappings')` query is replaced with a project-
  // scoped `target_field_mappings` fetch that nests `mapping_sources`
  // and `target_field`. Per Q3 decision, the TFM+MS graph is then
  // FLATTENED into an array of FM-shaped rows — one row per primary
  // MS, one row per contributor MS, one row per value assignment.
  // This keeps byte-for-byte parity with legacy semantics:
  //   (a) `fms.length` counts each contributor independently (matches
  //       the legacy "${fms.length} field mappings" text in the user
  //       prompt AND the `totalFieldMappings` field persisted to the
  //       runbook docx).
  //   (b) `mappingBlock` emits one line per primary + one line per
  //       contributor — the "src (type) → tgt (type)" shape contributors
  //       rendered on in legacy.
  //
  // Legacy did NOT filter FM.status (rejected FMs were included in
  // counts and mapping blocks), so we DO NOT add a `.neq('status',
  // 'rejected')` filter here — preservation trumps hygiene for the
  // runbook content, which is a downstream artifact of the approved
  // TM set.
  //
  // ── DESIGN PATTERN: CONTRIBUTOR SENTINEL IDS ────────────────────
  // Mapped-case contributor flat-rows receive a SENTINEL id of the
  // form `${tfm.id}:contrib:${ordinal}` (never a UUID, never a real
  // TFM id). The downstream transformation lookup map is keyed by
  // real TFM ids, so `transformByTfmId.get(flat.id)` naturally
  // returns undefined for contributor flat-rows — the "Transform:"
  // tag therefore renders exactly once per multi-source mapping
  // (on the primary row), matching legacy where only the primary
  // FM had a transformations row. Same pattern used in 3D-9
  // (migration-intelligence.ts). Prefer this over a branching
  // `is_primary` flag: downstream render/lookup code needs zero
  // changes, and the sentinel is self-documenting.
  // ─────────────────────────────────────────────────────────────────
  const [{ data: allTables }, tfmResult] = await Promise.all([
    supabaseAdmin.from('tables').select('id, name, dataset_id, row_count').in('id', allTableIds),
    supabaseAdmin
      .from('target_field_mappings')
      .select(
        `
        id,
        needs_transformation,
        combination_type,
        va_dismissed,
        target_field:fields!target_field_id (
          id, name, data_type, is_foreign_key, fk_reference, table_id
        ),
        mapping_sources (
          id, ordinal, source_field_id, source_table_id,
          source_field:fields!source_field_id (
            id, name, data_type
          )
        )
        `
      )
      .eq('project_id', projectId),
  ])

  const tables = allTables ?? []

  // ── Flatten TFM+MS into FM-shaped rows (Q3 preserves N-row output) ──────────
  type SrcEmbed = { id: string; name: string; data_type: string }
  type TgtEmbed = {
    id: string
    name: string
    data_type: string
    is_foreign_key: boolean
    fk_reference: string | null
    table_id: string
  }
  type MsEmbed = {
    id: string
    ordinal: number
    source_field_id: string | null
    source_table_id: string | null
    source_field: SrcEmbed | SrcEmbed[] | null
  }
  type TfmRow = {
    id: string
    needs_transformation: boolean | null
    combination_type: string | null
    va_dismissed: boolean | null
    target_field: TgtEmbed | TgtEmbed[] | null
    mapping_sources: MsEmbed[] | null
  }
  type FlatMappingRow = {
    id: string
    tfm_id: string
    table_mapping_id: string
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

  const fms: FlatMappingRow[] = []
  for (const tfm of tfms) {
    const tgt = pickOne(tfm.target_field)
    if (!tgt) continue
    const msAll = [...(tfm.mapping_sources ?? [])].sort((a, b) => a.ordinal - b.ordinal)
    const primary = msAll[0] ?? null
    const isVA = msAll.length === 0 && tfm.combination_type === 'custom_sql'
    const isBareAck = msAll.length === 0 && !isVA
    if (isBareAck) continue
    // Migration 077: dismissed VAs ("no value needed") are skipped so the
    // generated runbook accurately reports the rows it will load, matching
    // execution-package and outputs-helpers semantics exactly.
    if (isVA && tfm.va_dismissed === true) continue

    // Owning-TM rule: target_field.table_id == tm.target_table_id AND
    //   mapped case: primary MS source_table_id == tm.source_table_id
    //   VA case:     any tm with matching target_table_id (first match)
    const owningTm = approvedTMs.find((tm) => {
      if (tm.target_table_id !== tgt.table_id) return false
      if (isVA) return true
      if (!primary) return false
      return primary.source_table_id === tm.source_table_id
    })
    if (!owningTm) continue

    if (isVA) {
      fms.push({
        id: tfm.id,
        tfm_id: tfm.id,
        table_mapping_id: owningTm.id,
        needs_transformation: tfm.needs_transformation,
        source_field_id: null,
        source_field: null,
        target_field: tgt,
        is_contributor: false,
      })
      continue
    }

    for (const ms of msAll) {
      const isPrimary = ms.ordinal === 0
      fms.push({
        // Sentinel id for contributors (see DESIGN PATTERN header above).
        id: isPrimary ? tfm.id : `${tfm.id}:contrib:${ms.ordinal}`,
        tfm_id: tfm.id,
        table_mapping_id: owningTm.id,
        // `needs_transformation` lives on TFM only (migration 075);
        // surface the same TFM-level flag on every flat row.
        needs_transformation: tfm.needs_transformation,
        source_field_id: ms.source_field_id,
        source_field: pickOne(ms.source_field),
        target_field: tgt,
        is_contributor: !isPrimary,
      })
    }
  }

  // ── Parallel data fetch (hop 3) ─────────────────────────────────────────────
  // Transformations scoped by target_field_mapping_id (column rename).
  const [{ data: transformations }, { data: targetFieldsFull }] = await Promise.all([
    tfmIds.length > 0
      ? supabaseAdmin
          .from('transformations')
          .select('target_field_mapping_id, description, generated_sql, status')
          .in('target_field_mapping_id', tfmIds)
      : Promise.resolve({ data: [] }),
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
  // Keyed by real TFM id. Contributor flat-rows carry sentinel ids and
  // will therefore miss this map by design (see DESIGN PATTERN header).
  const transformByTfmId = new Map(allTransforms.map((t) => [t.target_field_mapping_id, t]))

  // ── Compute stats ──────────────────────────────────────────────────────────
  const srcTables = tables.filter((t) => t.dataset_id === srcDs?.id)
  const tgtTables = tables.filter((t) => t.dataset_id === tgtDs?.id)
  const tableById = new Map(tables.map((t) => [t.id, t]))

  const totalSourceRecords = srcTables.reduce((s, t) => s + (t.row_count ?? 0), 0)
  const openBlocking = (qualityIssues ?? []).filter((q) => q.severity === 'blocking' && q.status === 'open').length
  const openWarnings = (qualityIssues ?? []).filter((q) => q.severity === 'warning' && q.status === 'open').length

  // Single source of truth: delegate to the shared readiness helper so the
  // runbook's migrationReadinessPercent matches the Migration Center card.
  const readiness = await computeReadinessScore(projectId)
  const readinessScore = readiness.score

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
      const tgtF = fm.target_field as unknown as { name: string; data_type: string } | null
      if (!tgtF) continue
      const srcF = fm.source_field as unknown as { name: string; data_type: string } | null
      const srcLabel =
        fm.source_field_id == null
          ? '[Value Assignment]'
          : srcF
            ? `${srcF.name} (${srcF.data_type})`
            : null
      if (srcLabel === null) continue
      // Contributor flat-rows carry sentinel ids (see DESIGN PATTERN
      // header above); .get() therefore misses by design, rendering
      // the Transform tag exactly once per multi-source mapping —
      // legacy parity.
      const t = transformByTfmId.get(fm.id)
      const xform = t ? ` | Transform: ${t.description ?? t.generated_sql?.slice(0, 60) ?? 'yes'}` : ''
      mappingBlock += `  ${srcLabel} → ${tgtF.name} (${tgtF.data_type})${xform}\n`
    }
  }

  // Transforms summary
  const transformBlock = allTransforms
    .filter((t) => t.generated_sql)
    .slice(0, 30)
    .map((t) => {
      // Resolves to the primary (or VA) flat row — its id is the real
      // TFM id; contributor sentinels never collide.
      const fm = fms.find((f) => f.id === t.target_field_mapping_id)
      const src = !fm
        ? '?'
        : fm.source_field_id == null
          ? '[Value Assignment]'
          : (fm.source_field as unknown as { name: string } | null)?.name ?? '?'
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
    const result = await callLLM({
      feature: 'outputs_migration_runbook',
      systemPrompt: RUNBOOK_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 8000,
      projectId,
      userId: user.id,
      promptVersion: 'migration-runbook-v1',
      abuseUserId: user.id,
    })
    rawResponse = result.text
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
