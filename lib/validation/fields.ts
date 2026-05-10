import { z } from 'zod'

// ── createField input validation ───────────────────────────────────────────
//
// Mirrors the canonical Zod adopter at lib/actions/projects.ts (CLAUDE.md §9.3).
// Schemas + tunable bounds live in this non-'use server' module so they can be
// exported as plain values; the 'use server' file at lib/actions/fields.ts
// imports and runs `.safeParse(...)` inside the action body.

export const FIELD_NAME_MAX_LENGTH = 128
export const FIELD_DATA_TYPE_MAX_LENGTH = 128
export const FIELD_FK_REFERENCE_MAX_LENGTH = 256
export const FIELD_DESCRIPTION_MAX_LENGTH = 2000

export const createFieldInputSchema = z.object({
  tableId: z.string().uuid('tableId must be a valid UUID'),

  // Trim + non-empty enforced server-side. Case-sensitive collision detection
  // is the action's responsibility (Postgres is case-sensitive on TEXT, and
  // the existing DDL parser at lib/actions/ddl-upload.ts is too); the schema
  // does not lowercase or otherwise normalise.
  name: z
    .string()
    .trim()
    .min(1, 'Field name cannot be empty')
    .max(FIELD_NAME_MAX_LENGTH, `Field name must be ${FIELD_NAME_MAX_LENGTH} characters or less`),

  dataType: z
    .string()
    .trim()
    .min(1, 'Data type cannot be empty')
    .max(
      FIELD_DATA_TYPE_MAX_LENGTH,
      `Data type must be ${FIELD_DATA_TYPE_MAX_LENGTH} characters or less`
    ),

  inferredType: z.string().trim().min(1).nullable().optional(),
  isNullable: z.boolean().optional(),
  isPrimaryKey: z.boolean().optional(),
  isForeignKey: z.boolean().optional(),
  fkReference: z
    .string()
    .trim()
    .max(
      FIELD_FK_REFERENCE_MAX_LENGTH,
      `FK reference must be ${FIELD_FK_REFERENCE_MAX_LENGTH} characters or less`
    )
    .nullable()
    .optional(),
  description: z
    .string()
    .max(
      FIELD_DESCRIPTION_MAX_LENGTH,
      `Description must be ${FIELD_DESCRIPTION_MAX_LENGTH} characters or less`
    )
    .nullable()
    .optional(),
})

export type CreateFieldInput = z.infer<typeof createFieldInputSchema>

// ── Result shapes (closed-union contract) ──────────────────────────────────
//
// Every field-action returns the discriminated union below. The errorCode is
// a closed union — no string drift — so callers can switch on it.

export type FieldErrorCode =
  // Common
  | 'not_authenticated'
  | 'forbidden'
  | 'db_error'
  // Lookup
  | 'field_not_found'
  | 'table_not_found'
  // createField input
  | 'name_required'
  | 'name_collision'
  | 'invalid_data_type'
  // deleteField guards
  | 'maintenance_mode'

export type FieldActionResult<T> =
  | { success: true; data: T }
  | { success: false; errorCode: FieldErrorCode; error: string }

// previewFieldDeletion
export type DeleteFieldImpactCounts = {
  tfms: number
  mappingSources: number
  transformations: number
  stagedRows: number
  acknowledgments: number
  coverageRows: number
}

export type DeleteFieldImpact = {
  fieldId: string
  fieldName: string
  tableId: string
  counts: DeleteFieldImpactCounts
  /** True when the staged-row count was capped at the LIMIT — UI should render "100+". */
  stagedRowsCapped: boolean
  /** True if any linked transformation has is_ai_generated=false (signals user-authored SQL). */
  hasAuthoredTransformSQL: boolean
  /** Server-derived UI policy: typed-confirmation gate. v1 = stagedRows > 0. */
  requiresTypedConfirmation: boolean
}

// deleteField response
export type AppliedCascade = {
  targetFieldMappings: number
  mappingSources: number
  transformations: number
  stagedRowsScrubbed: number
  acknowledgments: number
  coverageRows: number
  hadAuthoredTransformSql: boolean
}

/** Cap for the staged-rows JSONB-key existence count in previewFieldDeletion.
 *  Mirrors PREVIEW_INVALIDATION_COUNT_CAP from lib/actions/mappings-for-redesign.ts. */
export const PREVIEW_STAGED_ROW_CAP = 101
