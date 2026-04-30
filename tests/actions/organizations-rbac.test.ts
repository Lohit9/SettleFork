// @vitest-environment node
//
// Source-level invariant tests for the org-level RBAC actions affected
// by migration 079 (project-level RBAC PR 1) and PR 2b (auto-grant
// toggle split).
//
// Four Server Actions are pinned:
//   - updateMemberRole: caller gate tightened to owner-only; promotion
//     to 'owner' triggers grant_new_org_member_project_access fanout
//     (admin rows for every project in org). Demotion does NOT remove
//     existing project_members rows (stickiness).
//   - removeMember: caller gate tightened to owner-only.
//   - setOrgMemberAutoGrant (079, refactored in PR 2b): owner-only;
//     pure column toggle, NO RPC calls, NO project_members deletes.
//     Backfill side effect was extracted into the new action below.
//   - backfillOrgMemberProjectAccess (PR 2b): owner-only; calls the
//     `backfill_org_member_project_access` RPC; sticky (no deletes).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/organizations.ts'),
  'utf8'
)

function functionBody(start: string, fallbackEnd: string = '\n}\n\n'): string {
  const a = SRC.indexOf(start)
  if (a < 0) throw new Error(`function not found: ${start}`)
  const b = SRC.indexOf(fallbackEnd, a + start.length)
  if (b < 0) throw new Error(`end not found for: ${start}`)
  return SRC.slice(a, b)
}

const UPDATE_MEMBER_ROLE = functionBody('export async function updateMemberRole(')
const REMOVE_MEMBER = functionBody('export async function removeMember(')
const SET_TOGGLE = functionBody('export async function setOrgMemberAutoGrant(')
const BACKFILL = functionBody('export async function backfillOrgMemberProjectAccess(')

describe('updateMemberRole — post-079', () => {
  it('caller gate is owner-only (no \'admin\' org-role anymore)', () => {
    // Must not allow the legacy "owner OR admin" gate
    expect(UPDATE_MEMBER_ROLE).not.toMatch(
      /\['owner',\s*'admin'\]\.includes\(callerMem\.role\)/
    )
    // Must require role === 'owner'
    expect(UPDATE_MEMBER_ROLE).toMatch(/callerMem\.role\s*!==\s*['"]owner['"]/)
  })

  it('calls grant_new_org_member_project_access RPC when promoting to owner', () => {
    expect(UPDATE_MEMBER_ROLE).toMatch(
      /\.rpc\(\s*[\s\n]*['"]grant_new_org_member_project_access['"]/
    )
    expect(UPDATE_MEMBER_ROLE).toMatch(/p_user_id\s*:\s*userId/)
    expect(UPDATE_MEMBER_ROLE).toMatch(/p_org_id\s*:\s*orgId/)
    expect(UPDATE_MEMBER_ROLE).toMatch(/p_role\s*:\s*['"]owner['"]/)
  })

  it('only fans out on member→owner transition (gates on prevRole !== \'owner\' and newRole === \'owner\')', () => {
    expect(UPDATE_MEMBER_ROLE).toMatch(
      /newRole\s*===\s*['"]owner['"][\s\S]*?prevRole\s*!==\s*['"]owner['"]/
    )
  })

  it('does NOT delete project_members rows on demotion (stickiness)', () => {
    // Stickiness: no .from('project_members').delete()
    const projectMembersDelete = /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.delete\(/
    expect(UPDATE_MEMBER_ROLE).not.toMatch(projectMembersDelete)
  })
})

describe('removeMember — post-079', () => {
  it('caller gate is owner-only', () => {
    expect(REMOVE_MEMBER).not.toMatch(
      /\['owner',\s*'admin'\]\.includes\(callerMem\.role\)/
    )
    expect(REMOVE_MEMBER).toMatch(/callerMem\.role\s*!==\s*['"]owner['"]/)
  })

  it('still sweeps project_members rows for the removed user (intentional revocation, not auto-fanout)', () => {
    expect(REMOVE_MEMBER).toMatch(
      /supabaseAdmin[\s\S]*?\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.delete\(/
    )
  })
})

describe('setOrgMemberAutoGrant — PR 2b (pure column toggle)', () => {
  it('exists with the expected (orgId, enabled) signature', () => {
    expect(SET_TOGGLE).toMatch(
      /export async function setOrgMemberAutoGrant\(\s*orgId:\s*string,\s*enabled:\s*boolean\s*\)/
    )
  })

  it('caller gate is owner-only', () => {
    expect(SET_TOGGLE).toMatch(/callerMem\.role\s*!==\s*['"]owner['"]/)
  })

  it('updates organizations.member_auto_grant_enabled', () => {
    expect(SET_TOGGLE).toMatch(
      /\.from\(\s*['"]organizations['"]\s*\)[\s\S]*?\.update\(\s*\{\s*member_auto_grant_enabled:\s*enabled\s*\}\s*\)/
    )
  })

  it('does NOT call any RPC (backfill is now a separate explicit action)', () => {
    // PR 2b refactor: the OFF→ON auto-backfill side effect was extracted
    // into `backfillOrgMemberProjectAccess`. This function must remain
    // a pure column toggle.
    expect(SET_TOGGLE).not.toMatch(/\.rpc\(/)
  })

  it('does NOT remove project_members rows (stickiness)', () => {
    expect(SET_TOGGLE).not.toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.delete\(/
    )
  })
})

describe('backfillOrgMemberProjectAccess — new in PR 2b', () => {
  it('exists with the expected (orgId) signature', () => {
    expect(BACKFILL).toMatch(
      /export async function backfillOrgMemberProjectAccess\(\s*orgId:\s*string\s*\)/
    )
  })

  it('caller gate is owner-only', () => {
    expect(BACKFILL).toMatch(/callerMem\.role\s*!==\s*['"]owner['"]/)
  })

  it("calls .rpc('backfill_org_member_project_access', { p_org_id: orgId })", () => {
    expect(BACKFILL).toMatch(
      /\.rpc\(\s*[\s\n]*['"]backfill_org_member_project_access['"]/
    )
    expect(BACKFILL).toMatch(/p_org_id\s*:\s*orgId/)
  })

  it('does NOT remove project_members rows (stickiness invariant)', () => {
    expect(BACKFILL).not.toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.delete\(/
    )
  })

  it('returns the RPC error message verbatim on failure', () => {
    // Pin the shape `{ success: false, error: rpcError.message }` so the
    // caller can surface it directly without re-wrapping.
    expect(BACKFILL).toMatch(
      /return\s*\{\s*success:\s*false,\s*error:\s*rpcError\.message\s*\}/
    )
  })
})
