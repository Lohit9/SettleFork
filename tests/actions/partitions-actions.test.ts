import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for PR Ω.3.1 — partition CRUD action layer.
 *
 * Mirrors the source-grep strategy used by
 * `tests/actions/transforms-apply-filter-sql.test.ts` and the cross-table
 * apply test. Behavior-level coverage (createPartition writes the right
 * shape, deletePartition blocks on staged rows, testFilterSql round-trips
 * through the RPC) is covered by env-gated integration tests at the next
 * tier (deferred to a follow-up once we have a scratch-DB harness for
 * permission-gated RPCs).
 *
 * Pinned invariants:
 *
 *   P1  File declares 'use server' at the top — required for Next.js
 *       server actions.
 *   P2  Five exports: createPartition, updatePartitionFilter,
 *       updatePartitionMetadata, deletePartition, testFilterSql.
 *   P3  PartitionWriteErrorCode union includes the 6 expected members,
 *       in particular HAS_STAGED_ROWS (new, for deletePartition's safety
 *       check).
 *   P4  All write actions use supabaseAdmin (service-role) for writes
 *       and createClient (user-scoped) for the auth check only — matches
 *       canonical pattern in projects.ts.
 *   P5  All actions Zod-parse their input via .safeParse and surface the
 *       first issue with errorCode='VALIDATION'.
 *   P6  All actions check requireProjectPermission(projectId, 'editor')
 *       before writes.
 *   P7  createPartition validates tables-belong-to-project + partition_label
 *       uniqueness + identity_field sibling consistency + assertNoDml on
 *       filter_sql.
 *   P8  updatePartitionFilter runs assertNoDml before the UPDATE and
 *       returns stagedRowsAffected so the UI can surface the
 *       clear-before-reapply prompt.
 *   P9  updatePartitionMetadata distinguishes "undefined" (don't update)
 *       from "null" (set to NULL) when building the UPDATE payload.
 *   P10 deletePartition counts staged_data_rows; returns
 *       errorCode='HAS_STAGED_ROWS' with stagedRowsBlocking count when
 *       force is false-y.
 *   P11 testFilterSql wraps the filter via wrapFieldRefsInJsonb with the
 *       string[] (same-table, unaliased) overload to match
 *       dq_test_filter_sql's no-alias FROM clause.
 *   P12 testFilterSql passes through the RPC's {ok, error?} shape,
 *       flattening to the action's { success, error? } envelope.
 *   P13 All write actions revalidatePath the mapping route after success.
 */

const PARTITIONS_PATH = resolve(__dirname, '../../lib/actions/partitions.ts')
const PARTITIONS_SRC = readFileSync(PARTITIONS_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const CREATE_BODY = sliceBetween(
  PARTITIONS_SRC,
  'export async function createPartition(',
  '// ── updatePartitionFilter',
)
const UPDATE_FILTER_BODY = sliceBetween(
  PARTITIONS_SRC,
  'export async function updatePartitionFilter(',
  '// ── updatePartitionMetadata',
)
const UPDATE_METADATA_BODY = sliceBetween(
  PARTITIONS_SRC,
  'export async function updatePartitionMetadata(',
  '// ── deletePartition',
)
const DELETE_BODY = sliceBetween(
  PARTITIONS_SRC,
  'export async function deletePartition(',
  '// ── testFilterSql',
)
const TEST_FILTER_BODY = PARTITIONS_SRC.slice(
  PARTITIONS_SRC.indexOf('export async function testFilterSql('),
)

// ─── P1 — 'use server' directive ─────────────────────────────────────────

describe('[partitions-actions] P1 — \'use server\' directive', () => {
  it('first non-whitespace line is "use server"', () => {
    const firstStatement = PARTITIONS_SRC.split('\n').find((l) => l.trim().length > 0)
    expect(firstStatement).toBe("'use server'")
  })
})

// ─── P2 — Five exports ────────────────────────────────────────────────────

describe('[partitions-actions] P2 — exports', () => {
  const expected = [
    'createPartition',
    'updatePartitionFilter',
    'updatePartitionMetadata',
    'deletePartition',
    'testFilterSql',
  ]
  for (const name of expected) {
    it(`exports async ${name}`, () => {
      expect(PARTITIONS_SRC).toMatch(
        new RegExp(`export async function ${name}\\b`),
      )
    })
  }
})

// ─── P3 — Error code taxonomy ────────────────────────────────────────────

describe('[partitions-actions] P3 — PartitionWriteErrorCode union', () => {
  it('exports the error code type', () => {
    expect(PARTITIONS_SRC).toContain('export type PartitionWriteErrorCode')
  })

  for (const code of [
    'PERMISSION_DENIED',
    'NOT_AUTHENTICATED',
    'VALIDATION',
    'NOT_FOUND',
    'HAS_STAGED_ROWS',
    'INTERNAL',
  ]) {
    it(`includes '${code}'`, () => {
      expect(PARTITIONS_SRC).toMatch(
        new RegExp(`\\|\\s*'${code}'`),
      )
    })
  }
})

// ─── P4 — supabaseAdmin for writes; createClient only for auth ───────────

describe('[partitions-actions] P4 — service-role for writes, user-scoped for auth', () => {
  it('imports both supabaseAdmin and createClient', () => {
    expect(PARTITIONS_SRC).toMatch(/import\s*\{\s*createClient\s*\}\s*from\s*['"]@\/lib\/supabase\/server['"]/)
    expect(PARTITIONS_SRC).toMatch(/import\s*\{\s*supabaseAdmin\s*\}\s*from\s*['"]@\/lib\/supabase\/admin['"]/)
  })

  it('each action calls createClient() to fetch the user', () => {
    for (const body of [CREATE_BODY, UPDATE_FILTER_BODY, UPDATE_METADATA_BODY, DELETE_BODY, TEST_FILTER_BODY]) {
      expect(body).toContain('await createClient()')
      expect(body).toMatch(/supabase\.auth\.getUser\(\)/)
    }
  })

  it('all write paths use supabaseAdmin for the actual mutation', () => {
    // createPartition: INSERT
    expect(CREATE_BODY).toMatch(/supabaseAdmin[\s\S]*?\.from\(\s*['"]table_mappings['"]\s*\)[\s\S]*?\.insert\(/)
    // updatePartitionFilter: UPDATE
    expect(UPDATE_FILTER_BODY).toMatch(/supabaseAdmin[\s\S]*?\.from\(\s*['"]table_mappings['"]\s*\)[\s\S]*?\.update\(/)
    // updatePartitionMetadata: UPDATE
    expect(UPDATE_METADATA_BODY).toMatch(/supabaseAdmin[\s\S]*?\.from\(\s*['"]table_mappings['"]\s*\)[\s\S]*?\.update\(/)
    // deletePartition: DELETE
    expect(DELETE_BODY).toMatch(/supabaseAdmin[\s\S]*?\.from\(\s*['"]table_mappings['"]\s*\)[\s\S]*?\.delete\(/)
  })
})

// ─── P5 — Zod .safeParse on every action input ────────────────────────────

describe('[partitions-actions] P5 — Zod .safeParse on every input', () => {
  it('createPartition uses createPartitionInputSchema.safeParse', () => {
    expect(CREATE_BODY).toMatch(/createPartitionInputSchema\.safeParse\(/)
  })
  it('updatePartitionFilter uses updateFilterInputSchema.safeParse', () => {
    expect(UPDATE_FILTER_BODY).toMatch(/updateFilterInputSchema\.safeParse\(/)
  })
  it('updatePartitionMetadata uses updateMetadataInputSchema.safeParse', () => {
    expect(UPDATE_METADATA_BODY).toMatch(/updateMetadataInputSchema\.safeParse\(/)
  })
  it('testFilterSql uses testFilterInputSchema.safeParse', () => {
    expect(TEST_FILTER_BODY).toMatch(/testFilterInputSchema\.safeParse\(/)
  })

  it('each action surfaces parse failure as errorCode=VALIDATION', () => {
    for (const body of [CREATE_BODY, UPDATE_FILTER_BODY, UPDATE_METADATA_BODY, TEST_FILTER_BODY]) {
      expect(body).toMatch(/errorCode:\s*['"]VALIDATION['"]/)
    }
  })
})

// ─── P6 — requireProjectPermission(projectId, 'editor') gate ─────────────

describe('[partitions-actions] P6 — editor permission gate on every action', () => {
  for (const [name, body] of [
    ['createPartition', CREATE_BODY],
    ['updatePartitionFilter', UPDATE_FILTER_BODY],
    ['updatePartitionMetadata', UPDATE_METADATA_BODY],
    ['deletePartition', DELETE_BODY],
    ['testFilterSql', TEST_FILTER_BODY],
  ] as const) {
    it(`${name} calls requireProjectPermission(..., 'editor')`, () => {
      expect(body).toMatch(/requireProjectPermission\([^,]+,\s*['"]editor['"]\)/)
    })
  }
})

// ─── P7 — createPartition validation chain ───────────────────────────────

describe('[partitions-actions] P7 — createPartition validation chain', () => {
  it('verifies both tables belong to projectId via datasets!inner join', () => {
    expect(CREATE_BODY).toMatch(/\.from\(\s*['"]tables['"]\s*\)[\s\S]*?\.select\(\s*['"][^'"]*datasets!inner[^'"]*['"]/)
  })

  it('checks partition_label uniqueness per (project, target_table)', () => {
    // Look for the maybeSingle() check that gates on existing label.
    expect(CREATE_BODY).toMatch(/\.eq\(\s*['"]partition_label['"]\s*,/)
  })

  it('checks identity_field sibling consistency', () => {
    expect(CREATE_BODY).toContain('identity_field_id')
    expect(CREATE_BODY).toMatch(/must match sibling partitions/)
  })

  it('runs assertNoDml on filter_sql before INSERT', () => {
    expect(CREATE_BODY).toMatch(/assertNoDml\(\s*filterSql\s*\)/)
  })

  it('default status is "approved" (manually created)', () => {
    expect(CREATE_BODY).toMatch(/status:\s*['"]approved['"]/)
  })
})

// ─── P8 — updatePartitionFilter behavior ─────────────────────────────────

describe('[partitions-actions] P8 — updatePartitionFilter', () => {
  it('runs assertNoDml on the new filter before UPDATE', () => {
    expect(UPDATE_FILTER_BODY).toMatch(/assertNoDml\(\s*filterSql\s*\)/)
  })

  it('returns stagedRowsAffected (count of rows the filter change may have invalidated)', () => {
    expect(UPDATE_FILTER_BODY).toContain('stagedRowsAffected')
    expect(UPDATE_FILTER_BODY).toMatch(/\.from\(\s*['"]staged_data_rows['"]\s*\)[\s\S]*?count:\s*['"]exact['"]/)
  })
})

// ─── P9 — updatePartitionMetadata partial-update semantics ───────────────

describe('[partitions-actions] P9 — updatePartitionMetadata distinguishes undefined from null', () => {
  it('builds the UPDATE payload only from explicitly-provided keys', () => {
    // The implementation should test each field !== undefined before adding
    // to the updates object. This preserves "set to NULL" semantics for
    // explicitly-null inputs while skipping undefined ones.
    expect(UPDATE_METADATA_BODY).toMatch(/if\s*\(\s*partitionLabel\s*!==\s*undefined\s*\)/)
    expect(UPDATE_METADATA_BODY).toMatch(/if\s*\(\s*partitionOrdinal\s*!==\s*undefined\s*\)/)
    expect(UPDATE_METADATA_BODY).toMatch(/if\s*\(\s*identityFieldId\s*!==\s*undefined\s*\)/)
    expect(UPDATE_METADATA_BODY).toMatch(/if\s*\(\s*dedupPriority\s*!==\s*undefined\s*\)/)
  })

  it('rejects no-op calls (no fields provided)', () => {
    expect(UPDATE_METADATA_BODY).toMatch(/No metadata fields provided/)
  })
})

// ─── P10 — deletePartition staged-rows safety check ──────────────────────

describe('[partitions-actions] P10 — deletePartition blocks on staged rows', () => {
  it('counts staged_data_rows unless force=true', () => {
    expect(DELETE_BODY).toMatch(/if\s*\(\s*!input\.force\s*\)/)
    expect(DELETE_BODY).toMatch(/\.from\(\s*['"]staged_data_rows['"]\s*\)[\s\S]*?count:\s*['"]exact['"]/)
  })

  it('returns errorCode=HAS_STAGED_ROWS with stagedRowsBlocking count', () => {
    expect(DELETE_BODY).toMatch(/errorCode:\s*['"]HAS_STAGED_ROWS['"]/)
    expect(DELETE_BODY).toContain('stagedRowsBlocking')
  })

  it('passes force-bypass through to the actual DELETE', () => {
    // Force should let the cascade run (no staged-count blocking branch when force=true).
    expect(DELETE_BODY).toMatch(/\.delete\(\)[\s\S]*?\.eq\(\s*['"]id['"]\s*,\s*input\.tableMappingId\s*\)/)
  })
})

// ─── P11 — testFilterSql uses string[] (unaliased) wrapper overload ─────

describe('[partitions-actions] P11 — testFilterSql wrapping', () => {
  it('fetches source field names via fields table', () => {
    expect(TEST_FILTER_BODY).toMatch(/\.from\(\s*['"]fields['"]\s*\)[\s\S]*?\.select\(\s*['"]name['"]\s*\)/)
    expect(TEST_FILTER_BODY).toMatch(/\.eq\(\s*['"]table_id['"]\s*,\s*sourceTableId\s*\)/)
  })

  it('passes a string[] (fieldNames) to wrapFieldRefsInJsonb', () => {
    // string[] overload produces (row_data->>'X') without alias, matching the
    // RPC's no-alias FROM clause.
    expect(TEST_FILTER_BODY).toMatch(/wrapFieldRefsInJsonb\(\s*filterSql\s*,\s*fieldNames\s*\)/)
  })

  it('runs assertNoDml before wrapping (defense-in-depth)', () => {
    const assertIdx = TEST_FILTER_BODY.indexOf('assertNoDml(')
    const wrapIdx = TEST_FILTER_BODY.indexOf('wrapFieldRefsInJsonb(')
    expect(assertIdx).toBeGreaterThan(0)
    expect(wrapIdx).toBeGreaterThan(0)
    expect(assertIdx).toBeLessThan(wrapIdx)
  })
})

// ─── P12 — testFilterSql RPC call shape + result flattening ──────────────

describe('[partitions-actions] P12 — testFilterSql passes through RPC shape', () => {
  it('calls supabase.rpc("dq_test_filter_sql", …) with the two expected params', () => {
    expect(TEST_FILTER_BODY).toMatch(
      /supabaseAdmin\.rpc\(\s*['"]dq_test_filter_sql['"]\s*,\s*\{[\s\S]*?p_source_table_id:\s*sourceTableId[\s\S]*?p_filter_sql:\s*wrappedFilter[\s\S]*?\}\s*\)/,
    )
  })

  it('reads the RPC result\'s .ok field; non-true returns success=false with the verbose error', () => {
    expect(TEST_FILTER_BODY).toMatch(/result\?\.\s*ok\s*!==\s*true|result\.ok\s*!==\s*true/)
    expect(TEST_FILTER_BODY).toMatch(/result\??\.\s*error/)
  })
})

// ─── P13 — revalidatePath on success ─────────────────────────────────────

describe('[partitions-actions] P13 — revalidatePath after write', () => {
  for (const [name, body] of [
    ['createPartition', CREATE_BODY],
    ['updatePartitionFilter', UPDATE_FILTER_BODY],
    ['updatePartitionMetadata', UPDATE_METADATA_BODY],
    ['deletePartition', DELETE_BODY],
  ] as const) {
    it(`${name} calls revalidatePath on mapping route`, () => {
      expect(body).toMatch(/revalidatePath\([^)]*\/mapping[^)]*\)/)
    })
  }

  it('testFilterSql does NOT revalidate (no DB write)', () => {
    expect(TEST_FILTER_BODY).not.toMatch(/revalidatePath\(/)
  })
})
