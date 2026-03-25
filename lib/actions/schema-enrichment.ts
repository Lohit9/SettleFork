'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'

// ── Types ──────────────────────────────────────────────────────────────────────

interface FieldCorrections {
  is_nullable?: boolean
  is_primary_key?: boolean
  is_foreign_key?: boolean
  inferred_type?: string
  data_type?: string
}

interface SchemaCorrection {
  field_name: string
  corrections: FieldCorrections
  reasoning: string
  known_issues?: string
}

interface ClaudeSchemaResponse {
  corrections: SchemaCorrection[]
}

export interface EnrichSchemaResult {
  success: boolean
  corrections: SchemaCorrection[]
  correctedFields: number
  error?: string
}

// ── System prompt ──────────────────────────────────────────────────────────────

const ENRICHMENT_SYSTEM_PROMPT = `You are a database schema analyst. You are given:
1. An INFERRED schema derived from analyzing CSV data (data types, nullability, keys detected from actual data values)
2. AUTHORITATIVE schema documentation (DDL, data dictionaries, ERDs) that describes what the schema SHOULD be

Your job is to compare the inferred schema against the documentation and identify corrections. The documentation is the source of truth for structural metadata — the data may contain quality issues that make inference unreliable.

For each field, evaluate:
- NULLABILITY: If the doc says NOT NULL but inferred says nullable (because nulls exist in the data), correct to NOT NULL. Nulls in the data are data quality defects, not schema features.
- PRIMARY KEY: If the doc identifies a field as PK but inference didn't detect it, correct it.
- FOREIGN KEY: If the doc identifies FK relationships, correct it.
- DATA TYPE: If the doc specifies a more precise type than inference detected (e.g., doc says DECIMAL(18,2) but inference said VARCHAR because of $ signs in values), note the intended type.
- SEMANTIC TYPE: If the doc describes a field's purpose (e.g., "phone number", "email", "currency amount", "date", "boolean"), set inferred_type accordingly. Valid semantic types: email, phone, date, datetime, currency, boolean, percentage, url, address, zip_code, country, state, name, id.
- KNOWN ISSUES: If the doc explicitly calls out known data quality issues for a field, extract them.

Only output corrections — fields where the documentation provides information that differs from or augments the inference. Do not output fields where inference and documentation agree.

Respond with ONLY valid JSON (no markdown, no explanation outside the JSON):
{
  "corrections": [
    {
      "field_name": "customer_id",
      "corrections": {
        "is_nullable": false,
        "is_primary_key": true
      },
      "reasoning": "Documentation states customer_id is PK and NOT NULL. Inferred as nullable because 15 null values exist from a 2018 import error — these are data quality defects, not intentional nullability.",
      "known_issues": "Some nulls exist from 2018 import error that was never fully remediated."
    }
  ]
}`

// ── Main action ────────────────────────────────────────────────────────────────

export async function enrichSchemaFromDocs(
  datasetId: string,
  tableId: string
): Promise<EnrichSchemaResult> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, corrections: [], correctedFields: 0, error: 'Not authenticated' }

    // Rate limit check
    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) {
      return {
        success: false,
        corrections: [],
        correctedFields: 0,
        error: rateLimit.error ?? 'AI rate limit reached.',
      }
    }

    // ── Step 1: Load table + inferred fields ─────────────────────────────────
    const { data: table } = await supabase
      .from('tables')
      .select('id, name, row_count, dataset_id')
      .eq('id', tableId)
      .single()

    if (!table) return { success: false, corrections: [], correctedFields: 0, error: 'Table not found' }

    const { data: fields } = await supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, schema_source')
      .eq('table_id', tableId)
      .order('ordinal_position', { ascending: true })

    if (!fields || fields.length === 0) {
      return { success: false, corrections: [], correctedFields: 0, error: 'No fields found for table' }
    }

    // Skip fields already manually edited — never overwrite 'manual'
    const enrichableFields = fields.filter((f) => f.schema_source !== 'manual')
    if (enrichableFields.length === 0) {
      return { success: true, corrections: [], correctedFields: 0 }
    }

    // ── Step 2: Load schema documents (structural, doc_type = 'schema') ──────
    // Deliberately excludes business_context docs — enrichment needs structural
    // truth (DDL, ERDs, data dictionaries), not migration rules or business logic.
    const { data: docs } = await supabaseAdmin
      .from('schema_documents')
      .select('filename, extracted_text')
      .eq('dataset_id', datasetId)
      .eq('doc_type', 'schema')
      .not('extracted_text', 'is', null)

    if (!docs || docs.length === 0) {
      return { success: true, corrections: [], correctedFields: 0 }
    }

    // ── Step 3: Build inferred schema string ─────────────────────────────────
    const inferredSchemaLines = enrichableFields.map((f) => {
      const flags = [
        f.is_primary_key ? 'PK' : null,
        f.is_foreign_key ? 'FK' : null,
        f.is_nullable ? 'nullable' : 'NOT NULL',
        f.inferred_type ? `semantic:${f.inferred_type}` : null,
      ]
        .filter(Boolean)
        .join(', ')
      return `  - ${f.name} (${f.data_type}) [${flags}]`
    })

    const inferredSchemaText = `Table: ${table.name} (${table.row_count ?? 0} rows)\nFields:\n${inferredSchemaLines.join('\n')}`

    // ── Step 4: Build docs string ─────────────────────────────────────────────
    const docsText = docs
      .map((d) => `--- ${d.filename} ---\n${d.extracted_text!.slice(0, 12000)}`)
      .join('\n\n')

    // ── Step 5: Call Claude ───────────────────────────────────────────────────
    const userMessage = `<inferred_schema>\n${inferredSchemaText}\n</inferred_schema>\n\n<schema_documentation>\n${docsText}\n</schema_documentation>\n\nCompare the inferred schema against the documentation and return corrections for the "${table.name}" table only.`

    const raw = await callClaude(ENRICHMENT_SYSTEM_PROMPT, userMessage, 2048)

    // ── Step 6: Parse response ────────────────────────────────────────────────
    let parsed: ClaudeSchemaResponse
    try {
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      console.error('[enrichSchemaFromDocs] Failed to parse Claude response:', raw)
      return { success: false, corrections: [], correctedFields: 0, error: 'Failed to parse AI response' }
    }

    if (!Array.isArray(parsed.corrections)) {
      return { success: true, corrections: [], correctedFields: 0 }
    }

    // ── Step 7: Apply corrections ─────────────────────────────────────────────
    const fieldByName = new Map(enrichableFields.map((f) => [f.name.toLowerCase(), f]))
    let correctedCount = 0

    for (const correction of parsed.corrections) {
      const field = fieldByName.get(correction.field_name.toLowerCase())
      if (!field) continue

      const updates: Record<string, unknown> = { schema_source: 'doc_enriched' }

      if (correction.corrections.is_nullable !== undefined) {
        updates.is_nullable = correction.corrections.is_nullable
      }
      if (correction.corrections.is_primary_key !== undefined) {
        updates.is_primary_key = correction.corrections.is_primary_key
        // A PK cannot be an FK
        if (correction.corrections.is_primary_key) updates.is_foreign_key = false
      }
      if (correction.corrections.is_foreign_key !== undefined) {
        updates.is_foreign_key = correction.corrections.is_foreign_key
      }
      if (correction.corrections.inferred_type) {
        updates.inferred_type = correction.corrections.inferred_type
      }
      if (correction.corrections.data_type) {
        updates.data_type = correction.corrections.data_type
      }

      const { error: updateErr } = await supabaseAdmin
        .from('fields')
        .update(updates)
        .eq('id', field.id)

      if (!updateErr) correctedCount++
    }

    return {
      success: true,
      corrections: parsed.corrections,
      correctedFields: correctedCount,
    }
  } catch (err) {
    console.error('[enrichSchemaFromDocs]', err)
    return {
      success: false,
      corrections: [],
      correctedFields: 0,
      error: err instanceof Error ? err.message : 'Schema enrichment failed',
    }
  }
}

// ── Bulk helper: enrich all tables in a dataset ────────────────────────────────
// Called after a schema doc is uploaded to catch all existing tables.

export async function enrichAllTablesInDataset(
  datasetId: string
): Promise<{ tableCount: number; totalCorrections: number }> {
  try {
    const { data: tables } = await supabaseAdmin
      .from('tables')
      .select('id')
      .eq('dataset_id', datasetId)

    if (!tables || tables.length === 0) return { tableCount: 0, totalCorrections: 0 }

    let totalCorrections = 0
    for (const table of tables) {
      const result = await enrichSchemaFromDocs(datasetId, table.id)
      if (result.success) totalCorrections += result.correctedFields
    }

    return { tableCount: tables.length, totalCorrections }
  } catch (err) {
    console.error('[enrichAllTablesInDataset]', err)
    return { tableCount: 0, totalCorrections: 0 }
  }
}
