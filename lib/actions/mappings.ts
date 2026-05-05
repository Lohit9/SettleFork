'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { callLLM, type LLMFeature } from '@/lib/ai/llm-client'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'
// PR 3.4cd — single-agent + multi-agent pipeline helpers.
import { runSingleAgentMappingLoop } from '@/lib/ai/single-agent-mapping'
import { runMultiAgentMappingPipeline } from '@/lib/ai/multi-agent-orchestrator'
import {
  EMIT_TABLE_MAPPINGS_TOOL,
  EMIT_FIELD_MAPPINGS_TOOL,
} from '@/lib/ai/tool-schemas'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import {
  buildAIContext,
  formatSchemaForPrompt,
  formatDocumentsForPrompt,
  formatSchemaOverviewBlock,
} from '@/lib/ai/context-builder'
import { logActivity } from '@/lib/actions/activity-log'
import { logAIEdit } from '@/lib/actions/ai-edit-history'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { computeOrphanedTfmsForTmDelete } from '@/lib/mappings/tm-ownership'
import {
  resetFieldTransform,
  resetAllTransformsForTable,
  checkFieldMappingHasTransform,
} from '@/lib/actions/transformations'
import {
  ShimError,
  decodeShimmedRowId,
  shimToMappingsResult,
  type ShimDatasetRow,
  type ShimFieldRow,
  type ShimInput,
  type ShimTableMappingRow,
  type ShimTableRow,
  type ShimTransformationRow,
} from '@/lib/compat/mapping-shim'
import type {
  MappingSourceRow,
  SourceFieldAcknowledgmentRow,
  TargetFieldMappingRow,
} from '@/lib/types/mapping-redesign'
import {
  MAPPING_GENERATION_SYSTEM_PROMPT,
  bareTableName,
  buildMappingUserMessage,
  parseClaudeJSON,
  persistClaudeFieldMappingsForTM,
  readBusinessContext,
  runMappingGeneration,
  type ClaudeFieldMapping,
  type ClaudeResponse,
} from '@/lib/ai/mapping-engine'

// ─── Type re-exports (preserve consumer import paths) ────────────────────────
//
// Every UI-consumed mapping shape was previously defined inline here. To keep
// `lib/compat/mapping-shim.ts` free of the `'use server'` boundary we moved
// them to `@/lib/types/mappings-ui`, then re-export from this module so that
// consumers (MappingContent.tsx, page.tsx, drawers, etc.) continue importing
// via `@/lib/actions/mappings` unchanged.

export type {
  RichFieldMapping,
  RichTableMapping,
  UnmappedField,
  SimpleField,
  FieldAcknowledgmentRow,
  MappingsResult,
} from '@/lib/types/mappings-ui'
import type {
  MappingsResult,
  SimpleField,
  UnmappedField,
} from '@/lib/types/mappings-ui'

// Out-of-scope compat re-export. Prompt 3b will flip the implementation to
// address target_field_mappings directly; the signature is preserved so the
// MappingContent drawer keeps working.
export { checkFieldMappingHasTransform }

// ─── Guard wiring helper ──────────────────────────────────────────────────────
//
// Converts `assertMappingWritesEnabled` throws into structured
// `{ success: false, error, errorCode: 'MAINTENANCE_MODE' }` responses.
// Every write path in this module threads its body through `guardWrites`
// so guard failures surface as consistent structured results rather than
// 500-level exceptions bubbling to the client. Throws from `body` that
// are NOT the guard error propagate unchanged — we only intercept the
// guard's sentinel message.

const MAINTENANCE_GUARD_MESSAGE =
  'Mapping writes are temporarily disabled for scheduled maintenance'

export type MappingWriteErrorCode =
  | 'MAINTENANCE_MODE'
  | 'TARGET_CONFLICT'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INTERNAL'

async function guardWrites<T extends { success: boolean; error?: string; errorCode?: MappingWriteErrorCode }>(
  projectId: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === MAINTENANCE_GUARD_MESSAGE) {
      return {
        success: false,
        error: MAINTENANCE_GUARD_MESSAGE,
        errorCode: 'MAINTENANCE_MODE',
      } as T
    }
    // "Project not found" from the guard — fold into NOT_FOUND.
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    } as T
  }
  return body()
}

// ─── runMappingGenerationForPair (regenerate single TM) ───────────────────────
//
// Exported (Phase 1 PR 10.4) so the eval harness in lib/eval/runner.ts can
// invoke the exact same code path production uses. Production callers
// should NOT import this directly — they call the public
// `regenerateFieldMappings` / `generateMappings` server actions which
// wrap this with permission checks, status updates, and activity logs.
//
// `featureOverride` (Phase 1 PR 10.4): when provided, replaces the
// default `mapping_generate_legacy_pair` feature value passed to
// callLLM (and the matching `_repair` value on the JSON-repair retry).
// Used by the eval runner to write llm_calls rows tagged
// `eval_mapping` so they're filtered out of the production cost
// report. Production callers omit this and continue to log under the
// canonical feature taxonomy.

export async function runMappingGenerationForPair(args: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  projectId: string
  tableMappingId: string
  sourceTableId: string
  targetTableId: string
  featureOverride?: LLMFeature
}): Promise<{ inserted: number; error?: string }> {
  const { supabase, userId, projectId, tableMappingId, sourceTableId, targetTableId, featureOverride } = args

  try {
    const [{ data: sourceTables, error: stErr }, { data: targetTables, error: ttErr }] = await Promise.all([
      supabase.from('tables').select('id, name').eq('id', sourceTableId),
      supabase.from('tables').select('id, name').eq('id', targetTableId),
    ])
    if (stErr) return { inserted: 0, error: stErr.message }
    if (ttErr) return { inserted: 0, error: ttErr.message }
    if (!sourceTables?.length || !targetTables?.length) {
      return { inserted: 0, error: 'Source or target table not found' }
    }

    const [{ data: sourceFields, error: sfErr }, { data: targetFields, error: tfErr }] = await Promise.all([
      supabase
        .from('fields')
        .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
        .eq('table_id', sourceTableId)
        .order('ordinal_position', { ascending: true }),
      supabase
        .from('fields')
        .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
        .eq('table_id', targetTableId)
        .order('ordinal_position', { ascending: true }),
    ])
    if (sfErr) return { inserted: 0, error: sfErr.message }
    if (tfErr) return { inserted: 0, error: tfErr.message }

    // PR 3.4b — Phase 3 agent-loop adoption gate. Default OFF preserves
    // heritage flag-OFF byte-identical behavior. Flag-ON: aiCtx uses
    // per-role sample bumps + the gate routes through runAgentLoop.
    const phase3Enabled = process.env.AI_PHASE_3_ENABLED === '1'
    // PR 3.4cd — second-level gate (multi-agent pipeline).
    const multiAgentEnabled = process.env.AI_PHASE_3_MULTI_AGENT_ENABLED === '1'

    const aiCtx = await buildAIContext(
      projectId,
      {
        tableIds: [sourceTableId, targetTableId],
        includeProfilingStats: true,
        includeValueDistributions: true,
        includeSampleValues: true,
        includeDocuments: true,
        maxDistributionValues: 15,
        maxSampleValues: 5,
        // PR 3.4b — agent path uses asymmetric per-role sample budgets
        // (LOCK #5/#6/#7). Spread is empty under flag-OFF → byte-identical.
        ...(phase3Enabled && { maxSourceSampleValues: 50, maxTargetSampleValues: 30 }),
      },
      userId,
      // Phase 1 PR 10.4: thread the caller's supabase client through so
      // the eval CLI can drive this path without a Next.js request
      // scope. Production callers receive `await createClient()` (the
      // RLS-aware client) via `regenerateFieldMappings`; this keeps
      // that semantic.
      supabase,
    )

    const sourceCtx = aiCtx.source_tables[0]
    if (!sourceCtx) {
      return { inserted: 0, error: 'Source table context could not be built' }
    }

    const sourceSection = formatSchemaForPrompt([sourceCtx], 'source')
    const targetSection = formatSchemaForPrompt(aiCtx.target_tables, 'target')
    const docBlock = formatDocumentsForPrompt(aiCtx.documents)
    const userMessage = buildMappingUserMessage({
      sourceSection,
      targetSection,
      docBlock,
      intelligenceCtx: aiCtx.intelligence_context ?? null,
    })

    // PR 3.4b — agent-mode preludes (read once before the callLLM/agent
    // gate). Both null/empty under flag-OFF.
    const businessContext = phase3Enabled
      ? await readBusinessContext(supabase, projectId)
      : null
    const schemaOverviewBlock = phase3Enabled ? formatSchemaOverviewBlock(aiCtx) : ''

    const PER_BATCH_MAX_TOKENS = 16000

    // PR 12 H1: tool use under flag ON; legacy text + parseClaudeJSON +
    // repair-retry under flag OFF. The legacy branch is preserved
    // verbatim so heritage byte-identical fingerprints hold.
    const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
    let primaryResult: Awaited<ReturnType<typeof callLLM>>
    if (phase3Enabled) {
      // PR 3.4cd — two-level gate. Multi-agent pipeline opt-in via
      // AI_PHASE_3_MULTI_AGENT_ENABLED=1; otherwise PR 3.4b single-agent
      // path (extracted to runSingleAgentMappingLoop helper, byte-equivalent).
      const baseMetadata = {
        source_table_id: sourceTableId,
        target_table_id: targetTableId,
        table_mapping_id: tableMappingId,
      }
      if (multiAgentEnabled) {
        // PR 3.4cd multi-agent pipeline (commit 2 SHELL — see
        // multi-agent-orchestrator.ts; voting + telemetry in commit 3).
        // Single-pair specifics: no other_source_tables block (it's a
        // single pair); no cacheControl (LOCK #4 / PR 13.1 audit posture).
        const unmappedTargetFieldNames = (targetFields ?? [])
          .filter((f) => f.table_id === targetTableId)
          .map((f) => f.name)
        const r = await runMultiAgentMappingPipeline({
          supabase,
          projectId,
          userId,
          feature: featureOverride ?? 'mapping_generate_legacy_pair',
          baseUserMessage: userMessage,
          schemaOverviewBlock,
          businessContext,
          maxTokens: PER_BATCH_MAX_TOKENS,
          baseMetadata: { ...baseMetadata, multi_agent: true },
          cacheControl: false,
          unmappedTargetFields: unmappedTargetFieldNames,
        })
        if (r.kind === 'pair_aborted') {
          const msg = `Multi-agent pair aborted: ${r.reason} — ${r.message}`
          console.error(`[Mapping] ${msg}`)
          return { inserted: 0, error: msg }
        }
        primaryResult = r.result
      } else {
        // PR 3.4b single-agent path — extracted to helper, byte-equivalent.
        const r = await runSingleAgentMappingLoop({
          supabase,
          projectId,
          userId,
          feature: featureOverride ?? 'mapping_generate_legacy_pair',
          baseUserMessage: userMessage,
          schemaOverviewBlock,
          businessContext,
          maxTokens: PER_BATCH_MAX_TOKENS,
          baseMetadata,
          cacheControl: false,
        })
        if (r.kind === 'agent_threw') {
          console.error(`[Mapping] Agent loop failed for pair ${sourceTables[0].name} → ${targetTables[0].name}:`, r.error)
          return { inserted: 0, error: r.error instanceof Error ? r.error.message : 'Agent loop failed' }
        }
        if (r.kind === 'fallback_threw') {
          console.error(`[Mapping] Schema-error fallback failed:`, r.error)
          return { inserted: 0, error: r.error instanceof Error ? r.error.message : 'Fallback failed' }
        }
        if (r.kind === 'aborted_other') {
          const msg = `Agent aborted: ${r.reason} — ${r.message}`
          console.error(`[Mapping] ${msg}`)
          return { inserted: 0, error: msg }
        }
        primaryResult = r.result
      }
    } else {
      try {
        primaryResult = await callLLM({
          // featureOverride lets the eval runner tag this call as
          // `eval_mapping` so it's excluded from the production cost
          // report. Production callers omit it and the canonical feature
          // taxonomy is preserved.
          feature: featureOverride ?? 'mapping_generate_legacy_pair',
          systemPrompt: withProvenanceGuidance(MAPPING_GENERATION_SYSTEM_PROMPT),
          userMessage,
          maxTokens: PER_BATCH_MAX_TOKENS,
          projectId,
          userId,
          promptVersion: 'mapping-v1',
          abuseUserId: userId,
          metadata: {
            source_table_id: sourceTableId,
            target_table_id: targetTableId,
            table_mapping_id: tableMappingId,
          },
          ...(phase2Enabled && { tool: EMIT_TABLE_MAPPINGS_TOOL }),
        })
      } catch (err) {
        console.error(`[Mapping] Claude call failed for pair ${sourceTables[0].name} → ${targetTables[0].name}:`, err)
        return { inserted: 0, error: err instanceof Error ? err.message : 'Claude call failed' }
      }
    }

    // primaryCallId is used downstream by logAIEdit for provenance
    // chaining — keep it at function scope so the post-persist provenance
    // emit (around line 356) can reference it under both branches.
    const primaryCallId = primaryResult.callId

    let parsedResponse: ClaudeResponse
    if (primaryResult.kind === 'toolUse') {
      // PR 12 flag-ON: schema-validated tool input; the
      // `mapping_generate_legacy_pair_repair` retry below is dead on
      // this branch (no parse failure mode to recover from).
      parsedResponse = primaryResult.toolUse.input as unknown as ClaudeResponse
    } else {
      // PR 12 flag-OFF: legacy parseClaudeJSON + repair-retry.
      const raw = primaryResult.text
      try {
        parsedResponse = parseClaudeJSON(raw)
      } catch {
        try {
          const retryResult = await callLLM({
            // Per the PR 10.4 decision: when the override is set, the
            // JSON-repair retry rolls up under the SAME eval feature
            // (eval_mapping) — eval treats primary+repair as one logical
            // call. Production callers continue to log under the
            // canonical _repair feature taxonomy.
            feature: featureOverride ?? 'mapping_generate_legacy_pair_repair',
            systemPrompt: 'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
            userMessage: `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${raw}`,
            maxTokens: PER_BATCH_MAX_TOKENS,
            projectId,
            userId,
            promptVersion: 'mapping-repair-v1',
            parentCallId: primaryCallId,
            abuseUserId: userId,
          })
          // The retry runs on the legacy text path (no tool passed)
          // so the result is always { kind: 'text', text }; the
          // discriminator narrowing is required for tsc.
          if (retryResult.kind !== 'text') {
            throw new Error('Unexpected toolUse on mapping_generate_legacy_pair_repair retry')
          }
          parsedResponse = parseClaudeJSON(retryResult.text)
        } catch (retryErr) {
          console.error(`[Mapping] Failed to parse response for pair after retry:`, retryErr)
          return { inserted: 0, error: 'AI returned invalid response. Please try again.' }
        }
      }
    }

    const srcFieldMap = new Map((sourceFields ?? []).map((f) => [f.name.toLowerCase(), f]))
    const tgtFieldMap = new Map((targetFields ?? []).map((f) => [f.name.toLowerCase(), f]))
    const srcTableKey = sourceTables[0].name.toLowerCase()
    const tgtTableKey = targetTables[0].name.toLowerCase()

    let totalInserted = 0
    // Capture the time before persistence starts so the post-call SELECT
    // for provenance only picks up TFMs THIS call created. Concurrent
    // generations on the same TM are gated by guardWrites at the caller,
    // so the time-window approach is safe in practice.
    const persistStartIso = new Date().toISOString()
    for (const tm of parsedResponse.table_mappings ?? []) {
      if (!tm.source_table || !tm.target_table) continue
      if (bareTableName(tm.source_table) !== srcTableKey || bareTableName(tm.target_table) !== tgtTableKey) {
        console.warn(`[mappings] Skipping unexpected TM in single-pair response: "${tm.source_table}" → "${tm.target_table}"`)
        continue
      }
      const { inserted } = await persistClaudeFieldMappingsForTM({
        supabase,
        projectId,
        tableMappingId,
        sourceFieldMap: srcFieldMap,
        targetFieldMap: tgtFieldMap,
        fieldMappings: tm.field_mappings ?? [],
        sourceTableId,
      })
      totalInserted += inserted
    }

    // Provenance: the persistence path runs through dq_create_target_field_mapping
    // (RPC) — not a direct .from('target_field_mappings').insert(...) — so the
    // audit invariant test does not require this site to call logAIEdit.
    // We emit anyway, anchored on the just-created TFMs found via a
    // post-persist SELECT scoped to (project_id, table_mapping_id, time
    // window). Engine-level callId chaining is a deliberate follow-up.
    if (totalInserted > 0) {
      const { data: createdTfms } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, target_field_id, confidence, ai_reasoning')
        .eq('project_id', projectId)
        .gte('created_at', persistStartIso)
      const createdMappingSources = await supabaseAdmin
        .from('mapping_sources')
        .select('target_field_mapping_id')
        .eq('source_table_id', sourceTableId)
        .gte('created_at', persistStartIso)
      const tfmIdsWithSources = new Set(
        (createdMappingSources.data ?? []).map(
          (r) => (r as { target_field_mapping_id: string }).target_field_mapping_id,
        ),
      )
      for (const tfm of createdTfms ?? []) {
        // Only emit for TFMs that have a source linking back to this TM's
        // source_table — filters out unrelated concurrent inserts.
        if (!tfmIdsWithSources.has(tfm.id)) continue
        void logAIEdit({
          projectId,
          actorId: userId,
          entityType: 'target_field_mapping',
          entityId: tfm.id,
          fieldPath: 'confidence',
          oldValue: null,
          newValue: {
            confidence: tfm.confidence,
            ai_reasoning: tfm.ai_reasoning,
            target_field_id: tfm.target_field_id,
          },
          editKind: 'ai_proposed',
          llmCallId: primaryCallId,
          metadata: {
            source_table_id: sourceTableId,
            target_table_id: targetTableId,
            table_mapping_id: tableMappingId,
          },
        })
      }
    }

    return { inserted: totalInserted }
  } catch (err) {
    console.error('runMappingGenerationForPair error:', err)
    return { inserted: 0, error: err instanceof Error ? err.message : 'Mapping generation failed' }
  }
}

// ─── generateMappings ─────────────────────────────────────────────────────────

export async function generateMappings(
  projectId: string,
  sourceTableIds: string[],
  targetTableIds: string[],
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode; generated?: number; skipped?: number; message?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(projectId, async () => {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .single()
    if (!project) return { success: false, error: 'Project not found', errorCode: 'NOT_FOUND' }

    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) return { success: false, error: rateLimit.error, errorCode: 'VALIDATION' }

    if (!sourceTableIds.length || !targetTableIds.length) {
      return { success: false, error: 'Select at least one source and one target table', errorCode: 'VALIDATION' }
    }

    const { data: existingMappingPairs } = await supabase
      .from('table_mappings')
      .select('source_table_id, target_table_id')
      .eq('project_id', projectId)

    const existingPairSet = new Set(
      (existingMappingPairs ?? []).map((m) => `${m.source_table_id}::${m.target_table_id}`),
    )

    return runMappingGeneration(supabase, user.id, projectId, sourceTableIds, targetTableIds, existingPairSet)
  })
}

// ─── getMappings (read path via shim) ────────────────────────────────────────

export async function getMappings(projectId: string): Promise<MappingsResult | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return null

  // Hop 2: project-scoped parallel fetch.
  const [
    { data: allDatasets },
    { data: rawTMs },
    { data: rawTFMs },
    { data: rawSourceAcks },
  ] = await Promise.all([
    supabase.from('datasets').select('id, name, role').eq('project_id', projectId),
    supabase
      .from('table_mappings')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabase
      .from('target_field_mappings')
      .select('*')
      .eq('project_id', projectId),
    supabase
      .from('source_field_acknowledgments')
      .select('*')
      .eq('project_id', projectId),
  ])

  const datasetIds = (allDatasets ?? []).map((d) => d.id)
  const tfmIds = (rawTFMs ?? []).map((r) => r.id)

  // Hop 3: dataset-scoped + tfm-scoped fetches.
  const [{ data: allTables }, { data: rawMappingSources }] = await Promise.all([
    supabase
      .from('tables')
      .select('id, name, dataset_id, row_count')
      .in('dataset_id', datasetIds.length ? datasetIds : ['__none__']),
    supabase
      .from('mapping_sources')
      .select('*')
      .in(
        'target_field_mapping_id',
        tfmIds.length ? tfmIds : ['__none__'],
      )
      .order('ordinal', { ascending: true }),
  ])

  const tableIds = (allTables ?? []).map((t) => t.id)

  // Hop 4: fields + transformations bound to TFMs.
  const [{ data: allFields }, { data: rawTransformations }] = await Promise.all([
    supabase
      .from('fields')
      .select(
        'id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, ordinal_position, default_value, field_profiles(field_id, sample_values, null_percentage)',
      )
      .in('table_id', tableIds.length ? tableIds : ['__none__'])
      .order('ordinal_position', { ascending: true }),
    tfmIds.length > 0
      ? supabase
          .from('transformations')
          .select('id, target_field_mapping_id, status, description, generated_sql')
          .in('target_field_mapping_id', tfmIds)
      : Promise.resolve({ data: [] as ShimTransformationRow[] }),
  ])

  // ─── Build indexes for the shim ────────────────────────────────────────────
  const datasetsById: Record<string, ShimDatasetRow> = {}
  for (const d of allDatasets ?? []) datasetsById[d.id] = { id: d.id, name: d.name, role: d.role }

  const tablesById: Record<string, ShimTableRow> = {}
  for (const t of allTables ?? []) tablesById[t.id] = { id: t.id, name: t.name, dataset_id: t.dataset_id }

  const fieldsById: Record<string, ShimFieldRow> = {}
  const fieldSamples: Record<string, string[]> = {}
  const fieldNullPercentages: Record<string, number> = {}
  for (const f of allFields ?? []) {
    fieldsById[f.id] = {
      id: f.id,
      name: f.name,
      data_type: f.data_type,
      table_id: f.table_id,
      inferred_type: f.inferred_type,
      is_nullable: f.is_nullable ?? true,
      default_value: (f as { default_value?: string | null }).default_value ?? null,
    }
    const profile = Array.isArray(f.field_profiles) ? f.field_profiles[0] : null
    if (profile?.sample_values) {
      fieldSamples[f.id] = (profile.sample_values as unknown[])
        .filter(Boolean)
        .slice(0, 3)
        .map((v) => String(v))
    }
    if (profile && typeof (profile as { null_percentage?: number }).null_percentage === 'number') {
      fieldNullPercentages[f.id] = (profile as { null_percentage: number }).null_percentage
    }
  }

  // Pre-compute MappingsResult top-level fields that the shim passes through.
  const sourceDatasetIds = new Set((allDatasets ?? []).filter((d) => d.role === 'source').map((d) => d.id))
  const targetDatasetIds = new Set((allDatasets ?? []).filter((d) => d.role === 'target').map((d) => d.id))

  const sourceTableIdSet = new Set((allTables ?? []).filter((t) => sourceDatasetIds.has(t.dataset_id)).map((t) => t.id))
  const targetTableIdSet = new Set((allTables ?? []).filter((t) => targetDatasetIds.has(t.dataset_id)).map((t) => t.id))

  // Mappedness indexes (non-rejected, non-acknowledged):
  //   - mapped target = TFM.target_field_id where status != 'rejected' AND NOT is_acknowledged
  //   - mapped source = mapping_sources.source_field_id whose parent TFM matches same rule
  const activeTfms = (rawTFMs ?? []).filter((t) => t.status !== 'rejected' && t.is_acknowledged !== true)
  const activeTfmIds = new Set(activeTfms.map((t) => t.id))
  const mappedTargetFieldIds = new Set(activeTfms.map((t) => t.target_field_id))
  const mappedSourceFieldIds = new Set(
    (rawMappingSources ?? [])
      .filter((ms) => ms.target_field_mapping_id && activeTfmIds.has(ms.target_field_mapping_id))
      .map((ms) => ms.source_field_id)
      .filter((id): id is string => Boolean(id)),
  )

  const tablesByIdMap = new Map((allTables ?? []).map((t) => [t.id, t]))
  const unmappedSourceFields: UnmappedField[] = (allFields ?? [])
    .filter((f) => sourceTableIdSet.has(f.table_id) && !mappedSourceFieldIds.has(f.id))
    .map((f) => ({
      id: f.id,
      name: f.name,
      data_type: f.data_type,
      table_id: f.table_id,
      table: tablesByIdMap.get(f.table_id) ?? null,
      is_nullable: f.is_nullable ?? true,
      default_value: (f as { default_value?: string | null }).default_value ?? null,
    }))

  const unmappedTargetFields: UnmappedField[] = (allFields ?? [])
    .filter((f) => targetTableIdSet.has(f.table_id) && !mappedTargetFieldIds.has(f.id))
    .map((f) => ({
      id: f.id,
      name: f.name,
      data_type: f.data_type,
      table_id: f.table_id,
      table: tablesByIdMap.get(f.table_id) ?? null,
      is_nullable: f.is_nullable ?? true,
      default_value: (f as { default_value?: string | null }).default_value ?? null,
    }))

  const allSourceTables = (allTables ?? [])
    .filter((t) => sourceDatasetIds.has(t.dataset_id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      datasetName: datasetsById[t.dataset_id]?.name ?? '',
    }))
  const allTargetTables = (allTables ?? [])
    .filter((t) => targetDatasetIds.has(t.dataset_id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      datasetName: datasetsById[t.dataset_id]?.name ?? '',
    }))

  const allFieldsByTable: Record<string, SimpleField[]> = {}
  for (const t of allTables ?? []) {
    allFieldsByTable[t.id] = (allFields ?? [])
      .filter((f) => f.table_id === t.id)
      .map((f) => ({
        id: f.id,
        name: f.name,
        data_type: f.data_type,
        is_nullable: f.is_nullable ?? true,
        default_value: (f as { default_value?: string | null }).default_value ?? null,
      }))
  }

  const shimInput: ShimInput = {
    projectId,
    tableMappings: (rawTMs ?? []).map((tm) => ({
      id: tm.id,
      project_id: tm.project_id,
      source_table_id: tm.source_table_id,
      target_table_id: tm.target_table_id,
      confidence: tm.confidence,
      status: tm.status,
      ai_reasoning: tm.ai_reasoning,
      created_at: tm.created_at,
    })) as ShimTableMappingRow[],
    targetFieldMappings: (rawTFMs ?? []) as TargetFieldMappingRow[],
    mappingSources: (rawMappingSources ?? []) as MappingSourceRow[],
    sourceAcks: (rawSourceAcks ?? []) as SourceFieldAcknowledgmentRow[],
    fieldsById,
    tablesById,
    datasetsById,
    fieldSamples,
    fieldNullPercentages,
    transformations: (rawTransformations ?? []) as ShimTransformationRow[],
    unmappedSourceFields,
    unmappedTargetFields,
    allFieldsByTable,
    allSourceTables,
    allTargetTables,
  }

  try {
    return shimToMappingsResult(shimInput)
  } catch (err) {
    if (err instanceof ShimError) {
      // Data-integrity errors MUST surface loudly — the legacy UI cannot
      // render a partial result that silently omits cross-table mappings
      // etc. Log with full context and re-throw as a generic Error so the
      // Next.js error boundary shows a clear failure rather than a blank
      // mapping tab.
      console.error('[mappings:getMappings] shim rejected input', {
        code: err.code,
        context: err.context,
      })
      throw new Error(`Mapping data integrity error (${err.code}): ${err.message}`)
    }
    throw err
  }
}

// ─── recomputeTableMappingStatus ──────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────────
// COVERAGE MODEL (READ BEFORE EDITING — spec §5.0, locked in Gate 2).
// ─────────────────────────────────────────────────────────────────────────────
// A table_mapping is `approved` iff every one of these three conditions holds:
//
//   1. Every non-rejected target_field_mapping (TFM) for this TM's target
//      table has status='approved'. Rejected TFMs are ignored (rejection =
//      deletion under the current UX).
//   2. Every target field of the TM's target_table_id is either:
//        a. the target of some non-rejected TFM (project-scoped — coverage
//           may come from a DIFFERENT TM pairing into the same target
//           table), OR
//        b. acknowledged as target-side via `target_field_mappings` with
//           is_acknowledged=true (project-scoped).
//   3. Every source field of the TM's source_table_id is either:
//        a. referenced by some mapping_sources row whose parent TFM is
//           non-rejected AND pairs into a table whose (source, target)
//           matches an existing TM in this project (TM-scoped — the
//           source-coverage check is tightened here because a source
//           column "used" only by a TFM in a DIFFERENT TM pairing would
//           otherwise silently drop in this TM's apply), OR
//        b. acknowledged as source-side via `source_field_acknowledgments`
//           (project-scoped).
//
// NAMESPACE: The mapped-coverage check for TARGETS is PROJECT-SCOPED because
// a target field can legitimately be the target of a TFM from any TM that
// pairs into that target table (entity fan-out is valid). The mapped-
// coverage check for SOURCES is TM-SCOPED because a source field only
// "flows" through its own source→target TM pair; a TFM belonging to a
// different TM doesn't populate the same apply batch. Acknowledgments are
// always PROJECT-SCOPED because they are user intent to dismiss a field
// regardless of which TM surfaces it.
// ─────────────────────────────────────────────────────────────────────────────

export async function recomputeTableMappingStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tableMappingId: string,
): Promise<void> {
  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return

  // 1. Project-wide TFMs for this target table: every non-rejected must be approved.
  const { data: targetFields } = await supabase
    .from('fields')
    .select('id')
    .eq('table_id', tm.target_table_id)
  const targetFieldIdArr = (targetFields ?? []).map((f) => f.id)

  const { data: sourceFields } = await supabase
    .from('fields')
    .select('id')
    .eq('table_id', tm.source_table_id)
  const sourceFieldIdArr = (sourceFields ?? []).map((f) => f.id)

  const { data: tfmsOnTargetTable } =
    targetFieldIdArr.length > 0
      ? await supabase
          .from('target_field_mappings')
          .select('id, target_field_id, status, is_acknowledged')
          .eq('project_id', tm.project_id)
          .in('target_field_id', targetFieldIdArr)
      : { data: [] as { id: string; target_field_id: string; status: string; is_acknowledged: boolean }[] }

  const nonRejectedTfms = (tfmsOnTargetTable ?? []).filter((t) => t.status !== 'rejected')
  const allMappingsApproved =
    nonRejectedTfms.length > 0 && nonRejectedTfms.every((t) => t.status === 'approved')

  // 2. Target coverage: every target_field is a target of a non-rejected TFM,
  //    OR acknowledged (TFM is_acknowledged=true). Project-scoped.
  const coveredTargetFieldIds = new Set(nonRejectedTfms.map((t) => t.target_field_id))
  const ackedTargetFieldIds = new Set(
    nonRejectedTfms.filter((t) => t.is_acknowledged).map((t) => t.target_field_id),
  )
  const allTargetFieldsCovered = (targetFields ?? []).every(
    (f) => coveredTargetFieldIds.has(f.id) || ackedTargetFieldIds.has(f.id),
  )

  // 3. Source coverage: TM-scoped. Find TFMs whose source side lives on this
  //    TM's source_table (via mapping_sources) — those are the fields that
  //    this TM's apply will actually read.
  let mappedSourceIds = new Set<string>()
  if (sourceFieldIdArr.length > 0) {
    const { data: msForTm } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_field_id, source_table_id, target_field_mapping_id, target_field_mappings!inner(project_id, status)')
      .in('source_field_id', sourceFieldIdArr)
    mappedSourceIds = new Set(
      (msForTm ?? [])
        .filter((ms) => {
          const parent = (ms as unknown as { target_field_mappings: { project_id: string; status: string } }).target_field_mappings
          return (
            parent?.project_id === tm.project_id &&
            parent?.status !== 'rejected' &&
            ms.source_table_id === tm.source_table_id
          )
        })
        .map((ms) => ms.source_field_id)
        .filter((id): id is string => Boolean(id)),
    )
  }

  const { data: sourceAcks } = await supabase
    .from('source_field_acknowledgments')
    .select('source_field_id')
    .eq('project_id', tm.project_id)
  const ackedSourceFieldIds = new Set(
    (sourceAcks ?? []).map((a) => a.source_field_id),
  )

  const allSourceFieldsCovered = (sourceFields ?? []).every(
    (f) => mappedSourceIds.has(f.id) || ackedSourceFieldIds.has(f.id),
  )

  const shouldBeApproved =
    allMappingsApproved && allTargetFieldsCovered && allSourceFieldsCovered

  await supabase
    .from('table_mappings')
    .update({ status: shouldBeApproved ? 'approved' : 'needs_review' })
    .eq('id', tableMappingId)
}

// ─── handleTargetFieldConflict (read helper) ─────────────────────────────────
//
// Returns any existing non-rejected TFM for (project, targetField). In the
// new model every target has at most ONE row in target_field_mappings (unique
// constraint on (project_id, target_field_id)), so `conflictType` is always
// either 'none' or one of the terminal forms.

export async function handleTargetFieldConflict(
  tableMappingId: string,
  targetFieldId: string,
  incomingFieldMappingId?: string,
): Promise<{
  hasConflict: boolean
  conflictType: 'none' | 'value_assignment' | 'field_mapping' | 'both'
  existingMappings: Array<{ id: string; sourceFieldName: string | null; isValueAssignment: boolean; hasTransform: boolean; hasStaged: boolean }>
}> {
  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('project_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { hasConflict: false, conflictType: 'none', existingMappings: [] }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, combination_type, is_acknowledged, status')
    .eq('project_id', tm.project_id)
    .eq('target_field_id', targetFieldId)
    .maybeSingle()

  if (!tfm || tfm.status === 'rejected' || tfm.id === incomingFieldMappingId) {
    return { hasConflict: false, conflictType: 'none', existingMappings: [] }
  }

  const isValueAssignment = tfm.combination_type === 'custom_sql'
  // Pull the first source field name if this is a mapped TFM (for UX labels).
  let sourceFieldName: string | null = null
  if (!isValueAssignment) {
    const { data: ms } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_field_id, fields:source_field_id(name)')
      .eq('target_field_mapping_id', tfm.id)
      .order('ordinal', { ascending: true })
      .limit(1)
    const row = (ms ?? [])[0]
    sourceFieldName = (row as unknown as { fields?: { name?: string } } | undefined)?.fields?.name ?? 'Unknown'
  }

  const check = await checkFieldMappingHasTransform(tfm.id)

  return {
    hasConflict: true,
    conflictType: isValueAssignment ? 'value_assignment' : 'field_mapping',
    existingMappings: [
      {
        id: tfm.id,
        sourceFieldName: isValueAssignment ? null : sourceFieldName,
        isValueAssignment,
        hasTransform: check.hasTransform,
        hasStaged: check.hasStaged,
      },
    ],
  }
}

// ─── cleanupOrphanedContributors — STUB (Design Call E) ──────────────────────
//
// Under the new data model, primary/contributor semantics are encoded as
// mapping_sources.ordinal (0 = primary, >0 = contributors) with a UNIQUE
// constraint guaranteeing exactly one ordinal=0 per TFM (enforced at
// application level by `dq_create_target_field_mapping` inserting ordinal=0
// first and contributors after). There is no "orphan contributor" state to
// repair because a contributor cannot exist without a parent TFM, and a
// TFM cannot exist without exactly one ordinal=0 primary unless the caller
// deleted it manually — in which case the correct response is to fix the
// caller, not silently re-promote.
//
// The function is kept as a no-op so existing call sites (regenerate path
// in particular) continue to compile without changes. Prompt 3b will remove
// the call sites entirely.

export async function cleanupOrphanedContributors(
  _tableMappingId: string,
): Promise<{ promoted: number; demoted: number }> {
  return { promoted: 0, demoted: 0 }
}

// ─── updateFieldMappingStatus ─────────────────────────────────────────────────
//
// Decodes the shimmed row id and routes to the correct underlying row:
//   - tfm-primary        → UPDATE target_field_mappings.status
//   - tfm-contributor    → approve = no-op (contributors inherit parent status);
//                          reject = DELETE the mapping_source row (rejection-
//                          is-deletion UX from Phase 1)
// Any other id shape is a programming error and returns NOT_FOUND.

export async function updateFieldMappingStatus(
  fieldMappingId: string,
  status: 'approved' | 'rejected' | 'needs_review',
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const decoded = decodeShimmedRowId(fieldMappingId)
  if (decoded.kind === 'unknown' || decoded.kind === 'target-ack' || decoded.kind === 'source-ack') {
    return { success: false, error: 'Mapping not found', errorCode: 'NOT_FOUND' }
  }

  // Resolve project_id from the TFM for permission + guard.
  const { data: tfmLookup } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, project_id, target_field_id, status, is_acknowledged, combination_type')
    .eq('id', decoded.tfmId)
    .single()
  if (!tfmLookup) return { success: false, error: 'Mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tfmLookup.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tfmLookup.project_id, async () => {
    if (decoded.kind === 'tfm-primary') {
      const previousStatus = tfmLookup.status
      const { error } = await supabaseAdmin
        .from('target_field_mappings')
        .update({ status })
        .eq('id', decoded.tfmId)
      if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }

      // Provenance: status flip on the TFM. Each new status maps to a
      // distinct edit_kind so the calibration loop can distinguish
      // approve / reject / send-back-to-review.
      const editKind =
        status === 'approved'
          ? 'human_accepted'
          : status === 'rejected'
            ? 'human_rejected'
            : 'human_modified'
      void logAIEdit({
        projectId: tfmLookup.project_id,
        actorId: user.id,
        entityType: 'target_field_mapping',
        entityId: decoded.tfmId,
        fieldPath: 'status',
        oldValue: previousStatus,
        newValue: status,
        editKind,
      })
    } else {
      // tfm-contributor: reject = delete the contributor row; approve = no-op.
      if (status === 'rejected') {
        // Capture the contributor row so the diff carries the rejected
        // source-field id rather than just "deleted."
        const { data: contribBefore } = await supabaseAdmin
          .from('mapping_sources')
          .select('id, source_field_id, confidence, ai_reasoning, ordinal')
          .eq('id', decoded.mappingSourceId)
          .eq('target_field_mapping_id', decoded.tfmId)
          .maybeSingle()

        const { error } = await supabaseAdmin
          .from('mapping_sources')
          .delete()
          .eq('id', decoded.mappingSourceId)
          .eq('target_field_mapping_id', decoded.tfmId)
        if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }

        if (contribBefore) {
          void logAIEdit({
            projectId: tfmLookup.project_id,
            actorId: user.id,
            entityType: 'mapping_source',
            entityId: decoded.mappingSourceId,
            fieldPath: 'source_field_id',
            oldValue: contribBefore,
            newValue: null,
            editKind: 'human_rejected',
            metadata: { parent_tfm_id: decoded.tfmId },
          })
        }
      }
    }

    // Re-evaluate coverage on the TM(s) that pair into this target table.
    const { data: targetField } = await supabase
      .from('fields')
      .select('table_id')
      .eq('id', tfmLookup.target_field_id)
      .single()
    if (targetField) {
      const { data: tms } = await supabase
        .from('table_mappings')
        .select('id, project_id')
        .eq('project_id', tfmLookup.project_id)
        .eq('target_table_id', targetField.table_id)
      for (const tm of tms ?? []) {
        await recomputeTableMappingStatus(supabase, tm.id)
      }
    }

    if ((status === 'approved' || status === 'rejected') && decoded.kind === 'tfm-primary') {
      try {
        const { data: tgtFld } = await supabase
          .from('fields')
          .select('name')
          .eq('id', tfmLookup.target_field_id)
          .single()
        const { data: primarySource } = await supabaseAdmin
          .from('mapping_sources')
          .select('source_field_id, fields:source_field_id(name)')
          .eq('target_field_mapping_id', decoded.tfmId)
          .order('ordinal', { ascending: true })
          .limit(1)
        const srcName = (primarySource ?? [])[0]
          ? ((primarySource![0] as unknown as { fields?: { name?: string } }).fields?.name ?? null)
          : null
        await logActivity(
          tfmLookup.project_id,
          status === 'approved' ? 'mapping_approved' : 'mapping_rejected',
          `Mapping ${status}: ${srcName ?? '[value]'} \u2192 ${tgtFld?.name ?? '?'}`,
          'mapping',
          {
            target_field_mapping_id: decoded.tfmId,
            target_field: tgtFld?.name,
            source_field: srcName,
          },
        )
        revalidatePath(`/app/projects/${tfmLookup.project_id}/transform`)
      } catch {
        // Non-critical
      }
    }

    return { success: true }
  })
}

// ─── updateTableMappingStatus ─────────────────────────────────────────────────

export async function updateTableMappingStatus(
  tableMappingId: string,
  status: 'approved' | 'rejected' | 'needs_review',
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const { data: tmLookup } = await supabaseAdmin
    .from('table_mappings')
    .select('project_id')
    .eq('id', tableMappingId)
    .single()
  if (!tmLookup) return { success: false, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tmLookup.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tmLookup.project_id, async () => {
    const { error } = await supabase
      .from('table_mappings')
      .update({ status })
      .eq('id', tableMappingId)
    if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }
    return { success: true }
  })
}

// ─── editFieldMapping (Refinement 2: TARGET_CONFLICT) ────────────────────────
//
// The legacy multi-purpose edit entrypoint. In the new data model we map
// its updates onto the TFM/mapping_sources shape:
//   - target_field_id change → UPDATE target_field_mappings.target_field_id
//     (subject to the TARGET_CONFLICT check below).
//   - source_field_id change → UPDATE mapping_sources.source_field_id for
//     the correct row (primary for tfm-primary ids, the specific
//     contributor row for tfm-contributor ids).
//   - confidence / ai_reasoning / type_compatibility → applied to the TFM
//     for primary ids, to the mapping_source for contributors.
//
// Refinement 2: when target_field_id changes AND a non-VA TFM already
// exists at the new target, we refuse with TARGET_CONFLICT rather than
// merging. VA conflicts are still auto-resolved by deleting the VA TFM.

export async function editFieldMapping(
  fieldMappingId: string,
  updates: {
    target_field_id?: string
    source_field_id?: string
    confidence?: number | null
    ai_reasoning?: string
    type_compatibility?: string | null
    is_contributing?: boolean
  },
): Promise<{
  success: boolean
  transformReset?: boolean
  stagedRowsReverted?: number
  valueAssignmentReplaced?: boolean
  becameContributing?: boolean
  promotedContributor?: boolean
  fkDependentsReset?: number
  error?: string
  errorCode?: MappingWriteErrorCode
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const decoded = decodeShimmedRowId(fieldMappingId)
  if (decoded.kind !== 'tfm-primary' && decoded.kind !== 'tfm-contributor') {
    return { success: false, error: 'Mapping not found', errorCode: 'NOT_FOUND' }
  }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, project_id, target_field_id, combination_type, is_acknowledged')
    .eq('id', decoded.tfmId)
    .single()
  if (!tfm) return { success: false, error: 'Mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tfm.project_id, async () => {
    let transformReset = false
    let stagedRowsReverted = 0
    let valueAssignmentReplaced = false
    let fkDependentsReset = 0

    // Reset transform when either side of the mapping is changing. Uses the
    // (still-legacy) resetFieldTransform wiring; Prompt 3b rewires it to the
    // new TFM-scoped transforms RPC. The call is preserved here so that the
    // behavioural contract lines up with the legacy UI expectations even
    // though the underlying reset won't succeed until Prompt 3b.
    if (updates.target_field_id || updates.source_field_id) {
      const resetResult = await resetFieldTransform(decoded.tfmId)
      transformReset = resetResult.hadTransform
      stagedRowsReverted = resetResult.rowsReverted
      fkDependentsReset = resetResult.fkDependentsReset ?? 0
      stagedRowsReverted += resetResult.fkRowsReverted ?? 0
    }

    if (updates.target_field_id && updates.target_field_id !== tfm.target_field_id) {
      if (decoded.kind === 'tfm-contributor') {
        return {
          success: false,
          error: 'Cannot change target of a contributing source — edit the primary mapping or remove this contributor first.',
          errorCode: 'VALIDATION',
        }
      }

      // Look at what already lives at the new target.
      const { data: existing } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, combination_type, is_acknowledged, status')
        .eq('project_id', tfm.project_id)
        .eq('target_field_id', updates.target_field_id)
        .maybeSingle()

      if (existing && existing.id !== tfm.id && existing.status !== 'rejected') {
        if (existing.combination_type === 'custom_sql' && !existing.is_acknowledged) {
          // VA at the new target — delete it first.
          const vaReset = await replaceValueAssignment(
            /* tableMappingId unused in new model */ '',
            updates.target_field_id,
          )
          if (vaReset.transformReset) valueAssignmentReplaced = true
          stagedRowsReverted += vaReset.rowsReverted
        } else {
          // Non-VA TFM at target → TARGET_CONFLICT (Refinement 2).
          return {
            success: false,
            error: 'Target field already has a mapping. Delete the existing mapping first.',
            errorCode: 'TARGET_CONFLICT',
          }
        }
      }

      const { error: updErr } = await supabaseAdmin
        .from('target_field_mappings')
        .update({
          target_field_id: updates.target_field_id,
          status: 'needs_review',
          ...(updates.confidence !== undefined ? { confidence: updates.confidence } : {}),
          ...(updates.ai_reasoning !== undefined ? { ai_reasoning: updates.ai_reasoning } : {}),
        })
        .eq('id', tfm.id)
      if (updErr) return { success: false, error: updErr.message, errorCode: 'INTERNAL' }
    } else {
      // No target change — apply scalar TFM updates only if relevant.
      const tfmPatch: Record<string, unknown> = { status: 'needs_review' }
      if (updates.confidence !== undefined) tfmPatch.confidence = updates.confidence
      if (updates.ai_reasoning !== undefined) tfmPatch.ai_reasoning = updates.ai_reasoning
      if (Object.keys(tfmPatch).length > 1) {
        const { error: patchErr } = await supabaseAdmin
          .from('target_field_mappings')
          .update(tfmPatch)
          .eq('id', tfm.id)
        if (patchErr) return { success: false, error: patchErr.message, errorCode: 'INTERNAL' }
      }
    }

    // Source-field change applies to the correct mapping_source row.
    if (updates.source_field_id !== undefined) {
      const msId = decoded.kind === 'tfm-primary' ? undefined : decoded.mappingSourceId
      if (msId) {
        const { error: msErr } = await supabaseAdmin
          .from('mapping_sources')
          .update({
            source_field_id: updates.source_field_id,
            ...(updates.type_compatibility !== undefined
              ? { type_compatibility: updates.type_compatibility }
              : {}),
          })
          .eq('id', msId)
        if (msErr) return { success: false, error: msErr.message, errorCode: 'INTERNAL' }
      } else {
        // Primary row — find ordinal=0 for this TFM and update it.
        const { data: primary } = await supabaseAdmin
          .from('mapping_sources')
          .select('id')
          .eq('target_field_mapping_id', tfm.id)
          .eq('ordinal', 0)
          .maybeSingle()
        if (primary) {
          const { error: msErr } = await supabaseAdmin
            .from('mapping_sources')
            .update({
              source_field_id: updates.source_field_id,
              ...(updates.type_compatibility !== undefined
                ? { type_compatibility: updates.type_compatibility }
                : {}),
            })
            .eq('id', primary.id)
          if (msErr) return { success: false, error: msErr.message, errorCode: 'INTERNAL' }
        }
      }
    }

    return {
      success: true,
      transformReset,
      stagedRowsReverted,
      valueAssignmentReplaced,
      becameContributing: false,
      promotedContributor: false,
      fkDependentsReset,
    }
  })
}

// ─── addManualFieldMapping (Refinement 1: direct contributor INSERT) ─────────
//
// Creates a new mapping between sourceFieldId and targetFieldId, respecting
// the TM's (source_table, target_table) pairing. The two modes differ:
//
//   - isContributing=false (primary): 
//       * If a VA TFM exists at targetFieldId → delete it first.
//       * If a non-VA TFM exists → convert incoming to contributor on
//         that TFM by inserting into mapping_sources with ordinal=max+1
//         (no RPC; direct INSERT per Refinement 1).
//       * Otherwise → call dq_create_target_field_mapping with ordinal=0.
//
//   - isContributing=true:
//       * Requires a parent TFM at targetFieldId. Insert directly into
//         mapping_sources with ordinal=max(existing)+1 (Refinement 1 —
//         avoids dq_replace_mapping_sources firing the confidence trigger
//         N times from DELETE+INSERT). UNIQUE (tfm_id, source_field_id)
//         catches duplicates naturally.

export async function addManualFieldMapping(
  tableMappingId: string,
  sourceFieldId: string,
  targetFieldId: string,
  isContributing = false,
  aiReasoning?: string,
): Promise<{
  success: boolean
  data?: { id: string; is_contributing: boolean }
  error?: string
  errorCode?: MappingWriteErrorCode
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tm.project_id, async () => {
    const defaultReasoning = isContributing
      ? 'Contributing source — manually mapped by user'
      : 'Manually mapped by user'

    const { data: existingTfm } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, combination_type, is_acknowledged, status')
      .eq('project_id', tm.project_id)
      .eq('target_field_id', targetFieldId)
      .maybeSingle()

    // Handle contributor path.
    if (isContributing) {
      if (!existingTfm || existingTfm.status === 'rejected' || existingTfm.is_acknowledged) {
        return {
          success: false,
          error: 'Cannot add contributor: target has no primary mapping.',
          errorCode: 'VALIDATION',
        }
      }
      const nextOrdinal = await getNextOrdinal(existingTfm.id)
      const { data: inserted, error } = await supabaseAdmin
        .from('mapping_sources')
        .insert({
          target_field_mapping_id: existingTfm.id,
          source_field_id: sourceFieldId,
          source_table_id: tm.source_table_id,
          confidence: 100,
          ai_reasoning: aiReasoning ?? defaultReasoning,
          similar_fields_considered: [],
          type_compatibility: null,
          ordinal: nextOrdinal,
        })
        .select('id')
        .single()
      if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }

      // Promote combination_type to concat_space if currently 'single'.
      if (existingTfm.combination_type === 'single') {
        await supabaseAdmin
          .from('target_field_mappings')
          .update({ combination_type: 'concat_space' })
          .eq('id', existingTfm.id)
      }

      revalidatePath(`/app/projects/${tm.project_id}/transform`)
      return {
        success: true,
        data: { id: `${existingTfm.id}::${inserted.id}`, is_contributing: true },
      }
    }

    // Primary path.
    // Bare-ack TFM (acknowledged with no combination_type) blocks new
    // primary mapping creation due to unique (project_id, target_field_id)
    // constraint. Delete the bare-ack first; it has no mapping_sources
    // or transformations that would FK-cascade.
    if (existingTfm && existingTfm.is_acknowledged && existingTfm.combination_type === null) {
      const { error: delErr } = await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .eq('id', existingTfm.id)
      if (delErr) return { success: false, error: delErr.message, errorCode: 'INTERNAL' }
    } else if (existingTfm && existingTfm.status !== 'rejected' && !existingTfm.is_acknowledged) {
      if (existingTfm.combination_type === 'custom_sql') {
        // VA conflict — delete it, then create fresh TFM.
        await replaceValueAssignment('', targetFieldId)
      } else {
        // Non-VA TFM exists → convert incoming to contributor.
        const nextOrdinal = await getNextOrdinal(existingTfm.id)
        const { data: inserted, error } = await supabaseAdmin
          .from('mapping_sources')
          .insert({
            target_field_mapping_id: existingTfm.id,
            source_field_id: sourceFieldId,
            source_table_id: tm.source_table_id,
            confidence: 100,
            ai_reasoning: aiReasoning ?? defaultReasoning,
            similar_fields_considered: [],
            type_compatibility: null,
            ordinal: nextOrdinal,
          })
          .select('id')
          .single()
        if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }
        if (existingTfm.combination_type === 'single') {
          await supabaseAdmin
            .from('target_field_mappings')
            .update({ combination_type: 'concat_space' })
            .eq('id', existingTfm.id)
        }
        revalidatePath(`/app/projects/${tm.project_id}/transform`)
        return {
          success: true,
          data: { id: `${existingTfm.id}::${inserted.id}`, is_contributing: true },
        }
      }
    }

    // Fresh TFM via RPC (handles primary + zero contributors).
    const { data: newTfmId, error: rpcErr } = await supabase.rpc('dq_create_target_field_mapping', {
      p_project_id: tm.project_id,
      p_target_field_id: targetFieldId,
      p_sources: [
        {
          source_field_id: sourceFieldId,
          source_table_id: tm.source_table_id,
          confidence: 100,
          ai_reasoning: aiReasoning ?? defaultReasoning,
          ordinal: 0,
        },
      ],
      p_combination: { type: 'single', ai_reasoning: aiReasoning ?? defaultReasoning },
    })
    if (rpcErr) return { success: false, error: rpcErr.message, errorCode: 'INTERNAL' }

    // Manual mappings are pre-approved.
    await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved' })
      .eq('id', newTfmId as string)

    revalidatePath(`/app/projects/${tm.project_id}/transform`)
    return {
      success: true,
      data: { id: newTfmId as string, is_contributing: false },
    }
  })
}

async function getNextOrdinal(tfmId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('mapping_sources')
    .select('ordinal')
    .eq('target_field_mapping_id', tfmId)
    .order('ordinal', { ascending: false })
    .limit(1)
  const max = (data ?? [])[0]?.ordinal
  return typeof max === 'number' ? max + 1 : 0
}

// ─── addManualTableMapping ────────────────────────────────────────────────────

export async function addManualTableMapping(
  projectId: string,
  sourceTableId: string,
  targetTableId: string,
): Promise<{ success: boolean; data?: { id: string }; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(projectId, async () => {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .single()
    if (!project) return { success: false, error: 'Project not found', errorCode: 'NOT_FOUND' }

    const { data: existingMapping } = await supabase
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .eq('source_table_id', sourceTableId)
      .eq('target_table_id', targetTableId)
      .limit(1)

    if (existingMapping && existingMapping.length > 0) {
      const [{ data: srcTableData }, { data: tgtTableData }] = await Promise.all([
        supabase.from('tables').select('name').eq('id', sourceTableId).single(),
        supabase.from('tables').select('name').eq('id', targetTableId).single(),
      ])
      return {
        success: false,
        error: `A mapping from ${srcTableData?.name ?? 'source table'} → ${tgtTableData?.name ?? 'target table'} already exists.`,
        errorCode: 'VALIDATION',
      }
    }

    const { data, error } = await supabase
      .from('table_mappings')
      .insert({
        project_id: projectId,
        source_table_id: sourceTableId,
        target_table_id: targetTableId,
        confidence: null,
        status: 'needs_review',
        ai_reasoning: null,
      })
      .select('id')
      .single()

    if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }
    return { success: true, data: { id: data.id } }
  })
}

// ─── deleteFieldMapping ───────────────────────────────────────────────────────
//
// - tfm-primary    → DELETE the TFM (cascade to mapping_sources + transformations)
// - tfm-contributor → DELETE the single mapping_source row
//   (if it was the last non-primary source AND the TFM is concat_*, demote
//    to combination_type='single'). If it was the PRIMARY (ordinal=0), we
//    refuse because promoting a contributor to primary is a semantic
//    decision that belongs on the front end.

export async function deleteFieldMapping(
  fieldMappingId: string,
): Promise<{
  success: boolean
  transformReset?: boolean
  stagedRowsReverted?: number
  error?: string
  errorCode?: MappingWriteErrorCode
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const decoded = decodeShimmedRowId(fieldMappingId)
  if (decoded.kind !== 'tfm-primary' && decoded.kind !== 'tfm-contributor') {
    return { success: false, error: 'Mapping not found', errorCode: 'NOT_FOUND' }
  }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, project_id, target_field_id, combination_type')
    .eq('id', decoded.tfmId)
    .single()
  if (!tfm) return { success: false, error: 'Mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tfm.project_id, async () => {
    // Reset transform BEFORE deletion so it can resolve names.
    const resetResult = await resetFieldTransform(tfm.id)

    if (decoded.kind === 'tfm-primary') {
      const { error } = await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .eq('id', tfm.id)
      if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }
    } else {
      // tfm-contributor — check we're not deleting the primary ordinal=0 row.
      const { data: ms } = await supabaseAdmin
        .from('mapping_sources')
        .select('id, ordinal')
        .eq('id', decoded.mappingSourceId)
        .eq('target_field_mapping_id', tfm.id)
        .single()
      if (!ms) return { success: false, error: 'Contributor not found', errorCode: 'NOT_FOUND' }
      if (ms.ordinal === 0) {
        return {
          success: false,
          error: 'Cannot delete the primary source. Delete the whole mapping instead.',
          errorCode: 'VALIDATION',
        }
      }
      const { error } = await supabaseAdmin
        .from('mapping_sources')
        .delete()
        .eq('id', decoded.mappingSourceId)
      if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }

      // Demote combination_type if this was the last contributor.
      const { count } = await supabaseAdmin
        .from('mapping_sources')
        .select('id', { count: 'exact', head: true })
        .eq('target_field_mapping_id', tfm.id)
      if ((count ?? 0) === 1 && tfm.combination_type !== 'single') {
        await supabaseAdmin
          .from('target_field_mappings')
          .update({ combination_type: 'single' })
          .eq('id', tfm.id)
      }
    }

    // Recompute every TM whose target table contains this target field.
    const { data: targetField } = await supabase
      .from('fields')
      .select('table_id')
      .eq('id', tfm.target_field_id)
      .single()
    if (targetField) {
      const { data: tms } = await supabase
        .from('table_mappings')
        .select('id')
        .eq('project_id', tfm.project_id)
        .eq('target_table_id', targetField.table_id)
      for (const row of tms ?? []) {
        await recomputeTableMappingStatus(supabase, row.id)
      }
    }

    revalidatePath(`/app/projects/${tfm.project_id}/transform`)
    return {
      success: true,
      transformReset: resetResult.hadTransform,
      stagedRowsReverted: resetResult.rowsReverted,
    }
  })
}

// ─── deleteTableMapping ──────────────────────────────────────────────────────
//
// Deletes the TM row and cascades ONLY to TFMs that would become orphaned
// (i.e., no other TM in the project would still own them via the shim's
// TM-pairing rules). TFMs that another TM still covers are preserved.
//
// Shim ownership rules (must stay in sync with `translateTfm` / the TM
// grouping logic in `lib/compat/mapping-shim.ts`):
//
//   ▸ Mapped TFM (combination_type != 'custom_sql')
//       A TM (source_table_id=S, target_table_id=T) owns this TFM iff the
//       TFM's target_field is in T AND at least one mapping_source of the
//       TFM has source_table_id=S.
//
//   ▸ VA TFM (combination_type = 'custom_sql', zero mapping_sources)
//       A TM (S,T) owns the VA iff the VA's target_field is in T.
//       Because VAs have no sources, every TM targeting T co-owns them.
//
// Algorithm:
//   1. Load sibling TMs (every TM in the project except the one being
//      deleted). Build sets of covered (S,T) pairs and covered Ts.
//   2. Enumerate candidate TFMs in the target table.
//   3. For each candidate decide whether any sibling still owns it. If
//      no sibling owns it, the TFM is orphaned by this delete → queue for
//      cascade deletion.
//   4. Delete orphaned TFMs (children cascade via FK) then delete the TM.
//
// See `tests/actions/mappings-refinements.test.ts` for the multi-TM case
// that locks this behavior.

export async function deleteTableMapping(
  tableMappingId: string,
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tm.project_id, async () => {
    // ── Step 1: load sibling TMs (project-scoped, excluding the target).
    const { data: siblingTmRows } = await supabaseAdmin
      .from('table_mappings')
      .select('id, source_table_id, target_table_id')
      .eq('project_id', tm.project_id)
      .neq('id', tableMappingId)
    const siblings = siblingTmRows ?? []

    // ── Step 2: find candidate TFMs (target field in tm.target_table).
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.target_table_id)
    const targetFieldIds = (targetFields ?? []).map((f) => f.id)

    if (targetFieldIds.length > 0) {
      const { data: candidateTfmRows } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, combination_type, target_field_id')
        .eq('project_id', tm.project_id)
        .in('target_field_id', targetFieldIds)
      const candidates = candidateTfmRows ?? []

      // Pull mapping_sources for mapped candidates in one query so we can
      // compute ownership without N roundtrips.
      const mappedIds = candidates
        .filter((t) => t.combination_type !== 'custom_sql')
        .map((t) => t.id)
      const sourcesByTfm = new Map<string, Set<string>>()
      if (mappedIds.length > 0) {
        const { data: msRows } = await supabaseAdmin
          .from('mapping_sources')
          .select('target_field_mapping_id, source_table_id')
          .in('target_field_mapping_id', mappedIds)
        for (const row of msRows ?? []) {
          if (!row.target_field_mapping_id || !row.source_table_id) continue
          const tfmId = row.target_field_mapping_id
          let set = sourcesByTfm.get(tfmId)
          if (!set) {
            set = new Set<string>()
            sourcesByTfm.set(tfmId, set)
          }
          set.add(row.source_table_id)
        }
      }

      // ── Step 3: classify each candidate via the pure helper so the
      // ownership algorithm stays unit-testable.
      const tfmIdsToDelete = computeOrphanedTfmsForTmDelete({
        targetTm: {
          source_table_id: tm.source_table_id,
          target_table_id: tm.target_table_id,
        },
        siblingTms: siblings,
        candidateTfms: candidates,
        sourcesByTfm,
      })

      if (tfmIdsToDelete.length > 0) {
        await supabaseAdmin
          .from('target_field_mappings')
          .delete()
          .in('id', tfmIdsToDelete)
      }
    }

    const { error } = await supabase.from('table_mappings').delete().eq('id', tableMappingId)
    if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }

    revalidatePath(`/app/projects/${tm.project_id}/transform`)
    return { success: true }
  })
}

// ─── mapUnmappedField ────────────────────────────────────────────────────────

export async function mapUnmappedField(
  projectId: string,
  sourceFieldId: string,
  targetFieldId: string,
  isContributing = false,
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(projectId, async () => {
    const { data: sf } = await supabase.from('fields').select('table_id').eq('id', sourceFieldId).single()
    const { data: tf } = await supabase.from('fields').select('table_id').eq('id', targetFieldId).single()
    if (!sf || !tf) return { success: false, error: 'Field not found', errorCode: 'NOT_FOUND' }

    // Find or create TM.
    let tmId: string
    const { data: existingTM } = await supabase
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .eq('source_table_id', sf.table_id)
      .eq('target_table_id', tf.table_id)
      .maybeSingle()

    if (existingTM) {
      tmId = existingTM.id
    } else {
      const { data: newTM, error: tmErr } = await supabase
        .from('table_mappings')
        .insert({
          project_id: projectId,
          source_table_id: sf.table_id,
          target_table_id: tf.table_id,
          confidence: null,
          status: 'needs_review',
        })
        .select('id')
        .single()
      if (tmErr || !newTM) return { success: false, error: tmErr?.message ?? 'Failed to create table mapping', errorCode: 'INTERNAL' }
      tmId = newTM.id
    }

    const result = await addManualFieldMapping(tmId, sourceFieldId, targetFieldId, isContributing)
    if (!result.success) return { success: false, error: result.error, errorCode: result.errorCode }
    return { success: true }
  })
}

// ─── replaceValueAssignment ──────────────────────────────────────────────────
//
// Deletes the VA TFM for (project, target_field) so a real mapping can take
// its place. The tableMappingId argument is retained for back-compat (some
// callers still pass it) but is unused — VAs in the new model live on
// target_field_mappings keyed by (project_id, target_field_id). When called
// from inside another guarded write we pass '' to indicate no TM context.
//
// This function intentionally does NOT call `assertMappingWritesEnabled`:
// it is a pure helper invoked exclusively from already-guarded write paths.
// Calling the guard here would re-read `projects.maintenance_mode` on every
// edit/add/map call, which is wasteful and could create log noise.

export async function replaceValueAssignment(
  _tableMappingId: string,
  targetFieldId: string,
): Promise<{ success: boolean; transformReset: boolean; rowsReverted: number }> {
  const { data: va } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id')
    .eq('target_field_id', targetFieldId)
    .eq('combination_type', 'custom_sql')
    .eq('is_acknowledged', false)
    .maybeSingle()

  if (!va) return { success: true, transformReset: false, rowsReverted: 0 }

  const resetResult = await resetFieldTransform(va.id)

  await supabaseAdmin
    .from('target_field_mappings')
    .delete()
    .eq('id', va.id)

  return {
    success: true,
    transformReset: resetResult.hadTransform,
    rowsReverted: resetResult.rowsReverted,
  }
}

// ─── createValueAssignment ───────────────────────────────────────────────────
//
// Creates a custom_sql TFM for the given target. The resulting row has
// `combination_sql = NULL` until the user authors the SQL in the Transform
// tab — that write goes to `transformations.generated_sql`, which is the
// canonical source of truth for VA SQL in this system. The NULL state is
// an INTENTIONAL LIFECYCLE (not data corruption): a VA row stays NULL for
// the entire window between creation and the user's first save in the
// Transform tab, which can be hours or days in normal usage.
//
// The shim's VA branch (`translateTfm`) expects this and renders the row
// as a `RichFieldMapping` with `source_field_id = null` regardless of
// whether `combination_sql` is populated. The legacy UI reads the VA's
// actual SQL off the attached `transformation.generated_sql`, not the
// TFM row, so a NULL `combination_sql` has zero observable effect.
//
// Prompt 3b will rewrite the Transform-tab save path to also mirror the
// final SQL back onto the TFM's `combination_sql` so the column matches
// `transformations.generated_sql` at rest.

export async function createValueAssignment(
  projectId: string,
  tableMappingId: string,
  targetFieldId: string,
): Promise<{ success: boolean; fieldMappingId?: string; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(projectId, async () => {
    const { data: existing } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, combination_type, is_acknowledged, status')
      .eq('project_id', projectId)
      .eq('target_field_id', targetFieldId)
      .maybeSingle()

    // Bare-ack TFM (acknowledged with no combination_type) blocks new
    // VA creation due to unique (project_id, target_field_id) constraint.
    // Delete the bare-ack first; it has no mapping_sources or transformations
    // that would FK-cascade.
    if (existing && existing.is_acknowledged && existing.combination_type === null) {
      const { error: delErr } = await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .eq('id', existing.id)
      if (delErr) return { success: false, error: delErr.message, errorCode: 'INTERNAL' }
    } else if (existing && existing.status !== 'rejected' && !existing.is_acknowledged) {
      if (existing.combination_type === 'custom_sql') {
        // Already a VA — return its id.
        return { success: true, fieldMappingId: existing.id }
      }
      return {
        success: false,
        error: 'This target field already has a field mapping. Remove the mapping first to add a value assignment.',
        errorCode: 'VALIDATION',
      }
    }

    const { data: newId, error: rpcErr } = await supabase.rpc('dq_create_target_field_mapping', {
      p_project_id: projectId,
      p_target_field_id: targetFieldId,
      p_sources: [],
      p_combination: {
        type: 'custom_sql',
        sql: null,
        confidence: 100,
        ai_reasoning: 'Value assignment — no source field. User will define the value in Transform.',
      },
    })
    if (rpcErr) return { success: false, error: rpcErr.message, errorCode: 'INTERNAL' }

    await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved' })
      .eq('id', newId as string)

    void tableMappingId
    revalidatePath(`/app/projects/${projectId}`, 'layout')
    return { success: true, fieldMappingId: newId as string }
  })
}

// ─── regenerateFieldMappings ─────────────────────────────────────────────────
//
// "Start fresh" on a single TM pairing: delete every TFM whose target lives
// in this TM's target_table AND whose mapping_sources point at this TM's
// source_table (same TM-pairing logic as deleteTableMapping/shim), clear
// both tables' acknowledgments, demote the TM to needs_review, then run
// the shared generation helper.

export async function regenerateFieldMappings(
  tableMappingId: string,
): Promise<{
  success: boolean
  fieldCount: number
  transformsReset?: number
  stagedRowsReverted?: number
  error?: string
  errorCode?: MappingWriteErrorCode
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, fieldCount: 0, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, fieldCount: 0, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, fieldCount: 0, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tm.project_id, async () => {
    const resetResult = await resetAllTransformsForTable(tableMappingId)

    // Find every TFM belonging to this TM pairing (same logic as the shim).
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.target_table_id)
    const targetFieldIds = (targetFields ?? []).map((f) => f.id)

    const tfmIdsToDelete: string[] = []
    if (targetFieldIds.length > 0) {
      const { data: allTfms } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, combination_type, is_acknowledged')
        .eq('project_id', tm.project_id)
        .in('target_field_id', targetFieldIds)

      const nonAck = (allTfms ?? []).filter((t) => !t.is_acknowledged)
      for (const t of nonAck) {
        if (t.combination_type === 'custom_sql') {
          // VAs are TM-pairing-agnostic — regenerate keeps them.
          continue
        }
      }
      const mappedIds = nonAck.filter((t) => t.combination_type !== 'custom_sql').map((t) => t.id)
      if (mappedIds.length > 0) {
        const { data: ms } = await supabaseAdmin
          .from('mapping_sources')
          .select('target_field_mapping_id')
          .in('target_field_mapping_id', mappedIds)
          .eq('source_table_id', tm.source_table_id)
        const belongs = new Set(
          (ms ?? [])
            .map((m) => m.target_field_mapping_id)
            .filter((id): id is string => Boolean(id)),
        )
        for (const id of belongs) tfmIdsToDelete.push(id)
      }
    }

    if (tfmIdsToDelete.length > 0) {
      const { error: delErr } = await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .in('id', tfmIdsToDelete)
      if (delErr) {
        return {
          success: false,
          fieldCount: 0,
          error: `Failed to clear existing field mappings: ${delErr.message}`,
          errorCode: 'INTERNAL',
        }
      }
    }

    // Clear acknowledgments on both sides so formerly-dismissed fields re-surface.
    const { data: sourceFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.source_table_id)
    const sourceFieldIds = (sourceFields ?? []).map((f) => f.id)

    if (targetFieldIds.length > 0) {
      // Target-side acks = TFM rows with is_acknowledged=true (no sources).
      await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .eq('project_id', tm.project_id)
        .in('target_field_id', targetFieldIds)
        .eq('is_acknowledged', true)
    }
    if (sourceFieldIds.length > 0) {
      await supabaseAdmin
        .from('source_field_acknowledgments')
        .delete()
        .eq('project_id', tm.project_id)
        .in('source_field_id', sourceFieldIds)
    }

    await supabase
      .from('table_mappings')
      .update({ status: 'needs_review' })
      .eq('id', tableMappingId)

    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) {
      return { success: false, fieldCount: 0, error: rateLimit.error, errorCode: 'VALIDATION' }
    }

    const genResult = await runMappingGenerationForPair({
      supabase,
      userId: user.id,
      projectId: tm.project_id,
      tableMappingId,
      sourceTableId: tm.source_table_id,
      targetTableId: tm.target_table_id,
    })

    if (!genResult.error && genResult.inserted > 0) {
      const { data: allTfms } = await supabaseAdmin
        .from('target_field_mappings')
        .select('confidence')
        .eq('project_id', tm.project_id)
        .in('target_field_id', targetFieldIds)
      const confs = (allTfms ?? [])
        .map((t) => t.confidence)
        .filter((c): c is number => c !== null && c !== undefined)
      if (confs.length > 0) {
        const avg = Math.round(confs.reduce((a, c) => a + c, 0) / confs.length)
        await supabase.from('table_mappings').update({ confidence: avg }).eq('id', tableMappingId)
      }
    }

    return {
      success: !genResult.error,
      fieldCount: genResult.inserted,
      transformsReset: resetResult.transformsReset,
      stagedRowsReverted: resetResult.stagedRowsReverted,
      error: genResult.error,
      errorCode: genResult.error ? 'INTERNAL' : undefined,
    }
  })
}

// ─── approveAllFieldMappings (Refinement 3: preserve existing acks) ──────────
//
// "Approve All" is an explicit user intent to approve every TFM that feeds
// this TM pairing AND to acknowledge every unmapped field on both sides.
// Refinement 3 requires us to NOT clobber existing acks with different
// reasons — so we SELECT existing acks first and UPSERT only the new ones.
// The bulk path uses direct upserts (not looped RPCs) per Concern 2 —
// each RPC fire would retrigger the confidence recomputation and create
// excessive log noise on large tables.

const APPROVE_ALL_REASON = 'approved_via_approve_all'

export async function approveAllFieldMappings(
  tableMappingId: string,
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tm.project_id, async () => {
    // Find every TFM that renders under this TM pairing.
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.target_table_id)
    const targetFieldIds = (targetFields ?? []).map((f) => f.id)

    const { data: sourceFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.source_table_id)
    const sourceFieldIds = (sourceFields ?? []).map((f) => f.id)

    const { data: allTfms } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, target_field_id, combination_type, is_acknowledged, status')
      .eq('project_id', tm.project_id)
      .in('target_field_id', targetFieldIds.length > 0 ? targetFieldIds : ['00000000-0000-0000-0000-000000000000'])

    // Purge rejected ghosts (same rationale as before: explicit approve intent).
    const rejectedIds = (allTfms ?? []).filter((t) => t.status === 'rejected').map((t) => t.id)
    if (rejectedIds.length > 0) {
      await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .in('id', rejectedIds)
    }

    // For non-VA mapped TFMs, scope to this TM's source_table via mapping_sources.
    const nonAckMapped = (allTfms ?? []).filter(
      (t) => !t.is_acknowledged && t.status !== 'rejected' && t.combination_type !== 'custom_sql',
    )
    const mappedIds = nonAckMapped.map((t) => t.id)
    let tmPairingTfmIds: string[] = []
    if (mappedIds.length > 0) {
      const { data: ms } = await supabaseAdmin
        .from('mapping_sources')
        .select('target_field_mapping_id')
        .in('target_field_mapping_id', mappedIds)
        .eq('source_table_id', tm.source_table_id)
      tmPairingTfmIds = [
        ...new Set(
          (ms ?? [])
            .map((m) => m.target_field_mapping_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ]
    }

    // VAs live under every matching TM, so include all non-ack VAs on this target_table.
    const vaIds = (allTfms ?? [])
      .filter(
        (t) => t.combination_type === 'custom_sql' && !t.is_acknowledged && t.status !== 'rejected',
      )
      .map((t) => t.id)

    const toApprove = [...tmPairingTfmIds, ...vaIds]
    if (toApprove.length > 0) {
      await supabaseAdmin
        .from('target_field_mappings')
        .update({ status: 'approved' })
        .in('id', toApprove)
    }

    // Identify target fields already covered by a non-rejected TFM.
    const coveredTargetIds = new Set(
      (allTfms ?? [])
        .filter((t) => t.status !== 'rejected')
        .map((t) => t.target_field_id),
    )
    const unmappedTargetIds = targetFieldIds.filter((id) => !coveredTargetIds.has(id))

    // Refinement 3: exclude fields already covered by a (non-rejected) ack.
    // Existing target-side acks are TFM rows with is_acknowledged=true.
    const existingTargetAckIds = new Set(
      (allTfms ?? [])
        .filter((t) => t.is_acknowledged)
        .map((t) => t.target_field_id),
    )
    const targetIdsToAck = unmappedTargetIds.filter((id) => !existingTargetAckIds.has(id))

    if (targetIdsToAck.length > 0) {
      const rows = targetIdsToAck.map((fid) => ({
        project_id: tm.project_id,
        target_field_id: fid,
        is_acknowledged: true,
        acknowledgment_reason: APPROVE_ALL_REASON,
        status: 'approved' as const,
        combination_type: null,
        combination_sql: null,
        confidence: null,
        ai_reasoning: null,
      }))
      await supabaseAdmin
        .from('target_field_mappings')
        .upsert(rows, { onConflict: 'project_id,target_field_id' })
    }

    // Source side. Determine mapped source_field_ids in this TM pairing.
    const { data: msForPairing } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_field_id, target_field_mapping_id')
      .eq('source_table_id', tm.source_table_id)
    const coveredSourceIds = new Set(
      (msForPairing ?? [])
        .filter(
          (m) =>
            m.source_field_id &&
            m.target_field_mapping_id &&
            (allTfms ?? [])
              .find((t) => t.id === m.target_field_mapping_id && t.status !== 'rejected'),
        )
        .map((m) => m.source_field_id!),
    )
    const unmappedSourceIds = sourceFieldIds.filter((id) => !coveredSourceIds.has(id))

    // Refinement 3: exclude fields already in source_field_acknowledgments.
    const { data: existingSrcAcks } = await supabaseAdmin
      .from('source_field_acknowledgments')
      .select('source_field_id')
      .eq('project_id', tm.project_id)
      .in('source_field_id', unmappedSourceIds.length > 0 ? unmappedSourceIds : ['00000000-0000-0000-0000-000000000000'])
    const existingSrcAckIds = new Set((existingSrcAcks ?? []).map((a) => a.source_field_id))
    const sourceIdsToAck = unmappedSourceIds.filter((id) => !existingSrcAckIds.has(id))

    if (sourceIdsToAck.length > 0) {
      const rows = sourceIdsToAck.map((fid) => ({
        project_id: tm.project_id,
        source_field_id: fid,
        reason: APPROVE_ALL_REASON,
        notes: null,
        acknowledged_by: user.id,
        acknowledged_at: new Date().toISOString(),
      }))
      await supabaseAdmin
        .from('source_field_acknowledgments')
        .upsert(rows, { onConflict: 'project_id,source_field_id' })
    }

    await supabase.from('table_mappings').update({ status: 'approved' }).eq('id', tableMappingId)
    return { success: true }
  })
}

// ─── rejectAllFieldMappings ──────────────────────────────────────────────────

export async function rejectAllFieldMappings(
  tableMappingId: string,
): Promise<{ success: boolean; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tm.project_id, async () => {
    const { data: targetFields } = await supabase
      .from('fields')
      .select('id')
      .eq('table_id', tm.target_table_id)
    const targetFieldIds = (targetFields ?? []).map((f) => f.id)

    if (targetFieldIds.length > 0) {
      const { data: allTfms } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, combination_type, is_acknowledged')
        .eq('project_id', tm.project_id)
        .in('target_field_id', targetFieldIds)

      const mappedIds = (allTfms ?? [])
        .filter((t) => !t.is_acknowledged && t.combination_type !== 'custom_sql')
        .map((t) => t.id)

      let toReject: string[] = []
      if (mappedIds.length > 0) {
        const { data: ms } = await supabaseAdmin
          .from('mapping_sources')
          .select('target_field_mapping_id')
          .in('target_field_mapping_id', mappedIds)
          .eq('source_table_id', tm.source_table_id)
        toReject = [
          ...new Set(
            (ms ?? [])
              .map((m) => m.target_field_mapping_id)
              .filter((id): id is string => Boolean(id)),
          ),
        ]
      }

      if (toReject.length > 0) {
        await supabaseAdmin
          .from('target_field_mappings')
          .update({ status: 'rejected' })
          .in('id', toReject)
      }
    }

    await recomputeTableMappingStatus(supabase, tableMappingId)
    revalidatePath(`/app/projects/${tm.project_id}/transform`)
    return { success: true }
  })
}

// ─── approveHighConfidenceMappings ───────────────────────────────────────────

export async function approveHighConfidenceMappings(
  projectId: string,
  threshold = 85,
): Promise<{ success: boolean; count: number; error?: string; errorCode?: MappingWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, count: 0, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, count: 0, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(projectId, async () => {
    const { data: updated, error } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved' })
      .eq('project_id', projectId)
      .eq('status', 'needs_review')
      .eq('is_acknowledged', false)
      .gte('confidence', threshold)
      .select('id, target_field_id')
    if (error) return { success: false, count: 0, error: error.message, errorCode: 'INTERNAL' }

    const count = updated?.length ?? 0

    // Recompute each affected TM.
    if (count > 0) {
      const targetFieldIds = [...new Set((updated ?? []).map((t) => t.target_field_id))]
      const { data: tgtFields } = await supabase
        .from('fields')
        .select('table_id')
        .in('id', targetFieldIds)
      const targetTableIds = [...new Set((tgtFields ?? []).map((f) => f.table_id))]
      const { data: tms } = await supabase
        .from('table_mappings')
        .select('id')
        .eq('project_id', projectId)
        .in('target_table_id', targetTableIds.length > 0 ? targetTableIds : ['00000000-0000-0000-0000-000000000000'])
      for (const tmRow of tms ?? []) {
        await recomputeTableMappingStatus(supabase, tmRow.id)
      }
    }

    return { success: true, count }
  })
}

// ─── suggestRemainingMappings ────────────────────────────────────────────────

export async function suggestRemainingMappings(
  tableMappingId: string,
): Promise<{
  success: boolean
  newMappingsCount: number
  error?: string
  errorCode?: MappingWriteErrorCode
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, newMappingsCount: 0, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) {
    return { success: false, newMappingsCount: 0, error: rateLimit.error, errorCode: 'VALIDATION' }
  }

  const { data: tm } = await supabaseAdmin
    .from('table_mappings')
    .select('*')
    .eq('id', tableMappingId)
    .single()
  if (!tm) return { success: false, newMappingsCount: 0, error: 'Table mapping not found', errorCode: 'NOT_FOUND' }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) return { success: false, newMappingsCount: 0, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(tm.project_id, async () => {
    // Discover already-mapped fields in this TM pairing.
    const { data: tgtFields } = await supabase
      .from('fields')
      .select('id, name, data_type, is_primary_key, is_foreign_key, is_nullable')
      .eq('table_id', tm.target_table_id)
      .order('ordinal_position', { ascending: true })
    const { data: srcFields } = await supabase
      .from('fields')
      .select('id, name, data_type, is_primary_key, is_foreign_key, is_nullable')
      .eq('table_id', tm.source_table_id)
      .order('ordinal_position', { ascending: true })

    const tgtIds = (tgtFields ?? []).map((f) => f.id)
    const { data: existingTfms } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, target_field_id, is_acknowledged, status, combination_type')
      .eq('project_id', tm.project_id)
      .in('target_field_id', tgtIds.length > 0 ? tgtIds : ['00000000-0000-0000-0000-000000000000'])

    const mappedTgtIds = new Set(
      (existingTfms ?? [])
        .filter((t) => t.status !== 'rejected')
        .map((t) => t.target_field_id),
    )

    const mappedTfmIds = (existingTfms ?? [])
      .filter((t) => t.status !== 'rejected' && !t.is_acknowledged && t.combination_type !== 'custom_sql')
      .map((t) => t.id)
    const { data: msRows } = mappedTfmIds.length > 0
      ? await supabaseAdmin
          .from('mapping_sources')
          .select('source_field_id')
          .in('target_field_mapping_id', mappedTfmIds)
          .eq('source_table_id', tm.source_table_id)
      : { data: [] as { source_field_id: string | null }[] }
    const mappedSrcIds = new Set(
      (msRows ?? [])
        .map((m) => m.source_field_id)
        .filter((id): id is string => Boolean(id)),
    )

    const unmapSrc = (srcFields ?? []).filter((f) => !mappedSrcIds.has(f.id))
    const unmapTgt = (tgtFields ?? []).filter((f) => !mappedTgtIds.has(f.id))
    if (unmapSrc.length === 0 || unmapTgt.length === 0) {
      return { success: true, newMappingsCount: 0 }
    }

    const { data: srcT } = await supabase
      .from('tables')
      .select('name, datasets(name)')
      .eq('id', tm.source_table_id)
      .single()
    const { data: tgtT } = await supabase
      .from('tables')
      .select('name, datasets(name)')
      .eq('id', tm.target_table_id)
      .single()
    const rawSrcDs = srcT?.datasets as unknown
    const srcDsN = Array.isArray(rawSrcDs)
      ? (rawSrcDs[0]?.name ?? 'source')
      : ((rawSrcDs as { name?: string } | null)?.name ?? 'source')
    const rawTgtDs = tgtT?.datasets as unknown
    const tgtDsN = Array.isArray(rawTgtDs)
      ? (rawTgtDs[0]?.name ?? 'target')
      : ((rawTgtDs as { name?: string } | null)?.name ?? 'target')

    const remCtx = await buildAIContext(
      tm.project_id,
      {
        tableIds: [tm.source_table_id, tm.target_table_id],
        fieldIds: [...unmapSrc.map((f) => f.id), ...unmapTgt.map((f) => f.id)],
        includeValueDistributions: true,
        includeSampleValues: true,
        includeDocuments: true,
        maxDistributionValues: 15,
        maxSampleValues: 5,
      },
      user.id,
    )

    const srcCtxByName = new Map(
      remCtx.source_tables.flatMap((t) => t.fields).map((f) => [f.name.toLowerCase(), f]),
    )
    const tgtCtxByName = new Map(
      remCtx.target_tables.flatMap((t) => t.fields).map((f) => [f.name.toLowerCase(), f]),
    )

    type UnmapFieldRow = {
      id: string
      name: string
      data_type: string
      is_primary_key: boolean
      is_foreign_key: boolean
      is_nullable: boolean
    }

    function fLine(
      f: UnmapFieldRow,
      ctxByName: Map<
        string,
        {
          value_distribution: { value: string; count: number }[]
          sample_values: string[]
        }
      >,
    ): string {
      const tags: string[] = []
      if (f.is_primary_key) tags.push('PK')
      if (f.is_foreign_key) tags.push('FK')
      if (f.is_nullable) tags.push('nullable')
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
      const ctx = ctxByName.get(f.name.toLowerCase())
      let line = `  - ${f.name} (${f.data_type})${tagStr}`
      if (ctx?.value_distribution?.length) {
        const top = ctx.value_distribution.slice(0, 10)
        line += `\n    Values: ${top.map((v) => `"${v.value}"(${v.count})`).join(', ')}`
      } else if (ctx?.sample_values?.length) {
        line += `\n    Samples: ${ctx.sample_values.slice(0, 5).map((v) => `"${v}"`).join(', ')}`
      }
      return line
    }

    const remDocBlock = formatDocumentsForPrompt(remCtx.documents)
    const userMsg = `Source ${srcDsN}.${srcT?.name} \u2192 Target ${tgtDsN}.${tgtT?.name}. Suggest mappings for these UNMAPPED fields only.

<source_unmapped>
${unmapSrc.map((f) => fLine(f, srcCtxByName)).join('\n')}
</source_unmapped>
<target_unmapped>
${unmapTgt.map((f) => fLine(f, tgtCtxByName)).join('\n')}
</target_unmapped>
${remDocBlock}
${remCtx.intelligence_context ? remCtx.intelligence_context + '\n\n' : ''}CRITICAL: Use ONLY the bare field name (not table.field). Respond with ONLY valid JSON:
{"field_mappings":[{"source_field":"name","target_field":"name","confidence":75,"reasoning":"reason","similar_fields_considered":[],"type_compatibility":"TYPE\u2192TYPE"}]}`

    // PR 12 H1: tool use under flag ON; legacy text+JSON.parse under flag OFF.
    const phase2EnabledBulk = process.env.AI_PHASE_2_ENABLED === '1'
    let parsed: { field_mappings: ClaudeFieldMapping[] }
    let suggestCallId: string | null = null
    try {
      const result = await callLLM({
        feature: 'mapping_suggest_legacy_bulk',
        systemPrompt: 'You are a data migration expert. Return ONLY valid JSON.',
        userMessage: userMsg,
        maxTokens: 4096,
        projectId: tm.project_id,
        userId: user.id,
        promptVersion: 'mapping-suggest-legacy-bulk-v1',
        abuseUserId: user.id,
        metadata: { table_mapping_id: tableMappingId },
        ...(phase2EnabledBulk && { tool: EMIT_FIELD_MAPPINGS_TOOL }),
      })
      suggestCallId = result.callId
      if (result.kind === 'toolUse') {
        parsed = result.toolUse.input as { field_mappings: ClaudeFieldMapping[] }
        if (!Array.isArray(parsed.field_mappings)) throw new Error('bad structure')
      } else {
        let cleaned = result.text.trim()
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
        }
        parsed = JSON.parse(cleaned)
        if (!Array.isArray(parsed.field_mappings)) throw new Error('bad structure')
      }
    } catch {
      return {
        success: false,
        newMappingsCount: 0,
        error: 'AI returned invalid response. Please try again.',
        errorCode: 'INTERNAL',
      }
    }

    function bareN(s: string | null | undefined): string {
      if (!s || typeof s !== 'string') return ''
      return s.split('.').pop()!.toLowerCase().trim()
    }

    const srcFMap = new Map(
      unmapSrc.map((f) => [f.name.toLowerCase(), { id: f.id, name: f.name }]),
    )
    const tgtFMap = new Map(
      unmapTgt.map((f) => [f.name.toLowerCase(), { id: f.id, name: f.name }]),
    )

    // Race guard: re-read existing TFMs on the pairing and drop any
    // incoming suggestion whose target already resolved to a non-rejected TFM.
    const { data: raceTfms } = await supabaseAdmin
      .from('target_field_mappings')
      .select('target_field_id, status')
      .eq('project_id', tm.project_id)
      .in('target_field_id', unmapTgt.length > 0 ? unmapTgt.map((f) => f.id) : ['00000000-0000-0000-0000-000000000000'])
    const racedTargetIds = new Set(
      (raceTfms ?? [])
        .filter((t) => t.status !== 'rejected')
        .map((t) => t.target_field_id),
    )

    const safeMappings = parsed.field_mappings.filter((fm) => {
      const sf = srcFMap.get(bareN(fm.source_field))
      const tf = tgtFMap.get(bareN(fm.target_field))
      if (!sf || !tf) return false
      if (racedTargetIds.has(tf.id)) return false
      return true
    })

    const persistStartIso = new Date().toISOString()
    const persistRes = await persistClaudeFieldMappingsForTM({
      supabase,
      projectId: tm.project_id,
      tableMappingId,
      sourceFieldMap: srcFMap,
      targetFieldMap: tgtFMap,
      fieldMappings: safeMappings,
      sourceTableId: tm.source_table_id,
    })

    // Provenance: same post-call SELECT pattern as runMappingGenerationForPair.
    // The persist call routes through the dq_create_target_field_mapping RPC,
    // so direct .from('target_field_mappings').insert is not visible to the
    // audit invariant test — we emit anyway for eval-harness traceability.
    if (persistRes.inserted > 0) {
      const { data: createdTfms } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, target_field_id, confidence, ai_reasoning')
        .eq('project_id', tm.project_id)
        .gte('created_at', persistStartIso)
      const { data: createdMs } = await supabaseAdmin
        .from('mapping_sources')
        .select('target_field_mapping_id')
        .eq('source_table_id', tm.source_table_id)
        .gte('created_at', persistStartIso)
      const tfmIdsWithSources = new Set(
        (createdMs ?? []).map(
          (r) => (r as { target_field_mapping_id: string }).target_field_mapping_id,
        ),
      )
      for (const tfm of createdTfms ?? []) {
        if (!tfmIdsWithSources.has(tfm.id)) continue
        void logAIEdit({
          projectId: tm.project_id,
          actorId: user.id,
          entityType: 'target_field_mapping',
          entityId: tfm.id,
          fieldPath: 'confidence',
          oldValue: null,
          newValue: {
            confidence: tfm.confidence,
            ai_reasoning: tfm.ai_reasoning,
            target_field_id: tfm.target_field_id,
          },
          editKind: 'ai_proposed',
          llmCallId: suggestCallId,
          metadata: {
            source_table_id: tm.source_table_id,
            target_table_id: tm.target_table_id,
            table_mapping_id: tableMappingId,
            origin: 'suggest_remaining',
          },
        })
      }
    }

    return { success: true, newMappingsCount: persistRes.inserted }
  })
}
