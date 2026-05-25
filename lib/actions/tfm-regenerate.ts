/**
 * PR δ — AI re-run hook on TFM edits.
 *
 * After a user-initiated edit clears `ai_reasoning` + `transformation_intent`
 * on a target_field_mapping (the locked-model behavior), this function
 * regenerates the cleared metadata by firing a single tool-use Claude call.
 *
 * Gated on `projects.poc_template != null` — pilot Rootstock-style projects
 * only. Non-pilot projects fall through with a success+skipped return and
 * preserve the existing "edit clears, user re-clicks Generate" semantics.
 *
 * ── Invocation ─────────────────────────────────────────────────────────────
 * Called from the four edit functions in `lib/actions/mappings-for-redesign.ts`
 * AFTER the edit's DB writes have committed:
 *   - updateMappingSourceField → trigger 'source_swap'
 *   - updateMappingTargetField → trigger 'target_swap'
 *   - editMappingSources       → trigger 'source_set_edit'
 *   - createMappingFromUnmapped→ trigger 'create_from_unmapped'
 *
 * Each callsite wraps the invocation in try-catch and logs failures —
 * a regenerate failure does NOT fail the user-facing edit response.
 *
 * ── Outputs ────────────────────────────────────────────────────────────────
 * The tool emits four fields:
 *   ai_reasoning, transformation_intent, needs_transformation, confidence
 *
 * Write path:
 *   • target_field_mappings: direct UPDATE for ai_reasoning,
 *     transformation_intent, needs_transformation, updated_at.
 *   • confidence: routes through mapping_sources for mapped TFMs
 *     (uniform value across all source rows, MIN-trigger picks it up);
 *     direct TFM write for VAs (combination_type='custom_sql'). Mirrors
 *     `clearMappingConfidenceForEdit` at mappings-for-redesign.ts:4012-4030.
 *
 * NOT touched: `original_ai_reasoning` (this is a regenerate, not a first
 * proposal; touching it would corrupt the eval harness's "did the user
 * accept the AI's original proposal?" signal).
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 * One `ai_edit_history` row written via `logAIEdit` (fire-and-forget) with
 * editKind='ai_proposed', virtual fieldPath='regenerated_metadata',
 * newValue=JSON.stringify(emitted), oldValue=null (the clear set the
 * pre-state to null). Mirrors the AI-Suggest provenance pattern at
 * lib/actions/transformations.ts:3192-3203.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { callLLM } from '@/lib/ai/llm-client'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'
import { EMIT_TFM_METADATA_TOOL } from '@/lib/ai/tool-schemas'
import {
  buildAIContext,
  formatFieldForPrompt,
  formatDocumentsForPrompt,
  formatPocAnswerKeyBlock,
} from '@/lib/ai/context-builder'
import {
  formatLookupTablesBlock,
  formatProjectDecisionsBlock,
  formatTransformationIntentBlock,
} from '@/lib/ai/project-context-blocks'
import { resolveTransformationIntent } from '@/lib/utils/transformation-intent'
import { loadTfmContext, loadProjectContextBlocks } from '@/lib/actions/transformations'
import { logAIEdit } from '@/lib/actions/ai-edit-history'

// ─── Types ──────────────────────────────────────────────────────────────────

export type TfmRegenerateTrigger =
  | 'source_swap'
  | 'target_swap'
  | 'source_set_edit'
  | 'create_from_unmapped'

export type TfmRegenerateResult =
  | {
      success: true
      /** Set when the function short-circuited without an LLM call. */
      skipped?: 'no_poc_template' | 'no_tfm'
    }
  | { success: false; error: string }

interface RegenerateOpts {
  triggerSource: TfmRegenerateTrigger
  /**
   * The acting user's id. Required for `ai_edit_history.actor_id`. All four
   * production callsites already have `user.id` in scope from their own
   * auth lookup, so threading it through is cheaper than re-resolving here.
   */
  userId: string
}

// ─── System prompt ──────────────────────────────────────────────────────────

const REGENERATE_SYSTEM_PROMPT = `You are Settle's mapping-metadata regenerator. A user just edited a target_field_mapping (source-swap, target-swap, source-set edit, or fresh creation). The mapping's previous AI commentary was cleared by the system because it described a relationship that no longer exists. Your job: emit fresh, accurate metadata for the CURRENT mapping state.

You will receive:
  - The current source field(s) and target field with their schema/profile
  - <mapping_context> describing the current TFM state
  - Project-scoped context: <lookup_tables>, <project_decisions>, <documentation>
  - When present, an authoritative <poc_answer_key authoritative="true"> block
    listing the customer-approved metadata for this and other fields. When
    this block exists, it overrides any inferred guesses you would otherwise make.

Emit ONE tool call to emit_tfm_metadata with four fields:
  - ai_reasoning: concise prose (≤500 chars) explaining why this mapping makes sense
  - transformation_intent: NL description of the needed transformation, or null for passthroughs
  - needs_transformation: boolean — true iff Transform tab should show "Define"
  - confidence: integer 0-100, calibrated per the tool description

Be terse. This is machine-consumed metadata, not customer-facing copy. Do NOT explain your reasoning before emitting the tool — emit the tool directly.`

// ─── Main ───────────────────────────────────────────────────────────────────

export async function regenerateTfmMetadata(
  tfmId: string,
  opts: RegenerateOpts,
): Promise<TfmRegenerateResult> {
  // 1. Load TFM context. Lost-race (TFM deleted post-edit) → no-op success.
  const ctx = await loadTfmContext(tfmId)
  if (!ctx) {
    return { success: true, skipped: 'no_tfm' }
  }

  // 2. Pilot-safety gate: only fire for projects with poc_template set.
  const { data: project, error: projectErr } = await supabaseAdmin
    .from('projects')
    .select('poc_template')
    .eq('id', ctx.projectId)
    .maybeSingle<{ poc_template: string | null }>()
  if (projectErr) {
    console.error(
      `[tfm-regenerate] project read failed for tfm=${tfmId}: ${projectErr.message}`,
    )
    return { success: false, error: `project read: ${projectErr.message}` }
  }
  if (!project?.poc_template) {
    // Non-pilot project: preserve existing edit-clears-then-manual-click
    // semantics. No LLM call, no DB write, no audit row.
    console.log(
      `[tfm-regenerate] skipped: project ${ctx.projectId} has no poc_template; tfmId=${tfmId}`,
    )
    return { success: true, skipped: 'no_poc_template' }
  }

  console.log(
    `[tfm-regenerate] firing: tfm=${tfmId} trigger=${opts.triggerSource} ` +
      `poc_template=${project.poc_template}`,
  )
  const t0 = Date.now()

  // 3. Build user message (mirrors suggestTransformDescription's context
  //    assembly, plus <contributing_source_fields> for many-to-one TFMs).
  const srcField = ctx.primarySource?.sourceField ?? null
  const tgtField = ctx.targetField

  const { data: tgtFieldFull } = await supabaseAdmin
    .from('fields')
    .select('id, name, data_type, inferred_type, is_nullable')
    .eq('id', tgtField.id)
    .single()
  if (!tgtFieldFull) {
    return { success: false, error: 'Target field not found' }
  }

  const { data: srcFieldFull } = srcField
    ? await supabaseAdmin
        .from('fields')
        .select('id, name, data_type, inferred_type, is_nullable')
        .eq('id', srcField.id)
        .single()
    : { data: null }
  if (srcField && !srcFieldFull) {
    return { success: false, error: 'Source field not found' }
  }

  // Collect IDs for the context builder. Include contributors so
  // field_profiles for every source field land in the prompt.
  const contributorFieldIds = ctx.contributors
    .map((c) => c.sourceFieldId)
    .filter((id) => id.length > 0)
  const fieldIds = srcField
    ? [srcField.id, tgtField.id, ...contributorFieldIds]
    : [tgtField.id, ...contributorFieldIds]

  let tableIds: string[]
  if (ctx.tableMapping) {
    tableIds = [ctx.tableMapping.source_table_id, ctx.tableMapping.target_table_id]
  } else {
    const { data: anyTm } = await supabaseAdmin
      .from('table_mappings')
      .select('source_table_id, target_table_id')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', tgtField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle<{ source_table_id: string; target_table_id: string }>()
    tableIds = anyTm
      ? [anyTm.source_table_id, anyTm.target_table_id]
      : [tgtField.table_id]
  }

  const aiCtx = await buildAIContext(
    ctx.projectId,
    {
      tableIds,
      fieldIds,
      includeProfilingStats: true,
      includeValueDistributions: true,
      includeSampleValues: true,
      includeDocuments: true,
      maxDistributionValues: 20,
    },
    opts.userId,
  )

  const srcFieldCtx = srcField
    ? aiCtx.source_tables.flatMap((t) => t.fields).find((f) => f.name === srcField.name)
    : null
  const tgtFieldCtx = aiCtx.target_tables
    .flatMap((t) => t.fields)
    .find((f) => f.name === tgtField.name)
  const docsBlock = formatDocumentsForPrompt(aiCtx.documents)
  const pocBlock = formatPocAnswerKeyBlock(aiCtx.documents.poc_answer_key)

  const { decisions: projectDecisions, lookupTables: projectLookupTables } =
    await loadProjectContextBlocks(ctx.projectId)
  const lookupTablesBlock = formatLookupTablesBlock(projectLookupTables)
  const projectDecisionsBlock = formatProjectDecisionsBlock(projectDecisions)

  // transformation_intent is null on the cleared TFM, but resolveTransformationIntent
  // can still recover a legacy [Combination: …] fragment from ai_reasoning if any.
  // For an edit-cleared TFM both are null, so this block ends up empty — fine.
  const resolvedIntent = resolveTransformationIntent(
    ctx.tfm.transformation_intent,
    ctx.tfm.ai_reasoning,
  )
  const transformationIntentBlock = formatTransformationIntentBlock(resolvedIntent)

  // <contributing_source_fields> — emits each contributor field block when
  // the TFM has >1 source. Closes the AI-Suggest coverage gap for many-to-one
  // mappings (the source-set edit case relies on this).
  let contributingBlock = ''
  if (ctx.contributors.length > 0) {
    const lines: string[] = ['<contributing_source_fields>']
    for (const c of ctx.contributors) {
      const fld = aiCtx.source_tables.flatMap((t) => t.fields).find((f) => f.field_id === c.sourceFieldId)
      if (fld) {
        lines.push(formatFieldForPrompt(fld))
      } else if (c.sourceField) {
        lines.push(`${c.sourceField.name} (${c.sourceField.data_type})`)
      }
    }
    lines.push('</contributing_source_fields>')
    contributingBlock = lines.join('\n') + '\n'
  }

  const sourceBlock = srcFieldFull
    ? `<source_field>\n${
        srcFieldCtx
          ? formatFieldForPrompt(srcFieldCtx)
          : `${(srcFieldFull as { name: string }).name} (${(srcFieldFull as { data_type: string }).data_type})\n  Nullable: ${(srcFieldFull as { is_nullable: boolean }).is_nullable}`
      }\n</source_field>`
    : `<source_field>\nNo source field — this is a value assignment. Define a constant or expression for the target field.\n</source_field>`

  const userMessage = `${sourceBlock}

<target_field>
${(tgtFieldFull as { name: string }).name} (${(tgtFieldFull as { data_type: string }).data_type}${
    (tgtFieldFull as { inferred_type?: string | null }).inferred_type
      ? `, ${(tgtFieldFull as { inferred_type?: string | null }).inferred_type}`
      : ''
  })
Nullable: ${(tgtFieldFull as { is_nullable: boolean }).is_nullable}
${tgtFieldCtx && tgtFieldCtx.cardinality > 0 ? `Distinct values: ${tgtFieldCtx.cardinality}` : ''}
</target_field>

${contributingBlock}<mapping_context>
Combination type: ${ctx.tfm.combination_type ?? 'Not specified'}
Trigger: ${opts.triggerSource}
This mapping was just edited by the user; previous AI commentary was cleared because it no longer matched the current source→target relationship.
</mapping_context>
${lookupTablesBlock ? '\n' + lookupTablesBlock + '\n' : ''}${projectDecisionsBlock ? '\n' + projectDecisionsBlock + '\n' : ''}${docsBlock}
${aiCtx.intelligence_context ? aiCtx.intelligence_context + '\n\n' : ''}${transformationIntentBlock ? transformationIntentBlock + '\n\n' : ''}${pocBlock ? pocBlock + '\n\n' : ''}Emit emit_tfm_metadata with fresh AI metadata for this mapping in its current state.`

  // 4. LLM call (tool-use).
  let emitted: {
    ai_reasoning: string
    transformation_intent: string | null
    needs_transformation: boolean
    confidence: number
  }
  let llmCallId: string | null = null
  try {
    const result = await callLLM({
      feature: 'mapping_regenerate',
      systemPrompt: withProvenanceGuidance(REGENERATE_SYSTEM_PROMPT),
      userMessage,
      maxTokens: 1024,
      projectId: ctx.projectId,
      userId: opts.userId,
      promptVersion: 'tfm-regenerate-v1',
      abuseUserId: opts.userId,
      tool: EMIT_TFM_METADATA_TOOL,
      cacheControl: true,
      metadata: { tfm_id: ctx.tfm.id, trigger_source: opts.triggerSource },
    })
    if (result.kind !== 'toolUse') {
      console.error(
        `[tfm-regenerate] LLM returned non-tool result for tfm=${tfmId}; kind=${result.kind}`,
      )
      return { success: false, error: 'LLM did not emit the expected tool call' }
    }
    const input = result.toolUse.input
    emitted = {
      ai_reasoning: String(input.ai_reasoning ?? ''),
      transformation_intent:
        input.transformation_intent === null || input.transformation_intent === undefined
          ? null
          : String(input.transformation_intent),
      needs_transformation: Boolean(input.needs_transformation),
      confidence: Math.round(Number(input.confidence ?? 0)),
    }
    llmCallId = result.callId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[tfm-regenerate] LLM call failed for tfm=${tfmId}: ${msg}`)
    return { success: false, error: `LLM call failed: ${msg}` }
  }

  // 5. Write TFM-level columns (ai_reasoning, transformation_intent,
  //    needs_transformation, updated_at). NOT original_ai_reasoning.
  const { error: tfmErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      ai_reasoning: emitted.ai_reasoning,
      transformation_intent: emitted.transformation_intent,
      needs_transformation: emitted.needs_transformation,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfmId)
  if (tfmErr) {
    console.error(`[tfm-regenerate] TFM update failed for tfm=${tfmId}: ${tfmErr.message}`)
    return { success: false, error: `TFM update: ${tfmErr.message}` }
  }

  // 6. Write confidence. VA → direct TFM (trigger skips custom_sql per
  //    migration 074:376). Mapped → uniform per-source value (trigger
  //    fires AFTER UPDATE on mapping_sources, computes TFM.confidence
  //    = MIN(...) = emitted.confidence). Mirrors the VA-vs-mapped branch
  //    in clearMappingConfidenceForEdit at mappings-for-redesign.ts:4012-4030.
  if (ctx.tfm.combination_type === 'custom_sql') {
    const { error: confErr } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ confidence: emitted.confidence })
      .eq('id', tfmId)
    if (confErr) {
      console.error(
        `[tfm-regenerate] VA confidence update failed for tfm=${tfmId}: ${confErr.message}`,
      )
      return { success: false, error: `VA confidence update: ${confErr.message}` }
    }
  } else {
    const { error: confErr } = await supabaseAdmin
      .from('mapping_sources')
      .update({ confidence: emitted.confidence })
      .eq('target_field_mapping_id', tfmId)
    if (confErr) {
      console.error(
        `[tfm-regenerate] mapped confidence update failed for tfm=${tfmId}: ${confErr.message}`,
      )
      return { success: false, error: `Mapped confidence update: ${confErr.message}` }
    }
  }

  // 7. Audit: one ai_edit_history row anchored on the parent TFM. Mirrors
  //    the AI-Suggest provenance pattern at lib/actions/transformations.ts:3192-3203.
  //    Fire-and-forget — losing an audit row is preferable to failing the
  //    user-facing edit response.
  void logAIEdit({
    projectId: ctx.projectId,
    actorId: opts.userId,
    entityType: 'target_field_mapping',
    entityId: tfmId,
    fieldPath: 'regenerated_metadata',
    oldValue: null,
    newValue: JSON.stringify(emitted),
    editKind: 'ai_proposed',
    llmCallId,
    metadata: { tfm_id: tfmId, trigger_source: opts.triggerSource },
  })

  console.log(
    `[tfm-regenerate] ok: tfm=${tfmId} trigger=${opts.triggerSource} ` +
      `confidence=${emitted.confidence} latency=${Date.now() - t0}ms`,
  )

  return { success: true }
}
