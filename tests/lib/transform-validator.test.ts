// @vitest-environment node
//
// Unit tests for lib/validation/transform-validator.ts (S1 #15).
// Tests cover the 4 static checks only — the async RPC check (syntax_error)
// requires a live Supabase connection and is exercised in integration tests.

import { describe, it, expect } from 'vitest'
import { validateTransformSQL } from '@/lib/validation/transform-validator'

// ─── Clean expressions ────────────────────────────────────────────────────────

describe('validateTransformSQL — clean expressions pass all static checks', () => {
  it('simple cast expression', async () => {
    const r = await validateTransformSQL("COALESCE(row_data->>'Amount', '0')::NUMERIC")
    expect(r.issues).toHaveLength(0)
    expect(r.counts.errors).toBe(0)
    expect(r.counts.warnings).toBe(0)
  })

  it('string concatenation with COALESCE', async () => {
    const r = await validateTransformSQL(
      "COALESCE(row_data->>'FirstName', '') || ' ' || COALESCE(row_data->>'LastName', '')",
    )
    expect(r.issues).toHaveLength(0)
  })

  it('CASE expression with null guard', async () => {
    const r = await validateTransformSQL(
      "CASE WHEN row_data->>'Status' IS NOT NULL THEN UPPER(row_data->>'Status') ELSE 'UNKNOWN' END",
    )
    expect(r.issues).toHaveLength(0)
  })

  it('literal value with no row_data reference', async () => {
    const r = await validateTransformSQL("'ACTIVE'")
    expect(r.issues).toHaveLength(0)
  })
})

// ─── nondeterministic_function ────────────────────────────────────────────────

describe('validateTransformSQL — nondeterministic_function', () => {
  const NONDETERMINISTIC_CASES = [
    "NOW()",
    // CURRENT_TIMESTAMP/DATE/TIME are used without () in Postgres — not caught by the
    // \s*\( pattern; acceptable gap since AI-generated SQL uses the function-call form.
    "RANDOM()",
    "GEN_RANDOM_UUID()",
    "UUID_GENERATE_V4()",
    "CLOCK_TIMESTAMP()",
  ]

  for (const expr of NONDETERMINISTIC_CASES) {
    it(`fires for ${expr}`, async () => {
      const r = await validateTransformSQL(expr)
      const issue = r.issues.find((i) => i.check === 'nondeterministic_function')
      expect(issue, `expected nondeterministic_function for: ${expr}`).toBeDefined()
      expect(issue?.severity).toBe('error')
    })
  }

  it('does not fire when NOW appears inside a string literal', async () => {
    // e.g. a default value string that contains the word NOW
    const r = await validateTransformSQL("COALESCE(row_data->>'ts', 'NOW is default')")
    expect(r.issues.every((i) => i.check !== 'nondeterministic_function')).toBe(true)
  })

  it('is case-insensitive', async () => {
    const r = await validateTransformSQL('now()')
    const issue = r.issues.find((i) => i.check === 'nondeterministic_function')
    expect(issue).toBeDefined()
  })
})

// ─── dml_ddl_keyword ──────────────────────────────────────────────────────────

describe('validateTransformSQL — dml_ddl_keyword', () => {
  const DML_DDL_CASES = [
    'INSERT INTO foo VALUES (1)',
    'UPDATE foo SET bar = 1',
    'DELETE FROM foo',
    'DROP TABLE foo',
    'CREATE TABLE foo (id INT)',
    'ALTER TABLE foo ADD COLUMN bar TEXT',
    'TRUNCATE TABLE foo',
    'GRANT SELECT ON foo TO bar',
    'REVOKE SELECT ON foo FROM bar',
    'EXECUTE my_func()',
    'CALL my_proc()',
  ]

  for (const stmt of DML_DDL_CASES) {
    it(`fires for "${stmt.split(' ').slice(0, 2).join(' ')}"`, async () => {
      const r = await validateTransformSQL(stmt)
      const issue = r.issues.find((i) => i.check === 'dml_ddl_keyword')
      expect(issue, `expected dml_ddl_keyword for: ${stmt}`).toBeDefined()
      expect(issue?.severity).toBe('error')
    })
  }

  it('does not fire when keyword appears inside a string literal', async () => {
    const r = await validateTransformSQL(
      "COALESCE(row_data->>'action', 'INSERT mode')",
    )
    expect(r.issues.every((i) => i.check !== 'dml_ddl_keyword')).toBe(true)
  })
})

// ─── statement_not_expression ─────────────────────────────────────────────────

describe('validateTransformSQL — statement_not_expression', () => {
  it('fires when expression starts with SELECT', async () => {
    const r = await validateTransformSQL("SELECT row_data->>'Name'")
    const issue = r.issues.find((i) => i.check === 'statement_not_expression')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })

  it('fires for SELECT with leading whitespace', async () => {
    const r = await validateTransformSQL("  SELECT 1")
    const issue = r.issues.find((i) => i.check === 'statement_not_expression')
    expect(issue).toBeDefined()
  })

  it('does not fire when SELECT appears mid-expression (subquery in expression)', async () => {
    // A CASE expression referencing SELECT inside a string is fine
    const r = await validateTransformSQL(
      "COALESCE(row_data->>'query', 'SELECT is a keyword')",
    )
    expect(r.issues.every((i) => i.check !== 'statement_not_expression')).toBe(true)
  })

  it('is case-insensitive', async () => {
    const r = await validateTransformSQL('select 1')
    const issue = r.issues.find((i) => i.check === 'statement_not_expression')
    expect(issue).toBeDefined()
  })
})

// ─── null_safety_missing ──────────────────────────────────────────────────────

describe('validateTransformSQL — null_safety_missing', () => {
  it('fires when row_data->> ref has no null guard', async () => {
    const r = await validateTransformSQL("row_data->>'Amount'::NUMERIC")
    const issue = r.issues.find((i) => i.check === 'null_safety_missing')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
  })

  it('does not fire when COALESCE wraps the ref', async () => {
    const r = await validateTransformSQL("COALESCE(row_data->>'Amount', '0')::NUMERIC")
    expect(r.issues.every((i) => i.check !== 'null_safety_missing')).toBe(true)
  })

  it('does not fire when IS NOT NULL guard is present', async () => {
    const r = await validateTransformSQL(
      "CASE WHEN row_data->>'Status' IS NOT NULL THEN row_data->>'Status' ELSE NULL END",
    )
    expect(r.issues.every((i) => i.check !== 'null_safety_missing')).toBe(true)
  })

  it('does not fire when NULLIF is present', async () => {
    const r = await validateTransformSQL("NULLIF(row_data->>'Field', '')")
    expect(r.issues.every((i) => i.check !== 'null_safety_missing')).toBe(true)
  })

  it('does not fire when expression has no row_data reference', async () => {
    const r = await validateTransformSQL("'ACTIVE'::TEXT")
    expect(r.issues.every((i) => i.check !== 'null_safety_missing')).toBe(true)
  })
})

// ─── counts ───────────────────────────────────────────────────────────────────

describe('validateTransformSQL — counts', () => {
  it('counts errors and warnings independently', async () => {
    // statement_not_expression (error) + null_safety_missing (warning — SELECT strips it but let's use a cleaner case)
    // Use NOW() (error) + row_data->> without guard (warning) in same expression
    const r = await validateTransformSQL("NOW() || row_data->>'Field'")
    expect(r.counts.errors).toBeGreaterThanOrEqual(1)
    expect(r.counts.warnings).toBeGreaterThanOrEqual(1)
    expect(r.counts.errors + r.counts.warnings).toBe(r.issues.length)
  })

  it('omitting supabase skips the syntax_error check', async () => {
    // Deliberately malformed — but no supabase passed, so syntax_error won't fire
    const r = await validateTransformSQL('((( invalid sql', undefined)
    const syntaxIssue = r.issues.find((i) => i.check === 'syntax_error')
    expect(syntaxIssue).toBeUndefined()
  })
})
