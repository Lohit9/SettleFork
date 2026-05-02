'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callLLM } from '@/lib/ai/llm-client'
import { EMIT_SCHEMA_CORRECTIONS_TOOL } from '@/lib/ai/tool-schemas'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { canOverride } from '@/lib/utils/schema-priority'

// ── Types ──────────────────────────────────────────────────────────────────────

interface FieldCorrections {
  is_nullable?: boolean
  is_primary_key?: boolean
  is_foreign_key?: boolean
  // Canonical format: "ReferencedTableName.pk_field_name" (e.g. "BRANCH_INFO.BRANCH_NO").
  // Downstream consumers — detection-engine.ts orphan check and execution-package.ts
  // topological sort — both require is_foreign_key AND fk_reference to be set.
  fk_reference?: string | null
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
- FOREIGN KEY: If the doc identifies FK relationships, correct it. When you set is_foreign_key to true, you MUST also set fk_reference to the target in the form "ReferencedTableName.pk_field_name" (e.g. "BRANCH_INFO.BRANCH_NO"). The referenced table must exist in the same dataset — check the inferred schema you were given; if the referenced table isn't present, do not emit the correction. Setting is_foreign_key = true without fk_reference has no downstream effect, so always supply both together. To remove a spurious FK, set is_foreign_key to false and fk_reference to null.
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
    },
    {
      "field_name": "branch_no",
      "corrections": {
        "is_foreign_key": true,
        "fk_reference": "BRANCH_INFO.BRANCH_NO"
      },
      "reasoning": "Data dictionary documents CIF_MASTER.BRANCH_NO as a foreign key to BRANCH_INFO.BRANCH_NO. Inference missed the relationship because column names only partially overlap."
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
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, schema_source')
      .eq('table_id', tableId)
      .order('ordinal_position', { ascending: true })

    if (!fields || fields.length === 0) {
      return { success: false, corrections: [], correctedFields: 0, error: 'No fields found for table' }
    }

    // IMPORTANT: we deliberately DO NOT filter out higher-priority fields
    // upfront anymore. Claude needs the full schema context to reason about
    // cross-field relationships and to emit accurate corrections, and any
    // corrections that conflict with a higher-priority source (ddl_parsed,
    // manual) are routed to validation_rules as warnings instead of being
    // silently dropped. The priority gate fires in the apply loop below.
    //
    // See lib/utils/schema-priority.ts for the cascade, and
    // routeConflictToValidationRule below for the warning-fallback path.

    // Resolve project_id once — needed when routing conflicts to validation_rules.
    const { data: dataset, error: datasetErr } = await supabaseAdmin
      .from('datasets')
      .select('project_id')
      .eq('id', datasetId)
      .single()
    if (datasetErr || !dataset?.project_id) {
      return {
        success: false,
        corrections: [],
        correctedFields: 0,
        error: `Could not resolve project for dataset ${datasetId}`,
      }
    }
    const projectId = dataset.project_id as string

    // ── Step 2: Load schema + business-context documents ─────────────────────
    // Two scopes, two queries:
    //   - Schema docs are dataset-scoped (dataset_id set, project_id null).
    //     They carry structural truth — DDL, ERDs, data dictionaries.
    //   - Business-context docs are project-scoped (dataset_id null,
    //     project_id set) per migration 021. They carry migration rules and
    //     business logic like "Tax ID is required for all customers".
    //
    // We feed both to Claude so cross-cutting rules can propose corrections
    // that the structural docs alone wouldn't surface. Conflicts with higher-
    // priority metadata are routed to validation_rules as warnings (see
    // routeConflictToValidationRule below), so it's safe to let business
    // context influence proposals even when a DDL already claims the field.
    const [schemaDocsResult, contextDocsResult] = await Promise.all([
      supabaseAdmin
        .from('schema_documents')
        .select('filename, extracted_text')
        .eq('dataset_id', datasetId)
        .eq('doc_type', 'schema')
        .not('extracted_text', 'is', null),
      supabaseAdmin
        .from('schema_documents')
        .select('filename, extracted_text')
        .eq('project_id', projectId)
        .eq('doc_type', 'business_context')
        .not('extracted_text', 'is', null),
    ])

    const docs = [
      ...(schemaDocsResult.data ?? []),
      ...(contextDocsResult.data ?? []),
    ]

    if (docs.length === 0) {
      return { success: true, corrections: [], correctedFields: 0 }
    }

    // ── Step 3: Build inferred schema string ─────────────────────────────────
    const inferredSchemaLines = fields.map((f) => {
      const fkFlag = f.is_foreign_key
        ? f.fk_reference
          ? `FK→${f.fk_reference}`
          : 'FK (no reference set)'
        : null
      const flags = [
        f.is_primary_key ? 'PK' : null,
        fkFlag,
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

    // PR 12 H1: tool use under flag ON; legacy text+JSON.parse under flag OFF.
    const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
    // `projectId` already resolved at the top of the function (line 149)
    // for downstream conflict-routing — reuse it here for the log row.
    const result = await callLLM({
      feature: 'schema_enrichment',
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 2048,
      projectId,
      userId: user.id,
      promptVersion: 'schema-enrichment-v1',
      abuseUserId: user.id,
      metadata: { dataset_id: datasetId, table_id: tableId, table_name: table.name },
      ...(phase2Enabled && { tool: EMIT_SCHEMA_CORRECTIONS_TOOL }),
    })

    // ── Step 6: Parse response ────────────────────────────────────────────────
    let parsed: ClaudeSchemaResponse
    if (result.kind === 'toolUse') {
      parsed = result.toolUse.input as unknown as ClaudeSchemaResponse
    } else {
      const raw = result.text
      try {
        // Strip markdown fences if present
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
        parsed = JSON.parse(cleaned)
      } catch {
        console.error('[enrichSchemaFromDocs] Failed to parse Claude response:', raw)
        return { success: false, corrections: [], correctedFields: 0, error: 'Failed to parse AI response' }
      }
    }

    if (!Array.isArray(parsed.corrections)) {
      return { success: true, corrections: [], correctedFields: 0 }
    }

    // ── Step 7: Apply corrections ─────────────────────────────────────────────
    const fieldByName = new Map(fields.map((f) => [f.name.toLowerCase(), f]))
    let correctedCount = 0

    for (const correction of parsed.corrections) {
      const field = fieldByName.get(correction.field_name.toLowerCase())
      if (!field) continue

      // Upfront priority gate. If this correction wants to overwrite a field
      // whose schema_source has higher authority (ddl_parsed, manual), we
      // don't touch the structural columns — but we don't drop the finding
      // either. Route it to validation_rules as a warning so the user sees
      // the conflict in the Validate tab and can either accept it (manual
      // edit → bumps schema_source to 'manual') or ignore it.
      if (!canOverride(field.schema_source, 'doc_enriched')) {
        await routeConflictToValidationRule(projectId, field, correction, table.name)
        console.log(
          `[Enrichment Conflict] ${table.name}.${field.name}: business rule says ${JSON.stringify(correction.corrections)} but '${field.schema_source}' has higher priority. Routed to validation_rules as warning.`
        )
        continue
      }

      const updates: Record<string, unknown> = { schema_source: 'doc_enriched' }

      if (correction.corrections.is_nullable !== undefined) {
        updates.is_nullable = correction.corrections.is_nullable
      }
      if (correction.corrections.is_primary_key !== undefined) {
        updates.is_primary_key = correction.corrections.is_primary_key
        // A PK cannot be an FK — clear both the flag and the now-stale reference
        if (correction.corrections.is_primary_key) {
          updates.is_foreign_key = false
          updates.fk_reference = null
        }
      }
      if (correction.corrections.is_foreign_key !== undefined) {
        updates.is_foreign_key = correction.corrections.is_foreign_key
        // Clearing the FK flag must also clear any stale fk_reference, unless
        // the same correction explicitly sets one below.
        if (!correction.corrections.is_foreign_key) {
          updates.fk_reference = null
        }
      }
      if (correction.corrections.fk_reference !== undefined) {
        // Persist null or a string ("Table.col"). Claude is instructed to emit
        // fk_reference alongside is_foreign_key=true; if it sent a reference
        // without flipping the flag, honour both by ensuring the flag is on.
        updates.fk_reference = correction.corrections.fk_reference
        if (correction.corrections.fk_reference && updates.is_foreign_key !== true) {
          updates.is_foreign_key = true
        }
      }
      if (correction.corrections.inferred_type) {
        updates.inferred_type = correction.corrections.inferred_type
      }
      if (correction.corrections.data_type) {
        updates.data_type = correction.corrections.data_type
      }

      // Race guard: the upfront canOverride filter was computed against the
      // snapshot we read earlier. Re-check at write time by constraining the
      // UPDATE to rows whose current schema_source we're still allowed to
      // overwrite. If a higher-priority writer (manual edit, DDL re-upload)
      // raced in between, the update matches zero rows and we skip.
      const overridableSources = ['inferred', 'cross_table_inferred', 'doc_enriched']
      const { data: updatedRows, error: updateErr } = await supabaseAdmin
        .from('fields')
        .update(updates)
        .eq('id', field.id)
        .in('schema_source', overridableSources)
        .select('id')

      if (updateErr) continue
      if (!updatedRows || updatedRows.length === 0) {
        // Another writer promoted this row between our read and write. The
        // snapshot canOverride check passed, but the current schema_source no
        // longer lets us overwrite. Surface the conflict the same way the
        // upfront gate does — a zero-row UPDATE is semantically identical.
        await routeConflictToValidationRule(projectId, field, correction, table.name)
        console.log(
          `[Enrichment Conflict] ${table.name}.${field.name}: schema_source raced to a higher priority before write. Routed to validation_rules as warning.`
        )
        continue
      }
      correctedCount++
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

// ── Conflict routing ──────────────────────────────────────────────────────────
//
// When AI enrichment finds a correction that conflicts with a higher-priority
// schema_source (typically ddl_parsed or manual), we deliberately do NOT touch
// the structural columns on the field row. Instead we record the finding as a
// 'warning' validation_rule so the Validate tab surfaces it without silently
// losing the signal.
//
// Design invariants:
//   - severity is ALWAYS 'warning' — business rules never block a migration
//     when the schema (higher authority) disagrees. The user can promote via
//     a manual edit in Schema Overview, which bumps schema_source = 'manual'
//     and lets a later enrichment pass rewrite it structurally.
//   - Only nullability and FK conflicts are routed today. Other fields
//     (is_primary_key, data_type, inferred_type) don't have clean warning
//     semantics yet — they log and drop. Expand this helper as needed.
//   - rule_type='not_null' has a live runtime handler in executeCustomRules;
//     rule_type='referential' does not — those rules are stored but won't
//     produce violation counts until a handler is added. Intentional.
//   - Dedup by (project_id, field_id, name) keeps re-triggers idempotent.

async function routeConflictToValidationRule(
  projectId: string,
  field: {
    id: string
    table_id: string
    name: string
    is_nullable: boolean
    is_foreign_key: boolean
    schema_source: string
  },
  correction: SchemaCorrection,
  tableName: string
): Promise<void> {
  type ConflictRuleInsert = {
    project_id: string
    table_id: string
    field_id: string
    name: string
    description: string
    rule_type: 'not_null' | 'referential'
    rule_config: Record<string, unknown>
    severity: 'warning'
    is_ai_generated: boolean
    ai_original_prompt: string
  }
  const rulesToInsert: ConflictRuleInsert[] = []

  // ── Nullability conflict ──
  // Doc says NOT NULL (is_nullable=false); DB says nullable (is_nullable=true).
  // We only care about the "doc wants stricter than schema" direction — the
  // inverse (doc says nullable, schema says NOT NULL) isn't a data quality
  // concern, it's just a documentation mismatch.
  if (
    correction.corrections.is_nullable === false &&
    field.is_nullable === true
  ) {
    rulesToInsert.push({
      project_id: projectId,
      table_id: field.table_id,
      field_id: field.id,
      name: `${field.name}: required per business rules (conflicts with schema)`,
      description:
        `Business rules indicate this field should be required (NOT NULL), but the ` +
        `current schema (schema_source='${field.schema_source}') allows null values. ` +
        `Flagged as a warning for review — promote via a manual edit in Schema Overview ` +
        `to enforce structurally.`,
      rule_type: 'not_null',
      rule_config: { source: 'business_rules' },
      severity: 'warning',
      is_ai_generated: true,
      ai_original_prompt:
        `Business rule conflict for ${tableName}.${field.name}: doc says NOT NULL, ` +
        `schema says nullable. Reasoning: ${correction.reasoning ?? '(no reasoning supplied)'}`,
    })
  }

  // ── FK conflict ──
  // Doc says this is an FK (with a concrete reference); DB has no FK declared.
  // Requires fk_reference — a rule without a target has nothing to validate.
  if (
    correction.corrections.is_foreign_key === true &&
    field.is_foreign_key === false
  ) {
    const fkRef = correction.corrections.fk_reference
    if (fkRef) {
      rulesToInsert.push({
        project_id: projectId,
        table_id: field.table_id,
        field_id: field.id,
        name: `${field.name}: FK reference per business rules (not in schema)`,
        description:
          `Business rules indicate this field references ${fkRef}, but the current ` +
          `schema (schema_source='${field.schema_source}') has no FOREIGN KEY ` +
          `declaration for it. Flagged as a warning for review — promote via a manual ` +
          `edit in Schema Overview to enforce structurally.`,
        rule_type: 'referential',
        rule_config: { source: 'business_rules', fk_reference: fkRef },
        severity: 'warning',
        is_ai_generated: true,
        ai_original_prompt:
          `Business rule conflict for ${tableName}.${field.name}: doc says FK to ` +
          `${fkRef}, schema has no FK. Reasoning: ${correction.reasoning ?? '(no reasoning supplied)'}`,
      })
    }
  }

  if (rulesToInsert.length === 0) return

  // Dedup by (project_id, field_id, name). We avoid a blind INSERT-then-ignore
  // because there's no DB-level unique constraint on these columns and a noisy
  // re-trigger would otherwise spam duplicate warnings.
  for (const rule of rulesToInsert) {
    const { data: existing } = await supabaseAdmin
      .from('validation_rules')
      .select('id')
      .eq('project_id', rule.project_id)
      .eq('field_id', rule.field_id)
      .eq('name', rule.name)
      .maybeSingle()

    if (existing) continue

    const { error } = await supabaseAdmin.from('validation_rules').insert(rule)
    if (error) {
      console.error(
        `[Enrichment Conflict] Failed to insert validation rule for ${tableName}.${field.name}: ${error.message}`
      )
    } else {
      console.log(
        `[Enrichment Conflict] Created warning rule "${rule.name}" for ${tableName}.${field.name}`
      )
    }
  }
}
