// @vitest-environment node
//
// Phase E PR α — structural invariant tests for `getPathDOutputsForProject`.
//
// The reduce step is exercised end-to-end via tests/utils/path-d-outputs-core.test.ts;
// here we lock the server-action shape (auth gate, three parallel SELECTs,
// graceful degradation paths) by reading the source file. Same testing
// strategy as `tests/actions/edit-mapping-sources.test.ts`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTION_PATH = resolve(__dirname, '../../lib/actions/path-d-outputs.ts')
const ACTION_SOURCE = readFileSync(ACTION_PATH, 'utf-8')

describe('getPathDOutputsForProject — server action contract', () => {
  it("declares 'use server' at the top", () => {
    expect(ACTION_SOURCE.split('\n', 2)[0]).toBe("'use server'")
  })

  it('imports the user-cookie supabase client (createClient), NOT supabaseAdmin', () => {
    expect(ACTION_SOURCE).toContain(
      "import { createClient } from '@/lib/supabase/server'",
    )
    expect(ACTION_SOURCE).not.toContain('supabaseAdmin')
  })

  it('gates on supabase.auth.getUser() and returns empty maps when unauthenticated', () => {
    expect(ACTION_SOURCE).toContain('supabase.auth.getUser()')
    expect(ACTION_SOURCE).toMatch(/if \(!user\) return emptyPathDOutputs\(\)/)
  })

  it('queries all three Path D tables in parallel via Promise.all', () => {
    expect(ACTION_SOURCE).toContain('Promise.all')
    expect(ACTION_SOURCE).toContain("from('target_field_coverage')")
    expect(ACTION_SOURCE).toContain("from('project_decisions')")
    expect(ACTION_SOURCE).toContain("from('project_data_quality_issues')")
  })

  it('scopes every query to the project via .eq("project_id", projectId)', () => {
    const matches = ACTION_SOURCE.match(/\.eq\('project_id', projectId\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  it('delegates indexing to the pure buildPathDOutputs reducer', () => {
    expect(ACTION_SOURCE).toContain(
      "import {\n  buildPathDOutputs,\n  emptyPathDOutputs,\n} from '@/lib/utils/_path-d-outputs-core'",
    )
    expect(ACTION_SOURCE).toContain('return buildPathDOutputs(')
  })

  it('falls back to empty arrays on result.error so a partial failure still returns', () => {
    // Each result is conditionally unwrapped: `!result.error && result.data ? data : []`
    const fallbackPattern =
      /!coverageResult\.error && coverageResult\.data[\s\S]*\[\]/
    expect(ACTION_SOURCE).toMatch(fallbackPattern)
  })
})

describe('getPathDOutputsForProject — type re-export', () => {
  it('re-exports PathDOutputs from the public action module so callers do not import the underscore-private core', () => {
    expect(ACTION_SOURCE).toContain(
      "export type { PathDOutputs } from '@/lib/utils/_path-d-outputs-core'",
    )
  })
})
