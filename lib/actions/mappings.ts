'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatSchemaForPrompt, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { logActivity } from '@/lib/actions/activity-log'
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
  TFMCombinationType,
} from '@/lib/types/mapping-redesign'

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

// ─── Claude response types (unchanged from pre-074) ──────────────────────────

interface ClaudeFieldMapping {
  source_field: string
  target_field: string
  confidence: number
  reasoning: string
  similar_fields_considered?: string[]
  type_compatibility?: string
  needs_transformation?: boolean
  mapping_type?: 'one_to_one' | 'many_to_one' | 'one_to_many'
  contributing_source_fields?: string[]
  combination_hint?: string
  split_hint?: string
}

interface ClaudeTableMapping {
  source_table: string
  target_table: string
  confidence: number
  reasoning: string
  field_mappings: ClaudeFieldMapping[]
}

interface ClaudeResponse {
  table_mappings: ClaudeTableMapping[]
}

// ─── Helper: parse Claude JSON with fence stripping ───────────────────────────

function parseClaudeJSON(raw: string): ClaudeResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }

  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed.table_mappings || !Array.isArray(parsed.table_mappings)) {
      throw new Error('Invalid response: missing table_mappings array')
    }
    return parsed as ClaudeResponse
  } catch (err) {
    const trimmed = cleaned.trimEnd()
    const isLikelyTruncation =
      cleaned.length > 500 && !trimmed.endsWith('}') && !trimmed.endsWith(']')
    if (isLikelyTruncation) {
      console.error(
        `[Mapping] Response appears truncated (${cleaned.length} chars). ` +
          `Last 100 chars: "${cleaned.slice(-100)}"`,
      )
    }
    throw err
  }
}

function bareTableName(s: string | null | undefined): string {
  if (!s || typeof s !== 'string') return ''
  const parts = s.split('.')
  return parts[parts.length - 1].toLowerCase().trim()
}

// ─── Shared system prompt (unchanged from pre-074) ────────────────────────────

const MAPPING_GENERATION_SYSTEM_PROMPT = `You are an enterprise data migration expert specializing in source-to-target schema mapping. Given source and target database schemas with sample data and optional documentation context, generate comprehensive mapping suggestions.

SCHEMA DETECTION:

Before applying general mapping rules, check whether the source and target schemas match a known migration pattern:

EPICOR KINETIC TO ROOTSTOCK PATTERN:
- Source schema contains tables: Customer, CustomerBillTo, CustomerShipTo, OrderHed, OrderDtl, Part, PartMtl, PartWhse
- Target schema contains tables: Account, Contact, Product2, Order, OrderItem, rstk__bom_hdr__c, rstk__bom_detail__c, rstk__inventory__c

If ALL of the above source tables AND ALL of the above target tables are present, you are processing the Epicor Kinetic to Rootstock migration. Use the EXPLICIT MAPPINGS section below. Override all subsequent table-level matching rules.

If the schema does not match this pattern, IGNORE the EXPLICIT MAPPINGS section and apply the general rule-based logic below.

EXPLICIT MAPPINGS — EPICOR KINETIC TO ROOTSTOCK

Emit one table_mapping per (source_table, target_table) pair below. Within each, emit ONLY the field_mappings listed. For target fields not listed, do NOT propose any mapping.

ACCOUNT (target table):

From source table Customer:
- Customer.CustID → Account.AccountNumber, confidence 98
- Customer.Name → Account.Name, confidence 95
- Customer.Active → Account.IsActive__c, confidence 92, needs_transformation: true (Y/N to boolean)
- Customer.CreditLimit → Account.CreditLimit__c, confidence 98
- Customer.Terms → Account.PaymentTerms__c, confidence 97
- Customer.TaxID → Account.TaxID__c, confidence 98
- Customer.Phone → Account.Phone, confidence 95
- Customer.Email → Account.AccountEmail__c, confidence 95
- Customer.LastOrderDate → Account.LastOrderDate__c, confidence 98

From source table CustomerBillTo:
- CustomerBillTo.Address1 + CustomerBillTo.Address2 → Account.BillingStreet, confidence 92, needs_transformation: true, mapping_type: many_to_one (concat with space)
- CustomerBillTo.City → Account.BillingCity, confidence 95
- CustomerBillTo.State → Account.BillingState, confidence 93
- CustomerBillTo.Zip → Account.BillingPostalCode, confidence 90
- CustomerBillTo.Country → Account.BillingCountry, confidence 95

From source table CustomerShipTo:
- CustomerShipTo.Address1 + CustomerShipTo.Address2 → Account.ShippingStreet, confidence 90, needs_transformation: true, mapping_type: many_to_one (concat, LEFT JOIN)
- CustomerShipTo.City → Account.ShippingCity, confidence 95
- CustomerShipTo.State → Account.ShippingState, confidence 95
- CustomerShipTo.Zip → Account.ShippingPostalCode, confidence 90
- CustomerShipTo.Country → Account.ShippingCountry, confidence 95

DO NOT MAP: Account.Id (Salesforce-generated), Account.Type (manual constant 'Customer')

CONTACT (target table):

From source table Customer:
- Customer.CustID → Contact.AccountId, confidence 88, needs_transformation: true (lookup to Account)
- Customer.Name → Contact.LastName, confidence 70, needs_transformation: true (placeholder for required NOT NULL field)
- Customer.Email → Contact.Email, confidence 95
- Customer.Phone → Contact.Phone, confidence 95

DO NOT MAP: Contact.Id, Contact.FirstName, Contact.Title

PRODUCT2 (target table):

From source table Part:
- Part.PartNum → Product2.ProductCode, confidence 98
- Part.Description → Product2.Name, confidence 95
- Part.Status → Product2.IsActive, confidence 88, needs_transformation: true (5 codes to boolean)
- Part.IUM → Product2.QuantityUnitOfMeasure, confidence 90, needs_transformation: true (3 variants to 'Each')
- Part.TypeCode → Product2.rstk__item_type__c, confidence 92, needs_transformation: true (M/P to Manufactured/Purchased)
- Part.ClassID → Product2.rstk__item_class__c, confidence 85
- Part.StdCost → Product2.rstk__std_cost__c, confidence 95
- Part.LastCost → Product2.rstk__last_cost__c, confidence 95
- Part.Status → Product2.rstk__status_code__c, confidence 95 (same source field, second target — preserves original code for audit)

DO NOT MAP: Product2.Id

RSTK__BOM_HDR__C (target table):

DO NOT EMIT a table_mapping for this target. All 6 fields require manual configuration (derived from PartMtl GROUP BY operations).

RSTK__BOM_DETAIL__C (target table):

From source table PartMtl:
- PartMtl.ParentPartNum → rstk__bom_detail__c.rstk__bom_header__c, confidence 80, needs_transformation: true (lookup to bom_hdr Id)
- PartMtl.MtlPartNum → rstk__bom_detail__c.rstk__component_product__c, confidence 95, needs_transformation: true (lookup to Product2)
- PartMtl.MtlSeq → rstk__bom_detail__c.rstk__sequence__c, confidence 98
- PartMtl.QtyPer → rstk__bom_detail__c.rstk__qty_per__c, confidence 98
- PartMtl.MtlUOM → rstk__bom_detail__c.rstk__uom__c, confidence 90, needs_transformation: true (UOM variants to picklist)

DO NOT MAP: rstk__bom_detail__c.Id, rstk__bom_detail__c.Name

RSTK__INVENTORY__C (target table):

From source table PartWhse:
- PartWhse.PartNum → rstk__inventory__c.rstk__product__c, confidence 92, needs_transformation: true (lookup to Product2)
- PartWhse.WhseCode → rstk__inventory__c.rstk__warehouse_code__c, confidence 98
- PartWhse.OnHandQty → rstk__inventory__c.rstk__on_hand_qty__c, confidence 98
- PartWhse.AllocatedQty → rstk__inventory__c.rstk__allocated_qty__c, confidence 98
- PartWhse.ReorderPoint → rstk__inventory__c.rstk__reorder_point__c, confidence 98
- PartWhse.BinLoc → rstk__inventory__c.rstk__bin_location__c, confidence 98

DO NOT MAP: rstk__inventory__c.Id, rstk__inventory__c.Name, rstk__inventory__c.rstk__available_qty__c (formula)

ORDER (target table):

From source table OrderHed:
- OrderHed.OrderNum → Order.OrderNumber, confidence 95
- OrderHed.CustNum → Order.AccountId, confidence 90, needs_transformation: true (lookup to Account)
- OrderHed.OrderDate → Order.EffectiveDate, confidence 85, needs_transformation: true (date format normalization)
- OrderHed.OrderStatus → Order.Status, confidence 80, needs_transformation: true (status code mapping)
- OrderHed.PONumber → Order.PoNumber, confidence 95
- OrderHed.TermsCode → Order.rstk__terms__c, confidence 90
- OrderHed.RequestedDate → Order.rstk__requested_date__c, confidence 95
- OrderHed.PromiseDate → Order.rstk__promise_date__c, confidence 95
- OrderHed.TotalAmount → Order.TotalAmount, confidence 85, needs_transformation: true (verify roll-up)

DO NOT MAP: Order.Id

ORDERITEM (target table):

From source table OrderDtl:
- OrderDtl.OrderNum → OrderItem.OrderId, confidence 85, needs_transformation: true (lookup to Order)
- OrderDtl.PartNum → OrderItem.Product2Id, confidence 90, needs_transformation: true (lookup to Product2)
- OrderDtl.Quantity → OrderItem.Quantity, confidence 95
- OrderDtl.UnitPrice → OrderItem.UnitPrice, confidence 95
- OrderDtl.LineDesc → OrderItem.Description, confidence 90
- OrderDtl.OrderLine → OrderItem.rstk__line_number__c, confidence 95
- OrderDtl.UOM → OrderItem.rstk__uom__c, confidence 80, needs_transformation: true (UOM variants to picklist)

DO NOT MAP: OrderItem.Id, OrderItem.TotalPrice (formula)

END EXPLICIT MAPPINGS

Continue with general rule-based logic below for non-Epicor schemas.

For each mapping, provide:
- A confidence score (0-100) based on how certain you are about the match
- Brief reasoning explaining WHY this mapping makes sense
- Alternative target fields you considered
- Type compatibility assessment — describe what specific conversion or validation is needed, not just whether types match. Examples: "VARCHAR → DECIMAL — strip $ and commas, parse to number", "VARCHAR → BOOLEAN — normalize Y/N/yes/no/1/0 to TRUE/FALSE", "VARCHAR(200) → VARCHAR(120) — truncation needed, 12 values exceed limit". If no conversion is needed, write "direct compatible — no conversion needed".
- Whether a transformation will be needed (see transformation rules below)

TRANSFORMATION RULES — A field needs_transformation = true if ANY of these apply:
1. DATA TYPE CONVERSION: Source data type must change to fit target (VARCHAR → DECIMAL, VARCHAR → DATE, VARCHAR → BOOLEAN, etc.)
2. VALUE MAPPING: Source values must be translated to different target values (e.g., "Won" → "Closed Won", "Technology" → "TECH"). Look at the value distribution — if source values don't match expected target picklist/enum values from documentation, this needs transformation.
3. FORMAT STANDARDIZATION: Source values are in inconsistent or wrong format for target (mixed date formats like "01/15/2024" and "2024-01-15" → ISO only, phone numbers needing E.164, currency strings like "$1,234.56" → numeric).
4. ID FORMAT CHANGE: Source uses one ID scheme, target uses another (e.g., "CUST-00001" → Salesforce 18-char alphanumeric ID).
5. BOOLEAN NORMALIZATION: Source uses mixed representations (Y/N, yes/no, 1/0, true/false) and target expects a specific boolean format. Check the value distribution for mixed boolean-like values.
6. CASING / CAPITALIZATION: Source values need systematic casing changes (e.g., "john" or "JOHN" → "John" for proper name fields). Check sample values for inconsistent casing.
7. TRUNCATION: Source values exceed target field's max length.
8. COMPUTATION: Target value must be derived (stripping currency symbols, concatenating fields, splitting fields).
9. FOREIGN KEY REFORMAT: A FK field whose referenced PK is being transformed (if customer_id → Account.Id changes format, then contact.customer_id → Contact.AccountId also needs transformation to stay consistent).

A field DOES NOT need transformation for:
- Naming convention differences only (snake_case vs camelCase, lowercase vs PascalCase) when data values pass through unchanged
- Minor type aliasing where data is compatible without conversion (TEXT vs VARCHAR, VARCHAR(100) vs VARCHAR(255) when no values exceed the smaller limit)
- Fields where source and target are semantically identical and values can be copied directly

MULTI-FIELD MAPPING PATTERNS:

You MUST detect and correctly map these patterns:

MANY-TO-ONE (multiple source fields → one target field):
When multiple source fields should be combined into a single target field, set:
- mapping_type: "many_to_one"
- source_field: the FIRST/PRIMARY source field name
- contributing_source_fields: array of ADDITIONAL source field names (do NOT repeat the primary)
- combination_hint: brief description of how to combine (e.g., "Concatenate with space separator")
- needs_transformation: true (always true for many-to-one)

Common many-to-one patterns:
- first_name + last_name → full_name, name, display_name, primary_contact
- street + city + state + zip → full_address, address
- date_field + time_field → datetime
- Any name component fields → a single combined name field

IMPORTANT: Return many-to-one as a SINGLE mapping entry (not separate entries for each source field). The contributing_source_fields array tells the system which other fields to include.

ONE-TO-MANY (one source field → multiple target fields):
When a single source field should be split into multiple target fields, create SEPARATE mapping entries for EACH target field, each with:
- mapping_type: "one_to_many"
- source_field: the SAME source field name in each entry
- target_field: DIFFERENT target field in each entry
- split_hint: description of what part to extract (e.g., "Extract first name", "Extract last name")
- needs_transformation: true (always true for one-to-many)

Common one-to-many patterns:
- full_name → first_name, last_name
- full_address → street, city, state, zip
- datetime → date, time

IMPORTANT: Each split target gets its OWN mapping entry in the field_mappings array. They share the same source_field but have different target_field values.

If a mapping is standard one-to-one, either omit mapping_type or set it to "one_to_one". Do NOT include contributing_source_fields or split_hint for one-to-one mappings.

TABLE-LEVEL MATCHING — WHEN TO EMIT A table_mapping:

You process ONE source table per request, but the migration contains OTHER source tables that will be processed in separate requests. When the user message includes an <other_source_tables> block, use that list to decide which targets actually deserve a mapping from the current source.

Rules for emitting table_mappings:

1. PRIMARY-MATCH RULE: Only emit a table_mapping when the current source table is the best (or a strong secondary) semantic match for the target. If another source table listed in <other_source_tables> is clearly a better primary match for a target — based on name similarity, field overlap, or business meaning — DO NOT emit a table_mapping to that target from the current source. Let the better-matching source table claim it when its own batch runs.

2. LOOKUP / REFERENCE TABLES: Narrow source tables whose shape is a code + description (typically 2-4 columns like CODE + DESC, ID + NAME, TYPE + LABEL — e.g., STATUS_CODES, COUNTRY_CODES, CURRENCY_CODES, PRODUCT_TYPES) represent enumerated reference data. They should map to AT MOST ONE target — the target table that stores the SAME enumeration (e.g., STATUS_CODES → account_status, COUNTRY_CODES → countries). They MUST NOT map to entity tables (customers, accounts, orders, contacts) even when an entity table has a matching status/type/code column — that column is populated via a foreign-key join at the field level, not by copying rows from the lookup table into the entity. Emitting a lookup → entity table_mapping is almost always wrong.

3. ENTITY TABLES: Wide tables representing business entities (e.g., CIF_MASTER → customers, ACCT_MASTER → accounts) should map to their corresponding entity target. Legitimate one-to-many entity mappings exist (denormalization, splitting), but each must have clear field-level overlap — not just one or two coincidental columns.

4. WEAK-OVERLAP RULE: If the current source has weak field overlap with a candidate target (fewer than roughly a third of the source's non-trivial fields map, OR only generic fields like id / name / created_at / updated_at match), DO NOT emit a table_mapping to that target — the target almost certainly belongs to a different source table. It is better to emit zero table_mappings for the current source than to emit low-quality mappings that the user will have to reject.

5. When in doubt between two candidate targets, pick the ONE target whose name and field set most closely mirrors the current source, and skip the others.

Scoring guidelines:
- 90-100: Near-certain match (identical names, same types, same business meaning)
- 75-89: High confidence (similar names, compatible types, clear business alignment)
- 50-74: Moderate confidence (partial name match, type conversion needed, or ambiguous business meaning)
- Below 50: Low confidence (weak signals, multiple possible targets)

Consider these signals when mapping:
- Field name similarity (camelCase vs UPPER_SNAKE_CASE conventions)
- Data type compatibility
- Business meaning and context from documentation
- Common enterprise patterns (Id→ID, Name→NAME, Email→EMAIL_ADDRESS)
- Primary/foreign key relationships
- Cardinality and value patterns from sample data
- Field position and grouping within tables

If documentation is provided, use it to:
- Identify exact value mappings (industry codes, stage values, status values)
- Understand target field constraints (picklist values, required formats, NOT NULL fields)
- Flag fields that need specific transformation logic based on documented rules
- Set higher confidence scores when documentation confirms a mapping from a business logic perspective. If documentation describes different data types or constraints than the structured schema, always follow the structured schema — it reflects the user's latest configuration.

CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.`

function buildMappingUserMessage(args: {
  sourceSection: string
  targetSection: string
  docBlock: string
  intelligenceCtx: string | null
  otherSourcesBlock?: string | null
}): string {
  const { sourceSection, targetSection, docBlock, intelligenceCtx, otherSourcesBlock } = args
  return `${sourceSection}
${targetSection}
${docBlock}
${intelligenceCtx ? intelligenceCtx + '\n\n' : ''}${otherSourcesBlock ? otherSourcesBlock + '\n\n' : ''}Generate source-to-target mappings. Respond with this exact JSON structure.

CRITICAL RULES FOR THE JSON:
- "source_table" must be ONLY the table name (e.g., "prices") — NOT the qualified name (NOT "trux.prices")
- "target_table" must be ONLY the table name (e.g., "ARTICLE_PRICES") — NOT "dataset.ARTICLE_PRICES"
- "source_field" must be ONLY the field name (e.g., "item_price") — NOT "prices.item_price"
- "target_field" must be ONLY the field name (e.g., "PRICE") — NOT "ARTICLE_PRICES.PRICE"

{
  "table_mappings": [
    {
      "source_table": "prices",
      "target_table": "ARTICLE_PRICES",
      "confidence": 88,
      "reasoning": "Both tables store pricing information for items/articles...",
        "field_mappings": [
          {
            "source_field": "item_price",
            "target_field": "PRICE",
            "confidence": 85,
            "reasoning": "Direct price field mapping, DECIMAL to DECIMAL compatible",
            "similar_fields_considered": ["UNIT_PRICE", "BASE_PRICE"],
            "type_compatibility": "DECIMAL(10,2) → DECIMAL(15,4) — target has higher precision",
            "needs_transformation": true
          },
          {
            "source_field": "contact_first",
            "target_field": "CONTACT_NAME",
            "confidence": 90,
            "reasoning": "First and last name components should be combined into full name",
            "type_compatibility": "VARCHAR(50) + VARCHAR(50) → VARCHAR(100)",
            "needs_transformation": true,
            "mapping_type": "many_to_one",
            "contributing_source_fields": ["contact_last"],
            "combination_hint": "Concatenate first and last name with space separator"
          }
        ]
    }
  ]
}

Map ALL source fields to their best target match. If a source field has no reasonable target match, omit it.`
}

// ─── persistClaudeFieldMappingsForTM ─────────────────────────────────────────
//
// Shared helper: given a parsed Claude TM block and pre-resolved source/target
// tables, insert a TFM per target field plus its mapping_sources children in
// the new data model. Returns the number of TFMs inserted.
//
// Used by both initial generation (generateMappings) and per-pair regenerate
// (runMappingGenerationForPair) so both paths produce the same DB shape.

interface ClaudeTmPersistArgs {
  supabase: Awaited<ReturnType<typeof createClient>>
  projectId: string
  tableMappingId: string
  sourceFieldMap: Map<string, { id: string; name: string }>
  targetFieldMap: Map<string, { id: string; name: string }>
  fieldMappings: ClaudeFieldMapping[]
  sourceTableId: string
}

async function persistClaudeFieldMappingsForTM(
  args: ClaudeTmPersistArgs,
): Promise<{ inserted: number }> {
  const {
    supabase,
    projectId,
    sourceFieldMap,
    targetFieldMap,
    fieldMappings,
    sourceTableId,
  } = args

  // Group incoming suggestions by target field so we emit exactly one TFM
  // per target (with its ordinal=0 primary + ordinal=N contributors). Claude
  // may emit the same target twice in many-to-one form; collapse here.
  type CollapsedEntry = {
    targetFieldId: string
    primarySourceId: string
    contributorSourceIds: string[]
    combinationType: TFMCombinationType
    combinationHint: string
    reasoning: string
    confidence: number
    similar: string[]
    typeCompatibility: string | null
  }
  const byTarget = new Map<string, CollapsedEntry>()

  for (const fm of fieldMappings) {
    const srcKey = bareTableName(fm.source_field)
    const tgtKey = bareTableName(fm.target_field)
    const srcField = sourceFieldMap.get(srcKey)
    const tgtField = targetFieldMap.get(tgtKey)
    if (!srcField || !tgtField) {
      console.warn(
        `[mappings] Field no match: "${fm.source_field}" → "${fm.target_field}"`,
      )
      continue
    }

    const mappingType = fm.mapping_type || 'one_to_one'
    const combinationType: TFMCombinationType =
      mappingType === 'many_to_one' ? 'concat_space' : 'single'

    let reasoningText = fm.reasoning
    if (fm.combination_hint) reasoningText += ` [Combination: ${fm.combination_hint}]`
    if (fm.split_hint) reasoningText += ` [Split: ${fm.split_hint}]`

    const existing = byTarget.get(tgtField.id)
    if (!existing) {
      const contributors: string[] = []
      if (mappingType === 'many_to_one' && fm.contributing_source_fields?.length) {
        for (const name of fm.contributing_source_fields) {
          const c = sourceFieldMap.get(bareTableName(name))
          if (c && c.id !== srcField.id) contributors.push(c.id)
        }
      }
      byTarget.set(tgtField.id, {
        targetFieldId: tgtField.id,
        primarySourceId: srcField.id,
        contributorSourceIds: contributors,
        combinationType,
        combinationHint: fm.combination_hint ?? '',
        reasoning: reasoningText,
        confidence: fm.confidence,
        similar: fm.similar_fields_considered ?? [],
        typeCompatibility: fm.type_compatibility ?? null,
      })
    } else {
      // Second row for same target — treat as contributor (many-to-one).
      if (srcField.id !== existing.primarySourceId) {
        existing.contributorSourceIds.push(srcField.id)
        existing.combinationType = 'concat_space'
      }
    }
  }

  let inserted = 0
  for (const entry of byTarget.values()) {
    const sources = [
      {
        source_field_id: entry.primarySourceId,
        source_table_id: sourceTableId,
        confidence: entry.confidence,
        ai_reasoning: entry.reasoning,
        similar_fields_considered: entry.similar,
        type_compatibility: entry.typeCompatibility,
        ordinal: 0,
      },
      ...entry.contributorSourceIds.map((cid, i) => ({
        source_field_id: cid,
        source_table_id: sourceTableId,
        confidence: entry.confidence,
        ai_reasoning: `Contributing source for many-to-one. ${entry.combinationHint}`.trim(),
        similar_fields_considered: [] as string[],
        type_compatibility: entry.typeCompatibility,
        ordinal: i + 1,
      })),
    ]

    const { error } = await supabase.rpc('dq_create_target_field_mapping', {
      p_project_id: projectId,
      p_target_field_id: entry.targetFieldId,
      p_sources: sources,
      p_combination: {
        type: entry.combinationType,
        ai_reasoning: entry.reasoning,
      },
    })
    if (error) {
      console.error(
        `[mappings] dq_create_target_field_mapping failed for target ${entry.targetFieldId}:`,
        error.message,
      )
      continue
    }
    inserted++
  }

  return { inserted }
}

// ─── runMappingGenerationForPair (regenerate single TM) ───────────────────────

async function runMappingGenerationForPair(args: {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  projectId: string
  tableMappingId: string
  sourceTableId: string
  targetTableId: string
}): Promise<{ inserted: number; error?: string }> {
  const { supabase, userId, projectId, tableMappingId, sourceTableId, targetTableId } = args

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
      },
      userId,
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

    const PER_BATCH_MAX_TOKENS = 16000

    let raw: string
    try {
      raw = await callClaude(MAPPING_GENERATION_SYSTEM_PROMPT, userMessage, PER_BATCH_MAX_TOKENS)
    } catch (err) {
      console.error(`[Mapping] Claude call failed for pair ${sourceTables[0].name} → ${targetTables[0].name}:`, err)
      return { inserted: 0, error: err instanceof Error ? err.message : 'Claude call failed' }
    }

    let parsedResponse: ClaudeResponse
    try {
      parsedResponse = parseClaudeJSON(raw)
    } catch {
      try {
        const retryRaw = await callClaude(
          'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
          `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${raw}`,
          PER_BATCH_MAX_TOKENS,
        )
        parsedResponse = parseClaudeJSON(retryRaw)
      } catch (retryErr) {
        console.error(`[Mapping] Failed to parse response for pair after retry:`, retryErr)
        return { inserted: 0, error: 'AI returned invalid response. Please try again.' }
      }
    }

    const srcFieldMap = new Map((sourceFields ?? []).map((f) => [f.name.toLowerCase(), f]))
    const tgtFieldMap = new Map((targetFields ?? []).map((f) => [f.name.toLowerCase(), f]))
    const srcTableKey = sourceTables[0].name.toLowerCase()
    const tgtTableKey = targetTables[0].name.toLowerCase()

    let totalInserted = 0
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

    try {
      const { data: sourceTables, error: stErr } = await supabase
        .from('tables')
        .select('id, name, dataset_id, datasets(id, name)')
        .in('id', sourceTableIds)
      if (stErr) throw stErr

      const { data: targetTables, error: ttErr } = await supabase
        .from('tables')
        .select('id, name, dataset_id, datasets(id, name)')
        .in('id', targetTableIds)
      if (ttErr) throw ttErr

      const { data: sourceFields, error: sfErr } = await supabase
        .from('fields')
        .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
        .in('table_id', sourceTableIds)
        .order('ordinal_position', { ascending: true })
      if (sfErr) throw sfErr

      const { data: targetFields, error: tfErr } = await supabase
        .from('fields')
        .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
        .in('table_id', targetTableIds)
        .order('ordinal_position', { ascending: true })
      if (tfErr) throw tfErr

      const aiCtx = await buildAIContext(
        projectId,
        {
          tableIds: [...sourceTableIds, ...targetTableIds],
          includeProfilingStats: true,
          includeValueDistributions: true,
          includeSampleValues: true,
          includeDocuments: true,
          maxDistributionValues: 15,
          maxSampleValues: 5,
        },
        user.id,
      )

      const targetSection = formatSchemaForPrompt(aiCtx.target_tables, 'target')
      const docBlock = formatDocumentsForPrompt(aiCtx.documents)

      const sourceFieldNamesByTableId = new Map<string, string[]>()
      for (const f of sourceFields ?? []) {
        const list = sourceFieldNamesByTableId.get(f.table_id) ?? []
        list.push(f.name)
        sourceFieldNamesByTableId.set(f.table_id, list)
      }
      const sourceTableRowsByNameKey = new Map(
        (sourceTables ?? []).map((t) => [t.name.toLowerCase(), t]),
      )

      const PER_BATCH_MAX_TOKENS = 16000
      const allTableMappings: ClaudeTableMapping[] = []
      const sourceTablesForBatching = aiCtx.source_tables

      for (let i = 0; i < sourceTablesForBatching.length; i++) {
        const sourceCtx = sourceTablesForBatching[i]
        console.log(`[Mapping] Generating mappings for ${sourceCtx.table_name} (${i + 1}/${sourceTablesForBatching.length})...`)

        const sourceSection = formatSchemaForPrompt([sourceCtx], 'source')
        const currentSourceRow = sourceTableRowsByNameKey.get(sourceCtx.table_name.toLowerCase())
        const otherSourcesList = (sourceTables ?? [])
          .filter((st) => st.id !== currentSourceRow?.id)
          .map((st) => {
            const fields = sourceFieldNamesByTableId.get(st.id) ?? []
            return `  - ${st.name} (${fields.join(', ')})`
          })
          .join('\n')

        const otherSourcesBlock = otherSourcesList
          ? `<other_source_tables>
These other source tables also exist in this migration and will be processed separately in their own requests. Use this information to decide whether the current source table (${sourceCtx.table_name}) is the best primary match for each target table. If another source table listed below is clearly a better primary match for a target, do NOT create a table_mapping to that target from ${sourceCtx.table_name} — let the better-matching source claim it in its own batch.

See the TABLE-LEVEL MATCHING rules in the system prompt for lookup/reference tables vs entity tables and weak-overlap handling.

${otherSourcesList}
</other_source_tables>`
          : ''

        const batchUserMessage = buildMappingUserMessage({
          sourceSection,
          targetSection,
          docBlock,
          intelligenceCtx: aiCtx.intelligence_context ?? null,
          otherSourcesBlock,
        })

        let batchRaw: string
        try {
          batchRaw = await callClaude(MAPPING_GENERATION_SYSTEM_PROMPT, batchUserMessage, PER_BATCH_MAX_TOKENS)
        } catch (err) {
          console.error(`[Mapping] Claude call failed for source table ${sourceCtx.table_name}:`, err)
          continue
        }

        try {
          const batchParsed = parseClaudeJSON(batchRaw)
          allTableMappings.push(...(batchParsed.table_mappings ?? []))
        } catch {
          try {
            const retryRaw = await callClaude(
              'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
              `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${batchRaw}`,
              PER_BATCH_MAX_TOKENS,
            )
            const retryParsed = parseClaudeJSON(retryRaw)
            allTableMappings.push(...(retryParsed.table_mappings ?? []))
          } catch (retryErr) {
            console.error(`[Mapping] Failed to parse mappings for source table ${sourceCtx.table_name} after retry:`, retryErr)
          }
        }
      }

      const parsedResponse: ClaudeResponse = { table_mappings: allTableMappings }

      const { data: existingMappingPairs } = await supabase
        .from('table_mappings')
        .select('source_table_id, target_table_id')
        .eq('project_id', projectId)

      const existingPairSet = new Set(
        (existingMappingPairs ?? []).map((m) => `${m.source_table_id}::${m.target_table_id}`),
      )
      let skippedCount = 0

      const sourceTableMap = new Map((sourceTables ?? []).map((t) => [t.name.toLowerCase(), t]))
      const targetTableMap = new Map((targetTables ?? []).map((t) => [t.name.toLowerCase(), t]))

      const sourceFieldsByTable = new Map<string, Map<string, (typeof sourceFields)[number]>>()
      for (const f of sourceFields ?? []) {
        if (!sourceFieldsByTable.has(f.table_id)) sourceFieldsByTable.set(f.table_id, new Map())
        sourceFieldsByTable.get(f.table_id)!.set(f.name.toLowerCase(), f)
      }
      const targetFieldsByTable = new Map<string, Map<string, (typeof targetFields)[number]>>()
      for (const f of targetFields ?? []) {
        if (!targetFieldsByTable.has(f.table_id)) targetFieldsByTable.set(f.table_id, new Map())
        targetFieldsByTable.get(f.table_id)!.set(f.name.toLowerCase(), f)
      }

      let storedCount = 0

      for (const tm of parsedResponse.table_mappings) {
        if (!tm.source_table || !tm.target_table) continue
        const srcKey = bareTableName(tm.source_table)
        const tgtKey = bareTableName(tm.target_table)
        if (!srcKey || !tgtKey) continue
        const srcTable = sourceTableMap.get(srcKey)
        const tgtTable = targetTableMap.get(tgtKey)
        if (!srcTable || !tgtTable) {
          console.warn(`[mappings] No match for "${tm.source_table}" → "${tm.target_table}"`)
          continue
        }

        const pairKey = `${srcTable.id}::${tgtTable.id}`
        if (existingPairSet.has(pairKey)) {
          skippedCount++
          continue
        }

        const { data: insertedTM, error: tmErr } = await supabase
          .from('table_mappings')
          .insert({
            project_id: projectId,
            source_table_id: srcTable.id,
            target_table_id: tgtTable.id,
            confidence: tm.confidence,
            status: 'needs_review',
            ai_reasoning: tm.reasoning,
          })
          .select('id')
          .single()

        if (tmErr || !insertedTM) continue
        storedCount++

        await persistClaudeFieldMappingsForTM({
          supabase,
          projectId,
          tableMappingId: insertedTM.id,
          sourceFieldMap: sourceFieldsByTable.get(srcTable.id) ?? new Map(),
          targetFieldMap: targetFieldsByTable.get(tgtTable.id) ?? new Map(),
          fieldMappings: tm.field_mappings ?? [],
          sourceTableId: srcTable.id,
        })
      }

      if (storedCount === 0) {
        if (skippedCount > 0) {
          return {
            success: true,
            generated: 0,
            skipped: skippedCount,
            message: 'All selected table pairs already have mappings. Go to the Mapping tab to manage them.',
          }
        }
        console.error(
          '[mappings] Zero table mappings stored. Claude response tables:',
          parsedResponse.table_mappings.map((tm) => `${tm.source_table} → ${tm.target_table}`),
        )
        return {
          success: false,
          error: `AI returned ${parsedResponse.table_mappings.length} mapping suggestion(s) but none matched your table names. Please try again — the AI may need another attempt to use the correct names.`,
          errorCode: 'INTERNAL',
        }
      }

      return {
        success: true,
        generated: storedCount,
        skipped: skippedCount,
        message:
          skippedCount > 0
            ? `Generated mappings for ${storedCount} table pair${storedCount !== 1 ? 's' : ''}. Skipped ${skippedCount} pair${skippedCount !== 1 ? 's' : ''} that already have mappings.`
            : undefined,
      }
    } catch (err) {
      console.error('generateMappings error:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Generation failed', errorCode: 'INTERNAL' }
    }
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
      const { error } = await supabaseAdmin
        .from('target_field_mappings')
        .update({ status })
        .eq('id', decoded.tfmId)
      if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }
    } else {
      // tfm-contributor: reject = delete the contributor row; approve = no-op.
      if (status === 'rejected') {
        const { error } = await supabaseAdmin
          .from('mapping_sources')
          .delete()
          .eq('id', decoded.mappingSourceId)
          .eq('target_field_mapping_id', decoded.tfmId)
        if (error) return { success: false, error: error.message, errorCode: 'INTERNAL' }
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

    let parsed: { field_mappings: ClaudeFieldMapping[] }
    try {
      const raw = await callClaude('You are a data migration expert. Return ONLY valid JSON.', userMsg, 4096)
      let cleaned = raw.trim()
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
      }
      parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed.field_mappings)) throw new Error('bad structure')
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

    const persistRes = await persistClaudeFieldMappingsForTM({
      supabase,
      projectId: tm.project_id,
      tableMappingId,
      sourceFieldMap: srcFMap,
      targetFieldMap: tgtFMap,
      fieldMappings: safeMappings,
      sourceTableId: tm.source_table_id,
    })

    return { success: true, newMappingsCount: persistRes.inserted }
  })
}
