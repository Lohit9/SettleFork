/**
 * Path D output parser — XML sections wrapping JSON.
 *
 * Path D's monolithic Opus 4.7 call emits 7 sections in a fixed order:
 * `<mappings>`, `<coverage>`, `<decisions>`, `<lookup_tables>`,
 * `<data_quality>`, `<inferred_targets>`, `<project_notes>`. Each section
 * (except `<project_notes>`) wraps a JSON array; `<project_notes>` wraps
 * raw markdown.
 *
 * This module exposes:
 *   - `parsePathDOutput(rawText)` — non-streaming convenience for full
 *     post-stream parsing (orchestrator calls this after `callLLMStreaming`
 *     resolves)
 *   - `createPathDStreamParser()` — stateful streaming parser; SSE plumbing
 *     in Sub-PR 5 will use this to emit progressive section-complete
 *     events
 *
 * Per-section recovery: each section is parsed independently. JSON or Zod
 * failures for one section are caught + reported as
 * `{ status: 'parse_error', error: '...' }`; other sections continue to
 * parse cleanly.
 *
 * UUID resolution NOT done here. Cross-section references in the LLM
 * output use INDEX-BASED references (e.g., `data_quality_flag_indices: [0, 2]`,
 * `applies_to.tfm_indices: [0, 3]`). The parser preserves these indices
 * verbatim — UUID resolution is the persistence layer's job
 * (`lib/ai/path-d-persistence.ts`'s 2-pass insert).
 */

import { z } from 'zod'

// ── Section schemas (Zod) ───────────────────────────────────────────────────
//
// Match migration 093 column shapes. JSONB columns accept `z.unknown()` —
// the LLM produces structured JSON inside, but Zod doesn't enforce schemas
// for nested JSONB at the parse layer. Persistence layer inserts as-is.

export const MappingPayloadSchema = z.object({
  target_field_id: z.string().uuid(),
  source_field_ids: z.array(z.string().uuid()).default([]),
  combination_type: z.enum(['single', 'concat_space', 'concat_comma', 'custom_sql']),
  combination_sql: z.string().nullable().optional(),
  ai_reasoning: z.string(),
  transformation_intent: z.string(),
  mapping_cardinality: z.enum(['1:1', 'many_to_one', 'one_to_many', 'many_to_many']),
  dedup_required: z.boolean().default(false),
  dedup_strategy: z.unknown().nullable().optional(),
  data_quality_flag_indices: z.array(z.number().int().nonnegative()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(['needs_review', 'approved', 'rejected']).default('needs_review'),
})
export type MappingPayload = z.infer<typeof MappingPayloadSchema>

export const CoveragePayloadSchema = z.object({
  target_field_id: z.string().uuid(),
  coverage_status: z.enum(['covered', 'partial', 'gap', 'optional', 'out_of_scope']),
  ai_reasoning: z.string().optional(),
  default_value_recommendation: z.unknown().nullable().optional(),
  // PR γ.1 Stop 1 calibration trial — coverage confidence emission. The
  // model is asked (via the <coverage> prompt section) to emit a 0.0-1.0
  // confidence score alongside each coverage_status verdict, reusing
  // the 5-tier scale from the mapping confidence guidance. Optional so
  // legacy responses without the field still parse cleanly during
  // calibration; Stop 2 may tighten to required after empirical
  // calibration confirms the prompt mechanic is sound.
  confidence: z.number().min(0).max(1).optional(),
})
export type CoveragePayload = z.infer<typeof CoveragePayloadSchema>

export const DecisionPayloadSchema = z.object({
  decision_type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  ai_recommendation: z.unknown(),
  alternatives: z.unknown(),
  applies_to: z
    .object({
      tfm_indices: z.array(z.number().int().nonnegative()).optional(),
      coverage_indices: z.array(z.number().int().nonnegative()).optional(),
    })
    .optional(),
  status: z.enum(['pending', 'decided', 'auto_applied']).default('pending'),
})
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>

export const LookupTablePayloadSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  applies_to_fields: z.unknown().optional(),
  mappings: z.unknown(),
  data_quality_notes: z.unknown().optional(),
})
export type LookupTablePayload = z.infer<typeof LookupTablePayloadSchema>

export const DQFindingPayloadSchema = z.object({
  source_field_id: z.string().uuid().nullable().optional(),
  severity: z.enum(['critical', 'warning', 'info']),
  category: z.string().min(1),
  description: z.string().min(1),
  example_values: z.unknown().optional(),
  recommendation: z.string().optional(),
})
export type DQFindingPayload = z.infer<typeof DQFindingPayloadSchema>

export const InferredTargetPayloadSchema = z.object({
  inferred_target_object: z.string().min(1),
  evidence_source_fields: z.unknown().optional(),
  reasoning: z.string().optional(),
})
export type InferredTargetPayload = z.infer<typeof InferredTargetPayloadSchema>

// ── Section parse status ────────────────────────────────────────────────────

export type SectionStatus<T> =
  | { status: 'parsed_ok'; data: T }
  | { status: 'parse_error'; error: string }
  | { status: 'missing' }

// ── Full parsed output shape ────────────────────────────────────────────────

export interface PathDParsedOutput {
  mappings: SectionStatus<MappingPayload[]>
  coverage: SectionStatus<CoveragePayload[]>
  decisions: SectionStatus<DecisionPayload[]>
  lookup_tables: SectionStatus<LookupTablePayload[]>
  data_quality: SectionStatus<DQFindingPayload[]>
  inferred_targets: SectionStatus<InferredTargetPayload[]>
  project_notes: SectionStatus<string>
}

// ── Section-name list (canonical order) ─────────────────────────────────────

const SECTION_NAMES = [
  'mappings',
  'coverage',
  'decisions',
  'lookup_tables',
  'data_quality',
  'inferred_targets',
  'project_notes',
] as const
type SectionName = (typeof SECTION_NAMES)[number]

// ── Section extraction + validation ─────────────────────────────────────────

function extractSectionContent(text: string, name: SectionName): string | null {
  // Match `<name>...</name>` greedily for the LAST close tag (handles nested
  // similar tokens in JSON content, though sections shouldn't contain them).
  const openTag = `<${name}>`
  const closeTag = `</${name}>`
  const openIdx = text.indexOf(openTag)
  if (openIdx < 0) return null
  const contentStart = openIdx + openTag.length
  const closeIdx = text.indexOf(closeTag, contentStart)
  if (closeIdx < 0) return null
  return text.slice(contentStart, closeIdx).trim()
}

function parseArraySection<T>(
  rawContent: string,
  schema: z.ZodType<T[], z.ZodTypeDef, unknown>,
  sectionName: string,
): SectionStatus<T[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch (err) {
    return {
      status: 'parse_error',
      error: `${sectionName}: JSON.parse failed — ${(err as Error).message}`,
    }
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    return {
      status: 'parse_error',
      error: `${sectionName}: Zod validation failed — ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    }
  }
  return { status: 'parsed_ok', data: result.data as T[] }
}

// ── Public: non-streaming parser ────────────────────────────────────────────

export function parsePathDOutput(rawText: string): PathDParsedOutput {
  const result: PathDParsedOutput = {
    mappings: { status: 'missing' },
    coverage: { status: 'missing' },
    decisions: { status: 'missing' },
    lookup_tables: { status: 'missing' },
    data_quality: { status: 'missing' },
    inferred_targets: { status: 'missing' },
    project_notes: { status: 'missing' },
  }

  // Per-section explicit dispatch — TS can't narrow a dynamic
  // `result[name] = ...` assignment across discriminated-union members.
  const mappingsContent = extractSectionContent(rawText, 'mappings')
  if (mappingsContent !== null) {
    result.mappings = parseArraySection(mappingsContent, z.array(MappingPayloadSchema), 'mappings')
  }
  const coverageContent = extractSectionContent(rawText, 'coverage')
  if (coverageContent !== null) {
    result.coverage = parseArraySection(coverageContent, z.array(CoveragePayloadSchema), 'coverage')
  }
  const decisionsContent = extractSectionContent(rawText, 'decisions')
  if (decisionsContent !== null) {
    result.decisions = parseArraySection(decisionsContent, z.array(DecisionPayloadSchema), 'decisions')
  }
  const lookupTablesContent = extractSectionContent(rawText, 'lookup_tables')
  if (lookupTablesContent !== null) {
    result.lookup_tables = parseArraySection(lookupTablesContent, z.array(LookupTablePayloadSchema), 'lookup_tables')
  }
  const dqContent = extractSectionContent(rawText, 'data_quality')
  if (dqContent !== null) {
    result.data_quality = parseArraySection(dqContent, z.array(DQFindingPayloadSchema), 'data_quality')
  }
  const inferredContent = extractSectionContent(rawText, 'inferred_targets')
  if (inferredContent !== null) {
    result.inferred_targets = parseArraySection(inferredContent, z.array(InferredTargetPayloadSchema), 'inferred_targets')
  }
  const notesContent = extractSectionContent(rawText, 'project_notes')
  if (notesContent !== null) {
    result.project_notes = { status: 'parsed_ok', data: notesContent }
  }

  return result
}

// ── Public: streaming parser (Sub-PR 5 SSE will consume) ────────────────────
//
// Stateful parser that accumulates chunks + tracks which sections have been
// completed. `feed(chunk)` returns the names of sections that completed
// during this chunk (so SSE can emit per-section events progressively).
// `finish()` returns the full parsed output, including any sections that
// didn't get close tags (status = 'missing').

export interface PathDStreamParser {
  feed(chunk: string): { completedSections: SectionName[] }
  finish(): PathDParsedOutput
}

export function createPathDStreamParser(): PathDStreamParser {
  let buffer = ''
  const completed: Record<SectionName, boolean> = {
    mappings: false,
    coverage: false,
    decisions: false,
    lookup_tables: false,
    data_quality: false,
    inferred_targets: false,
    project_notes: false,
  }

  return {
    feed(chunk: string) {
      buffer += chunk
      const newlyCompleted: SectionName[] = []
      for (const name of SECTION_NAMES) {
        if (completed[name]) continue
        const closeTag = `</${name}>`
        if (buffer.includes(closeTag)) {
          completed[name] = true
          newlyCompleted.push(name)
        }
      }
      return { completedSections: newlyCompleted }
    },
    finish() {
      // One-shot full parse on the accumulated buffer.
      return parsePathDOutput(buffer)
    },
  }
}
