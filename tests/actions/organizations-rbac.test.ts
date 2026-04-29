// @vitest-environment node
//
// Source-level invariant tests for the org-level RBAC actions affected
// by migration 079 (project-level RBAC PR 1).
//
// Three Server Actions are pinned:
//   - updateMemberRole: caller gate tightened to owner-only; promotion
//     to 'owner' triggers grant_new_org_member_project_access fanout
//     (admin rows for every project in org). Demotion does NOT remove
//     existing project_members rows (stickiness).
//   - removeMember: caller gate tightened to owner-only.
//   - setOrgMemberAutoGrant (new in 079): owner-only; OFF→ON triggers
//     backfill_org_member_project_access; ON→OFF does not remove rows.

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

describe('setOrgMemberAutoGrant (new in 079)', () => {
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

  it('OFF→ON triggers backfill_org_member_project_access RPC', () => {
    // The backfill is gated on (enabled && prev === false) — pin both
    // the gate and the RPC name.
    expect(SET_TOGGLE).toMatch(/enabled\s*&&\s*prev\s*===\s*false/)
    expect(SET_TOGGLE).toMatch(
      /\.rpc\(\s*[\s\n]*['"]backfill_org_member_project_access['"]/
    )
  })

  it('ON→OFF does NOT remove project_members rows (stickiness)', () => {
    // No project_members deletion in the ON→OFF path. Negative match
    // against the entire function body is sufficient: the only
    // post-toggle code path is the OFF→ON backfill.
    expect(SET_TOGGLE).not.toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.delete\(/
    )
  })
})
