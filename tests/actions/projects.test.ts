// @vitest-environment node
//
// Source-level invariant tests for `createProject` in
// `lib/actions/projects.ts`.
//
// Why source-level (not a runtime Supabase mock):
//   The established pattern across `tests/actions/` (see
//   `bulk-approve.test.ts`, `unacknowledge-field.test.ts`,
//   `edit-mapping-sources.test.ts`, etc.) is `readFileSync` + regex
//   against the action source. The convention catches architectural
//   drift without needing to mock the Supabase fluent builder.
//   End-to-end runtime behavior is pinned by integration tests under
//   `tests/integration/`. Sibling file: `projects-rbac-fanout.test.ts`.
//
// Architecture (post-080):
//   `createProject` is a thin caller of the SECURITY DEFINER RPC
//   `create_project_with_access` (migration 080). The projects-table
//   INSERT now lives inside the RPC body, not at the call site, so
//   the pre-080 P1 invariant ("inline insert sets
//   use_mapping_redesign: true") has moved one layer down: the RPC
//   parameter `p_use_mapping_redesign` has DEFAULT TRUE
//   (`supabase/migrations/080_create_project_with_access_rpc.sql`
//   line 40), and the Server Action relies on that default by not
//   passing the parameter.
//
// Invariants pinned:
//
//   P1.  `createProject` calls `create_project_with_access` (RPC
//        contract precondition; if this slips, P2/P3 are vacuous).
//        Note: the parameter-shape and grant_new_project_access
//        negative are pinned by `projects-rbac-fanout.test.ts` —
//        not duplicated here.
//
//   P2.  The RPC call site does NOT explicitly disable mapping
//        redesign — i.e. it does not pass `p_use_mapping_redesign:
//        false` (or null). A future edit that flips the explicit
//        value to false would defeat the Path γ rollout.
//
//   P3.  If `p_use_mapping_redesign` IS passed explicitly at the
//        call site, the only legal literal is `true`. Pins the
//        positive case symmetrically with P2.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(__dirname, '../../lib/actions/projects.ts')
const SRC = readFileSync(ACTIONS_PATH, 'utf8')

function sliceFromTo(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const CREATE_START = 'export async function createProject('
const CREATE_END = 'export async function getProjects('

const CREATE_BODY = sliceFromTo(SRC, CREATE_START, CREATE_END)

describe('[createProject] post-080 mapping-redesign default', () => {
  it('P1 — calls .rpc(\'create_project_with_access\', {...}) (precondition)', () => {
    expect(CREATE_BODY).toMatch(/\.rpc\(\s*['"]create_project_with_access['"]/)
  })

  it('P2 — does NOT pass p_use_mapping_redesign with a non-true literal at the RPC call site', () => {
    expect(CREATE_BODY).not.toMatch(/p_use_mapping_redesign\s*:\s*false\b/)
    expect(CREATE_BODY).not.toMatch(/p_use_mapping_redesign\s*:\s*null\b/)
  })

  it('P3 — if p_use_mapping_redesign is passed explicitly, the literal is true', () => {
    const match = CREATE_BODY.match(/p_use_mapping_redesign\s*:\s*([A-Za-z0-9_]+)/)
    if (match) {
      expect(match[1]).toBe('true')
    }
  })
})
