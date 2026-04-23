/**
 * Golden-output + regression tests for `buildSqlLoadScriptInserts`.
 *
 *   T6   Golden: header + N INSERT statements for a small row batch. Asserts
 *        byte stability of comment formatting, column quoting, value
 *        escaping, and the `Rows: N` header line.
 *
 *   T10  Regression: header `Rows: ` must print the row count, not
 *        `[object Object],[object Object],…`. This was the legacy
 *        `rows.toLocaleString()` (Array.prototype.toLocaleString) bug.
 *        Fixed in Prompt 3c by rendering `rows.length.toLocaleString()` in
 *        the translator.
 *
 * Regenerate via:
 *   UPDATE_FIXTURES=1 npx vitest tests/outputs/sql-load-inserts.golden.test.ts
 */

import { describe, expect, it } from 'vitest'
import { buildSqlLoadScriptInserts } from '@/lib/actions/_outputs-translators'
import { assertMatchesFixture } from './_fixture-assert'

const sampleRows = [
  { t_customer_id: 1, t_full_name: 'Alice Jones', t_email_norm: 'alice@example.com', t_tenant_id: '00000000-0000-0000-0000-000000000001' },
  { t_customer_id: 2, t_full_name: "Bob O'Brien", t_email_norm: null, t_tenant_id: '00000000-0000-0000-0000-000000000001' },
  { t_customer_id: 3, t_full_name: 'Carol "C" Tran', t_email_norm: 'carol@example.com', t_tenant_id: '00000000-0000-0000-0000-000000000001' },
]

const sampleFieldNames = ['t_customer_id', 't_full_name', 't_email_norm', 't_tenant_id']

describe('buildSqlLoadScriptInserts — golden (T6)', () => {
  it('renders byte-stable load script for a small row batch', () => {
    const sql = buildSqlLoadScriptInserts({
      targetTableName: 't_customers',
      sourceTableName: 's_customers',
      sourceDatasetName: 'Legacy CRM',
      generatedAt: 'Wed, 15 Jan 2026 12:00:00 GMT',
      rows: sampleRows,
      targetFieldNames: sampleFieldNames,
    })

    assertMatchesFixture(sql.endsWith('\n') ? sql : sql + '\n', 'sql-load-inserts.t-customers.expected.sql')
  })
})

describe('buildSqlLoadScriptInserts — rows-header regression (T10)', () => {
  it('header renders "Rows: N" with the row count, not [object Object]', () => {
    const sql = buildSqlLoadScriptInserts({
      targetTableName: 't_customers',
      sourceTableName: 's_customers',
      sourceDatasetName: 'Legacy CRM',
      generatedAt: 'Wed, 15 Jan 2026 12:00:00 GMT',
      rows: sampleRows,
      targetFieldNames: sampleFieldNames,
    })

    expect(sql).toContain('Rows: 3')
    expect(sql).not.toContain('[object Object]')
  })

  it('header renders "Rows: 0" for an empty batch (not an empty string)', () => {
    const sql = buildSqlLoadScriptInserts({
      targetTableName: 't_customers',
      sourceTableName: 's_customers',
      sourceDatasetName: 'Legacy CRM',
      generatedAt: 'Wed, 15 Jan 2026 12:00:00 GMT',
      rows: [],
      targetFieldNames: sampleFieldNames,
    })

    expect(sql).toContain('Rows: 0')
    expect(sql).not.toContain('[object Object]')
  })
})
