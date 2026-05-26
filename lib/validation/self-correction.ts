/**
 * Self-correction loop: deterministic validation → LLM re-proposal.
 *
 * Sits between AI proposal and persistence. Runs the deterministic
 * validator on each proposed mapping. If hard errors are found, feeds
 * them back to the LLM as structured correction prompts. Loops up to
 * MAX_CORRECTION_ITERATIONS times. Soft warnings pass through to the
 * human with badges.
 *
 * Option C architecture:
 *   Stage 1 (this module): AI proposes → validate → re-propose if errors → repeat
 *   Stage 2 (UI component): surviving mappings display with green/yellow/red badges
 *
 * Three exit conditions:
 *   1. UNRECOVERABLE — all remaining errors are schema-structural (LLM can't fix)
 *   2. Zero improvement delta — same hard errors between consecutive iterations
 *   3. Hard cap at MAX_CORRECTION_ITERATIONS — route to human
 *
 * No side effects beyond LLM calls. Does not persist anything.
 */

import { callLLMStreaming, type CallLLMResult, type LLMFeature } from '@/lib/ai/llm-client'
import { EMIT_TABLE_MAPPINGS_TOOL } from '@/lib/ai/tool-schemas'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'
import {
  MAPPING_GENERATION_AGENT_SYSTEM_PROMPT,
} from '@/lib/ai/mapping-engine'
import {
  validateMappingBatch,
  type MappingProposal,
  type SourceField,
  type TargetField,
  type ValidationResult,
} from '@/lib/validation/mapping-validator'
import type { ClaudeFieldMapping, ClaudeResponse, ClaudeTableMapping } from '@/lib/ai/mapping-engine'

// ─── Constants ──────────────────────────────────────────────────────

/** Max self-correction iterations before routing to human. */
const MAX_CORRECTION_ITERATIONS = 3

/**
 * Hard errors that trigger re-prompting — the LLM can address these
 * by picking a different target field, adding a transform, or changing
 * the mapping structure.
 */
const HARD_ERROR_CHECKS = new Set([
  'type_incompatible',
  'null_to_not_null',
  'fk_value_gap',
  'fk_orphan_risk',
  'unique_violation_risk',
  'many_to_one_collision',
  'fk_circular_dependency',
  'fk_load_order_violation',
])

/**
 * Structural errors that the LLM cannot resolve by re-mapping.
 * When ALL remaining hard errors fall in this set, exit immediately
 * (exit condition 1: UNRECOVERABLE).
 *
 * fk_circular_dependency / fk_load_order_violation are target-schema
 * invariants — the LLM can't fix the FK topology by changing source→target
 * field pairings.
 */
const UNRECOVERABLE_CHECKS = new Set([
  'fk_circular_dependency',
  'fk_load_order_violation',
])

// ─── Types ──────────────────────────────────────────────────────────

export interface CorrectionResult {
  /** The final (possibly corrected) LLM response. */
  response: ClaudeResponse
  /** The final LLM call result (for callId chaining). */
  llmResult: CallLLMResult
  /** Per-target-field validation results for UI badge rendering. */
  validationResults: Map<string, ValidationResult>
  /** How many correction iterations ran (0 = first pass was clean). */
  correctionsApplied: number
  /** Fields that still have hard errors after all exit conditions evaluated. */
  unresolvableFields: string[]
  /** Exit reason — for telemetry and human-routing decisions. */
  exitReason: 'clean' | 'unrecoverable' | 'no_improvement' | 'max_iterations' | 'llm_error'
}

export interface SelfCorrectionArgs {
  /** The initial parsed ClaudeResponse from the first LLM call. */
  initialResponse: ClaudeResponse
  /** The initial LLM CallResult (for callId chaining). */
  initialLlmResult: CallLLMResult
  /** Source fields for validation context. */
  sourceFields: Array<{ name: string; data_type: string; is_nullable: boolean; table_name?: string }>
  /** Target fields for validation context. */
  targetFields: Array<{
    name: string; data_type: string; is_nullable: boolean;
    is_primary_key?: boolean; is_unique?: boolean;
    is_foreign_key?: boolean; fk_reference?: string | null;
    enum_values?: string[]; max_length?: number | null;
  }>
  /** The original user message for re-prompting. */
  originalUserMessage: string
  /** LLM feature tag for telemetry. */
  feature: LLMFeature
  projectId: string
  userId: string
  maxTokens: number
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Convert a ClaudeFieldMapping + raw field metadata into a MappingProposal
 * that the validator understands.
 */
function toMappingProposal(
  fm: ClaudeFieldMapping,
  sourceFieldMap: Map<string, SelfCorrectionArgs['sourceFields'][number]>,
  targetFieldMap: Map<string, SelfCorrectionArgs['targetFields'][number]>,
): MappingProposal | null {
  const tgtRaw = targetFieldMap.get(fm.target_field.toLowerCase())
  if (!tgtRaw) return null

  const sourceFieldNames = fm.mapping_type === 'many_to_one' && fm.contributing_source_fields
    ? [fm.source_field, ...fm.contributing_source_fields]
    : [fm.source_field]

  const sourceFields: SourceField[] = sourceFieldNames
    .map(name => {
      const raw = sourceFieldMap.get(name.toLowerCase())
      if (!raw) return null
      return {
        name: raw.name,
        dataType: raw.data_type,
        isNullable: raw.is_nullable,
      }
    })
    .filter((f): f is SourceField => f !== null)

  if (sourceFields.length === 0) return null

  const targetField: TargetField = {
    name: tgtRaw.name,
    dataType: tgtRaw.data_type,
    isNullable: tgtRaw.is_nullable,
    isPrimaryKey: tgtRaw.is_primary_key ?? false,
    isUnique: tgtRaw.is_unique ?? false,
    isForeignKey: tgtRaw.is_foreign_key ?? false,
    fkReference: tgtRaw.fk_reference ?? null,
    maxLength: tgtRaw.max_length ?? null,
    enumValues: tgtRaw.enum_values,
  }

  return { sourceFields, targetField }
}

/**
 * Collect hard-error field names from validation results.
 * Returns a sorted serialized key (for delta comparison) and the name list.
 */
function collectHardErrors(
  validationResults: Map<string, ValidationResult>,
): { names: string[]; key: string } {
  const names: string[] = []
  for (const [fieldName, vr] of validationResults) {
    if (vr.issues.some(i => i.severity === 'error' && HARD_ERROR_CHECKS.has(i.check))) {
      names.push(fieldName)
    }
  }
  names.sort()
  return { names, key: names.join('|') }
}

/**
 * Build a correction prompt from validation errors.
 * Feeds specific error messages + suggestions back to the LLM.
 */
function buildCorrectionPrompt(
  originalMessage: string,
  tableMapping: ClaudeTableMapping,
  validationResults: Map<string, ValidationResult>,
): string {
  const errorSummaries: string[] = []

  for (const fm of tableMapping.field_mappings) {
    const vr = validationResults.get(fm.target_field)
    if (!vr) continue

    const hardErrors = vr.issues.filter(i =>
      i.severity === 'error' && HARD_ERROR_CHECKS.has(i.check)
    )
    if (hardErrors.length === 0) continue

    for (const err of hardErrors) {
      errorSummaries.push(
        `- MAPPING ERROR: ${fm.source_field} → ${fm.target_field}: ${err.message}` +
        (err.suggestion ? `\n  FIX: ${err.suggestion}` : '')
      )
    }
  }

  if (errorSummaries.length === 0) return originalMessage

  return `${originalMessage}

<validation_errors>
The following mappings have deterministic validation errors. You MUST fix these by either:
1. Proposing a different target field
2. Adding a transformation SQL (e.g., CAST, COALESCE, LEFT()) to resolve the type/constraint mismatch
3. Splitting or combining source fields differently

Do NOT simply repeat the same mapping — the same check will fail again.

${errorSummaries.join('\n')}
</validation_errors>`
}

// ─── Main entry ─────────────────────────────────────────────────────

/**
 * Run the self-correction loop on an AI-proposed mapping.
 *
 * 1. Validate the initial response
 * 2. Check exit conditions (clean, unrecoverable, no-improvement, max-iterations)
 * 3. If errors remain and are addressable, re-prompt with error context
 * 4. Return the final response + validation results for UI badges
 */
export async function runSelfCorrectionLoop(
  args: SelfCorrectionArgs,
): Promise<CorrectionResult> {
  const {
    sourceFields,
    targetFields,
    originalUserMessage,
    feature,
    projectId,
    userId,
    maxTokens,
  } = args

  const sourceFieldMap = new Map(sourceFields.map(f => [f.name.toLowerCase(), f]))
  const targetFieldMap = new Map(targetFields.map(f => [f.name.toLowerCase(), f]))

  let currentResponse = args.initialResponse
  let currentLlmResult = args.initialLlmResult
  let correctionsApplied = 0
  let prevErrorKey = ''

  for (let iteration = 0; iteration < MAX_CORRECTION_ITERATIONS; iteration++) {
    // Build proposals and validate
    const proposals: MappingProposal[] = []
    for (const tm of currentResponse.table_mappings ?? []) {
      for (const fm of tm.field_mappings ?? []) {
        const proposal = toMappingProposal(fm, sourceFieldMap, targetFieldMap)
        if (proposal) proposals.push(proposal)
      }
    }

    const validationResults = validateMappingBatch(proposals)
    const { names: hardErrorFields, key: errorKey } = collectHardErrors(validationResults)

    // ── Exit condition: clean ────────────────────────────────────────
    if (hardErrorFields.length === 0) {
      return {
        response: currentResponse,
        llmResult: currentLlmResult,
        validationResults,
        correctionsApplied,
        unresolvableFields: [],
        exitReason: 'clean',
      }
    }

    // ── Exit condition 1: UNRECOVERABLE ─────────────────────────────
    // All remaining hard errors are structural — re-prompting can't help.
    const allUnrecoverable = hardErrorFields.every((field) => {
      const vr = validationResults.get(field)
      if (!vr) return false
      return vr.issues
        .filter(i => i.severity === 'error' && HARD_ERROR_CHECKS.has(i.check))
        .every(i => UNRECOVERABLE_CHECKS.has(i.check))
    })
    if (allUnrecoverable) {
      return {
        response: currentResponse,
        llmResult: currentLlmResult,
        validationResults,
        correctionsApplied,
        unresolvableFields: hardErrorFields,
        exitReason: 'unrecoverable',
      }
    }

    // ── Exit condition 2: zero improvement delta ─────────────────────
    // Same hard-error fields as last iteration — LLM is stuck.
    if (iteration > 0 && errorKey === prevErrorKey) {
      return {
        response: currentResponse,
        llmResult: currentLlmResult,
        validationResults,
        correctionsApplied,
        unresolvableFields: hardErrorFields,
        exitReason: 'no_improvement',
      }
    }
    prevErrorKey = errorKey

    // ── Exit condition 3: hard cap ───────────────────────────────────
    if (iteration === MAX_CORRECTION_ITERATIONS - 1) {
      return {
        response: currentResponse,
        llmResult: currentLlmResult,
        validationResults,
        correctionsApplied,
        unresolvableFields: hardErrorFields,
        exitReason: 'max_iterations',
      }
    }

    // ── Re-prompt ────────────────────────────────────────────────────
    const firstTM = currentResponse.table_mappings[0]
    if (!firstTM) break

    const correctionPrompt = buildCorrectionPrompt(
      originalUserMessage,
      firstTM,
      validationResults,
    )

    try {
      const retryResult = await callLLMStreaming({
        feature,
        systemPrompt: withProvenanceGuidance(MAPPING_GENERATION_AGENT_SYSTEM_PROMPT),
        userMessage: correctionPrompt,
        tool: EMIT_TABLE_MAPPINGS_TOOL,
        maxTokens,
        projectId,
        userId,
        model: 'claude-opus-4-7',
        promptVersion: 'mapping-v2-agent-self-correction',
        abuseUserId: userId,
        thinking: { type: 'disabled' },
        output_config: { effort: 'max' },
        metadata: {
          self_correction: true,
          correction_iteration: iteration + 1,
          hard_errors_count: hardErrorFields.length,
        },
        parentCallId: currentLlmResult.callId,
      })

      if (retryResult.kind === 'toolUse') {
        currentResponse = retryResult.toolUse.input as unknown as ClaudeResponse
        currentLlmResult = retryResult
        correctionsApplied++
      } else {
        // LLM returned text instead of tool use — can't parse, stop
        break
      }
    } catch {
      break
    }
  }

  // Fallback: final validation on whatever state we reached
  const finalProposals: MappingProposal[] = []
  for (const tm of currentResponse.table_mappings ?? []) {
    for (const fm of tm.field_mappings ?? []) {
      const proposal = toMappingProposal(fm, sourceFieldMap, targetFieldMap)
      if (proposal) finalProposals.push(proposal)
    }
  }
  const finalValidation = validateMappingBatch(finalProposals)
  const { names: finalErrors } = collectHardErrors(finalValidation)

  return {
    response: currentResponse,
    llmResult: currentLlmResult,
    validationResults: finalValidation,
    correctionsApplied,
    unresolvableFields: finalErrors,
    exitReason: 'llm_error',
  }
}
