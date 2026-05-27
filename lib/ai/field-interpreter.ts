/**
 * Field-level domain interpretation (S1 — #17).
 *
 * Before mapping is proposed, reads each source field's name, type, and
 * sample data and produces a 1-2 sentence business description of what the
 * field means in the source domain. Writes back to fields.description.
 *
 * Idempotent: fields that already have a description are skipped so human
 * edits are never overwritten.
 *
 * Architecture:
 *   - One LLM call per source table, all fields bundled in a single message.
 *   - Uses the EMIT_FIELD_DESCRIPTIONS tool so output is structured + typed.
 *   - Descriptions flow into buildAIContext (FieldContext.description) and
 *     from there into the mapping prompt automatically — no extra wiring needed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { callLLM } from '@/lib/ai/llm-client'
import { supabaseAdmin } from '@/lib/supabase/admin'

// ─── Tool schema ──────────────────────────────────────────────────────────────

const EMIT_FIELD_DESCRIPTIONS_TOOL: Tool = {
  name: 'emit_field_descriptions',
  description:
    'Emit a domain-level business description for each source field. ' +
    'Each description is 1-2 sentences explaining what the field represents ' +
    'in the source system\'s business domain — not a restatement of the field ' +
    'name or data type. Skip fields you cannot confidently interpret.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fields: {
        type: 'array',
        description: 'One entry per field you can confidently describe. Omit fields with unclear meaning.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_name: {
              type: 'string',
              description: 'The bare field name exactly as given in the prompt.',
            },
            description: {
              type: 'string',
              description:
                '1-2 sentences describing the business meaning of this field. ' +
                'Reference the sample values or value distribution where helpful. ' +
                'Do not restate the field name or data type.',
            },
          },
          required: ['field_name', 'description'],
        },
      },
    },
    required: ['fields'],
  },
}

const EMIT_FIELD_SYNONYMS_TOOL: Tool = {
  name: 'emit_field_synonyms',
  description:
    'Emit cross-system synonyms for each field where confidence is high. ' +
    'For each field, return 3-5 alternative names used in enterprise systems ' +
    '(SAP, NetSuite, Salesforce, Oracle EBS, QuickBooks, etc.). Return an ' +
    'empty array when no reliable cross-system equivalent exists.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fields: {
        type: 'array',
        description: 'One entry per field with cross-system synonym candidates.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_name: {
              type: 'string',
              description: 'The bare field name exactly as given in the prompt.',
            },
            synonyms: {
              type: 'array',
              description:
                '3-5 alternative names used in other enterprise systems. ' +
                'Use [] when no confident equivalent exists.',
              items: { type: 'string' },
            },
          },
          required: ['field_name', 'synonyms'],
        },
      },
    },
    required: ['fields'],
  },
}

// ─── System prompt ────────────────────────────────────────────────────────────

const FIELD_INTERPRETER_SYSTEM_PROMPT = `You are an enterprise data analyst interpreting source database schemas for migration projects.

Given a source table's fields with their data types, profiling statistics, and sample values, produce concise business descriptions for each field. A good description:
- Explains what the field represents in the source system's business domain
- References specific sample values or patterns when they reveal business meaning (e.g., "Values like 'Won', 'Lost', 'Prospecting' indicate this tracks deal stage in a sales pipeline")
- Is 1-2 sentences, reviewer-facing, jargon-free
- Does NOT restate the field name or data type
- Does NOT speculate beyond what the data supports

Skip fields whose meaning cannot be confidently inferred from the name + sample data alone.`

const CROSS_SYSTEM_SYNONYMS_SYSTEM_PROMPT = `You are an enterprise data migration analyst.

For each field below, identify 3-5 alternative names this same business concept is known by in other enterprise systems (SAP, NetSuite, Salesforce, Oracle EBS, QuickBooks, etc.).

Output structure:
- Return one entry per provided field via the tool.
- synonyms must be an array of strings.
- Include only synonyms you are confident about.
- If a field is generic or custom with no reliable cross-system equivalent (for example a custom UUID key), return an empty array.

Prefer canonical enterprise naming variants, not trivial formatting variants.`

// ─── Field context builder ────────────────────────────────────────────────────

interface RawField {
  id: string
  name: string
  data_type: string
  inferred_type: string | null
  description: string | null
  is_nullable: boolean
  is_primary_key: boolean
}

interface RawFieldWithSynonyms extends RawField {
  synonyms: string[] | null
}

interface FieldProfile {
  field_id: string
  null_percentage: number | null
  cardinality: number | null
  sample_values: unknown | null
  value_distribution: unknown | null
}

function formatSynonymAddendum(synonyms: string[]): string {
  return `Also known as: ${synonyms.join(', ')}.`
}

async function hasFieldSynonymsColumn(): Promise<boolean> {
  // TODO: remove this runtime check after migration 108 adds fields.synonyms JSONB column.
  // Called once per interpretCrossSystemSynonyms invocation — cache the result if perf matters.
  const { error } = await supabaseAdmin.from('fields').select('synonyms').limit(1)
  if (!error) return true
  if (error.message.includes('column fields.synonyms does not exist')) return false
  console.error('[field-interpreter] Failed to check fields.synonyms column:', error.message)
  return false
}

function buildFieldPromptBlock(field: RawField, profile: FieldProfile | undefined): string {
  const lines: string[] = [
    `Field: ${field.name}`,
    `Type: ${field.inferred_type ?? field.data_type}${field.is_nullable ? ' (nullable)' : ' (not null)'}${field.is_primary_key ? ' — PRIMARY KEY' : ''}`,
  ]

  if (profile) {
    if (profile.null_percentage !== null && profile.null_percentage > 0) {
      lines.push(`Null rate: ${profile.null_percentage.toFixed(1)}%`)
    }
    if (profile.cardinality !== null) {
      lines.push(`Distinct values: ${profile.cardinality}`)
    }

    const dist = Array.isArray(profile.value_distribution)
      ? (profile.value_distribution as { value: string; count: number }[]).slice(0, 10)
      : []
    if (dist.length > 0) {
      lines.push(`Top values: ${dist.map((d) => `"${d.value}" (${d.count})`).join(', ')}`)
    } else {
      const samples = Array.isArray(profile.sample_values)
        ? (profile.sample_values as unknown[]).slice(0, 8).map(String)
        : []
      if (samples.length > 0) {
        lines.push(`Sample values: ${samples.join(', ')}`)
      }
    }
  }

  return lines.join('\n')
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Interprets all fields on the given source tables that lack a description.
 * Writes results to fields.description via supabaseAdmin (bypasses RLS —
 * this is a system-initiated write, not user-triggered).
 *
 * Called from runMappingGeneration before the mapping batch loop.
 * Fire-and-forget safe: errors are logged but never surface to the caller.
 */
export async function interpretFieldDomains(
  projectId: string,
  sourceTableIds: string[],
  userId: string,
): Promise<void> {
  if (!sourceTableIds.length) return

  for (const tableId of sourceTableIds) {
    try {
      // Fetch table name for prompt context
      const { data: table } = await supabaseAdmin
        .from('tables')
        .select('name')
        .eq('id', tableId)
        .single()
      if (!table) continue

      // Fetch fields — only those without a description
      const { data: fields } = await supabaseAdmin
        .from('fields')
        .select('id, name, data_type, inferred_type, description, is_nullable, is_primary_key')
        .eq('table_id', tableId)
        .is('description', null)
        .order('ordinal_position', { ascending: true })

      if (!fields?.length) continue

      const fieldIds = fields.map((f) => f.id)

      // Fetch profiles for context
      const { data: profiles } = await supabaseAdmin
        .from('field_profiles')
        .select('field_id, null_percentage, cardinality, sample_values, value_distribution')
        .in('field_id', fieldIds)

      const profileMap = new Map((profiles ?? []).map((p) => [p.field_id, p as FieldProfile]))

      // Build prompt
      const fieldBlocks = (fields as RawField[])
        .map((f) => buildFieldPromptBlock(f, profileMap.get(f.id)))
        .join('\n\n')

      const userMessage =
        `Source table: ${table.name}\n\n` +
        `Interpret the business meaning of the following fields:\n\n` +
        fieldBlocks

      const result = await callLLM({
        feature: 'field_interpretation',
        projectId,
        userId,
        systemPrompt: FIELD_INTERPRETER_SYSTEM_PROMPT,
        userMessage,
        tool: EMIT_FIELD_DESCRIPTIONS_TOOL,
      })

      if (result.kind !== 'toolUse' || result.toolUse.name !== 'emit_field_descriptions') {
        console.warn(`[field-interpreter] Unexpected LLM result kind for table ${table.name}:`, result.kind)
        continue
      }

      const { fields: emitted } = result.toolUse.input as {
        fields: { field_name: string; description: string }[]
      }

      if (!emitted?.length) continue

      // Build a name → id lookup for this table's fields
      const nameToId = new Map((fields as RawField[]).map((f) => [f.name, f.id]))

      // Write descriptions — supabaseAdmin bypasses RLS; idempotency enforced
      // by the .is('description', null) filter above: we only fetched fields
      // that had no description, so any row we write to was definitely null.
      for (const { field_name, description } of emitted) {
        const fieldId = nameToId.get(field_name)
        if (!fieldId) continue

        const { error } = await supabaseAdmin
          .from('fields')
          .update({ description })
          .eq('id', fieldId)

        if (error) {
          console.error(`[field-interpreter] Failed to write description for field ${field_name}:`, error.message)
        }
      }

      console.log(
        `[field-interpreter] Interpreted ${emitted.length}/${fields.length} fields for table ${table.name}`,
      )
    } catch (err) {
      console.error(`[field-interpreter] Error interpreting table ${tableId}:`, err)
    }
  }
}

export async function interpretCrossSystemSynonyms(
  projectId: string,
  sourceTableIds: string[],
  userId: string,
): Promise<void> {
  if (!sourceTableIds.length) return

  const synonymsColumnExists = await hasFieldSynonymsColumn()
  if (!synonymsColumnExists) {
    console.warn(
      '[field-interpreter] fields.synonyms is missing; appended fallback addendums to fields.description. Add a migration for fields.synonyms JSONB.',
    )
  }

  for (const tableId of sourceTableIds) {
    try {
      const { data: table } = await supabaseAdmin
        .from('tables')
        .select('name')
        .eq('id', tableId)
        .single()
      if (!table) continue

      let fields: RawField[] | RawFieldWithSynonyms[] | null = null
      if (synonymsColumnExists) {
        const { data } = await supabaseAdmin
          .from('fields')
          .select('id, name, data_type, inferred_type, description, synonyms, is_nullable, is_primary_key')
          .eq('table_id', tableId)
          .not('description', 'is', null)
          .order('ordinal_position', { ascending: true })
        fields = data as RawFieldWithSynonyms[] | null
      } else {
        const { data } = await supabaseAdmin
          .from('fields')
          .select('id, name, data_type, inferred_type, description, is_nullable, is_primary_key')
          .eq('table_id', tableId)
          .not('description', 'is', null)
          .order('ordinal_position', { ascending: true })
        fields = data as RawField[] | null
      }

      if (!fields?.length) continue

      const candidateFields = synonymsColumnExists
        ? (fields as RawFieldWithSynonyms[]).filter((f) => f.synonyms === null)
        : (fields as RawField[]).filter((f) => !f.description?.includes('Also known as:'))

      if (!candidateFields.length) continue

      const fieldBlocks = candidateFields
        .map((f) => [`Field: ${f.name}`, `Description: ${f.description ?? ''}`].join('\n'))
        .join('\n\n')

      const userMessage =
        `Source table: ${table.name}\n\n` +
        `For each field below, return cross-system synonyms as requested:\n\n` +
        fieldBlocks

      const result = await callLLM({
        feature: 'field_cross_system_synonyms',
        projectId,
        userId,
        systemPrompt: CROSS_SYSTEM_SYNONYMS_SYSTEM_PROMPT,
        userMessage,
        tool: EMIT_FIELD_SYNONYMS_TOOL,
      })

      if (result.kind !== 'toolUse' || result.toolUse.name !== 'emit_field_synonyms') {
        console.warn(`[field-interpreter] Unexpected synonyms result kind for table ${table.name}:`, result.kind)
        continue
      }

      const { fields: emitted } = result.toolUse.input as {
        fields: { field_name: string; synonyms: string[] }[]
      }
      if (!emitted?.length) continue

      const fieldByName = new Map(candidateFields.map((f) => [f.name, f]))

      for (const { field_name, synonyms } of emitted) {
        const field = fieldByName.get(field_name)
        if (!field) continue
        const cleanedSynonyms = synonyms.map((s) => s.trim()).filter(Boolean)

        if (synonymsColumnExists) {
          // Supabase generated types do not include `fields.synonyms` yet.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await supabaseAdmin
            .from('fields')
            .update({ synonyms: cleanedSynonyms } as any)
            .eq('id', field.id)

          if (error) {
            console.error(`[field-interpreter] Failed to write synonyms for field ${field_name}:`, error.message)
          }
          continue
        }

        if (!cleanedSynonyms.length || !field.description) continue
        const addendum = formatSynonymAddendum(cleanedSynonyms)
        if (field.description.includes('Also known as:')) continue

        const { error } = await supabaseAdmin
          .from('fields')
          .update({ description: `${field.description}\n\n${addendum}` })
          .eq('id', field.id)

        if (error) {
          console.error(
            `[field-interpreter] Failed to append fallback synonyms for field ${field_name}:`,
            error.message,
          )
        }
      }

    } catch (err) {
      console.error(`[field-interpreter] Error generating cross-system synonyms for table ${tableId}:`, err)
    }
  }
}
