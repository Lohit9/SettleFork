/**
 * Hand-constructed fixture scenario for golden-output tests (Prompt 3c).
 *
 * Purpose: a deterministic, in-memory representation of a small but
 * comprehensive migration project that exercises every customer-facing code
 * path in `lib/actions/outputs.ts`, `lib/actions/execution-package.ts`, and
 * `lib/quality/readiness-score.ts`.
 *
 * Every ID below is a stable placeholder — no UUIDs generated at runtime — so
 * the fixture is byte-identical across machines and CI runs.
 *
 * Coverage matrix (see Prompt 3c Gate 2 §5):
 *
 *   Case 1  — Simple 1:1 mapping               TFM-1 (no transform), TFM-3 (dismissed), TFM-8 (with transform)
 *   Case 2  — Concat multi-source              TFM-2 (concat_space, two sources)
 *   Case 3  — Value assignment                 TFM-4 (custom_sql, zero sources)
 *   Case 4  — Target acknowledgment            TFM-5 (is_acknowledged=true, combination_type=NULL)
 *   Case 5  — Source acknowledgment            SA-1 (s_phone)
 *   Case 6  — Transform APPLIED                T-2, T-3, T-4, T-6, T-7, T-8
 *   Case 7  — Transform NOT applied            T-1 (status='saved')
 *   Case 8  — FK-dependent table pair          (t_customers → t_orders via t_customer_fk → t_customer_id)
 *   Case 9  — Rejected TFM (MUST NOT APPEAR)   TFM-9 (status='rejected')
 *
 * R1: TFM-3 (`t_email_norm`) carries `needs_transformation=false` — the
 *     user-dismissed state. It STILL has an applied transformation (T-3) to
 *     prove that dismissing the flag and having a transform are independent
 *     concerns.
 *
 * This fixture is the SOURCE OF TRUTH for every golden-output file in this
 * directory. If you add a coverage case, add it here first, then regenerate
 * the affected fixtures via `UPDATE_FIXTURES=1 npx vitest tests/outputs/`.
 * See `README.md` in this directory for the change process.
 */

import type {
  MappingSourceRow,
  SourceFieldAcknowledgmentRow,
  TargetFieldMappingRow,
  TransformationRow,
} from '@/lib/types/mapping-redesign'
import type { FieldLookupRow, TableMappingLookup } from '@/lib/actions/_outputs-helpers'

// ─── Stable IDs ────────────────────────────────────────────────────────────

export const IDS = {
  project: 'proj-fixture-0001',
  datasetSource: 'ds-src-0001',
  datasetTarget: 'ds-tgt-0001',

  // Source tables
  tableSCustomers: 'tbl-s-cust-0001',
  tableSOrders: 'tbl-s-ord-0001',

  // Target tables
  tableTCustomers: 'tbl-t-cust-0001',
  tableTOrders: 'tbl-t-ord-0001',

  // Source fields (s_customers)
  fSId: 'fld-s-id-0001',
  fSFirstName: 'fld-s-firstname-0001',
  fSLastName: 'fld-s-lastname-0001',
  fSEmail: 'fld-s-email-0001',
  fSPhone: 'fld-s-phone-0001', // source-ack
  fSLegacyFlag: 'fld-s-legacy-0001', // unmapped

  // Source fields (s_orders)
  fSoId: 'fld-so-id-0001',
  fSoCustomerId: 'fld-so-custid-0001',
  fSoTotalCents: 'fld-so-total-0001',

  // Target fields (t_customers)
  fTCustomerId: 'fld-t-custid-0001',
  fTFullName: 'fld-t-fullname-0001',
  fTEmailNorm: 'fld-t-emailnorm-0001',
  fTTenantId: 'fld-t-tenant-0001',
  fTNotes: 'fld-t-notes-0001', // target-ack
  // Flag 2 (2026-04-22): relocated TFM-9 target from t_orders.t_orphan to
  // t_customers.t_deprecated_flag so the rejected TFM is actually owned by
  // tmCust and exercises the groupTfmsWithRejected path instead of being
  // silently dropped by the TM lookup. See README ▸ Fixture change process.
  fTDeprecatedFlag: 'fld-t-deprecated-0001', // rejected TFM target

  // Target fields (t_orders)
  fTOrderId: 'fld-t-ordid-0001',
  fTCustomerFk: 'fld-t-custfk-0001',
  fTAmountDollars: 'fld-t-amount-0001',

  // Table mappings
  tmCust: 'tm-cust-0001',
  tmOrd: 'tm-ord-0001',

  // TFMs (target_field_mappings)
  tfm1: 'tfm-00000001',
  tfm2: 'tfm-00000002',
  tfm3: 'tfm-00000003',
  tfm4: 'tfm-00000004',
  tfm5: 'tfm-00000005',
  tfm6: 'tfm-00000006',
  tfm7: 'tfm-00000007',
  tfm8: 'tfm-00000008',
  tfm9: 'tfm-00000009',

  // Mapping sources
  ms1P: 'ms-1-p-0001',
  ms2P: 'ms-2-p-0001',
  ms2C: 'ms-2-c-0001', // contributor
  ms3P: 'ms-3-p-0001',
  ms6P: 'ms-6-p-0001',
  ms7P: 'ms-7-p-0001',
  ms8P: 'ms-8-p-0001',
  ms9P: 'ms-9-p-0001', // rejected TFM's MS — also rejected by inheritance

  // Transformations
  t1: 'tx-00000001',
  t2: 'tx-00000002',
  t3: 'tx-00000003',
  t4: 'tx-00000004',
  t6: 'tx-00000006',
  t7: 'tx-00000007',
  t8: 'tx-00000008',

  // Source ack
  sa1: 'sack-00000001',
} as const

// Stable ISO timestamp for every created_at/updated_at. Fixture avoids clock
// drift by using this single constant.
const FIXED_TS = '2026-01-15T12:00:00.000Z'

// ─── Dataset + table + field rows ──────────────────────────────────────────

export interface FixtureTable {
  id: string
  dataset_id: string
  name: string
  row_count: number
}

export interface FixtureField {
  id: string
  table_id: string
  name: string
  data_type: string
  inferred_type: string | null
  is_nullable: boolean
  is_primary_key: boolean
  is_foreign_key: boolean
  fk_reference: string | null
  check_constraint: string | null
  default_value: string | null
  ordinal_position: number
}

export interface FixtureDataset {
  id: string
  project_id: string
  name: string
  role: 'source' | 'target'
}

export const datasets: FixtureDataset[] = [
  { id: IDS.datasetSource, project_id: IDS.project, name: 'Legacy CRM', role: 'source' },
  { id: IDS.datasetTarget, project_id: IDS.project, name: 'Modern ERP', role: 'target' },
]

export const tables: FixtureTable[] = [
  { id: IDS.tableSCustomers, dataset_id: IDS.datasetSource, name: 's_customers', row_count: 100 },
  { id: IDS.tableSOrders, dataset_id: IDS.datasetSource, name: 's_orders', row_count: 250 },
  { id: IDS.tableTCustomers, dataset_id: IDS.datasetTarget, name: 't_customers', row_count: 0 },
  { id: IDS.tableTOrders, dataset_id: IDS.datasetTarget, name: 't_orders', row_count: 0 },
]

export const fields: FixtureField[] = [
  // s_customers
  mk(IDS.fSId, IDS.tableSCustomers, 's_id', 'integer', 1, { isPk: true }),
  mk(IDS.fSFirstName, IDS.tableSCustomers, 's_first_name', 'text', 2),
  mk(IDS.fSLastName, IDS.tableSCustomers, 's_last_name', 'text', 3),
  mk(IDS.fSEmail, IDS.tableSCustomers, 's_email', 'text', 4),
  mk(IDS.fSPhone, IDS.tableSCustomers, 's_phone', 'text', 5),
  mk(IDS.fSLegacyFlag, IDS.tableSCustomers, 's_legacy_flag', 'text', 6),
  // s_orders
  mk(IDS.fSoId, IDS.tableSOrders, 'so_id', 'integer', 1, { isPk: true }),
  mk(IDS.fSoCustomerId, IDS.tableSOrders, 'so_customer_id', 'integer', 2, {
    isFk: true,
    fkRef: 's_customers.s_id',
  }),
  mk(IDS.fSoTotalCents, IDS.tableSOrders, 'so_total_cents', 'integer', 3),
  // t_customers
  mk(IDS.fTCustomerId, IDS.tableTCustomers, 't_customer_id', 'integer', 1, {
    isPk: true,
    notNull: true,
  }),
  mk(IDS.fTFullName, IDS.tableTCustomers, 't_full_name', 'text', 2, { notNull: true }),
  mk(IDS.fTEmailNorm, IDS.tableTCustomers, 't_email_norm', 'text', 3),
  mk(IDS.fTTenantId, IDS.tableTCustomers, 't_tenant_id', 'uuid', 4, { notNull: true }),
  mk(IDS.fTNotes, IDS.tableTCustomers, 't_notes', 'text', 5),
  mk(IDS.fTDeprecatedFlag, IDS.tableTCustomers, 't_deprecated_flag', 'text', 6),
  // t_orders
  mk(IDS.fTOrderId, IDS.tableTOrders, 't_order_id', 'integer', 1, { isPk: true, notNull: true }),
  mk(IDS.fTCustomerFk, IDS.tableTOrders, 't_customer_fk', 'integer', 2, {
    isFk: true,
    fkRef: 't_customers.t_customer_id',
    notNull: true,
  }),
  mk(IDS.fTAmountDollars, IDS.tableTOrders, 't_amount_dollars', 'numeric(10,2)', 3),
]

function mk(
  id: string,
  table_id: string,
  name: string,
  data_type: string,
  ordinal: number,
  opts: {
    isPk?: boolean
    isFk?: boolean
    fkRef?: string
    notNull?: boolean
  } = {},
): FixtureField {
  return {
    id,
    table_id,
    name,
    data_type,
    inferred_type: data_type,
    is_nullable: !opts.notNull,
    is_primary_key: !!opts.isPk,
    is_foreign_key: !!opts.isFk,
    fk_reference: opts.fkRef ?? null,
    check_constraint: null,
    default_value: null,
    ordinal_position: ordinal,
  }
}

// ─── Table mappings ────────────────────────────────────────────────────────

export interface FixtureTableMapping extends TableMappingLookup {
  project_id: string
  status: 'needs_review' | 'approved' | 'rejected'
}

export const tableMappings: FixtureTableMapping[] = [
  {
    id: IDS.tmCust,
    project_id: IDS.project,
    source_table_id: IDS.tableSCustomers,
    target_table_id: IDS.tableTCustomers,
    status: 'approved',
  },
  {
    id: IDS.tmOrd,
    project_id: IDS.project,
    source_table_id: IDS.tableSOrders,
    target_table_id: IDS.tableTOrders,
    status: 'approved',
  },
]

// ─── Target field mappings (TFMs) ──────────────────────────────────────────

export const targetFieldMappings: TargetFieldMappingRow[] = [
  // ─── Confidence semantics ─────────────────────────────────────────────
  //
  // Production stores target_field_mappings.confidence and
  // mapping_sources.confidence as 0–100 integer-valued numerics (verified
  // via `SELECT MIN,MAX,AVG,COUNT … WHERE confidence IS NOT NULL` during
  // Prompt 3c Gate 3 Concern 1: min=40, max=100, avg≈91 across 763/774/776
  // rows respectively). The fixture matches that convention so goldens
  // reflect real production byte shapes.
  //
  // Formatter bug fix (Prompt 3c, 2026-04-22): three legacy sites
  // (_execution-package-prompt.ts:693, :724, migration-intelligence.ts:616)
  // previously computed `Math.round(c * 100)` under the incorrect
  // assumption that c was a 0–1 fraction, producing absurd values like
  // `[confidence: 9500%]` in Claude prompts and customer-facing execution
  // packages. Fix: render the stored integer directly. Goldens in this
  // directory now show realistic 40–100% values — any future regression
  // to the multiplier formula will show up immediately as four-digit
  // percentages and fail the confidence-formatting test. See
  // `docs/prompt-3a-remaining-work.md` ▸ Bugs fixed in Prompt 3c.
  //
  // TFM-1: 1:1 mapping with NOT-APPLIED transform (needs_transformation=true).
  tfm({
    id: IDS.tfm1,
    target_field_id: IDS.fTCustomerId,
    combination_type: 'single',
    confidence: 95,
    needs_transformation: true,
    ai_reasoning: 'Direct primary key mapping.',
  }),
  // TFM-2: concat_space multi-source (needs_transformation=true).
  tfm({
    id: IDS.tfm2,
    target_field_id: IDS.fTFullName,
    combination_type: 'concat_space',
    confidence: 80,
    needs_transformation: true,
    ai_reasoning: 'Concatenate first name and last name with a space separator.',
  }),
  // TFM-3: 1:1 mapping, user-dismissed transform flag (needs_transformation=false).
  //        R1 coverage: transform IS applied, flag is dismissed — independent.
  tfm({
    id: IDS.tfm3,
    target_field_id: IDS.fTEmailNorm,
    combination_type: 'single',
    confidence: 90,
    needs_transformation: false,
    ai_reasoning: 'Normalize email to lowercase; user dismissed stricter validation.',
  }),
  // TFM-4: value assignment (custom_sql, zero sources). Trigger skips custom_sql
  // rows; confidence stays NULL per spec §Confidence semantics.
  tfm({
    id: IDS.tfm4,
    target_field_id: IDS.fTTenantId,
    combination_type: 'custom_sql',
    confidence: null,
    needs_transformation: true,
    ai_reasoning: 'Tenant ID hardcoded per deployment instance.',
  }),
  // TFM-5: target acknowledgment (bare ack, no combination).
  tfm({
    id: IDS.tfm5,
    target_field_id: IDS.fTNotes,
    combination_type: null,
    combination_sql: null,
    confidence: null,
    is_acknowledged: true,
    acknowledgment_reason: 'acknowledged',
    needs_transformation: null,
    status: 'approved',
    ai_reasoning: null,
  }),
  // TFM-6: 1:1 (t_orders PK)
  tfm({
    id: IDS.tfm6,
    target_field_id: IDS.fTOrderId,
    combination_type: 'single',
    confidence: 95,
    needs_transformation: true,
  }),
  // TFM-7: 1:1 (t_orders FK)
  tfm({
    id: IDS.tfm7,
    target_field_id: IDS.fTCustomerFk,
    combination_type: 'single',
    confidence: 92,
    needs_transformation: true,
    ai_reasoning: 'FK mapped direct to source customer id.',
  }),
  // TFM-8: 1:1 with transform applied (cents → dollars)
  tfm({
    id: IDS.tfm8,
    target_field_id: IDS.fTAmountDollars,
    combination_type: 'single',
    confidence: 88,
    needs_transformation: true,
    ai_reasoning: 'Divide cents by 100 to express dollars.',
  }),
  // TFM-9: REJECTED mapping (Case 9).
  //
  // Must APPEAR in customer-facing CSV / JSON audit-trail exports (with
  // status='rejected') and must NOT appear in any execution artifact
  // (transform-specs, gold-standard-select, sql-load-inserts, execution
  // package, readiness report). Relocated 2026-04-22 from t_orders.t_orphan
  // to t_customers.t_deprecated_flag so the rejected TFM is correctly owned
  // by tmCust and the grouping pipeline actually evaluates it. Test 11
  // asserts both inclusion and exclusion.
  tfm({
    id: IDS.tfm9,
    target_field_id: IDS.fTDeprecatedFlag,
    combination_type: 'single',
    confidence: 40,
    status: 'rejected',
    needs_transformation: null,
    ai_reasoning: 'Weak match; user rejected.',
  }),
]

function tfm(partial: Partial<TargetFieldMappingRow> & Pick<TargetFieldMappingRow, 'id' | 'target_field_id'>): TargetFieldMappingRow {
  return {
    project_id: IDS.project,
    confidence: 100,
    status: 'approved',
    ai_reasoning: null,
    is_acknowledged: false,
    acknowledgment_reason: null,
    combination_type: 'single',
    combination_sql: null,
    needs_transformation: null,
    va_dismissed: false,
    dismissal_reason: null,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    ...partial,
  }
}

// ─── Mapping sources ───────────────────────────────────────────────────────

// Confidence is stored as 0–100 integer-valued numeric (see TFM array above
// for production-verified range). TFM.confidence is trigger-derived as
// MIN(mapping_sources.confidence) for mapped targets; every consumer now
// renders the stored integer directly (the legacy `Math.round(c * 100)`
// bug was fixed in Prompt 3c — see TFM-array comment + regression test
// at `tests/outputs/confidence-formatting.test.ts`).
export const mappingSources: MappingSourceRow[] = [
  ms({ id: IDS.ms1P, tfmId: IDS.tfm1, sourceFieldId: IDS.fSId, tableId: IDS.tableSCustomers, ordinal: 0, confidence: 95 }),
  ms({ id: IDS.ms2P, tfmId: IDS.tfm2, sourceFieldId: IDS.fSFirstName, tableId: IDS.tableSCustomers, ordinal: 0, confidence: 85 }),
  ms({ id: IDS.ms2C, tfmId: IDS.tfm2, sourceFieldId: IDS.fSLastName, tableId: IDS.tableSCustomers, ordinal: 1, confidence: 80, typeCompat: 'exact' }),
  ms({ id: IDS.ms3P, tfmId: IDS.tfm3, sourceFieldId: IDS.fSEmail, tableId: IDS.tableSCustomers, ordinal: 0, confidence: 90 }),
  // (TFM-4 is a VA — no MS rows)
  ms({ id: IDS.ms6P, tfmId: IDS.tfm6, sourceFieldId: IDS.fSoId, tableId: IDS.tableSOrders, ordinal: 0, confidence: 95 }),
  ms({ id: IDS.ms7P, tfmId: IDS.tfm7, sourceFieldId: IDS.fSoCustomerId, tableId: IDS.tableSOrders, ordinal: 0, confidence: 92 }),
  ms({ id: IDS.ms8P, tfmId: IDS.tfm8, sourceFieldId: IDS.fSoTotalCents, tableId: IDS.tableSOrders, ordinal: 0, confidence: 88 }),
  // TFM-9 primary (rejected): s_legacy_flag → t_deprecated_flag.
  // Exercises the rejection path (not the "no MS" path). s_legacy_flag
  // doubles as the "unmapped unacknowledged source" in coverage case 5 —
  // still accurate because a rejected TFM does not mark its source as
  // mapped from any live output's perspective.
  ms({ id: IDS.ms9P, tfmId: IDS.tfm9, sourceFieldId: IDS.fSLegacyFlag, tableId: IDS.tableSCustomers, ordinal: 0, confidence: 40 }),
]

function ms(args: {
  id: string
  tfmId: string
  sourceFieldId: string
  tableId: string
  ordinal: number
  confidence: number | null
  typeCompat?: string | null
  aiReasoning?: string | null
}): MappingSourceRow {
  return {
    id: args.id,
    target_field_mapping_id: args.tfmId,
    source_field_id: args.sourceFieldId,
    source_table_id: args.tableId,
    confidence: args.confidence,
    ai_reasoning: args.aiReasoning ?? null,
    similar_fields_considered: null,
    type_compatibility: args.typeCompat ?? null,
    join_spec: null,
    ordinal: args.ordinal,
    created_at: FIXED_TS,
  }
}

// ─── Transformations ───────────────────────────────────────────────────────

export const transformations: TransformationRow[] = [
  // T-1: NOT applied (Case 7)
  tx({ id: IDS.t1, tfmId: IDS.tfm1, status: 'saved', sql: "(row_data->>'s_id')::integer", desc: 'Cast s_id to integer.' }),
  // T-2: applied (Case 6)
  tx({
    id: IDS.t2,
    tfmId: IDS.tfm2,
    status: 'applied',
    sql: "((row_data->>'s_first_name') || ' ' || (row_data->>'s_last_name'))",
    desc: 'Concatenate first and last name with a space.',
  }),
  // T-3: applied — user-dismissed flag case (Case 1 variant)
  tx({ id: IDS.t3, tfmId: IDS.tfm3, status: 'applied', sql: "lower(row_data->>'s_email')", desc: 'Normalize email to lowercase.' }),
  // T-4: applied — VA (Case 3)
  tx({
    id: IDS.t4,
    tfmId: IDS.tfm4,
    status: 'applied',
    sql: "'00000000-0000-0000-0000-000000000001'::uuid",
    desc: 'Hardcoded tenant UUID per deployment instance.',
  }),
  // T-6: applied — orders PK
  tx({ id: IDS.t6, tfmId: IDS.tfm6, status: 'applied', sql: "(row_data->>'so_id')::integer", desc: 'Cast so_id to integer.' }),
  // T-7: applied — orders FK
  tx({
    id: IDS.t7,
    tfmId: IDS.tfm7,
    status: 'applied',
    sql: "(row_data->>'so_customer_id')::integer",
    desc: 'Cast FK to integer.',
  }),
  // T-8: applied — cents → dollars
  tx({
    id: IDS.t8,
    tfmId: IDS.tfm8,
    status: 'applied',
    sql: "((row_data->>'so_total_cents')::numeric / 100)",
    desc: 'Convert cents to dollars by dividing by 100.',
  }),
  // (no transformation for TFM-5 — target ack — nor for TFM-9 — rejected —
  //  nor for TFM-4's peers; TFM-5 and TFM-9 should NEVER appear in any
  //  customer output regardless of transformation state.)
]

function tx(args: {
  id: string
  tfmId: string
  status: TransformationRow['status']
  sql: string
  desc: string
}): TransformationRow {
  return {
    id: args.id,
    target_field_mapping_id: args.tfmId,
    description: args.desc,
    generated_sql: args.sql,
    is_ai_generated: true,
    test_results: null,
    status: args.status,
    created_at: FIXED_TS,
  }
}

// ─── Source acknowledgments ────────────────────────────────────────────────

export const sourceFieldAcknowledgments: SourceFieldAcknowledgmentRow[] = [
  {
    id: IDS.sa1,
    project_id: IDS.project,
    source_field_id: IDS.fSPhone,
    reason: 'not_in_scope',
    notes: 'Phone numbers not migrated per scope document v3.',
    acknowledged_by: null,
    acknowledged_at: FIXED_TS,
  },
]

// ─── Convenience: pre-built lookup map (saves every test from rebuilding) ─

export const fieldsById: Map<string, FieldLookupRow> = new Map(
  fields.map((f) => [f.id, { id: f.id, table_id: f.table_id, ordinal_position: f.ordinal_position }]),
)

// ─── Named bundle (what tests import) ──────────────────────────────────────

export const fixture = {
  ids: IDS,
  datasets,
  tables,
  fields,
  fieldsById,
  tableMappings,
  targetFieldMappings,
  mappingSources,
  transformations,
  sourceFieldAcknowledgments,
} as const

export type Fixture = typeof fixture
