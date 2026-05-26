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

// ─── System prompt ────────────────────────────────────────────────────────────

const FIELD_INTERPRETER_SYSTEM_PROMPT = `You are an enterprise data analyst interpreting source database schemas for migration projects.

Given a source table's fields with their data types, profiling statistics, and sample values, produce concise business descriptions for each field. A good description:
- Explains what the field represents in the source system's business domain
- References specific sample values or patterns when they reveal business meaning (e.g., "Values like 'Won', 'Lost', 'Prospecting' indicate this tracks deal stage in a sales pipeline")
- Is 1-2 sentences, reviewer-facing, jargon-free
- Does NOT restate the field name or data type
- Does NOT speculate beyond what the data supports

Skip fields whose meaning cannot be confidently inferred from the name + sample data alone.`

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

interface FieldProfile {
  field_id: string
  null_percentage: number | null
  cardinality: number | null
  sample_values: unknown | null
  value_distribution: unknown | null
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
